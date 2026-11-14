import Audit from '../../models/audit.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import helpers from '../../lib/common.js';

// Read only by design : there is deliberately no create, update or delete handler
// here. Entries are written by Audit.log from the middleware and the models, and
// removed only by the retention sweep.

// an instant as the page sends a period's bounds : a day, or a day and a time with an optional
// zone (2026-11-14, 2026-11-13T23:00:00.000Z, 2026-11-14T00:00:00+01:00)
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
// the period a download is named after : a year, a month or a day (audit-2026-11-14.csv)
const PERIOD_NAME = /^\d{4}(-\d{2}(-\d{2})?)?$/;
// the columns of the download, the ones the page shows ; the time in ISO, the detail as JSON text
const CSV_COLUMNS = ['time', 'actor', 'action', 'target', 'outcome', 'ip', 'detail'];

/**
 * Whether a period bound is one the read side takes : none, or one ISO date (or date and time)
 * that is a real instant. A repeated parameter (an array) is not one.
 *
 * Args:
 *   value (any): query.from or query.to.
 *
 * Returns:
 *   boolean: true when it is.
 */
export function validInstant(value) {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return false;
  return !isNaN(new Date(value).getTime());
}

/**
 * The filter of a request, checked : the period's bounds must be ISO dates, or the request is
 * refused with a reason rather than read with a bound silently dropped.
 *
 * Args:
 *   req (object): the request ; its query's actor, actorType, action, targetType, target,
 *     outcome, from, to, limit and offset.
 *
 * Returns:
 *   object: filter, the filter to read with ; or error, the translated reason (a 400).
 */
export function readQuery(req) {
  const q = req.query || {};
  // the period, [from, to)
  if (!validInstant(q.from) || !validInstant(q.to)) {
    return { error: i18n.t(req, 'audit.invalidPeriod') };
  }
  return {
    filter: {
      actor: q.actor,
      actorType: q.actorType,
      action: q.action,
      targetType: q.targetType,
      target: q.target,
      outcome: q.outcome,
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    },
  };
}

/**
 * One cell of the download : quoted (every cell, so a comma, a quote or a line break inside
 * stays in it, the quotes doubled), and a text that a spreadsheet would run as a formula (one
 * starting with = + - @, a tab or a carriage return) given a leading quote, so it shows as text.
 *
 * Args:
 *   value (any): the value ; null and undefined are empty.
 *
 * Returns:
 *   string: the cell.
 */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/**
 * One line of the download, ended by CRLF (RFC 4180).
 *
 * Args:
 *   values (Array): the row's values, in the columns' order.
 *
 * Returns:
 *   string: the line.
 */
export function csvLine(values) {
  return values.map(csvCell).join(',') + '\r\n';
}

/**
 * An entry as a line of the download : the time in ISO, the detail as its JSON text (as
 * stored, already scrubbed of secrets when written ; nothing is added to it here).
 *
 * Args:
 *   row (object): the entry, as read from the table.
 *
 * Returns:
 *   string: the line.
 */
export function entryLine(row) {
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  const detail = row.detail === null || row.detail === undefined || typeof row.detail === 'string'
    ? row.detail
    : JSON.stringify(row.detail);
  return csvLine([created, row.actor, row.action, row.target, row.outcome, row.ip, detail]);
}

/**
 * The download's file name : audit-<period>.csv for a year, a month or a day, audit.csv
 * otherwise (no period, or one not written as such : it only names the file).
 *
 * Args:
 *   period (any): query.period, YYYY, YYYY-MM or YYYY-MM-DD.
 *
 * Returns:
 *   string: the file name.
 */
export function downloadName(period) {
  return typeof period === 'string' && PERIOD_NAME.test(period) ? `audit-${period}.csv` : 'audit.csv';
}

/**
 * A page of the trail, filtered, the newest first.
 *
 * Args:
 *   req (object): the request ; its query's filters, from and to (ISO, [from, to)), limit and
 *     offset.
 *   res (object): the response ; 400 for a period that is not one.
 */
const findAll = async function (req, res) {
  const { filter, error } = readQuery(req);
  if (error) return res.status(400).json(RestResult.error(error));
  try {
    const result = await Audit.find(filter);
    res.json(RestResult.single(result));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'audit.failedGet'), helpers.getError(err)));
  }
};

/**
 * Every entry the filters select, the newest first, as a CSV file : a header row, then a
 * line per entry, UTF-8 with a byte order mark so a spreadsheet reads the accents. The rows are
 * streamed from the database and written as they come, the writing paced by the client.
 *
 * Args:
 *   req (object): the request ; the query of findAll (no limit or offset : all of them), and
 *     period (YYYY, YYYY-MM or YYYY-MM-DD), which only names the file.
 *   res (object): the response ; 400 for a period that is not one.
 */
const download = async function (req, res) {
  const { filter, error } = readQuery(req);
  if (error) return res.status(400).json(RestResult.error(error));
  // the client gone, the reading stops
  let gone = false;
  req.on?.('close', () => {
    gone = true;
  });
  try {
    for await (const row of Audit.stream(filter)) {
      // step 1 : the headers and the header row, with the first entry (an error before it is
      // still a JSON 500)
      if (!res.headersSent) start(res, req.query.period);
      // step 2 : the entry, waiting for the client when its buffer is full
      if (!res.write(entryLine(row))) await new Promise((resolve) => res.once('drain', resolve));
      if (gone) break;
    }
    // no entry at all : the header row alone
    if (!res.headersSent) start(res, req.query.period);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json(RestResult.error(i18n.t(req, 'audit.failedGet'), helpers.getError(err)));
    }
    // half a file sent : cut it, so it is not taken for the whole
    res.destroy(err);
  }
};

/**
 * Starts the download : its headers, the byte order mark and the header row.
 *
 * Args:
 *   res (object): the response.
 *   period (any): query.period, for the file name.
 */
function start(res, period) {
  res.status(200);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${downloadName(period)}"`);
  res.write('﻿' + csvLine(CSV_COLUMNS));
}

/**
 * The values the filters offer : the actions and actors recorded, and the oldest entry's time
 * (the first year of the period).
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 */
const facets = async function (req, res) {
  try {
    res.json(RestResult.single(await Audit.facets()));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'audit.failedGet'), helpers.getError(err)));
  }
};

export default { findAll, download, facets };
