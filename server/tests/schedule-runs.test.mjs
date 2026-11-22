// A schedule lists its runs, the jobs it started : the job keeps the schedule that started it
// (jobs.schedule_id, set by Schedule.launch), and the schedule's page asks
// GET /api/v2/job?schedule=<id>, which narrows the jobs list : within the jobs the caller may see,
// as every other narrowing of it (a user's, a runner's, a stored job's), never beyond them.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the query the jobs list sends, answered with nothing
let sent = null;
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: vi.fn(async (sql, params) => {
      sent = { sql, params };
      return [];
    }),
  },
}));

const Job = (await import("../src/models/job.model.js")).default;

const admin = { username: "admin", type: "local", roles: ["admin"], options: {} };
const bob = { username: "bob", type: "local", roles: ["public"], options: {} };

beforeEach(() => {
  sent = null;
});

describe("the runs of a schedule", () => {
  test("the jobs that carry its id, the newest first", async () => {
    await Job.findAll(admin, 100, { schedule: "12" });
    expect(sent.sql).toMatch(/WHERE schedule_id=\? ORDER BY id DESC LIMIT \?/);
    expect(sent.params.slice(-2)).toEqual([12, 100]);
  });

  test("a user who does not see every job : only their own among them (and the ones they approve)", async () => {
    await Job.findAll(bob, 100, { schedule: 12 });
    expect(sent.sql).toMatch(/WHERE \(\(user=\? AND user_type=\?\) OR .*\) AND schedule_id=\? ORDER BY/);
    expect(sent.params).toContain("bob");
  });

  test("an id that is no number : none, never every job", async () => {
    for (const id of ["abc", "-3", "1.5"]) {
      await Job.findAll(admin, 100, { schedule: id });
      expect(sent.sql).toMatch(/WHERE 1=0 ORDER BY/);
    }
  });

  test("a job keeps the schedule that started it, only when there is one", () => {
    expect(new Job({ form: "f", schedule_id: 7 }).schedule_id).toBe(7);
    expect("schedule_id" in new Job({ form: "f" })).toBe(false);
  });
});

describe("the request", () => {
  test("GET /api/v2/job hands ?schedule= to the list", async () => {
    vi.resetModules();
    vi.doMock("../src/models/job.model.js", () => ({
      default: { findAll: vi.fn(async (_u, _n, filter) => { sent = filter; return []; }) },
    }));
    const { default: controller } = await import("../src/controllers/v2/job.controller.js");
    const res = { status() { return this; }, json() { return this; } };
    await controller.findAllJobs({ query: { schedule: "12" }, user: { user: bob } }, res);
    expect(sent).toMatchObject({ schedule: "12" });
    vi.doUnmock("../src/models/job.model.js");
  });

  test("the API docs say the filter", async () => {
    const { readFileSync } = await import("fs");
    const doc = JSON.parse(readFileSync(new URL("../src/swagger_v2.json", import.meta.url), "utf8"));
    const params = doc.paths["/job"].get.parameters.map((p) => p.name);
    expect(params).toContain("schedule");
  });
});
