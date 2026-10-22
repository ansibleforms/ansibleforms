// Why a schedule's iCal rrule is refused, worked out on its text alone : the early answer the
// rrule editor (BsRrule) and the schedule dialogs give while it is typed. The same rules, in the
// same order and with the same reasons, as the server's check (server/src/lib/scheduleRrule.js
// validateRrule) - whatever the case of the keys or the sign of a number - which
// server/tests/schedule-rrule-client.test.mjs holds them to. What only the server can say (a rule
// that never fires, its next runs) comes from its preview.
//
// No import : the server's test reads this file as it is.

// the most runs a COUNT may ask for
const MAX_COUNT = 999;

// the frequencies a rule may name (SECONDLY is named, then refused)
const FREQS = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'];

// the parts a rule may have
const PARTS = [
  'FREQ',
  'DTSTART',
  'INTERVAL',
  'WKST',
  'COUNT',
  'UNTIL',
  'TZID',
  'BYSETPOS',
  'BYMONTH',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYWEEKDAY',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
  'BYSECOND',
  'BYEASTER',
];

// the weekdays a BYDAY names
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// the parts that hold whole numbers, and their range : from min to max, or (signed) from 1 to max
// and from -max to -1
const NUMBER_PARTS = {
  BYSECOND: { min: 0, max: 59 },
  BYMINUTE: { min: 0, max: 59 },
  BYHOUR: { min: 0, max: 23 },
  BYMONTH: { min: 1, max: 12 },
  BYMONTHDAY: { max: 31, signed: true },
  BYYEARDAY: { max: 366, signed: true },
  BYWEEKNO: { max: 53, signed: true },
  BYSETPOS: { max: 366, signed: true },
  BYEASTER: { min: -366, max: 366 },
};

/**
 * A number of a rule's part as the server reads it : an integer, a sign allowed ; NaN when it is
 * none (1.5, abc).
 *
 * Args:
 *   text (string): the part's value.
 *
 * Returns:
 *   number: the number, NaN when it is none.
 */
function numberOf(text) {
  return /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
}

/**
 * Why one rule (RRULE or EXRULE) is refused once it is read, in the order the server finds it :
 * an UNTIL that is no date and time, a FREQ that does not exist, a part that is not a rule's, a
 * weekday with a number that is not one, a BYxxx out of its range or a WKST that is no weekday, no FREQ, an INTERVAL under 1, SECONDLY, COUNT with UNTIL,
 * a COUNT under 1 or above 999, a weekday that is not one, BYDAY with a number.
 *
 * Args:
 *   kind (string): RRULE or EXRULE.
 *   text (string): the rule's parts (FREQ=DAILY;INTERVAL=1).
 *
 * Returns:
 *   string: the reason, '' when it passes.
 */
function ruleProblem(kind, text) {
  const failed = (why) => `rrule parsing failed validation: ${why}`;
  const label = `${kind}:${text}`;
  const parts = text
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf('=');
      return { part, key: (at < 0 ? part : part.slice(0, at)).toUpperCase(), value: at < 0 ? '' : part.slice(at + 1) };
    });
  const values = Object.fromEntries(parts.map((p) => [p.key, p.value]));
  // step 1 : an UNTIL is a date with a time
  const until = parts.find((p) => p.key === 'UNTIL');
  if (until && !/^\d{8}T\d{6}Z?$/i.test(until.value)) {
    return failed(`UNTIL must be a date and a time (YYYYMMDDTHHMMSS): ${until.part}`);
  }
  // step 2 : a FREQ that does not exist
  if (values.FREQ !== undefined && !FREQS.includes(values.FREQ.toUpperCase()))
    return failed(`invalid 'FREQ': ${values.FREQ}`);
  // step 3 : read part by part, a part that is not a rule's, a weekday with a number not one, a
  // BYxxx that is not whole numbers in its range, a WKST that is no weekday
  for (const { part, key, value } of parts) {
    if (key === 'UNTIL') continue;
    if (!PARTS.includes(key)) return failed(`Unknown RRULE property '${key}'`);
    if (key === 'BYDAY' || key === 'BYWEEKDAY') {
      const bad = value.split(',').find((d) => d === '' || (/\d/.test(d) && !/^[+-]?\d{1,2}[A-Z]{2}$/.test(d)));
      if (bad !== undefined) return failed(`Invalid weekday string: ${bad}`);
    }
    const range = NUMBER_PARTS[key];
    if (range) {
      const fits = (n) => (range.signed ? n !== 0 && Math.abs(n) <= range.max : n >= range.min && n <= range.max);
      if (!value.split(',').every((v) => /^[+-]?\d+$/.test(v) && fits(Number(v)))) {
        return failed(
          range.signed
            ? `${key} must be whole numbers from 1 to ${range.max} or from -${range.max} to -1: ${part}`
            : `${key} must be whole numbers from ${range.min} to ${range.max}: ${part}`,
        );
      }
    }
    if (key === 'WKST' && !WEEKDAYS.includes(value.toUpperCase())) return failed(`invalid 'WKST': ${value}`);
  }
  if (values.FREQ === undefined) return failed('a rule needs a FREQ');
  // step 4 : what was read
  if (values.INTERVAL !== undefined) {
    const interval = numberOf(values.INTERVAL);
    if (!(Number.isInteger(interval) && interval >= 1)) return `INTERVAL must be a positive integer: ${label}`;
  }
  if (values.FREQ.toUpperCase() === 'SECONDLY') return `SECONDLY is not supported: ${label}`;
  if (values.COUNT !== undefined) {
    if (until) return `RRULE may not contain both COUNT and UNTIL: ${label}`;
    const count = numberOf(values.COUNT);
    if (!Number.isInteger(count) || count < 1) return `COUNT must be a positive integer: ${label}`;
    if (count > MAX_COUNT) return `COUNT > 999 is unsupported: ${label}`;
  }
  const byday = parts.find((p) => p.key === 'BYDAY' || p.key === 'BYWEEKDAY');
  if (byday) {
    const days = byday.value.split(',');
    // a weekday not known (mo, in lower case) : named, as the server names it
    if (days.some((d) => !WEEKDAYS.includes(d) && !/\d/.test(d)))
      return failed(`Invalid weekday string: ${byday.value}`);
    if (days.some((d) => !WEEKDAYS.includes(d))) return `BYDAY with numeric prefix not supported: ${label}`;
  }
  return '';
}

/**
 * Why a rrule is refused, on its text alone : no DTSTART, a naive one, several, no RRULE, an
 * EXDATE or an RDATE, a rule without INTERVAL or with INTERVAL under 1, SECONDLY, BYDAY with a
 * numeric prefix, COUNT with UNTIL, a COUNT under 1 or above 999, a part that is not a rule's, a
 * BYxxx number out of its range (BYSETPOS=0), a WKST that is no weekday, a TZID that is no time
 * zone - the server's reasons, in its order.
 *
 * Args:
 *   value (string): the rrule.
 *   validZone (function): (zone) => true when the zone exists ; every zone when none is given.
 *
 * Returns:
 *   string: the reason, '' when the text passes.
 */
export function rruleProblem(value, validZone = () => true) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // step 1 : what is checked on the text ; EXDATE and RDATE end the check at once
  const errors = [];
  const dtstarts = text.match(/DTSTART(;[^:]+)?:[0-9]+T[0-9]+Z?/g) || [];
  if (!dtstarts.length)
    errors.push('Valid DTSTART required in rrule. Value should start with: DTSTART:YYYYMMDDTHHMMSSZ');
  if (/DTSTART:[0-9]+T[0-9]+ /.test(text))
    errors.push('DTSTART cannot be a naive datetime.  Specify ;TZINFO= or YYYYMMDDTHHMMSSZZ.');
  if (dtstarts.length > 1) errors.push('Multiple DTSTART is not supported.');
  if (!/rrule:/i.test(text)) errors.push('One or more rule required in rrule.');
  if (/exdate:/i.test(text)) return 'EXDATE not allowed in rrule.';
  if (/rdate:/i.test(text)) return 'RDATE not allowed in rrule.';
  for (const rule of text.match(/RULE:[^\s]*/g) || []) {
    if (!/interval/i.test(rule)) {
      errors.push(`INTERVAL required in rrule: ${rule}`);
    } else {
      const interval = rule.match(/INTERVAL=([0-9]+)/);
      if (interval && Number(interval[1]) < 1) errors.push(`INTERVAL must be a positive integer: ${rule}`);
    }
    if (/secondly/i.test(rule)) errors.push(`SECONDLY is not supported: ${rule}`);
    if (/BYDAY[:=][0-9]+[a-zA-Z]{2}/.test(rule)) errors.push(`BYDAY with numeric prefix not supported: ${rule}`);
    if (rule.includes('COUNT') && rule.includes('UNTIL'))
      errors.push(`RRULE may not contain both COUNT and UNTIL: ${rule}`);
    const count = rule.match(/COUNT=([0-9]+)/);
    if (count && Number(count[1]) > MAX_COUNT) errors.push(`COUNT > 999 is unsupported: ${rule}`);
  }
  if (errors.length) return errors[0];
  // step 2 : what reading it says, part by part, as the server reads it
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const dt = token.match(/^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z?)$/i);
    if (dt) {
      if (dt[1] && dt[3]) return `rrule parsing failed validation: a DTSTART with a TZID cannot end in Z: ${token}`;
      if (!dt[1] && !dt[3]) return `A valid TZID must be provided (e.g., America/New_York). Invalid: ['${token}']`;
      if (dt[1] && !validZone(dt[1]))
        return `A valid TZID must be provided (e.g., America/New_York). Invalid: ['${token}']`;
      continue;
    }
    const rule = token.match(/^(RRULE|EXRULE):(.*)$/i);
    if (!rule) return `rrule parsing failed validation: unsupported property: ${token}`;
  }
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const rule = token.match(/^(RRULE|EXRULE):(.*)$/i);
    const problem = rule ? ruleProblem(rule[1].toUpperCase(), rule[2]) : '';
    if (problem) return problem;
  }
  return '';
}
