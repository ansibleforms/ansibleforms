// A schedule of a schedules repository is timed by an iCal rrule, in its own time zone
// (server/src/lib/scheduleRrule.js). This is the early answer the dialog and the schedule page
// give while it is typed - what is refused on the text itself - and the rrule a new schedule
// starts with. The server applies the real check and works out the runs (GET
// /api/v2/schedule/rrule, the preview of BsRrule).

import { ref } from 'vue';
import axios from 'axios';
import { rruleProblem as textProblem } from '@/lib/rruleRules';

// the schedules repository, when there is one : a new recurring schedule goes to it, edited as a
// rrule (read by loadScheduleRepository, on the schedules list)
export const scheduleRepository = ref(null);

/**
 * Reads which repository holds the schedules (none, or one), for the schedules list's dialog.
 *
 * Returns:
 *   Promise<string|null>: its name.
 */
export async function loadScheduleRepository() {
  try {
    const res = await axios.get('/api/v2/schedule/repositories');
    scheduleRepository.value = res.data?.records?.[0]?.name || null;
  } catch {
    scheduleRepository.value = null;
  }
  return scheduleRepository.value;
}

/**
 * Why a rrule is refused, on its text alone : the server's rules and reasons
 * (lib/rruleRules.js), its TZID checked against the zones the browser knows.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   string: the reason, '' when the text passes.
 */
export function rruleProblem(value) {
  return textProblem(value, validZone);
}

/**
 * The message a rrule refused shows, in the app's language, the reason in it.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   value (string): the rrule.
 *
 * Returns:
 *   string: the message, '' when the text passes.
 */
export function rruleValidationMessage(t, value) {
  const reason = rruleProblem(value);
  return reason ? t('settings.schedules.rruleInvalid', { reason }) : '';
}

/**
 * A rrule's time zone : its DTSTART's TZID, UTC for one ending in Z.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   string: the zone, '' when it names none.
 */
export function zoneOf(value) {
  const m = String(value ?? '').match(/DTSTART(?:;TZID=([^:]+))?:\d{8}T\d{6}(Z?)/);
  if (!m) return '';
  return m[1] || (m[2] ? 'UTC' : '');
}

/**
 * Whether the browser knows a time zone.
 *
 * Args:
 *   zone (string): the zone.
 *
 * Returns:
 *   boolean: true when it does.
 */
function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The rrule a new repository schedule starts with : every day at midnight from today, in a zone
 * (the scheduler's).
 *
 * Args:
 *   zone (string): the zone ; UTC when it is none or unknown.
 *   now (Date): today.
 *
 * Returns:
 *   string: the rrule, on one line.
 */
export function defaultRrule(zone = 'UTC', now = new Date()) {
  const tz = zone && validZone(zone) ? zone : 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `DTSTART;TZID=${tz}:${parts.year}${parts.month}${parts.day}T000000 RRULE:FREQ=DAILY;INTERVAL=1`;
}

/**
 * A repository schedule's rrule in the list's Schedule column, as code.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   string: the cell's HTML, escaped.
 */
export function rruleCell(value) {
  const text = String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<span class="font-monospace small">${text}</span>`;
}
