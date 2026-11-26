// A socket runner's output (an RTE connected over its socket, outbound or inbound) is stored with
// Job.createOutputOnce. It told no browser : a job's page waited for its status to change before
// it showed the lines. It now tells them, as every other write of a job's output does.
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const published = [];
vi.mock("../src/lib/liveEvents.js", async (orig) => ({
  ...(await orig()),
  publish: (name) => published.push(name),
}));
vi.mock("../src/models/db.model.js", () => ({
  default: { do: async () => ({ affectedRows: 1 }) },
}));

const { default: Job } = await import("../src/models/job.model.js");

describe("a socket runner's output line", () => {
  test("is stored once, and tells the browsers the job changed", async () => {
    const stored = await Job.createOutputOnce({ job_id: 7, order: 3, output: "TASK [ping]", output_type: "stdout" });
    assert.equal(stored, true);
    assert.ok(published.includes("jobs"));
  });
});
