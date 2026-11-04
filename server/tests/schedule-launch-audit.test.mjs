// A scheduled launch is written to the audit log (Schedule.launch) : no request launches it, so
// the audit middleware never sees it, and once the job history is pruned this entry is the
// record of what ran - as the user it ran as, naming the schedule, the form and the job.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

let launchImpl = async () => ({ id: 42 });
vi.mock("../src/models/job.model.js", () => ({
  default: { launch: async (args) => launchImpl(args) },
}));

const audited = [];
vi.mock("../src/models/audit.model.js", () => ({
  default: { log: async (entry) => { audited.push(entry); } },
}));

vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => (/SET state='running'/.test(sql) ? { affectedRows: 1 } : []),
    tryDo: async () => [],
  },
}));

vi.mock("../src/services/cron.service.js", () => ({
  default: { removeScheduleJob: () => {}, addScheduleJob: () => {}, removeSchedule: () => {} },
}));

const { default: Schedule } = await import("../src/models/schedule.model.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");

let row = {};
beforeEach(() => {
  audited.length = 0;
  launchImpl = async () => ({ id: 42 });
  row = { id: 7, name: "nightly", form: "myform", extra_vars: "a: 1", one_time_run: 0, state: "queued" };
  CrudModel.findById = async () => ({ ...row });
  CrudModel.update = async (model, data) => { Object.assign(row, data); return { changedRows: 1 }; };
  CrudModel.delete = async () => ({ affectedRows: 1 });
});

describe("a scheduled launch in the audit log", () => {
  test("a schedule's job : by the schedule service, naming the schedule, the form and the job", async () => {
    await Schedule.launch(7);
    assert.equal(audited.length, 1);
    const [e] = audited;
    assert.equal(e.action, "schedule.launch");
    assert.equal(e.outcome, "success");
    assert.equal(e.targetType, "job");
    assert.equal(e.target, 42);
    assert.equal(e.user.username, "Schedule Service");
    assert.equal(e.user.type, "schedule");
    assert.deepEqual(e.detail, { schedule: "nightly", scheduleId: 7, form: "myform", planned: false });
  });

  test("a planned job : by the user who planned it", async () => {
    row.owner = JSON.stringify({ username: "jdoe", type: "ldap", roles: ["public"], groups: [] });
    await Schedule.launch(7);
    assert.equal(audited[0].user.username, "jdoe");
    assert.equal(audited[0].user.type, "ldap");
    assert.equal(audited[0].detail.planned, true);
  });

  test("a launch that failed : a failure, with why, and no job", async () => {
    launchImpl = async () => { throw new Error("form 'myform' not found"); };
    await Schedule.launch(7);
    const [e] = audited;
    assert.equal(e.outcome, "failure");
    assert.equal(e.target, null);
    assert.match(e.detail.error, /not found/);
  });

  test("no job created : a failure too", async () => {
    launchImpl = async () => ({});
    await Schedule.launch(7);
    assert.equal(audited[0].outcome, "failure");
    assert.equal(audited[0].detail.error, "no job was created");
  });
});
