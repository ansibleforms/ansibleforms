// The days a stored job may stay unused before it is removed (#1437) : the Store dialog and the
// stored job's page. The setting (STORED_JOB_UNUSED_DAYS, /api/v2/app/config) is the most a stored
// job may ask for, and the Store dialog starts at it ; while it is above 0 a stored job must ask
// for some days, at most that many. With the setting 0, any number of days or none. The server
// checks the same (lib/storedJobExpiry.js) ; this says it in the dialog before a save is sent.

/**
 * The setting's days as the dialogs read them : a whole number of at least 1, or 0 for never.
 *
 * Args:
 *   setting (any): the app config's storedJobUnusedDays.
 *
 * Returns:
 *   number: the days, 0 for never.
 */
export function unusedDaysMax(setting) {
  const n = Number(setting);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Why the days typed may not be saved ; null when they may. Empty is allowed only without a
 * setting, as empty would then keep the stored job for ever.
 *
 * Args:
 *   setting (any): the app config's storedJobUnusedDays.
 *   value (any): the field's value (a number, a numeric text or '').
 *
 * Returns:
 *   string|null: 'invalid', 'tooLong' or 'required' ; null when allowed.
 */
export function unusedDaysError(setting, value) {
  const max = unusedDaysMax(setting);
  if (value === null || value === undefined || String(value).trim() === '') return max > 0 ? 'required' : null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 'invalid';
  if (max > 0 && n > max) return 'tooLong';
  return null;
}

/**
 * The days as a save sends them, once allowed (unusedDaysError) : a number, or null for none.
 *
 * Args:
 *   value (any): the field's value.
 *
 * Returns:
 *   number|null: the days, or null.
 */
export function unusedDaysValue(value) {
  return value === null || value === undefined || String(value).trim() === '' ? null : Number(value);
}

/**
 * The warning a refused value shows : the whole numbers allowed, up to the setting's when it has
 * one.
 *
 * Args:
 *   setting (any): the app config's storedJobUnusedDays.
 *   t (function): vue-i18n's t.
 *
 * Returns:
 *   string: the warning.
 */
export function unusedDaysWarning(setting, t) {
  const max = unusedDaysMax(setting);
  return max > 0
    ? t('settings.storedJobs.unusedDaysInvalidMax', { days: max })
    : t('settings.storedJobs.unusedDaysInvalid');
}

// ===========================================================================
// WHEN IT IS REMOVED : ONE CHOICE OF THREE (AppStoredJobRemoval)
// ===========================================================================
// never (only without a setting), on a date (its expires_at ; the setting's days still apply), or
// when unused for some days (its unused_days). The server keeps the two columns as before : a
// choice sends both, the one it leaves out empty.

/**
 * The removal a stored job shows : its days when it has some, else its date, else never - or,
 * with a setting, its days at the setting's (never is not offered then).
 *
 * Args:
 *   record (object): the stored job ({ expires_at, unused_days }), {} for a new one.
 *   setting (any): the app config's storedJobUnusedDays.
 *
 * Returns:
 *   object: { mode ('never', 'date' or 'unused'), expires_at, unused_days }.
 */
export function removalOf(record, setting) {
  const max = unusedDaysMax(setting);
  const own = record?.unused_days;
  if (own !== null && own !== undefined && String(own).trim() !== '')
    return { mode: 'unused', expires_at: '', unused_days: own };
  if (record?.expires_at) return { mode: 'date', expires_at: record.expires_at, unused_days: '' };
  return max > 0
    ? { mode: 'unused', expires_at: '', unused_days: max }
    : { mode: 'never', expires_at: '', unused_days: '' };
}

/**
 * Why a removal may not be saved ; null when it may : a date to pick, or days that are no whole
 * number of at least 1 (at most the setting's).
 *
 * Args:
 *   removal (object): { mode, expires_at, unused_days }.
 *   setting (any): the app config's storedJobUnusedDays.
 *
 * Returns:
 *   string|null: 'dateRequired', 'required', 'invalid' or 'tooLong' ; null when allowed.
 */
export function removalError(removal, setting) {
  if (removal?.mode === 'date') return removal.expires_at ? null : 'dateRequired';
  if (removal?.mode === 'unused') {
    if (String(removal.unused_days ?? '').trim() === '') return 'required';
    return unusedDaysError(setting, removal.unused_days);
  }
  return null;
}

/**
 * The two columns a removal is saved as : the one its choice leaves out empty.
 *
 * Args:
 *   removal (object): { mode, expires_at, unused_days }.
 *
 * Returns:
 *   object: { expires_at, unused_days }, each a value or null.
 */
export function removalPayload(removal) {
  return {
    expires_at: removal?.mode === 'date' ? removal.expires_at || null : null,
    unused_days: removal?.mode === 'unused' ? unusedDaysValue(removal.unused_days) : null,
  };
}
