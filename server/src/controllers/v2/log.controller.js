'use strict';
import Log from '../../models/log.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import logConfig from '../../../config/log.config.js';

/**
 * The lines a request is answered : the lines it asks, at most LOG_VIEW_LINES (the Logs page's
 * setting, 1000 by default), and LOG_VIEW_LINES when it asks none or no whole number of at
 * least 1. So no request can make the server read the whole day's file : that is the download.
 *
 * Args:
 *   asked (string|undefined): query.lines.
 *   limit (number): LOG_VIEW_LINES.
 *
 * Returns:
 *   number: the lines to read.
 */
export function linesToRead(asked, limit) {
  const text = String(asked ?? '').trim();
  const n = /^\d+$/.test(text) ? Number(text) : 0;
  return n >= 1 ? Math.min(n, limit) : limit;
}

/**
 * The day a request asks : its `date` query (YYYY-MM-DD, a real calendar day), today when it
 * asks none. Anything else (another form, a day that does not exist, a repeated parameter) is
 * refused : a path is only ever built from a checked day.
 *
 * Args:
 *   asked (any): query.date.
 *
 * Returns:
 *   string|null: the day, null when the value is no day.
 */
export function dayToRead(asked) {
  if (asked === undefined || asked === '') return Log.today();
  return Log.isDate(asked) ? asked : null;
}

/**
 * The last lines of a day's log (Settings > Logs reads today's every 2 seconds, another day once).
 *
 * A day without a file is an empty log, not a failure : today's is only made by the first line
 * logged today (just after midnight, or on a quiet server, it is not there yet), and a day past
 * may have been swept by LOG_RETENTION_DAYS. Answered with no lines (200) and the header
 * X-Log-Missing: true, so the page says there is no log for that day, and keeps following today's
 * until its lines come, where a 500 made it stop reading. The body stays the log's text, as it
 * always was, so a script reading it is not broken. Every answer names the day it read in
 * X-Log-Date : the page following today learns the server's today (its local date, which the
 * files are named after, may not be the browser's), and moves on with it at midnight.
 *
 * Args:
 *   req (object): the request ; query.lines, how many lines (LOG_VIEW_LINES by default, and at
 *     most) ; query.date, the day (YYYY-MM-DD, today by default).
 *   res (object): the response ; 400 for a date that is no day.
 */
const get = async function(req, res) {
  try {
    // step 1 : the day, checked before anything is read
    const date = dayToRead(req.query.date);
    if (!date) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.invalidLogDate')));
    }
    // the lines asked, at most the Logs page's setting (LOG_VIEW_LINES) ; none asked, that many
    const lines = linesToRead(req.query.lines, logConfig.viewLines);
    // step 2 : its last lines ; no file for that day, an empty log said missing
    const log = await Log.find(lines, date);
    res.set('X-Log-Date', date);
    if (log === null) {
      res.set('X-Log-Missing', 'true');
      return res.json(RestResult.single(''));
    }
    res.json(RestResult.single(log));
  } catch(err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedGetLog'), err.toString()));
  }
};

/**
 * The days that have a log file (plain or zipped), the newest first : the years the Logs page
 * offers, and which days of them have something to show.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response ; a list of YYYY-MM-DD.
 */
const dates = async function(req, res) {
  try {
    res.json(RestResult.list(await Log.dates()));
  } catch(err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedGetLog'), err.toString()));
  }
};

/**
 * Downloads a day's log file : its plain .log, or its zipped .log.gz as it is.
 *
 * Args:
 *   req (object): the request ; query.date, the day (YYYY-MM-DD, today by default).
 *   res (object): the response ; 400 for a date that is no day, 404 when the day has no file.
 */
const download = function(req, res) {
  // step 1 : the day, checked before a path is built from it
  const date = dayToRead(req.query.date);
  if (!date) {
    return res.status(400).json(RestResult.error(i18n.t(req, 'resources.invalidLogDate')));
  }
  // step 2 : its file, or why there is none
  try {
    const file = Log.getFileName(date);
    res.download(file);
  } catch(err) {
    res.status(404).json(RestResult.error(i18n.t(req, 'resources.logNotFound'), err.toString()));
  }
};

export default {
  get,
  dates,
  download
};
