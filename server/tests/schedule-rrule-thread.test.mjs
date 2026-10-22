// The runs of a rrule are worked out in a thread of their own (lib/scheduleRrule.js) : a call
// that takes too long gives the rule up a while - a check refuses it, saying so, it is walked
// again after - a
// thread that stops is replaced at once, and a call awaited (nextRunsAsync) leaves the process
// free meanwhile.
import { test, describe, afterEach } from "vitest";
import assert from "node:assert/strict";
import { validateRrule, validateRruleAsync, nextRuns, nextRunsAsync, nextRun, limits, rruleThreads, TIMEOUT } from "../src/lib/scheduleRrule.js";

const DEFAULTS = { ...limits };
afterEach(() => Object.assign(limits, DEFAULTS));

// a rule walked for a while (a hundred milliseconds or so) : every minute, its EXRULE taking out
// every minute from October to February, so its next run after AFTER is the 1st of March, some
// 180000 minutes looked at first (each test its own, by the week start, which does not change
// its runs)
const busy = (wkst) =>
  `DTSTART;TZID=UTC:20160104T000000 RRULE:FREQ=MINUTELY;INTERVAL=1;WKST=${wkst} EXRULE:FREQ=MINUTELY;INTERVAL=1;BYMONTH=10,11,12,1,2`;
// a rule of its own for each test : the given up ones are remembered by their text
const daily = (hour) => `DTSTART;TZID=UTC:20200101T${String(hour).padStart(2, "0")}0000 RRULE:FREQ=DAILY;INTERVAL=1`;
const AFTER = new Date("2026-10-24T10:00:00Z");

describe("a call that takes too long", () => {
  test("refuses the rule when it is checked, saying so", async () => {
    limits.walkMs = 0;
    assert.match(validateRrule(daily(1))[0], /could not be worked out in 0 second: simplify it/);
    assert.match((await validateRruleAsync(busy("MO")))[0], /could not be worked out/);
    assert.equal(nextRun(daily(2)), null);
  });

  test("gives the rule up a while, then it is walked again", async () => {
    limits.walkMs = 0;
    limits.givenUpMs = 200;
    assert.throws(() => nextRuns(daily(3), { after: AFTER }), (e) => e.code === TIMEOUT);
    limits.walkMs = DEFAULTS.walkMs;
    // given up : at once, without walking it
    assert.throws(() => nextRuns(daily(3), { after: AFTER }), (e) => e.code === TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(nextRuns(daily(3), { after: AFTER })[0].toISOString(), "2026-10-25T03:00:00.000Z");
  });

  test("awaited, it gives up too, and the next call is served", async () => {
    limits.walkMs = 0;
    await assert.rejects(nextRunsAsync(busy("TU"), { after: AFTER }), (e) => e.code === TIMEOUT);
    limits.walkMs = DEFAULTS.walkMs;
    assert.equal((await nextRunsAsync(daily(4), { after: AFTER }))[0].toISOString(), "2026-10-25T04:00:00.000Z");
  });
});

describe("a thread that stops", () => {
  test("is replaced at the next call, which is not given up", async () => {
    nextRuns(daily(5), { after: AFTER });
    const { sync } = rruleThreads();
    assert.ok(sync);
    await sync.terminate();
    // its end is seen
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    assert.equal(nextRuns(daily(6), { after: AFTER })[0].toISOString(), "2026-10-25T06:00:00.000Z");
    assert.ok(Date.now() - started < limits.walkMs, `at once (${Date.now() - started} ms)`);
    assert.notEqual(rruleThreads().sync, sync);
  });

  test("ends the call it was answering, and the next call is served", async () => {
    await nextRunsAsync(daily(7), { after: AFTER });
    const pending = nextRunsAsync(busy("WE"), { after: AFTER });
    // the call sent, the thread stopped under it
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rruleThreads().async.terminate();
    await assert.rejects(pending, (e) => e.code !== TIMEOUT && /thread stopped/.test(e.message));
    assert.equal((await nextRunsAsync(busy("TH"), { after: AFTER }))[0].toISOString(), "2027-03-01T00:00:00.000Z");
  });
});

describe("an awaited thread that does not start in time", () => {
  test("fails its call, and the next call is served by a new one", async () => {
    await rruleThreads().async?.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    limits.startMs = 0;
    await assert.rejects(nextRunsAsync(daily(9), { after: AFTER }), (e) => e.code !== TIMEOUT && /did not start/.test(e.message));
    limits.startMs = DEFAULTS.startMs;
    assert.equal((await nextRunsAsync(daily(10), { after: AFTER }))[0].toISOString(), "2026-10-25T10:00:00.000Z");
  });
});

test("an awaited call leaves the process free while the runs are worked out", async () => {
  await nextRunsAsync(daily(8), { after: AFTER });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const started = Date.now();
  const runs = await nextRunsAsync(busy("FR"), { after: AFTER, count: 2 });
  const took = Date.now() - started;
  clearInterval(timer);
  assert.equal(runs.length, 2);
  // the timer kept ticking meanwhile
  assert.ok(ticks >= Math.floor(took / 5) / 3, `${ticks} ticks in ${took} ms`);
});
