// A repository schedule is timed by its rrule (cron.service.js addRruleSchedule) : a one-shot task
// at its next run, in the rrule's own zone, that queues it the way a cron task does - once, not
// when it is turned off or already queued or running, only in the process holding the worker
// lock - and then registers the run after it. The launch itself is claimed once whatever process
// reads the queue (Schedule.launch, tests/planned-jobs and schedule-state).
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// each task captured with the moment it is for, instead of a timer
let tasks;
vi.mock("croner", () => ({
  Cron: class {
    constructor(pattern, opts, fn) {
      this.pattern = pattern;
      this.fn = fn;
      this.stopped = false;
      tasks.push(this);
    }
    stop() {
      this.stopped = true;
    }
    resume() {}
    // never running : a stop has nothing to wait for
    isBusy() {
      return false;
    }
    nextRun() {
      return this.pattern instanceof Date ? this.pattern : null;
    }
  },
}));

// the schedule row and the statements the queueing runs
let row;
let queued;
let schedules;
vi.mock("../src/models/db.model.js", () => {
  const run = async (sql) => {
    if (/^SELECT id\b[^]*? FROM AnsibleForms.`schedule` WHERE id=\? AND COALESCE\(enabled,1\)=1/.test(sql)) {
      return row.enabled && !["queued", "running"].includes(row.state) ? [{ id: row.id }] : [];
    }
    if (/^UPDATE AnsibleForms.`schedule` SET state='queued'/.test(sql)) {
      queued++;
      row.state = "queued";
      return { affectedRows: 1 };
    }
    if (/FROM AnsibleForms.`schedule`/.test(sql)) return schedules;
    return [];
  };
  // the queueing runs its statement again on a deadlock (Schedule.queue)
  return { default: { do: run, doRetryingDeadlock: run, tryDo: async () => [] } };
});
let held = true;
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => held }));

const { default: cronService } = await import("../src/services/cron.service.js");
const { limits, rruleThreads } = await import("../src/lib/scheduleRrule.js");
const LIMITS = { ...limits };

const RRULE = "DTSTART;TZID=Europe/Brussels:20200101T020000 RRULE:FREQ=DAILY;INTERVAL=1";
const live = () => tasks.filter((t) => !t.stopped);

beforeEach(() => {
  tasks = [];
  queued = 0;
  held = true;
  row = { id: 7, name: "Nightly", enabled: 1, state: "idle" };
  schedules = [{ id: 7, name: "Nightly", one_time_run: null, cron: null, rrule: RRULE }];
  cronService.active = true;
});
afterEach(async () => {
  Object.assign(limits, LIMITS);
  await cronService.stopAll();
  cronService.active = false;
  cronService.signatures.schedules.clear();
});

describe("a rrule schedule is registered at its next run", () => {
  test("the resync registers it at the rrule's next run, 02:00 in Brussels", async () => {
    await cronService.resync();
    const [task] = live();
    assert.ok(task.pattern instanceof Date);
    assert.ok(task.pattern > new Date());
    // 02:00 Brussels is 00:00 or 01:00 UTC, summer or winter
    assert.equal(task.pattern.getUTCMinutes(), 0);
    assert.ok([0, 1].includes(task.pattern.getUTCHours()));
    assert.equal(cronService.jobs.schedules.get(7), task);
  });

  test("when it fires it is queued once, and the run after it is registered", async () => {
    // in UTC : a day apart whatever the date the test runs on
    schedules = [{ ...schedules[0], rrule: "DTSTART;TZID=UTC:20200101T020000 RRULE:FREQ=DAILY;INTERVAL=1" }];
    await cronService.resync();
    const [first] = live();
    await first.fn();
    assert.equal(queued, 1);
    const [second] = live();
    assert.notEqual(second, first);
    assert.ok(second.pattern > first.pattern, "the next run, after this one");
    assert.equal(second.pattern - first.pattern, 24 * 3600 * 1000, "a day later");
  });

  test("still queued or running when it fires again : not queued twice", async () => {
    await cronService.resync();
    await live()[0].fn();
    // the queue has not launched it yet
    await live()[0].fn();
    assert.equal(queued, 1);
  });

  test("turned off : not queued, still registered for later", async () => {
    row.enabled = 0;
    await cronService.resync();
    await live()[0].fn();
    assert.equal(queued, 0);
    assert.equal(live().length, 1);
  });

  test("a process without the worker lock queues nothing, and keeps its next run", async () => {
    held = false;
    await cronService.resync();
    await live()[0].fn();
    assert.equal(queued, 0);
    assert.equal(live().length, 1);
  });

  test("an unchanged rrule is left registered ; a changed one is registered again", async () => {
    await cronService.resync();
    const before = live()[0];
    await cronService.resync();
    assert.equal(live()[0], before);
    schedules = [{ ...schedules[0], rrule: "DTSTART;TZID=UTC:20200101T060000 RRULE:FREQ=DAILY;INTERVAL=1" }];
    await cronService.resync();
    assert.notEqual(live()[0], before);
    assert.equal(live()[0].pattern.getUTCHours(), 6);
  });

  test("a rule rrule.js would walk for ever registers nothing, and the resync goes on", { timeout: 10000 }, async () => {
    schedules = [
      { ...schedules[0], rrule: "DTSTART;TZID=UTC:20260101T000000 RRULE:FREQ=HOURLY;INTERVAL=2;BYHOUR=1" },
      { id: 8, name: "Daily", one_time_run: null, cron: null, rrule: "DTSTART;TZID=UTC:20200101T060000 RRULE:FREQ=DAILY;INTERVAL=1" },
    ];
    const started = Date.now();
    await cronService.resync();
    assert.ok(Date.now() - started < 3000, `in time (${Date.now() - started} ms)`);
    assert.deepEqual([...cronService.jobs.schedules.keys()], [8]);
  });

  test("a rule with no run ahead registers nothing", async () => {
    schedules = [{ ...schedules[0], rrule: "DTSTART;TZID=UTC:20200101T060000 RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2" }];
    await cronService.resync();
    assert.equal(live().length, 0);
  });

  test("a rule whose next run took too long to work out is tried again, not dropped", async () => {
    // a rule walked for a while (every minute of the working week since 2016, as a weekly rule),
    // of this test's own : the given up ones are remembered by their text
    const all = (n) => [...Array(n).keys()].join(",");
    const rrule = `DTSTART;TZID=UTC:20160104T000000 RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SA;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${all(24)};BYMINUTE=${all(60)}`;
    schedules = [{ ...schedules[0], rrule }];
    limits.walkMs = 0;
    limits.givenUpMs = 0;
    const started = Date.now();
    await cronService.resync();
    const [retry] = live();
    assert.ok(retry, "a task to try again");
    assert.ok(retry.pattern - started >= 1000 && retry.pattern - started < 5000, "once the rule is walked again");
    // the resync leaves it to its retry
    await cronService.resync();
    assert.deepEqual(live(), [retry]);
    limits.walkMs = LIMITS.walkMs;
    await retry.fn();
    const [task] = live();
    assert.notEqual(task, retry);
    assert.ok(task.pattern > new Date() && task.pattern - Date.now() < 4 * 86400000, "its next run");
    assert.equal(cronService.jobs.schedules.get(7), task);
    assert.equal(queued, 0);
  });

  test("a rule whose next run failed otherwise (its thread did not start) is registered at the next resync", async () => {
    // a new thread, given no time to start
    await rruleThreads().async?.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    limits.startMs = 0;
    await cronService.resync();
    assert.equal(live().length, 0, "not registered");
    assert.equal(cronService.signatures.schedules.has(7), false, "forgotten");
    // the next resync (every 5 minutes, or a change notice) registers it, on a thread that starts
    limits.startMs = LIMITS.startMs;
    await cronService.resync();
    const [task] = live();
    assert.ok(task, "registered");
    assert.equal(cronService.jobs.schedules.get(7), task);
  });

  test("a run that passed while it was worked out runs at once, never registered in the past", async () => {
    // worked out from two minutes ago (the thread busy meanwhile) : its run a minute ago
    await cronService.addRruleSchedule(7, "Every minute", "DTSTART;TZID=UTC:20200101T000000 RRULE:FREQ=MINUTELY;INTERVAL=1", new Date(Date.now() - 120000));
    const [task] = live();
    assert.ok(task.pattern > new Date(), "a moment ahead");
    assert.ok(task.pattern - Date.now() <= 1000, "at once");
    await task.fn();
    assert.equal(queued, 1);
  });

  test("the run after one is taken a second later still", async () => {
    // its next run at the start of a minute ahead, then one a second later
    const minute = Math.ceil(Date.now() / 60000) * 60000 + 60000;
    await cronService.addRruleSchedule(7, "Twice a minute", "DTSTART;TZID=UTC:20200101T000000 RRULE:FREQ=MINUTELY;INTERVAL=1;BYSECOND=0,1", new Date(minute - 500));
    const [first] = live();
    assert.equal(first.pattern.getTime(), minute);
    await first.fn();
    const [second] = live();
    assert.equal(second.pattern.getTime(), minute + 1000);
  });

  test("a time the spring gap skips, moved past a later run of the day, still runs in the chain", async () => {
    // 02:30 and 03:15 in Brussels : the night of 2027-03-28 skips 02:30, run at 03:30 (01:30 UTC),
    // after the 03:15 (01:15 UTC) that registered it
    const rrule =
      "DTSTART;TZID=Europe/Brussels:20260101T000000 RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=2;BYMINUTE=30 RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=3;BYMINUTE=15";
    await cronService.addRruleSchedule(7, "Twice a night", rrule, new Date("2027-03-27T20:00:00Z"));
    const fired = [];
    for (let i = 0; i < 4; i++) {
      const [task] = live();
      fired.push(task.pattern.toISOString());
      row.state = "idle";
      await task.fn();
    }
    assert.equal(queued, 4);
    assert.deepEqual(fired, ["2027-03-28T01:15:00.000Z", "2027-03-28T01:30:00.000Z", "2027-03-29T00:30:00.000Z", "2027-03-29T01:15:00.000Z"]);
  });

  test("a schedule removed while its next run is worked out is not registered", async () => {
    const pending = cronService.addSchedule(7, "Nightly", null, null, RRULE);
    cronService.removeSchedule(7);
    await pending;
    assert.equal(live().length, 0);
    assert.equal(cronService.jobs.schedules.size, 0);
  });
});
