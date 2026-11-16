// #1437 : a stored job records when it was last used (stored_jobs.last_used_at).
//
// A launch names the stored job its values came from (the form opened with ?storedJob=<id>, the
// MCP launch_job with a storedJob) and Job.launch writes the date. The id comes from the caller,
// so lib/storedJobUse.js checks it first, by the rules of the stored jobs API's read of one : the
// allowStoredJobs role option, then the caller's own, a shared one, or any for a settings user,
// and of the form launched. Any other id is ignored and the launch goes on.
import { test, describe, vi, beforeEach, expect } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the stored jobs live in this array instead of the database
let rows = [];
// a class : the models Job.launch imports extend it
vi.mock("../src/models/crud.model.js", () => ({
  default: class CrudModel {
    static async findById(_model, id) {
      const row = rows.find((r) => String(r.id) === String(id));
      if (!row) {
        const err = new Error(`No record found with id ${id}`);
        err.name = "NotFoundError";
        throw err;
      }
      return { ...row };
    }
  },
}));

// every query the code under test sends, answered with nothing
const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: vi.fn(async (sql, params) => {
      queries.push({ sql, params });
      return [];
    }),
  },
}));

// the forms : Demo and Other share their stored jobs, Locked turns sharing off
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: vi.fn(async (_roles, name) => ({
      forms: [{ name, type: "ansible", playbook: "site.yml", ...(name === "Locked" ? { allowStoredJobSharing: false } : {}) }],
    })),
  },
}));

const { storedJobOfLaunch, markStoredJobUsed, seesStoredJob, storedJobOfJob } = await import("../src/lib/storedJobUse.js");
const mysql = (await import("../src/models/db.model.js")).default;
const Job = (await import("../src/models/job.model.js")).default;

const bob = { username: "bob", type: "local", options: { allowStoredJobs: true } };
const viewer = { username: "carl", type: "local", options: { allowStoredJobs: true, allowStoredJobsViewAll: true } };
const admin = { username: "admin", type: "local", options: { allowStoredJobs: true, showSettings: true } };
const demo = { name: "Demo" };

beforeEach(() => {
  queries.length = 0;
  rows = [
    { id: 1, name: "mine", form_name: "Demo", username: "local/bob", visibility: "private" },
    { id: 2, name: "eve's", form_name: "Demo", username: "local/eve", visibility: "private" },
    { id: 3, name: "shared", form_name: "Demo", username: "local/eve", visibility: "shared" },
    { id: 4, name: "locked", form_name: "Locked", username: "local/eve", visibility: "shared" },
  ];
});

describe("the stored job of a launch", () => {
  test("none named : none, and nothing is read", async () => {
    for (const id of [undefined, null, ""]) expect(await storedJobOfLaunch(bob, id, "Demo", demo)).toBeNull();
  });

  test("the caller's own, of the form launched : its id, given as a number or a string", async () => {
    expect(await storedJobOfLaunch(bob, 1, "Demo", demo)).toBe(1);
    expect(await storedJobOfLaunch(bob, "1", "Demo", demo)).toBe(1);
  });

  test("not an id, gone, or of another form : ignored", async () => {
    expect(await storedJobOfLaunch(bob, "abc", "Demo", demo)).toBeNull();
    expect(await storedJobOfLaunch(bob, -1, "Demo", demo)).toBeNull();
    expect(await storedJobOfLaunch(bob, 99, "Demo", demo)).toBeNull();
    expect(await storedJobOfLaunch(bob, 1, "Other", { name: "Other" })).toBeNull();
  });

  test("without allowStoredJobs : ignored, as the stored jobs API refuses every route", async () => {
    expect(await storedJobOfLaunch({ ...bob, options: {} }, 1, "Demo", demo)).toBeNull();
  });

  test("another user's : only a shared one, with allowStoredJobsViewAll, on a form that shares", async () => {
    expect(await storedJobOfLaunch(bob, 2, "Demo", demo)).toBeNull();
    expect(await storedJobOfLaunch(bob, 3, "Demo", demo)).toBeNull();
    expect(await storedJobOfLaunch(viewer, 2, "Demo", demo)).toBeNull();
    expect(await storedJobOfLaunch(viewer, 3, "Demo", demo)).toBe(3);
    expect(await storedJobOfLaunch(viewer, 4, "Locked", { name: "Locked", allowStoredJobSharing: false })).toBeNull();
  });

  test("a settings user sees every one, as on the stored jobs page", async () => {
    expect(await storedJobOfLaunch(admin, 2, "Demo", demo)).toBe(2);
    expect(seesStoredJob(admin, rows[1], demo)).toBe(true);
    expect(seesStoredJob(bob, null, demo)).toBe(false);
  });
});

describe("its last use", () => {
  test("written as now, on that stored job only", async () => {
    await markStoredJobUsed(3, 70);
    expect(queries).toEqual([{ sql: "UPDATE AnsibleForms.stored_jobs SET last_used_at = NOW() WHERE id = ?", params: [3] }]);
  });

  test("none : nothing written ; a database error is logged, never thrown", async () => {
    await markStoredJobUsed(null, 70);
    expect(queries).toEqual([]);
    mysql.do.mockRejectedValueOnce(new Error("gone away"));
    await expect(markStoredJobUsed(3, 70)).resolves.toBeUndefined();
  });
});

describe("a launch", () => {
  beforeEach(() => {
    Job.create = vi.fn(async () => 70);
    // the run itself is not what this is about : it never goes past its launch notification
    Job.sendEventNotification = vi.fn(() => new Promise(() => {}));
  });

  /** The stored jobs the launch wrote a last use for. */
  const marked = () => queries.filter((q) => /last_used_at = NOW\(\)/.test(q.sql)).map((q) => q.params[0]);

  test("from a stored job the user sees : the job keeps it, and its last use is written", async () => {
    const job = await Job.launch({ form: "Demo", user: bob, extravars: {}, storedJobId: 1 });
    expect(job.id).toBe(70);
    expect(marked()).toEqual([1]);
    expect(Job.create.mock.calls[0][0].stored_job_id).toBe(1);
  });

  test("from one the user does not see, or none : the job runs without one, nothing is written", async () => {
    expect((await Job.launch({ form: "Demo", user: bob, extravars: {}, storedJobId: 2 })).id).toBe(70);
    expect((await Job.launch({ form: "Demo", user: bob, extravars: {} })).id).toBe(70);
    expect(marked()).toEqual([]);
    for (const [record] of Job.create.mock.calls) expect(record.stored_job_id).toBeUndefined();
  });
});

describe("the stored job a job page names", () => {
  test("its id and name to a viewer who sees it : the owner, a settings user", async () => {
    expect(await storedJobOfJob(bob, 1)).toEqual({ id: 1, name: "mine" });
    expect(await storedJobOfJob(admin, 2)).toEqual({ id: 2, name: "eve's" });
  });

  test("a shared one : to a viewer with allowStoredJobsViewAll, on a form that shares", async () => {
    expect(await storedJobOfJob(viewer, 3)).toEqual({ id: 3, name: "shared" });
    expect(await storedJobOfJob(viewer, 4)).toBeNull();
    expect(await storedJobOfJob(bob, 3)).toBeNull();
  });

  test("none to anyone else, without allowStoredJobs, or once it is deleted ; none without one", async () => {
    expect(await storedJobOfJob(viewer, 2)).toBeNull();
    expect(await storedJobOfJob({ ...bob, options: {} }, 1)).toBeNull();
    expect(await storedJobOfJob(bob, 99)).toBeNull();
    expect(await storedJobOfJob(bob, null)).toBeNull();
  });
});

// a relaunch of a job launched from a stored job is a launch from it too : the job relaunched
// names it (jobs.stored_job_id), checked again as the relauncher
describe("a relaunch", () => {
  const relauncher = (user) => ({ ...user, options: { ...user.options, allowJobRelaunch: true } });
  /** The job relaunched : bob's, of form Demo, from stored job `storedJobId` unless none. */
  const ran = (storedJobId, owner = "bob") => ({
    id: 60, form: "Demo", status: "success", user: owner, user_type: "local", extravars: "{}", credentials: "{}",
    raw_form_data: JSON.stringify({ __form__: "Demo" }), ...(storedJobId ? { stored_job_id: storedJobId } : {}),
  });
  const marked = () => queries.filter((q) => /last_used_at = NOW\(\)/.test(q.sql)).map((q) => q.params[0]);

  beforeEach(() => {
    Job.create = vi.fn(async () => 71);
    // the relaunch waits for its own notification ; the run never goes past its launch one
    Job.sendEventNotification = vi.fn((_id, event) => (event === "relaunch" ? Promise.resolve() : new Promise(() => {})));
  });

  test("as it ran : the new job inherits the stored job, whose last use is written", async () => {
    Job.findById = vi.fn(async () => ran(1));
    expect((await Job.relaunch(relauncher(bob), 60, false)).id).toBe(71);
    expect(Job.create.mock.calls[0][0].stored_job_id).toBe(1);
    expect(marked()).toEqual([1]);
  });

  test("with values changed : the same", async () => {
    Job.findById = vi.fn(async () => ran(1));
    expect((await Job.relaunchWithValues({ user: relauncher(bob), id: 60, values: { extra: "x" } })).id).toBe(71);
    expect(Job.create.mock.calls[0][0].stored_job_id).toBe(1);
    expect(marked()).toEqual([1]);
  });

  test("a stored job deleted since : skipped, the relaunch goes on without one", async () => {
    Job.findById = vi.fn(async () => ran(99));
    expect((await Job.relaunch(relauncher(bob), 60, false)).id).toBe(71);
    expect(Job.create.mock.calls[0][0].stored_job_id).toBeUndefined();
    expect(marked()).toEqual([]);
  });

  test("one the relauncher does not see : skipped, even when the job's owner did", async () => {
    // eve's own private stored job, relaunched by a settings-less user who manages all jobs
    Job.findById = vi.fn(async () => ran(2, "eve"));
    const manager = { ...relauncher(bob), roles: ["admin"] };
    expect((await Job.relaunch(manager, 60, false)).id).toBe(71);
    expect(Job.create.mock.calls[0][0].stored_job_id).toBeUndefined();
    expect(marked()).toEqual([]);
  });

  test("of a job from no stored job : none", async () => {
    Job.findById = vi.fn(async () => ran(null));
    await Job.relaunch(relauncher(bob), 60, false);
    expect(Job.create.mock.calls[0][0].stored_job_id).toBeUndefined();
    expect(marked()).toEqual([]);
  });
});
