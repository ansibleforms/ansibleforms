// The recurrence rules a schedule of a schedules repository is timed by : an iCal rrule (DTSTART
// with its TZID, RRULE, EXRULE), refused where it is not a valid schedule rrule, its runs worked
// out in its own time zone. Pure : lib/scheduleFiles.js reads them from the files,
// models/schedule.model.js and services/cron.service.js time the schedules by them.
//
// The rules :
//   a rrule needs one DTSTART, with a TZID or in UTC (ending in Z), and at least one RRULE ;
//     EXRULE takes runs out, EXDATE and RDATE are refused ; each rule needs an INTERVAL of 1 or
//     more, no SECONDLY, no BYDAY with a number (5MO), not COUNT and UNTIL together, COUNT 999
//     at most ; each BYxxx number in its range (BYHOUR 0 to 23, BYSETPOS 1 to 366 or -366 to
//     -1 ...), WKST a weekday
//   a naive UNTIL is read in the DTSTART's zone, one ending in Z is the UTC moment it names
//   a rule needs a run in the 50 years after its DTSTART : one that never fires is refused
//   every rule is walked from now, never from a DTSTART of years ago : from the period (the
//     year, month, week, day, hour or minute) now is in
//   every rule is walked here, period by period (its days kept by their BYMONTH, BYMONTHDAY,
//     BYYEARDAY, BYWEEKNO, BYDAY and BYEASTER, its times by its BYHOUR, BYMINUTE and BYSECOND,
//     BYSETPOS picking among the runs of each period, as dateutil does) : rrule.js loses its way
//     in one whose days are filtered and whose hours are too (Monday to Friday, 9 to 17), takes
//     the first run for a BYSETPOS counted from the end past the runs a period has (BYSETPOS=-5
//     of four Saturdays) and keeps a BYEASTER in periods its INTERVAL never reaches
//   a rule whose times or days can never meet (FREQ=HOURLY;INTERVAL=2;BYHOUR=1 from midnight,
//     BYMONTH=2;BYMONTHDAY=30) is seen at once as one that never fires
//   its runs are looked for in growing windows up to 50 years ahead, in a thread of their own
//     (lib/scheduleRruleWorker.js) given one second at most : no rule blocks the process. One
//     that takes longer is given up for a minute, never refused for it
//   a time a DST change skips runs when the clock reaches it (02:30 on the night the clock goes
//     from 02:00 to 03:00 runs at 03:30, as a cron does), a time the clock shows twice runs at
//     the first
//   a preview shows the next ten runs
//
// rrule.js is a port of python-dateutil's rrule : it reads the rule, and keeps the days of a year
// a rule's BYxxx parts name (dayRuleOf). The rule is walked in the zone's wall clock (a
// "floating" time), and luxon turns each run into the moment it is in that zone.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import rrulePkg from "rrule";
import { DateTime } from "luxon";

const { RRule } = rrulePkg;

// the most runs a COUNT may ask for
const MAX_COUNT = 999;

// how far ahead runs are looked for : a rule with no run in it has none (a rule that never fires
// is refused)
export const HORIZON_YEARS = 50;
const HORIZON_MS = HORIZON_YEARS * 366 * 86400000;

// the first window runs are looked for in, doubled while it holds none
const FIRST_WINDOW_MS = 3600000;

// a minute, an hour and a day of the floating time (which has no DST)
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// once enough runs are found, the window after them is looked at this far still : a time a DST
// change skips, moved forward, may come after a run found later
const SHIFT_MS = 3 * HOUR;

// the time the runs of one call may take in their thread, the time its start may take, how long a
// rrule whose runs took longer is given up (each walk would cost the time again), and how many such
// rrules are remembered at most : tests change them
export const limits = { walkMs: 1000, startMs: 10000, givenUpMs: 60000, maxGivenUp: 200 };

// the code of the error a call that took too long throws : the rule is not refused for it
export const TIMEOUT = "RRULE_TIMEOUT";

// the weekdays, as rrule.js numbers them (Monday 0)
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

// the parts a rule may have
const PARTS = [
  "FREQ",
  "DTSTART",
  "INTERVAL",
  "WKST",
  "COUNT",
  "UNTIL",
  "TZID",
  "BYSETPOS",
  "BYMONTH",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYWEEKDAY",
  "BYDAY",
  "BYHOUR",
  "BYMINUTE",
  "BYSECOND",
  "BYEASTER",
];

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

// ===========================================================================
// RRULE : CHECKED
// ===========================================================================

/**
 * Why a rrule is refused on its text and once read (steps 1 and 2 of validateRrule) : what is left
 * is whether it ever fires.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   object: { errors (string[]), text (the rrule trimmed) }.
 */
function readErrors(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { errors: ["This field may not be blank."], text };
  // step 1 : what is checked on the text ; EXDATE and RDATE end the check at once, said on
  // their own
  const errors = [];
  const dtstarts = text.match(/DTSTART(;[^:]+)?:[0-9]+T[0-9]+Z?/g) || [];
  if (!dtstarts.length) errors.push("Valid DTSTART required in rrule. Value should start with: DTSTART:YYYYMMDDTHHMMSSZ");
  if (/DTSTART:[0-9]+T[0-9]+ /.test(text)) errors.push("DTSTART cannot be a naive datetime.  Specify ;TZINFO= or YYYYMMDDTHHMMSSZZ.");
  if (dtstarts.length > 1) errors.push("Multiple DTSTART is not supported.");
  if (!/rrule:/i.test(text)) errors.push("One or more rule required in rrule.");
  if (/exdate:/i.test(text)) return { errors: ["EXDATE not allowed in rrule."], text };
  if (/rdate:/i.test(text)) return { errors: ["RDATE not allowed in rrule."], text };
  for (const rule of text.match(/RULE:[^\s]*/g) || []) {
    if (!/interval/i.test(rule)) {
      errors.push(`INTERVAL required in rrule: ${rule}`);
    } else {
      const interval = rule.match(/INTERVAL=([0-9]+)/);
      if (interval && Number(interval[1]) < 1) errors.push(`INTERVAL must be a positive integer: ${rule}`);
    }
    if (/secondly/i.test(rule)) errors.push(`SECONDLY is not supported: ${rule}`);
    if (/BYDAY[:=][0-9]+[a-zA-Z]{2}/.test(rule)) errors.push(`BYDAY with numeric prefix not supported: ${rule}`);
    if (rule.includes("COUNT") && rule.includes("UNTIL")) errors.push(`RRULE may not contain both COUNT and UNTIL: ${rule}`);
    const count = rule.match(/COUNT=([0-9]+)/);
    if (count && Number(count[1]) > MAX_COUNT) errors.push(`COUNT > 999 is unsupported: ${rule}`);
  }
  // step 2 : what parsing it says (a TZID that is no zone, a FREQ that does not exist ...), when
  // the text itself passed : its reasons are not said twice
  if (errors.length) return { errors, text };
  try {
    compileRrule(text);
  } catch (e) {
    errors.push(e.message);
  }
  return { errors, text };
}

/**
 * Why a rrule is refused : no DTSTART, a naive one (neither a TZID nor a Z), more than one, no RRULE,
 * an EXDATE or an RDATE, a rule without INTERVAL or with INTERVAL under 1, SECONDLY, BYDAY with a
 * numeric prefix (20MO), COUNT and UNTIL together, COUNT above 999, a BYxxx number out of its range,
 * a TZID that is no time zone, whatever does not parse, and a rule with no run in the HORIZON_YEARS
 * after its DTSTART. A rule whose runs could not be worked out in time is not refused for it.
 *
 * Args:
 *   value (string): the rrule, written on one line (DTSTART;TZID=Europe/Brussels:
 *     20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1).
 *
 * Returns:
 *   string[]: the reasons it is refused ; empty when it is valid.
 */
export function validateRrule(value) {
  const { errors, text } = readErrors(value);
  if (errors.length) return errors;
  // step 3 : it fires - a run in the years after its DTSTART (its runs may all be past : one that
  // ended is still a valid rule)
  try {
    if (!nextRuns(text, { fromStart: true }).length) errors.push(neverFires());
  } catch (e) {
    if (e.code !== TIMEOUT) errors.push(e.message);
  }
  return errors;
}

/**
 * validateRrule, its runs worked out without waiting in the process (a preview, an app's save).
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   Promise<string[]>: the reasons it is refused ; empty when it is valid.
 */
export async function validateRruleAsync(value) {
  const { errors, text } = readErrors(value);
  if (errors.length) return errors;
  try {
    if (!(await nextRunsAsync(text, { fromStart: true })).length) errors.push(neverFires());
  } catch (e) {
    if (e.code !== TIMEOUT) errors.push(e.message);
  }
  return errors;
}

// the reason a rule that never fires is refused
const neverFires = () => `This rrule never fires in the ${HORIZON_YEARS} years after its DTSTART.`;

/**
 * A rrule read into what its runs are worked out from : its zone, its start and its rules in
 * that zone's wall clock (a "floating" time : the wall clock's fields as if they were UTC), as
 * dateutil walks a rule whose DTSTART has a TZID - a daily 02:00 stays at 02:00 across a DST
 * change.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   object: { zone, start (floating ms), rules: [{ kind: 'rrule'|'exrule', options }] }.
 *
 * Raises:
 *   Error: it does not parse (the message starts with "rrule parsing failed validation"),
 *     or its TZID is no time zone ("A valid TZID must be provided").
 */
export function compileRrule(value) {
  const fail = (why) => new Error(`rrule parsing failed validation: ${why}`);
  const tokens = String(value || "").trim().split(/\s+/).filter(Boolean);
  let zone = null;
  let start = null;
  const rules = [];
  for (const token of tokens) {
    // DTSTART;TZID=<zone>:YYYYMMDDTHHMMSS, or DTSTART:YYYYMMDDTHHMMSSZ (UTC)
    const dt = token.match(/^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})(Z?)$/i);
    if (dt) {
      if (start !== null) throw fail("Multiple DTSTART is not supported");
      const [, tzid, stamp, utc] = dt;
      // a TZID with a Z : dateutil refuses it
      if (tzid && utc) throw fail(`a DTSTART with a TZID cannot end in Z: ${token}`);
      if (!tzid && !utc) throw new Error(`A valid TZID must be provided (e.g., America/New_York). Invalid: ['${token}']`);
      zone = tzid || "UTC";
      if (!DateTime.local().setZone(zone).isValid) {
        throw new Error(`A valid TZID must be provided (e.g., America/New_York). Invalid: ['${token}']`);
      }
      start = floatingOfStamp(stamp);
      if (Number.isNaN(start)) throw fail(`invalid DTSTART: ${token}`);
      continue;
    }
    const rule = token.match(/^(RRULE|EXRULE):(.*)$/i);
    if (rule) {
      rules.push({ kind: rule[1].toUpperCase() === "RRULE" ? "rrule" : "exrule", text: rule[2] });
      continue;
    }
    throw fail(`unsupported property: ${token}`);
  }
  if (start === null) throw fail("A DTSTART field needs to be in the rrule");
  if (!rules.some((r) => r.kind === "rrule")) throw fail("One or more rule required in rrule");
  return {
    zone,
    start,
    rules: rules.map((r) => ({ kind: r.kind, options: ruleOptions(r.text, zone, fail, `${r.kind.toUpperCase()}:${r.text}`) })),
  };
}

/**
 * Why a part of a rule is refused before rrule.js reads it : a part that is not a rule's, a
 * weekday with a number that is not one, a BYxxx that is not whole numbers in its range, a WKST
 * that is no weekday.
 *
 * Args:
 *   part (string): the part (BYHOUR=9,10).
 *
 * Returns:
 *   string: the reason, '' when it passes.
 */
function partProblem(part) {
  const at = part.indexOf("=");
  const key = (at < 0 ? part : part.slice(0, at)).toUpperCase();
  const value = at < 0 ? "" : part.slice(at + 1);
  if (!PARTS.includes(key)) return `Unknown RRULE property '${key}'`;
  if (key === "BYDAY" || key === "BYWEEKDAY") {
    const bad = value.split(",").find((d) => d === "" || (/\d/.test(d) && !/^[+-]?\d{1,2}[A-Z]{2}$/.test(d)));
    if (bad !== undefined) return `Invalid weekday string: ${bad}`;
  }
  const range = NUMBER_PARTS[key];
  if (range) {
    const fits = (n) => (range.signed ? n !== 0 && Math.abs(n) <= range.max : n >= range.min && n <= range.max);
    if (!value.split(",").every((v) => /^[+-]?\d+$/.test(v) && fits(Number(v)))) {
      return range.signed
        ? `${key} must be whole numbers from 1 to ${range.max} or from -${range.max} to -1: ${part}`
        : `${key} must be whole numbers from ${range.min} to ${range.max}: ${part}`;
    }
  }
  if (key === "WKST" && !WEEKDAYS.includes(value.toUpperCase())) return `invalid 'WKST': ${value}`;
  return "";
}

/**
 * A rule's parts, its UNTIL in the wall clock of the DTSTART's zone : a naive UNTIL is read in
 * that zone, one ending in Z is the UTC moment it names.
 *
 * Args:
 *   text (string): the rule's parts (FREQ=DAILY;INTERVAL=1;UNTIL=...).
 *   zone (string): the DTSTART's zone.
 *   fail (function): makes the parse error.
 *
 * Returns:
 *   object: the rule's options, as rrule.js reads them, without a dtstart.
 *
 * Raises:
 *   Error: a part that does not parse.
 */
function ruleOptions(text, zone, fail, label = `RRULE:${text}`) {
  let until = null;
  const parts = text
    .split(";")
    .filter((part) => {
      const m = part.match(/^UNTIL=(.*)$/i);
      if (!m) return true;
      // an UNTIL is a date with a time (YYYYMMDDTHHMMSS, Z or not)
      const stamp = m[1].match(/^(\d{8}T\d{6})(Z?)$/i);
      if (!stamp) throw fail(`UNTIL must be a date and a time (YYYYMMDDTHHMMSS): ${part}`);
      until = stamp[2] ? floatingOf(new Date(floatingOfStamp(stamp[1])), zone) : floatingOfStamp(stamp[1]);
      return false;
    })
    .filter(Boolean);
  // a FREQ rrule.js does not know would be left out silently : named, as dateutil names it
  const freq = parts.map((part) => part.match(/^FREQ=(.*)$/i)).find(Boolean);
  if (freq && !["YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY", "MINUTELY", "SECONDLY"].includes(freq[1].toUpperCase())) {
    throw fail(`invalid 'FREQ': ${freq[1]}`);
  }
  // each part, in its order, before rrule.js reads it : it would take a number out of range
  for (const part of parts) {
    const problem = partProblem(part);
    if (problem) throw fail(problem);
  }
  let options;
  try {
    options = RRule.parseString(parts.join(";"));
  } catch (e) {
    throw fail(e.message || String(e));
  }
  if (options.freq === undefined) throw fail("a rule needs a FREQ");
  // the checks validateRrule makes on the text, made again on what was read : whatever the case
  // of the keys or the sign of a number (interval=-1, count=5000)
  if (options.interval !== undefined && options.interval !== null && !(Number.isInteger(options.interval) && options.interval >= 1)) {
    throw new Error(`INTERVAL must be a positive integer: ${label}`);
  }
  if (options.freq === RRule.SECONDLY) throw new Error(`SECONDLY is not supported: ${label}`);
  if (options.count !== undefined && options.count !== null) {
    if (until !== null) throw new Error(`RRULE may not contain both COUNT and UNTIL: ${label}`);
    if (!Number.isInteger(options.count) || options.count < 1) throw new Error(`COUNT must be a positive integer: ${label}`);
    if (options.count > MAX_COUNT) throw new Error(`COUNT > 999 is unsupported: ${label}`);
  }
  const byday = options.byweekday === undefined || options.byweekday === null ? [] : [].concat(options.byweekday);
  // a weekday rrule.js does not know (mo, in lower case) is read as nothing : named
  if (byday.some((d) => d === undefined || d === null)) {
    throw fail(`Invalid weekday string: ${parts.map((part) => part.match(/^BY(?:WEEK)?DAY=(.*)$/i)).find(Boolean)?.[1]}`);
  }
  if (byday.some((d) => d && typeof d === "object" && d.n)) throw new Error(`BYDAY with numeric prefix not supported: ${label}`);
  // rrule.js reads both BYDAY and BYWEEKDAY ; no time zone of its own (the wall clock is ours)
  delete options.tzid;
  delete options.dtstart;
  if (until !== null) options.until = new Date(until);
  return options;
}

// ===========================================================================
// RRULE : ITS RUNS
// ===========================================================================

/**
 * A YYYYMMDDTHHMMSS stamp as a floating time.
 *
 * Args:
 *   stamp (string): the stamp.
 *
 * Returns:
 *   number: the floating time in ms (NaN when it is no date).
 */
function floatingOfStamp(stamp) {
  const m = String(stamp).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // a day or an hour out of range (20261332T250000) is no date
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return NaN;
  return ms;
}

/**
 * A moment as the wall clock of a zone shows it, as a floating time.
 *
 * Args:
 *   date (Date): the moment.
 *   zone (string): the zone.
 *
 * Returns:
 *   number: the floating time in ms.
 */
function floatingOf(date, zone) {
  const dt = DateTime.fromJSDate(date, { zone });
  return Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second);
}

/**
 * The moment a wall clock time of a zone is. A time the zone's clock skips (the hour a DST change
 * jumps over) is the moment the clock reaches it, moved forward by the jump - 02:30 is 03:30 the
 * night the clock goes from 02:00 to 03:00, as a cron runs it ; a time the clock shows twice (the
 * hour it goes back) is the first of the two, as dateutil takes it.
 *
 * Args:
 *   floating (number): the floating time in ms.
 *   zone (string): the zone.
 *
 * Returns:
 *   Date|null: the moment ; null when the zone cannot say.
 */
function momentOf(floating, zone) {
  const f = new Date(floating);
  const dt = DateTime.fromObject(
    {
      year: f.getUTCFullYear(),
      month: f.getUTCMonth() + 1,
      day: f.getUTCDate(),
      hour: f.getUTCHours(),
      minute: f.getUTCMinutes(),
      second: f.getUTCSeconds(),
    },
    { zone },
  );
  return dt.isValid ? dt.toJSDate() : null;
}

/**
 * The fields of a floating time, its weekday as rrule.js numbers it (Monday 0).
 *
 * Args:
 *   ms (number): the floating time.
 *
 * Returns:
 *   object: { year, month (1 to 12), day, hour, minute, second, weekday }.
 */
function fieldsOf(ms) {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: (d.getUTCDay() + 6) % 7,
  };
}

// the start of the day of a floating time
const dayOf = (ms) => Math.floor(ms / DAY) * DAY;

// the greatest common divisor of two whole numbers
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * A rule's options as lists, the parts rrule.js would take from the DTSTART written out : its
 * time of the day (BYHOUR, BYMINUTE, BYSECOND, when coarser than them), and the day of a weekly,
 * monthly or yearly rule that names none. With them written out, the rule is the same from any
 * DTSTART of its own periods : it can be walked from now.
 *
 * Args:
 *   options (object): the rule's options, as ruleOptions reads them.
 *   start (number): the DTSTART, floating ms.
 *
 * Returns:
 *   object: { freq, interval, count, until (floating ms or null), wkst, byeaster (or null), and
 *     bysetpos, bymonth, bymonthday, byyearday, byweekno, byweekday, byhour, byminute, bysecond
 *     as lists }.
 */
function specOf(options, start) {
  const list = (v) => (v === undefined || v === null ? [] : [].concat(v));
  const f = fieldsOf(start);
  const spec = {
    freq: options.freq,
    interval: options.interval || 1,
    count: options.count || null,
    until: options.until ? options.until.getTime() : null,
    wkst: options.wkst === undefined || options.wkst === null ? 0 : typeof options.wkst === "number" ? options.wkst : options.wkst.weekday,
    byeaster: options.byeaster === undefined || options.byeaster === null ? null : options.byeaster,
    bysetpos: list(options.bysetpos),
    bymonth: list(options.bymonth),
    bymonthday: list(options.bymonthday),
    byyearday: list(options.byyearday),
    byweekno: list(options.byweekno),
    byweekday: list(options.byweekday).map((d) => (typeof d === "number" ? d : d.weekday)),
    byhour: list(options.byhour),
    byminute: list(options.byminute),
    bysecond: list(options.bysecond),
  };
  // the time of the day, as rrule.js takes it from the DTSTART
  if (!spec.byhour.length && spec.freq < RRule.HOURLY) spec.byhour = [f.hour];
  if (!spec.byminute.length && spec.freq < RRule.MINUTELY) spec.byminute = [f.minute];
  if (!spec.bysecond.length) spec.bysecond = [f.second];
  // the day of a rule that names none, as rrule.js takes it from the DTSTART
  const namesDays = spec.byweekno.length || spec.byyearday.length || spec.bymonthday.length || spec.byweekday.length || spec.byeaster !== null;
  if (!namesDays) {
    if (spec.freq === RRule.YEARLY) {
      if (!spec.bymonth.length) spec.bymonth = [f.month];
      spec.bymonthday = [f.day];
    } else if (spec.freq === RRule.MONTHLY) {
      spec.bymonthday = [f.day];
    } else if (spec.freq === RRule.WEEKLY) {
      spec.byweekday = [f.weekday];
    }
  }
  return spec;
}

/**
 * The rule rrule.js keeps the days of a rule with : a yearly rule with its BYMONTH, BYMONTHDAY,
 * BYYEARDAY, BYWEEKNO, BYDAY and BYEASTER, one run a day ; null when it names no day (every day
 * is kept).
 *
 * Args:
 *   spec (object): specOf's result.
 *   year (number): the year it starts in.
 *
 * Returns:
 *   RRule|null: the rule.
 */
function dayRuleOf(spec, year) {
  const opts = { freq: RRule.YEARLY, interval: 1, dtstart: new Date(Date.UTC(year, 0, 1)), wkst: spec.wkst, byhour: [0], byminute: [0], bysecond: [0] };
  for (const key of ["bymonth", "bymonthday", "byyearday", "byweekno", "byweekday"]) if (spec[key].length) opts[key] = spec[key];
  if (spec.byeaster !== null) opts.byeaster = spec.byeaster;
  if (Object.keys(opts).length === 7) return null;
  // only months : every day of them (a yearly rule would take only the day of its DTSTART)
  if (!opts.bymonthday && !opts.byyearday && !opts.byweekno && !opts.byweekday && opts.byeaster === undefined) opts.byweekday = [0, 1, 2, 3, 4, 5, 6];
  return new RRule(opts);
}

/**
 * Whether a rule can never fire, seen without walking it : no day is ever kept, its months never
 * meet a monthly interval, its hours and minutes never meet an hourly or minutely interval, or
 * its BYSETPOS picks none of the times of a daily, hourly or minutely period (BYSETPOS=2 of one).
 *
 * Args:
 *   spec (object): specOf's result.
 *   start (number): the DTSTART, floating ms.
 *
 * Returns:
 *   boolean: true when it never fires.
 */
function neverFiresAtAll(spec, start) {
  const f = fieldsOf(start);
  if (!timesOf(spec).length) return true;
  // the residues the interval reaches, from the DTSTART's : value - first is a multiple of their gcd
  const reaches = (values, size, first) => values.some((v) => (((v - first) % gcd(spec.interval, size)) + size) % size === 0);
  if (spec.freq === RRule.MONTHLY && spec.bymonth.length && !reaches(spec.bymonth, 12, f.month)) return true;
  if (spec.freq === RRule.HOURLY && spec.byhour.length && !reaches(spec.byhour, 24, f.hour)) return true;
  if (spec.freq === RRule.MINUTELY && (spec.byhour.length || spec.byminute.length)) {
    const hours = spec.byhour.length ? spec.byhour : [...Array(24).keys()];
    const minutes = spec.byminute.length ? spec.byminute : [...Array(60).keys()];
    if (!reaches(hours.flatMap((h) => minutes.map((m) => h * 60 + m)), 1440, f.hour * 60 + f.minute)) return true;
  }
  const days = dayRuleOf(spec, f.year);
  return !!days && days.after(new Date(Date.UTC(f.year, 0, 1)), true) === null;
}

/**
 * The runs BYSETPOS picks among the runs of a period, in order : the n-th from the start, or from
 * the end when negative ; one past the runs the period has picks none.
 *
 * Args:
 *   set (number[]): the runs of the period, in order.
 *   bysetpos (number[]): the rule's BYSETPOS (empty : every run).
 *
 * Returns:
 *   number[]: the runs picked, in order.
 */
function pickSet(set, bysetpos) {
  if (!bysetpos.length) return set;
  const picked = bysetpos.map((p) => set[p > 0 ? p - 1 : set.length + p]).filter((t) => t !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/**
 * The times of a rule's runs from the start of the day (a weekly, monthly or yearly rule : its
 * BYHOUR, BYMINUTE and BYSECOND) or of its period (a daily, hourly or minutely one : as many of
 * them as the period holds, BYSETPOS picking among them, the period's runs being these times).
 *
 * Args:
 *   spec (object): specOf's result.
 *
 * Returns:
 *   number[]: the times, ms, in order.
 */
function timesOf(spec) {
  const product = (lists) => lists.reduce((acc, [values, size]) => acc.flatMap((a) => values.map((v) => a + v * size)), [0]);
  const parts = [[spec.bysecond, 1000]];
  if (spec.freq !== RRule.MINUTELY) parts.unshift([spec.byminute, MINUTE]);
  if (spec.freq <= RRule.DAILY) parts.unshift([spec.byhour, HOUR]);
  const times = [...new Set(product(parts))].sort((a, b) => a - b);
  return spec.freq >= RRule.DAILY ? pickSet(times, spec.bysetpos) : times;
}

/**
 * The periods of a rule, every INTERVAL of them from the DTSTART's : a minute, an hour, a day or
 * a week (from its WKST) of a fixed length, a month or a year of the calendar.
 *
 * Args:
 *   spec (object): specOf's result.
 *   start (number): the DTSTART, floating ms.
 *
 * Returns:
 *   object: { startOf (k => where the k-th period starts), endOf (k => where it ends), firstFrom
 *     (t => the first period that ends after t) }.
 */
function periodsOf(spec, start) {
  const f = fieldsOf(start);
  let startOf;
  let endOf;
  let indexOf;
  if (spec.freq === RRule.MONTHLY || spec.freq === RRule.YEARLY) {
    const months = spec.freq === RRule.YEARLY ? 12 : 1;
    const step = spec.interval * months;
    const first = f.year * 12 + (spec.freq === RRule.YEARLY ? 0 : f.month - 1);
    const monthStart = (m) => Date.UTC(Math.floor(m / 12), m % 12, 1);
    startOf = (k) => monthStart(first + k * step);
    endOf = (k) => monthStart(first + k * step + months);
    indexOf = (t) => {
      const g = fieldsOf(t);
      return Math.floor((g.year * 12 + g.month - 1 - first) / step);
    };
  } else {
    const unit = { [RRule.WEEKLY]: 7 * DAY, [RRule.DAILY]: DAY, [RRule.HOURLY]: HOUR, [RRule.MINUTELY]: MINUTE }[spec.freq];
    const step = spec.interval * unit;
    const base = spec.freq === RRule.WEEKLY ? dayOf(start) - ((f.weekday - spec.wkst + 7) % 7) * DAY : Math.floor(start / unit) * unit;
    startOf = (k) => base + k * step;
    endOf = (k) => base + k * step + unit;
    indexOf = (t) => Math.floor((t - base) / step);
  }
  const firstFrom = (t) => {
    const k = Math.max(0, indexOf(t));
    return endOf(k) <= t ? k + 1 : k;
  };
  return { startOf, endOf, firstFrom };
}

/**
 * A rule walked here : its periods (every INTERVAL of them from the DTSTART's), the days each
 * holds that are kept (dayRuleOf), its times on them (timesOf), BYSETPOS picking among the runs of
 * a weekly, monthly or yearly period as it does among the times of a shorter one. An hour or a
 * minute is kept when its hour and minute are too.
 *
 * Args:
 *   spec (object): specOf's result.
 *   start (number): the DTSTART, floating ms.
 *
 * Returns:
 *   function: (from, to) => the runs after from and up to to, floating ms, in order, COUNT not
 *     applied.
 */
function periodWalker(spec, start) {
  const { startOf, endOf, firstFrom } = periodsOf(spec, start);
  const short = spec.freq >= RRule.DAILY;
  const times = timesOf(spec);
  // what keeps an hour or a minute : its hour, its minute
  const hours = spec.freq > RRule.DAILY && spec.byhour.length ? new Set(spec.byhour) : null;
  const minutes = spec.freq === RRule.MINUTELY && spec.byminute.length ? new Set(spec.byminute) : null;
  return (from, to) => {
    const runs = [];
    const lo = Math.max(from, start - 1);
    const hi = spec.until === null ? to : Math.min(to, spec.until);
    if (hi <= lo) return runs;
    let k = firstFrom(lo);
    // the days kept in the periods between the two, in order : every day of the periods each
    // end is in, BYSETPOS counting the runs of a whole period
    const dayRule = dayRuleOf(spec, fieldsOf(startOf(k)).year);
    const kh = firstFrom(hi);
    const last = startOf(kh) <= hi ? Math.max(hi, endOf(kh) - 1) : hi;
    let days = dayRule ? dayRule.between(new Date(dayOf(startOf(k))), new Date(dayOf(last)), true).map((d) => d.getTime()) : null;
    // a weekly, monthly or yearly rule names its days (specOf) : every day all the same
    if (!days && !short) days = Array.from({ length: (dayOf(last) - dayOf(startOf(k))) / DAY + 1 }, (_, i) => dayOf(startOf(k)) + i * DAY);
    let at = 0;
    for (;;) {
      const p = startOf(k);
      if (p > hi) break;
      if (days) {
        // the first day kept from the period's on
        while (at < days.length && days[at] < dayOf(p)) at++;
        if (at >= days.length) break;
        if (days[at] >= endOf(k)) {
          k = Math.max(k + 1, firstFrom(days[at]));
          continue;
        }
      }
      if (!short) {
        // a week, a month or a year : the runs of its days, BYSETPOS picking among them
        const set = [];
        for (let i = at; i < days.length && days[i] < endOf(k); i++) for (const time of times) set.push(days[i] + time);
        for (const t of pickSet(set, spec.bysetpos)) if (t > lo && t <= hi) runs.push(t);
        k++;
        continue;
      }
      const f = hours || minutes ? fieldsOf(p) : null;
      if (hours && !hours.has(f.hour)) {
        // a minute : on to the next hour
        k = spec.freq === RRule.MINUTELY ? Math.max(k + 1, firstFrom(Math.floor(p / HOUR) * HOUR + HOUR)) : k + 1;
        continue;
      }
      if (!minutes || minutes.has(f.minute)) {
        for (const time of times) {
          const t = p + time;
          if (t > lo && t <= hi) runs.push(t);
        }
      }
      k++;
    }
    return runs;
  };
}

/**
 * How a rule is walked : here (periodWalker) from the period a moment is in, a rule with a COUNT
 * from its DTSTART.
 *
 * Args:
 *   options (object): the rule's options, as ruleOptions reads them.
 *   start (number): the DTSTART, floating ms.
 *
 * Returns:
 *   object: { never (true : it never fires), between: (from, to) => the runs after from and up to
 *     to, floating ms, in order }.
 */
function ruleWalker(options, start) {
  const spec = specOf(options, start);
  if (neverFiresAtAll(spec, start)) return { never: true, between: () => [] };
  const walk = periodWalker(spec, start);
  if (!spec.count) return { never: false, between: walk };
  // its first COUNT runs, from its DTSTART, a year at a time
  const runs = [];
  for (let from = start - 1; runs.length < spec.count && from < start + HORIZON_MS; from += 366 * DAY) {
    runs.push(...walk(from, from + 366 * DAY));
  }
  runs.length = Math.min(runs.length, spec.count);
  return { never: false, between: (from, to) => runs.filter((t) => t > from && t <= to) };
}

/**
 * The next runs of a rrule, worked out here : looked for in windows that start at an hour and
 * double while they hold none, up to HORIZON_YEARS ahead, a time its zone's clock skips moved
 * forward. Only the thread of lib/scheduleRruleWorker.js calls it - nextRuns and nextRunsAsync
 * are the guarded calls.
 *
 * Args:
 *   value (string|object): the rrule, or compileRrule's result.
 *   options (object): { after (Date, now by default), count (how many, 1 by default), fromStart
 *     (true : from its DTSTART, after ignored) }.
 *
 * Returns:
 *   Date[]: the runs, as moments ; fewer than asked (or none) when the rule ends.
 *
 * Raises:
 *   Error: the rrule does not parse.
 */
export function walkRuns(value, { after = new Date(), count = 1, fromStart = false } = {}) {
  const compiled = typeof value === "string" ? compileRrule(value) : value;
  // from just before its DTSTART, or from the moment asked, as the zone's wall clock shows it
  const reference = fromStart ? compiled.start - 1000 : floatingOf(after, compiled.zone);
  const walkers = compiled.rules.map((r) => ({ kind: r.kind, ...ruleWalker(r.options, compiled.start) }));
  const takes = walkers.filter((w) => w.kind === "rrule" && !w.never);
  const leaves = walkers.filter((w) => w.kind === "exrule" && !w.never);
  const runs = new Set();
  const end = reference + HORIZON_MS;
  let until = end;
  let from = reference;
  let window = FIRST_WINDOW_MS;
  while (takes.length && from < until) {
    const to = Math.min(from + window, until);
    const out = new Set(leaves.flatMap((w) => w.between(from, to)));
    for (const w of takes) {
      for (const next of w.between(from, to)) {
        if (out.has(next)) continue;
        const moment = momentOf(next, compiled.zone);
        // not after the moment asked (the hour the clock goes back)
        if (!moment || (!fromStart && moment <= after)) continue;
        runs.add(moment.getTime());
      }
    }
    from = to;
    window *= 2;
    // enough : a little further still, for a skipped time moved forward past a later run
    if (runs.size >= count && until === end) until = Math.min(end, to + SHIFT_MS);
  }
  return [...runs]
    .sort((a, b) => a - b)
    .slice(0, count)
    .map((ms) => new Date(ms));
}

// ===========================================================================
// RRULE : ITS RUNS, IN THEIR THREAD
// ===========================================================================

// the threads the runs are worked out in, started at their first call : one a call waits for
// (nextRuns), one a call awaits (nextRunsAsync) ; a new one after one stopped or took too long
let syncThread = null;
let asyncThread = null;
// the rrules whose runs took too long : given up until a moment (ms)
const givenUp = new Map();

/**
 * The error of a call that took too long : the rule is given up a while, not refused.
 *
 * Returns:
 *   Error: the error, its code TIMEOUT.
 */
function tooSlow() {
  const e = new Error(`No run of this rrule could be worked out in ${limits.walkMs / 1000} second: does it ever fire?`);
  e.code = TIMEOUT;
  return e;
}

/**
 * Whether a rrule is given up still : one whose time is over is walked again.
 *
 * Args:
 *   rrule (string): the rrule.
 *
 * Returns:
 *   boolean: true when it is.
 */
function isGivenUp(rrule) {
  const until = givenUp.get(rrule);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  givenUp.delete(rrule);
  return false;
}

/**
 * Gives a rrule up for limits.givenUpMs, the oldest forgotten past limits.maxGivenUp.
 *
 * Args:
 *   rrule (string): the rrule.
 */
function giveUp(rrule) {
  if (givenUp.size >= limits.maxGivenUp) givenUp.delete(givenUp.keys().next().value);
  givenUp.set(rrule, Date.now() + limits.givenUpMs);
}

/**
 * A thread of lib/scheduleRruleWorker.js : its replies come on a port of its own, a shared flag
 * says one is there. It never keeps the process alive ; when it fails or stops, onGone is told
 * (once), so the next call starts a new one.
 *
 * Args:
 *   onGone (function): (thread, error) => what follows its end.
 *
 * Returns:
 *   object: { worker, port, flag, asked (the last request's id), gone }.
 */
function spawnThread(onGone) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./scheduleRruleWorker.js", import.meta.url), { workerData: { flag, port: port2 }, transferList: [port2] });
  worker.unref();
  const thread = { worker, port: port1, flag, asked: 0, gone: false };
  const gone = (error) => {
    if (thread.gone) return;
    thread.gone = true;
    onGone(thread, error);
  };
  worker.on("error", gone);
  worker.on("exit", () => gone(null));
  return thread;
}

/**
 * Stops a thread that took too long or is no longer wanted.
 *
 * Args:
 *   thread (object): the thread.
 */
function stopThread(thread) {
  thread.gone = true;
  thread.worker.terminate().catch(() => {});
}

/**
 * The thread nextRuns waits for, started and ready (it sets the shared flag once it has loaded).
 *
 * Returns:
 *   object: the thread.
 *
 * Raises:
 *   Error: it did not start in limits.startMs.
 */
function startSyncThread() {
  const thread = spawnThread((t) => {
    if (syncThread === t) syncThread = null;
  });
  thread.port.unref();
  if (Atomics.wait(thread.flag, 0, 0, limits.startMs) === "timed-out") {
    stopThread(thread);
    throw new Error("The runs of the rrule could not be worked out: their thread did not start.");
  }
  return thread;
}

/**
 * Asks the thread for runs and waits for them, limits.walkMs at most : synchronous, as its
 * callers are (a rule checked while a file is read). A thread that takes longer is stopped (a new
 * one serves the next call) and the rrule is given up a while.
 *
 * Args:
 *   request (object): { rrule, after (ms), count, fromStart }.
 *
 * Returns:
 *   number[]: the runs, in ms.
 *
 * Raises:
 *   Error: the rrule does not parse, or its runs took too long (code TIMEOUT).
 */
function askThread(request) {
  if (isGivenUp(request.rrule)) throw tooSlow();
  if (syncThread?.gone) syncThread = null;
  syncThread ||= startSyncThread();
  const thread = syncThread;
  const id = ++thread.asked;
  Atomics.store(thread.flag, 0, 0);
  thread.worker.postMessage({ id, ...request });
  const deadline = Date.now() + limits.walkMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left > 0) Atomics.wait(thread.flag, 0, 0, left);
    const reply = receiveMessageOnPort(thread.port)?.message;
    if (reply && reply.id === id) {
      if (reply.error) throw new Error(reply.error);
      return reply.runs;
    }
    // a reply to an older call, or the thread saying it is ready : read past it
    if (reply) continue;
    if (Date.now() >= deadline) break;
    Atomics.store(thread.flag, 0, 0);
  }
  // too long : this thread is lost to that rule, a new one for the next call
  stopThread(thread);
  if (syncThread === thread) syncThread = null;
  giveUp(request.rrule);
  throw tooSlow();
}

/**
 * The thread nextRunsAsync awaits : its calls are answered one after the other, each given
 * limits.walkMs once the thread has it. When it fails or stops, the call it was answering is
 * told so (not given up : the next call starts a new thread).
 *
 * Returns:
 *   object: the thread, with { ready (resolved once it has loaded), queue (the calls before the
 *     next one), pending (the call it answers) }.
 */
function startAsyncThread() {
  const thread = spawnThread((t, error) => {
    if (asyncThread === t) asyncThread = null;
    t.pending?.reject(new Error(`The runs of the rrule could not be worked out: their thread stopped${error ? `: ${error.message}` : ""}.`));
    t.readyFailed?.(new Error("The runs of the rrule could not be worked out: their thread stopped."));
  });
  thread.queue = Promise.resolve();
  thread.pending = null;
  thread.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The runs of the rrule could not be worked out: their thread did not start.")), limits.startMs);
    timer.unref?.();
    thread.readyDone = () => {
      clearTimeout(timer);
      resolve();
    };
    thread.readyFailed = (e) => {
      clearTimeout(timer);
      reject(e);
    };
  });
  // a rejection nobody awaits yet is no crash
  thread.ready.catch(() => {});
  thread.port.on("message", (message) => {
    if (message?.ready) thread.readyDone();
    else if (thread.pending && message?.id === thread.pending.id) thread.pending.resolve(message);
  });
  thread.port.unref();
  return thread;
}

/**
 * One call of the thread nextRunsAsync awaits : sent once the thread is ready, given
 * limits.walkMs ; a thread that takes longer is stopped and the rrule given up a while.
 *
 * Args:
 *   thread (object): the thread.
 *   request (object): { rrule, after (ms), count, fromStart }.
 *
 * Returns:
 *   Promise<number[]>: the runs, in ms.
 */
async function askThreadOnce(thread, request) {
  // a thread that stopped meanwhile : the call goes to a new one
  if (thread.gone) return askThreadAsync(request);
  if (isGivenUp(request.rrule)) throw tooSlow();
  await thread.ready;
  const id = ++thread.asked;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      thread.pending = null;
      stopThread(thread);
      if (asyncThread === thread) asyncThread = null;
      giveUp(request.rrule);
      reject(tooSlow());
    }, limits.walkMs);
    timer.unref?.();
    const done = (fn) => (value) => {
      clearTimeout(timer);
      thread.pending = null;
      fn(value);
    };
    thread.pending = { id, resolve: done(resolve), reject: done(reject) };
    thread.worker.postMessage({ id, ...request });
  });
  if (reply.error) throw new Error(reply.error);
  return reply.runs;
}

/**
 * Asks the awaited thread for runs, after the calls before it.
 *
 * Args:
 *   request (object): { rrule, after (ms), count, fromStart }.
 *
 * Returns:
 *   Promise<number[]>: the runs, in ms.
 */
function askThreadAsync(request) {
  if (isGivenUp(request.rrule)) return Promise.reject(tooSlow());
  if (asyncThread?.gone) asyncThread = null;
  const thread = (asyncThread ||= startAsyncThread());
  const call = thread.queue.then(() => askThreadOnce(thread, request));
  thread.queue = call.catch(() => {});
  return call;
}

/**
 * The threads the runs are worked out in, as they are now : for the tests.
 *
 * Returns:
 *   object: { sync, async } (each a Worker, or null).
 */
export function rruleThreads() {
  return { sync: syncThread?.worker || null, async: asyncThread?.worker || null };
}

/**
 * The next runs of a rrule after a moment, in its own time zone, a time its zone's clock skips
 * moved forward (when a rule is checked) : worked out in a thread of their own, waited for
 * limits.walkMs at most, so no rule blocks the process for longer.
 *
 * Args:
 *   value (string): the rrule.
 *   options (object): { after (Date, now by default), count (how many, 1 by default), fromStart
 *     (true : from its DTSTART) }.
 *
 * Returns:
 *   Date[]: the runs, as moments ; fewer than asked (or none) when the rule ends.
 *
 * Raises:
 *   Error: the rrule does not parse, or its runs cannot be worked out in time (code TIMEOUT).
 */
export function nextRuns(value, { after = new Date(), count = 1, fromStart = false } = {}) {
  const rrule = normalizeRrule(value);
  return askThread({ rrule, after: after.getTime(), count, fromStart }).map((ms) => new Date(ms));
}

/**
 * nextRuns, awaited instead of waited for : the process goes on meanwhile (the schedules list, a
 * preview, the scheduler).
 *
 * Args:
 *   value (string): the rrule.
 *   options (object): as nextRuns.
 *
 * Returns:
 *   Promise<Date[]>: the runs.
 *
 * Raises:
 *   Error: as nextRuns.
 */
export async function nextRunsAsync(value, { after = new Date(), count = 1, fromStart = false } = {}) {
  const rrule = normalizeRrule(value);
  return (await askThreadAsync({ rrule, after: after.getTime(), count, fromStart })).map((ms) => new Date(ms));
}

/**
 * The next run of a rrule after a moment.
 *
 * Args:
 *   value (string): the rrule.
 *   after (Date): the moment (now by default).
 *
 * Returns:
 *   Date|null: the run ; null when the rule has ended, does not parse or took too long.
 */
export function nextRun(value, after = new Date()) {
  try {
    return nextRuns(value, { after, count: 1 })[0] || null;
  } catch {
    return null;
  }
}

/**
 * The next run of a rrule after a moment, awaited.
 *
 * Args:
 *   value (string): the rrule.
 *   after (Date): the moment (now by default).
 *
 * Returns:
 *   Promise<Date|null>: the run ; null when the rule has ended, does not parse or took too long.
 */
export async function nextRunAsync(value, after = new Date()) {
  try {
    return (await nextRunsAsync(value, { after, count: 1 }))[0] || null;
  } catch {
    return null;
  }
}

/**
 * The time zone of a rrule (its DTSTART's TZID, UTC for a DTSTART ending in Z).
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   string|null: the zone ; null when it does not parse.
 */
export function zoneOf(value) {
  try {
    return compileRrule(value).zone;
  } catch {
    return null;
  }
}

/**
 * A rrule a new schedule starts with : every day at midnight, from today, in a zone.
 *
 * Args:
 *   zone (string): the zone (the scheduler's).
 *   now (Date): today.
 *
 * Returns:
 *   string: the rrule.
 */
export function defaultRrule(zone = "UTC", now = new Date()) {
  const dt = DateTime.fromJSDate(now, { zone: zone || "UTC" });
  const day = dt.isValid ? dt.toFormat("yyyyLLdd") : DateTime.utc().toFormat("yyyyLLdd");
  return `DTSTART;TZID=${dt.isValid ? zone : "UTC"}:${day}T000000 RRULE:FREQ=DAILY;INTERVAL=1`;
}

/**
 * A rrule written on one line, its parts apart by one space.
 *
 * Args:
 *   value (string): the rrule.
 *
 * Returns:
 *   string: the rrule on one line.
 */
export function normalizeRrule(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).join(" ");
}
