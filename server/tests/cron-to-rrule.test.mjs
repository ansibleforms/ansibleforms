// A cron written as the iCal rrule that fires at exactly the same moments (lib/cronToRrule.js),
// for an app schedule a schedules repository takes : its DTSTART in the scheduler's zone, so the
// wall clock times do not move. Each case is compared with croner itself, the scheduler that ran
// the cron : the next forty runs must be the same moments.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { Cron } from "croner";
import { cronToRrule } from "../src/lib/cronToRrule.js";
import { nextRuns, validateRrule } from "../src/lib/scheduleRrule.js";

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
