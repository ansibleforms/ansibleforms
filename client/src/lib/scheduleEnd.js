// How a schedule ends, as its page (pages/schedule.vue) and the New schedule wizard
// (config/settings.js) edit it with AppScheduleEnd : a schedule timed by a cron or a rrule ends
// never, on a date (end_at) or after a number of runs (end_count), then is turned off or removed
// (end_action) ; a one-time run only says whether it is removed after its run (remove_after_run).
// The server checks it again (server/src/lib/scheduleEnd.js) ; the runs a preview shows stop at
// it (runsBeforeEnd), as the server's rrule preview does.

// ─── the end of a record ─────────────────────────────────────────────────────

/**
 * The end of a schedule as the page and the wizard edit it.
 *
 * Args:
 *   record (object): the schedule (its columns ends, end_at, end_count, end_action,
 *     remove_after_run), or none for a new one.
 *
 * Returns:
 *   object: { ends, end_at, end_count, end_action, remove_after_run (a boolean) }.
 */
export function endOf(record = {}) {
  const ends = ['never', 'date', 'count'].includes(record?.ends) ? record.ends : 'never';
  return {
    ends,
    end_at: record?.end_at ?? '',
    end_count: record?.end_count ?? '',
    end_action: record?.end_action === 'remove' ? 'remove' : 'disable',
    // removed after its run unless turned off (the default, as before)
    remove_after_run:
      record?.remove_after_run === undefined || record?.remove_after_run === null
        ? true
        : !!Number(record.remove_after_run),
  };
}

/**
 * Why an end may not be saved ; null when it may. A one-time run has none to check.
 *
 * Args:
 *   t (function): the translator.
 *   end (object): the end (endOf).
 *   once (boolean): whether the schedule is timed by a one-time run.
 *
 * Returns:
 *   string|null: the reason, in the app's language.
 */
export function endError(t, end, once) {
  if (once || !end) return null;
  if (end.ends === 'date' && !String(end.end_at ?? '').trim()) return t('settings.schedules.endDateRequired');
  if (end.ends === 'count') {
    const n = Number(end.end_count);
    if (String(end.end_count ?? '').trim() === '' || !Number.isInteger(n) || n < 1)
      return t('settings.schedules.endCountInvalid');
  }
  return null;
}

/**
 * The end as a schedule is saved with it : the fields its kind uses, the others empty ; a
 * one-time run sends only whether it is removed after its run.
 *
 * Args:
 *   end (object): the end (endOf).
 *   once (boolean): whether the schedule is timed by a one-time run.
 *
 * Returns:
 *   object: { ends, end_at, end_count, end_action } or { remove_after_run (1 or 0) }.
 */
export function endPayload(end, once) {
  if (once) return { remove_after_run: end?.remove_after_run === false ? 0 : 1 };
  const ends = end?.ends || 'never';
  return {
    ends,
    end_at: ends === 'date' ? end.end_at || null : null,
    end_count: ends === 'count' ? Number(end.end_count) : null,
    end_action: end?.end_action === 'remove' ? 'remove' : 'disable',
  };
}

// ─── its runs ────────────────────────────────────────────────────────────────

/**
 * The runs of a preview up to a schedule's end : none after its date, at most its runs left
 * (end_count less the jobs it started).
 *
 * Args:
 *   runs (Date[]): the runs, in order.
 *   end (object|null): { ends, end_at, end_count } ; none : every run.
 *   runCount (number): the jobs it started already.
 *
 * Returns:
 *   Date[]: the runs before its end.
 */
export function runsBeforeEnd(runs, end, runCount = 0) {
  if (!end) return runs;
  let out = runs;
  if (end.ends === 'date' && end.end_at) {
    const at = new Date(end.end_at).getTime();
    if (!isNaN(at)) out = out.filter((d) => d.getTime() <= at);
  }
  if (end.ends === 'count') {
    const n = Number(end.end_count);
    if (Number.isInteger(n) && n >= 1) out = out.slice(0, Math.max(0, n - Number(runCount || 0)));
  }
  return out;
}
