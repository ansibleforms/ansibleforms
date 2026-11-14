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
 * The last lines of today's log (Settings > Logs reads it every 2 seconds).
 *
 * Today's file is only made by the first line logged today : just after midnight, or on a
 * quiet server, it is not there yet. That is an empty log, not a failure : answered with no
 * lines (200), the page keeps following and shows the lines once they come, where a 500 made
 * it stop reading.
 *
 * Args:
 *   req (object): the request ; query.lines, how many lines (LOG_VIEW_LINES by default, and at
 *     most).
 *   res (object): the response.
 */
const get = async function(req, res) {
  try {
    // the lines asked, at most the Logs page's setting (LOG_VIEW_LINES) ; none asked, that many
    const lines = linesToRead(req.query.lines, logConfig.viewLines);
    // step 1 : no file for today yet, an empty log
    try {
      Log.getFileName();
    } catch {
      return res.json(RestResult.single(''));
    }
    // step 2 : its last lines
    const log = await Log.find(lines);
    res.json(RestResult.single(log));
  } catch(err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedGetLog'), err.toString()));
  }
};

const download = function(req, res) {
  try {
    const file = Log.getFileName();
    res.download(file);
  } catch(err) {
    res.status(404).json(RestResult.error(i18n.t(req, 'resources.logNotFound'), err.toString()));
  }
};

export default {
  get,
  download
};