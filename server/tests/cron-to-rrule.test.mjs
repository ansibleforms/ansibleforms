// A cron written as the iCal rrule that fires at exactly the same moments (lib/cronToRrule.js),
// for an app schedule a schedules repository takes : its DTSTART in the scheduler's zone, so the
// wall clock times do not move. Each case is compared with croner itself, the scheduler that ran
// the cron : the next forty runs must be the same moments.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Cron } from "croner";
import { DateTime } from "luxon";
import { cronToRrule } from "../src/lib/cronToRrule.js";
import { nextRuns, validateRrule, walkRuns } from "../src/lib/scheduleRrule.js";

const ZONE = "Europe/Brussels";
// a day with no DST change in the forty runs that follow
const NOW = new Date("2026-11-10T09:17:23Z");

/**
 * The next runs of a cron as croner fires it, in the zone.
 */
function cronRuns(cron, count = 40) {
  const task = new Cron(cron, { timezone: ZONE, paused: true });
  const runs = [];
  let at = NOW;
  for (let i = 0; i < count; i++) {
    at = task.nextRun(at);
    runs.push(at.toISOString());
  }
  task.stop();
  return runs;
}

describe("a cron becomes a rrule that fires at the same moments", () => {
  const cases = [
    ["every 5 minutes", "*/5 * * * *", /RRULE:FREQ=MINUTELY;INTERVAL=5$/],
    ["every 7 minutes (no even step : each hour starts again)", "*/7 * * * *", /BYMINUTE=0,7,14,21,28,35,42,49,56/],
    ["every hour", "0 * * * *", /RRULE:FREQ=HOURLY;INTERVAL=1$/],
    ["every 6 hours at :15", "15 */6 * * *", /T001500 RRULE:FREQ=HOURLY;INTERVAL=6$/],
    ["daily at 02:30", "30 2 * * *", /T023000 RRULE:FREQ=DAILY;INTERVAL=1$/],
    ["weekdays at 08:00", "0 8 * * 1-5", /RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR$/],
    ["weekdays by name", "0 8 * * MON-FRI", /BYDAY=MO,TU,WE,TH,FR$/],
    ["Sunday as 0", "0 0 * * 0", /BYDAY=SU$/],
    ["Sunday as 7", "0 0 * * 7", /BYDAY=SU$/],
    ["monthly on the 1st", "0 0 1 * *", /RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1$/],
    ["monthly on the 1st and the 15th", "0 0 1,15 * *", /BYMONTHDAY=1,15$/],
    ["every other day of the month", "5 4 */2 * *", /BYMONTHDAY=1,3,5,/],
    ["a list of months", "0 6 * 1,4,7,10 *", /BYMONTH=1,4,7,10$/],
    ["months by name", "0 6 1 JAN,JUL *", /BYMONTH=1,7;BYMONTHDAY=1$/],
    ["ranges and steps", "10-20/5 9-17 * * MON-FRI", /BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,10,11,12,13,14,15,16,17;BYMINUTE=10,15,20$/],
    ["a range with a step", "5-55/10 * * * *", /BYMINUTE=5,15,25,35,45,55$/],
    ["with seconds", "30 0 0 * * *", /T000030 RRULE:FREQ=DAILY;INTERVAL=1$/],
    ["several seconds", "*/10 30 4 * * *", /BYSECOND=0,10,20,30,40,50$/],
    ["every day of the month or Monday : every day", "0 0 1-31 * 1", /RRULE:FREQ=DAILY;INTERVAL=1$/],
  ];
  for (const [label, cron, shape] of cases) {
    test(`${label} : ${cron}`, () => {
      const { rrule, reason } = cronToRrule(cron, ZONE, NOW);
      assert.ok(rrule, reason);
      assert.match(rrule, shape);
      assert.ok(rrule.startsWith(`DTSTART;TZID=${ZONE}:20261110T`), "in the scheduler's zone, from today");
      assert.deepEqual(validateRrule(rrule), [], "a valid rrule");
      assert.deepEqual(
        nextRuns(rrule, { after: NOW, count: 40 }).map((d) => d.toISOString()),
        cronRuns(cron),
        "the same next runs",
      );
    });
  }
});

describe("a cron written as a rrule years ago still has its next runs at once", () => {
  // its DTSTART the day the schedules repository took it : the rule is walked from now, not from
  // then, whatever its shape
  const LONG_AGO = new Date("2016-03-01T10:00:00Z");
  for (const cron of ["*/7 * * * *", "*/10 * * * * *", "10-20/5 9-17 * * MON-FRI", "*/5 * * * *", "30 2 * * *"]) {
    test(cron, () => {
      const { rrule } = cronToRrule(cron, ZONE, LONG_AGO);
      assert.ok(rrule.startsWith(`DTSTART;TZID=${ZONE}:20160301T`));
      const started = Date.now();
      const runs = nextRuns(rrule, { after: NOW, count: 40 }).map((d) => d.toISOString());
      assert.ok(Date.now() - started < 500, `fast (${Date.now() - started} ms)`);
      assert.deepEqual(runs, cronRuns(cron), "the same next runs");
    });
  }
});

describe("a cron a rrule cannot express is refused, saying why", () => {
  const cases = [
    ["the day of the month and the day of the week both restricted (OR against AND)", "0 0 1 * 1", "both the day of the month and the day of the week"],
    ["the last day of the month", "0 0 L * *", "cannot be written as a rrule"],
    ["the nth weekday", "0 0 * * 1#2", "cannot be written as a rrule"],
    ["a question mark", "0 0 ? * 1", "cannot be written as a rrule"],
    ["weekdays ANDed with +", "0 0 1 * +1", "'+'"],
    ["a year field", "0 0 0 1 1 * 2030", "5 or 6 fields"],
    ["a range that goes backwards", "0 0 * * 5-1", "goes backwards"],
    ["out of range", "61 * * * *", "out of range"],
  ];
  for (const [label, cron, reason] of cases) {
    test(label, () => {
      const out = cronToRrule(cron, ZONE, NOW);
      assert.equal(out.rrule, undefined);
      assert.ok(out.reason.includes(reason), out.reason);
    });
  }
});

describe("across a DST change, the rrule fires when croner fires the cron", () => {
  // the nights the clock goes forward (02:00 to 03:00) and back (03:00 to 02:00) in Brussels
  const NIGHTS = [new Date("2027-03-27T12:00:00Z"), new Date("2026-10-24T12:00:00Z")];
  const crons = ["30 2 * * *", "0 2 * * *", "15 2 * * 0", "0 * * * *", "*/30 * * * *", "30 1,2,3 * * *", "0 2 28 3 *"];
  for (const cron of crons) {
    test(cron, () => {
      for (const after of NIGHTS) {
        const task = new Cron(cron, { timezone: ZONE, paused: true });
        // a moment croner lists twice (02:30 moved onto 03:30) is one run
        const expected = [...new Set(task.nextRuns(8, after).map((d) => d.toISOString()))].slice(0, 6);
        task.stop();
        const { rrule } = cronToRrule(cron, ZONE, new Date("2026-01-05T12:00:00Z"));
        assert.deepEqual(
          nextRuns(rrule, { after, count: 6 }).map((d) => d.toISOString()),
          expected,
          `after ${after.toISOString()}`,
        );
      }
    });
  }
});

describe("random crons become rrules that fire as croner fires them, a DST change among their runs", () => {
  // seeded : the same crons each run
  let seed = 20261022;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const between = (a, b) => a + Math.floor(random() * (b - a + 1));
  // a field : a star, a step, a value, a range, a range with a step, a name, a list
  const field = (min, max, names) => {
    const r = random();
    if (r < 0.35) return "*";
    if (r < 0.5) return `*/${between(2, Math.min(15, max))}`;
    if (r < 0.65) return `${between(min, max)}`;
    const a = between(min, max - 1);
    if (r < 0.75) return `${a}-${between(a, max)}`;
    if (r < 0.85) return `${a}-${between(a, max)}/${between(2, 5)}`;
    if (r < 0.9 && names) return names[between(0, names.length - 1)];
    return [...new Set([between(min, max), between(min, max), between(min, max)])].join(",");
  };
  // not Pacific/Chatham : its clock goes from 02:45 to 03:45, and croner leaves out the 03:45 to
  // 03:59 that do exist that night, a rrule keeps them
  const zones = ["UTC", "Europe/Brussels", "America/New_York", "Australia/Lord_Howe", "America/Santiago", "Asia/Kolkata", "Australia/Sydney"];
  // the offset of a zone at a moment, in minutes
  const offset = (ms, zone) => DateTime.fromMillis(ms, { zone }).offset;
  const cases = [];
  while (cases.length < 150) {
    const seconds = random() < 0.2 ? `${field(0, 59)} ` : "";
    // the hours a DST change moves, often
    const hour = random() < 0.5 ? `${between(0, 3)}` : field(0, 23);
    const cron = `${seconds}${field(0, 59)} ${hour} ${field(1, 31)} ${field(1, 12, ["JAN", "MAR", "OCT"])} ${field(0, 7, ["MON", "SUN", "SAT"])}`;
    const zone = zones[between(0, zones.length - 1)];
    // a few hours before the zone's next DST change
    let t = Date.UTC(2026, 9, 22) + between(0, 3 * 365) * 86400000;
    for (let k = 0; k < 400 && offset(t + 86400000, zone) === offset(t, zone); k++) t += 86400000;
    for (let k = 0; k < 24 && offset(t + 3600000, zone) === offset(t, zone); k++) t += 3600000;
    const now = new Date(t - between(0, 6 * 3600) * 1000);
    const converted = cronToRrule(cron, zone, now);
    if (converted.rrule) cases.push({ cron, zone, now, rrule: converted.rrule });
  }
  for (const { cron, zone, now, rrule } of cases) {
    test(`${cron} in ${zone} from ${now.toISOString()}`, () => {
      const task = new Cron(cron, { timezone: zone, paused: true });
      const want = task.nextRuns(10, now).map((d) => d.toISOString());
      task.stop();
      assert.deepEqual(walkRuns(rrule, { after: now, count: 10 }).map((d) => d.toISOString()), want, rrule);
    });
  }
});
