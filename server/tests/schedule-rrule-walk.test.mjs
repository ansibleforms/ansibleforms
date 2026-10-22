// The runs of a rrule are walked from now, never from a DTSTART of years ago, and give the runs a
// walk from the DTSTART gives (lib/scheduleRrule.js walkRuns) : every rule period by period here,
// from the period now is in - rrule.js loses its way in a minutely or hourly rule whose days and
// hours are both filtered (Monday to Friday, 9 to 17), skipping days or walking for ever, takes
// the first run for a BYSETPOS counted from the end past a period's runs, and keeps a BYEASTER in
// periods the INTERVAL never reaches.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import rrulePkg from "rrule";
import { walkRuns, nextRuns, validateRrule } from "../src/lib/scheduleRrule.js";

const { RRule, RRuleSet } = rrulePkg;

// the moments the runs are asked after
const AFTER = ["2026-10-22T10:17:00Z", "2026-10-24T00:00:00Z", "2027-02-28T23:59:59Z", "2028-12-31T12:00:00Z"].map((d) => new Date(d));

const iso = (dates) => dates.map((d) => d.toISOString());

/**
 * The runs rrule.js gives walking a rule from its DTSTART (in UTC, which has no DST) : what a
 * walk from now must give.
 *
 * Args:
 *   rrule (string): the rrule (DTSTART:...Z RRULE:... [EXRULE:...]).
 *   after (Date): the moment.
 *   count (number): how many.
 *
 * Returns:
 *   string[]: the runs, ISO.
 */
function fromDtstart(rrule, after, count) {
  const [dtstart, ...rules] = rrule.split(" ");
  const m = dtstart.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  const start = new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]));
  const set = new RRuleSet();
  for (const rule of rules) {
    const [kind, text] = rule.split(/:(.*)/);
    const r = new RRule({ ...RRule.parseString(text), dtstart: start });
    if (kind === "RRULE") set.rrule(r);
    else set.exrule(r);
  }
  const runs = [];
  set.between(after, new Date(after.getTime() + 60 * 366 * 86400000), false, (d) => {
    runs.push(d);
    return runs.length < count;
  });
  return iso(runs);
}

/**
 * The runs of a minutely or hourly rule found the long way : every step of its interval from its
 * DTSTART, kept when its weekday, month, day of the month, hour and minute are.
 *
 * Args:
 *   rrule (string): the rrule, in UTC, its rule FREQ, INTERVAL and BYDAY, BYMONTH, BYMONTHDAY,
 *     BYHOUR, BYMINUTE.
 *   after (Date): the moment.
 *   count (number): how many.
 *
 * Returns:
 *   string[]: the runs, ISO.
 */
function stepByStep(rrule, after, count) {
  const [dtstart, rule] = rrule.split(" ");
  const m = dtstart.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  let t = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]);
  const parts = Object.fromEntries(rule.replace("RRULE:", "").split(";").map((p) => p.split("=")));
  const step = Number(parts.INTERVAL) * (parts.FREQ === "HOURLY" ? 3600000 : 60000);
  const set = (key, map = Number) => (parts[key] ? new Set(parts[key].split(",").map(map)) : null);
  const days = set("BYDAY", (d) => ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(d));
  const months = set("BYMONTH");
  const monthDays = set("BYMONTHDAY");
  const hours = set("BYHOUR");
  const minutes = set("BYMINUTE");
  const runs = [];
  for (let i = 0; runs.length < count && i < 2e7; i++, t += step) {
    const d = new Date(t);
    if (t <= after.getTime()) continue;
    if (days && !days.has(d.getUTCDay())) continue;
    if (months && !months.has(d.getUTCMonth() + 1)) continue;
    if (monthDays && !monthDays.has(d.getUTCDate())) continue;
    if (hours && !hours.has(d.getUTCHours())) continue;
    if (minutes && !minutes.has(d.getUTCMinutes())) continue;
    runs.push(d.toISOString());
  }
  return runs;
}

describe("a weekly, monthly or yearly rule from years ago gives the runs its DTSTART gives", () => {
  const rules = [
    "DTSTART:20160104T080000Z RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8,9,10,11,12,13,14,15,16,17,18;BYMINUTE=0,15,30,45",
    "DTSTART:20170103T063000Z RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SA",
    "DTSTART:20170103T063000Z RRULE:FREQ=WEEKLY;INTERVAL=3;WKST=SU;BYDAY=SU,MO",
    "DTSTART:20180105T120000Z RRULE:FREQ=WEEKLY;INTERVAL=1",
    "DTSTART:20180131T090000Z RRULE:FREQ=MONTHLY;INTERVAL=1",
    "DTSTART:20180131T090000Z RRULE:FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=-1,15",
    "DTSTART:20190312T000000Z RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "DTSTART:20190312T000000Z RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=SA;BYSETPOS=1;BYHOUR=6,18",
    "DTSTART:20160229T101010Z RRULE:FREQ=YEARLY;INTERVAL=1",
    "DTSTART:20150601T000000Z RRULE:FREQ=YEARLY;INTERVAL=3;BYMONTH=2,8;BYMONTHDAY=1,28",
    "DTSTART:20150601T000000Z RRULE:FREQ=YEARLY;INTERVAL=1;BYWEEKNO=1,53;BYDAY=MO",
    "DTSTART:20150601T000000Z RRULE:FREQ=YEARLY;INTERVAL=2;BYYEARDAY=1,-1,100",
    "DTSTART:20180101T020000Z RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR EXRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1,2,3,4,5,6,7",
    "DTSTART:20180101T020000Z RRULE:FREQ=DAILY;INTERVAL=3;BYMONTH=1,6;BYHOUR=2,14",
    "DTSTART:20180101T020000Z RRULE:FREQ=DAILY;INTERVAL=1;BYDAY=SA,SU;BYSETPOS=2;BYHOUR=1,2,3",
  ];
  for (const rrule of rules) {
    // rrule.js walks from the DTSTART : a while
    test(rrule, { timeout: 60000 }, () => {
      for (const after of AFTER) {
        assert.deepEqual(iso(walkRuns(rrule, { after, count: 6 })), fromDtstart(rrule, after, 6), `after ${after.toISOString()}`);
      }
    });
  }

  test("an office-hours rule from 2016 is worked out at once, not given up", () => {
    const rrule = `DTSTART;TZID=UTC:20160104T000000 RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${[...Array(24).keys()].join(",")};BYMINUTE=${[...Array(60).keys()].join(",")}`;
    assert.deepEqual(iso(nextRuns(rrule, { after: new Date("2026-10-24T10:00:00Z"), count: 2 })), ["2026-10-26T00:00:00.000Z", "2026-10-26T00:01:00.000Z"]);
    assert.deepEqual(validateRrule(rrule), []);
  });
});

describe("a minutely or hourly rule whose days and hours are filtered", () => {
  const office = "BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16,17";

  test("one that starts on a weekend is taken", () => {
    for (const start of ["20261024T000000", "20261025T000000", "20261024T090000", "20261023T220000"]) {
      for (const rule of [`FREQ=MINUTELY;INTERVAL=5;${office}`, "FREQ=HOURLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8,12,18"]) {
        assert.deepEqual(validateRrule(`DTSTART;TZID=Europe/Brussels:${start} RRULE:${rule}`), [], `${start} ${rule}`);
      }
    }
  });

  test("walked from a weekend, the next run is Monday morning", () => {
    const rrule = `DTSTART;TZID=Europe/Brussels:20261020T090000 RRULE:FREQ=MINUTELY;INTERVAL=5;${office}`;
    for (const after of ["2026-10-23T16:00:00Z", "2026-10-23T22:30:00Z", "2026-10-24T10:00:00Z"]) {
      assert.equal(nextRuns(rrule, { after: new Date(after) })[0].toISOString(), "2026-10-26T08:00:00.000Z", after);
    }
    assert.deepEqual(iso(nextRuns("DTSTART;TZID=UTC:20261020T090000 RRULE:FREQ=MINUTELY;INTERVAL=5;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9", { after: new Date("2026-10-24T10:00:00Z"), count: 3 })), [
      "2026-10-26T09:00:00.000Z",
      "2026-10-26T09:05:00.000Z",
      "2026-10-26T09:10:00.000Z",
    ]);
  });

  const rules = [
    `DTSTART:20261024T000000Z RRULE:FREQ=MINUTELY;INTERVAL=5;${office}`,
    "DTSTART:20261020T090000Z RRULE:FREQ=MINUTELY;INTERVAL=5;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9",
    "DTSTART:20261024T000000Z RRULE:FREQ=MINUTELY;INTERVAL=15;BYDAY=SA,SU",
    "DTSTART:20261024T000000Z RRULE:FREQ=MINUTELY;INTERVAL=30;BYHOUR=22,23,0,1",
    "DTSTART:20261024T000700Z RRULE:FREQ=MINUTELY;INTERVAL=7;BYHOUR=9,11;BYDAY=TU",
    "DTSTART:20261024T000000Z RRULE:FREQ=MINUTELY;INTERVAL=90;BYHOUR=9,10,11",
    "DTSTART:20261024T000000Z RRULE:FREQ=MINUTELY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=29;BYHOUR=0;BYMINUTE=0,1",
    "DTSTART:20261024T030000Z RRULE:FREQ=HOURLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8,12,18",
    "DTSTART:20261024T030000Z RRULE:FREQ=HOURLY;INTERVAL=5;BYDAY=WE;BYHOUR=3,8,13",
    "DTSTART:20161024T030000Z RRULE:FREQ=HOURLY;INTERVAL=7;BYMONTHDAY=1,15",
  ];
  for (const rrule of rules) {
    test(`step by step : ${rrule}`, { timeout: 60000 }, () => {
      for (const after of AFTER) {
        assert.deepEqual(iso(walkRuns(rrule, { after, count: 4 })), stepByStep(rrule, after, 4), `after ${after.toISOString()}`);
      }
    });
  }
});

describe("a rule rrule.js reads otherwise than dateutil gives dateutil's runs", () => {
  // each rule, and its first runs as python-dateutil gives them
  const cases = [
    // the first Saturday of the months with five : none in a month with four
    ["DTSTART:20260101T090000Z RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=SA;BYSETPOS=-5", ["2026-01-03T09:00:00.000Z", "2026-05-02T09:00:00.000Z", "2026-08-01T09:00:00.000Z", "2026-10-03T09:00:00.000Z"]],
    ["DTSTART:20260101T090000Z RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-23", ["2026-07-01T09:00:00.000Z", "2026-12-01T09:00:00.000Z", "2027-03-01T09:00:00.000Z", "2027-12-01T09:00:00.000Z"]],
    // BYEASTER only in the months and weeks the INTERVAL reaches
    ["DTSTART:20231006T010050Z RRULE:FREQ=MONTHLY;INTERVAL=7;BYEASTER=-3;BYHOUR=1", ["2034-04-06T01:00:50.000Z", "2041-04-18T01:00:50.000Z", "2048-04-02T01:00:50.000Z", "2051-03-30T01:00:50.000Z"]],
    ["DTSTART:20250330T000013Z RRULE:FREQ=MONTHLY;INTERVAL=3;BYEASTER=-1", ["2027-03-27T00:00:13.000Z", "2029-03-31T00:00:13.000Z", "2032-03-27T00:00:13.000Z", "2035-03-24T00:00:13.000Z"]],
    ["DTSTART:20260119T023032Z RRULE:FREQ=WEEKLY;INTERVAL=7;BYEASTER=0", ["2032-03-28T02:30:32.000Z", "2043-03-29T02:30:32.000Z", "2054-03-29T02:30:32.000Z", "2056-04-02T02:30:32.000Z"]],
  ];
  for (const [rrule, runs] of cases) {
    test(rrule, () => {
      assert.deepEqual(iso(walkRuns(rrule, { fromStart: true, count: 4 })), runs);
    });
  }

  test("a week a BYMONTH leaves one day of has no second-to-last run", () => {
    const rrule = "DTSTART;TZID=UTC:20260702T013000 RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,FR;BYMONTH=11,12;BYSETPOS=-2";
    assert.deepEqual(iso(walkRuns(rrule, { after: new Date("2028-10-01T00:00:00Z"), count: 2 })), ["2028-11-07T01:30:00.000Z", "2028-11-14T01:30:00.000Z"]);
  });
});

describe("a minutely rule with a COUNT", () => {
  // half a million runs a year : only the COUNT of them taken
  test("its runs are its first COUNT minutes, and it is valid", () => {
    const rrule = "DTSTART;TZID=Europe/Brussels:20261022T090000 RRULE:FREQ=MINUTELY;INTERVAL=1;COUNT=10";
    assert.deepEqual(validateRrule(rrule), []);
    assert.deepEqual(iso(walkRuns(rrule, { after: new Date("2026-10-22T07:05:30Z"), count: 3 })), ["2026-10-22T07:06:00.000Z", "2026-10-22T07:07:00.000Z", "2026-10-22T07:08:00.000Z"]);
    assert.deepEqual(walkRuns(rrule, { after: new Date("2026-10-22T07:09:00Z") }), []);
  });

  test("its BYSETPOS picks among the times of each minute", () => {
    const rrule = "DTSTART;TZID=Australia/Sydney:20271002T183000 RRULE:FREQ=MINUTELY;INTERVAL=1;BYSETPOS=1;COUNT=19";
    assert.deepEqual(validateRrule(rrule), []);
    assert.equal(walkRuns(rrule, { fromStart: true, count: 30 }).length, 19);
  });
});
