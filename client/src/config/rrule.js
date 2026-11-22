// A schedule may be timed by an iCal rrule, in its own time zone (server/src/lib/scheduleRrule.js),
// wherever it is kept : in the app or in a schedules repository. This is the early answer the
// dialog and the schedule page give while it is typed - what is refused on the text itself - and
// the rrule a schedule given one starts with. The server applies the real check and works out the
// runs (GET /api/v2/schedule/rrule, the preview of BsRrule).

import { rruleProblem as textProblem } from '@/lib/rruleRules';

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

// the days of an rrule, as a cron numbers them (0 is Sunday)
const CRON_DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// the parts of an rrule a cron can say : any other (BYWEEKNO, BYYEARDAY ...) keeps the rule as text
const SAID = new Set([
  'FREQ',
  'INTERVAL',
  'BYMINUTE',
  'BYHOUR',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'BYSECOND',
  'WKST',
  'COUNT',
  'UNTIL',
]);

/**
 * The cron that runs at the same times as an rrule, for its words (describeCron) : only when a
 * cron says exactly the same thing. An interval a cron cannot count (every 2 weeks, every 3 days
 * across months) gives none, and the rule stays as it is. Its end (COUNT, UNTIL) is the
 * schedule's end, said apart ; its time zone is in the rule shown on hover.
 *
 * Args:
 *   value (string): the rrule, with its DTSTART.
 *
 * Returns:
 *   string|null: the cron ; null when no cron says the same.
 */
export function rruleToCron(value) {
  const tokens = String(value ?? '')
    .trim()
    .split(/\s+/);
  const rule = tokens.find((x) => /^RRULE:/i.test(x));
  if (!rule) return null;
  const parts = {};
  for (const pair of rule.slice(6).split(';')) {
    const [k, v] = pair.split('=');
    if (!k || v === undefined) return null;
    parts[k.toUpperCase()] = v.toUpperCase();
  }
  if (Object.keys(parts).some((k) => !SAID.has(k))) return null;
  if (parts.BYSECOND && parts.BYSECOND !== '0') return null;
  // step 1 : its start, the time and day a part it leaves out takes
  const start = (tokens.find((x) => /^DTSTART/i.test(x)) || '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  const date = start ? { y: +start[1], m: +start[2], d: +start[3], h: +(start[4] || 0), min: +(start[5] || 0) } : null;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  const list = (v) => (v ? v.split(',') : null);
  const numbers = (v) => (list(v) || []).every((x) => /^\d+$/.test(x));
  if (![parts.BYMINUTE, parts.BYHOUR, parts.BYMONTH].every((v) => !v || numbers(v))) return null;
  const minute = parts.BYMINUTE || (date ? String(date.min) : null);
  const hour = parts.BYHOUR || (date ? String(date.h) : null);
  const month = parts.BYMONTH || '*';
  // the days without a position (MO,WE) as a cron's ; null with a position (2MO, -1FR)
  const plainDays = (v) => {
    const days = list(v);
    if (!days || !days.every((x) => x in CRON_DAY)) return null;
    return days.map((x) => CRON_DAY[x]).join(',');
  };
  const monthDays = parts.BYMONTHDAY
    ? numbers(parts.BYMONTHDAY)
      ? parts.BYMONTHDAY
      : parts.BYMONTHDAY === '-1'
        ? 'L'
        : null
    : '*';
  if (monthDays === null) return null;
  // step 2 : by its frequency
  switch (parts.FREQ) {
    case 'MINUTELY': {
      // every n minutes : the same as a cron when n divides the hour, from a start on its step
      if (parts.BYMINUTE || parts.BYHOUR || parts.BYDAY || parts.BYMONTHDAY || parts.BYMONTH || parts.BYSETPOS)
        return null;
      if (interval === 1) return '* * * * *';
      if (60 % interval || (date && date.min % interval)) return null;
      return `*/${interval} * * * *`;
    }
    case 'HOURLY': {
      if (parts.BYHOUR || parts.BYDAY || parts.BYMONTHDAY || parts.BYMONTH || parts.BYSETPOS || minute === null)
        return null;
      if (interval === 1) return `${minute} * * * *`;
      if (24 % interval || (date && date.h % interval)) return null;
      return `${minute} */${interval} * * *`;
    }
    case 'DAILY': {
      if (interval !== 1 || parts.BYSETPOS || minute === null || hour === null) return null;
      const days = parts.BYDAY ? plainDays(parts.BYDAY) : '*';
      if (days === null) return null;
      return `${minute} ${hour} ${monthDays} ${month} ${days}`;
    }
    case 'WEEKLY': {
      if (interval !== 1 || parts.BYSETPOS || parts.BYMONTHDAY || minute === null || hour === null) return null;
      const days = parts.BYDAY
        ? plainDays(parts.BYDAY)
        : date
          ? String(new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay())
          : null;
      if (days === null) return null;
      return `${minute} ${hour} * ${month} ${days}`;
    }
    case 'MONTHLY': {
      if (interval !== 1 || minute === null || hour === null) return null;
      const at = (dom, dow) => `${minute} ${hour} ${dom} ${month} ${dow}`;
      if (parts.BYDAY) {
        if (parts.BYMONTHDAY) return null;
        const days = list(parts.BYDAY);
        const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR'];
        // the last or first weekday of the month (BYDAY=MO..FR;BYSETPOS=-1 or 1)
        if (parts.BYSETPOS && days.length === 5 && weekdays.every((x) => days.includes(x))) {
          if (parts.BYSETPOS === '-1') return at('LW', '*');
          if (parts.BYSETPOS === '1') return at('1W', '*');
          return null;
        }
        // one day at a position : 2MO, -1FR, or MO with BYSETPOS=2
        if (days.length !== 1) return null;
        const m = days[0].match(/^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/);
        if (!m) return null;
        const pos = m[1] ?? parts.BYSETPOS;
        if (!pos) return null;
        const n = Number(pos);
        if (n === -1) return at('*', `${CRON_DAY[m[2]]}L`);
        if (n >= 1 && n <= 5) return at('*', `${CRON_DAY[m[2]]}#${n}`);
        return null;
      }
      if (parts.BYSETPOS) return null;
      const dom = parts.BYMONTHDAY ? monthDays : date ? String(date.d) : null;
      return dom === null ? null : at(dom, '*');
    }
    case 'YEARLY': {
      if (interval !== 1 || parts.BYDAY || parts.BYSETPOS || minute === null || hour === null) return null;
      const dom = parts.BYMONTHDAY ? monthDays : date ? String(date.d) : null;
      const months = parts.BYMONTH || (date ? String(date.m) : null);
      if (dom === null || months === null) return null;
      return `${minute} ${hour} ${dom} ${months} *`;
    }
    default:
      return null;
  }
}
