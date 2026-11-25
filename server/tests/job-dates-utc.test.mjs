// A job's dates are read as stored, in UTC : the browser converts them to the user's zone.
// They were converted to LOG_TZ in SQL as well, and the pool then read that as UTC - every
// date shifted by the LOG_TZ offset (issue #1525).
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.LOG_TZ = "Europe/Paris";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const calls = [];
const start = new Date("2026-11-25T13:02:00Z");
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id FROM AnsibleForms.`jobs` WHERE id = \?/.test(sql)) return [{ id: params[0] }];
      if (/FROM AnsibleForms.`job_output`/.test(sql)) return [{ output: "ok", timestamp: start, output_type: "stdout" }];
      if (/FROM AnsibleForms.jobs j LEFT JOIN/.test(sql)) return [{ id: 5, form: "f", status: "success", start, end: start, extravars: "{}" }];
      if (/FROM AnsibleForms.`jobs` WHERE/.test(sql)) return [{ id: 5, status: "success", start, end: start }];
      return [];
    },
  },
}));

const { default: Job } = await import("../src/models/job.model.js");
const admin = { username: "admin", type: "local", roles: ["admin"] };

beforeEach(() => { calls.length = 0; });

describe("a job's dates with LOG_TZ set", () => {
  test("the jobs list reads them as stored, and passes no timezone", async () => {
    const rows = await Job.findAll(admin, 10);
    assert.equal(rows[0].start.toISOString(), "2026-11-25T13:02:00.000Z");
    const q = calls.find((c) => /FROM AnsibleForms.`jobs` WHERE/.test(c.sql));
    assert.doesNotMatch(q.sql, /CONVERT_TZ/);
    assert.ok(!q.params.includes("Europe/Paris"));
  });

  test("a job and its output read them as stored, and pass no timezone", async () => {
    const job = await Job.findById(admin, 5, true);
    assert.equal(job.start.toISOString(), "2026-11-25T13:02:00.000Z");
    for (const c of calls) {
      assert.doesNotMatch(c.sql, /CONVERT_TZ/);
      assert.ok(!c.params.includes("Europe/Paris"));
    }
  });
});
