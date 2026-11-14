'use strict';
import fs from "fs";
import config from "../../config/log.config.js";
import path from "path";
import zlib from "zlib";
import { StringDecoder } from "string_decoder";
import readLastLines from "read-last-lines";
import moment from "moment";

// ─── the server's log files ───────────────────────────────────────────────────
// winston-daily-rotate-file writes one file a day in LOG_PATH : ansibleforms.YYYY-MM-DD.log,
// named after the server's LOCAL date (moment()), and zips the days past as
// ansibleforms.YYYY-MM-DD.log.gz (zippedArchive). The errors go to their own files
// (ansibleforms.errors.YYYY-MM-DD.log), which the Logs page does not show.

const Log = {

}

// a day as the files name it : four digits, two, two (a real calendar day is checked apart)
const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
// a main log file of a day, plain or zipped ; the errors files do not match (their middle part)
const LOG_FILE = /^ansibleforms\.(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/;

/**
 * Whether a value is a real calendar day written as YYYY-MM-DD : 2026-02-29 is not (2026 is no
 * leap year), nor 2026-13-01, nor anything with more around it. The only form a path is ever
 * built from.
 *
 * Args:
 *   value (any): the value, a query parameter for example (an array when repeated).
 *
 * Returns:
 *   boolean: true when it is one.
 */
Log.isDate = function (value) {
  if (typeof value !== 'string') return false;
  const m = DATE_FORMAT.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // a Date made from the parts gives the same parts back only for a day that exists
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
};

/**
 * Today, as the log files name it : the server's local date (moment()), the rule the logger's
 * rotation follows.
 *
 * Returns:
 *   string: YYYY-MM-DD.
 */
Log.today = function () {
  return moment().format("YYYY-MM-DD");
};

/**
 * The file of a day : its plain log, else its zipped one, else none.
 *
 * Args:
 *   date (string): the day, YYYY-MM-DD (checked : anything else has no file).
 *
 * Returns:
 *   string|null: the file's path, null when the day has none.
 */
Log.fileFor = function (date) {
  // never a path from a value that is not a day : no '..', no separator can reach it
  if (!Log.isDate(date)) return null;
  // and the path resolved and kept inside LOG_PATH all the same : a second guard, the one code
  // scanning recognises, so no value can ever name a file outside the log folder
  const root = path.resolve(config.path);
  const plain = path.resolve(root, `ansibleforms.${date}.log`);
  if (!plain.startsWith(root + path.sep)) return null;
  if (fs.existsSync(plain)) return plain;
  const zipped = plain + '.gz';
  if (fs.existsSync(zipped)) return zipped;
  return null;
};

/**
 * The days that have a log file, plain or zipped, the newest first. The errors files are not
 * counted : a day with only errors has no log to show.
 *
 * Returns:
 *   Promise<string[]>: the days, YYYY-MM-DD.
 *
 * Raises:
 *   Error: LOG_PATH could not be read.
 */
Log.dates = async function () {
  const names = await fs.promises.readdir(config.path);
  const days = new Set();
  for (const name of names) {
    const m = LOG_FILE.exec(name);
    // a name that looks like a day but is none (2026-02-30) is not offered
    if (m && Log.isDate(m[1])) days.add(m[1]);
  }
  // YYYY-MM-DD sorts as text in the order of the days
  return [...days].sort().reverse();
};

/**
 * The last lines of a zipped log, unzipped as they stream : only the last lines are kept in
 * memory, never the whole day.
 *
 * Args:
 *   file (string): the .gz file.
 *   lines (number): how many of its last lines.
 *
 * Returns:
 *   Promise<string>: the lines, each ended by a newline ; '' for an empty file.
 *
 * Raises:
 *   Error: the file could not be read, or is no gzip.
 */
Log.readZippedTail = function (file, lines) {
  return new Promise((resolve, reject) => {
    const tail = [];
    let rest = '';
    // a character cut in two between chunks is put back together
    const decoder = new StringDecoder('utf8');
    const keep = (line) => {
      tail.push(line);
      // trimmed now and then rather than per line : a shift per line is slow on a long day
      if (tail.length > lines * 2) tail.splice(0, tail.length - lines);
    };
    const input = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    input.on('error', reject);
    gunzip.on('error', reject);
    gunzip.on('data', (chunk) => {
      // step 1 : the whole lines of what came, the last part waits for its end
      const parts = (rest + decoder.write(chunk)).split('\n');
      rest = parts.pop();
      for (const part of parts) keep(part);
    });
    gunzip.on('end', () => {
      // step 2 : a last line without its newline counts too
      rest += decoder.end();
      if (rest) keep(rest);
      const last = tail.slice(-lines);
      resolve(last.length ? last.join('\n') + '\n' : '');
    });
    input.pipe(gunzip);
  });
};

/**
 * The last lines of a day's log, its plain file or its zipped one.
 *
 * Args:
 *   lines (number): how many of its last lines.
 *   date (string): the day, YYYY-MM-DD ; today by default.
 *
 * Returns:
 *   Promise<string|null>: the lines, null when the day has no log file.
 *
 * Raises:
 *   Error: the file could not be read.
 */
Log.find = async function (lines, date = Log.today()) {
  const fileName = Log.fileFor(date);
  if (!fileName) return null;
  if (fileName.endsWith('.gz')) return Log.readZippedTail(fileName, lines);
  return readLastLines.read(fileName, lines);
};

/**
 * The file of a day to download : its plain log, else its zipped one (sent as it is).
 *
 * Args:
 *   date (string): the day, YYYY-MM-DD ; today by default.
 *
 * Returns:
 *   string: the file's path.
 *
 * Raises:
 *   Error: the day has no log file.
 */
Log.getFileName = function (date = Log.today()) {
  const fileName = Log.fileFor(date);
  if (fileName) return fileName;
  throw new Error(`No logfile ansibleforms.${Log.isDate(date) ? date : '(invalid date)'}.log found`);
};

export default Log;
