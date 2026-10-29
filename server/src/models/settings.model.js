'use strict';
import logger from "../lib/logger.js";
import mysql from "./db.model.js";
import nodemailer from "nodemailer";
import crypto from "../lib/crypto.js";
import Repository from './repository.model.js';
import Lock from './lock.model.js';
import appConfig from "./../../config/app.config.js";
import { configRepoFromPath } from "../lib/forms-git.js";
import fs from 'fs';
import path from 'path';
import yaml from "yaml";
import Announcement from './announcement.model.js';

//mail object create
var Settings=function(settings){
    // Only set properties whose key is actually present on the input, so a
    // partial update (e.g. only the mail_* fields) never wipes other columns.
    if(settings.mail_server !== undefined){
      this.mail_server = settings.mail_server;
    }
    if(settings.mail_port !== undefined){
      this.mail_port = settings.mail_port;
    }
    if(settings.mail_secure !== undefined){
      this.mail_secure = (settings.mail_secure)?1:0;
    }
    if(settings.mail_username !== undefined){
      this.mail_username = settings.mail_username;
    }
    // Handle mail_password: undefined = don't update, "" = clear password, "value" = encrypt
    if(settings.mail_password !== undefined){
      if(settings.mail_password === ""){
        this.mail_password = "";
      } else {
        this.mail_password = crypto.encrypt(settings.mail_password);
      }
    }
    if(settings.mail_from !== undefined){
      this.mail_from = settings.mail_from;
    }
    if(settings.url !== undefined){
      this.url = settings.url;
    }
    // forms_yaml is deliberately NOT accepted here. This constructor feeds the
    // generic PUT /settings, which knows nothing about config content : writing the
    // config through it would bypass the designer-lock 423, the yaml parse +
    // Form.validateConfig check, the baseHash concurrency check AND the restore
    // point. Config content only ever goes through saveConfig -> saveActiveConfig
    // (or importConfig), which do all four. config_source stays : switching the
    // mode IS the settings page's job, and it writes no config content.
    if(settings.config_source !== undefined){
      this.config_source = settings.config_source || null;
    }
    if(settings.default_language !== undefined){
      this.default_language = settings.default_language || null;
    }
    if(settings.default_theme !== undefined){
      this.default_theme = settings.default_theme || null;
    }
    if(settings.default_theme_color !== undefined){
      this.default_theme_color = settings.default_theme_color || null;
    }
    // Settings > Appearance : each kept to what the page offers, an empty value none
    const text = (v, max) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
    const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);
    if(settings.app_name !== undefined){
      this.app_name = text(settings.app_name, 100);
    }
    // the environment label of before (env_label, env_label_color, env_label_show) is neither
    // written nor read : it became the first of the labels (Settings > Appearance > Labels, the
    // schema patch addLabelsTable), its columns kept only for that move
    if(settings.forms_view !== undefined){
      this.forms_view = oneOf(settings.forms_view, FORMS_VIEWS);
    }
    // the time zone dates show in : UTC, the browser's own, or a zone name (Europe/Madrid)
    if(settings.default_timezone !== undefined){
      this.default_timezone = validTimezone(settings.default_timezone);
    }
    // the date format dates show in (Settings > Appearance > Defaults)
    if(settings.default_date_format !== undefined){
      this.default_date_format = oneOf(settings.default_date_format, DATE_FORMATS);
    }
    // the header's own links (Settings > Appearance > Links > Custom), kept as JSON ; none : null
    if(settings.header_links !== undefined){
      const links = validHeaderLinks(settings.header_links);
      this.header_links = links.length ? JSON.stringify(links) : null;
    }
};
// the most links the header takes, and the longest label : it has room for a few short ones
// the most links in the header itself, the most inside one of them, the longest label : the
// header has room for a few short ones
export const MAX_HEADER_LINKS = 5;
export const MAX_NESTED_LINKS = 10;
const MAX_LINK_LABEL = 30;
/**
 * The header's own links, as Settings > Appearance > Links keeps them : each an id, a label, an
 * http or https address or a path of the app (/forms/all), a Font Awesome icon's name, whether
 * it opens in a new tab, and the link it sits inside (parent : another link's id) or none - in
 * the header itself. A link with links inside it is a menu in the header ; its own address is
 * then optional (the first entry of its menu when it has one). One level only : a link inside
 * a link that is itself inside one, or inside one that is not there, goes to the header.
 *
 * A link without a label, or with an address that is not a site or a page of the app
 * (javascript:, data:, //host), is left out - so is a menu left with nothing to open.
 *
 * Args:
 *   value (Array|string|null): the links, or their JSON.
 *
 * Returns:
 *   Array: the valid links in their order, at most MAX_HEADER_LINKS in the header and
 *     MAX_NESTED_LINKS inside each.
 */
export function validHeaderLinks(value){
  let list = value;
  if(typeof list === 'string'){
    try { list = JSON.parse(list); } catch { return []; }
  }
  if(!Array.isArray(list)) return [];
  // ------------------------------------------------------------------
  // each link as it may be kept : an id of its own, an address only when valid
  // ------------------------------------------------------------------
  const seen = new Set();
  const items = [];
  list.forEach((item, index) => {
    if(!item || typeof item !== 'object') return;
    const label = String(item.label ?? '').trim().slice(0, MAX_LINK_LABEL);
    if(!label) return;
    const url = String(item.url ?? '').trim();
    if(url && !isLinkUrl(url)) return;
    let id = /^[a-z0-9]{1,16}$/.test(String(item.id ?? '')) ? String(item.id) : `l${index}`;
    while(seen.has(id)) id = `${id}x`;
    seen.add(id);
    const icon = /^[a-z0-9-]{1,40}$/.test(String(item.icon ?? '')) ? String(item.icon) : 'link';
    const parent = /^[a-z0-9]{1,16}$/.test(String(item.parent ?? '')) ? String(item.parent) : null;
    items.push({ id, label, url, icon, newTab: !!item.newTab, parent });
  });
  // ------------------------------------------------------------------
  // one level : inside a link of the header, else in the header itself
  // ------------------------------------------------------------------
  const byId = new Map(items.map((l) => [l.id, l]));
  // first inside a link that is there and is not itself ...
  for(const l of items){
    if(l.parent && (!byId.has(l.parent) || l.parent === l.id)) l.parent = null;
  }
  // ... then only one level : inside a link that is inside another, it goes to the header
  const nested = new Set(items.filter((l) => l.parent).map((l) => l.id));
  for(const l of items){
    if(l.parent && nested.has(l.parent)) l.parent = null;
  }
  // ------------------------------------------------------------------
  // what opens something : a link inside needs an address, one in the header an address or
  // links inside it ; then the limits
  // ------------------------------------------------------------------
  const inside = (top) => items.filter((l) => l.parent === top.id && l.url);
  const kept = [];
  let tops = 0;
  for(const l of items.filter((x) => !x.parent)){
    const children = inside(l).slice(0, MAX_NESTED_LINKS);
    if(!l.url && !children.length) continue;
    if(tops >= MAX_HEADER_LINKS) break;
    tops++;
    kept.push({ id: l.id, label: l.label, url: l.url, icon: l.icon, newTab: l.newTab, parent: null });
    for(const c of children) kept.push({ id: c.id, label: c.label, url: c.url, icon: c.icon, newTab: c.newTab, parent: l.id });
  }
  return kept;
}
/**
 * Whether an address may be a header link : http or https with a host, or a path of the app
 * (one leading slash, not two : //host is another site ; no backslash : browsers read /\\host
 * as //host).
 *
 * Args:
 *   url (string): the address.
 *
 * Returns:
 *   boolean: true when it may.
 */
export function isLinkUrl(url){
  if(!url || url.length > 500 || /[\s\\]/.test(url)) return false;
  if(/^\/(?!\/)/.test(url)) return true;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}
/**
 * A default time zone as Settings > Appearance > Defaults keeps it : UTC, browser (each
 * browser's own zone) or a zone name this server knows ; anything else is none.
 *
 * Args:
 *   value (string): the zone asked for.
 *
 * Returns:
 *   string|null: the zone, or null.
 */
export function validTimezone(value){
  if(!value || typeof value !== 'string') return null;
  if(value === 'UTC' || value === 'browser') return value;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.slice(0, 64);
  } catch {
    return null;
  }
}
// what Settings > Appearance offers : the environment label's colours (the app's
// pill tones), the forms list's views
export const LABEL_COLORS = ['blue', 'green', 'amber', 'orange', 'red', 'grey'];
export const FORMS_VIEWS = ['tiles', 'list'];
// the date formats offered, as dayjs writes them : digits and separators only
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'];
// Resolve whether the ACTIVE config lives in the database, from a findFormsYaml record.
//
// Precedence is the same everywhere in the app: the ENVIRONMENT first, then the database,
// then the built-in default. An explicitly set ENABLE_CONFIG_IN_DATABASE therefore wins over the config_source column, and the UI
// greys the selector out when that is the case rather than offering an edit that cannot take.
//
// This REVERSED in 6.3.0. Before, the column won and the variable was only a fallback, so a
// value an operator had put in their compose file could be silently overridden from a web
// page. Note the upgrade consequence: an instance with the variable set AND a differing
// column now follows the variable, which can change which configuration it serves.
//
// Pure : no I/O, safe to call anywhere the findFormsYaml record is already in hand.
Settings.configSourceFromEnv = function () {
  // undefined means 'not configured', which is not the same as 0
  const explicit = process.env.ENABLE_CONFIG_IN_DATABASE;
  return explicit === undefined ? null : explicit == 1;
}

Settings.resolveConfigInDatabase = function (settings) {
  const fromEnv = Settings.configSourceFromEnv()
  if (fromEnv !== null) return fromEnv
  return settings.config_source
    ? settings.config_source === 'database'
    : appConfig.enableConfigInDatabase
}
Settings.update = async function (record) {
    logger.info(`Updating settings`)
    // Guard the chokepoint : a record with zero own properties renders an empty
    // SET clause, which mysql2 turns into invalid SQL. The controller pre-checks and
    // returns 400 ; log a warning and no-op instead of querying for any other caller.
    const cols = Object.keys(record)
    if (cols.length === 0) {
      logger.warning("Settings.update called with an empty record, nothing to update")
      return
    }
    // The settings table is implicitly single-row, but on a broken init seed /
    // partial DB restore it can be empty (findFormsYaml now tolerates that). A
    // bare UPDATE would then affect 0 rows and silently discard the data while
    // reporting success (a DB-mode designer save, PUT settings/config or
    // importConfig). So upsert : INSERT when the table is empty, else UPDATE.
    //
    // Use a single atomic conditional INSERT (... SELECT ... WHERE NOT EXISTS)
    // rather than a COUNT-then-INSERT : two concurrent updates on a fresh empty
    // table could both pass a COUNT check and insert a duplicate into this
    // single-row table. The INSERT's affectedRows then tells us whether the row
    // already existed (0 => a row was already present, so fall through to
    // UPDATE). We can't drive that decision off an UPDATE's affectedRows because
    // mysql2's default flags (no CLIENT_FOUND_ROWS, see db.model.js) report
    // affectedRows=0 for an UPDATE that matches a row but changes nothing.
    const values = cols.map((k) => record[k])
    const ins = await mysql.do(
      "INSERT INTO AnsibleForms.`settings` (??) SELECT ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM AnsibleForms.`settings`)",
      [cols, values]
    )
    if (ins.affectedRows > 0) {
      return ins
    }
    return mysql.do("UPDATE AnsibleForms.`settings` set ?", record)
};
Settings.getLogo = function () {
  return mysql.do("SELECT logo FROM AnsibleForms.`settings` limit 1;")
    .then((res) => (res.length > 0 && res[0].logo) ? res[0].logo : null)
};
Settings.setLogo = async function (logo) {
  logger.info(`Updating custom logo`)
  // reuse the race-safe single-row upsert in Settings.update (same fresh-install
  // empty-table case), rather than duplicating the COUNT-then-INSERT pattern.
  await Settings.update({ logo })
};
// the website icon (browser tab) : a data url, or null for the bundled one
Settings.getFavicon = function () {
  return mysql.do("SELECT favicon FROM AnsibleForms.`settings` limit 1;")
    .then((res) => (res.length > 0 && res[0].favicon) ? res[0].favicon : null)
};
Settings.setFavicon = async function (favicon) {
  logger.info(`Updating the website icon`)
  await Settings.update({ favicon })
};
// backstop against overwriting the config while the designer holds the lock.
// The controllers pre-check this and return a clean 423 ; the check also lives here so
// no caller of the model can skip it.
Settings.assertDesignerNotLocked = async function(){
  if (await Lock.isHeld()) {
    throw new Error("Configuration is locked by the designer. Please close the designer and try again.")
  }
}
// Snapshot the ACTIVE config before overwriting it, so a bad write can be rolled
// back from the backups page (the designer save path does the same, see
// Form.save). Config only : no forms are touched here. form.model.js imports this
// model, so a top-level import would be circular : import it lazily.
// source 'active' snapshots whatever currently serves the config ; 'file' snapshots
// the on-disk config file, which is what a write that REPLACES that file with the
// database copy needs (see Settings.exportConfig), and 'database' snapshots the
// database copy, which is what the opposite write needs (see Settings.importConfig).
async function backupConfig(source='active'){
  const { default: Form } = await import('./form.model.js')
  const backupfile = await Form.backup(true,source)
  if(backupfile){
    logger.debug(`Succesfull config backup to ${backupfile}`)
  }else{
    logger.warning("No config snapshot was written, this change can not be rolled back")
  }
}
/**
 * Loads config.yaml (the repository copy when a use_for_config repository holds it) into the
 * database, replacing the database copy after a restore point of it.
 *
 * Args:
 *   options (object): optional :
 *     assertRoles (function): awaited with the roles of the file (null for a ytt template,
 *       whose roles cannot be read) before anything is written ; it throws to refuse.
 *
 * Returns:
 *   Promise<string>: the message for the user.
 *
 * Raises:
 *   Error: the file is missing, not valid YAML or fails the base schema, or assertRoles refused.
 */
Settings.importConfig = async function({ assertRoles } = {}){
  await Settings.assertDesignerNotLocked()
  const configPath = (await Repository.getConfigPath()) || appConfig.configPath
  if(!fs.existsSync(configPath)){
    logger.error(`Config path ${configPath} doesn't exist`)
    throw new Error(`Config path ${configPath} doesn't exist`)
  }

  logger.notice(`Loading ${configPath} into the database`)
  let configFile = fs.readFileSync(configPath, 'utf8')
  // Validate BEFORE writing, exactly as saveConfig does. This path used to copy the file
  // in unchecked, so importing a malformed or schema-invalid config.yaml stored something
  // Form.load could not read - and when config_source is 'database' that is the active
  // config, so the import bricked every form through the UI with no way back but the
  // restore point. A ytt template is skipped: it is not plain YAML until ytt renders it,
  // which is the same reason the visual editors go read-only on one (/^\s*#@/m).
  // the roles of the file, for assertRoles : null while they cannot be read (a ytt template)
  let roles = null
  if(!/^\s*#@/m.test(configFile)){
    let parsed
    try{
      parsed = yaml.parse(configFile)
    }catch(err){
      throw new Error(`${configPath} is not valid YAML: ${err.message}`, { cause: err })
    }
    // imported lazily : form.model.js imports THIS module, so a static import would be a
    // cycle and Form would still be in its temporal dead zone at module-init time
    const { default: Form } = await import('./form.model.js')
    // same three sections saveConfig checks - forms are validated per form on load
    Form.validateConfig({
      categories: parsed?.categories || [],
      roles: parsed?.roles || [],
      constants: parsed?.constants || {}
    })
    roles = parsed?.roles || []
  }else{
    logger.warning(`${configPath} is a ytt template, importing it without validation`)
  }
  // importing replaces the DATABASE copy : snapshot that copy, not the active
  // config. In file mode getActiveConfig() returns the FILE, so an 'active'
  // snapshot would have made a restore point out of the very file being imported
  // while the previous forms_yaml was lost unrecoverably.
  // Unlike exportConfig there is deliberately no "database must be the active
  // source" guard here : seeding the database from config.yaml BEFORE switching
  // config_source to 'database' is a supported migration path. A 'database'
  // snapshot is restored back into the database whatever the active source is
  // (see configBackupPathForSource in form.model.js), so that stays safe.
  // the caller's check of the roles, before the restore point and the write
  if (assertRoles) await assertRoles(roles)
  await backupConfig('database')
  var settings = await Settings.findFormsYaml()
  settings.forms_yaml = configFile
  await Settings.update(settings)
  return "config.yaml imported successfully"

}
Settings.exportConfig = async function(){
  await Settings.assertDesignerNotLocked()
  const settings = await Settings.findFormsYaml()
  // exporting overwrites the config file with the database copy : when the
  // database is not the ACTIVE config source that copy is a stale snapshot while
  // the file is the live config, so refuse instead of destroying it.
  // both refusals are a state problem the admin can act on, not a server fault :
  // tag them so the controller answers 400 instead of 500.
  if(!Settings.resolveConfigInDatabase(settings)){
    throw Object.assign(new Error("The database is not the active config source, refusing to overwrite the config file"),{ statusCode: 400 })
  }
  if(!settings.forms_yaml || !settings.forms_yaml.trim()){
    throw Object.assign(new Error("No config found in the database to export"),{ statusCode: 400 })
  }
  const configPath = (await Repository.getConfigPath()) || appConfig.configPath
  logger.notice(`Exporting database config to ${configPath}`)
  // leave a restore point in the backups page before overwriting the file (the
  // designer save path does the same). Snapshot the FILE, not the active config :
  // the active config here is the database copy we are about to write out, so an
  // 'active' snapshot would preserve the new content and lose the old file.
  await backupConfig('file')
  // when config.yaml lives in a repository working tree, claim its write-lock so
  // the fs write can't race a concurrent scheduled pull/sync running git on the
  // same tree (issue #414). A plain local path (no repo) needs no claim.
  const repoName = configRepoFromPath(configPath, appConfig.repoPath)
  const token = repoName ? await Repository.claimForWrite(repoName) : undefined
  try {
    fs.writeFileSync(configPath, settings.forms_yaml, 'utf8')
  } finally {
    if (repoName && token !== undefined) {
      await Repository.releaseWrite(repoName, token).catch(e => logger.error(`Failed to release write-lock on '${repoName}': ${e.message}`))
    }
  }
  return "config.yaml exported successfully"
}
Settings.getActiveConfig = async function() {
  const settings = await Settings.findFormsYaml()
  const useDatabase = Settings.resolveConfigInDatabase(settings)

  if (useDatabase && settings.forms_yaml && settings.forms_yaml.trim()) {
    return settings.forms_yaml
  }

  const configPath = (await Repository.getConfigPath()) || appConfig.configPath
  if (!fs.existsSync(configPath)) {
    return ''
  }
  return fs.readFileSync(configPath, 'utf8')
}
// options.ignoreDesignerLock : a write the app makes itself (the role `public` renamed `default`,
// Form.getBaseConfig), one word the designer's editor cannot be in the middle of
Settings.saveActiveConfig = async function(yamlStr, options = {}) {
  if (!options.ignoreDesignerLock) await Settings.assertDesignerNotLocked()
  const settings = await Settings.findFormsYaml()
  const useDatabase = Settings.resolveConfigInDatabase(settings)

  if (useDatabase) {
    logger.info("Saving config to database")
    // snapshot the config before it is overwritten
    await backupConfig()
    await Settings.update({ forms_yaml: yamlStr })
    return
  }

  const configPath = (await Repository.getConfigPath()) || appConfig.configPath
  logger.info(`Saving config to ${configPath}`)
  // when config.yaml lives in a repository working tree, claim its write-lock so
  // the fs write can't race a concurrent scheduled pull/sync running git on the
  // same tree (issue #414). A plain local path (no repo) needs no claim.
  const repoName = configRepoFromPath(configPath, appConfig.repoPath)
  // snapshot the config before it is overwritten. In a repository working tree the
  // git history is the backup (Form.backup only snapshots the local config file),
  // so nothing is snapshotted there : same as the designer save path.
  if (!repoName) {
    await backupConfig()
  }
  const token = repoName ? await Repository.claimForWrite(repoName) : undefined
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, yamlStr, 'utf8')
  } finally {
    if (repoName && token !== undefined) {
      await Repository.releaseWrite(repoName, token).catch(e => logger.error(`Failed to release write-lock on '${repoName}': ${e.message}`))
    }
  }
}
Settings.find = function () {

  return mysql.do("SELECT * FROM AnsibleForms.`settings` limit 1;")
    .then((res)=>{
      if(res.length>0){
        try{
          if(res[0].mail_password!=""){
            res[0].mail_password=crypto.decrypt(res[0].mail_password)
          }
        }catch(e){
          logger.error("Couldn't decrypt mail password, did the secretkey change ?")
          res[0].mail_password=""
        }
        res[0].enableConfigInDatabase = appConfig.enableConfigInDatabase
        // internal bookkeeping (secrets/importVaultEnv.js, lib/syslogServers.js), not settings
        delete res[0].vault_env_imported_at
        delete res[0].syslog_env_imported_at
        // the environment label of before : the labels' first now (Settings > Appearance >
        // Labels), its columns kept only for that move
        delete res[0].env_label
        delete res[0].env_label_color
        delete res[0].env_label_show
        return res[0]
      }else{
        logger.error("No settings record in the database, something is wrong")
        throw "No settings record in the database, something is wrong"
      }
    })

};
Settings.findMailSettings = function () {
  return mysql.do("SELECT mail_server,mail_port,mail_secure,mail_username,mail_password,mail_from FROM AnsibleForms.`settings` limit 1;")
    .then((res)=>{
      if(res.length>0){
        try{
          if(res[0].mail_password!=""){
            res[0].mail_password=crypto.decrypt(res[0].mail_password)
          }
        }catch(e){
          logger.error("Couldn't decrypt mail password, did the secretkey change ?")
          res[0].mail_password=""
        }
        return res[0]
      }else{
        logger.error("No settings record in the database, something is wrong")
        throw "No settings record in the database, something is wrong"
      }
    })

};
Settings.findUrl = function () {

  return mysql.do("SELECT url FROM AnsibleForms.`settings` limit 1;")
    .then((res)=>{
      if(res.length>0){
        return res[0]
      }else{
        logger.error("No settings record in the database, something is wrong")
        throw "No settings record in the database, something is wrong"
      }
    })

};
// language and theme defaults for the unauthenticated SPA bootstrap endpoint.
// They all live on the same single settings row, so read them in ONE query : that
// endpoint blocks the SPA from rendering even the login page, so a MySQL outage
// must cost one connectTimeout, not one per setting.
Settings.findAppDefaults = function () {
  return mysql.do("SELECT default_language, default_theme, default_theme_color, app_name, forms_view, default_timezone, default_date_format, header_links FROM AnsibleForms.`settings` LIMIT 1")
    .then(async (res) => {
      const r = res[0] || {};
      // the announcements enabled and not ended yet (Settings > Appearance > Announcements) ;
      // which run now is decided per request (routes/v2/app.routes.js). A table not there yet (a
      // database before its patch) : none
      const announcements = await Announcement.findNotEnded().catch(() => []);
      return {
        language: r.default_language || null,
        theme: r.default_theme || null,
        color: r.default_theme_color || null,
        // Settings > Appearance
        appName: r.app_name || null,
        // the labels beside the logo (Settings > Appearance > Labels), those shown, in their order ;
        // a table not there yet (a database before its patch) : none
        labels: await import('./label.model.js').then((m) => m.default.findShown()).catch(() => []),
        announcements,
        formsView: r.forms_view || null,
        timezone: r.default_timezone || null,
        dateFormat: r.default_date_format || null,
        // only for who is signed in (GET /api/v2/app/links), never the public /config
        headerLinks: validHeaderLinks(r.header_links),
      };
    })
}
Settings.findFormsYaml = function () {

  return mysql.do("SELECT forms_yaml, config_source FROM AnsibleForms.`settings` limit 1;")
    .then((res)=>{
      if(res.length>0){
        return res[0]
      }else{
        // A missing settings row (failed init seed / partial DB restore) must not
        // break config loading : every caller guards on a truthy forms_yaml and
        // falls back to file mode, so return empty values instead of throwing.
        logger.error("No settings record in the database, something is wrong")
        return { forms_yaml: null, config_source: null }
      }
    })
    .catch((err)=>{
      // A missing settings TABLE (ER_NO_SUCH_TABLE) or a missing database
      // (ER_BAD_DB_ERROR, 'Unknown database') is the file-mode install case :
      // the schema has not been created yet, so a DB-stored config cannot exist
      // anyway. Behave like a missing row so file mode still works (on a fresh
      // install file mode must never touch the DB). Any other error (unreachable
      // DB, auth failure, ...) must propagate : in database mode we must NOT
      // silently fall back to a stale disk config when MySQL is merely down.
      if(err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_DB_ERROR')){
        logger.error("Settings schema is missing, falling back to file-based config")
        return { forms_yaml: null, config_source: null }
      }
      // A missing COLUMN (ER_BAD_FIELD_ERROR) is the un-migrated schema case :
      // restoring an older database dump does not re-run the schema patches, so
      // forms_yaml/config_source can be absent on an otherwise healthy database.
      // Behave like a missing row (no config in the database) instead of failing
      // every getBaseConfig/Form.load until a restart applies the patches.
      if(err && err.code === 'ER_BAD_FIELD_ERROR'){
        logger.error("Settings schema is outdated (missing config column), falling back to file-based config")
        return { forms_yaml: null, config_source: null }
      }
      throw err
    })

};
Settings.mailcheck = function(config,to,subject,body){
  subject = subject || "Test message"
  var message = body || "<p>This is a test message from AnsibleForms</p>"
  if(config.mail_password){
    try{
      config.mail_password=crypto.decrypt(config.mail_password)
    }catch(e){
      config.mail_password=""
      logger.error("Failed to decrypt mail password")
    }
  }
  logger.info("Sending testmail")
  return Settings.maildo(config,to,subject,message)
}
// Sent with the active mail channel (Connections > Notifications) ; none active, with the mail
// settings, which a config seed still writes
Settings.mailsend = async function(to,subject,message){
  const { default: NotificationChannel } = await import('./notificationChannel.model.js')
  const active = await NotificationChannel.findActive()
  const config = active ? await NotificationChannel.toMailConfig(active) : await Settings.findMailSettings()
  return Settings.maildo(config,to,subject,message)
}
Settings.maildo = function(config,to,subject,message){
  var mailConfig
  if(!config.mail_server)return false
  if(config.mail_username){
    mailConfig = {
      host: config.mail_server,
      port: config.mail_port,
      secure: !!config.mail_secure,
      auth: {
        user: config.mail_username,
        pass: config.mail_password
      },
      tls: {
          rejectUnauthorized: false
      }
    }
  }else{
    mailConfig = {
      host: config.mail_server,
      port: config.mail_port,
      secure: !!config.mail_secure,
      tls:{
          rejectUnauthorized: false
      }
    }
  }
  var mailmessage = {
    from: config.mail_from,
    to: to,
    subject: subject,
    html: message
  };
  // console.log(mailConfig)
  // console.log(message)
  let transporter = nodemailer.createTransport(mailConfig);
  return transporter.sendMail(mailmessage)
    .then((info)=>{
      if(info.messageId){
        return info.messageId
      }else{
        return "No messageId"
      }
  })
}
export default  Settings;
