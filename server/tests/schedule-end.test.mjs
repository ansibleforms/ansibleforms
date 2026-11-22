// How a schedule ends (lib/scheduleEnd.js) : timed by a cron or a rrule it ends never, on a date
// (end_at) or after a number of runs (end_count), then is turned off or removed (end_action) ; a
// one-time run is removed after its run (remove_after_run, the default) or turned off and kept. A
// schedule of a schedules repository is managed by its file : an end only ever turns it off. The
// scheduler counts the jobs a schedule starts (run_count, the jobs its Runs tab lists : the job
// keeps jobs.schedule_id), ends it once its runs are done, never launches one whose date passed,
// and drops an ended one from the cron or rrule registry. Each end is logged and audited.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// what Job.launch was given, and the job it starts
let launched = null;
vi.mock("../src/models/job.model.js", () => ({
  default: { launch: async (args) => { launched = args; return { id: 42 }; } },
}));

// the schedule rows, and the statements the scheduler runs on them
let rows = [];
let audits = [];
const find = (id) => rows.find((r) => r.id === id);
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params = []) => {
      if (/SET state='running',.* WHERE id=\? AND state='queued'/.test(sql)) {
        const r = find(params[1]);
        if (r.state !== "queued") return { affectedRows: 0 };
        r.state = "running";
        return { affectedRows: 1 };
      }
      if (/SET run_count = COALESCE\(run_count,0\) \+ 1 WHERE id=\?/.test(sql)) {
        find(params[0]).run_count = (find(params[0]).run_count || 0) + 1;
        return { affectedRows: 1 };
      }
      if (/^SELECT \* FROM AnsibleForms.`schedule` WHERE id=\?$/.test(sql)) return rows.filter((r) => r.id === params[0]).map((r) => ({ ...r }));
      if (/^UPDATE AnsibleForms.`schedule` SET enabled=0 WHERE id=\?$/.test(sql)) {
        find(params[0]).enabled = 0;
        return { affectedRows: 1 };
      }
      if (/SET output=\?, status=\?, last_run=\?, state='idle', enabled=0, claim_node=NULL, run_count=COALESCE\(run_count,0\)\+\? WHERE id=\?/.test(sql)) {
        const r = find(params[4]);
        Object.assign(r, { output: params[0], status: params[1], state: "idle", enabled: 0, run_count: (r.run_count || 0) + params[3] });
        return { affectedRows: 1 };
      }
      // the sweep : on, not once, its date passed or its runs done
      if (/^SELECT \* FROM AnsibleForms.`schedule` WHERE COALESCE\(enabled,1\)=1 AND one_time_run IS NULL/.test(sql)) {
        const now = params[0];
        return rows.filter((r) => r.enabled !== 0 && !r.one_time_run && ((r.ends === "date" && new Date(r.end_at) <= now) || (r.ends === "count" && (r.run_count || 0) >= r.end_count)));
      }
      // the cron or rrule trigger : the row, when it is on and idle
      if (/^SELECT id, name, one_time_run, ends, end_at, end_count, end_action, run_count, repository FROM AnsibleForms.`schedule` WHERE id=\? AND COALESCE\(enabled,1\)=1/.test(sql)) {
        return rows.filter((r) => r.id === params[0] && r.enabled !== 0 && !["queued", "running"].includes(r.state)).map((r) => ({ ...r }));
      }
      if (/UPDATE AnsibleForms.`schedule` SET state='queued'/.test(sql)) {
        find(params[0]).state = "queued";
        return { affectedRows: 1 };
      }
      if (/^INSERT INTO AnsibleForms.`audit`/.test(sql)) {
        audits.push({ action: params[3], target: params[5], outcome: params[6], detail: JSON.parse(params[7] || "{}") });
        return { affectedRows: 1 };
      }
      return [];
    },
    doRetryingDeadlock: async (sql, params) => {
      find(params[0]).state = "queued";
      return { affectedRows: 1 };
    },
    tryDo: async () => [],
  },
}));
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => true }));

const { default: Schedule } = await import("../src/models/schedule.model.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const { default: cronService } = await import("../src/services/cron.service.js");
const End = await import("../src/lib/scheduleEnd.js");

// the registry : what was dropped from it
let removed = [];
cronService.removeSchedule = (id) => removed.push(id);

beforeEach(() => {
  launched = null;
  rows = [];
  audits = [];
  removed = [];
  CrudModel.findById = async (_m, id) => ({ ...find(Number(id)) });
  CrudModel.update = async (_m, data, id) => {
    Object.assign(find(Number(id)), data);
    return { changedRows: 1 };
  };
  CrudModel.delete = async (_m, id) => {
    rows = rows.filter((r) => r.id !== Number(id));
    return { affectedRows: 1 };
  };
});

const schedule = (over = {}) => ({ id: 1, name: "nightly", form: "f", extra_vars: "", cron: "0 2 * * *", one_time_run: null, state: "queued", enabled: 1, ends: "never", end_action: "disable", run_count: 0, remove_after_run: 1, repository: null, ...over });

// ─── what a request gives ────────────────────────────────────────────────────

describe("the end a request gives", () => {
  test("ends date needs its date, as a moment kept in UTC", () => {
    assert.throws(() => End.checkEnd({ ends: "date" }), /needs that date \(end_at\)/);
    assert.throws(() => End.checkEnd({ ends: "date", end_at: "soon" }), /is not a time/);
    const data = End.checkEnd({ ends: "date", end_at: "2030-01-01T10:00:00+02:00", end_count: 4 });
    assert.deepEqual(data, { ends: "date", end_at: "2030-01-01 08:00:00", end_count: null, end_action: "disable" });
  });

  test("ends count needs a whole number of at least 1", () => {
    for (const n of [undefined, "", 0, -1, 1.5, "x"]) assert.throws(() => End.checkEnd({ ends: "count", end_count: n }), /end_count/, String(n));
    assert.deepEqual(End.checkEnd({ ends: "count", end_count: "3", end_action: "remove" }), { ends: "count", end_at: null, end_count: 3, end_action: "remove" });
  });

  test("an unknown kind or action is refused ; an update keeps what it does not give", () => {
    assert.throws(() => End.checkEnd({ ends: "soon" }), /ends must be one of never, date, count/);
    assert.throws(() => End.checkEnd({ end_action: "explode" }), /end_action must be one of disable, remove/);
    const current = { ends: "count", end_count: 5, end_action: "remove" };
    assert.deepEqual(End.checkEnd({ end_count: 7 }, current), { ends: "count", end_at: null, end_count: 7, end_action: "remove" });
    // nothing of the end : left as it is
    assert.deepEqual(End.checkEnd({ name: "x" }, current), { name: "x" });
  });

  test("a one-time run has no end : what is given of it is ignored, only remove_after_run read", () => {
    assert.deepEqual(End.checkEnd({ ends: "count", end_count: 3, remove_after_run: false }, null, true), { remove_after_run: 0 });
    assert.deepEqual(End.checkEnd({}, { ends: "date" }, true), { ends: "never", end_at: null, end_count: null });
    assert.throws(() => End.checkEnd({ remove_after_run: "maybe" }, null, true), /remove_after_run must be true or false/);
  });

  test("run_count is never a request's", () => {
    assert.deepEqual(End.checkEnd({ run_count: 99 }), {});
  });
});

// ─── when it ends ────────────────────────────────────────────────────────────

describe("when a schedule ends", () => {
  test("its date passed, or its runs done ; never for a one-time run", () => {
    const now = new Date("2030-01-01T12:00:00Z");
    assert.equal(End.endReached({ ends: "date", end_at: "2030-01-01 11:59:00" }, now), "date");
    assert.equal(End.endReached({ ends: "date", end_at: new Date("2030-01-01T12:01:00Z") }, now), null);
    assert.equal(End.endReached({ ends: "count", end_count: 3, run_count: 3 }, now), "count");
    assert.equal(End.endReached({ ends: "count", end_count: 3, run_count: 2 }, now), null);
    assert.equal(End.endReached({ ends: "date", end_at: "2000-01-01 00:00:00", one_time_run: "2000-01-01" }, now), null);
    assert.equal(End.endReached({ ends: "never" }, now), null);
  });

  test("the runs a preview shows stop at it", () => {
    const runs = [1, 2, 3].map((d) => new Date(`2030-01-0${d}T00:00:00Z`));
    assert.deepEqual(End.runsBeforeEnd(runs, { ends: "date", end_at: "2030-01-02 00:00:00" }), runs.slice(0, 2));
    assert.deepEqual(End.runsBeforeEnd(runs, { ends: "count", end_count: 5, run_count: 4 }), runs.slice(0, 1));
  });

  test("a repository's schedule is only turned off, whatever its end_action ; a planned job always removed", () => {
    assert.equal(End.endActionOf({ end_action: "remove" }), "remove");
    assert.equal(End.endActionOf({ end_action: "remove", repository: "ops" }), "disable");
    assert.equal(End.onceActionOf({ remove_after_run: 1 }), "remove");
    assert.equal(End.onceActionOf({ remove_after_run: 0 }), "disable");
    assert.equal(End.onceActionOf({ remove_after_run: 0, owner: "{}" }), "remove");
    assert.equal(End.onceActionOf({ remove_after_run: 1, repository: "ops" }), "disable");
  });
});

// ─── the scheduler ───────────────────────────────────────────────────────────

describe("the scheduler", () => {
  test("a launch names the schedule to its job, and counts it", async () => {
    rows = [schedule()];
    await Schedule.launch(1);
    assert.equal(launched.scheduleId, 1);
    assert.equal(rows[0].run_count, 1);
    assert.equal(rows[0].enabled, 1);
    assert.deepEqual(audits.filter((a) => a.action === "schedule.end"), []);
  });

  test("its last run turns it off (end_action disable), dropped from the registry, audited", async () => {
    rows = [schedule({ ends: "count", end_count: 2, run_count: 1 })];
    await Schedule.launch(1);
    assert.equal(rows[0].run_count, 2);
    assert.equal(rows[0].enabled, 0);
    assert.deepEqual(removed, [1]);
    const end = audits.find((a) => a.action === "schedule.end");
    assert.equal(end.outcome, "success");
    assert.deepEqual(end.detail, { scheduleId: 1, reason: "count", action: "disable" });
  });

  test("end_action remove : its last run removes it", async () => {
    rows = [schedule({ ends: "count", end_count: 1, end_action: "remove" })];
    await Schedule.launch(1);
    assert.deepEqual(rows, []);
    assert.equal(audits.find((a) => a.action === "schedule.end").detail.action, "remove");
  });

  test("a repository's schedule is only turned off, even when its end_action says remove", async () => {
    rows = [schedule({ ends: "count", end_count: 1, end_action: "remove", repository: "ops" })];
    await Schedule.launch(1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].enabled, 0);
    assert.deepEqual(audits.find((a) => a.action === "schedule.end").detail, { scheduleId: 1, reason: "count", action: "disable", repository: "ops" });
  });

  test("a one-time run with remove_after_run is removed after it started its job ; without, turned off and kept", async () => {
    rows = [schedule({ cron: null, one_time_run: "2020-01-01 00:00:00" })];
    await Schedule.launch(1);
    assert.deepEqual(rows, []);
    rows = [schedule({ cron: null, one_time_run: "2020-01-01 00:00:00", remove_after_run: 0 })];
    await Schedule.launch(1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].enabled, 0);
    assert.equal(rows[0].run_count, 1);
    assert.match(rows[0].output, /started job 42/);
  });

  test("a schedule whose end date passed is never launched by its trigger : it is ended instead", async () => {
    rows = [schedule({ state: "idle", ends: "date", end_at: "2020-01-01 00:00:00" })];
    await cronService.queueIfIdle(1, "nightly");
    assert.equal(rows[0].state, "idle", "not queued");
    assert.equal(rows[0].enabled, 0);
    assert.deepEqual(removed, [1]);
    // one whose date is ahead : queued
    rows = [schedule({ state: "idle", ends: "date", end_at: "2999-01-01 00:00:00" })];
    await cronService.queueIfIdle(1, "nightly");
    assert.equal(rows[0].state, "queued");
  });

  test("the sweep ends the schedules whose date passed between two runs", async () => {
    rows = [
      schedule({ id: 1, state: "idle", ends: "date", end_at: "2020-01-01 00:00:00", end_action: "remove" }),
      schedule({ id: 2, name: "later", state: "idle", ends: "date", end_at: "2999-01-01 00:00:00" }),
    ];
    assert.equal(await Schedule.endReachedSchedules(), 1);
    assert.deepEqual(rows.map((r) => r.id), [2]);
  });

  test("a schedule turned off is not registered", () => {
    let added = 0;
    const save = cronService.addSchedule;
    cronService.addSchedule = () => added++;
    try {
      cronService.addScheduleRow({ id: 5, name: "off", cron: "* * * * *", enabled: 0 });
      assert.equal(added, 0);
      assert.deepEqual(removed, [5]);
      cronService.addScheduleRow({ id: 6, name: "on", cron: "* * * * *", enabled: 1 });
      assert.equal(added, 1);
    } finally {
      cronService.addSchedule = save;
    }
  });
});

// ─── its next run ────────────────────────────────────────────────────────────

describe("its next run", () => {
  test("none once its end is reached, nor one after its end date", () => {
    assert.equal(Schedule.withNextRun({ cron: "* * * * *", enabled: 1, ends: "count", end_count: 2, run_count: 2 }).next_run, null);
    assert.equal(Schedule.withNextRun({ cron: "* * * * *", enabled: 1, ends: "date", end_at: new Date(Date.now() + 1) }).next_run, null);
    assert.ok(Schedule.withNextRun({ cron: "* * * * *", enabled: 1, ends: "date", end_at: new Date(Date.now() + 3600e3) }).next_run);
  });
});
