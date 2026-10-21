// A schedule of a schedules repository is timed by its iCal rrule (lib/scheduleRrule.js) : refused
// where it is not valid, with the reason, and its runs worked out in its own time zone, across DST
// changes, with EXRULE, UNTIL and a start date years ago.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { validateRrule, nextRuns, nextRun, zoneOf, defaultRrule, normalizeRrule } from "../src/lib/scheduleRrule.js";

// before every run of the cases below, so the whole rule is walked
const LONG_AGO = new Date("2020-01-01T00:00:00Z");
const runs = (rrule, count = 10, after = LONG_AGO) => nextRuns(rrule, { after, count }).map((d) => d.toISOString());

describe("a refused rrule is refused, with the reason", () => {
  // [rrule, the reason it gives]
  const cases = [
    ["", "This field may not be blank"],
    ["DTSTART:NONSENSE", "Valid DTSTART required in rrule"],
    ["DTSTART:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1", "DTSTART cannot be a naive datetime"],
    ["DTSTART:20300308T050000Z DTSTART:20310308T050000", "Multiple DTSTART is not supported"],
    ["DTSTART:20300308T050000Z", "One or more rule required in rrule"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=MONTHLY;INTERVAL=1; EXDATE:20220401", "EXDATE not allowed in rrule"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=MONTHLY;INTERVAL=1; RDATE:20220401", "RDATE not allowed in rrule"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=YEARLY;INTERVAL=0;BYDAY=MO", "INTERVAL must be a positive integer"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=SECONDLY;INTERVAL=5;COUNT=6", "SECONDLY is not supported"],
    ["DTSTART:20300308T050000Z RRULE:NONSENSE", "INTERVAL required in rrule"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=5MO", "BYDAY with numeric prefix not supported"],
    ["DTSTART:20030925T104941Z RRULE:FREQ=DAILY;INTERVAL=10;COUNT=500;UNTIL=20040925T104941Z", "RRULE may not contain both COUNT and UNTIL"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2000", "COUNT > 999 is unsupported"],
    ["DTSTART:20300308T050000Z RRULE:NONSENSE RRULE:INTERVAL=1;FREQ=DAILY EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU", "INTERVAL required in rrule"],
    [
      "DTSTART:20300308T050000Z RRULE:INTERVAL=1;FREQ=DAILY EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=5MO",
      "BYDAY with numeric prefix not supported",
    ],
    ["DTSTART:NONSENSE RRULE:NONSENSE RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=3,4", "Valid DTSTART required in rrule"],
    ["DTSTART;TZID=US-Eastern:19961105T090000 RRULE:FREQ=MINUTELY;INTERVAL=10;COUNT=5", "A valid TZID must be provided"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=REGULARLY;INTERVAL=1", "rrule parsing failed validation: invalid 'FREQ': REGULARLY"],
    ["DTSTART;TZID=America/New_York:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1", "rrule parsing failed validation"],
    // the checks on what was read, whatever the case of the keys or the sign of a number
    ["DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=-1", "INTERVAL must be a positive integer"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=DAILY;interval=0", "INTERVAL must be a positive integer"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=MINUTELY;INTERVAL=1;count=100000000", "COUNT > 999 is unsupported"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;COUNT=0", "COUNT must be a positive integer"],
    ["DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;count=5;until=20310101T000000Z", "RRULE may not contain both COUNT and UNTIL"],
    // a rule that never fires
    ["DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20300101T000000Z", "never fires in the 50 years after its DTSTART"],
  ];
  for (const [rrule, reason] of cases) {
    test(`${rrule || "(empty)"} : ${reason}`, () => {
      const errors = validateRrule(rrule);
      assert.ok(errors.length, "refused");
      assert.ok(errors[0].includes(reason), `${errors[0]} says ${reason}`);
    });
  }

  test("a date-only UNTIL is refused", () => {
    assert.ok(validateRrule("DTSTART;TZID=Europe/Brussels:20300101T020000 RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20300201").length);
  });
});

describe("a valid rrule is taken", () => {
  for (const rrule of [
    "DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1",
    "DTSTART:20151117T050000Z RRULE:FREQ=DAILY;INTERVAL=1;COUNT=1",
    "DTSTART;TZID=America/New_York:20300302T150000 RRULE:INTERVAL=1;FREQ=DAILY;UNTIL=20300304T150000 EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU",
    "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
  ]) {
    test(rrule, () => assert.deepEqual(validateRrule(rrule), []));
  }
});

describe("its runs, in its own time zone", () => {
  test("UTC", () => {
    assert.deepEqual(runs("DTSTART:20300308T050000Z RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5"), [
      "2030-03-08T05:00:00.000Z",
      "2030-03-09T05:00:00.000Z",
      "2030-03-10T05:00:00.000Z",
      "2030-03-11T05:00:00.000Z",
      "2030-03-12T05:00:00.000Z",
    ]);
  });

  test("New York keeps 05:00 local across the DST change", () => {
    assert.deepEqual(runs("DTSTART;TZID=America/New_York:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5"), [
      "2030-03-08T10:00:00.000Z",
      "2030-03-09T10:00:00.000Z",
      "2030-03-10T09:00:00.000Z",
      "2030-03-11T09:00:00.000Z",
      "2030-03-12T09:00:00.000Z",
    ]);
  });

  test("Phoenix has no DST", () => {
    assert.deepEqual(runs("DTSTART;TZID=America/Phoenix:20300308T050000 RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5"), [
      "2030-03-08T12:00:00.000Z",
      "2030-03-09T12:00:00.000Z",
      "2030-03-10T12:00:00.000Z",
      "2030-03-11T12:00:00.000Z",
      "2030-03-12T12:00:00.000Z",
    ]);
  });

  test("a time the DST change skips is left out", () => {
    assert.deepEqual(runs("DTSTART;TZID=America/New_York:20300303T023000 RRULE:FREQ=WEEKLY;BYDAY=SU;INTERVAL=1;COUNT=3"), [
      "2030-03-03T07:30:00.000Z",
      "2030-03-17T06:30:00.000Z",
    ]);
  });

  test("the hour the clock goes back is not run twice", () => {
    assert.deepEqual(runs("DTSTART;TZID=America/New_York:20301102T233000 RRULE:FREQ=HOURLY;INTERVAL=1;COUNT=5"), [
      "2030-11-03T03:30:00.000Z", // 23:30 -04:00
      "2030-11-03T04:30:00.000Z", // 00:30 -04:00
      "2030-11-03T05:30:00.000Z", // 01:30 -04:00
      "2030-11-03T07:30:00.000Z", // 02:30 -05:00
      "2030-11-03T08:30:00.000Z", // 03:30 -05:00
    ]);
  });

  test("Brussels : a nightly 02:00 stays 02:00 when summer time ends", () => {
    assert.deepEqual(runs("DTSTART;TZID=Europe/Brussels:20261024T020000 RRULE:FREQ=DAILY;INTERVAL=1;COUNT=3"), [
      "2026-10-24T00:00:00.000Z", // 02:00 CEST
      "2026-10-25T00:00:00.000Z", // 02:00 CEST : the clock shows 02:00 twice, the first is run
      "2026-10-26T01:00:00.000Z", // 02:00 CET
    ]);
  });

  test("the first Saturday of the month, by the local day", () => {
    assert.deepEqual(runs("DTSTART;TZID=America/New_York:20300112T210000 RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=SA;BYSETPOS=1;COUNT=4"), [
      "2030-02-03T02:00:00.000Z",
      "2030-03-03T02:00:00.000Z",
      "2030-04-07T01:00:00.000Z",
      "2030-05-05T01:00:00.000Z",
    ]);
  });

  test("an EXRULE takes runs out, and a naive UNTIL is read in the DTSTART's zone", () => {
    assert.deepEqual(
      runs("DTSTART;TZID=America/New_York:20300302T150000 RRULE:INTERVAL=1;FREQ=DAILY;UNTIL=20300304T150000 EXRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU"),
      ["2030-03-02T20:00:00.000Z", "2030-03-04T20:00:00.000Z"],
    );
    assert.deepEqual(
      runs("DTSTART;TZID=US/Eastern:20300428T170000 RRULE:INTERVAL=1;FREQ=DAILY;COUNT=4 EXRULE:INTERVAL=1;FREQ=DAILY;BYMONTH=4;BYMONTHDAY=30"),
      ["2030-04-28T21:00:00.000Z", "2030-04-29T21:00:00.000Z", "2030-05-01T21:00:00.000Z"],
    );
  });

  test("an UNTIL ending in Z is the UTC moment it names", () => {
    // 20:00Z is 15:00 in New York : the run of the 4th at 15:00 is the last
    assert.deepEqual(runs("DTSTART;TZID=America/New_York:20300302T150000 RRULE:INTERVAL=1;FREQ=DAILY;UNTIL=20300304T200000Z"), [
      "2030-03-02T20:00:00.000Z",
      "2030-03-03T20:00:00.000Z",
      "2030-03-04T20:00:00.000Z",
    ]);
  });

  test("a minutely rule from years ago is walked from now, at once", () => {
    const now = new Date();
    const started = Date.now();
    const next = nextRuns("DTSTART;TZID=America/New_York:20051231T000030 RRULE:FREQ=MINUTELY;INTERVAL=15", { after: now, count: 10 });
    assert.ok(Date.now() - started < 1000, "fast");
    assert.equal(next.length, 10);
    assert.ok(next[0] > now && next[0] - now <= 15 * 60000, "the first run is within one interval");
    for (let i = 1; i < next.length; i++) {
      assert.equal(next[i] - next[i - 1], 15 * 60000);
      assert.equal(next[i].getUTCSeconds(), 30);
    }
  });

  test("the next run : after the moment asked, none once the rule ended", () => {
    const rrule = "DTSTART;TZID=Europe/Brussels:20300101T020000 RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2";
    assert.equal(nextRun(rrule, new Date("2030-01-01T01:00:00Z")).toISOString(), "2030-01-02T01:00:00.000Z");
    assert.equal(nextRun(rrule, new Date("2030-01-03T00:00:00Z")), null);
    assert.equal(nextRun("not a rrule"), null);
  });
});

describe("a rule rrule.js would walk for ever never blocks the process", () => {
  // its times never meet its BYHOUR or BYMINUTE (rrule.js loops for ever), or no day is ever
  // kept (walked to the year 9999) : refused, and its runs given up after a second
  const rules = [
    "DTSTART:20260101T000000Z RRULE:FREQ=DAILY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=30",
    "DTSTART:20260101T000000Z RRULE:FREQ=HOURLY;INTERVAL=2;BYHOUR=1",
    "DTSTART:20260101T000000Z RRULE:FREQ=MINUTELY;INTERVAL=60;BYMINUTE=30",
  ];
  for (const rrule of rules) {
    test(rrule, { timeout: 10000 }, () => {
      const started = Date.now();
      const errors = validateRrule(rrule);
      assert.ok(errors.length, "refused");
      assert.match(errors[0], /No run of this rrule could be worked out|never fires/);
      // its runs : given up, at once once known
      assert.throws(() => nextRuns(rrule, { after: new Date("2026-10-22T10:00:00Z"), count: 3 }), /No run of this rrule could be worked out/);
      assert.equal(nextRun(rrule), null);
      assert.ok(Date.now() - started < 3000, `given up in time (${Date.now() - started} ms)`);
    });
  }

  test("the next rule is served after one was given up", () => {
    assert.equal(nextRun("DTSTART:20300101T000000Z RRULE:FREQ=DAILY;INTERVAL=1", new Date("2030-01-01T12:00:00Z")).toISOString(), "2030-01-02T00:00:00.000Z");
  });
});

describe("helpers", () => {
  test("its zone : the TZID, UTC for a Z", () => {
    assert.equal(zoneOf("DTSTART;TZID=Europe/Brussels:20300101T020000 RRULE:FREQ=DAILY;INTERVAL=1"), "Europe/Brussels");
    assert.equal(zoneOf("DTSTART:20300101T020000Z RRULE:FREQ=DAILY;INTERVAL=1"), "UTC");
    assert.equal(zoneOf("nonsense"), null);
  });

  test("a new schedule's rrule : daily at midnight from today, in the zone given, valid", () => {
    const rrule = defaultRrule("Europe/Brussels", new Date("2026-10-20T10:00:00Z"));
    assert.equal(rrule, "DTSTART;TZID=Europe/Brussels:20261020T000000 RRULE:FREQ=DAILY;INTERVAL=1");
    assert.deepEqual(validateRrule(rrule), []);
  });

  test("written on one line, its parts apart by one space", () => {
    assert.equal(normalizeRrule("  DTSTART:20300101T000000Z\n  RRULE:FREQ=DAILY;INTERVAL=1 "), "DTSTART:20300101T000000Z RRULE:FREQ=DAILY;INTERVAL=1");
  });
});
