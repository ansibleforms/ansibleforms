// The recurrence rules a schedule of a schedules repository is timed by : an iCal rrule (DTSTART
// with its TZID, RRULE, EXRULE), refused where it is not a valid schedule rrule, its runs worked
// out in its own time zone. Pure : lib/scheduleFiles.js reads them from the files,
// models/schedule.model.js and services/cron.service.js time the schedules by them.
//
// The rules :
//   a rrule needs one DTSTART, with a TZID or in UTC (ending in Z), and at least one RRULE ;
//     EXRULE takes runs out, EXDATE and RDATE are refused ; each rule needs an INTERVAL of 1 or
//     more, no SECONDLY, no BYDAY with a number (5MO), not COUNT and UNTIL together, COUNT 999
//     at most
//   a naive UNTIL is read in the DTSTART's zone, one ending in Z is the UTC moment it names
//   a minutely or hourly rule is moved up to now before it is walked
//   a time a DST change skips is left out, a time the clock shows twice runs at the first
//   a preview shows the next ten runs
//
// rrule.js is a port of python-dateutil's rrule : the BYxxx parts expand as dateutil expands
// them. It is given the rule in the zone's wall clock (a "floating" time), and luxon turns each
// run into the moment it is in that zone.
import rrulePkg from "rrule";
import { DateTime } from "luxon";

const { RRule, RRuleSet } = rrulePkg;

// the most runs a COUNT may ask for
const MAX_COUNT = 999;

// the occurrences looked at, at most, for the next ones : a rule whose runs all fall in a DST gap
// would otherwise be walked for ever
const MAX_STEPS = 5000;

// ===========================================================================
// RRULE : CHECKED
// ===========================================================================

/**
 * Why a rrule is refused : no DTSTART, a naive one (neither a TZID nor a Z), more than one, no RRULE,
 * an EXDATE or an RDATE, a rule without INTERVAL or with INTERVAL under 1, SECONDLY, BYDAY with a
 * numeric prefix (20MO), COUNT and UNTIL together, COUNT above 999, a TZID that is no time zone,
 * and whatever does not parse.
 *
 * Args:
 *   value (string): the rrule, written on one line (DTSTART;TZID=Europe/Brussels:
 *     20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1).
 *
 * Returns:
 *   string[]: the reasons it is refused ; empty when it is valid.
 */
export function validateRrule(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return ["This field may not be blank."];
  // step 1 : what is checked on the text ; EXDATE and RDATE end the check at once, said on
  // their own
  const errors = [];
  const dtstarts = text.match(/DTSTART(;[^:]+)?:[0-9]+T[0-9]+Z?/g) || [];
  if (!dtstarts.length) errors.push("Valid DTSTART required in rrule. Value should start with: DTSTART:YYYYMMDDTHHMMSSZ");
  if (/DTSTART:[0-9]+T[0-9]+ /.test(text)) errors.push("DTSTART cannot be a naive datetime.  Specify ;TZINFO= or YYYYMMDDTHHMMSSZZ.");
  if (dtstarts.length > 1) errors.push("Multiple DTSTART is not supported.");
  if (!/rrule:/i.test(text)) errors.push("One or more rule required in rrule.");
  if (/exdate:/i.test(text)) return ["EXDATE not allowed in rrule."];
  if (/rdate:/i.test(text)) return ["RDATE not allowed in rrule."];
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
  if (errors.length) return errors;
  try {
    compileRrule(text);
  } catch (e) {
    errors.push(e.message);
  }
  return errors;
}

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
    rules: rules.map((r) => ({ kind: r.kind, options: ruleOptions(r.text, zone, fail) })),
  };
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
function ruleOptions(text, zone, fail) {
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
  let options;
  try {
    options = RRule.parseString(parts.join(";"));
  } catch (e) {
    throw fail(e.message || String(e));
  }
  if (options.freq === undefined) throw fail("a rule needs a FREQ");
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
 * The moment a wall clock time of a zone is, or null when the zone's clock skips it (the hour a
 * DST change jumps over, which is left out). A time the clock shows twice (the hour it goes
 * back) is the first of the two, as dateutil takes it.
 *
 * Args:
 *   floating (number): the floating time in ms.
 *   zone (string): the zone.
 *
 * Returns:
 *   Date|null: the moment.
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
  // luxon moves a skipped time forward : the wall clock it lands on is not the one asked
  if (!dt.isValid || dt.hour !== f.getUTCHours() || dt.minute !== f.getUTCMinutes() || dt.day !== f.getUTCDate()) return null;
  return dt.toJSDate();
}

/**
 * A minutely or hourly rule's start moved up to the last of its runs before the reference,
 * before it is walked : walking every minute since a DTSTART of
 * years ago would take minutes. A rule with a COUNT keeps its start (its runs are counted from
 * it), a start still ahead too.
 *
 * Args:
 *   options (object): the rule's options.
 *   start (number): the DTSTART, floating ms.
 *   reference (number): the reference, floating ms.
 *
 * Returns:
 *   number: the start to walk it from, floating ms.
 */
function fastForward(options, start, reference) {
  if (![RRule.HOURLY, RRule.MINUTELY].includes(options.freq)) return start;
  if (options.count) return start;
  if (start > reference) return start;
  const step = (options.interval || 1) * (options.freq === RRule.HOURLY ? 3600000 : 60000);
  return start + Math.floor((reference - start) / step) * step;
}

/**
 * The rule set of a compiled rrule, in floating time, its minutely and hourly rules moved up to
 * the reference.
 *
 * Args:
 *   compiled (object): compileRrule's result.
 *   reference (number): the reference, floating ms.
 *
 * Returns:
 *   RRuleSet: the set.
 */
function ruleSet(compiled, reference) {
  const set = new RRuleSet();
  for (const rule of compiled.rules) {
    const dtstart = new Date(fastForward(rule.options, compiled.start, reference));
    const r = new RRule({ ...rule.options, dtstart });
    if (rule.kind === "rrule") set.rrule(r);
    else set.exrule(r);
  }
  return set;
}

/**
 * The next runs of a rrule after a moment, in its own time zone, the times its zone's clock skips
 * left out (the preview, and when a schedule runs next).
 *
 * Args:
 *   value (string|object): the rrule, or compileRrule's result.
 *   options (object): { after (Date, now by default), count (how many, 1 by default) }.
 *
 * Returns:
 *   Date[]: the runs, as moments ; fewer than asked (or none) when the rule ends.
 *
 * Raises:
 *   Error: the rrule does not parse.
 */
export function nextRuns(value, { after = new Date(), count = 1 } = {}) {
  const compiled = typeof value === "string" ? compileRrule(value) : value;
  const set = ruleSet(compiled, floatingOf(after, compiled.zone));
  const runs = [];
  let cursor = new Date(floatingOf(after, compiled.zone));
  for (let step = 0; step < MAX_STEPS && runs.length < count; step++) {
    const next = set.after(cursor, false);
    if (!next) break;
    cursor = next;
    const moment = momentOf(next.getTime(), compiled.zone);
    // skipped by a DST change, or (the hour the clock goes back) not after the moment asked
    if (!moment || moment <= after) continue;
    runs.push(moment);
  }
  return runs;
}

/**
 * The next run of a rrule after a moment.
 *
 * Args:
 *   value (string): the rrule.
 *   after (Date): the moment (now by default).
 *
 * Returns:
 *   Date|null: the run ; null when the rule has ended or does not parse.
 */
export function nextRun(value, after = new Date()) {
  try {
    return nextRuns(value, { after, count: 1 })[0] || null;
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
