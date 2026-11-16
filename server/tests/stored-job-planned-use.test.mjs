// #1437 : a planned run ("Run later") from a stored job is a use of that stored job.
//
// The form opened with ?storedJob=<id> (or filled with Load) names the stored job in its Run later,
// as the MCP plan_job does. Schedule.plan keeps the id with the planned run (schedule.stored_job_id)
// when the planner sees that stored job and it is of the form planned (lib/storedJobUse.js), and
// Schedule.launch names it to Job.launch when the run fires : the stored job's last use is
// written then, not when the run is planned. A schedule (admin-level, recurring or one-time)
// keeps its own copy of the values : it names no stored job, and its runs are no uses.
import { test, describe, vi, beforeEach, expect } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── the database, in memory ─────────────────────────────────────────────────

// the rows of each model : the stored jobs and the schedules
let tables = {};
// what the schedules' create wrote
let created = null;
// a class : the models extend it
vi.mock("../src/models/crud.model.js", () => ({
  default: class CrudModel {
    static async findById(model, id) {
      const row = (tables[model] || []).find((r) => String(r.id) === String(id));
      if (!row) {
        const err = new Error(`No record found with id ${id}`);
        err.name = "NotFoundError";
        throw err;
      }
      return { ...row };
    }
    static async create(_model, data) {
      created = { ...data };
      return 7;
    }
    static async update() {
      return { changedRows: 1 };
    }
    static async delete() {
      return { affectedRows: 1 };
    }
    static changed() {}
  },
}));

// every query the code under test sends : the schedule's claim is always this test's to take,
// anything else is answered with nothing
const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: vi.fn(async (sql, params) => {
      queries.push({ sql, params });
      return /SET state='running',.* WHERE id=\? AND state='queued'/.test(sql) ? { affectedRows: 1 } : [];
    }),
    tryDo: vi.fn(async () => []),
  },
}));

vi.mock("../src/services/cron.service.js", () => ({
  default: { removeSchedule: () => {}, addSchedule: () => {} },
}));

// the forms : Demo and Other, both open to everyone
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: vi.fn(async (_roles, name) => ({ forms: [{ name, type: "ansible", playbook: "site.yml" }] })),
  },
}));

const { default: Schedule } = await import("../src/models/schedule.model.js");
const Job = (await import("../src/models/job.model.js")).default;

// ─── the users ───────────────────────────────────────────────────────────────

const bob = {
  username: "bob", type: "local", groups: [], roles: ["users"],
  options: { allowPlannedJobs: true, allowStoredJobs: true },
};
const planBody = (extra = {}) => ({
  name: "bob later", one_time_run: true, form: "Demo", extra_vars: "a: 1\n", run_at: "2030-01-01 10:00:00", ...extra,
});

/** The stored jobs a last use was written for. */
const marked = () => queries.filter((q) => /last_used_at = NOW\(\)/.test(q.sql)).map((q) => q.params[0]);

beforeEach(() => {
  queries.length = 0;
  created = null;
  tables = {
    stored_jobs: [
      { id: 1, name: "mine", form_name: "Demo", username: "local/bob", visibility: "private" },
      { id: 2, name: "eve's", form_name: "Demo", username: "local/eve", visibility: "private" },
    ],
    schedule: [],
  };
  Job.create = vi.fn(async () => 70);
  // the run itself is not what this is about : it never goes past its launch notification
  Job.sendEventNotification = vi.fn(() => new Promise(() => {}));
});

// ─── planning ────────────────────────────────────────────────────────────────

describe("Run later from a stored job", () => {
  test("keeps the stored job the planner sees, and writes no last use yet", async () => {
    await Schedule.plan(bob, planBody({ stored_job_id: 1 }));
    expect(created.stored_job_id).toBe(1);
    expect(marked()).toEqual([]);
  });

  test("drops one the planner does not see, one gone, or one of another form", async () => {
    for (const id of [2, 99]) {
      await Schedule.plan(bob, planBody({ stored_job_id: id }));
      expect(created.stored_job_id).toBeNull();
    }
    await Schedule.plan(bob, planBody({ form: "Other", stored_job_id: 1 }));
    expect(created.stored_job_id).toBeNull();
  });

  test("without one : none kept", async () => {
    await Schedule.plan(bob, planBody());
    expect(created.stored_job_id).toBeNull();
  });

  test("a schedule never keeps one, on create or update : it has its own copy of the values", async () => {
    await Schedule.create({ name: "nightly", form: "Demo", cron: "0 0 * * *", stored_job_id: 1 });
    expect(created.stored_job_id).toBeUndefined();
    const data = { name: "nightly", stored_job_id: 1 };
    await Schedule.update(data, 7);
    expect(data.stored_job_id).toBeUndefined();
  });
});

// ─── firing ──────────────────────────────────────────────────────────────────

describe("the planned run, when it fires", () => {
  /** A queued schedule row, planned by bob unless `owner` says otherwise. */
  function queue(extra = {}) {
    tables.schedule = [{
      id: 5, name: "bob later", form: "Demo", extra_vars: "a: 1", one_time_run: 1, state: "queued",
      owner: JSON.stringify(bob), ...extra,
    }];
  }

  test("writes the last use of the stored job it was planned from", async () => {
    queue({ stored_job_id: 1 });
    await Schedule.launch(5);
    expect(Job.create).toHaveBeenCalledTimes(1);
    expect(marked()).toEqual([1]);
  });

  test("a stored job deleted, or no longer seen, since : skipped, the run goes on", async () => {
    queue({ stored_job_id: 99 });
    await Schedule.launch(5);
    queue({ stored_job_id: 2 });
    await Schedule.launch(5);
    expect(Job.create).toHaveBeenCalledTimes(2);
    expect(marked()).toEqual([]);
  });

  test("a schedule's run is no use, even with a stored job in its row", async () => {
    // an admin-level schedule : no owner, it runs as the Schedule Service
    queue({ owner: null, stored_job_id: 1, one_time_run: 0, cron: "0 0 * * *" });
    await Schedule.launch(5);
    expect(Job.create).toHaveBeenCalledTimes(1);
    expect(marked()).toEqual([]);
  });

  test("the stored job's id is not handed to the playbook in the schedule's record", async () => {
    queue({ stored_job_id: 1 });
    const launch = vi.spyOn(Job, "launch");
    try {
      await Schedule.launch(5);
      const args = launch.mock.calls[0][0];
      expect(args.storedJobId).toBe(1);
      expect(args.serverExtravars.schedule.stored_job_id).toBeUndefined();
    } finally {
      launch.mockRestore();
    }
  });
});
