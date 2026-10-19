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
    nextRun() {
      return this.pattern instanceof Date ? this.pattern : null;
    }
  },
}));

// the schedule row and the statements the queueing runs
let row;
let queued;
let schedules;
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => {
      if (/^SELECT id FROM AnsibleForms.`schedule` WHERE id=\? AND COALESCE\(enabled,1\)=1/.test(sql)) {
        return row.enabled && !["queued", "running"].includes(row.state) ? [{ id: row.id }] : [];
      }
      if (/^UPDATE AnsibleForms.`schedule` SET state='queued'/.test(sql)) {
        queued++;
        row.state = "queued";
        return { affectedRows: 1 };
      }
      if (/FROM AnsibleForms.`schedule`/.test(sql)) return schedules;
      return [];
    },
    tryDo: async () => [],
  },
}));
let held = true;
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => held }));

const { default: cronService } = await import("../src/services/cron.service.js");

const RRULE = "DTSTART;TZID=Europe/Brussels:20200101T020000 RRULE:FREQ=DAILY;INTERVAL=1";
const live = () => tasks.filter((t) => !t.stopped);

beforeEach(() => {
  tasks = [];
  queued = 0;
  held = true;
  row = { id: 7, name: "Nightly", enabled: 1, state: "idle" };
  schedules = [{ id: 7, name: "Nightly", one_time_run: 0, cron: null, run_at: null, rrule: RRULE }];
  cronService.active = true;
});
afterEach(() => {
  cronService.stopAll();
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

  test("a rule with no run ahead registers nothing", async () => {
    schedules = [{ ...schedules[0], rrule: "DTSTART;TZID=UTC:20200101T060000 RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2" }];
    await cronService.resync();
    assert.equal(live().length, 0);
  });
});
