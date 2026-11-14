import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



/**
 * The days of log files kept : a whole number, 30 when unset or not a number ; 0 keeps them all.
 *
 * Args:
 *   value (string|undefined): LOG_RETENTION_DAYS.
 *
 * Returns:
 *   number: the days, 0 for for ever.
 */
export function parseRetentionDays(value) {
  const days = parseInt(value ?? '90', 10);
  return Number.isNaN(days) || days < 0 ? 90 : days;
}

// the lines the Logs page shows when LOG_VIEW_LINES is unset or not a whole number of at least 1
export const LOG_VIEW_LINES_DEFAULT = 1000;

/**
 * The lines of today's log the Logs page shows, and the most the log endpoint answers : a whole
 * number of at least 1, no upper limit (an admin who sets it high makes the page heavier to
 * follow, their choice) ; the default (1000) when unset or not one.
 *
 * Args:
 *   value (string|number|undefined): LOG_VIEW_LINES.
 *
 * Returns:
 *   number: the lines.
 */
export function parseViewLines(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return LOG_VIEW_LINES_DEFAULT;
  const lines = Number(text);
  return lines >= 1 ? lines : LOG_VIEW_LINES_DEFAULT;
}

/**
 * Whether a value is one LOG_VIEW_LINES takes : empty (the default), or a whole number of at
 * least 1.
 *
 * Args:
 *   value (string|undefined): the value.
 *
 * Returns:
 *   boolean: true when it is.
 */
export function validViewLines(value) {
  const text = String(value ?? '').trim();
  return text === '' || (/^\d+$/.test(text) && Number(text) >= 1);
}

// The levels the logger knows : winston's syslog levels, the most severe first. They have
// `warning` and no `warn`, and winston logs NOTHING at all (errors included) for a level it does
// not know - which is what LOG_LEVEL=warn did, the value the documentation once gave.
export const LOG_LEVELS = ['emerg', 'alert', 'crit', 'error', 'warning', 'notice', 'info', 'debug'];

// each level variable with its documented default (help.yaml), used when it is unset or unknown
export const LOG_LEVEL_DEFAULTS = {
  LOG_LEVEL: 'notice',
  LOG_CONSOLE_LEVEL: 'notice',
  LOG_SYSLOG_LEVEL: 'debug',
};

/**
 * The level a value names, or null when it names none : case and spaces do not matter, and
 * `warn` is `warning` (what the documentation once said, still in many an environment).
 *
 * Args:
 *   value (string|undefined): the value of a level variable.
 *
 * Returns:
 *   string|null: the level, or null for an empty or unknown value.
 */
export function knownLogLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  if (level === 'warn') return 'warning';
  return LOG_LEVELS.includes(level) ? level : null;
}

/**
 * The level a level variable sets : its value when it names one, its documented default when
 * it is unset or names none (logger.js says which, once, at start).
 *
 * Args:
 *   name (string): the variable (LOG_LEVEL, LOG_CONSOLE_LEVEL, LOG_SYSLOG_LEVEL).
 *   value (string|undefined): its value.
 *
 * Returns:
 *   string: the level.
 */
export function parseLogLevel(name, value) {
  return knownLogLevel(value) || LOG_LEVEL_DEFAULTS[name] || 'notice';
}

var log_config = {
  level: parseLogLevel('LOG_LEVEL', process.env.LOG_LEVEL),
  path: process.env.LOG_PATH || path.resolve(__dirname + '/../persistent/logs'),
  consolelevel: parseLogLevel('LOG_CONSOLE_LEVEL', process.env.LOG_CONSOLE_LEVEL),
  sysloglevel: parseLogLevel('LOG_SYSLOG_LEVEL', process.env.LOG_SYSLOG_LEVEL),
  // no default host : syslog is off until LOG_SYSLOG_HOST names one (logger.js only builds
  // the transport for a host). A "localhost" default sent every install's logs to udp 514.
  sysloghost: process.env.LOG_SYSLOG_HOST || "",
  syslogport: process.env.LOG_SYSLOG_PORT || 514,
  syslogprotocol: process.env.LOG_SYSLOG_PROTOCOL || "udp4",
  syslogpath: process.env.LOG_SYSLOG_PATH || "/dev/log",
  sysloglocalhost: process.env.LOG_SYSLOG_SOURCE || "localhost",
  syslogtype: process.env.LOG_SYSLOG_TYPE || "BSD",
  syslogappname: process.env.LOG_SYSLOG_APPNAME || "AnsibleForms",
  tz: process.env.LOG_TZ || "UTC",
  // how many days of log files are kept (the main log and the errors log) ; 0 keeps them all
  retentionDays: parseRetentionDays(process.env.LOG_RETENTION_DAYS),
  // the lines of today's log the Logs page shows, and the most the log endpoint answers
  viewLines: parseViewLines(process.env.LOG_VIEW_LINES),
};
if ( !fs.existsSync( log_config.path ) ) {
  try{
    // Create the directory if it does not exist.
    // `recursive` matters : the default LOG_PATH is ./persistent/logs and persistent/ is
    // gitignored, so on a fresh clone the parent does not exist either and a plain mkdir
    // fails with ENOENT - taking 22 test suites and `npm run dev` down with it. That is
    // what "server/persistent/ must exist" was a manual workaround for.
    fs.mkdirSync( log_config.path, { recursive: true } );
  }catch(err){
    throw new Error("Failed to create the path for the log files", { cause: err })
  }

}
export default log_config;