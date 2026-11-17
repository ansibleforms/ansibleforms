'use strict';
import path from 'path';
import { promises as fs, constants as fsConstants } from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import appConfig, { jobsListSize } from '../../config/app.config.js';
import { RTE_SETTINGS } from '../rte/socket/settings.js';
import mysql from '../models/db.model.js';
import logger, { logLevelOf, setLogLevel, setLogColor, setLogFormat, rebuildSyslogTransport, rebuildFileTransports } from './logger.js';
import { setDefaultLocale } from './i18n.js';
import { applySecureContext } from './httpsContext.js';
import { rebuildBodyParsers } from './bodyParsers.js';
import { applyTrustProxy, compileTrustProxy } from './trustProxy.js';
import { MIN_HEADER_SIZE, MAX_HEADER_SIZE } from './httpServerOptions.js';
import authConfig, { entraEnv } from '../../config/auth.config.js';
import logConfig, { parseRetentionDays, parseViewLines, validViewLines, knownLogLevel, LOG_LEVEL_DEFAULTS, LOG_LEVELS } from '../../config/log.config.js';
import ansibleConfig from '../../config/ansible.config.js';
import { SCHEDULE_SETTINGS, scheduleCronProblem } from './systemTasks.js';

// Editing environment variables from the settings page.
//
// The store is a FILE, not a database table, and that is the whole design. DB_HOST,
// DB_USER, DB_PASSWORD and ENCRYPTION_SECRET are needed to reach and decrypt the
// database, so anything kept in the database can never cover them. A file that
// load-env.js reads before the first import can.
//
// Precedence at boot is: real process environment > this file > built-in default.
// dotenv does not overwrite a variable that is already set, so an operator's compose
// or kubernetes value keeps winning - which is the right order, but it means the UI
// has to SAY when a field is overridden, or a save looks like it did nothing.
const __dirname_es = path.dirname(fileURLToPath(import.meta.url));

// Alongside the other persistent state, so it survives the container being replaced.
export const MANAGED_ENV_PATH = process.env.MANAGED_ENV_PATH
  || path.resolve(__dirname_es, '../../persistent/.env');

// Never editable from the UI. Each of these can destroy data or hand out access, and a
// settings page is the wrong place to do that - the reason is shown in the field.
export const REFUSED = {
  ENCRYPTION_SECRET: 'Set in the environment of every node : the stored secrets are re-encrypted with it on the next start',
  ENCRYPTION_SECRET_PREVIOUS: 'Set in the environment of the worker, for the one start that re-encrypts the stored secrets',
  ACCESS_TOKEN_SECRET: 'Changing this invalidates every session and signs out all users',
  ADMIN_PASSWORD: 'Change the admin password from the Users page instead',
  ADMIN_USERNAME: 'Change the admin account from the Users page instead',
  REINIT_ADMIN: 'This recreates the local admin account at startup - a password reset backdoor',
  ALLOW_SCHEMA_CREATION: 'This re-opens the endpoint that drops and recreates every table',
  NODE_ENV: 'This decides how the application boots and must come from the environment',
  // which process this is (app, worker, rte) : saved here, the next start would turn the app into
  // another process and this page with it
  AF_ROLE: 'This decides which process this is (app, worker, rte) and must come from the environment',
  // Both of these decide where configuration comes from. Editing them through the very
  // page they govern is a way to lock yourself out of it, and CONFIG_SEED_PATH would
  // change the source of truth without re-applying it.
  ALLOW_ENV_EDIT: 'This decides whether this page may write anything at all',
  CONFIG_SEED_PATH: 'This moves the source of truth for the admin objects - set it in the environment',
  'YTT_LIB_DATA_{dynamic}': 'A prefix, not a variable - set YTT_LIB_DATA_<name> in the environment instead',
};

// The variables Settings > System > General leaves to another page or to the deployment, and so
// does not show : the page's own list (env API ownedElsewhere), and the one a General repository
// keeps out of its general: map (lib/repoObjects/general.js).
// VAULT_* are only imported once, when upgrading to 7 (Secret stores). BASE_URL is here for a different reason -
// it is the one setting that genuinely cannot be applied without a restart, because the
// served index.html has the base path baked into it, so every page already open would break.
// Showing it on a page of editable settings would only offer an edit that cannot work; it is
// reported as a fact on the Status page instead.
// AF_ROLE and RTE_* describe which process this is and where its RTE lives : set in
// the environment of the container, not edited from inside the app - but RTE_QUEUE_MINUTES, how
// long the controller's job waits for a busy RTE, and RTE_FILES_MAX_MB, the largest folder it sends
// an RTE, which the controller reads (Jobs). ANSIBLE_PATH, PROCESS_MAX_BUFFER, CONTROLLER_URL,
// CONTROLLER_TLS_VERIFY (APP_URL, APP_TLS_VERIFY before 7.8) and LISTEN_HOST are read by an RTE
// only : since 7 the controller runs no playbook itself.
// the MCP server's switch and options (Settings > Connections > MCP) and the chat assistant's
// switch (Settings > Connections > Chat assistant) ; the default language (Settings > Appearance >
// Defaults) and the designer's switch (Settings > Appearance > Links).
// The local admin's first start (ADMIN_USERNAME, ADMIN_PASSWORD, REINIT_ADMIN) : the account is
// the Users page's once it exists. NODE_ENV and ALLOW_ENV_EDIT decide how the process boots and
// whether this page writes at all (it says so when it does not) : the deployment's.
// YTT_LIB_DATA_<name> is a prefix, not a variable : documented, nothing to show. LOG_COLOR_* are
// the console's ANSI colour codes : rarely changed, documented. LOG_SYSLOG_* are imported once as a
// syslog server (Settings > Connections > Syslog), as VAULT_* as a secret store.
// The nightly system tasks' crons (JOB_CLEANUP_CRON and the like, lib/systemTasks.js) are changed
// on each task's own page (Jobs > System > the task > Schedule), beside its next runs.
export const OWNED_ELSEWHERE =
  /^(VAULT|MCP|LOG_COLOR|LOG_SYSLOG)_|^RTE_(?!(QUEUE_MINUTES|FILES_MAX_MB)$)|^(ENABLE_(MCP|CHAT)|BASE_URL|AF_ROLE|CONTROLLER_URL|CONTROLLER_TLS_VERIFY|APP_URL|APP_TLS_VERIFY|ANSIBLE_PATH|PROCESS_MAX_BUFFER|LISTEN_HOST|DEFAULT_LANGUAGE|SHOW_DESIGNER|ADMIN_USERNAME|ADMIN_PASSWORD|REINIT_ADMIN|NODE_ENV|ALLOW_ENV_EDIT|YTT_LIB_DATA_\{dynamic\}|(TOKEN|AUDIT|JOB|STORED_JOB)_CLEANUP_CRON|NIGHTLY_BACKUP_CRON)$/;

// Names whose VALUE must never be sent to the client. A bare 'TOKEN' would be too broad -
// ACCESS_TOKEN_EXPIRATION and ACCESS_TOKEN_ISSUER are not secrets and are worth seeing -
// so this matches a trailing _TOKEN instead, which is what VAULT_TOKEN and any future
// <service>_TOKEN look like. HTTPS_KEY is deliberately NOT matched: it is a path to a key
// file, not the key itself, and the path is useful to see. PASSWORD and SECRET are trailing
// too, for the same reason : PASSWORD_MIN_LENGTH is a number, and it was hidden as a secret.
// A General repository writes these only as ${ENV} references.
export const SECRET_ENV_NAME = /_PASSWORD$|_SECRET$|_TOKEN$|_SECRET_PREVIOUS$/;

// The server's own variables : its database, its token and encryption secrets, its local admin, the
// token RTEs join with, its metrics token, and every variable it refuses to edit (REFUSED). A
// repository's object never reads one into a secret field (lib/repoObjects/secrets.js) : whoever
// may push to the repository would have it sent where their file says (a credential's host, a
// channel's url), the token secret making them an admin. The tokens an object is meant to carry
// stay readable : an RTE's (RTE_TOKEN, the credential of its runner), the Vault's (VAULT_TOKEN, a
// secret store's).
const SERVER_OWN_VARIABLE = /^(DB_|ACCESS_TOKEN_|ENCRYPTION_|ADMIN_|MYSQL)|^(METRICS_TOKEN|RTE_JOIN_TOKEN)$/;

/**
 * Whether a variable is one of the server's own (SERVER_OWN_VARIABLE, REFUSED) : never read into a
 * repository's object.
 *
 * Args:
 *   name (string): the variable.
 *
 * Returns:
 *   boolean: true when it is.
 */
export function isServerOwnVariable(name) {
  return SERVER_OWN_VARIABLE.test(String(name)) || Object.prototype.hasOwnProperty.call(REFUSED, String(name));
}

// Why the whole page is read only, when it is. Distinct from a per-variable refusal :
// nothing here is wrong with the variable, the store itself is not ours to write.
export const ENV_EDIT_DISABLED_REASON =
  'Environment variables are managed declaratively (ALLOW_ENV_EDIT=0) and cannot be changed here';

// Variables that take effect the moment they are saved, because every reader takes them
// from appConfig at call time rather than capturing them at import. Anything not listed
// here is saved but needs a restart - that is the safe default, not a limitation to work
// around: a value captured at import cannot be changed under the running process.
// A field belongs here only when its consumer reads appConfig at call time : writing a value
// captured at import changes nothing while the page reports "applied now".
const LIVE = {
  JOB_RETENTION_DAYS: { key: 'jobRetentionDays', parse: v => parseInt(v, 10) || 0 },
  // the stored jobs cleanup and the stored jobs routes read it on each run and each save
  STORED_JOB_UNUSED_DAYS: { key: 'storedJobUnusedDays', parse: v => parseInt(v, 10) || 0 },
  AUDIT_RETENTION_DAYS: { key: 'auditRetentionDays', parse: v => parseInt(v, 10) || 0 },
  NIGHTLY_BACKUP_RETENTION: { key: 'nightlyBackupRetention', parse: v => parseInt(v, 10) || 0 },
  // upload.controller builds its multer limits on each upload ; the same fallback as app.config
  UPLOAD_MAX_GB: { key: 'uploadMaxGb', parse: v => (Number.isNaN(parseInt(v, 10)) ? 10 : parseInt(v, 10)) },
  // form.model reads it each time it removes old restore points ; the same fallback as app.config
  OLD_BACKUP_DAYS: { key: 'oldBackupDays', parse: v => (Number.isNaN(parseInt(v, 10)) ? 60 : parseInt(v, 10)) },
  MYSQLDUMP_COMMAND: { key: 'mysqldumpCommand', parse: v => v },
  MYSQL_COMMAND: { key: 'mysqlCommand', parse: v => v },
  // the fn REST helpers and lib/jq.js read them on every call ; the same fallbacks as app.config
  REST_TIMEOUT_SECONDS: { key: 'restTimeoutSeconds', parse: v => (parseInt(v, 10) > 0 ? parseInt(v, 10) : 60) },
  JQ_TIMEOUT_SECONDS: { key: 'jqTimeoutSeconds', parse: v => (parseInt(v, 10) > 0 ? parseInt(v, 10) : 30) },
  // lib/jobFiles.js reads it on each job it packs files for ; the same fallback as app.config
  RTE_FILES_MAX_MB: { key: 'rteFilesMaxMb', parse: v => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 512) },
  REST_IGNORE_CERTS: { key: 'restIgnoreCerts', parse: v => ['1', 'true', 'yes'].includes(String(v || '').trim().toLowerCase()) },
  // backup.model passes it to every dump and restore it runs ; the same fallback as app.config
  BACKUP_COMMAND_TIMEOUT_SECONDS: { key: 'backupCommandTimeoutSeconds', parse: v => (parseInt(v, 10) > 0 ? parseInt(v, 10) : 3600) },
  GIT_CLONE_COMMAND: { key: 'gitCloneCommand', parse: v => v },
  GIT_PULL_COMMAND: { key: 'gitPullCommand', parse: v => v },
  GIT_PUSH_COMMAND: { key: 'gitPushCommand', parse: v => v },
  MASK_EXTRAVARS_REGEX: { key: 'maskExtravarsRegex', parse: v => v },
  EXTRAVARS_USER_FIELDS: { key: 'extravarsUserFields', parse: v => (v || '').trim() },
  REGEX_FILTER_JOB_OUTPUT: { key: 'filterJobOutputRegex', parse: v => v },
  JOBS_LIST_SIZE: { key: 'jobsListSize', parse: v => jobsListSize(v) },
  PROCESS_MAX_BUFFER: { key: 'processMaxBuffer', parse: v => parseInt(v, 10) || 50 * 1024 * 1024 },
  AWX_API_PREFIX: { key: 'awxApiPrefix', parse: v => v },
  SHOW_DESIGNER: { key: 'showDesigner', parse: v => v == 1 },
  // the login page reads it per request, through /api/v2/auth/settings
  // app.js mounts the MCP server always, behind a gate reading this per request
  ENABLE_MCP: { key: 'enableMcp', parse: v => v == 1 },
  // the chat route's gate, the chat button and the chat service read it per request
  ENABLE_CHAT: { key: 'enableChat', parse: v => v == 1 },
  // the MCP router reads both per request, when it builds the tools of a request
  MCP_READ_ONLY: { key: 'mcpReadOnly', parse: v => v == 1 },
  MCP_CHAT_FORMS_ONLY: { key: 'mcpChatFormsOnly', parse: v => v == 1 },
  USE_YTT: { key: 'useYtt', parse: v => v == 1 },
  // lib/loginThrottle.js reads them on every login
  LOGIN_MAX_FAILURES: { key: 'loginMaxFailures', parse: v => Math.max(0, parseInt(v, 10) || 0) },
  LOGIN_MAX_FAILURES_PER_IP: { key: 'loginMaxFailuresPerIp', parse: v => Math.max(0, parseInt(v, 10) || 0) },
  LOGIN_LOCKOUT_MINUTES: { key: 'loginLockoutMinutes', parse: v => Math.max(0, parseInt(v, 10) || 0) },
  AUTH_RATE_LIMIT: { key: 'authRateLimit', parse: v => Math.max(0, parseInt(v, 10) || 0) },
  PASSWORD_MIN_LENGTH: { key: 'passwordMinLength', parse: v => Math.max(0, parseInt(v, 10) || 0) },
  // Job.launch reads it on every launch
  LAUNCH_VALIDATION: { key: 'launchValidation', parse: v => (['off', 'log', 'enforce'].includes(String(v || '').trim().toLowerCase()) ? String(v).trim().toLowerCase() : 'enforce') },
  // db.model.js checks this inside mysql.do, so it is evaluated per query - exactly the
  // setting you want to flip on while debugging and off again without a restart
  ENABLE_DB_QUERY_LOGGING: { key: 'enableDbQueryLogging', parse: v => v == 1 },
  // Settings.resolveConfigInDatabase reads these per config load. The config_source column
  // outranks them anyway, so this is only the fallback.
  ENABLE_CONFIG_IN_DATABASE: { key: 'enableConfigInDatabase', parse: v => v == 1 },
  // form.model builds the ytt command from these on every render
  YTT_VARS_PREFIX: { key: 'yttVarsPrefix', parse: v => v },
  YTT_ALLOW_SYMLINK_DESTINATIONS: { key: 'yttAllowSymlinkDestinations', parse: v => v },
  YTT_DANGEROUS_ALLOW_ALL_SYMLINK_DESTINATIONS: { key: 'yttDangerousAllowAllSymlinkDestinations', parse: v => v == 1 },
  // Paths. Every one of these is dereferenced at call time - multer's destination callback,
  // the backup and repository functions, the lock read - so a restart was never what made a
  // new path take effect, and saying so was misleading. What actually matters is that files
  // already written stay where they are, which is what the RELOCATES note says. LOG_PATH is
  // excluded on purpose - it is baked into the rotating file transport's filename, so it has
  // its own LIVE_CUSTOM applier that rebuilds the transport instead.
  BACKUP_PATH: { key: 'backupPath', parse: v => v },
  CONFIG_PATH: { key: 'configPath', parse: v => v },
  FORMS_FOLDER_PATH: { key: 'formsFolderPath', parse: v => v },
  FORMS_STAGING_PATH: { key: 'formsStagingPath', parse: v => v },
  VARS_FILES_PATH: { key: 'varsFilesPath', parse: v => v },
  INVENTORY_PATH: { key: 'inventoryPath', parse: v => v },
  WORKFLOWS_PATH: { key: 'workflowsPath', parse: v => v },
  REPO_PATH: { key: 'repoPath', parse: v => v },
  // ssh.model computes the key paths from appConfig.homePath when used, not at import
  HOME_PATH: { key: 'homePath', parse: v => v },
  // multer's destination callback dereferences this per upload (the SIZE cap does not -
  // see the UPLOAD_MAX_GB note above)
  UPLOAD_PATH: { key: 'uploadPath', parse: v => v },
  // form.model reads it (and the forms and config paths) each time it backs up or restores
  FORMS_BACKUP_PATH: { key: 'formsBackupPath', parse: v => v },
  // app.js builds the security headers both ways and picks one per request from this
  CONTENT_SECURITY_POLICY: { key: 'contentSecurityPolicy', parse: v => String(v ?? 1).trim() !== '0' },
};

// Read straight from process.env at call time by their consumer rather than captured into
// appConfig, so setting the environment variable is enough - no appConfig key to update.
const LIVE_ENV_ONLY = new Set([
  // hostfilter.assertUrlAllowed reads them on every outbound REST call
  'REST_ALLOWED_HOSTS', 'REST_DENIED_HOSTS',
  // expression.model reads it through getExpressionMode() on every expression
  'EXPRESSION_SANITIZER',
  // lib/metrics.js reads it on every scrape of /api/v2/metrics
  'METRICS_TOKEN',
  // runners/awx/api.js reads it each time it follows a job (contactTolerance)
  'AWX_LOST_MINUTES',
  // runners/rte.js reads it each time a job waits for a busy RTE
  'RTE_QUEUE_MINUTES',
  // schema.model reads it when an upgrade patches the database, which happens at a start
  'UPGRADE_BACKUP',
]);

// Read by an RTE (AF_ROLE=rte) from its own environment : this page, on the controller, cannot
// reach it - neither now nor after a restart of the controller. Set where the RTE runs. The
// controller reads none of them (CONTROLLER_URL is the controller's address as an RTE dials it).
const RTE_ONLY = new Set([
  'APP_TLS_VERIFY', 'APP_URL', 'CONTROLLER_TLS_VERIFY', 'CONTROLLER_URL', 'LISTEN_HOST', 'RTE_CACHE_MB', 'RTE_CACHE_PATH', 'RTE_DRAIN_SECONDS', 'RTE_FILES',
  'RTE_JOIN_TOKEN', 'RTE_MAX_JOBS', 'RTE_MODE', 'RTE_NAME', 'RTE_REGISTER', 'RTE_SPOOL_PATH', 'RTE_TOKEN', 'RTE_URL',
]);

// Of those, the ones a socket-mode RTE also takes from its runner page (Connections > Runners >
// the runner > RTE, rte/socket/settings.js) : the page says so beside them
export const RUNNER_PAGE = new Set(RTE_SETTINGS.map((s) => s.env));

// the VAULT_* variables are imported once, as the secret store 'vault' (secrets/importVaultEnv.js)
// : imported when saved, as a start would, a moment later so that the fields saved together
// (its address, its token, its mount...) are all there first. Imported before, it only warns.
let vaultImport = null;
function importVaultSoon() {
  clearTimeout(vaultImport);
  vaultImport = setTimeout(() => {
    import('../secrets/importVaultEnv.js')
      .then(({ importVaultFromEnvOnce }) => importVaultFromEnvOnce())
      .catch((err) => logger.error(`Could not import the VAULT_* variables: ${err.message || err}`));
  }, 500);
  // a pending import never keeps the process alive
  vaultImport.unref?.();
}

// the LOG_SYSLOG_* variables are imported once, as the syslog server 'syslog' (lib/syslogServers.js)
// : imported when saved, as a start would, a moment later so that the fields saved together are
// all there first. Imported before, it only warns.
let syslogImport = null;
function importSyslogSoon() {
  clearTimeout(syslogImport);
  syslogImport = setTimeout(() => {
    import('./syslogServers.js')
      .then(({ importSyslogFromEnvOnce }) => importSyslogFromEnvOnce())
      .catch((err) => logger.error(`Could not import the LOG_SYSLOG_* variables: ${err.message || err}`));
  }, 500);
  // a pending import never keeps the process alive
  syslogImport.unref?.();
}

// the SSO login strategies are built once (auth/loginStrategies.js) : rebuilt when SSO is
// switched or the Entra ID authority changes, a moment later so that the fields saved together
// are all there first and one rebuild covers them
let loginRebuild = null;
function rebuildLoginSoon() {
  clearTimeout(loginRebuild);
  loginRebuild = setTimeout(() => {
    import('../auth/loginStrategies.js')
      .then(({ rebuildLoginStrategies }) => rebuildLoginStrategies())
      .catch((err) => logger.error(`Could not rebuild the SSO login: ${err.message || err}`));
  }, 500);
  // a pending rebuild never keeps the process alive
  loginRebuild.unref?.();
}

/**
 * Registers a nightly system task again on its new cron (cron.service rescheduleSystemTask), on
 * this node : the one whose scheduler runs the tasks does, any other has none to change. Imported
 * when used, so this module does not load the scheduler and every model behind it.
 *
 * Args:
 *   key (string): the task's key (jobCleanup).
 */
function rescheduleSystemTask(key) {
  import('../services/cron.service.js')
    .then(({ default: cronService }) => cronService.rescheduleSystemTask(key))
    .catch((err) => logger.error(`Could not reschedule the system task ${key}: ${err.message || err}`));
}

// The nightly system tasks' crons (lib/systemTasks.js SCHEDULE_SETTINGS) : appConfig takes the new
// one, which the API answers at once, then the task is registered again on it. Cleared, applyLive
// hands over the documented default, the task's own cron.
const LIVE_SCHEDULES = Object.fromEntries(
  SCHEDULE_SETTINGS.map((setting) => [
    setting.env,
    (v) => {
      appConfig[setting.config] = String(v ?? '').trim();
      rescheduleSystemTask(setting.key);
    },
  ]),
);

// Live, but needing more than an appConfig field or process.env : a function that
// reconfigures something already constructed.
const LIVE_CUSTOM = {
  ...LIVE_SCHEDULES,
  // jwt.sign() reads these off authConfig at call time (token.controller, login.controller),
  // so updating the object is enough - the next token issued uses the new value
  ACCESS_TOKEN_EXPIRATION: (v) => { authConfig.jwtExpiration = v; },
  ACCESS_TOKEN_REFRESH_EXPIRATION: (v) => { authConfig.jwtRefreshExpiration = v; },
  ACCESS_TOKEN_ISSUER: (v) => { authConfig.jwtIssuer = v; },
  // the new name wins over the old one (AZURE_*, deprecated) : both read again from process.env,
  // which applyLive has already updated, so clearing one falls back to the other
  ENTRA_GRAPH_URI: () => { authConfig.entraGraphUrl = entraEnv('ENTRA_GRAPH_URI'); },
  AZURE_GRAPH_URI: () => { authConfig.entraGraphUrl = entraEnv('ENTRA_GRAPH_URI'); },
  // the Entra ID strategy discovers its issuer from it when built : rebuilt
  ENTRA_AUTHORITY_URI: () => { authConfig.entraAuthorityUrl = entraEnv('ENTRA_AUTHORITY_URI'); rebuildLoginSoon(); },
  AZURE_AUTHORITY_URI: () => { authConfig.entraAuthorityUrl = entraEnv('ENTRA_AUTHORITY_URI'); rebuildLoginSoon(); },
  // winston keeps the level as a mutable property on the logger and each transport.
  // logConfig holds its own captured copy, which the Status page reports - update both, or
  // the level changes while the page keeps claiming the old one.
  // the value as a level (logLevelOf) : `warn` is `warning`, and one winston does not know
  // would have it log nothing at all, so the documented default is used instead
  LOG_LEVEL: (v) => { const level = logLevelOf('LOG_LEVEL', v); logger.level = level; setLogLevel('file', level); logConfig.level = level; },
  LOG_CONSOLE_LEVEL: (v) => { const level = logLevelOf('LOG_CONSOLE_LEVEL', v); setLogLevel('console', level); logConfig.consolelevel = level; },
  // the LOG_SYSLOG_* variables of before 7 : imported once as the syslog server `syslog`
  // (lib/syslogServers.js) - until then they still drive the transport they built
  LOG_SYSLOG_LEVEL: (v) => { const level = logLevelOf('LOG_SYSLOG_LEVEL', v); setLogLevel('syslog', level); logConfig.sysloglevel = level; importSyslogSoon(); },
  // the colour map is built at import but looked up per log line, so mutating it is enough
  LOG_COLOR_ERROR: (v) => setLogColor('error', v),
  LOG_COLOR_WARN: (v) => setLogColor('warn', v),
  LOG_COLOR_NOTICE: (v) => setLogColor('notice', v),
  LOG_COLOR_INFO: (v) => setLogColor('info', v),
  LOG_COLOR_DEBUG: (v) => setLogColor('debug', v),
  // getTimestamp() reads loggerConfig.tz inside the function, so every log line already
  // picks up a change - it only needed logConfig updating. (An earlier pass wrongly called
  // this captured in the formatter's closure ; it is not.)
  LOG_TZ: (v) => { logConfig.tz = v; },
  // the rotating filenames are built at construction, so both file transports are rebuilt.
  // Like the other paths, existing log files stay where they are (RELOCATES says so).
  LOG_PATH: (v) => { logConfig.path = v; return rebuildFileTransports(); },
  // the rotating files are told how long to keep their files when built : rebuilt, with the
  // new value (0 keeps them all)
  LOG_RETENTION_DAYS: (v) => { logConfig.retentionDays = parseRetentionDays(v); return rebuildFileTransports(); },
  // read by the log endpoint on every request : setting it is enough
  LOG_VIEW_LINES: (v) => { logConfig.viewLines = parseViewLines(v); },
  // node's setSecureContext replaces the TLS context for new connections, so a renewed
  // certificate needs no restart. Returns false in http mode - there is no context to swap -
  // and false if the files cannot be read, keeping the working certificate in place.
  HTTPS_KEY: () => applySecureContext(),
  HTTPS_CERT: () => applySecureContext(),
  // body-parser bakes the limit in at creation, so the pair is rebuilt behind the stable
  // middlewares app.js installed - no per-request cost, no restart
  API_BODY_LIMIT_MB: (v) => { appConfig.apiBodyLimitMb = parseInt(v, 10) || 50; return rebuildBodyParsers(); },
  // express compiles 'trust proxy' when it is set and reads the compiled function per
  // request, so setting it again on the running app is enough. Reads process.env, which
  // applyLive has already updated. Returns false for a value it refused.
  TRUST_PROXY: () => applyTrustProxy(),
  // the scheduler registered the seed reload with its interval at startup : it is registered
  // again with the new one (cron.service, scheduleConfigSeedReload). Imported when used, so this
  // module does not load the scheduler and every model behind it.
  CONFIG_SEED_RELOAD_SECONDS: (v) => {
    const seconds = parseInt(v, 10);
    appConfig.configSeedReloadSeconds = Number.isNaN(seconds) ? 60 : seconds;
    import('../services/cron.service.js')
      .then(({ default: cronService }) => cronService.scheduleConfigSeedReload(appConfig))
      .catch((err) => logger.error(`Could not reschedule the config seed reload: ${err.message || err}`));
  },
  // mysql2 fixes connectionLimit at creation, so a new size means a new pool. Safe because a
  // transaction holds its own connection - see MySql.resizePool.
  DB_POOL_SIZE: (v) => mysql.resizePool(v),
  // /api/v2/app/config reads process.env per request, but i18n captured its fallback at
  // import - update both or the visible default changes while server messages do not
  DEFAULT_LANGUAGE: (v) => { setDefaultLocale(v); },
  // seven settings feeding one transport : each rebuilds it, then they are imported as the
  // syslog server `syslog` (once : after that the transport is retired and they are ignored)
  LOG_SYSLOG_HOST: (v) => { logConfig.sysloghost = v; importSyslogSoon(); return rebuildSyslogTransport(); },
  LOG_SYSLOG_PORT: (v) => { logConfig.syslogport = v; return rebuildSyslogTransport(); },
  LOG_SYSLOG_PROTOCOL: (v) => { logConfig.syslogprotocol = v; return rebuildSyslogTransport(); },
  LOG_SYSLOG_PATH: (v) => { logConfig.syslogpath = v; return rebuildSyslogTransport(); },
  LOG_SYSLOG_SOURCE: (v) => { logConfig.sysloglocalhost = v; return rebuildSyslogTransport(); },
  LOG_SYSLOG_TYPE: (v) => { logConfig.syslogtype = v; return rebuildSyslogTransport(); },
  LOG_SYSLOG_APPNAME: (v) => { logConfig.syslogappname = v; return rebuildSyslogTransport(); },
  // login.controller bounds an api token's life with it on every login
  API_TOKEN_MAX_DAYS: (v) => { authConfig.apiTokenMaxDays = Math.max(1, parseInt(v, 10) || 90); },
  // the playbook folder : read when a playbook starts (rte/ansible-core.js)
  ANSIBLE_PATH: (v) => { ansibleConfig.path = v || path.resolve(__dirname_es, '../../persistent/playbooks'); },
  // every transport's format reads it per line : text or JSON
  LOG_FORMAT: (v) => setLogFormat(v),
  VAULT_ADDR: () => importVaultSoon(),
  VAULT_TOKEN: () => importVaultSoon(),
  VAULT_NAMESPACE: () => importVaultSoon(),
  VAULT_DEFAULT_MOUNT: () => importVaultSoon(),
  VAULT_KV_VERSION: () => importVaultSoon(),
  VAULT_SKIP_VERIFY: () => importVaultSoon(),
  VAULT_CACHE_TTL_MS: () => importVaultSoon(),
};

// Restart-tier variables that point at a location holding data. A restart applies the new
// value but does NOT move what is already there, which is the part worth warning about.
export const RELOCATES = new Set([
  'BACKUP_PATH', 'FORMS_BACKUP_PATH', 'CONFIG_PATH', 'FORMS_FOLDER_PATH',
  'FORMS_STAGING_PATH', 'REPO_PATH', 'UPLOAD_PATH', 'VARS_FILES_PATH', 'INVENTORY_PATH', 'WORKFLOWS_PATH', 'LOG_PATH',
]);

/**
 * How a saved variable takes effect : 'refused' (not editable here), 'live' (at once), 'rte'
 * (read by an RTE, set where it runs) or 'restart' (at the next start : the database's
 * address and login, the port, https, the base url and the process's role, which decide how
 * the process itself starts).
 *
 * Args:
 *   name (string): the variable.
 *
 * Returns:
 *   string: the tier.
 */
export function classify(name) {
  if (REFUSED[name]) return 'refused';
  if (RTE_ONLY.has(name)) return 'rte';
  return (LIVE[name] || LIVE_ENV_ONLY.has(name) || LIVE_CUSTOM[name]) ? 'live' : 'restart';
}

// A value already present in the real process environment cannot be changed by writing
// the file, because dotenv will not overwrite it. Saving one anyway would silently do
// nothing, so the caller refuses it and the UI greys the field.
export function isOverridden(name, managed) {
  return process.env[name] !== undefined && process.env[name] !== managed.get(name);
}

// KEY="value" per line. Values are ALWAYS quoted: a bare `FOO=docker exec x` is read by
// `. ./.env` in bash as "assign FOO=docker, then run exec x", which replaces the shell -
// a footgun this repo has already been bitten by.
/**
 * Quote a value so that DOTENV reads back exactly what was written.
 *
 * The previous encoding escaped `\` as `\\` and `"` as `\"` inside double quotes. dotenv
 * unescapes NEITHER (it only turns \n and \r into real newlines), so every value containing
 * a backslash came back different after a restart - `\[low\]`, the documented default of
 * REGEX_FILTER_JOB_OUTPUT, became `\\[low\\]`, a different regex. Worse, isOverridden then
 * compared that against the file and flipped the row to read-only, so the value could no
 * longer be corrected from the page at all. Measured: 8 of 13 representative values
 * round-tripped.
 *
 * SINGLE quotes are the default because dotenv performs no unescaping inside them at all, so
 * anything survives verbatim - and because this file gets sourced by bash sometimes, where
 * single quotes also suppress every expansion. Double quotes are used only when the value
 * itself contains a single quote, encoding real newlines as \n, which dotenv does undo.
 * Measured: 13 of 13, including quotes, backslashes, newlines and `$`.
 */
export function quoteValue(value) {
  const v = String(value);
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\r?\n/g, '\\n')}"`;
}

export function serialize(map) {
  const header = [
    '# Managed by the AnsibleForms settings page.',
    '# Values set in the real environment (docker-compose, kubernetes) take precedence',
    '# over this file, so a variable that is set there cannot be changed from here.',
    '',
  ];
  const body = [...map.entries()]
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${quoteValue(String(v))}`);
  return header.concat(body, '').join('\n');
}

/**
 * Reads the managed file with DOTENV'S OWN PARSER, deliberately.
 *
 * This used to be a second, hand-written parser, and isOverridden decides whether a variable
 * is read-only by comparing process.env (filled by dotenv at boot) against what this returns.
 * Any disagreement between the two therefore made a variable permanently uneditable - and
 * they did disagree: on backslash escapes, on `VALUE # trailing comment`, and on
 * `export NAME=x`. Delegating removes the whole class: there is now one reader.
 */
export function parseEnvFile(text) {
  return new Map(Object.entries(dotenv.parse(String(text || ''))));
}

export async function readManaged() {
  try {
    return parseEnvFile(await fs.readFile(MANAGED_ENV_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return new Map();
    throw e;
  }
}

// Validated against the documentation in help.yaml, so a typo cannot leave the app
// unable to start. `doc` is the help.yaml entry for the variable.
export function validate(name, value, doc) {
  const v = value === null || value === undefined ? '' : String(value);
  if (doc?.type === 'number' && v !== '' && !/^-?\d+$/.test(v)) {
    return `${name} must be a whole number`;
  }
  // documented as positive, so enforce it - a 0 here reaches the next boot as a real value
  if (doc?.type === 'number' && v !== '' && /positive/i.test(String(doc.allowed || '')) && parseInt(v, 10) < 1) {
    return `${name} must be greater than 0`;
  }
  if (/[\r\n]/.test(v)) return `${name} cannot contain a line break`;
  // legacy re-opens remote code execution for every authenticated user. That must be a
  // decision taken where the deployment is defined, not a dropdown on this page.
  if (name === 'EXPRESSION_SANITIZER' && v !== '') {
    const mode = v.trim().toLowerCase();
    if (mode === 'legacy') return 'EXPRESSION_SANITIZER=legacy can only be set in the real environment (docker-compose, kubernetes)';
    if (!['off', 'paranoid', 'strict'].includes(mode)) return 'EXPRESSION_SANITIZER must be off, paranoid or strict';
  }
  // a level winston does not know makes it log nothing at all : refused here, `warn` (and any
  // case) accepted as the level it means
  if (name in LOG_LEVEL_DEFAULTS && v !== '' && !knownLogLevel(v)) {
    return `${name} must be one of ${LOG_LEVELS.join(', ')}`;
  }
  // the Logs page's lines : a whole number of at least 1, no upper limit (empty : the default)
  if (name === 'LOG_VIEW_LINES' && !validViewLines(v)) {
    return 'LOG_VIEW_LINES must be a whole number of at least 1';
  }
  // a nightly system task's cron : 5 fields croner accepts and that run again, refused here
  // rather than passed over by the scheduler for the default (lib/systemTasks.js taskCron)
  if (SCHEDULE_SETTINGS.some((s) => s.env === name) && v !== '') {
    const problem = scheduleCronProblem(v);
    if (problem) return `${name} ${problem}`;
  }
  if (name === 'LAUNCH_VALIDATION' && v !== '' && !['off', 'log', 'enforce'].includes(v.trim().toLowerCase())) {
    return 'LAUNCH_VALIDATION must be off, log or enforce';
  }
  // refused here rather than at the next start : an address express cannot parse would
  // otherwise only be logged, and the audit trail would quietly keep naming the proxy
  if (name === 'TRUST_PROXY' && v !== '') {
    try {
      compileTrustProxy(v);
    } catch (e) {
      return `TRUST_PROXY must be a number of proxies, true, false or a comma-separated list of addresses and CIDR ranges: ${e.message}`;
    }
  }
  // refused here rather than at the next start, where it would only be logged and Node's own
  // limit would apply (lib/httpServerOptions.js)
  if (name === 'MAX_HTTP_HEADER_SIZE' && v !== '' && (parseInt(v, 10) < MIN_HEADER_SIZE || parseInt(v, 10) > MAX_HEADER_SIZE)) {
    return `MAX_HTTP_HEADER_SIZE must be a number of bytes from ${MIN_HEADER_SIZE} to ${MAX_HEADER_SIZE}`;
  }
  if (v.length > 4096) return `${name} is too long`;
  // A value documented as a regular expression is COMPILED by its consumer, and both of
  // them (MASK_EXTRAVARS_REGEX, REGEX_FILTER_JOB_OUTPUT) do so on a hot path - a logging
  // call and the job output formatter. An uncompilable one used to be accepted here and
  // then throw from there, so a stray bracket typed into this page aborted job launches
  // and made every job unviewable. The consumers now fall back to their default, but the
  // honest place to refuse it is the field it was typed into.
  if (v !== '' && /regular expression/i.test(String(doc?.allowed || ''))) {
    try {
      new RegExp(v);
    } catch (e) {
      return `${name} is not a valid regular expression: ${e.message}`;
    }
  }
  return null;
}

// Applies a saved value to the running process. Live variables also update appConfig, so
// they take effect without a restart ; everything else is only written to the file.
/**
 * @param {string} value            the new value ; '' means "clear this and go back to the default"
 * @param {string} [documentedDefault] help.yaml's `default` for this name, used on a clear
 *
 * Clearing used to write `''` straight into process.env and appConfig, so "clear the field to
 * get the default back" - the ONLY way to unset anything - gave the running process an empty
 * path or a false flag instead: BACKUP_PATH became "", SHOW_DESIGNER became false, VAULT_ADDR
 * became "" while the file key was deleted, which then made isOverridden compare a set
 * process.env against an absent file key and lock the field read-only until a restart.
 *
 * So a clear now REMOVES the variable from process.env (matching the file, so isOverridden
 * agrees) and applies the documented default instead. A default that is computed rather than
 * literal - help.yaml writes those as %PERSISTENT_FOLDER%/... - cannot be reproduced here, so
 * those report "needs a restart" rather than pretending.
 */
export function applyLive(name, value, documentedDefault) {
  const cleared = value === '' || value === null || value === undefined;
  if (cleared) {
    // absent, not empty : this is what makes isOverridden agree with the file
    delete process.env[name];
    const fallback = documentedDefault === undefined || documentedDefault === null
      ? null : String(documentedDefault);
    // a placeholder default is resolved at import from __dirname and cannot be rebuilt here
    if (fallback === null || fallback.includes('%')) return false;
    value = fallback;
  } else {
    process.env[name] = value;
  }
  const live = LIVE[name];
  if (live) {
    appConfig[live.key] = live.parse(value);
    return true;
  }
  const custom = LIVE_CUSTOM[name];
  if (custom) {
    // an applier that returns false could NOT apply the value (an unreadable certificate, a
    // pool size it refuses, no https server in http mode). Reporting 'live' there would tell
    // the user the change is in effect when only the file was written, so the refusal is
    // passed through and the caller flags it as needing a restart. Appliers that return
    // nothing are treated as applied.
    return custom(value) !== false;
  }
  // nothing to update beyond process.env : the consumer reads it on every call
  return LIVE_ENV_ONLY.has(name);
}

// Writes the file. The previous content is kept as .env.bak first : a bad DB_HOST can
// stop the app from starting, and the only way back is the old file.
export async function writeManaged(map) {
  const dir = path.dirname(MANAGED_ENV_PATH);
  try {
    await fs.access(dir, fsConstants.W_OK);
  } catch {
    throw new Error(`${dir} is not writable, so environment settings cannot be saved here`);
  }
  const text = serialize(map);
  try {
    const previous = await fs.readFile(MANAGED_ENV_PATH, 'utf8');
    await fs.writeFile(`${MANAGED_ENV_PATH}.bak`, previous, { mode: 0o600 });
    await fs.chmod(`${MANAGED_ENV_PATH}.bak`, 0o600);
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warning(`Could not back up ${MANAGED_ENV_PATH}: ${e.message}`);
  }
  // Write to a temp file in the SAME directory and rename over the target, so the file is
  // never half written. DB_HOST/DB_USER/DB_PASSWORD can live only here, and db.config.js
  // throws at import when they are missing - a truncated file (crash, ENOSPC) would leave an
  // app that cannot boot at all, recoverable only by hand from the .bak.
  //
  // The explicit chmod matters: writeFile's `mode` applies only when it CREATES the file, so
  // an existing 0644 .env stayed 0644 while credentials were written into it.
  const tmp = `${MANAGED_ENV_PATH}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, MANAGED_ENV_PATH);
  return text;
}

export default { MANAGED_ENV_PATH, OWNED_ELSEWHERE, SECRET_ENV_NAME, REFUSED, isServerOwnVariable, ENV_EDIT_DISABLED_REASON, RELOCATES, RUNNER_PAGE, classify, isOverridden, serialize, parseEnvFile, readManaged, validate, applyLive, writeManaged };
