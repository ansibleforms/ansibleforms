'use strict';
// How a schedule ends.
//
// A schedule timed by a cron or a rrule ends never (the default, every schedule from before), on
// a date (end_at) or after a number of runs (end_count) ; it is then turned off (end_action
// 'disable', the default) or removed ('remove'). A rrule's own UNTIL or COUNT still works : this
// end comes on top of it. The jobs it started are counted (run_count), the same jobs its Runs tab
// lists (jobs.schedule_id) : "after 3 runs" ends it once it started three jobs in all.
//
// A one-time run has no end : it ends with its run, removed (remove_after_run, the default, as
// before) or turned off and kept with its outcome.
//
// A schedule from a schedules repository is managed by its file : an end only ever turns it off,
// never removes its row, whatever end_action says (models/schedule.model.js endSchedule).
//
// Pure : the schedule model, the scheduler (services/cron.service.js), the schedules repository's
// files (lib/scheduleFiles.js) and the rrule preview (controllers/v2/schedule.controller.js) use it.

import Errors from './errors.js';
import { parseMoment, dbMoment } from './oneTimeRun.js';

// ===========================================================================
// CONSTANTS
// ===========================================================================

// how a schedule ends, and what then happens to it
export const ENDS = ['never', 'date', 'count'];
export const END_ACTIONS = ['disable', 'remove'];

// the columns of the end, as a request or a file may give them (run_count is the scheduler's)
export const END_FIELDS = ['ends', 'end_at', 'end_count', 'end_action', 'remove_after_run'];

// ===========================================================================
// HELPERS
// ===========================================================================

/**
 * Whether a value is given : not undefined, null or blank text.
 *
 * Args:
 *   v (any): the value.
 *
 * Returns:
 *   boolean: true when given.
 */
const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * A yes or no as a request or a file gives it : a boolean, 1 / 0, or yes / no, true / false,
 * on / off text.
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   boolean|undefined: the boolean ; undefined when it is none of those.
 */
export function boolOf(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return undefined;
}

/**
 * An end's moment as the schedule table keeps it (UTC, YYYY-MM-DD HH:MM:SS) : an ISO 8601 time
 * with its offset or Z, a Date, or a time without a zone taken as UTC, as a one-time run's.
 *
 * Args:
 *   value (any): the moment.
 *
 * Returns:
 *   string|null: the moment ; null when it is no time.
 */
export function endMoment(value) {
  if (!given(value)) return null;
  const { when } = parseMoment(value, 'end_at');
  if (when) return dbMoment(when);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) return dbMoment(text.length === 16 ? `${text}:00` : text);
  return null;
}

/**
 * A moment of the table (UTC without its zone), an ISO text or a Date, as a Date.
 *
 * Args:
 *   value (any): the moment.
 *
 * Returns:
 *   Date|null: the moment ; null for none or one that is no date.
 */
export function momentDate(value) {
  if (!given(value)) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : text.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

// ===========================================================================
// WHAT A REQUEST GIVES
// ===========================================================================

/**
 * Checks the end a request gives a schedule and writes it in the shape the table keeps, in
 * place : the end merged with the one it had (an update gives only what changes), the fields its
 * kind does not use cleared. A one-time run has no end : what is given of it is ignored and its
 * end set back to never. remove_after_run is read as a yes or no. run_count is never a request's
 * : dropped (the scheduler counts the jobs it starts).
 *
 *   ends 'date'   needs end_at (a moment) ; end_count cleared
 *   ends 'count'  needs end_count, a whole number of at least 1 ; end_at cleared
 *   ends 'never'  both cleared
 *
 * Args:
 *   data (object): the request body (changed in place).
 *   current (object|null): the schedule as it is (an update), null for a new one.
 *   once (boolean): whether it is timed by a one-time run (after the request).
 *
 * Returns:
 *   object: the request.
 *
 * Raises:
 *   Errors.BadRequestError: an unknown ends or end_action, no or a bad end_at for ends date, no
 *     or a bad end_count for ends count, or a remove_after_run that is no yes or no.
 */
export function checkEnd(data, current = null, once = false) {
  delete data.run_count;
  // remove_after_run : a yes or no, for a one-time run (kept on the others, unused)
  if (data.remove_after_run !== undefined) {
    const v = boolOf(data.remove_after_run);
    if (v === undefined) throw new Errors.BadRequestError('remove_after_run must be true or false.');
    data.remove_after_run = v ? 1 : 0;
  }
  const touched = ['ends', 'end_at', 'end_count', 'end_action'].some((k) => data[k] !== undefined);
  // a one-time run : no end, whatever is given ; set back to never when it had one
  if (once) {
    for (const k of ['ends', 'end_at', 'end_count', 'end_action']) delete data[k];
    if (current && (current.ends ?? 'never') !== 'never') Object.assign(data, { ends: 'never', end_at: null, end_count: null });
    return data;
  }
  if (!touched) return data;
  const ends = given(data.ends) ? String(data.ends).trim() : current?.ends || 'never';
  if (!ENDS.includes(ends)) throw new Errors.BadRequestError(`ends must be one of ${ENDS.join(', ')}, not '${data.ends}'.`);
  const action = given(data.end_action) ? String(data.end_action).trim() : current?.end_action || 'disable';
  if (!END_ACTIONS.includes(action)) {
    throw new Errors.BadRequestError(`end_action must be one of ${END_ACTIONS.join(', ')}, not '${data.end_action}'.`);
  }
  const out = { ends, end_action: action, end_at: null, end_count: null };
  if (ends === 'date') {
    const raw = data.end_at !== undefined ? data.end_at : current?.end_at;
    if (!given(raw)) throw new Errors.BadRequestError('A schedule that ends on a date needs that date (end_at).');
    out.end_at = endMoment(raw);
    if (!out.end_at) throw new Errors.BadRequestError(`end_at '${raw}' is not a time: send an ISO 8601 time with its offset or Z.`);
  } else if (ends === 'count') {
    const raw = data.end_count !== undefined ? data.end_count : current?.end_count;
    if (!given(raw)) throw new Errors.BadRequestError('A schedule that ends after a number of runs needs that number (end_count).');
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Errors.BadRequestError(`end_count must be a whole number of at least 1, not '${raw}'.`);
    out.end_count = n;
  }
  Object.assign(data, out);
  return data;
}

// ===========================================================================
// WHEN IT ENDS
// ===========================================================================

/**
 * Whether a schedule timed by a cron or a rrule reached its end : now at or past its end_at, or
 * as many jobs started as its end_count. A one-time run never does (it ends with its run).
 *
 * Args:
 *   row (object): the schedule ({ one_time_run, ends, end_at, end_count, run_count }).
 *   now (Date): the moment it is checked at.
 *
 * Returns:
 *   string|null: 'date' or 'count', what ended it ; null while it goes on.
 */
export function endReached(row, now = new Date()) {
  if (!row || row.one_time_run) return null;
  if (row.ends === 'date') {
    const at = momentDate(row.end_at);
    return at && now.getTime() >= at.getTime() ? 'date' : null;
  }
  if (row.ends === 'count') {
    const n = Number(row.end_count);
    return Number.isInteger(n) && n >= 1 && Number(row.run_count || 0) >= n ? 'count' : null;
  }
  return null;
}

/**
 * How many runs a schedule ending after a number of runs has left : its end_count less the jobs
 * it started ; null for one that does not end so.
 *
 * Args:
 *   row (object): { ends, end_count, run_count }.
 *
 * Returns:
 *   number|null: the runs left (0 or more) ; null : no limit.
 */
export function runsLeft(row) {
  if (row?.ends !== 'count') return null;
  const n = Number(row.end_count);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.max(0, n - Number(row.run_count || 0));
}

/**
 * The runs of a preview (or a schedule's next run) up to its end : none after its end_at, at most
 * the runs it has left.
 *
 * Args:
 *   runs (Date[]): the runs, in order.
 *   row (object): { ends, end_at, end_count, run_count }.
 *
 * Returns:
 *   Date[]: the runs before its end.
 */
export function runsBeforeEnd(runs, row) {
  let out = runs;
  if (row?.ends === 'date') {
    const at = momentDate(row.end_at);
    if (at) out = out.filter((d) => d.getTime() <= at.getTime());
  }
  const left = runsLeft(row);
  return left === null ? out : out.slice(0, left);
}

/**
 * What happens to a schedule that reached its end : turned off, or removed as its end_action
 * says. A schedule from a schedules repository is managed by its file : only ever turned off,
 * its row never removed.
 *
 * Args:
 *   row (object): { end_action, repository }.
 *
 * Returns:
 *   string: 'disable' or 'remove'.
 */
export function endActionOf(row) {
  if (row?.repository) return 'disable';
  return row?.end_action === 'remove' ? 'remove' : 'disable';
}

/**
 * What happens to a one-time run after its run : removed (remove_after_run, the default, and
 * always a job a user planned) or turned off and kept with its outcome. A schedule from a
 * schedules repository is managed by its file : only ever turned off (its next pull drops it
 * when its entry says remove_after_run, lib/repoObjects/schedules.js).
 *
 * Args:
 *   row (object): { remove_after_run, owner, repository }.
 *
 * Returns:
 *   string: 'disable' or 'remove'.
 */
export function onceActionOf(row) {
  if (row?.repository) return 'disable';
  if (row?.owner) return 'remove';
  return row?.remove_after_run === undefined || row?.remove_after_run === null || !!Number(row.remove_after_run) ? 'remove' : 'disable';
}

// ===========================================================================
// A SCHEDULES REPOSITORY'S ENTRY
// ===========================================================================

/**
 * The end of a schedule entry of a file (ends, end_at, end_count, end_action, remove_after_run),
 * checked. A one-time entry has no end (ends and its keys are ignored) ; remove_after_run is read
 * on a one-time entry only, true when not said.
 *
 * Args:
 *   obj (object): the entry, as its file gives it.
 *   once (boolean): whether it is timed by a one-time run.
 *
 * Returns:
 *   object: { errors (string[]), end: { ends, endAt (ISO text in UTC, or null), endCount,
 *     endAction, removeAfterRun } }.
 */
export function endOfEntry(obj, once) {
  const errors = [];
  const end = { ends: 'never', endAt: null, endCount: null, endAction: 'disable', removeAfterRun: true };
  if (once) {
    if (given(obj?.remove_after_run)) {
      const v = boolOf(obj.remove_after_run);
      if (v === undefined) errors.push('remove_after_run must be true or false');
      else end.removeAfterRun = v;
    }
    return { errors, end };
  }
  const ends = given(obj?.ends) ? String(obj.ends).trim() : 'never';
  if (!ENDS.includes(ends)) {
    errors.push(`ends must be one of ${ENDS.join(', ')}`);
    return { errors, end };
  }
  end.ends = ends;
  if (given(obj?.end_action)) {
    const action = String(obj.end_action).trim();
    if (!END_ACTIONS.includes(action)) errors.push(`end_action must be one of ${END_ACTIONS.join(', ')}`);
    else end.endAction = action;
  }
  if (ends === 'date') {
    const value = obj?.end_at instanceof Date ? obj.end_at : given(obj?.end_at) ? String(obj.end_at) : '';
    if (!given(value)) errors.push('end_at is required when ends is date');
    else {
      const { when, error } = parseMoment(value, 'end_at');
      if (error) errors.push(error);
      else end.endAt = when.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  } else if (ends === 'count') {
    const n = Number(obj?.end_count);
    if (!given(obj?.end_count) || !Number.isInteger(n) || n < 1) errors.push('end_count must be a whole number of at least 1 when ends is count');
    else end.endCount = n;
  }
  return { errors, end };
}

/**
 * The keys of a schedule entry that write its end, as few as say it : none for one that never
 * ends, ends and its date or number (and end_action when it removes) for one that does ;
 * remove_after_run for a one-time run only when it is false (true when not said).
 *
 * Args:
 *   end (object): { ends, endAt, endCount, endAction, removeAfterRun }.
 *   once (boolean): whether it is timed by a one-time run.
 *
 * Returns:
 *   object: the keys and their values.
 */
export function endEntryKeys(end, once) {
  if (once) return end?.removeAfterRun === false ? { remove_after_run: false } : {};
  if (!end || !end.ends || end.ends === 'never') return {};
  const keys = { ends: end.ends };
  if (end.ends === 'date') keys.end_at = end.endAt;
  if (end.ends === 'count') keys.end_count = Number(end.endCount);
  if (end.endAction === 'remove') keys.end_action = 'remove';
  return keys;
}

/**
 * The end of a schedule as the table keeps it, from what an entry says (endOfEntry).
 *
 * Args:
 *   end (object): { ends, endAt, endCount, endAction, removeAfterRun }.
 *
 * Returns:
 *   object: { ends, end_at, end_count, end_action, remove_after_run }.
 */
export function endColumns(end) {
  return {
    ends: end?.ends || 'never',
    end_at: end?.ends === 'date' ? dbMoment(end.endAt) : null,
    end_count: end?.ends === 'count' ? Number(end.endCount) : null,
    end_action: end?.endAction === 'remove' ? 'remove' : 'disable',
    remove_after_run: end?.removeAfterRun === false ? 0 : 1,
  };
}

/**
 * The end of a schedule as an entry says it, from its row (the reverse of endColumns).
 *
 * Args:
 *   row (object): the schedule.
 *
 * Returns:
 *   object: { ends, endAt, endCount, endAction, removeAfterRun }.
 */
export function endOfRow(row) {
  const ends = ENDS.includes(row?.ends) ? row.ends : 'never';
  const at = momentDate(row?.end_at);
  return {
    ends,
    endAt: ends === 'date' && at ? at.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    endCount: ends === 'count' && given(row?.end_count) ? Number(row.end_count) : null,
    endAction: row?.end_action === 'remove' ? 'remove' : 'disable',
    removeAfterRun: row?.remove_after_run === undefined || row?.remove_after_run === null ? true : !!Number(row.remove_after_run),
  };
}

export default {
  ENDS,
  END_ACTIONS,
  END_FIELDS,
  boolOf,
  endMoment,
  momentDate,
  checkEnd,
  endReached,
  runsLeft,
  runsBeforeEnd,
  endActionOf,
  onceActionOf,
  endOfEntry,
  endEntryKeys,
  endColumns,
  endOfRow,
};
