// A schedule of a schedules repository is timed by an iCal rrule, in its own time zone
// (server/src/lib/scheduleRrule.js). This is the early answer the dialog and the schedule page
// give while it is typed - what is refused on the text itself - and the rrule a new schedule
// starts with. The server applies the real check and works out the runs (GET
// /api/v2/schedule/rrule, the preview of BsRrule).

import { ref } from 'vue';
import axios from 'axios';

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
 * Why a rrule is refused, on its text alone : no DTSTART, a naive one, several, no RRULE, an
 * EXDATE or an RDATE, a rule without INTERVAL or with INTERVAL under 1, SECONDLY, BYDAY with a
 * numeric prefix, COUNT with UNTIL, COUNT above 999, a TZID that is no time zone.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   string: the reason, '' when the text passes.
 */
export function rruleProblem(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const dtstarts = text.match(/DTSTART(;[^:]+)?:[0-9]+T[0-9]+Z?/g) || [];
  if (!dtstarts.length) return 'Valid DTSTART required in rrule. Value should start with: DTSTART:YYYYMMDDTHHMMSSZ';
  if (/DTSTART:[0-9]+T[0-9]+(\s|$)/.test(text))
    return 'DTSTART cannot be a naive datetime. Specify ;TZID= or end it in Z.';
  if (dtstarts.length > 1) return 'Multiple DTSTART is not supported.';
  if (!/rrule:/i.test(text)) return 'One or more rule required in rrule.';
  if (/exdate:/i.test(text)) return 'EXDATE not allowed in rrule.';
  if (/rdate:/i.test(text)) return 'RDATE not allowed in rrule.';
  for (const rule of text.match(/RULE:[^\s]*/g) || []) {
    if (!/interval/i.test(rule)) return `INTERVAL required in rrule: ${rule}`;
    const interval = rule.match(/INTERVAL=([0-9]+)/);
    if (interval && Number(interval[1]) < 1) return `INTERVAL must be a positive integer: ${rule}`;
    if (/secondly/i.test(rule)) return `SECONDLY is not supported: ${rule}`;
    if (/BYDAY[:=][0-9]+[a-zA-Z]{2}/.test(rule)) return `BYDAY with numeric prefix not supported: ${rule}`;
    if (rule.includes('COUNT') && rule.includes('UNTIL')) return `RRULE may not contain both COUNT and UNTIL: ${rule}`;
    const count = rule.match(/COUNT=([0-9]+)/);
    if (count && Number(count[1]) > 999) return `COUNT > 999 is unsupported: ${rule}`;
  }
  const zone = zoneOf(text);
  if (zone && !validZone(zone)) return `A valid TZID must be provided (e.g., America/New_York). Invalid: ${zone}`;
  return '';
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
