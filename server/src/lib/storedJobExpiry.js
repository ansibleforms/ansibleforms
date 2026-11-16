'use strict';
// When a stored job nobody uses is removed (#1437).
//
// The setting STORED_JOB_UNUSED_DAYS (Settings > Environment > Retention) removes the stored
// jobs no job was launched from for that many days, counted from their last use
// (stored_jobs.last_used_at), or from when they were stored for one never used. 0, the default,
// never removes one for that : nothing changes on an upgrade.
//
// A stored job may carry its own number of days (stored_jobs.unused_days) : shorter than the
// setting, never longer, any number without a setting. None (NULL) follows the setting, which
// still removes it : a stored job removed on a date of its own keeps no days of its own. The days that count are
// the shorter of the two, a 0 or NULL of either left aside : a setting lowered later shortens
// what a stored job asked for, never the other way round.
//
// The stored job's own expiry date (expires_at) keeps working : the daily cleanup
// (services/cron.service.js) removes it at whichever comes first.

// ─── the days that count ─────────────────────────────────────────────────────

/**
 * The days of the setting as the cleanup reads them : a whole number of at least 1, or 0 for
 * never (anything else, a negative number included).
 *
 * Args:
 *   setting (any): appConfig.storedJobUnusedDays.
 *
 * Returns:
 *   number: the days, 0 for never.
 */
export function settingDays(setting) {
  const n = Number(setting);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The days a stored job may stay unused before it is removed : the shorter of the setting and
 * its own, either left aside when it is 0 or none.
 *
 * Args:
 *   setting (any): the setting's days (0 for never).
 *   own (any): the stored job's unused_days (null to follow the setting).
 *
 * Returns:
 *   number|null: the days, null when it is never removed for being unused.
 */
export function effectiveUnusedDays(setting, own) {
  const days = [settingDays(setting), settingDays(own)].filter((n) => n > 0);
  return days.length ? Math.min(...days) : null;
}

// ─── what a user may ask for ─────────────────────────────────────────────────

/**
 * Why a stored job may not get these days of its own ; null when it may. Nothing given
 * (undefined) leaves them as they are. A whole number of at least 1, at most the setting's ;
 * none (null or '') follows the setting.
 *
 * Args:
 *   setting (any): the setting's days (0 for never).
 *   value (any): the days asked for (a number, a numeric text, null or '').
 *
 * Returns:
 *   string|null: 'invalid' or 'tooLong' ; null when allowed.
 */
export function unusedDaysRefusal(setting, value) {
  if (value === undefined) return null;
  const max = settingDays(setting);
  // none : the setting's days, which still remove it
  if (value === null || value === '') return null;
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(n) || n < 1) return 'invalid';
  if (max > 0 && n > max) return 'tooLong';
  return null;
}

/**
 * The days as the column stores them, once allowed (unusedDaysRefusal) : a number, or null for
 * none. Nothing given stays nothing (undefined), so an update leaves the column alone.
 *
 * Args:
 *   value (any): the days asked for.
 *
 * Returns:
 *   number|null|undefined: the column's value.
 */
export function unusedDaysValue(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return Number(value);
}

// ─── the cleanup ─────────────────────────────────────────────────────────────

/**
 * The query of the daily cleanup : the stored jobs past their expiry date, and those unused for
 * longer than their days (effectiveUnusedDays, computed by the database row by row), counted
 * from their last use or, never used, from when they were stored. A stored job with no days
 * (the setting 0 and none of its own) is never removed for being unused : its interval is NULL,
 * and so is the comparison.
 *
 * Args:
 *   setting (any): the setting's days (0 for never).
 *
 * Returns:
 *   object: { sql, params } for mysql.do.
 */
export function cleanupQuery(setting) {
  const days = settingDays(setting);
  const sql =
    'DELETE FROM AnsibleForms.stored_jobs'
    + ' WHERE (expires_at IS NOT NULL AND expires_at < NOW())'
    + ' OR COALESCE(last_used_at, created_at) < NOW() - INTERVAL (CASE'
    + ' WHEN ? > 0 AND unused_days > 0 THEN LEAST(?, unused_days)'
    + ' WHEN ? > 0 THEN ?'
    + ' WHEN unused_days > 0 THEN unused_days'
    + ' END) DAY';
  return { sql, params: [days, days, days, days] };
}
