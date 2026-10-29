'use strict';
import { assertOneEveryoneRole, renameLegacyRole } from "../lib/defaultRole.js";
import appConfig from './../../config/app.config.js';
import logger from "../lib/logger.js";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fse from "fs-extra";
import moment from "moment";
import _ from "lodash";
import Errors from '../lib/errors.js';
import { execFileSync } from 'child_process';
import yaml from "yaml";
import Ajv from 'ajv';
import quote from 'shell-quote/quote.js';
import Repository from './repository.model.js';
import { resolveTargetDir, configRepoFromPath, claimAllOrRollback } from "../lib/forms-git.js";
import Helpers from "../lib/common.js";
import Settings from './settings.model.js';
import AJVErrorParser from './ajvErrorParser.model.js';
import { repoFolder } from "./repo.model.js";


const ajv = new Ajv({allErrors: true, allowUnionTypes: true});

// Construct __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load JSON schemas synchronously
const baseSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../schema/base_schema.json"), "utf8"));
const formSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../schema/form_schema.json"), "utf8"));

// Generate formsSchema in-memory: base config wrapper + formSchema as array items.
// It validates what the designer saves : the base config (categories, roles,
// constants) and every form (forms[]) in one payload.
const formsSchema = (() => {
  const schema = JSON.parse(JSON.stringify(baseSchema)); // deep clone
  schema.required = [...schema.required, "forms"];
  // Use the per-form schema as-is. The per-type `oneOf` branches already
  // enforce `roles` where appropriate (ansible/awx/multistep) and forbid it
  // where it must not appear (subform). Forcing `roles` into the top-level
  // required list here would make subforms unsaveable.
  const formItems = JSON.parse(JSON.stringify(formSchema));
  schema.properties.forms = { type: "array", default: [], items: formItems };
  return schema;
})();
const jsonSchemaDraft6 = JSON.parse(fs.readFileSync(path.join(__dirname, "../../node_modules/ajv/lib/refs/json-schema-draft-06.json"), "utf8"));

// The paths, read from appConfig each time they are used : the settings page changes
// FORMS_BACKUP_PATH, CONFIG_PATH and FORMS_FOLDER_PATH without a restart (lib/envSettings.js)
const backupPath = () => appConfig.formsBackupPath
const configFileName = () => path.basename(appConfig.configPath)
const formsPath = () => appConfig.formsFolderPath
const formsBackupPath = () => path.join(backupPath(),'forms')
const configFileBackupPath = () => path.join(backupPath(),configFileName())
// A snapshot is normally of the ACTIVE config, and a restore reinstates it into
// whatever source is active at that moment. The two writes that REPLACE one source
// with the other - Settings.exportConfig (database -> file) and
// Settings.importConfig (file -> database) - snapshot the source they are about to
// destroy, so such a snapshot belongs to a FIXED source and must be reinstated
// there, not into the active one : restoring an export's snapshot into the database
// would overwrite the live config with a stale disk copy, the exact opposite of
// undoing the export. The backup name therefore carries that source
// ('config.file.yaml.bak.<ts>', 'config.database.yaml.bak.<ts>'), which also keeps
// the two kinds apart in the backups list. They still end in 'yaml.bak.<ts>', so
// the backups list, the suffix parser and the retention cleanup keep working
// unchanged, and an 'active' snapshot keeps its plain historical name.
const configBackupPathForSource = function(source){
  if(source!=='file' && source!=='database') return configFileBackupPath()
  const parsed = path.parse(configFileName())
  return path.join(backupPath(),`${parsed.name}.${source}${parsed.ext}`)
}
// the snapshot sources that carry their name ; anything else is an 'active' snapshot
const fixedBackupSources = ['file','database']


const pathDelimiterRegex = new RegExp(`(?<!\\\\)${path.delimiter}`, 'g');

/**
 * Extracts the '.bak.<17 digit timestamp>' suffix of a backup name.
 *
 * The name comes straight from the URL of the restore / delete endpoints, so it is
 * validated here : a name without the suffix used to crash with a TypeError
 * (reading [1] of a null match), which surfaced as a 500 instead of a clear 400.
 *
 * Args:
 *   t (string): The backup name, e.g. 'config.yaml.bak.20261018120000000'.
 *
 * Returns:
 *   string: The suffix, e.g. '.bak.20261018120000000'.
 *
 * Raises:
 *   BadRequestError: When the name is not a string or carries no valid suffix.
 */
function getBackupSuffix(t){
  const match = typeof t === 'string' ? /(\.bak\.[0-9]{17})$/.exec(t) : null
  if(!match){
    throw new Errors.BadRequestError(`Invalid backup name '${String(t)}'`)
  }
  return match[1]
}
// Which source a stored snapshot was taken from, told by the artifact that exists
// for its timestamp : a 'file' / 'database' snapshot carries its source in the name,
// an older or plain one is an 'active' snapshot.
function backupConfigSource(backupName){
  const suffix = getBackupSuffix(backupName)
  for(const source of fixedBackupSources){
    if(fs.existsSync(configBackupPathForSource(source)+suffix)) return source
  }
  return 'active'
}
// Whether a config RESTORE must write into the database. The database only counts
// when it really holds a config : with an empty forms_yaml the config is served
// from disk/repository (see getBaseConfig), and writing to the database anyway
// would flip the effective source to the database as a side effect.
// Form.restore and Form.restoreBackup MUST share this one expression : the former
// refuses a restore that would only touch local folders while git serves the
// forms, and if the latter disagreed it would take its disk branch anyway and
// write into a repository working tree - leaving an uncommitted change that breaks
// the next scheduled pull, which is exactly what that guard exists to forbid.
async function resolveRestoreInDatabase(){
  const settings = await Settings.findFormsYaml()
  return Settings.resolveConfigInDatabase(settings) && !!(settings.forms_yaml && settings.forms_yaml.trim())
}
// Copy a config snapshot onto the file the config is read from : a repository copy
// wins over the local one, exactly like the designer save and
// Settings.saveActiveConfig resolve it. When that file lives in a repository
// working tree, claim its write-lock so this write can't race a concurrent
// scheduled pull/sync (issue #414).
async function restoreConfigFile(snapshot){
  const targetConfigPath = (await Repository.getConfigPath()) || appConfig.configPath
  logger.debug(`Copying config file '${snapshot}'->'${targetConfigPath}'`)
  const repoName = configRepoFromPath(targetConfigPath, appConfig.repoPath)
  const token = repoName ? await Repository.claimForWrite(repoName) : undefined
  try{
    fse.ensureDirSync(path.dirname(targetConfigPath))
    fse.copySync(snapshot,targetConfigPath)
  }finally{
    if(repoName && token !== undefined){
      await Repository.releaseWrite(repoName, token).catch(e => logger.error(`Failed to release write-lock on '${repoName}': ${e.message}`))
    }
  }
}
ajv.addMetaSchema(jsonSchemaDraft6);
var Form=function(data){
  this.forms = data.forms;
};

/**
 * The ytt options for the library data values the environment names (YTT_LIB_DATA_*).
 *
 * Returns:
 *   string[]: the options and their values, one argument each.
 */
function getYttLibDataOpts() {
  const opts = [];
  for (const [libName, value] of Object.entries(appConfig.yttLibData)) {
    opts.push('--data-values-file', `@${libName}:data=${value}`);
  }
  return opts;
}

/**
 * The other ytt options the environment sets (YTT_VARS_PREFIX, the symlink destinations).
 *
 * Returns:
 *   string[]: the options and their values, one argument each.
 */
function getYttEnvDataOpts() {
  const opts = [];
  if (appConfig.yttVarsPrefix || false) {
    opts.push('--data-values-env', appConfig.yttVarsPrefix);
  }
  if (appConfig.yttAllowSymlinkDestinations || false) {
    // path.delimiter separated list of paths (delimiter can be escaped with '\')
    for (const allowedPath of appConfig.yttAllowSymlinkDestinations.split(pathDelimiterRegex)) {
      opts.push('--allow-symlink-destination', allowedPath.replace(/\\(.)/g, '$1'));
    }
  }
  if (appConfig.yttDangerousAllowAllSymlinkDestinations) {
    opts.push('--dangerous-allow-all-symlink-destinations');
  }
  return opts;
}

// ytt run on a config file : its program and arguments, no shell (a path or a value is one
// argument, never more)
function execYtt(file,libdir) {

  // database didn't deliver any forms, so let's load from file
  const args = ['-f', file, '-f', libdir, ...getYttEnvDataOpts(), ...getYttLibDataOpts()];
  logger.info(`interpreting ${file} with ytt.`);
  logger.debug(`executing 'ytt ${quote(args)}'`);
  var data = execFileSync('ytt', args, {
    env: process.env,
    encoding: 'utf-8'
  });
  if (!data) {
    throw new Error(`ytt did not return any data for file ${file}`);
  }
  return data;
}

/**
 * The config file : a repository's config.yaml when one serves the config, else the
 * local CONFIG_PATH (created from the template when it does not exist yet).
 */
async function getConfigPath() {
  const repoConfigPath = await Repository.getConfigPath();
  if (repoConfigPath && fs.existsSync(repoConfigPath)) {
    logger.info(`Using config from repository: ${repoConfigPath}`);
    return repoConfigPath;
  }
  logger.info(`Using config file: ${appConfig.configPath}`);
  return appConfig.configPath;
}

// forms repositories are read AND write (issue #414) : the designer saves a
// form file back into the repository working tree it was loaded from. This
// resolves the write targets : the forms folders (with their repository name)
// and the config file path, mirroring where they are read from. In repository
// mode a staging folder is added : a brand new form (not yet in any repository)
// is written there and stays visible until a 'Push to repo' assigns it to a
// chosen repository.
async function getSaveTargets() {
  const repoFolders = await Repository.getFormsFolders()
  const repoMode = repoFolders.length > 0
  for (const folder of repoFolders) {
    const repoDir = repoFolder(folder.name)
    if (!fs.existsSync(path.join(repoDir, ".git"))) {
      throw new Error(`The forms repository '${folder.name}' is not cloned yet ; clone it from the repositories settings first`)
    }
  }
  // config is written where it is read from : Repository.getConfigPath() (the same
  // resolution the READ path and Settings.saveActiveConfig use) wins over the local
  // file. It must be consulted regardless of repoMode : a use_for_config repository
  // holds the config even when it is not a forms repository, and writing to the
  // local config.yaml then silently discarded every category/role edit, because the
  // repository copy kept being served.
  var targetConfigPath = appConfig.configPath
  const repoConfigPath = await Repository.getConfigPath()
  if (repoConfigPath) {
    targetConfigPath = repoConfigPath
  } else if (repoMode && repoFolders.length === 1) {
    // no config in any repository yet : adopt the single forms repository root
    targetConfigPath = path.join(repoFolder(repoFolders[0].name), "config.yaml")
  }
  // staging is the default target for new files in repository mode ; it is
  // listed last so an existing repository file is always matched first
  const stagingDir = { name: null, path: appConfig.formsStagingPath, staging: true }
  const formsDirs = repoMode ? [...repoFolders, stagingDir] : [{ name: null, path: formsPath() }]
  // the distinct git repositories this save writes into : the forms repos plus
  // the repo that holds config.yaml (it may be a separate use_for_config repo,
  // and then there are no forms repos at all - which is why this is not gated on
  // repoMode) ; used to lock them for the duration of the write (issue #414)
  const names = new Set(repoFolders.map(f => f.name).filter(Boolean))
  const configRepo = configRepoFromPath(targetConfigPath, appConfig.repoPath)
  if (configRepo) names.add(configRepo)
  const repoNames = [...names]
  return { configPath: targetConfigPath, formsDirs, repoMode, repoNames }
}

// ===========================================================================
// YAML FILE WALK
// ===========================================================================
/**
 * Recursively lists the yaml files of a forms folder, relative to that folder.
 *
 * This ONE walk serves both the loader (Form.load) and the delete pass of a designer
 * save (listYamlFiles). They used to be two separate walks that disagreed about
 * symbolic links : the loader followed a symlinked folder while the delete pass did
 * not, so a form deleted in the designer stayed on disk when it lived inside a
 * symlinked folder. Sharing the walk keeps both sides seeing exactly the same set.
 *
 * Rules :
 * - the .git folder is skipped (a repository served from its root would otherwise
 *   re-stat the whole object store on every request for the form list) ;
 * - a symbolic link is resolved : a link to a folder is walked, a link to a yaml file
 *   is listed, a broken link is reported and skipped ;
 * - every folder is visited at most once, by its REAL path, so a link pointing back
 *   up the tree (a loop) cannot recurse forever ;
 * - a folder that cannot be read (permissions, vanished mid-walk) is reported and
 *   skipped on its own ; the files already collected from the other folders are
 *   kept. Before, one unreadable subfolder threw out of the whole walk and the
 *   complete forms folder looked empty.
 *
 * Args:
 *   root (string): The forms folder to walk.
 *   onWarn (function): Optional callback receiving a human readable warning for
 *     every skipped folder or broken link. Defaults to logger.warning.
 *
 * Returns:
 *   string[]: The yaml file paths, relative to root, in walk order.
 *
 * Raises:
 *   Error: When root itself cannot be read ; the callers treat that as "this forms
 *     folder failed to load" and skip it as a whole.
 */
function walkYamlFiles(root, onWarn = (m) => logger.warning(m)) {
  const files = []
  const visited = new Set()
  const walk = (dir, isRoot) => {
    // step 1 : loop guard on the real path (a symlink back up the tree)
    let real
    try {
      real = fs.realpathSync(dir)
    } catch (e) {
      if (isRoot) throw e
      onWarn(`Skipping folder '${dir}': it cannot be resolved (${e.code || e.message})`)
      return
    }
    if (visited.has(real)) {
      onWarn(`Skipping folder '${dir}': it was already visited (a symbolic link loop)`)
      return
    }
    visited.add(real)
    // step 2 : read the folder ; an unreadable subfolder is skipped on its own,
    // only the root itself is fatal for the caller
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      if (isRoot) throw e
      onWarn(`Skipping folder '${dir}': it cannot be read (${e.code || e.message})`)
      return
    }
    // step 3 : collect yaml files, descend into folders
    for (const entry of entries) {
      if (entry.name === ".git") continue
      const fullPath = path.join(dir, entry.name)
      // A SYMLINK is neither isDirectory() nor isFile() - readdirSync does not follow
      // them - so resolve it. A symlinked form yaml is a normal way to share one form
      // between an app and a git checkout, and must be both listed and deletable.
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(fullPath) // follows the link
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch (e) {
          // a broken symlink : name it rather than dropping it silently
          onWarn(`Skipping '${fullPath}': it is a symbolic link that does not resolve (${e.code || e.message})`)
          continue
        }
      }
      if (isDir) {
        walk(fullPath, false)
      } else if (isFile && /\.(yaml|yml)$/i.test(entry.name)) {
        // relative to the root so getFormsFromFile(root, rel) and the save agree
        files.push(path.relative(root, fullPath))
      }
    }
  }
  walk(root, true)
  return files
}

// recursively list the yaml files of a forms folder, relative to it ; used to
// remove forms that were deleted in the designer (same walk as the loader)
function listYamlFiles(dir) {
  return walkYamlFiles(dir)
}

function copyConfigTemplate(to) {
  try{
    logger.warning("No config found in database or config.yaml... creating empty one from template")
    var configTemplatePath = path.join(__dirname,"../../templates/seed/config.yaml.template")
    fs.copyFileSync(configTemplatePath, to)
    logger.warning("Config file copied from template")
  } catch (e) {
    logger.error(`Failed to copy config from template.`,e);
    throw new Error(Helpers.getError(e,"There is no config.yaml nor could one be created from template."), { cause: e })
  }
}

function copyFormsDirectoryTemplate(toDir) {
  // declared outside the try : the catch reports the path, and a const inside the
  // try block is not in scope there (a ReferenceError would then replace the real
  // copy error with a confusing one)
  const formsDirTemplatePath = path.join(__dirname, "../../templates/seed/forms.template");
  try {
    logger.warning("No forms directory found... creating empty one from template");
    fse.copySync(formsDirTemplatePath, toDir, { overwrite: false, errorOnExist: false });
    logger.warning("Directory copied");
  } catch (e) {
    logger.error(`Failed to copy forms directory from template '${formsDirTemplatePath}'.`, e);
    throw new Error(Helpers.getError(e, "There is no forms directory nor could there be one created from template."), { cause: e });
  }
}

// the base config last parsed, by its text's hash (getBaseConfig)
let baseConfigCache = { hash: null, config: null, retryAt: undefined };

// a refused rename was said already (saveRenamedRole)
let renameRetried = false

/**
 * Writes back a config whose `public` role renameLegacyRole renamed `default` : to the database
 * or the file it is read from (a repository's working tree too, the change then waits to be
 * pushed). A ytt template is never rewritten : its output only is renamed. The designer's lock
 * does not hold it back ; only a failed write (a repository busy pulling, a full disk) does, and
 * the next load a minute later tries again.
 *
 * Args:
 *   renamed (string): the config, its role renamed.
 *
 * Returns:
 *   Promise<object>: { text (the config to use, renamed whether or not it could be written),
 *   saved (false : the write was refused) }.
 */
async function saveRenamedRole(renamed) {
  if (appConfig.useYtt && !Settings.resolveConfigInDatabase(await Settings.findFormsYaml())) {
    logger.warning("Role 'public' is renamed 'default' in the config loaded: rename it in the ytt template too")
    return { text: renamed, saved: true }
  }
  try {
    await Settings.saveActiveConfig(renamed, { ignoreDesignerLock: true })
    logger.notice("Role 'public' renamed 'default' in the config ('public' is its name before 7)")
    return { text: renamed, saved: true }
  } catch (e) {
    // said once, then quietly : until the write goes through, every minute tries again
    const log = renameRetried ? logger.debug : logger.warning
    renameRetried = true
    log.call(logger, `Role 'public' could not be renamed 'default' in the config yet, tried again in a minute: ${e.message}`)
    return { text: renamed, saved: false }
  }
}

async function getBaseConfig() {
  var rawdata=''

  const settings = await Settings.findFormsYaml()
  const useDatabase = Settings.resolveConfigInDatabase(settings)

  if(useDatabase){
    if(settings.forms_yaml && settings.forms_yaml.trim()){
      logger.info(`Using config from database`)
      rawdata = settings.forms_yaml
    }else{
      logger.warning("No config found in the database, falling back to disk file")
    }
  }

  if(!rawdata){
    const configPath = await getConfigPath();

    // Create config.yaml from template if it doesn't exist
    if (!fs.existsSync(configPath)) {
      copyConfigTemplate(configPath);
    }
    
    // Also ensure the forms directory exists
    if (!fs.existsSync(formsPath())) {
      copyFormsDirectoryTemplate(formsPath());
    }
    // at this point we have a config file and forms directory

    if (appConfig.useYtt) {
      // try to process ytt
      try{
        const yttLibDir=path.join(path.dirname(configPath),"/lib");
        rawdata = execYtt(configPath,yttLibDir);
      } catch (e) {
        logger.error(`Failed to load '${configPath}' with ytt.`,e);
        throw new Error(Helpers.getError(e,"Error processing the config file with ytt."), { cause: e })
      }
    } else {
      // try to read the file
      try{
        logger.info(`Using config from file: ${configPath}`)      
        rawdata = fs.readFileSync(configPath, 'utf8');
      } catch (e) {
        logger.error(`Failed to load '${configPath}'.`,e);
        throw new Error(Helpers.getError(e,"Error reading the config file."), { cause: e })
      }
    }
  }

  // now let's see if it's valid yaml - kept by the text's hash, a deep copy each time : the base
  // config is read on every Form.load and every role check
  try{
    const hash = crypto.createHash("sha256").update(String(rawdata)).digest("hex")
    if (baseConfigCache.hash === hash && !(baseConfigCache.retryAt <= Date.now())) return structuredClone(baseConfigCache.config)
    // a config from before 7 names the role every user has `public` : renamed `default`, and
    // written back where it came from - once per text, the cache below keeps the result ; a
    // refused write is tried again a minute later
    let retryAt
    const renamed = renameLegacyRole(rawdata)
    if (renamed !== null) {
      const result = await saveRenamedRole(renamed)
      rawdata = result.text
      if (!result.saved) retryAt = Date.now() + 60000
    }
    const config = yaml.parse(rawdata)
    logger.debug("Base config loaded and is valid YAML")
    baseConfigCache = { hash, config: structuredClone(config), retryAt }
    return config;
  }catch(err){
    logger.error("Error",err)
    throw new Error(Helpers.getError(err,"Error parsing the base config, it's not valid yaml."), { cause: err })
  }  
}

async function loadVarsFiles(varsFiles) {
  if (!varsFiles || !Array.isArray(varsFiles) || varsFiles.length === 0) {
    return {};
  }

  let mergedVars = {};
  // Every failure below used to be logged and dropped, so this returned {} or a partial
  // merge and the caller's catch could never fire: the form loaded 200 with vars: {},
  // $vars.* resolved to nothing, defaults and enums came back empty, and the job ran with
  // the wrong extravars - with nothing on screen saying a file was missing. Collected and
  // handed back so the caller can put them in the errors the client renders.
  const problems = [];
  
  // Get vars files path from repository or default local path
  const varsFilesPath = await Repository.getVarsFilesPath();

  for (const varsFile of varsFiles) {
    // Support both absolute and relative paths
    // Relative paths are resolved against vars files path (from repository or local)
    const absPath = path.isAbsolute(varsFile) 
      ? path.resolve(varsFile)
      : path.resolve(varsFilesPath, varsFile);
    
    const ext = path.extname(absPath).toLowerCase();
    // Validate file extension
    if (ext !== '.yml' && ext !== '.yaml') {
      logger.warning(`Skipping varsFile '${varsFile}': must end with .yml or .yaml`);
      problems.push(`'${varsFile}' was skipped: a varsFile must end with .yml or .yaml`);
      continue;
    }

    try {
      logger.debug(`Loading varsFile: ${varsFile} (resolved to ${absPath})`);

      const rawData = fs.readFileSync(absPath, 'utf8');
      const data = yaml.parse(rawData);

      // Validate that the file contains a dict/object
      if (typeof data !== 'object' || Array.isArray(data)) {
        logger.warning(`Skipping varsFile '${varsFile}': content must be a dictionary, not ${Array.isArray(data) ? 'a list' : typeof data}`);
        problems.push(`'${varsFile}' was skipped: its content must be a dictionary, not ${Array.isArray(data) ? 'a list' : typeof data}`);
        continue;
      }

      // Deep merge with existing vars
      mergedVars = _.merge(mergedVars, data);
      logger.debug(`Successfully loaded and merged varsFile: ${varsFile}`);
    } catch (err) {
      logger.error(`Failed to load varsFile '${varsFile}': ${err.message}`);
      // Continue with the other files, but REMEMBER this one - see `problems` above
      problems.push(`'${varsFile}' could not be loaded: ${err.message}`);
    }
  }

  return { vars: mergedVars, problems };
}

function getFormInfo(form,formName='',loadFullConfig=false) {
  // if we are loading full config, return the full form object
  if(loadFullConfig){
     return validatedForm(form); // validate the form and return
  }
  if(!formName){
    // list, only mimimal info
    return {
      icon: form.icon || undefined,
      iconSize: form.iconSize || "3x",
      iconColor: form.iconColor || undefined,
      overlayIcon: form.overlayIcon || undefined,
      overlayIconCircle: form.overlayIconCircle ?? true,
      overlayIconTransform: form.overlayIconTransform || undefined,
      overlayIconColor: form.overlayIconColor || undefined,
      overlayIconText: form.overlayIconText || undefined,
      overlayIconTextPosition: form.overlayIconTextPosition || undefined,
      overlayIconTextColor: form.overlayIconTextColor || undefined,
      image: form.image || '',
      name: form.name,
      categories: form.categories || [],
      description: form.description || '',
      tileClass: form.tileClass || '',
      order: form.order ?? Number.MAX_SAFE_INTEGER,
      // the chat assistant's allowlist and its button : read from this list (MCP list_forms,
      // the chat catalog), so they must survive the trimming to tile info
      enableForChat: form.enableForChat === true,
    };
  }
  else if(form.name == formName) {
    // validate the form and return
    return validatedForm(form);
  }
  // no match
  return null;
}


// The forms of a file, parsed, kept by the file's path, modification time and size : a file that
// did not change is not read and parsed again on every Form.load (every form list, every dynamic
// field's query). A changed file - a save, a repository pull, an edit on the volume - has another
// mtime or size, and is read again ; nothing has to invalidate this. Every caller gets a deep
// copy : the forms are changed downstream (defaults, vars, subforms). ytt renders from other files
// too, so with USE_YTT nothing is kept.
const parsedFiles = new Map();
const MAX_CACHED_FILES = 5000;

function fileKey(formPath) {
  try {
    const st = fs.statSync(formPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function cachedForms(formPath, read) {
  if (appConfig.useYtt) return read();
  const key = fileKey(formPath);
  const hit = key && parsedFiles.get(formPath);
  if (hit && hit.key === key) return cloneTagged(hit.forms, hit.key, formPath);
  const forms = read();
  if (key) {
    if (parsedFiles.size >= MAX_CACHED_FILES) parsedFiles.delete(parsedFiles.keys().next().value);
    parsedFiles.set(formPath, { key, forms: structuredClone(forms) });
  }
  return cloneTagged(forms, key, formPath);
}

// a copy of the file's forms, each tagged (not enumerable, so never saved nor sent) with where it
// comes from : the key its validation is kept under (validatedForm)
function cloneTagged(forms, key, formPath) {
  return structuredClone(forms).map((form, i) => {
    if (key && form && typeof form === "object") Object.defineProperty(form, "__cacheKey", { value: `${formPath}#${key}#${i}`, enumerable: false });
    return form;
  });
}

// A form's validation (AJV against the form schema, removedIn7), kept by its cache key : the same
// file content validates the same way. A deep copy each time, as above.
const validatedForms = new Map();
function validatedForm(form) {
  const key = form?.__cacheKey;
  if (!key) return Form.validateForm(form);
  const hit = validatedForms.get(key);
  if (hit) return structuredClone(hit);
  const valid = Form.validateForm(form);
  if (validatedForms.size >= MAX_CACHED_FILES * 4) validatedForms.delete(validatedForms.keys().next().value);
  validatedForms.set(key, structuredClone(valid));
  return valid;
}

function getFormsFromFile(formsPath,filename){
  const formPath = path.join(formsPath, filename);
  return cachedForms(formPath, () => readFormsFile(formsPath, filename));
}

function readFormsFile(formsPath,filename){
  var rawData;
  const formPath = path.join(formsPath, filename);
  if (appConfig.useYtt) {
    try{
      // process with ytt
      const yttLibDir=path.join(path.dirname(formsPath),"/lib");
      rawData = execYtt(formPath, yttLibDir);
    } catch (e) {
      throw new Error(`Failed to load '${formPath}' and process with ytt.`,{ cause: e });

    }
  } else {
    try{
      // read the file
      rawData =fs.readFileSync(formPath,'utf8');
    } catch (e) {
      throw new Error(`Failed to load '${formPath}'.`,{ cause: e });
    }
  }

  logger.info(`merging file ${filename}`)
  try{
    const data = yaml.parse(rawData);
    var forms = [].concat(data || [])
    for(let form of forms){
      form.source = filename; // add source to the form
    }
    return forms;
  } catch (e) {
    throw new Error(`Failed to parse '${formPath}' as yaml.`,e);
  }  
}

// whether a user's roles reach a form (an admin reaches every one) : the Forms page's filter, and
// the designer's for a user without designAllForms (lib/designerForms.js)
Form.checkFormRole = (form, userRoles) => checkFormRole(form, userRoles)
function checkFormRole(form, userRoles) {
  if(!userRoles) {
    return true
  }
  if(userRoles.includes("admin")){
    return true
  }
  if(form.roles){
    for(var role of form.roles){
      if(userRoles.includes(role)){
        return true
      }
    }
  }
  return false
}

/**
 * The forms folders with their repository name, in the order the loader reads them : the forms
 * repositories' (each its forms subfolder, or its root), then the staging folder when it is there
 * (new forms not yet pushed, no repository) ; or the local forms folder when no repository serves
 * forms.
 *
 * Returns:
 *   Promise<object[]>: [{ name (the repository, null for a local or the staging folder), path,
 *     dedicated }].
 */
async function formsFolders() {
  const repoFolders = await Repository.getFormsFolders()
  const stagingPath = appConfig.formsStagingPath
  return repoFolders.length > 0
    ? [...repoFolders, ...(fs.existsSync(stagingPath) ? [{ name: null, path: stagingPath }] : [])]
    : [{ name: null, path: appConfig.formsFolderPath }]
}

/**
 * Every form of the folders, each with where it is, in the order they are read (the folders in
 * turn, the files of each sorted) : what the loader goes through, and what the designer's checks
 * of the forms it never received read (Form.unloaded, Form.duplicates).
 *
 * Args:
 *   formsdirs (object[]): the folders (formsFolders).
 *   warn (function): (message) => a warning (a folder that cannot be read).
 *   error (function): (message) => an error (a file that cannot be read or parsed).
 *
 * Returns:
 *   object[]: [{ form, repository (its repository, null for a local or the staging folder), dir
 *     (its folder), file (the file, relative to the folder) }].
 */
function collectForms(formsdirs, warn, error) {
  const out = []
  // when several forms repos exist, tag each form with the repo it came from so a save writes it
  // back there even if another repo has a same-named file
  const tagRepository = formsdirs.filter((d) => d.name).length > 1
  // Loop through each forms directory (with its repository name)
  for (const formsdir of formsdirs) {
    const formsdirpath = formsdir.path
    var files;
    try {
      // walk directory recursively and collect relative paths for .yml/.yaml files ;
      // walkYamlFiles skips an unreadable subfolder on its own (with a warning) and
      // guards against symbolic link loops
      if (fs.existsSync(formsdirpath)) {
        files = walkYamlFiles(formsdirpath, warn);
      } else {
        warn(`Failed to load forms directory '${formsdirpath}'.`);
        continue; // skip this directory
      }
    } catch (e) {
      warn(`Failed to load forms directory '${formsdirpath}'.`, e);
      continue; // skip this directory
    }
    if (!files?.length) continue
    logger.debug(`Found ${files.length} form file(s) in '${formsdirpath}'`)
    // sort for deterministic order
    files.sort();
    // read files
    for (const item of files) {
      // read the file and add to the forms array
      logger.debug(`Loading forms from file ${item} in ${formsdirpath}`);
      try{
        const fileForms = getFormsFromFile(formsdirpath,item) // get the forms from the file, including subpaths
        // tag with the originating repository so a save writes it back there
        // (disambiguates same-named files across repos) ; only when needed
        if (tagRepository && formsdir.name) {
          for (const ff of fileForms) ff.repository = formsdir.name
        }
        for (const form of fileForms) out.push({ form, repository: formsdir.name, dir: formsdir, file: item })
      }
      catch (e) {
        error(e.message);
      }
    }
  }
  return out
}

// load the forms config
Form.load = async function(userRoles,formName='',loadFullConfig=false,baseOnly=false) {
  logger.debug(`Loading forms with userRoles=${userRoles}, formName=${formName}, loadFullConfig=${loadFullConfig}, baseOnly=${baseOnly}`)
  var existingFormNames=[]
  var errors = []
  var warnings = []
  
  // Get the forms folders with their repository name - can be multiple from
  // repositories or a single default path. In repository mode the staging
  // folder is added (new forms not yet pushed) with no repository (formsFolders).
  const formsdirs = await formsFolders()

  logger.debug(`Loading forms from ${formsdirs.length} folder(s): ${formsdirs.map(d => d.path).join(", ")}`)

  function warn(message) {
    logger.warning(message);
    warnings.push(message);
  }
  function error(message) {
    logger.error(message);
    errors.push(message);
  }
  // let's load the base config
  const unvalidatedBase = await getBaseConfig();

  // a content-free config (an empty file, or one holding only comments) parses to
  // null, and a config that is not a yaml mapping parses to a scalar or an array :
  // reading categories/roles off that would throw a bare TypeError, so report it
  // as the config error it is
  if(!unvalidatedBase || typeof unvalidatedBase !== "object" || Array.isArray(unvalidatedBase)){
    const message = "The base config has no content. It must be a yaml mapping holding at least 'categories' and 'roles'."
    error(message)
    throw new Error(message)
  }

  // let's grab the base config and validate it, without it the app won't work
  var baseConfig = {
    categories: unvalidatedBase.categories || [],
    roles: unvalidatedBase.roles || [],
    constants: unvalidatedBase.constants || {}
  }
  // validate base config
  baseConfig = Form.validateConfig(baseConfig); // throws if not valid with the error messages
  logger.debug("Base config validated against schema")

  // just interested in the base config, no forms needed
  if(baseOnly){
    // if we only want the base config, return it now
    logger.debug("Returning base config only, no forms requested")
    return baseConfig;
  }

  baseConfig.forms = []; // initialize forms array  


  // Forms in the base config (the old forms.yaml layout) are no longer loaded since 7.0.0 :
  // every form lives in its own file in the forms folder. Say so, rather than silently
  // showing an empty form list.
  if (unvalidatedBase.forms !== undefined && unvalidatedBase.forms !== null && !(Array.isArray(unvalidatedBase.forms) && unvalidatedBase.forms.length === 0)) {
    error("The base config has a 'forms' section. Since 7.0.0 forms are no longer read from the base config - move each form to its own file in the forms folder (FORMS_FOLDER_PATH).")
  }
  var unvalidatedForms = [];

  // read extra form files from all forms directories, in the order they are read (collectForms)
  unvalidatedForms = unvalidatedForms.concat(collectForms(formsdirs, warn, error).map((e) => e.form));
  
  // Process all collected forms
  for (const f of unvalidatedForms) {
      var form = null; // initialize form
      if(!f?.name){
        error(`Form found with no name.`)
        continue // skip this form, but keep loading the rest
      }
      if(formName && f.name != formName){
        logger.debug(`Skipping form ${f.name}, not requested.`)
        continue // skip this form if it is not the one we are looking for
      }
      // subform type forms are not standalone forms; they are only consumed
      // by "list" / "yaml" fields through the dedicated subform endpoint.
      // Hide them from the runtime form list (tiles) and from regular form
      // lookups, but keep them visible to the designer (loadFullConfig=true)
      // so they can be edited natively alongside their parent forms.
      if(!formName && !loadFullConfig && f.type === "subform"){
        logger.debug(`Skipping subform ${f.name} from form list.`)
        continue
      }
      if(existingFormNames.includes(f.name)){
        warn(Form.duplicateWarning(f.name))
        continue
      }
      // The name is claimed BEFORE the role check, so a name resolves to exactly one
      // definition - the first in walk order - on every path.
      //
      // It used to be claimed after, which made the two ways through this loop disagree.
      // With two files defining `Deploy`, the first restricted to `ops` and the second to
      // `default`, any user got: the LIST path skipped copy 1 without registering the
      // name, so copy 2 passed the duplicate check and the tile appeared; the SINGLE-form
      // path hit copy 1 first and threw AccessDenied, so copy 2 was never reached. The
      // form was listed and then failed to open. Claiming the name first makes both paths
      // answer "denied", and the designer edits the same copy the loader resolves.
      existingFormNames.push(f.name) // collect all form names
      if(!checkFormRole(f,userRoles)){
        logger.debug(`User has no access to form ${f.name}.`)
        if(formName) { // if we are looking for a specific form, and no access, throw an error
          throw new Errors.AccessDeniedError(`Access denied to form ${f.name}.`); 
        } 
        continue // skip this form if user has no access to it
      }
      
      logger.debug(`adding form ${f.name}`)
      try{
        form = getFormInfo(f,formName,loadFullConfig); // retreive only the necessary form info
      } catch (e) {
        // convert e to proper string
        error(Form.validationError(f.name, e.message));
      }  
      if(form){
        // Load varsFiles if this is a single form request and varsFiles is defined
        if(formName && form.varsFiles){
          logger.debug(`Loading varsFiles for form ${f.name}`);
          try {
            const loaded = await loadVarsFiles(form.varsFiles);
            form.vars = loaded.vars;
            // A varsFile that could not be read is not a detail: the form still renders,
            // but $vars.* is empty and the job runs with the wrong extravars. Say so.
            for (const p of loaded.problems) {
              error(`Form '${f.name}': ${p}`);
            }
          } catch (e) {
            error(`Failed to load varsFiles for form '${f.name}'.\r\n${e.message}`);
          }
        }
        // When loading a single form, inline every subform referenced by a
        // "list" field (recursively) so the client has a self-contained
        // definition and no extra API calls are required. Authorization is
        // implicit: we already validated the caller has access to this form,
        // and subforms can only be reached through that form's field tree.
        if(formName){
          form.subforms = collectSubformsForForm(form, unvalidatedForms, errors)
        }
        baseConfig.forms.push(form);   // merge the form into the base forms
        // if we are loading full config, we can return the form right away
        if(formName){
          baseConfig.errors = errors; // add errors to the base config
          baseConfig.warnings = warnings; // add warnings to the base config
          return baseConfig // exit early if we found the form we are looking for
        }                
      }
    }

  baseConfig.errors = errors; // add errors to the base config
  baseConfig.warnings = warnings; // add warnings to the base config
  return baseConfig; // return the base config with the forms
};

// Walk a field tree and collect every subform name referenced by a "list"
// field. Recurses into subform definitions as well so we pick up nested
// lists. `visited` guards against cycles (A -> B -> A).
function collectSubformNames(fields, unvalidated, collected, visited){
  if(!Array.isArray(fields)) return
  for(const field of fields){
    if((field?.type === "list" || field?.type === "yaml") && field?.subform){
      const name = field.subform
      if(!visited.has(name)){
        visited.add(name)
        collected.add(name)
        const sub = unvalidated.find(f => f.name === name && f.type === "subform")
        if(sub){
          collectSubformNames(sub.fields, unvalidated, collected, visited)
        }
      }
    }
    // multistep forms nest fields under step objects
    if(Array.isArray(field?.fields)){
      collectSubformNames(field.fields, unvalidated, collected, visited)
    }
  }
}

// Given a validated parent form, return the array of validated subform
// definitions referenced by its list fields (recursively). Missing subforms
// produce an error entry but do not throw, so the form itself can still be
// rendered (the client will show a placeholder).
/**
 * The subforms a form uses, by name : its list and yaml fields' (recursively) and its wizard steps'.
 *
 * Args:
 *   parentForm (object): the form.
 *   unvalidated (object[]): every form, as read.
 *
 * Returns:
 *   Set<string>: the subforms' names.
 */
function subformNamesOf(parentForm, unvalidated){
  const names = new Set()
  const visited = new Set()
  collectSubformNames(parentForm?.fields, unvalidated, names, visited)
  // wizard steps reference subforms by name too
  if(Array.isArray(parentForm?.wizard)){
    for(const step of parentForm.wizard){
      if(step?.subform && !visited.has(step.subform)){
        visited.add(step.subform)
        names.add(step.subform)
        const sub = unvalidated.find(f => f.name === step.subform && f.type === "subform")
        if(sub){
          collectSubformNames(sub.fields, unvalidated, names, visited)
        }
      }
    }
  }
  return names
}
// the subforms a form uses : the designer's for a user without designAllForms (lib/designerForms.js)
Form.subformNamesOf = subformNamesOf

function collectSubformsForForm(parentForm, unvalidated, errors){
  const names = subformNamesOf(parentForm, unvalidated)
  const result = []
  for(const name of names){
    const raw = unvalidated.find(f => f.name === name && f.type === "subform")
    if(!raw){
      errors.push(`Subform '${name}' referenced by form '${parentForm.name}' was not found.`)
      continue
    }
    try{
      result.push(Form.validateForm(raw))
    } catch (e) {
      errors.push(`Failed to validate subform '${name}'.\r\n${e.message}`)
    }
  }
  return result
}

// ===========================================================================
// WHAT A DESIGNER WITHOUT designAllForms IS NOT TOLD
// ===========================================================================
// The designer of a user whose role option designAllForms is off shows only the forms of their
// roles (lib/designerForms.js). These read what the loader leaves out or says of a form (a form
// that does not load, a name defined twice), so that nothing of a form hidden from them is named.

/**
 * A path as the disk resolves it, links followed : the deepest part of it that exists resolved
 * (realpath), the rest added as written. A file not made yet is resolved through the folders it
 * would be made in, so a link to a folder (sub -> .) cannot hide where it lands.
 *
 * Args:
 *   abs (string): the path, absolute.
 *
 * Returns:
 *   string: the path resolved ; as written when nothing of it resolves.
 */
function realPathOf(abs) {
  let probe = path.resolve(abs)
  const rest = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...rest)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return path.resolve(abs)
      rest.unshift(path.basename(probe))
      probe = parent
    }
  }
}

/**
 * The warning the loader records for a form name defined twice : the later copy is skipped.
 *
 * Args:
 *   name (string): the form.
 *
 * Returns:
 *   string: the warning.
 */
Form.duplicateWarning = (name) => `skipping duplicate form ${name}`

/**
 * The form names defined more than once across the forms folders : the copy used (the first
 * read, Form.load's) and each one skipped, with the roles of both, so that a designer without
 * designAllForms is told only of copies they reach (lib/designerForms.js duplicateShown).
 *
 * Returns:
 *   Promise<object[]>: [{ name, used: { roles }, skipped: { roles }, notice (the loader's warning,
 *     Form.duplicateWarning) }].
 */
Form.duplicates = async function() {
  const first = new Map()
  const out = []
  for (const e of collectForms(await formsFolders(), () => {}, () => {})) {
    const name = e.form?.name
    if (!name) continue
    if (!first.has(name)) {
      first.set(name, e)
      continue
    }
    const used = first.get(name)
    out.push({
      name,
      used: { roles: Array.isArray(used.form.roles) ? used.form.roles : [] },
      skipped: { roles: Array.isArray(e.form.roles) ? e.form.roles : [] },
      notice: Form.duplicateWarning(name),
    })
  }
  return out
}

/**
 * The forms the loader leaves out because they do not load (no name aside : failing validation),
 * each the copy its name resolves to (a later copy of a name is a skipped one) : the designer never
 * receives them, a save keeps them (formsToKeep). A designer without designAllForms is refused
 * their names and their files when they are not theirs (lib/designerForms.js).
 *
 * Returns:
 *   Promise<object[]>: [{ form (as read), source (its file in its folder), repository (its
 *     repository, null for a local or the staging folder) }].
 */
Form.unloaded = async function() {
  const first = new Map()
  for (const e of collectForms(await formsFolders(), () => {}, () => {})) {
    if (e.form?.name && !first.has(e.form.name)) first.set(e.form.name, e)
  }
  // validated as the loader validates them : a form that loads is answered from its cache
  const loads = (form) => {
    try {
      validatedForm(form)
      return true
    } catch {
      return false
    }
  }
  return [...first.values()].filter((e) => !loads(e.form)).map((e) => ({ form: e.form, source: e.file, repository: e.repository }))
}

/**
 * The error the loader records for a form failing validation : what a designer without
 * designAllForms is not shown of a form hidden from them (lib/designerForms.js).
 *
 * Args:
 *   name (string): the form.
 *   message (string): why it fails ; '' for the start every such error has.
 *
 * Returns:
 *   string: the error.
 */
Form.validationError = (name, message) => `Failed to validate form '${name}'.\r\n${message}`

/**
 * What a save says of a form name it cannot take, to a designer who is not told where it is.
 *
 * Args:
 *   name (string): the name.
 *
 * Returns:
 *   string: the message.
 */
Form.nameTaken = (name) => `The form name '${name}' is already taken`

/**
 * Which paths are form files, as the loader reads them (formsFolders) : anything in a folder that
 * is the forms' own (a forms repository's forms folder, the staging folder, the local forms
 * folder, those two whether they are read now or not), and every yaml file of a forms repository
 * serving its forms from its root. The designer's other explorers (models/projectFiles.model.js)
 * never write one : a form written there skips every check of Form.save (its name, its roles, its
 * validation, the forms hidden from a designer).
 *
 * Returns:
 *   Promise<function>: (absolute path) => whether it is a form file, by the path as written and
 *     as the disk resolves it (links followed).
 */
Form.formsFileTest = async function() {
  const inside = (root, p) => {
    const rel = path.relative(root, p)
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
  }
  // the forms repositories' folders, and the staging and the local forms folders whether they are
  // read now or not (a file made there is a form once they are) ; a folder not configured holds none
  const folders = [...(await Repository.getFormsFolders()), { name: null, path: appConfig.formsStagingPath }, { name: null, path: appConfig.formsFolderPath }]
  const roots = folders.filter((d) => d.path).map((d) => ({ own: !d.name || !!d.dedicated, paths: [path.resolve(d.path), realPathOf(d.path)] }))
  return (abs) => {
    const candidates = [path.resolve(abs), realPathOf(abs)]
    return roots.some((r) => candidates.some((p) => r.paths.some((root) => inside(root, p)) && (r.own || /\.(yaml|yml)$/i.test(p))))
  }
}

// load the forms config
Form.backups = function() {
  logger.info(`Loading backups`)
  var files
  var backups=[]
  try{
    files = fs.readdirSync(backupPath())
    if(files){
      // filter only backups
      files=files.filter((item)=>item.match(/y[a]{0,1}ml\.bak\.[0-9]{17}$/g))
      // parse the backup data
      backups=files.map(file => {
        var item=file.substring(file.length-17)
        // snapshots taken before the timestamp fix were written with 'kk' (1-24), so
        // a backup made at midnight carries hour '24' on its own date. Moment refuses
        // to parse that ('Invalid date' in the list, and a broken sort), so read it
        // back as hour 00 of the same day - which is the moment it was really taken
        var hour=item.slice(8,10)==='24' ? '00' : item.slice(8,10)
        var dt=moment(item.slice(0,8)+"T"+hour+item.slice(10,14)+","+item.slice(14))
        return {'file':file,'date':dt.format("YYYY-MM-DD HH:mm:ss")}
      }).sort((a, b) => a.date < b.date && 1 || -1);
    }
  }catch(e){
    logger.warning("Failed to load backups. "+e)
  }
  return backups
};
/**
 * Reject duplicate role names.
 *
 * ajv has no "unique by property", and this is a privilege escalation rather than a typo:
 * getRolesAndOptions applies EVERY matching entry, so a second `- name: admin` grants
 * admin to that entry's groups too - while the roles editor, the designer and the audit
 * delta all key roles by name and only ever show one of them.
 *
 * Shared by validateConfig AND validate. It used to live inline in validateConfig only,
 * under a comment claiming every write path was covered - but Form.save (the DESIGNER
 * path, and POST /api/v2/config/check) goes through Form.validate, which had no such
 * check. So the designer happily saved a config that the next Form.load then refused,
 * 500ing every config endpoint and - until the user.model fix - hanging every login.
 */
function assertNoDuplicateRoles(obj){
  const seen = new Set()
  const duplicates = new Set()
  for(const role of (Array.isArray(obj?.roles) ? obj.roles : [])){
    const name = typeof role?.name === 'string' ? role.name.trim() : null
    if(name === null) continue
    if(seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  if(duplicates.size > 0){
    const message = `Duplicate role name(s): ${[...duplicates].join(", ")}. Each role must appear once.`
    logger.error(message)
    throw new Error(message)
  }
}

/**
 * Refuse a config that has lost the admin or the default role.
 *
 * The server derives admin rights from the role NAMED admin, and the schema requires a default
 * role : a save without one of them locks every administrator out, or breaks every config load.
 * The roles page greys them out, but the config can be written from the designer, the API or a
 * hand-edited YAML posted to the settings - so the save refuses it, whoever sends it.
 *
 * Checked on the saves only (Form.validate, the settings' forms_yaml), never on the load : an
 * install whose config already lacks one keeps starting, and can be repaired from the pages.
 *
 * Args:
 *   obj (object): the config about to be saved ({ roles: [...] }).
 *
 * Raises:
 *   Error: a required role is missing.
 */
Form.assertRequiredRoles = function(obj){
  if(!Array.isArray(obj?.roles)) return
  const names = new Set(obj.roles.map(r => (typeof r?.name === 'string' ? r.name.trim() : '')))
  // the role every user has : default, or public its old name - one of them, not both
  const missing = ['admin'].filter(n => !names.has(n))
  if (!names.has('default') && !names.has('public')) missing.push('default')
  if(missing.length > 0){
    const message = `The role(s) ${missing.join(", ")} cannot be deleted: the app needs them.`
    logger.error(message)
    throw new Error(message)
  }
  assertOneEveryoneRole(obj.roles)
}

Form.validateConfig = function(obj){
  if(obj){
    logger.debug("validating base against schema")
    // default and public (its old name) are one role : not both
    assertOneEveryoneRole(obj.roles)
    const validate = ajv.compile(baseSchema)
    const valid = validate(obj)

    if (!valid){
      var ajvMessages = AJVErrorParser.parseErrors(validate.errors)
      ajvMessages=ajvMessages.map(x => {
        try{
          var tmp=`${x}`
          var category
          var role
          category = Helpers.friendlyAJVError(tmp,"categories","Category",obj.categories)
          if(category.changed){
            return category.value
          }
          role = Helpers.friendlyAJVError(tmp,"roles","Role",obj.roles)
          if(role.changed){
            return role.value
          }        
        }catch(e){
          logger.error(e)
          return x
        }     
        return tmp
      })
      logger.error(ajvMessages)
      throw new Error(`${ajvMessages.join("\r\n")}`)
    }else{
      // JSON Schema cannot express "unique by property", so duplicate role names get
      // past ajv - and they are a privilege escalation, not a cosmetic problem :
      // getRolesAndOptions iterates EVERY entry (user.model.js), so a second
      // `- name: admin` with different groups grants admin to those groups, while the
      // roles editor and the audit delta both key roles by name and only ever see one
      // of the two. Reject it here so every write path is covered (designer, config
      // editor, import, and a hand-edited file).
      assertNoDuplicateRoles(obj)
      logger.debug("Valid base")
      return obj
    }

  }
}
// What 7.0.0 removed, said in one line each : the schema alone answers a removed field type
// with a page of "must match exactly one schema" (it tries every other type and reports why
// each one does not fit), which hides the one thing to change.
const REMOVED_IN_7 = 'removed in 7.0.0, see https://ansibleforms.com/upgrade-7'
export function removedIn7(form){
  const found = []
  if (form && typeof form === 'object') {
    if (form.disableRelaunch !== undefined) found.push(`Form '${form.name}': disableRelaunch was ${REMOVED_IN_7} - use allowRelaunch: false`)
    for (const f of Array.isArray(form.fields) ? form.fields : []) {
      if (!f || typeof f !== 'object') continue
      if (f.type === 'table' || f.tableFields !== undefined) found.push(`Field '${f.name}': the table field was ${REMOVED_IN_7} - use a list field with a subform`)
      if (f.noOutput !== undefined) found.push(`Field '${f.name}': noOutput was ${REMOVED_IN_7} - use output: false`)
    }
  }
  return found
}
// Deprecated in 7.0.0, removed in 8.0.0 (DEPRECATED.md). hasApproval is accepted by the
// schema on a form and on a step, but nothing reads it : a form that sets it gets no
// approval point from it. The approval point is the approval property.
const DEPRECATED_IN_7 = 'deprecated since 7 and removed in 8'
export function deprecatedIn7_3(form){
  const found = []
  if (form && typeof form === 'object') {
    if (form.hasApproval !== undefined) found.push(`Form '${form.name}': hasApproval is ${DEPRECATED_IN_7} - it has no effect, an approval point is set with approval`)
    for (const s of Array.isArray(form.steps) ? form.steps : []) {
      if (s && typeof s === 'object' && s.hasApproval !== undefined) found.push(`Step '${s.name}' of form '${form.name}': hasApproval is ${DEPRECATED_IN_7} - it has no effect, an approval point is set with approval`)
    }
  }
  return found
}
// Deprecated in 7.0.0, removed in 8.0.0 (DEPRECATED.md) : a multistep form. A workflow does what
// it does - nodes on any runner (runner), a condition (if_extra_var), a step's own values
// (extra_vars_key), approval nodes - and more. Until 8 a multistep runs as it did ; the log says
// so once per form, not on every read of it.
const warnedMultistep = new Set()
export function deprecatedMultistep(form){
  if (form?.type !== 'multistep') return null
  return `Form '${form.name}': type multistep is ${DEPRECATED_IN_7} - use type workflow (Designer > Workflows), whose nodes run on any runner, with a condition (if_extra_var) and their own values (extra_vars_key)`
}
/**
 * The notification channels a form names (its notifications, its approval, its steps') :
 * channels: [...] of Connections > Notifications.
 *
 * Args:
 *   form (object): the form.
 *
 * Returns:
 *   string[]: the names, each once.
 */
export function channelsOfForm(form){
  const names = []
  const add = (list) => { if (Array.isArray(list)) names.push(...list.filter((n) => typeof n === 'string' && n.trim())) }
  if (form && typeof form === 'object') {
    add(form.notifications?.channels)
    add(form.approval?.channels)
    for (const s of Array.isArray(form.steps) ? form.steps : []) {
      add(s?.notifications?.channels)
      add(s?.approval?.channels)
    }
  }
  return [...new Set(names)]
}
// A form naming a channel that is not there (Connections > Notifications) : said in the log, once
// per form and name - never an error, the notification skips it when it is sent
const warnedChannels = new Set()
async function warnUnknownChannels(form){
  const names = channelsOfForm(form).filter((n) => !warnedChannels.has(`${form.name}\u0000${n}`))
  if (!names.length) return
  try {
    const { default: NotificationChannel } = await import('./notificationChannel.model.js')
    const known = new Set((await NotificationChannel.findAll()).map((c) => c.name))
    for (const name of names) {
      if (known.has(name)) continue
      warnedChannels.add(`${form.name}\u0000${name}`)
      logger.warning(`Form '${form.name}' names the notification channel '${name}', which is not there (Connections > Notifications): its notifications skip it`)
    }
  } catch (e) {
    logger.debug(`The notification channels of form '${form.name}' could not be checked: ${e.message}`)
  }
}
Form.validateForm = function(obj){
  if(obj){
    // not awaited : a check against the database, its outcome a log line
    warnUnknownChannels(obj)
    const multistep = deprecatedMultistep(obj)
    if (multistep && !warnedMultistep.has(obj.name)) {
      warnedMultistep.add(obj.name)
      logger.warning(multistep)
    }

    const removed = removedIn7(obj)
    if (removed.length) {
      logger.error(removed)
      throw new Error(removed.join("\r\n"))
    }
    for (const line of deprecatedIn7_3(obj)) logger.warning(line)
    logger.debug("validating form against schema")
    const validate = ajv.compile(formSchema)
    const valid = validate(obj)
    if (!valid){
      var ajvMessages = AJVErrorParser.parseErrors(validate.errors)
      ajvMessages=ajvMessages.map(x => {
        try{
          var tmp=`${x}`
          var field
          field = Helpers.friendlyAJVError(tmp,"fields","Field",obj.fields)
          if(field.changed){
            tmp = field.value
          }
        }catch(e){
          logger.error(e)
          return x
        }     
        return tmp
      })
      logger.error(ajvMessages)
      throw new Error(`${ajvMessages.join("\r\n")}`)
    }else{
      logger.debug("Validated")
      return obj
    }
  }
}
Form.validate = function(forms){
  if(forms){
    logger.debug("validating the config and forms against the schema")
    // the designer saves through here ; see assertNoDuplicateRoles and assertRequiredRoles
    assertNoDuplicateRoles(forms)
    Form.assertRequiredRoles(forms)
    const validate = ajv.compile(formsSchema)
    const valid = validate(forms)
    if (!valid){
      var ajvMessages = AJVErrorParser.parseErrors(validate.errors)
      ajvMessages=ajvMessages.map(x => {
        try{
          var tmp=`${x}`
          var form
          var field
          var category
          var role
          category = Helpers.friendlyAJVError(tmp,"categories","Category",forms.categories)
          if(category.changed){
            return category.value
          }
          role = Helpers.friendlyAJVError(tmp,"roles","Role",forms.roles)
          if(role.changed){
            return role.value
          }        
          form = Helpers.friendlyAJVError(tmp,"forms","Form",forms.forms)
          if(form.changed){
            tmp = form.value
            field = Helpers.friendlyAJVError(tmp,"fields","Field",forms.forms[form.index].fields)
            if(field.changed){
              tmp = field.value
            }
          }   
        }catch(e){
          logger.error(e)
          return x
        }     

        return tmp

      })
      logger.error(ajvMessages)
      throw new Error(`${ajvMessages.join("\r\n")}`)
    }else{
      logger.debug("Config and forms are valid")
      return forms
    }
  }
}
Form.parse = function(data){
  var formsConfig
  try{
    logger.info("Parsing yaml data")
    formsConfig = yaml.parse(data.forms,{prettyErrors:true})
  }catch(err){
    logger.error("Error: ", err)
    throw new Error(Helpers.getError(err,"Failed to parse yaml"), { cause: err })
  }
  return formsConfig
}
Form.removeOld=function(days=60){
  // 0 KEEPS EVERYTHING, like every other retention setting in this product.
  //
  // `old > days` with days=0 deleted every restore point more than a day old - so the one
  // value an operator would reach for to mean "never prune" was the most destructive one
  // available, and it applies to the snapshots taken before each config-replacing write,
  // which are the only way back from a bad import.
  //
  // The Status page already asserted the opposite in as many words: it prints
  // 'restore points never' for 0 with the note "0 deletes nothing, for every one of
  // these". That page's whole premise is that it never claims a fact it has not
  // established, so the code is what was wrong here, not the note.
  //
  // A non-numeric value already behaved this way by accident (`old > NaN` is false);
  // it is explicit now rather than incidental.
  const keep = parseInt(days, 10)
  if(!(keep >= 1)){
    logger.debug("Config restore point retention is disabled (OLD_BACKUP_DAYS), keeping all snapshots")
    return
  }
  days = keep
  var items = fs.readdirSync(backupPath())
  if(items && items.length){
    // filter only backup yamls
    items=items.filter((item)=>item.match(/\.bak\.[0-9]{17}$/g))
    // read files
    items.forEach((item) => {
      var dt=item.substring(item.length-17) // get time part
      var iso=moment(dt.slice(0,8)) // get date part
      var old=moment().diff(moment(iso),"days") // how old ?
      if(old>days){ // date is older than x days ?
        logger.debug("Removing old backup item")
        fse.removeSync(path.join(backupPath(),item)) // remove backup
      }else{
        //logger.debug(`Keeping ${file} [${old} days]`)
      }
    });
  }
}
// configOnly : snapshot only the base config (repo mode keeps forms in git, so
// the forms directories are never snapshotted ; only the DB/disk config is).
// source : 'active' snapshots the config that is really being served (database,
// repository or local file) ; 'file' snapshots the on-disk config file and
// 'database' the database copy, even when that is not the active source - see
// below. A 'file' / 'database' snapshot is named after its source
// (configBackupPathForSource) so the restore reinstates it there.
Form.backup = async function(configOnly=false,source='active'){
  logger.info(configOnly ? "Making backup of config" : "Making backup of config and forms")
  const sourceFormsPath = formsPath()
  // 'HH' (00-23), not 'kk' (1-24) : with 'kk' a backup taken at midnight was named
  // hour '24', which moment can no longer reparse (see Form.backups)
  var timestamp=moment().format("YYYYMMDDHHmmssSSS")
  var backupformsdir=formsBackupPath() +".bak."+timestamp
  var backupconfigfile=configBackupPathForSource(source) +".bak."+timestamp
  var backupfile=path.parse(backupconfigfile).base
  Form.removeOld(appConfig.oldBackupDays) // read now : OLD_BACKUP_DAYS changes without a restart

  // Back up the ACTIVE base config, whatever serves it : the database (when
  // config_source or the env default says so and forms_yaml is not empty), a
  // repository working tree, or the local config.yaml - Settings.getActiveConfig
  // resolves exactly that, the same way the designer save does. Snapshotting
  // appConfig.configPath instead would write nothing at all in repository mode
  // (that file is then stale or absent), while still reporting a backup name.
  var activeConfig
  const sourceLabel = source==='file' ? 'config file' : (source==='database' ? 'database config' : 'active config')
  if(source==='file'){
    // source 'file' : snapshot the on-disk config file itself, for a write that
    // REPLACES that file with the database copy (Settings.exportConfig). There the
    // active config is the database, so an 'active' snapshot would only preserve
    // what is being written and the disk contents would be lost. The path is
    // resolved exactly like the one that write targets, and Form.restoreBackup
    // reinstates the snapshot onto that same file.
    const diskConfigPath = (await Repository.getConfigPath()) || appConfig.configPath
    logger.debug(`Backing up the config file '${diskConfigPath}'`)
    activeConfig = fs.existsSync(diskConfigPath) ? fs.readFileSync(diskConfigPath,'utf8') : ''
  }else if(source==='database'){
    // source 'database' : snapshot the database copy itself, for a write that
    // REPLACES it with the config file (Settings.importConfig). In file mode the
    // ACTIVE config IS that file, so an 'active' snapshot would preserve the very
    // content being imported and lose the database copy unrecoverably.
    logger.debug("Backing up the database config")
    const dbSettings = await Settings.findFormsYaml()
    activeConfig = dbSettings.forms_yaml || ''
  }else{
    activeConfig = await Settings.getActiveConfig()
  }
  var configBackedUp = false
  // an empty (or whitespace-only) source is not a restore point : a fresh install
  // with no config yet must not leave a bogus empty snapshot behind
  if(activeConfig && activeConfig.trim()){
    logger.debug(`Snapshotting the ${sourceLabel} -> '${backupconfigfile}'`)
    fse.ensureDirSync(path.dirname(backupconfigfile))
    fs.writeFileSync(backupconfigfile, activeConfig)
    configBackedUp = true
  }else{
    logger.warning(`There is no ${sourceLabel} to back up`)
  }

  // in config-only mode (repo mode + DB config) the forms live in git : only the
  // base config is snapshotted, the forms directory is left to git
  if(!configOnly){
    // Back up forms directory
    if(fs.existsSync(sourceFormsPath)){
      logger.debug(`Copying forms directory '${sourceFormsPath}'->'${backupformsdir}'`)
      fse.removeSync(backupformsdir) // just in case, remove it (unlikely hit)
      fse.ensureDirSync(backupformsdir) // make backupdir
      fse.copySync(sourceFormsPath,backupformsdir) // make backup
    }
  }
  // the returned name IS the config backup file name : it is what the backup list
  // shows and what Form.restore uses as its rollback point. Never report one for a
  // file that was not written, or a failed restore would silently not be undone.
  if(!configBackedUp){
    logger.warning("No config snapshot was written, so no backup is reported")
    // the forms directory above was already written under a timestamp nobody is
    // ever handed : Form.restore sees no rollback point and never calls Form.remove
    // for it, so it would linger for the whole retention period.
    // Named exactly like Form.remove names it, so nothing can be left behind
    for(const orphan of [backupformsdir]){
      if(fs.existsSync(orphan)){
        logger.debug(`Removing orphaned forms backup '${orphan}'`)
        fse.removeSync(orphan)
      }
    }
    return null
  }
  return backupfile
}
// remove unique backupname with forms folder
Form.remove = function(backupName){
  logger.debug(`Removing old backup '${backupName}'`)
  var backupformsdir=formsBackupPath()+getBackupSuffix(backupName)

  // Remove the config.yaml backup, whichever source it was taken from (a timestamp
  // only ever carries one of them, see configBackupPathForSource ; all are tried so
  // no orphan can be left behind)
  for(const source of ['active',...fixedBackupSources]){
    const backupconfigfile=configBackupPathForSource(source)+getBackupSuffix(backupName)
    if(fs.existsSync(backupconfigfile)){
      logger.debug(`Removing config file '${backupconfigfile}'`)
      fse.removeSync(backupconfigfile)
    }
  }

  // Remove forms directory backup
  if(fs.existsSync(backupformsdir)){
    logger.debug(`Removing forms directory '${backupformsdir}'`)
    fse.removeSync(backupformsdir)
  }
}
Form.restoreBackup = async function(backupName,configOnly=false){
  const targetFormsPath = formsPath()
  const suffix = getBackupSuffix(backupName)
  var backupformsdir=formsBackupPath()+suffix
  // a snapshot taken from a FIXED source lives under its own name and goes back to
  // that source ; only a plain 'active' snapshot follows whatever is serving the
  // config at restore time
  const configSource = backupConfigSource(backupName)
  var backupconfigfile=configBackupPathForSource(configSource)+suffix

  // Restore config.yaml
  if(fs.existsSync(backupconfigfile)){
    const toDatabase = configSource==='database' || (configSource==='active' && await resolveRestoreInDatabase())
    if(toDatabase){
      // the base config lives in the database : reinstate the snapshot into the
      // settings row (writing only to disk would leave the DB config untouched). A
      // 'database' snapshot (Settings.importConfig) goes here even when a file is
      // what currently serves the config.
      logger.debug(`Restoring database config from '${backupconfigfile}'`)
      await Settings.update({ forms_yaml: fs.readFileSync(backupconfigfile,'utf8') })
    }else{
      // a 'file' snapshot (Settings.exportConfig) goes back onto the config file,
      // which is what undoing that export means - reinstating it into the database
      // would replace the live config with a stale disk copy instead
      await restoreConfigFile(backupconfigfile)
    }
  }

  // in config-only mode (repo mode + DB config) the served forms come from git :
  // only the base config is reinstated, the forms directory is not touched
  if(!configOnly){

    // Restore forms directory
    if(fs.existsSync(backupformsdir)){
      logger.debug(`Copying forms directory '${backupformsdir}'->'${targetFormsPath}'`)
      fse.removeSync(targetFormsPath) // just in case, remove it (unlikely hit)
      fse.ensureDirSync(targetFormsPath) // make backupdir
      fse.copySync(backupformsdir,targetFormsPath) // make backup
    }
  }
}
/**
 * Refuses a designer save that names the same form twice.
 *
 * The loader keeps the first form of a name and skips the others (Form.load), so a
 * second form of the same name would be written and then never be seen again : the
 * designer would show the first one, and the edit made to the second one would be lost
 * on the next save. JSON Schema cannot say "unique by property", so it is checked here.
 *
 * Args:
 *   forms (object[]): the forms of the save.
 *
 * Raises:
 *   Errors.ConflictError: a form name is used more than once (409).
 */
function assertUniqueFormNames(forms){
  const seen = new Set()
  const duplicates = new Set()
  for (const form of (Array.isArray(forms) ? forms : [])) {
    const name = typeof form?.name === 'string' ? form.name : null
    if (name === null) continue
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  if (duplicates.size > 0) {
    throw new Errors.ConflictError(`A form named ${[...duplicates].map(n => `'${n}'`).join(", ")} already exists ; every form needs a name of its own`)
  }
}

Form.save = async function(data){
  // The checks of what the user sent come first, and each answers as the user's mistake
  // (lib/errors.js) : the controller turns them into a 400 or a 409 with their message,
  // where a plain Error became a 500 that read as a broken server.
  var formsConfig
  try {
    formsConfig = Form.parse(data)
    formsConfig = Form.validate(formsConfig)
  } catch (err) {
    if (err instanceof Errors.ApiError) throw err
    throw new Errors.BadRequestError(Helpers.getError(err))
  }
  assertUniqueFormNames(formsConfig.forms)
  const { configPath: targetConfigPath, formsDirs, repoMode, repoNames } = await getSaveTargets()
  logger.info(`Saving forms to ${formsDirs.map(d => d.path).join(", ")}`)
  var groups={}  // key "<repository>\0<source>" -> { repository, source, forms:[] }

  // filter source-forms out of forms and group them by their physical file :
  // (repository, source). The repository field (set on load when several forms
  // repos exist) keeps a form in its own repo even when another repo holds a
  // file of the same name ; it is internal and stripped before writing.
  // every form lives in a file of its own (7.0.0) : one without a file is refused rather
  // than written into the base config
  const homeless = (formsConfig.forms || []).filter(item => !item.source).map(item => item.name || '(no name)')
  if (homeless.length) {
    throw new Errors.BadRequestError(`Every form must be saved to a file in the forms folder ; not in a file: ${homeless.join(", ")}`)
  }
  formsConfig.forms = formsConfig.forms.filter(item => {
    var src = item.source
    if(src){
      const repo = item.repository ?? null
      const key = (repo ?? '') + '\0' + src
      if(!groups[key]) groups[key] = { repository: repo, source: src, forms: [] }
      groups[key].forms.push(item)
      return false
    }else{
      return true
    }
  })

  // a form 'source' is client-controlled ; reject any that would escape its
  // forms folder (path traversal / absolute path) before it is used as a path
  for (const g of Object.values(groups)) {
    const probe = path.resolve(formsPath(), g.source)
    if (g.source.includes("\0") || path.isAbsolute(g.source) || !probe.startsWith(path.resolve(formsPath()) + path.sep)) {
      throw new Errors.BadRequestError(`Invalid form source '${g.source}': must be a path inside the forms folder`)
    }
  }

  // resolve the target folder per group (own repo, then existing holder, then staging)
  for (const g of Object.values(groups)) {
    g.dir = resolveTargetDir(g.repository, g.source, formsDirs, (d, src) => fs.existsSync(path.join(d.path, src)))
  }

  // repository and source are internal placement fields : never write them to a form file or config
  // source is re-stamped from the filename on load ; repository pins a form to its repo
  for (const g of Object.values(groups)) for (const f of g.forms) { delete f.repository; delete f.source; }
  formsConfig.forms.forEach(f => { delete f.repository; delete f.source; })

  // determine write target before locking to avoid querying settings inside the lock
  const configSettings = await Settings.findFormsYaml()
  const useDatabase = Settings.resolveConfigInDatabase(configSettings)

  // lock the working trees for the duration of the write so a concurrent
  // pull/sync/clone/reset can't run git on the same files (issue #414). All-or-
  // nothing : a failed claim rolls back the ones already taken and throws a
  // 'busy, try again' error before anything is written.
  const held = await claimAllOrRollback(repoNames,
    name => Repository.claimForWrite(name),
    (name, token) => Repository.releaseWrite(name, token))

  // declared once for both branches below : two `var backupfile` in the same
  // function scope is the same variable, so only the branch that runs assigns it
  let backupfile
  try {
    if (!repoMode) {
      // local mode : snapshot before overwriting (in repo mode the git history is the backup)
      backupfile=await Form.backup()
      logger.debug(backupfile ? `Succesfull backup to ${backupfile}` : "No backup was made, there is no config yet")
    } else if (useDatabase) {
      // repo mode, but the base config lives in the database : git covers the
      // forms, yet the DB config has no git history, so snapshot it (config only)
      // before overwriting so a bad config save can still be rolled back
      backupfile=await Form.backup(true)
      logger.debug(backupfile ? `Succesfull config backup to ${backupfile}` : "No config backup was made, there is no config yet")
    }

    // every form name the save is writing, across ALL folders - a file is only a deletion
    // candidate when none of the names it defines survive anywhere
    const savedFormNames = new Set(
      Object.values(groups).flatMap(g => (g.forms || []).map(f => f?.name)).filter(Boolean)
    )
    for (const dirEntry of formsDirs) {
      const dirGroups = Object.values(groups).filter(g => g.dir === dirEntry)
      const dirFiles = dirGroups.map(g => g.source)
      // write the surviving form files FIRST, then delete the leftovers : a crash
      // mid-write then leaves the old files intact (no hole) rather than a folder
      // that was emptied before the replacements were written.
      for (const g of dirGroups) {
        const target = path.join(dirEntry.path, g.source)
        const forms = g.forms
        // the forms of this file the designer never received (no name, failing validation)
        // are written back as they were, in their places : saving another form of the file
        // must not drop them (formsToKeep)
        let kept = []
        if (fs.existsSync(target)) {
          const onDisk = readFileForms(target, g.source)
          if (onDisk === null) {
            // the loader left the whole file out, so none of its forms were in the designer :
            // writing over it would lose them all
            throw new Errors.BadRequestError(`The file '${g.source}' cannot be read as forms ; fix it, or save the form to another file`)
          }
          const savedNames = new Set(forms.map(f => f?.name).filter(Boolean))
          // a form the designer never received, sent now : it is that form, edited. It must
          // load once saved, or the save is refused with the reason
          for (const f of onDisk.forms.filter(x => x.notLoaded && x.name && savedNames.has(x.name))) {
            try {
              Form.validateForm({ ...structuredClone(forms.find(x => x.name === f.name)), source: g.source })
            } catch (e) {
              throw new Errors.BadRequestError(`Form '${f.name}' is not valid: ${Helpers.getError(e)}`)
            }
          }
          kept = formsToKeep(onDisk, savedNames)
          if (kept.length) logger.info(`Keeping ${kept.map(k => k.name ? `'${k.name}'` : '(a form with no name)').join(", ")} in '${target}' as it was : it does not load, so the designer never had it`)
        }
        logger.debug(`saving ${forms.length==1 ? `single form '${forms[0].name}'` : `forms ${forms.map(x => x.name)}`} to '${target}'`)
        // ensure parent directory exists for nested paths
        fse.ensureDirSync(path.dirname(target));
        fs.writeFileSync(target, formsFileText(forms, kept));
      }
      // a dedicated forms folder is fully managed : the yaml files of deleted
      // forms are removed ; a repository ROOT serving forms can hold unrelated
      // yaml files, there nothing is ever deleted. The staging folder is always
      // fully managed.
      // dirEntry.dedicated, NOT the basename : a repository named 'forms' has a ROOT path
      // ending in /forms, which the old test could not tell from a dedicated subfolder.
      const managed = !repoMode || dirEntry.staging || dirEntry.dedicated === true
      if (managed && fs.existsSync(dirEntry.path)) {
        for (const existing of listYamlFiles(dirEntry.path)) {
          if (!dirFiles.includes(existing)) {
            // "absent from the payload" is NOT the same as "the user deleted it".
            // Form.load silently drops a file it cannot parse, a form failing validation,
            // and a form whose name duplicates one already loaded - and the designer never
            // sees any of them, so they were never in the payload to begin with. Deleting
            // on absence alone therefore removed working files nobody touched: two forms
            // repositories both defining a form called 'Deploy' lost the second one's file
            // on the next save, and in repo mode Form.save takes no snapshot first.
            //
            // So only delete a file we can read AND whose form names have all genuinely
            // gone from the config. Anything unreadable, or still naming a form that
            // survived, is left alone and reported.
            const fullPath = path.join(dirEntry.path, existing)
            const onDisk = readFileForms(fullPath, existing)
            if (onDisk === null) {
              logger.warning(`Not removing '${existing}' from '${dirEntry.path}': it could not be parsed, so it was never loaded and cannot have been deleted here`)
              continue
            }
            // a form the designer never received cannot have been deleted in it. Such a file
            // stays as it is when nothing else in it was deleted, and is written again without
            // the deleted forms only : the forms that do not load stay, and so does a form
            // whose name the configuration still has (see stillDefined below)
            if (onDisk.forms.some(f => f.notLoaded)) {
              const kept = onDisk.forms.filter(f => f.notLoaded || (f.name && savedFormNames.has(f.name)))
              if (kept.length < onDisk.forms.length) {
                logger.info(`Keeping ${kept.map(k => k.name ? `'${k.name}'` : '(a form with no name)').join(", ")} in '${existing}' : the designer never had it ; the other forms of the file were deleted`)
                fs.writeFileSync(fullPath, kept.map(k => k.text).join(""))
              } else {
                logger.warning(`Not removing '${existing}' from '${dirEntry.path}': its forms do not load, so the designer never had them`)
              }
              continue
            }
            const definedNames = onDisk.forms.map(f => f.name).filter(Boolean)
            const stillDefined = definedNames.filter(n => savedFormNames.has(n))
            if (stillDefined.length > 0) {
              logger.warning(`Not removing '${existing}' from '${dirEntry.path}': it defines ${stillDefined.join(", ")}, which the configuration still has - most likely a duplicate form name that the loader skipped`)
              continue
            }
            logger.debug(`Removing deleted form file '${existing}' from '${dirEntry.path}'`)
            fse.removeSync(fullPath)
          }
        }
      }
    }

    // the base config only : categories, roles, constants - the forms are in their files
    delete formsConfig.forms
    const configYaml = yaml.stringify(formsConfig)

    if (useDatabase) {
      logger.debug("Writing base config to database")
      await Settings.update({ forms_yaml: configYaml })
    } else {
      logger.debug(`Writing base file '${targetConfigPath}'`)
      fse.ensureDirSync(path.dirname(targetConfigPath));
      fs.writeFileSync(targetConfigPath, configYaml);
    }
  }
  catch(err) {
    // handle error
    logger.error("Failed to save forms: ",err)
    // a refusal (lib/errors.js) keeps its class and its status ; only a real failure
    // becomes the generic "Failed to save forms"
    if (err instanceof Errors.ApiError) throw err
    throw new Error(Helpers.getError(err,"Failed to save forms"), { cause: err })
  }
  finally {
    // release the working-tree locks, restoring each repo's prior status (the
    // save is not a git op, so its status must reflect the last pull/sync)
    for (const h of held) {
      await Repository.releaseWrite(h.name, h.token).catch(e => logger.error(`Failed to release write-lock on '${h.name}': ${e.message}`))
    }
  }

  return true
}
// ===========================================================================
// FORMS THE DESIGNER NEVER SAW
// ===========================================================================
// The loader leaves out a form that has no name or fails validation (Form.load) : it is
// reported as an error, and the designer never receives it. A save rewrites a file from the
// forms the designer sent, so such a form was dropped from its file - and from git at the
// next push - by a save of ANOTHER form of the same file. These helpers find those forms on
// disk so the save writes them back exactly as they were.

/**
 * Tells whether the loader would leave a form of a file out (Form.load) : not a mapping, no
 * name, or a form failing validation.
 *
 * Args:
 *   item (any): one form of a file, as parsed.
 *   filename (string): the file, relative to its forms folder ; the loader validates a form
 *     with it as its source.
 *
 * Returns:
 *   boolean: true when the designer never received this form.
 */
function notLoaded(item, filename) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !item.name) return true
  try {
    Form.validateForm({ ...structuredClone(item), source: filename })
    return false
  } catch {
    return true
  }
}

/**
 * Reads the forms of a file on disk, each with the text it is written in, and whether the
 * designer ever received it.
 *
 * The text of a form is the file's own bytes for that entry - its comments and the blank
 * lines before it included - when the file is a block list at the top level, which is how a
 * file of several forms is written. Otherwise (a single form, a flow list, an indented list)
 * the parsed node is kept, and written again with its comments and styles.
 *
 * Args:
 *   fullPath (string): the file.
 *   filename (string): the file, relative to its forms folder.
 *
 * Returns:
 *   object|null: { forms: [{ name, notLoaded, text }], single (the file holds one form, not
 *   a list) } ; null when the file cannot be read or parsed as forms (the loader then left
 *   the whole file out).
 */
function readFileForms(fullPath, filename) {
  let raw
  let doc
  try {
    raw = fs.readFileSync(fullPath, "utf8")
    doc = yaml.parseDocument(raw)
  } catch {
    return null
  }
  if (doc.errors.length) return null
  const contents = doc.contents
  let nodes
  if (contents === null || contents === undefined) nodes = []
  else if (yaml.isSeq(contents)) nodes = contents.items
  else if (yaml.isMap(contents)) nodes = [contents]
  else return null
  const values = [].concat(doc.toJS() ?? [])
  const blockList = yaml.isSeq(contents) && !contents.flow
  let previousEnd = 0
  const forms = nodes.map((node, i) => {
    let text = null
    if (blockList && node?.range) {
      // the entry from the end of the previous one : its "- " marker, and the comments and
      // blank lines above it. A document marker or a directive there is not taken along.
      const lineStart = raw.lastIndexOf("\n", node.range[0] - 1) + 1
      let start = previousEnd
      const above = raw.slice(previousEnd, lineStart)
      if (!above.split("\n").every(line => /^\s*(#.*)?$/.test(line))) start = lineStart
      // the marker at the first column only : an indented list cannot be mixed with the
      // entries written at the first column
      if (/^-\s+$/.test(raw.slice(lineStart, node.range[0]))) {
        text = raw.slice(start, node.range[2])
        if (!text.endsWith("\n")) text += "\n"
      }
      previousEnd = node.range[2]
    }
    if (text === null) {
      // the node itself, as an entry of a list
      const one = new yaml.Document()
      one.contents = new yaml.YAMLSeq()
      one.contents.items.push(node)
      text = String(one)
    }
    const value = values[i]
    return { name: value?.name, notLoaded: notLoaded(value, filename), text }
  })
  return { forms, single: !yaml.isSeq(contents) }
}

/**
 * The forms of a file a save keeps : the ones the designer never received, unless the save
 * writes a form of the same name into that file (it is then that form, edited).
 *
 * Args:
 *   onDisk (object|null): the file, as readFileForms returns it.
 *   savedNames (Set<string>): the names of the forms the save writes into the file.
 *
 * Returns:
 *   object[]: [{ index (its place in the file), name, text }].
 */
function formsToKeep(onDisk, savedNames) {
  if (!onDisk) return []
  return onDisk.forms
    .map((f, index) => ({ ...f, index }))
    .filter(f => f.notLoaded && !(f.name && savedNames.has(f.name)))
}

/**
 * The text of a forms file : the forms the designer sent, with the forms it never received
 * back in their places.
 *
 * Args:
 *   forms (object[]): the forms the save writes into the file, in their order.
 *   kept (object[]): the forms to keep, as formsToKeep returns them.
 *
 * Returns:
 *   string: the yaml text of the file.
 */
function formsFileText(forms, kept) {
  // nothing to keep : the file is written as it always was, a single form as a mapping
  if (!kept.length) return yaml.stringify(forms.length == 1 ? forms[0] : forms)
  const entries = forms.map(form => ({ text: yaml.stringify([form]) }))
  for (const k of kept) entries.splice(Math.min(k.index, entries.length), 0, k)
  return entries.map(e => e.text).join("")
}

/**
 * The roles a configuration backup holds, for a check before it is restored.
 *
 * Args:
 *   backupName (string): the backup.
 *
 * Returns:
 *   object[]|null: its roles ; null when the backup holds no base configuration.
 */
Form.backupRoles = function(backupName){
  const suffix = getBackupSuffix(backupName)
  const file = configBackupPathForSource(backupConfigSource(backupName))+suffix
  if(!fs.existsSync(file)) return null
  return yaml.parse(fs.readFileSync(file,'utf8'))?.roles || []
}

Form.restore = async function(backupName,backupBeforeRestore){
  logger.info(`Restoring backup '${backupName}'`)
  var tmpbackup
  const { repoMode } = await getSaveTargets()
  // the SAME expression Form.restoreBackup routes on : with a different one this
  // guard could pass while the restore below still took the disk branch and wrote
  // config.yaml into a repository working tree (issue : config_source='database'
  // with a forms_yaml that is still empty, e.g. right after switching source)
  const useDatabase = await resolveRestoreInDatabase()
  if (repoMode && !useDatabase) {
    // forms live in git repositories and no config is in the database : the
    // snapshots only cover the local folders, restoring them would not affect
    // the served forms
    throw new Error("Forms are managed in git repositories ; restore a previous state from the git history instead")
  }
  // in repo mode only the DB base config is restorable ; the forms stay in git
  const configOnly = repoMode
  try {
    // first backup current (config only in repo mode : no repo working tree is touched)
    // ; a null means nothing was snapshotted, so there is no rollback point either.
    // Snapshot the same source the restore is about to write : undoing a failed
    // restore of a 'file' / 'database' snapshot must reinstate that source, not
    // whatever happens to be the active one.
    tmpbackup=await Form.backup(configOnly,backupConfigSource(backupName))
    if(!tmpbackup){
      logger.warning("Could not snapshot the current config before restoring ; this restore can not be undone")
    }
    await Form.restoreBackup(backupName,configOnly)
    if(!backupBeforeRestore && tmpbackup)
      Form.remove(tmpbackup)
    return true
  }catch(e){
    logger.error(`Failed to restore '${backupName}'.` + e)
    if(tmpbackup){
      try{
        await Form.restoreBackup(tmpbackup,configOnly)
      }catch(err){
        logger.error(`Failed to undo failed restore '${tmpbackup}' !!`)
      }
    }
    return false
  }
}
// Form.loadByName = async function(form,user,forApproval=false){
//   var forms = await Form.load()
//   var formObj = forms?.forms.filter(x => x.name==form)
//   if(formObj.length>0){
//     if(forApproval){
//       return formObj[0]
//     }
//     logger.debug(`Form ${form} is found, checking access...`)
//     var access = formObj[0].roles.filter(role => user?.roles?.includes(role))
//     if(access.length>0 || user?.roles?.includes("admin")){
//       return formObj[0]
//       //logger.debug(`Form ${form}, access allowed...`)
//     }else {
//       logger.warning(`Form ${form}, no access...`)
//       return null
//     }
//   }else{
//     return null
//   }

// }
// create the backup path, and clear backups past their retention
Form.initBackupFolder=function(){
  try{
    fs.mkdirSync(backupPath(), { recursive: true })
  }catch(e){
    logger.error("Failed to init backup folder\n",e)
  }
  Form.removeOld(appConfig.oldBackupDays) // read now : OLD_BACKUP_DAYS changes without a restart
}
export default  Form;
// the form file cache, for the tests
export { getFormsFromFile, walkYamlFiles };
