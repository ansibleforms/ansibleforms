// "Run later (one-time)" on a form, for a user with allowPlannedJobs.
//
// The button is shown on allowPlannedJobs (on for everyone by default) and it POSTs a
// one-time schedule to /api/v2/schedule - but that whole mount sat behind
// allowScheduledJobs, which is admin-only by default, so every non-admin who pressed it
// got "You do not have permission to manage scheduled jobs".
//
// Opening the mount is not enough on its own : a schedule launches as the 'Schedule
// Service' with the admin role and its extra_vars skip the reserved-key strip, so a
// planner would have been able to run any form, as admin, with any playbook. These tests
// pin the narrow door : a planner may only CREATE, only a one-time run, only of a form
// they may run - and the job runs as them, through the strip a browser launch gets.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/lib/i18n.js", () => ({
  default: { t: (_req, key) => key },
}));

// what Job.launch receives, per test
let launched = null;
// what the launch validation was asked to check when a job was planned
let guarded = null;
vi.mock("../src/models/job.model.js", () => ({
  default: { launch: async (args) => { launched = args; return { id: 42 }; } },
  // the server's filter of the raw form data, as a job's : here it drops a field named secret
  // (the real one, models/job.model.js, is tested with the form engine)
  filterRawFormDataOf: (_formObj, raw) => Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "secret")),
  // the form 'Strict Form' is under 'enforce' : a planned run without a host is refused
  guardLaunch: async (args) => {
    guarded = args;
    if (args.formObj?.launchValidation === "enforce" && !args.rawFormData?.host) {
      const err = new Error("The form data of 'Strict Form' is not valid - missing: host");
      err.name = "ValidationError";
      throw err;
    }
  },
}));

// Schedule.launch claims the row with one conditional statement (two processes reading the
// same queued schedule launch it once) : here it is always this test's to take
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => (/SET state='running',.* WHERE id=\? AND state='queued'/.test(sql) ? { affectedRows: 1 } : []),
    tryDo: async () => [],
  },
}));

vi.mock("../src/services/cron.service.js", () => ({
  default: { removeSchedule: () => {}, addSchedule: () => {}, addScheduleRow: () => {} },
}));

// the forms each role may run : 'Demo Form' for 'users', 'Admin Form' for admins only
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: async (roles, name) => {
      const forms = { "Demo Form": ["users"], "Admin Form": ["admin"], "Strict Form": ["users"] };
      if (!forms[name]) return { forms: [] };
      const launchValidation = name === "Strict Form" ? "enforce" : undefined;
      if (roles.includes("admin") || forms[name].some((r) => roles.includes(r))) return { forms: [{ name, launchValidation }] };
      // what the real Form.load does for a named form the roles do not reach
      const err = new Error(`Access denied to form ${name}.`);
      err.name = "AccessDeniedError";
      throw err;
    },
  },
}));

const Middleware = (await import("../src/lib/middleware.js")).default;
const { default: Schedule } = await import("../src/models/schedule.model.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const { default: scheduleController } = await import("../src/controllers/v2/schedule.controller.js");

const planner = {
  id: 2, username: "bob", type: "local", groups: ["local/users"], roles: ["users", "default"],
  options: { allowPlannedJobs: true, allowScheduledJobs: false, allowVerboseMode: false },
};
const scheduler = { ...planner, options: { allowPlannedJobs: true, allowScheduledJobs: true } };
const nobody = { ...planner, options: { allowPlannedJobs: false, allowScheduledJobs: false } };

// the moment of the run, as a request sends it, and as the schedule table keeps it (UTC)
const runAt = "2030-01-01T10:00:00Z";
const stored = "2030-01-01 10:00:00";
const planBody = (extra = {}) => ({
  name: "bob later", one_time_run: runAt, form: "Demo Form", extra_vars: "username: x\n", ...extra,
});

// ─── the route guard ───────────────────────────────────────────────

function guard(user, method, path) {
  const res = { statusCode: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = () => res;
  let nexted = false;
  Middleware.checkScheduleOrPlannedJobsMiddleware({ user: user && { user }, method, path }, res, () => { nexted = true; });
  return { status: res.statusCode, nexted };
}

describe("the /api/v2/schedule guard", () => {
  test("allowPlannedJobs alone may create", () => {
    assert.equal(guard(planner, "POST", "/").nexted, true,
      "'Run later' is offered on allowPlannedJobs, so creating must not answer 403");
  });

  test.each([
    ["GET", "/"], ["GET", "/1"], ["PUT", "/1"], ["DELETE", "/1"], ["POST", "/1/launch/"],
  ])("allowPlannedJobs alone may not %s %s", (method, path) => {
    const r = guard(planner, method, path);
    assert.equal(r.nexted, false, "a planner must not see or touch other schedules");
    assert.equal(r.status, 403);
  });

  test("allowScheduledJobs still reaches everything", () => {
    for (const [m, p] of [["GET", "/"], ["PUT", "/1"], ["DELETE", "/1"], ["POST", "/"]]) {
      assert.equal(guard(scheduler, m, p).nexted, true);
    }
  });

  test("neither option is 403, and no user is 401", () => {
    assert.equal(guard(nobody, "POST", "/").status, 403);
    assert.equal(guard(undefined, "POST", "/").status, 401);
  });
});

// ─── planning ──────────────────────────────────────────────────────

let created = null;
beforeEach(() => {
  created = null;
  launched = null;
  guarded = null;
  CrudModel.create = async (_model, data) => { created = { ...data }; return 7; };
});

describe("Schedule.plan", () => {
  test("a one-time run of a form the user may run is created, owned by the user", async () => {
    const id = await Schedule.plan(planner, planBody());
    assert.equal(id, 7);
    assert.equal(created.form, "Demo Form");
    // one_time_run holds the moment, no run_at beside it
    assert.equal(created.one_time_run, stored);
    assert.equal("run_at" in created, false);
    const owner = JSON.parse(created.owner);
    assert.equal(owner.username, "bob");
    assert.deepEqual(owner.roles, ["users", "default"]);
  });

  test("a form the user may not run is refused", async () => {
    const hidden = await Schedule.plan(planner, planBody({ form: "Admin Form" })).catch((e) => e);
    const unknown = await Schedule.plan(planner, planBody({ form: "No Such Form" })).catch((e) => e);
    assert.equal(hidden.name, "AccessDeniedError");
    assert.equal(unknown.name, "AccessDeniedError");
    // the same words for both, so planning is no way to probe which forms exist
    assert.equal(hidden.message.replace("Admin Form", "X"), unknown.message.replace("No Such Form", "X"));
    assert.equal(created, null);
  });

  test("a recurring schedule is refused", async () => {
    await assert.rejects(Schedule.plan(planner, planBody({ one_time_run: false, cron: "* * * * *" })), { name: "AccessDeniedError" });
    await assert.rejects(Schedule.plan(planner, planBody({ cron: "* * * * *" })), { name: "AccessDeniedError" });
    assert.equal(created, null);
  });

  test("the request cannot choose the owner or the internal fields", async () => {
    const forged = JSON.stringify({ username: "admin", roles: ["admin"] });
    await Schedule.plan(planner, planBody({ owner: forged, state: "queued", queue_id: 1, status: "success" }));
    assert.equal(JSON.parse(created.owner).username, "bob");
    for (const key of ["queue_id", "status", "output", "cron"]) {
      assert.equal(created[key], undefined, `${key} must not come from the request`);
    }
    // its state is the server's : a new plan waits for its time, idle - never the request's
    assert.equal(created.state, "idle", "state must not come from the request");
  });

  test("verbose needs allowVerboseMode, as on a direct launch", async () => {
    await assert.rejects(Schedule.plan(planner, planBody({ extra_vars: "__verbose__: true\n" })), { name: "AccessDeniedError" });
  });

  test("extra_vars must be a dictionary, and the moment of its run is required", async () => {
    await assert.rejects(Schedule.plan(planner, planBody({ extra_vars: "- a\n- b\n" })), { name: "BadRequestError" });
    await assert.rejects(Schedule.plan(planner, planBody({ one_time_run: true })), { name: "BadRequestError" });
    await assert.rejects(Schedule.plan(planner, planBody({ one_time_run: "not a time" })), { name: "BadRequestError" });
  });

  test("the pair before 7.5.0 (one_time_run true with run_at) still plans, at run_at (deprecated)", async () => {
    await Schedule.plan(planner, planBody({ one_time_run: true, run_at: "2030-01-01 10:00:00" }));
    assert.equal(created.one_time_run, stored);
    await Schedule.plan(planner, planBody({ one_time_run: undefined, run_at: runAt }));
    assert.equal(created.one_time_run, stored);
    assert.equal("run_at" in created, false);
  });

  test("the owner is the whole token user, so ansibleforms_user matches a browser launch", async () => {
    await Schedule.plan({ ...planner, type: "ldap", displayName: "Bob Builder" }, planBody());
    const owner = JSON.parse(created.owner);
    assert.equal(owner.displayName, "Bob Builder", "a field the token carries must not be dropped");
    assert.equal(owner.type, "ldap");
  });

  test("the raw field values are checked when planned, and kept for when it fires", async () => {
    await Schedule.plan(planner, planBody({ raw_form_data: { username: "x" } }));
    assert.equal(guarded.form, "Demo Form");
    assert.deepEqual(guarded.rawFormData, { username: "x" });
    assert.deepEqual(guarded.extravars, { username: "x" });
    assert.equal(created.raw_form_data, JSON.stringify({ username: "x" }));
  });

  test("launch validation 'enforce' refuses invalid values when planned, not when it fires", async () => {
    await assert.rejects(Schedule.plan(planner, planBody({ form: "Strict Form" })), { name: "ValidationError" });
    assert.equal(created, null);
    await Schedule.plan(planner, planBody({ form: "Strict Form", raw_form_data: JSON.stringify({ host: "prod-1" }) }));
    assert.equal(created.raw_form_data, JSON.stringify({ host: "prod-1" }));
  });

  test("the raw form data is filtered on the server before it is stored, as a job's is", async () => {
    await Schedule.plan(planner, planBody({ raw_form_data: { host: "prod-1", secret: "s3cr3t" } }));
    assert.equal(created.raw_form_data, JSON.stringify({ host: "prod-1" }));
  });

  test("raw form data that is not a dictionary is refused", async () => {
    await assert.rejects(Schedule.plan(planner, planBody({ raw_form_data: "{bad" })), { name: "BadRequestError" });
    await assert.rejects(Schedule.plan(planner, planBody({ raw_form_data: [1] })), { name: "BadRequestError" });
  });

  test("without allowPlannedJobs nothing is planned", async () => {
    await assert.rejects(Schedule.plan(nobody, planBody()), { name: "AccessDeniedError" });
  });

  test("an admin-level create cannot set an owner either, nor raw form data", async () => {
    await Schedule.create({ name: "x", owner: "{}", raw_form_data: { host: "x" } });
    assert.equal(created.owner, undefined);
    assert.equal(created.raw_form_data, undefined);
  });

  test("while a schedules repository is used, every new schedule goes to it, whatever its timing ; a planned job stays in the app", async () => {
    const { default: ScheduleRepo } = await import("../src/models/scheduleRepo.model.js");
    const original = { active: ScheduleRepo.activeRepository, create: ScheduleRepo.create };
    const sent = [];
    ScheduleRepo.activeRepository = async () => "ops";
    ScheduleRepo.create = async (repo, data) => { sent.push([repo, data.name]); return 99; };
    try {
      assert.equal(await Schedule.create({ name: "nightly", form: "Demo Form", cron: "0 2 * * *" }), 99);
      await Schedule.create({ name: "once", form: "Demo Form", one_time_run: "2030-01-01T00:00:00Z" });
      await Schedule.create({ name: "weekly", form: "Demo Form", rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=WEEKLY;INTERVAL=1" });
      assert.deepEqual(sent, [["ops", "nightly"], ["ops", "once"], ["ops", "weekly"]]);
      // a "Run later" job a user planned : that user's job, kept in the app
      await Schedule.plan(planner, planBody());
      assert.equal(sent.length, 3);
      assert.ok(created.owner);
    } finally {
      Object.assign(ScheduleRepo, { activeRepository: original.active, create: original.create });
    }
  });

  test("a schedule kept in the app may run on a rrule (one a repository left it), checked", async () => {
    let updated = null;
    const original = CrudModel.update;
    CrudModel.update = async (_m, data) => { updated = { ...data }; return {}; };
    try {
      await Schedule.update({ rrule: "DTSTART;TZID=UTC:20300101T000000  RRULE:FREQ=DAILY;INTERVAL=1", cron: "0 1 * * *" }, 7);
      assert.equal(updated.rrule, "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1");
      assert.equal(updated.cron, null);
      await assert.rejects(Schedule.update({ rrule: "DTSTART:20300101T000000Z RRULE:FREQ=SECONDLY;INTERVAL=1" }, 7), { name: "BadRequestError" });
    } finally {
      CrudModel.update = original;
    }
  });

  test("the timing given replaces the one it had, exactly one kept ; a rrule with a one time run is refused", async () => {
    let updated = null;
    const original = CrudModel.update;
    CrudModel.update = async (_m, data) => { updated = { ...data }; return {}; };
    try {
      // it runs on the cron it is given, not on the rrule it had
      await Schedule.update({ one_time_run: null, cron: "0 1 * * *" }, 7);
      assert.deepEqual([updated.rrule, updated.cron, updated.one_time_run], [null, "0 1 * * *", null]);
      // once, at its moment : the cron and the rrule cleared
      await Schedule.update({ one_time_run: "2030-01-01T00:00:00Z" }, 7);
      assert.deepEqual([updated.rrule, updated.cron, updated.one_time_run], [null, null, "2030-01-01 00:00:00"]);
      // the pair before 7.5.0 : read as that moment ; the flag off with a cron : the cron
      await Schedule.update({ one_time_run: 1, run_at: "2030-01-01T00:00:00.000Z" }, 7);
      assert.deepEqual([updated.one_time_run, "run_at" in updated], ["2030-01-01 00:00:00", false]);
      await Schedule.update({ one_time_run: 0, cron: "0 1 * * *", run_at: "2030-01-01T00:00:00Z" }, 7);
      assert.deepEqual([updated.rrule, updated.cron, updated.one_time_run, "run_at" in updated], [null, "0 1 * * *", null, false]);
      // neither : the rrule stays
      await Schedule.update({ enabled: 0 }, 7);
      assert.equal("rrule" in updated, false);
      // a one time run has no rrule
      const rrule = "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1";
      await assert.rejects(Schedule.update({ one_time_run: "2030-01-01T00:00:00Z", rrule }, 7), { name: "BadRequestError" });
      await assert.rejects(Schedule.create({ name: "once", form: "Demo Form", one_time_run: "2030-01-01T00:00:00Z", rrule }), { name: "BadRequestError" });
      assert.equal(created, null);
    } finally {
      CrudModel.update = original;
    }
  });

  test("an update changes neither the owner nor the values a run was planned with", async () => {
    let updated = null;
    const original = CrudModel.update;
    CrudModel.update = async (_m, data) => { updated = { ...data }; return {}; };
    try {
      await Schedule.update({ name: "y", owner: "{}", raw_form_data: "{}" }, 7);
    } finally {
      CrudModel.update = original;
    }
    assert.deepEqual(updated, { name: "y" });
  });
});

// ─── running ───────────────────────────────────────────────────────

describe("Schedule.launch", () => {
  let row;
  beforeEach(() => {
    row = { id: 1, name: "n", form: "Demo Form", extra_vars: "a: 1", one_time_run: new Date("2030-01-01T10:00:00Z") };
    CrudModel.findById = async () => ({ ...row });
    CrudModel.update = async (_m, data) => { Object.assign(row, data); return { changedRows: 1 }; };
    CrudModel.delete = async () => ({ affectedRows: 1 });
  });

  test("a planned job runs as its owner, with the client-side reserved-key strip", async () => {
    row.owner = JSON.stringify({ username: "bob", type: "local", roles: ["users"], groups: [], options: {} });
    await Schedule.launch(1);
    assert.equal(launched.user.username, "bob");
    assert.deepEqual(launched.user.roles, ["users"], "it must not run with the admin role");
    assert.equal(launched.fromClient, true, "its extra_vars came from a request body");
    assert.equal(launched.serverExtravars.schedule.owner, undefined);
    assert.equal(launched.extravars.schedule, undefined, "the schedule's record is not form output");
  });

  test("a planned job fires with the raw field values it was planned with", async () => {
    row.owner = JSON.stringify({ username: "bob", type: "local", roles: ["users"], groups: [], options: {} });
    row.raw_form_data = JSON.stringify({ host: "prod-1" });
    await Schedule.launch(1);
    assert.deepEqual(launched.rawFormData, { host: "prod-1" });
    assert.equal(launched.serverExtravars.schedule.raw_form_data, undefined);
  });

  test("an admin-level schedule still runs as the Schedule Service", async () => {
    await Schedule.launch(1);
    assert.equal(launched.user.username, "Schedule Service");
    assert.deepEqual(launched.user.roles, ["admin"]);
    assert.equal(launched.fromClient, false);
  });

  test("a repository schedule runs as the Schedule Service, its file's prompts as the job's reserved extra vars", async () => {
    Object.assign(row, {
      one_time_run: null,
      rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1",
      repository: "ops",
      repo_file: "schedules/n.yaml",
      launch_options: JSON.stringify({ __limit__: "web", __tags__: "rotate" }),
    });
    await Schedule.launch(1);
    assert.equal(launched.user.username, "Schedule Service");
    assert.deepEqual(launched.extravars, { a: 1, __limit__: "web", __tags__: "rotate" });
    assert.equal(launched.serverExtravars.schedule.repository, "ops");
    assert.equal(launched.serverExtravars.schedule.launch_options, undefined);
    assert.equal(launched.serverExtravars.schedule.rrule, undefined);
  });

  test("an unreadable owner fails the run instead of falling back to admin", async () => {
    row.owner = "not json";
    // a recurring one : a one-time schedule is deleted after its run, its outcome with it
    row.one_time_run = null;
    await Schedule.launch(1);
    assert.equal(launched, null, "nothing may run");
    assert.equal(row.status, "failed");
  });
});

// ─── the create endpoint : "Run later" against "Schedule" (#1063) ──

describe("POST /api/v2/schedule", () => {
  // the controller with a request from this user, and what it created
  async function post(user, body) {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    CrudModel.findById = async () => ({ id: 7, ...created });
    await scheduleController.create({ user: { user }, body }, res);
    return res;
  }

  test("an admin's Run later is planned: it runs as them, with their form values", async () => {
    const r = await post(scheduler, planBody({ planned: true, raw_form_data: { username: "x" } }));
    assert.equal(r.statusCode, 201);
    assert.equal(JSON.parse(created.owner).username, "bob", "it runs as the admin who planned it");
    assert.equal(created.raw_form_data, JSON.stringify({ username: "x" }));
    assert.equal(created.planned, undefined, "the flag is not a column");
  });

  test("an admin's Schedule is an admin-level schedule, as before", async () => {
    const r = await post(scheduler, planBody({ planned: false }));
    assert.equal(r.statusCode, 201);
    assert.equal(created.owner, undefined, "it runs as the Schedule Service");
    assert.equal(created.planned, undefined, "the flag is not a column");
  });

  test("a planner's Run later is planned, with or without the flag", async () => {
    await post(planner, planBody({ planned: true }));
    assert.equal(JSON.parse(created.owner).username, "bob");
    await post(planner, planBody());
    assert.equal(JSON.parse(created.owner).username, "bob");
  });

  test("a planner cannot make an admin-level schedule by leaving the flag off", async () => {
    const r = await post(planner, planBody({ planned: false, one_time_run: false, cron: "0 0 * * *" }));
    assert.equal(r.statusCode, 403);
    assert.equal(created, null);
  });
});

// the schedule's CRUD fields : what plan() writes must reach the table, and be read back when
// the run fires (the other tests mock CrudModel.create, which hid that it was dropped)
describe("the schedule record", () => {
  test("keeps the owner, the raw form data and the stored job on insert and update", () => {
    const row = { name: "n", owner: "{}", raw_form_data: '{"username":"x"}', stored_job_id: 3 };
    assert.deepEqual(CrudModel.getFieldValues("schedule", { ...row }), row);
    assert.match(CrudModel.getSelectFields("schedule"), /\braw_form_data\b/);
    assert.match(CrudModel.getSelectFields("schedule"), /\bstored_job_id\b/);
  });

  test("its one-time run is one column holding the moment : no run_at, no flag", () => {
    assert.match(CrudModel.getSelectFields("schedule"), /\bone_time_run\b/);
    assert.doesNotMatch(CrudModel.getSelectFields("schedule"), /\brun_at\b/);
    assert.deepEqual(CrudModel.getFieldValues("schedule", { one_time_run: "2030-01-01T10:00:00.000Z" }), { one_time_run: "2030-01-01 10:00:00" });
  });
});
