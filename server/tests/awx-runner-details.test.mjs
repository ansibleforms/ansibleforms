// Smaller AWX runner fixes : cancelling a workflow before its first poll, and an Ansible
// Automation Platform 2.5 gateway named without its controller path.
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "http";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { Awx, check } = await import("../src/runners/awx/api.js");

const hits = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  hits.push(`${req.method} ${url.pathname}`);
  // workflow job 9 : unknown to /jobs/, cancelled on /workflow_jobs/
  if (url.pathname === "/api/v2/workflow_jobs/9/cancel/") { res.writeHead(202, { "Content-Type": "application/json" }); res.end("{}"); return; }
  // an AAP 2.5 gateway : no /api/v2, the controller under /api/controller/v2
  if (url.pathname === "/api/controller/v2/ping/") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
  res.writeHead(404); res.end("{}");
});
let uri;
beforeAll(async () => { await new Promise((r) => server.listen(0, "127.0.0.1", r)); uri = `http://127.0.0.1:${server.address().port}`; });
afterAll(() => server.close());

describe("the AWX runner", () => {
  test("a workflow cancelled before its first poll is cancelled on the workflow endpoint", async () => {
    hits.length = 0;
    await Awx.abortJob({ uri, token: "t" }, 9, false);
    expect(hits).toEqual(["POST /api/v2/jobs/9/cancel/", "POST /api/v2/workflow_jobs/9/cancel/"]);
  });

  test("an AAP 2.5 gateway without its controller path : Test connection says which uri to set", async () => {
    await expect(check({ uri, token: "t" })).rejects.toThrow(/Ansible Automation Platform 2.5\+ gateway : set the uri to .*\/api\/controller\/v2/);
  });
});
