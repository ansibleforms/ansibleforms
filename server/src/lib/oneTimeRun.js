'use strict';
// The moment of a one-time run (a schedule's one_time_run, a planned job's run_at), read the one
// way the app takes it : an ISO 8601 time with its offset or Z, so the run never depends on the
// zone of a server or a browser (#1064), on a day that exists. Pure : the MCP tools (plan_job,
// create_schedule) and the schedules repository's entries (lib/scheduleFiles.js) read it with it ;
// whether it may be in the past is the caller's to say.

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

export default { parseMoment, isoMoment, dbMoment };
