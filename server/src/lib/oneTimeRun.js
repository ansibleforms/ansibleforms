'use strict';
// The moment of a one-time run (a schedule's one_time_run, a planned job's too), read the one way
// the app takes it : an ISO 8601 time with its offset or Z, so the run never depends on the zone of
// a server or a browser (#1064), on a day that exists. The MCP tools (plan_job, create_schedule),
// the schedule model and the schedules repository's entries (lib/scheduleFiles.js) read it with
// it ; whether it may be in the past is the caller's to say. The pair a request sent before 7.8.0
// (one_time_run true with run_at) is still read here, deprecated (oneTimeRunOf).

import logger from './logger.js';
import Errors from './errors.js';

// an ISO 8601 time with its offset or Z : 2026-10-15T22:00:00+02:00, 2026-10-15T20:00:00Z
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Reads a run_at : the moment it names, or why it is refused.
 *
 * Args:
 *   value (any): the time given (a text ; a Date is taken as it is).
 *   what (string): the field's name, for the reason.
 *
 * Returns:
 *   object: { when (Date) } or { error (string) }.
 */
export function parseMoment(value, what = 'run_at') {
  if (value instanceof Date) return isNaN(value.getTime()) ? { error: `${what} is not a valid time` } : { when: value };
  const text = String(value ?? '').trim();
  if (!ISO_WITH_ZONE.test(text)) {
    return {
      error: `${what} must be an ISO 8601 time with its offset or Z, such as 2026-10-15T22:00:00+02:00 or `
        + `2026-10-15T20:00:00Z, not '${text}': a time without a zone is ambiguous`,
    };
  }
  const when = new Date(text);
  // a date that does not exist (30 February, 24:00) is moved by the parser without a word :
  // refused instead, the run would happen on another day than the one asked
  const [, y, mo, d, h, mi] = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/).map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(when.getTime()) || h > 23 || mi > 59
    || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return { error: `${what} '${text}' is not a valid time` };
  }
  return { when };
}

/**
 * A moment as a file writes it : an ISO text in UTC, to the second (2026-11-01T08:00:00Z).
 *
 * Args:
 *   value (any): a Date, an ISO text, or a stored DATETIME text (UTC, without its zone).
 *
 * Returns:
 *   string|null: the moment ; null for none or one that is no date.
 */
export function isoMoment(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = value instanceof Date ? value.toISOString() : String(value).trim();
  // the database's DATETIME (YYYY-MM-DD HH:MM:SS) is UTC (db.model.js timezone 'Z')
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(text) || value instanceof Date ? text : text.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A moment as the schedule table keeps it : UTC, YYYY-MM-DD HH:MM:SS (as the crud model stores
 * the run_at a page sends).
 *
 * Args:
 *   value (any): a Date, an ISO text, or a stored DATETIME text.
 *
 * Returns:
 *   string|null: the moment ; null for none or one that is no date.
 */
export function dbMoment(value) {
  const iso = isoMoment(value);
  return iso ? iso.slice(0, 19).replace('T', ' ') : null;
}

// the callers already told of the deprecated pair (one_time_run true + run_at), once each
const warned = new Set();

/**
 * Whether a value is the old flag of a one-time run (6.2.0 to 7.4 : true / 1, false / 0) rather
 * than its moment.
 *
 * Args:
 *   value (any): a request's one_time_run.
 *
 * Returns:
 *   boolean|null: true or false for the flag ; null when it is no flag (a moment, or none).
 */
function flagOf(value) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

/**
 * A request's one-time run in the shape 7.8.0 takes it : one_time_run, the moment of the run (or
 * null : not one). The pair before it is still read, deprecated since 7.8.0 and removed in 8, said
 * once in the server log per caller : one_time_run true (or 1) with run_at is a one-time run at
 * run_at, run_at alone too ; one_time_run false (or 0) is none (its run_at ignored : a cron or a
 * rrule times it). The request is changed in place, run_at removed.
 *
 * Args:
 *   data (object): the request body.
 *   caller (string): who sent it (the API, the MCP tools), for the warning.
 *
 * Returns:
 *   object: the request.
 *
 * Raises:
 *   Errors.BadRequestError: one_time_run true without its moment.
 */
export function oneTimeRunOf(data, caller = "api") {
  if (!data || typeof data !== "object") return data;
  const flag = flagOf(data.one_time_run);
  const hasRunAt = Object.prototype.hasOwnProperty.call(data, "run_at");
  const runAt = hasRunAt && data.run_at !== null && data.run_at !== undefined && String(data.run_at).trim() !== "" ? data.run_at : null;
  if (flag === null && !hasRunAt) return data;
  if (flag !== null || runAt) {
    if (!warned.has(caller)) {
      warned.add(caller);
      logger.warning(`A schedule was sent one_time_run as a yes or no${runAt ? " with run_at" : ""} (${caller}), deprecated since 7.8.0 and removed in 8: send one_time_run with the moment of the run instead (an ISO 8601 time with its offset or Z)`);
    }
  }
  if (flag === true) {
    if (!runAt) throw new Errors.BadRequestError("A one time run needs its moment: send one_time_run with the time of the run (an ISO 8601 time with its offset or Z).");
    data.one_time_run = runAt;
  } else if (flag === false) data.one_time_run = null;
  else if (runAt && (data.one_time_run === undefined || data.one_time_run === null || data.one_time_run === "")) data.one_time_run = runAt;
  delete data.run_at;
  return data;
}

/**
 * A one-time run's moment as the schedule table keeps it, from what the app is sent : an ISO 8601
 * time with its offset or Z, a Date, or a time without a zone taken as UTC (as the table took one
 * before 7.8.0).
 *
 * Args:
 *   value (any): the moment.
 *
 * Returns:
 *   string|null: YYYY-MM-DD HH:MM:SS in UTC ; null for none.
 *
 * Raises:
 *   Errors.BadRequestError: a value that is no time.
 */
export function tableMoment(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const { when } = parseMoment(value, "one_time_run");
  if (when) return dbMoment(when);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text) && dbMoment(text)) return dbMoment(text.length === 16 ? `${text}:00` : text);
  throw new Errors.BadRequestError(`one_time_run '${text}' is not a time: send an ISO 8601 time with its offset or Z`);
}

export default { parseMoment, isoMoment, dbMoment, oneTimeRunOf, tableMoment };
