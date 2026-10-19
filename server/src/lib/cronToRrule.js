// A schedule's cron written as an iCal rrule that fires at exactly the same moments, for a schedule
// that goes to the schedules repository (models/scheduleRepo.model.js activate) : its DTSTART in the
// scheduler's zone (LOG_TZ, where the cron fires), so the wall clock times do not move.
//
// A cron is the product of its fields' values (seconds, minutes, hours, days of the month, months,
// days of the week), which a daily rule with BYSECOND, BYMINUTE, BYHOUR, BYMONTHDAY, BYMONTH and
// BYDAY expresses exactly - with one exception : when both the day of the month and the day of the
// week are restricted, a cron fires on either (OR), a rrule only on both (AND). Such a cron is not
// converted, nor one that uses what a rrule has no word for (L, W, #, ?, a + before the weekdays,
// a year field). The common shapes get a short rule : every N minutes (N dividing 60), every N
// hours (N dividing 24), daily, weekly and monthly at one time.
import { DateTime } from "luxon";

// each field : its range, and the names it may use
const FIELDS = {
  second: { min: 0, max: 59 },
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], base: 1 },
  dow: { min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], base: 0 },
};

// a rrule's weekdays, Sunday first as a cron counts them
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * The values a cron field fires on : *, a value, a range, a list, and steps (star, a range or a
 * start with /n), month and weekday names.
 *
 * Args:
 *   text (string): the field.
 *   name (string): which field (FIELDS).
 *
 * Returns:
 *   number[]: its values, sorted (a weekday 7 is Sunday, 0).
 *
 * Raises:
 *   Error: a part a rrule cannot express, or not a valid field.
 */
function valuesOf(text, name) {
  const spec = FIELDS[name];
  if (!/^[0-9A-Za-z*,/-]+$/.test(text) || /[LW#?]/i.test(text.replace(/[A-Z]{3}/gi, (m) => (spec.names?.includes(m.toUpperCase()) ? "0" : m)))) {
    throw new Error(`'${text}' in the ${name} field cannot be written as a rrule`);
  }
  const number = (part) => {
    const upper = part.toUpperCase();
    if (spec.names?.includes(upper)) return spec.names.indexOf(upper) + spec.base;
    if (!/^\d+$/.test(part)) throw new Error(`'${part}' is not a valid ${name}`);
    const n = Number(part);
    if (n < spec.min || n > spec.max) throw new Error(`${n} is out of range for the ${name} field`);
    return n;
  };
  const values = new Set();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`'${part}' has no valid step`);
    let from;
    let to;
    if (range === "*") {
      from = spec.min;
      to = name === "dow" ? 6 : spec.max;
    } else if (range.includes("-")) {
      [from, to] = range.split("-").map(number);
      if (from > to) throw new Error(`'${part}' is a range that goes backwards`);
    } else {
      from = number(range);
      // a start with a step runs to the end of the field
      to = stepText === undefined ? from : name === "dow" ? 6 : spec.max;
    }
    for (let v = from; v <= to; v += step) values.add(name === "dow" && v === 7 ? 0 : v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Whether a field's values cover its whole range.
 *
 * Args:
 *   values (number[]): the values.
 *   name (string): the field.
 *
 * Returns:
 *   boolean: true when they do.
 */
function full(values, name) {
  const spec = FIELDS[name];
  const max = name === "dow" ? 6 : spec.max;
  return values.length === max - spec.min + 1;
}

/**
 * Whether values are every n-th from 0, n dividing the field's size (every 5 minutes : 0, 5, ...
 * 55), so a MINUTELY or HOURLY rule with that interval fires on them.
 *
 * Args:
 *   values (number[]): the values.
 *   size (number): the field's size (60, 24).
 *
 * Returns:
 *   number: n, or 0 when they are not.
 */
function evenStep(values, size) {
  if (values[0] !== 0 || values.length < 2) return 0;
  const n = values[1];
  if (size % n !== 0 || values.length !== size / n) return 0;
  return values.every((v, i) => v === i * n) ? n : 0;
}

/**
 * A cron as an iCal rrule that fires at exactly the same moments, in a zone, or why it cannot be.
 *
 * Args:
 *   cron (string): the cron (5 fields, or 6 with seconds first).
 *   zone (string): the zone the cron fires in (the scheduler's, LOG_TZ).
 *   now (Date): today, the rule's DTSTART day.
 *
 * Returns:
 *   object: { rrule } ; or { reason } when it cannot be written as a rrule.
 */
export function cronToRrule(cron, zone = "UTC", now = new Date()) {
  const parts = String(cron || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5 && parts.length !== 6) return { reason: "a cron has 5 or 6 fields" };
  if (parts.length === 5) parts.unshift("0");
  const [secText, minText, hourText, domText, monthText, dowText] = parts;
  if (dowText.startsWith("+")) return { reason: "'+' before the days of the week cannot be written as a rrule" };
  let sec, min, hour, dom, month, dow;
  try {
    sec = valuesOf(secText, "second");
    min = valuesOf(minText, "minute");
    hour = valuesOf(hourText, "hour");
    dom = valuesOf(domText, "dom");
    month = valuesOf(monthText, "month");
    dow = valuesOf(dowText, "dow");
  } catch (e) {
    return { reason: e.message };
  }
  // the days : a cron with both its day of the month and its day of the week restricted fires on
  // either ; a rrule only on both. Unless one of them covers every day, it cannot be written
  const domStar = domText === "*";
  const dowStar = dowText === "*";
  let byMonthDay = null;
  let byDay = null;
  if (!domStar && !dowStar) {
    if (full(dom, "dom") || full(dow, "dow")) {
      // one covers every day : the cron fires every day
    } else {
      return { reason: "both the day of the month and the day of the week are restricted: a cron fires on either, a rrule only on both" };
    }
  } else if (!domStar) {
    if (!full(dom, "dom")) byMonthDay = dom;
  } else if (!dowStar) {
    if (!full(dow, "dow")) byDay = dow;
  }
  const byMonth = full(month, "month") ? null : month;
  const filters = [];
  if (byMonth) filters.push(`BYMONTH=${byMonth.join(",")}`);
  if (byMonthDay) filters.push(`BYMONTHDAY=${byMonthDay.join(",")}`);
  if (byDay) filters.push(`BYDAY=${byDay.map((d) => BYDAY[d]).join(",")}`);

  const tz = DateTime.local().setZone(zone).isValid ? zone : "UTC";
  const day = DateTime.fromJSDate(now, { zone: tz }).toFormat("yyyyLLdd");
  const pad = (n) => String(n).padStart(2, "0");
  const start = (h, m, s) => `DTSTART;TZID=${tz}:${day}T${pad(h)}${pad(m)}${pad(s)}`;
  const rule = (freq, interval, extra = []) => `RRULE:${[`FREQ=${freq}`, `INTERVAL=${interval}`, ...extra].join(";")}`;

  // every N minutes, every N hours, every hour at a minute : no day or month restricted
  const single = (v) => v.length === 1;
  if (!filters.length && single(sec) && sec[0] === 0) {
    const everyMin = full(hour, "hour") ? evenStep(min, 60) : 0;
    if (everyMin) return { rrule: `${start(0, 0, 0)} ${rule("MINUTELY", everyMin)}` };
    if (single(min) && full(hour, "hour")) return { rrule: `${start(0, min[0], 0)} ${rule("HOURLY", 1)}` };
    const everyHour = single(min) ? evenStep(hour, 24) : 0;
    if (everyHour) return { rrule: `${start(0, min[0], 0)} ${rule("HOURLY", everyHour)}` };
  }
  // at one time of the day : daily, weekly on its weekdays, monthly on its days
  const freq = byDay ? "WEEKLY" : byMonthDay ? "MONTHLY" : "DAILY";
  if (single(sec) && single(min) && single(hour)) {
    return { rrule: `${start(hour[0], min[0], sec[0])} ${rule(freq, 1, filters)}` };
  }
  // anything else : every day (or its weekdays, its days), at each of its times
  const times = [`BYHOUR=${hour.join(",")}`, `BYMINUTE=${min.join(",")}`];
  if (!(single(sec) && sec[0] === 0)) times.push(`BYSECOND=${sec.join(",")}`);
  return { rrule: `${start(0, 0, 0)} ${rule("DAILY", 1, [...filters, ...times])}` };
}
