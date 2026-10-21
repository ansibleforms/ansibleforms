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
//   a rule needs a run in the 50 years after its DTSTART : one that never fires is refused
//   a minutely, hourly or daily rule is moved up to now before it is walked
//   its runs are looked for in growing windows up to 50 years ahead, in a thread of their own
//     (lib/scheduleRruleWorker.js) given one second at most : a rule rrule.js would walk for
//     ever (FREQ=HOURLY;INTERVAL=2;BYHOUR=1 from midnight) never blocks the process
//   a time a DST change skips is left out, a time the clock shows twice runs at the first
//   a preview shows the next ten runs
//
// rrule.js is a port of python-dateutil's rrule : the BYxxx parts expand as dateutil expands
// them. It is given the rule in the zone's wall clock (a "floating" time), and luxon turns each
// run into the moment it is in that zone.
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import rrulePkg from "rrule";
import { DateTime } from "luxon";

const { RRule, RRuleSet } = rrulePkg;

// the most runs a COUNT may ask for
const MAX_COUNT = 999;

// how far ahead runs are looked for : a rule with no run in it has none (a rule that never fires
// is refused)
export const HORIZON_YEARS = 50;
const HORIZON_MS = HORIZON_YEARS * 366 * 86400000;

// the first window runs are looked for in, doubled while it holds none
const FIRST_WINDOW_MS = 3600000;

// the time the runs of one call may take in their thread, and the time its start may take
const WALK_MS = 1000;
const START_MS = 10000;

// the rrules whose runs took longer : not walked again (each would cost WALK_MS), at most this many
const MAX_SLOW = 200;

// ===========================================================================
// RRULE : CHECKED
// ===========================================================================

/**
 * Why a rrule is refused : no DTSTART, a naive one (neither a TZID nor a Z), more than one, no RRULE,
 * an EXDATE or an RDATE, a rule without INTERVAL or with INTERVAL under 1, SECONDLY, BYDAY with a
 * numeric prefix (20MO), COUNT and UNTIL together, COUNT above 999, a TZID that is no time zone,
 * whatever does not parse, and a rule with no run in the HORIZON_YEARS after its DTSTART (or whose
 * runs cannot be worked out in time : one rrule.js would walk for ever).
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
    return errors;
  }
  // step 3 : it fires - a run in the years after its DTSTART (its runs may all be past : one that
  // ended is still a valid rule)
  try {
    if (!nextRuns(text, { fromStart: true }).length) errors.push(`This rrule never fires in the ${HORIZON_YEARS} years after its DTSTART.`);
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
    rules: rules.map((r) => ({ kind: r.kind, options: ruleOptions(r.text, zone, fail, `${r.kind.toUpperCase()}:${r.text}`) })),
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
 * A minutely, hourly or daily rule's start moved up to the last of its runs before the reference,
 * before it is walked : walking every minute (or every day, at each of its times) since a DTSTART
 * of years ago would take minutes. The step is the rule's period in the floating time, which has
 * no DST : the start stays on the rule's own lattice, its time of the day kept. A rule with a
 * COUNT keeps its start (its runs are counted from it), a start still ahead too.
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
  const period = { [RRule.MINUTELY]: 60000, [RRule.HOURLY]: 3600000, [RRule.DAILY]: 86400000 }[options.freq];
  if (!period) return start;
  if (options.count) return start;
  if (start > reference) return start;
  const step = (options.interval || 1) * period;
  return start + Math.floor((reference - start) / step) * step;
}

/**
 * The rule set of a compiled rrule, in floating time, its minutely, hourly and daily rules moved
 * up to the reference.
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
 * The next runs of a rrule, worked out here : looked for in windows that start at an hour and
 * double while they hold none, up to HORIZON_YEARS ahead, the times its zone's clock skips left
 * out. Only the thread of lib/scheduleRruleWorker.js calls it - a rule rrule.js walks for ever
 * would block the process ; nextRuns is the guarded call.
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
  const set = ruleSet(compiled, reference);
  const end = reference + HORIZON_MS;
  const runs = [];
  let from = reference;
  let window = FIRST_WINDOW_MS;
  while (runs.length < count && from < end) {
    const to = Math.min(from + window, end);
    for (const next of set.between(new Date(from), new Date(to), true)) {
      // the window's start was looked at in the window before
      if (next.getTime() === from && from !== reference) continue;
      if (next.getTime() === reference) continue;
      const moment = momentOf(next.getTime(), compiled.zone);
      // skipped by a DST change, or (the hour the clock goes back) not after the moment asked
      if (!moment || (!fromStart && moment <= after)) continue;
      runs.push(moment);
      if (runs.length >= count) break;
    }
    from = to;
    window *= 2;
  }
  return runs;
}

// the thread the runs are worked out in, started at the first call ; a new one after a call that
// took too long (the old one is stopped)
let walker = null;
const slow = new Map();

/**
 * The thread of lib/scheduleRruleWorker.js, started and ready (it sets the shared flag once it
 * has loaded) : its replies come on a port of its own, the flag says one is there.
 *
 * Returns:
 *   object: { worker, port, flag, asked (the last request's id) }.
 *
 * Raises:
 *   Error: it did not start in START_MS.
 */
function startWalker() {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./scheduleRruleWorker.js", import.meta.url), { workerData: { flag, port: port2 }, transferList: [port2] });
  // it never keeps the process alive
  worker.unref();
  port1.unref();
  if (Atomics.wait(flag, 0, 0, START_MS) === "timed-out") {
    worker.terminate();
    throw new Error("The runs of the rrule could not be worked out: their thread did not start.");
  }
  return { worker, port: port1, flag, asked: 0 };
}

/**
 * Asks the thread for runs and waits for them, a time at most : synchronous, as the callers are
 * (a list's next runs, a rule checked). A thread that takes longer is stopped (a new one serves
 * the next call) and the rrule is remembered as one whose runs cannot be worked out.
 *
 * Args:
 *   request (object): { rrule, after (ms), count, fromStart }.
 *
 * Returns:
 *   number[]: the runs, in ms.
 *
 * Raises:
 *   Error: the rrule does not parse, or its runs took too long.
 */
function askWalker(request) {
  const tooSlow = `No run of this rrule could be worked out in ${WALK_MS / 1000} second: does it ever fire?`;
  if (slow.has(request.rrule)) throw new Error(tooSlow);
  walker ||= startWalker();
  const id = ++walker.asked;
  Atomics.store(walker.flag, 0, 0);
  walker.worker.postMessage({ id, ...request });
  const deadline = Date.now() + WALK_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left > 0) Atomics.wait(walker.flag, 0, 0, left);
    const reply = receiveMessageOnPort(walker.port)?.message;
    if (reply && reply.id === id) {
      if (reply.error) throw new Error(reply.error);
      return reply.runs;
    }
    // a reply to an older call : read past it
    if (reply) continue;
    if (Date.now() >= deadline) break;
    Atomics.store(walker.flag, 0, 0);
  }
  // too long : this thread is lost to that rule, a new one for the next call
  walker.worker.terminate();
  walker = null;
  if (slow.size >= MAX_SLOW) slow.delete(slow.keys().next().value);
  slow.set(request.rrule, true);
  throw new Error(tooSlow);
}

/**
 * The next runs of a rrule after a moment, in its own time zone, the times its zone's clock skips
 * left out (the preview, and when a schedule runs next) : worked out in a thread of their own,
 * given WALK_MS at most, so no rule blocks the process.
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
 *   Error: the rrule does not parse, or its runs cannot be worked out in time.
 */
export function nextRuns(value, { after = new Date(), count = 1, fromStart = false } = {}) {
  const rrule = normalizeRrule(value);
  return askWalker({ rrule, after: after.getTime(), count, fromStart }).map((ms) => new Date(ms));
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
