
import Cmd from '../lib/cmd.js';
import dbConfig from '../../config/db.config.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import appConfig from '../../config/app.config.js';
import { MANAGED_ENV_PATH } from '../lib/envSettings.js';
import Helpers from '../lib/common.js';
import yaml from 'yaml';
import { create as createTar } from 'tar';
// the same parser load-env.js and envSettings.js read this file with, so the check below
// cannot disagree with what the application actually sees
import dotenv from 'dotenv';
import Errors from '../lib/errors.js';
import logger from '../lib/logger.js';
import { bump } from '../lib/epochs.js';
import mysql from './db.model.js';
import { releasedOperationsSql } from '../lib/repositoryClaims.js';

// The tables that describe the running processes, not the configuration : which nodes are up,
// what changed between them (lib/epochs.js), who holds the designer, which RTE holds which
// job slot (runner_leases). A restore must not bring back gone nodes, an old designer lock, old
// change counters or leases of jobs long gone - so they are not dumped, and a restore leaves
// the live ones as they are.
const RUNTIME_TABLES = ['nodes', 'cache_epochs', 'designer_lock', 'runner_leases']
  .map((t) => `--ignore-table=AnsibleForms.${t}`).join(' ')
  // tablespaces are the server's, not the schema's : dumping them needs the PROCESS right, which
  // a user limited to the AnsibleForms schema does not have (mysqldump and mariadb-dump)
  + ' --no-tablespaces';

/**
 * Wrap a value for a POSIX shell as a single-quoted string.
 *
 * Only the password was ever escaped here. dbHost and dbPort went in bare and dbUser sat
 * inside single quotes without its own quotes being escaped, so a legitimate value
 * carrying an apostrophe or a shell metacharacter produced a mangled - or injected -
 * command rather than a quoting error. These come from DB_HOST / DB_USER / DB_PORT, which
 * are editable through the managed env file.
 *
 * The `'"'"'` idiom is how you get a literal apostrophe into a single-quoted shell word:
 * close the quote, emit an escaped one, reopen.
 */
function shQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

/**
 * The operator's MYSQL_* variables, for the dump and restore commands.
 *
 * A command runs with the environment a playbook gets (lib/playbookEnv.js), which drops every
 * MYSQL_* variable : right for a playbook, wrong for mysqldump and mysql, which read
 * MYSQL_HOME, MYSQL_TEST_LOGIN_FILE, MYSQL_UNIX_PORT ... for their option files, socket and
 * TLS settings. So they are handed back here, through cmd.env. MYSQL_PWD stays out : the
 * password reaches the command as $AF_DB_PASSWORD (DB_PASSWORD), never a second one that may
 * disagree with it.
 *
 * Args:
 *   env (object): the server's environment.
 *
 * Returns:
 *   object: the MYSQL_* variables, MYSQL_PWD excepted.
 */
export function mysqlClientEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (!name.startsWith('MYSQL_') || name === 'MYSQL_PWD') continue;
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

/**
 * What a restore brought back from the time of the backup that nothing follows any more : the
 * jobs that were running then (their loops, their trackers and their RTE are not this
 * instance's now), and the repository and schedule claims taken then. Left as they are, the
 * jobs would show 'running' until a sweep gave up on them, a repository would refuse every pull
 * and save, and the schedule queue would wait for a launch that never ends.
 *
 * Returns:
 *   Promise<object>: { jobs, repositories, schedules } : how many rows were released.
 */
async function releaseRestoredRuntime() {
  const released = { jobs: 0, repositories: 0, schedules: 0 };
  // step 1 : the jobs under way in the dump - running, or a workflow waiting on an approval
  // node - end as abandoned, their abort answered, no process and no RTE on them
  const jobs = await mysql.do(
    "UPDATE AnsibleForms.`jobs` SET status='abandoned', abort_requested=0, host=NULL, pid=NULL " +
    "WHERE status='running' OR (status='approve' AND job_type='workflow')");
  released.jobs = jobs?.changedRows || 0;
  // step 2 : the repository claims (a pull, a push or a save of then) : failed, as a stale claim
  // is, with the pull or the push it was running (no badge left on running)
  const repos = await mysql.do(
    "UPDATE AnsibleForms.`repositories` SET status='failed', " + releasedOperationsSql() + "claim_node=NULL WHERE status='running'");
  released.repositories = repos?.changedRows || 0;
  // step 3 : a schedule launching then : idle again, so the queue goes on
  const schedules = await mysql.do(
    "UPDATE AnsibleForms.`schedule` SET state='idle', claim_node=NULL WHERE state='running'");
  released.schedules = schedules?.changedRows || 0;
  return released;
}

// --- Helpers for backup details ---
async function getFileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function getDirStats(dirPath) {
  let totalSize = 0;
  let fileCount = 0;
  try {
    const files = await fs.readdir(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        fileCount++;
        totalSize += stat.size;
      }
    }
  } catch (e) {
    // a backup taken before forms/ was included has no such folder : a valid restore point,
    // which describeBackup reports as formsDirExists false. Warned about, it filled the log
    // on every list of the backups (#1192)
    if (e.code !== 'ENOENT') logger.warning(`getDirSize: failed to read ${dirPath}: ${e.message || e}`);
  }
  return { fileCount, totalSize };
}

// Describe one backup folder. Shared by listBackups and getBackupByFolder so the
// list and the detail panel can never disagree about the same backup.
//
// `valid` is the one field that matters : the sql dump is what a restore actually
// replays, so a missing or EMPTY dump means the folder is not a restore point at
// all, however healthy it looks in the list. Empty is the common case - the dump
// is written through a shell redirect, which creates the file before the command
// runs, so a missing mysqldump binary leaves a 0-byte .sql behind.
async function describeBackup(folder) {
  const backupFolder = path.join(appConfig.backupPath, folder);
  const backupFile = path.join(backupFolder, 'ansibleforms.sql');
  const configYaml = path.join(backupFolder, path.basename(appConfig.configPath));
  const formsDir = path.join(backupFolder, 'forms');
  const envFile = path.join(backupFolder, ENV_BACKUP_NAME);
  let description = '';
  try {
    const metaRaw = await fs.readFile(path.join(backupFolder, 'meta.yaml'), 'utf8');
    const meta = yaml.parse(metaRaw);
    description = meta?.description || '';
  } catch {}
  const backupFileExists = await fs.stat(backupFile).then(() => true).catch(() => false);
  const backupFileSize = await getFileSize(backupFile);
  const formsDirStats = await getDirStats(formsDir);
  return {
    folder,
    date: Helpers.dateFromBackupFolder(folder),
    description,
    valid: backupFileExists && backupFileSize > 0,
    // the names of what it holds, shown with their sizes (the backup's page, the restore dialog)
    backupFileName: path.basename(backupFile),
    configYamlName: path.basename(configYaml),
    envFileName: path.basename(envFile),
    formsDirName: path.basename(formsDir),
    backupFileExists,
    configYamlExists: await fs.stat(configYaml).then(() => true).catch(() => false),
    formsDirExists: await fs.stat(formsDir).then(() => true).catch(() => false),
    // Reported so an operator can SEE that this folder carries environment settings - it is
    // 0600 and credential-bearing (VAULT_TOKEN, a mail password), and it is restored only on
    // request, so the list must not stay silent about it.
    envFileExists: await fs.stat(envFile).then(() => true).catch(() => false),
    envFileSize: await getFileSize(envFile),
    configYamlSize: await getFileSize(configYaml),
    backupFileSize,
    formsDirFileCount: formsDirStats.fileCount,
    formsDirTotalSize: formsDirStats.totalSize
  };
}

// ===========================================================================
// DIRECTORY COPY / SWAP HELPERS
// ===========================================================================
/**
 * Recursively copies a directory (used by copyFormsAndFolder and the restore).
 *
 * Symbolic links are resolved with lstat/stat rather than trusted to the dirent :
 * - a link to a folder is followed and its CONTENT copied (fs.copyFile on a folder
 *   used to fail with EISDIR and abort the whole backup) ;
 * - a link to a file is copied as the file it points to ;
 * - a broken link is skipped with a warning (it used to fail with ENOENT and abort
 *   the whole backup, which was then deleted) ;
 * - every folder is copied at most once, by its REAL path, so a link pointing back
 *   up the tree cannot recurse forever ;
 * - anything that is neither a file nor a folder (a socket, a fifo) is skipped.
 *
 * Args:
 *   src (string): The folder to copy. When it does not exist or is not a folder,
 *     nothing is done.
 *   dest (string): The destination folder, created when missing.
 *   visited (Set<string>): Internal ; the real paths already copied (loop guard).
 *
 * Returns:
 *   Promise<void>
 *
 * Raises:
 *   Error: On a real copy failure (a full disk, a permission error on a file).
 */
async function copyDir(src, dest, visited = new Set()) {
  // step 1 : if source doesn't exist or isn't a directory, do nothing
  try {
    const stat = await fs.stat(src);
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }
  // step 2 : loop guard on the real path
  const real = await fs.realpath(src);
  if (visited.has(real)) {
    logger.warning(`Not copying '${src}' again: it was already copied (a symbolic link loop)`);
    return;
  }
  visited.add(real);
  logger.debug(`Copying dir ${src} -> ${dest}`)
  await fs.mkdir(dest, { recursive: true });
  // step 3 : copy every entry, resolving symbolic links
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = await fs.stat(srcPath); // follows the link
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (e) {
        logger.warning(`Skipping '${srcPath}': it is a symbolic link that does not resolve (${e.code || e.message})`);
        continue;
      }
    }
    if (isDir) {
      await copyDir(srcPath, destPath, visited);
    } else if (isFile) {
      logger.debug(`Copying file ${srcPath} -> ${destPath}`)
      await fs.copyFile(srcPath, destPath);
    } else {
      logger.warning(`Skipping '${srcPath}': it is neither a file nor a folder`);
    }
  }
}

// the file in a backup folder that lists the symbolic links of the forms folder (recordLinks) :
// the backup holds their content (copyDir follows them), the restore makes them links again
const LINKS_MANIFEST = 'forms-links.json';

/**
 * The symbolic links in a folder, as they are written (readlink : a relative target stays
 * relative), with their path relative to the folder. A linked folder is not walked into : the
 * link is what a restore puts back, and what it points to comes with it.
 *
 * Args:
 *   root (string): The folder to walk (the forms folder).
 *
 * Returns:
 *   Promise<object[]>: [{ path, target }], parents before what they hold ; empty when the folder
 *     is missing.
 */
async function recordLinks(root) {
  const links = [];
  // step 1 : walk without following links
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ path: entryRel, target: await fs.readlink(full) });
      } else if (entry.isDirectory()) {
        await walk(full, entryRel);
      }
    }
  }
  // step 2 : a forms folder that is itself a link is resolved (replaceDir keeps that link)
  try {
    await walk(await fs.realpath(root), '');
  } catch {
    // no forms folder : no links
  }
  return links;
}

/**
 * Makes the recorded symbolic links links again in a restored copy of the forms folder, in place
 * of the plain copies copyDir made of them. A link whose target no longer resolves (from where
 * the link will be, in the final folder) keeps the copy the backup holds, with a warning : the
 * content would otherwise be lost. A link that was broken at backup time has no copy : it is put
 * back as it was.
 *
 * Args:
 *   staging (string): The restored copy, where the links are made.
 *   finalDir (string): Where that copy ends up : relative targets are resolved from there.
 *   links (object[]): [{ path, target }], as recordLinks returned them.
 *
 * Returns:
 *   Promise<void>
 */
async function applyLinks(staging, finalDir, links) {
  const made = [];
  for (const link of links || []) {
    // step 1 : only a path inside the folder, and not inside a link already made
    const rel = path.normalize(String(link?.path || ''));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || typeof link.target !== 'string') continue;
    if (made.some((m) => rel.startsWith(m + path.sep))) continue;
    const at = path.join(staging, rel);
    // step 2 : the copy is kept when the target is gone
    const resolved = path.resolve(path.dirname(path.join(finalDir, rel)), link.target);
    let copied = true;
    try {
      await fs.lstat(at);
    } catch {
      copied = false;
    }
    let reachable = true;
    try {
      await fs.stat(resolved);
    } catch {
      reachable = false;
    }
    if (!reachable && copied) {
      logger.warning(`Restored '${rel}' as a copy: it was a symbolic link to '${link.target}', which no longer exists`);
      continue;
    }
    // step 3 : the copy goes, the link takes its place
    await fs.rm(at, { recursive: true, force: true });
    await fs.mkdir(path.dirname(at), { recursive: true });
    await fs.symlink(link.target, at);
    made.push(rel);
  }
}

/**
 * Gives a new folder the mode and the owner of the one it replaces : a restored forms folder
 * was created with this process's defaults, and an operator's group-writable folder (or one
 * owned by another user) changed under them. The owner is best effort : only root may give a
 * folder away.
 *
 * Args:
 *   from (string): The folder being replaced.
 *   to (string): The folder taking its place.
 *
 * Returns:
 *   Promise<void>
 */
async function copyFolderMode(from, to) {
  const st = await fs.stat(from);
  await fs.chmod(to, st.mode & 0o7777);
  await fs.chown(to, st.uid, st.gid).catch((e) => {
    if (e.code !== 'EPERM') logger.warning(`Could not give '${to}' the owner of '${from}': ${e.message}`);
  });
}

// rename failures that mean "this folder cannot be swapped as a whole" : a mount
// point (EBUSY, a docker volume), another filesystem (EXDEV), or a parent folder we
// may not write in (EACCES / EPERM)
const SWAP_UNSUPPORTED = new Set(['EBUSY', 'EXDEV', 'EACCES', 'EPERM']);

/**
 * Empties a folder without removing the folder itself.
 *
 * Args:
 *   dir (string): The folder to empty.
 *
 * Returns:
 *   Promise<void>
 */
async function emptyDir(dir) {
  for (const entry of await fs.readdir(dir)) {
    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Replaces the CONTENT of a folder with the content of another one, keeping the
 * folder itself. The fallback of replaceDir for a folder that cannot be renamed
 * (a mount point). A verbatim copy of the current content is kept aside first, and
 * put back when anything fails midway, so the folder is never left half restored.
 *
 * Args:
 *   staging (string): The folder holding the new content.
 *   target (string): The folder whose content is replaced.
 *
 * Returns:
 *   Promise<void>
 *
 * Raises:
 *   Error: The original failure, after the previous content was put back.
 */
async function replaceContents(staging, target) {
  // step 1 : an exact copy of the current content (links kept as links)
  const aside = await fs.mkdtemp(path.join(os.tmpdir(), 'af-forms-old-'));
  try {
    await fs.cp(target, aside, { recursive: true, verbatimSymlinks: true });
    // step 2 : swap the content
    try {
      await emptyDir(target);
      // verbatim : the staged copy holds the restored links as links (applyLinks), and
      // copyDir would turn them into copies again
      await fs.cp(staging, target, { recursive: true, verbatimSymlinks: true });
    } catch (e) {
      // step 3 : roll back to the previous content
      logger.error(`Restoring '${target}' failed midway, putting the previous content back: ${e.message}`);
      await emptyDir(target);
      await fs.cp(aside, target, { recursive: true, verbatimSymlinks: true });
      throw e;
    }
  } finally {
    await fs.rm(aside, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Replaces a folder by a copy of another one, so that NOTHING of the previous
 * content survives (a restore used to merge the backup into the existing folder :
 * forms created after the backup stayed, and a form deleted since came back next to
 * them).
 *
 * The backup is first copied into a staging folder beside the target ; only when
 * that copy is complete is the current folder renamed aside, the staging folder
 * renamed into its place and the old one removed. A failure while staging leaves
 * the current folder untouched, a failure during the swap renames the old folder
 * back. When the target cannot be renamed (a mount point, as with a docker volume),
 * its content is swapped instead, with the same roll back (replaceContents).
 *
 * A target that is a symbolic link is resolved first, so the link itself is kept
 * and the folder it points to is the one replaced.
 *
 * Args:
 *   src (string): The folder to restore from. When it is missing, nothing is done.
 *   targetDir (string): The folder to replace.
 *   options (object): { links } - the symbolic links the folder had at backup time
 *     (recordLinks), made links again in the restored copy (applyLinks).
 *
 * Returns:
 *   Promise<boolean>: true when the folder was replaced, false when src is missing.
 *
 * Raises:
 *   Error: When the copy or the swap fails ; the previous folder is then in place.
 */
async function replaceDir(src, targetDir, { links = [] } = {}) {
  // step 1 : nothing to restore from
  try {
    if (!(await fs.stat(src)).isDirectory()) return false;
  } catch {
    return false;
  }
  // step 2 : resolve a symlinked target, so the link survives
  let target = targetDir;
  let existed = true;
  try {
    target = await fs.realpath(targetDir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    existed = false;
  }
  const parent = path.dirname(target);
  const stamp = `${Date.now()}-${process.pid}`;
  const base = path.basename(target);
  // step 3 : stage a complete copy beside the target (same filesystem, so the
  // renames below are atomic) ; fall back to a temp folder when the parent cannot
  // be written, and then swap the content
  let staging = path.join(parent, `.${base}.restore-${stamp}`);
  let besideTarget = true;
  try {
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(staging);
  } catch (e) {
    if (!SWAP_UNSUPPORTED.has(e.code)) throw e;
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'af-forms-restore-'));
    besideTarget = false;
  }
  try {
    await copyDir(src, staging);
    // the links of then : links again, not the copies copyDir made of them
    await applyLinks(staging, target, links);
    if (!existed) {
      // step 4a : no current folder, just move the staged one in
      await fs.rename(staging, target);
      return true;
    }
    if (!besideTarget) {
      // step 4b : the staging is elsewhere, swap the content
      await replaceContents(staging, target);
      return true;
    }
    // step 4c : the staged folder takes the current one's mode and owner (it was made with this
    // process's defaults), then the current folder is renamed aside
    await copyFolderMode(target, staging).catch((e) => {
      logger.warning(`Could not give the restored '${target}' the mode of the previous one: ${e.message}`);
    });
    const aside = path.join(parent, `.${base}.old-${stamp}`);
    try {
      await fs.rename(target, aside);
    } catch (e) {
      if (!SWAP_UNSUPPORTED.has(e.code)) throw e;
      // a mount point cannot be renamed : swap its content instead
      await replaceContents(staging, target);
      return true;
    }
    // step 5 : move the staged copy in ; on failure, put the old folder back
    try {
      await fs.rename(staging, target);
    } catch (e) {
      logger.error(`Restoring '${target}' failed midway, putting the previous folder back: ${e.message}`);
      await fs.rename(aside, target);
      throw e;
    }
    // step 6 : the old folder is no longer needed
    await fs.rm(aside, { recursive: true, force: true }).catch((e) => {
      logger.warning(`Could not remove the previous folder '${aside}': ${e.message}`);
    });
    return true;
  } finally {
    // a staging folder that was not moved into place
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// copy file only if exists
async function copyFileIfExists(src,dest,mode){
    var exists=true
    try {
      await fs.access(src);
    } catch {
      exists=false
      logger.warning(`File ${src} not found`)
    }   
    if(exists){   
      logger.debug(`Copying file ${src} -> ${dest}`)
      await fs.copyFile(src, dest);
      // a file that can hold credentials must not widen when it is copied
      if (mode !== undefined) { await fs.chmod(dest, mode); }
    }
}

// Secrets that must never leave the host inside a backup. Both are unrecoverable-by-design
// rather than merely sensitive: ENCRYPTION_SECRET decrypts every stored credential (so it
// would defeat the dump's encryption if shipped with it) and ACCESS_TOKEN_SECRET signs
// sessions. Neither is readable through the API at all - see REFUSED in lib/envSettings.js.
const ENV_BACKUP_EXCLUDE = ['ENCRYPTION_SECRET', 'ENCRYPTION_SECRET_PREVIOUS', 'ACCESS_TOKEN_SECRET'];

/**
 * The name a line assigns, read with DOTENV'S OWN grammar.
 *
 * It matters that this agrees with the reader exactly. The previous pattern was
 * `^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=`, which does not recognise the optional `export `
 * prefix that dotenv accepts - so `export ENCRYPTION_SECRET='...'` was read by the
 * application as a real value and NOT recognised here, and the key that decrypts every
 * stored credential was written verbatim into every backup, in the same folder as the
 * ciphertext it opens. `export` is not exotic in this file either: it is what you write
 * when the file is also meant to be `source`d, which this project's own documentation
 * does.
 *
 * This is the same lesson envSettings.parseEnvFile already records - a second, hand
 * written parser that disagrees with dotenv creates a whole class of bug - so the name
 * charset follows dotenv's `[\w.-]+` too, not just letters and underscores.
 */
function envAssignmentName(line) {
  return /^\s*(?:export\s+)?([\w.-]+)\s*=/.exec(line)?.[1] || null;
}

// Whether a value leaves a quote open at the end of its line, so the assignment continues
// on the next one. dotenv allows a real newline inside a quoted value, and dropping only
// the FIRST line of such a secret would leave the rest of it behind as loose text.
function opensUnterminatedQuote(afterEquals) {
  const value = afterEquals.replace(/^\s*/, '');
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  // closed on this same line ?
  return value.slice(1).includes(quote) ? null : quote;
}

/**
 * Copies the managed env file into a backup with the master secrets removed, leaving a
 * comment in their place so a restore is not a silent surprise. Line based on purpose: it
 * must not reformat or re-quote anything it does not understand.
 *
 * Two lines of defence, because what leaks here is unrecoverable: the line filter above,
 * and then a re-parse of the RESULT with dotenv. If an excluded name survives that, the
 * environment file is left out of the backup entirely rather than shipped with a secret
 * in it - a backup missing one optional file is a nuisance, a backup carrying
 * ENCRYPTION_SECRET beside the dump is the thing this function exists to prevent.
 */
async function copyEnvWithoutMasterSecrets(src, dest) {
  let text;
  try {
    text = await fs.readFile(src, 'utf8');
  } catch {
    logger.warning(`File ${src} not found`);
    return;
  }
  const kept = [];
  const removed = [];
  let dropUntilQuote = null;     // inside a multi-line value we are dropping
  for (const line of text.split(/\r?\n/)) {
    if (dropUntilQuote) {
      // still inside the removed value : drop this line too, and stop when it closes
      if (line.includes(dropUntilQuote)) dropUntilQuote = null;
      continue;
    }
    const name = envAssignmentName(line);
    if (name && ENV_BACKUP_EXCLUDE.includes(name)) {
      removed.push(name);
      dropUntilQuote = opensUnterminatedQuote(line.slice(line.indexOf('=') + 1));
      continue;
    }
    kept.push(line);
  }
  const header = removed.length
    ? `# ${removed.join(' and ')} removed from this backup on purpose - set them on the target host.\n`
    : '';
  const body = header + kept.join('\n');

  // Verified against the real reader, not against the filter's own idea of the grammar.
  const survivors = ENV_BACKUP_EXCLUDE.filter((name) => dotenv.parse(body)[name] !== undefined);
  if (survivors.length) {
    logger.error(`Refusing to put the environment file in the backup: ${survivors.join(', ')} survived the filter. Rewrite that entry in ${src} as a plain NAME=value line.`);
    return;
  }

  await fs.writeFile(dest, body, { mode: 0o600 });
  // writeFile does not chmod a file that already exists
  await fs.chmod(dest, 0o600);
  if (removed.length) logger.info(`Backed up the environment file without ${removed.join(', ')}`);
}

const ENV_BACKUP_NAME = 'managed.env';

class BackupModel {
  static getBackupPaths() {
    const backupRoot = appConfig.backupPath;
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const backupFolder = path.join(backupRoot, timestamp);
    const backupFile = path.join(backupFolder, 'ansibleforms.sql');
    return { backupRoot, backupFolder, backupFile, timestamp };
  }

  static async backupFormsAndFolder(backupFolder) {
    logger.info(`Copying config/yaml files and forms folder to ${backupFolder}`)
    
    // Backup config.yaml (new structure)
    const configFile = appConfig.configPath;
    const destConfigFile = path.join(backupFolder, path.basename(configFile));
    await copyFileIfExists(configFile, destConfigFile);
    
    // Backup the managed environment file. Everything the settings page writes lives here,
    // and without this a restore onto a fresh host silently loses all of it.
    //
    // The two MASTER secrets are stripped out. The dump beside this file holds every stored
    // credential as AES ciphertext, so writing ENCRYPTION_SECRET next to it would put the
    // lock and the key in the same folder - and a backup travels (rsync, a support bundle, a
    // playbook that reads persistent/). ENCRYPTION_SECRET is REFUSED in the settings page and
    // redacted by GET /api/v2/config/env precisely so no admin can read it through the API;
    // it must not be readable from a backup either. ACCESS_TOKEN_SECRET goes for the same
    // reason - it forges sessions.
    //
    // Everything else stays, so a rebuild still gets DB_*, VAULT_*, the paths and the log
    // settings. What is left can still hold credentials, so the copy is 0600 rather than
    // inheriting the folder's mode.
    //
    // Deliberately NOT restored automatically : see restoreFormsAndFolder.
    await copyEnvWithoutMasterSecrets(MANAGED_ENV_PATH, path.join(backupFolder, ENV_BACKUP_NAME));

    // Backup forms directory
    const formsDir = appConfig.formsFolderPath;
    const destDir = path.join(backupFolder, 'forms');
    await copyDir(formsDir, destDir);
    // and its symbolic links : the copy above holds what they point to, this says they were
    // links, so a restore makes them links again rather than plain copies (applyLinks)
    const links = await recordLinks(formsDir);
    if (links.length) {
      await fs.writeFile(path.join(backupFolder, LINKS_MANIFEST), JSON.stringify({ links }, null, 2), 'utf8');
    }
  }


  // The environment file is captured by a backup but NOT restored with it. DB_HOST, the
  // paths and the TLS locations in it describe the machine the backup was taken on, so
  // restoring it onto a different host would point that instance at the wrong database.
  // Callers that genuinely want it back ask for it explicitly.
  /**
   * @param {string} folder A backup folder NAME (YYYYMMDDHHmmss), like every sibling method
   *   here takes. It used to take a full path, which was both inconsistent - the natural
   *   wiring `restoreManagedEnv(req.params.folder)` would silently look in the wrong place -
   *   and a traversal primitive, since `path.join` on an unvalidated caller string could
   *   write an arbitrary file over the live persistent/.env.
   */
  static async restoreManagedEnv(folder) {
    if (!folder || !/^\d{14}$/.test(folder)) throw new Errors.BadRequestError('Invalid or missing backup folder');
    const src = path.join(appConfig.backupPath, folder, ENV_BACKUP_NAME);
    try {
      await fs.access(src);
    } catch {
      return { restored: false, reason: 'the backup contains no environment file' };
    }
    // Keep the current file first. writeManaged does the same, for the same reason: a bad
    // DB_HOST in here stops the app from starting, and the previous file is the only way
    // back - which matters most for exactly this operation, the one likeliest to install a
    // DB_HOST belonging to another machine.
    try {
      const previous = await fs.readFile(MANAGED_ENV_PATH, 'utf8');
      await fs.writeFile(`${MANAGED_ENV_PATH}.bak`, previous, { mode: 0o600 });
      await fs.chmod(`${MANAGED_ENV_PATH}.bak`, 0o600);
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warning(`Could not back up ${MANAGED_ENV_PATH}: ${e.message}`);
    }
    await copyFileIfExists(src, MANAGED_ENV_PATH, 0o600);
    logger.warning(`Restored the environment file from backup ${folder} - a restart is needed for it to take effect. ENCRYPTION_SECRET and ACCESS_TOKEN_SECRET are never in a backup and must already be set on this host.`);
    return { restored: true, restartRequired: true, folder };
  }

  static async restoreFormsAndFolder(restoreFolder) {
    logger.info(`Restoring config/yaml files and forms folder from ${restoreFolder}`)
    
    // Restore config.yaml (new structure)
    const configFile = appConfig.configPath;
    const configYamlBackup = path.join(restoreFolder, path.basename(configFile));
    await copyFileIfExists(configYamlBackup, configFile);
    
    // Restore forms directory : REPLACED by the backup's copy (not merged into it),
    // so forms created after the backup do not survive the restore ; see replaceDir
    // for the staging / swap / roll back
    const formsDir = appConfig.formsFolderPath;
    const formsDirBackup = path.join(restoreFolder, 'forms');
    // the symbolic links it had (a backup from before this manifest has none listed : its links
    // come back as copies, as they always did)
    let links = [];
    try {
      links = JSON.parse(await fs.readFile(path.join(restoreFolder, LINKS_MANIFEST), 'utf8')).links || [];
    } catch (e) {
      if (e.code !== 'ENOENT') logger.warning(`Could not read the symbolic links of the backup's forms folder, they are restored as copies: ${e.message}`);
    }
    await replaceDir(formsDirBackup, formsDir, { links });
  }


  // The configured commands are shell strings and may be wrappers (for example
  // 'docker exec <container> mysqldump'), so the executable to look for is the
  // first token. Checking up front turns the single most common failure - the
  // client tools simply not being installed - into a message that says what to do.
  static async assertToolAvailable(commandString, envVar) {
    const binary = String(commandString || '').trim().split(/\s+/)[0];
    if (!binary) throw new Error(`No command configured, set ${envVar}`);
    if (!Cmd.isAvailable(binary)) {
      throw new Error(`'${binary}' was not found on this system. Install the mysql/mariadb client tools, or set ${envVar} to a command that works here.`);
    }
  }


  // A failed backup must not leave a folder behind. The dump is written through a
  // shell redirect, so the .sql is created BEFORE the command runs : when the dump
  // binary is missing the command fails, the throw skips the forms copy and the
  // meta.yaml write, and what stays on disk is a folder holding a 0-byte .sql and
  // nothing else. That folder still listed as a backup, so a run that failed was
  // indistinguishable from one that worked - you would only find out while trying
  // to restore in an emergency. Everything is unwound now, and the caller gets a
  // real error instead of a phantom restore point.
  static async doBackup(description) {
    logger.info(`Running backup '${description}'`)
    const dbName = 'AnsibleForms';
    const dbHost = dbConfig.host;
    const dbUser = dbConfig.user;
    const dbPassword = dbConfig.password;
    const dbPort = dbConfig.port;
    await this.assertToolAvailable(appConfig.mysqldumpCommand, 'MYSQLDUMP_COMMAND');
    const { backupFolder, backupFile, timestamp } = this.getBackupPaths();
    // The timestamp has one-second granularity, so two backups started in the same
    // second resolve to the same folder. That matters because the failure path below
    // removes the folder recursively : without this check a failing run could delete a
    // perfectly good backup somebody else had just written (a double-clicked button, or
    // a manual backup colliding with the 00:00:00 nightly). Refuse instead - the caller
    // can retry a second later.
    var alreadyThere = false;
    try {
      await fs.stat(backupFolder);
      alreadyThere = true;
    } catch {
      // ENOENT is the normal case
    }
    if (alreadyThere) {
      throw new Error(`A backup folder for ${timestamp} already exists, try again`);
    }
    await fs.mkdir(backupFolder, { recursive: true });
    try {
      // the password reaches the command through its environment : Cmd puts it in place of
      // "$AF_DB_PASSWORD" when it splits the command, so the command text (logged, shown, in an
      // error) never holds it, and a wrapper (docker exec ...) still gets it as an argument ;
      // the operator's MYSQL_* settings go with it (mysqlClientEnv), MYSQL_PWD excepted
      const dumpCmd = `${appConfig.mysqldumpCommand} -h ${shQuote(dbHost)} -u${shQuote(dbUser)} -p"$AF_DB_PASSWORD" -P ${shQuote(dbPort)} ${RUNTIME_TABLES} ${shQuote(dbName)}`;
      const cmdObj = {
        command: dumpCmd,
        directory: process.cwd(),
        description: `Database backup to ${backupFile}`,
        env: { ...mysqlClientEnv(), AF_DB_PASSWORD: dbPassword ?? '' },
        // the dump goes to the file (no shell : no > redirect)
        stdoutFile: backupFile
      };
      // explicit timeout : the default is 60s, which no real database can dump in
      await Cmd.executeSilentCommand(cmdObj, true, false, appConfig.backupCommandTimeoutSeconds);
      // a dump can exit 0 and still have written nothing worth restoring
      if (await getFileSize(backupFile) === 0) {
        throw new Error(`The database dump is empty, '${backupFile}' was not written`);
      }
      await this.backupFormsAndFolder(backupFolder);
      const meta = { description: description || '' };
      await fs.writeFile(path.join(backupFolder, 'meta.yaml'), yaml.stringify(meta), 'utf8');
      return { backupFolder, backupFile, timestamp, description: meta.description };
    } catch (err) {
      logger.error(`Backup failed, removing the incomplete folder '${backupFolder}': ${err.message || err}`);
      await fs.rm(backupFolder, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  static async restore(folder, backupFirst = false) {
    logger.info(`Running restore from '${folder}'`)
    const dbName = 'AnsibleForms';
    const dbHost = dbConfig.host;
    const dbUser = dbConfig.user;
    const dbPassword = dbConfig.password;
    const dbPort = dbConfig.port;
    if (!folder || !/^\d{14}$/.test(folder)) throw new Errors.BadRequestError('Invalid or missing backup folder');
    await this.assertToolAvailable(appConfig.mysqlCommand, 'MYSQL_COMMAND');
    // a failing pre-restore backup aborts the restore : it throws out of here, which
    // is the point - never overwrite the database without the safety net that was
    // explicitly asked for
    if (backupFirst) {
      await this.doBackup(`Auto backup before restore of ${folder}`);
    }
    const restoreFolder = path.join(appConfig.backupPath, folder);
    let stat;
    try {
      stat = await fs.stat(restoreFolder);
    } catch {
      throw new Errors.NotFoundError('Backup folder not found');
    }
    if (!stat.isDirectory()) throw new Errors.NotFoundError('Backup folder not found');
    const backupFile = path.join(restoreFolder, 'ansibleforms.sql');
    // Refuse a folder that is not actually a restore point. Replaying an empty dump
    // is a no-op that still reported 'Restore completed', so a broken backup looked
    // like a successful restore - the worst possible moment to be told a comforting
    // lie. See describeBackup for what makes a backup valid.
    const backupFileSize = await getFileSize(backupFile);
    if (backupFileSize === 0) {
      throw new Errors.BadRequestError(`Backup '${folder}' has no usable database dump (ansibleforms.sql is missing or empty), so there is nothing to restore. The backup that created it most likely failed.`);
    }
    // the password through the environment, as for the backup (doBackup)
    const restoreCmd = `${appConfig.mysqlCommand} -h ${shQuote(dbHost)} -u${shQuote(dbUser)} -p"$AF_DB_PASSWORD" -P ${shQuote(dbPort)} ${shQuote(dbName)}`;
    const cmdObj = {
      command: restoreCmd,
      directory: process.cwd(),
      description: `Database restore from ${backupFile}`,
      env: { ...mysqlClientEnv(), AF_DB_PASSWORD: dbPassword ?? '' },
      // the dump is read from the file (no shell : no < redirect)
      stdinFile: backupFile
    };
    // The one place a timeout is destructive rather than merely annoying: this replays a
    // dump that DROPs and CREATEs each table in turn, so being killed part way leaves some
    // tables restored, some dropped and not recreated, and some still holding the old
    // data. It ran on the 60 second default, which any real database exceeds.
    try {
      await Cmd.executeSilentCommand(cmdObj, true, false, appConfig.backupCommandTimeoutSeconds);
    } catch (err) {
      // say what state the database is in - there is no rollback, and "the command timed
      // out" on its own does not tell the operator their database is half replayed
      logger.error(`Restore from '${folder}' failed: ${err.message || err}`);
      throw new Error(
        `Restore from '${folder}' failed part way through: ${err.message || err}. ` +
        `The database may be partially restored - some tables replayed, others not. ` +
        `Re-run the restore once the cause is fixed, or raise BACKUP_COMMAND_TIMEOUT_SECONDS ` +
        `(currently ${appConfig.backupCommandTimeoutSeconds}s) if the dump is large.`,
        { cause: err }
      );
    }
    // the schema that came back can be an older release's (the backup taken before an upgrade) :
    // it is checked and patched again before success is reported, or this release ran on the old
    // schema, its cached "schema is up to date" of before saying all was well. First, right after
    // the dump : what runs meanwhile (the background tasks) queries the old tables until then.
    // Imported here : the schema model imports the bootstrap, which imports this model
    const { default: Schema } = await import('./schema.model.js');
    const schema = await Schema.upgradeAfterRestore();
    // what the dump brought back from then and nothing follows now : its running jobs, its
    // repository and schedule claims (releaseRestoredRuntime). A failure here leaves the
    // restore done : the sweeps release them later, so it is said, not thrown
    try {
      const released = await releaseRestoredRuntime();
      if (released.jobs || released.repositories || released.schedules) {
        logger.warning(`Restore from '${folder}': abandoned ${released.jobs} job(s) that were running at the time of the backup, released ${released.repositories} repository and ${released.schedules} schedule claim(s)`);
      }
    } catch (err) {
      logger.error(`Restore from '${folder}': could not release the jobs and claims of the backup's time: ${err.message || err}`);
    }
    await this.restoreFormsAndFolder(restoreFolder);
    // every process drops what it had cached of the replaced rows (lib/epochs.js)
    bump('restore');
    if (!schema.upgraded) {
      const why = schema.failed.slice(0, 3).join('; ');
      logger.error(`Restore from '${folder}': the restored database could not be upgraded to this release: ${why}`);
      return {
        message: `Restore completed, but the restored database could not be upgraded to this release: ${why}`,
        restoreFolder,
        schemaUpgraded: false,
        schemaFailed: schema.failed,
      };
    }
    return { message: 'Restore completed', restoreFolder, schemaUpgraded: true };
  }

  static async listBackups() {
    await fs.mkdir(appConfig.backupPath, { recursive: true });
    const folders = (await fs.readdir(appConfig.backupPath)).filter(f => /^\d{14}$/.test(f));
    folders.sort((a, b) => b.localeCompare(a));
    return await Promise.all(folders.map(folder => describeBackup(folder)));
  }

  static async deleteBackup(folder) {
  if (!folder || !/^\d{14}$/.test(folder)) throw new Errors.BadRequestError('Invalid or missing folder parameter');
    const backupFolder = path.join(appConfig.backupPath, folder);
    await fs.rm(backupFolder, { recursive: true, force: true });
    return { message: 'Backup deleted', folder };
  }

  /**
   * A backup folder's name as the backup path lists it : the name asked for is only compared,
   * never put into a path, so whatever a request sends can never point outside the backup path.
   *
   * Args:
   *   folder (string): the folder asked for (YYYYMMDDHHmmss).
   *
   * Returns:
   *   Promise<string>: the folder's name, read from the backup path.
   *
   * Raises:
   *   Errors.BadRequestError: not the 14 digits of a backup's timestamp.
   *   Errors.NotFoundError: no such backup folder.
   */
  static async backupFolderName(folder) {
    if (!folder || !/^\d{14}$/.test(folder)) throw new Errors.BadRequestError('Invalid or missing backup folder');
    let entries;
    try {
      entries = await fs.readdir(appConfig.backupPath, { withFileTypes: true });
    } catch {
      throw new Errors.NotFoundError('Backup folder not found');
    }
    const found = entries.find((entry) => entry.isDirectory() && entry.name === folder);
    if (!found) throw new Errors.NotFoundError('Backup folder not found');
    return found.name;
  }

  static async getBackupByFolder(folder) {
    return await describeBackup(await this.backupFolderName(folder));
  }

  /**
   * A backup folder as a gzipped tar archive, streamed : read from disk as it is sent, never
   * held in memory as a whole (a dump can be gigabytes).
   *
   * The archive holds the folder itself (<folder>/...), so extracting it gives back the same
   * folder, ready to be dropped into the backup path of another host. Only its regular files
   * and folders go in : a symbolic link (which a backup does not make : copyDir copies what a
   * link points to) or anything else is left out, so nothing beyond the folder's own files can
   * ever end up in the archive.
   *
   * What a backup folder holds : the database dump (ansibleforms.sql, its stored credentials
   * encrypted), config.yaml, the forms folder, meta.yaml (its description), the forms' symbolic
   * links manifest when there were any, and managed.env WITHOUT the master secrets
   * (copyEnvWithoutMasterSecrets), which can still hold other credentials (VAULT_TOKEN, a mail
   * password) : the same 0600 file the folder holds, which is why the route is a backup operator's.
   *
   * Args:
   *   folder (string): The backup folder name.
   *
   * Returns:
   *   Promise<object>: { stream (a readable stream of the .tar.gz), fileName (its download name) }.
   *
   * Raises:
   *   BadRequestError: When the name is missing or not a backup folder name.
   *   NotFoundError: When there is no such folder.
   */
  static async archiveBackup(folder) {
    // the folder's name as the backup path lists it, never the name the request sent
    const name = await this.backupFolderName(folder);
    // step 1 : from the backup path, so every entry starts with the folder's name
    const stream = createTar(
      {
        gzip: true,
        cwd: appConfig.backupPath,
        // no uid/gid/user names of this host in the archive
        portable: true,
        // lstat : a link is seen as a link, never followed
        follow: false,
        filter: (_entry, stat) => stat.isFile() || stat.isDirectory(),
      },
      [name]
    );
    // step 2 : the name it is downloaded as
    return { stream, fileName: `ansibleforms-backup-${name}.tar.gz` };
  }
}

export default BackupModel;
// the directory helpers, for the tests
export { copyDir, replaceDir, recordLinks };
