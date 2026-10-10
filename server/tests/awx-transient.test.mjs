// AWX failing to answer for a moment (a network blip, a restart) does not end a job that is
// running there : the tracker retries with a backoff, and gives up only after AWX_LOST_MINUTES of
// failures in a row (contactTolerance). One failed status request used to fail the job.
import { test, describe, expect, beforeAll, afterAll } from "vitest";
import http from "http";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { default: Job } = await import("../src/models/job.model.js");
const { Awx, contactTolerance } = await import("../src/runners/awx/api.js");
const { default: mysql } = await import("../src/models/db.model.js");

let jobRow = { status: "running" };
const rows = [];
mysql.do = async function (sql, params) {
  if (sql.includes("INSERT INTO AnsibleForms.`job_output`")) { rows.push(params[0]); return { insertId: rows.length }; }
  if (sql.includes("UPDATE AnsibleForms.`jobs` SET ? WHERE id=? AND status IN (?)")) {
    if (!params[2].includes(jobRow.status)) return { affectedRows: 0 };
    Object.assign(jobRow, params[0]);
    return { affectedRows: 1 };
  }
  if (sql.includes("SELECT abort_requested")) return [{ abort_requested: 0 }];
  if (sql.includes("SELECT id FROM AnsibleForms.`jobs`")) return [{ id: params[0] }];
  return [];
};
Job.sendStatusNotification = async () => {};

// the test AWX : the job's status answers 502 the first `failFirst` times, then the job is done
let calls = 0;
let failFirst = 2;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/v2/jobs/88/") {
    if (++calls <= failFirst) { res.writeHead(502); res.end("bad gateway"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: 88, type: "job", url: "/api/v2/jobs/88/", status: "successful", finished: "2026-01-01T10:00:00Z", artifacts: {}, related: { stdout: "/api/v2/jobs/88/stdout/" } }));
    return;
  }
  if (url.pathname === "/api/v2/jobs/88/stdout/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("PLAY RECAP"); return; }
  res.writeHead(404); res.end();
});
let runner;
beforeAll(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  runner = { uri: `http://127.0.0.1:${server.address().port}`, token: "t", ignore_certs: true };
});
afterAll(() => server.close());

describe("AWX not answering for a moment", () => {
  test("the job is followed on and ends with AWX's verdict", async () => {
    await Awx.trackJob(runner, { id: 88, url: "/api/v2/jobs/88/", related: { stdout: "/api/v2/jobs/88/stdout/" } }, 1, 0, "");
    expect(calls).toBeGreaterThan(failFirst);
    expect(jobRow.status).toBe("success");
    expect(rows.some((r) => /lost contact/.test(r.output))).toBe(false);
  }, 20000);
});

describe("the tolerance", () => {
  test("backs off, and gives up only after the time and enough tries", () => {
    let t = 0;
    const c = contactTolerance(5, () => t);
    const waits = [];
    let r;
    for (let i = 0; i < 9; i++) { r = c.failed(); waits.push(r.waitMs); t += r.waitMs; }
    expect(r.giveUp).toBe(false);
    expect(waits.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    t += 5 * 60 * 1000;
    expect(c.failed().giveUp).toBe(true);
  });

  test("an answer starts the count again", () => {
    let t = 0;
    const c = contactTolerance(0, () => t);
    for (let i = 0; i < 9; i++) c.failed();
    c.ok();
    expect(c.failed()).toMatchObject({ giveUp: false, failures: 1, waitMs: 1000 });
  });
});
