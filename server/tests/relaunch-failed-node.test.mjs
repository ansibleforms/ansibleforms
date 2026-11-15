// A workflow job relaunched from its failed node (POST /api/v2/job/:id/relaunch with
// fromFailedNode) : each node kept as it ended (workflow_node_runs), the nodes that succeeded
// carried over with their outputs, the run starting at the failed node, only while the workflow
// is the same (its hash) ; an Ascender workflow job through Ascender's `nodes: failed` ; and
// issue #1082 : Ascender's retries, carried over and forced nodes on the graph and in the output.
import { describe, test, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── the database : what these runs read and write ───────────────────────────
const db = { status: {}, artifacts: {}, hashes: {}, nodeRuns: {} };
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: vi.fn(async (sql, params) => {
      if (sql.startsWith("SELECT status FROM AnsibleForms.`jobs` WHERE id=?")) return [{ status: db.status[params[0]] ?? "running" }];
      if (sql.startsWith("SELECT awx_artifacts FROM")) return [{ awx_artifacts: JSON.stringify(db.artifacts[params[0]] || {}) }];
      if (sql.startsWith("SELECT workflow_hash FROM")) return [{ workflow_hash: db.hashes[params[0]] ?? null }];
      if (sql.startsWith("INSERT INTO AnsibleForms.`workflow_node_runs`")) {
        const [jobId, node, status, elapsed, nodeJob, carried, artifacts] = params;
        (db.nodeRuns[jobId] ||= {})[node] = { node, status, elapsed, node_job_id: nodeJob, carried, artifacts };
        return { affectedRows: 1 };
      }
      if (sql.startsWith("SELECT node, status, elapsed, node_job_id, carried, artifacts FROM AnsibleForms.`workflow_node_runs`")) {
        return Object.values(db.nodeRuns[params[0]] || {});
      }
      return [];
    }),
  },
}));

const { runWorkflow, previousRun } = await import("../src/models/workflowRun.js");
const { workflowsOf } = await import("../src/lib/workflowDefs.js");
const { workflowHash, carriedNodes, fromFailedNodeCheck } = await import("../src/lib/workflowRelaunch.js");
const { default: Repository } = await import("../src/models/repository.model.js");
const { default: axios } = await import("axios");
const { Awx, workflowNodeOf, nodeAttempts, attemptLabel, printedWorkflowKeys, failedNodesRelaunchBody } = await import("../src/runners/awx/api.js");
const { default: Job } = await import("../src/models/job.model.js");
const { default: Schema } = await import("../src/models/schema.model.js");

// ─── the onboarding workflow : AD account, mailbox, laptop, licence ──────────
const WORKFLOW = (extra = "") => `
workflow_job_templates:
  - name: onboarding
    related:
      workflow_nodes:
        - identifier: ad
          unified_job_template: { name: ad.yaml, type: job_template }
          related: { success_nodes: [{ identifier: mailbox }] }
        - identifier: mailbox
          unified_job_template: { name: mailbox.yaml, type: job_template }
          related: { success_nodes: [{ identifier: laptop }] }
        - identifier: laptop
          unified_job_template: { name: laptop.yaml, type: job_template }
          related: { success_nodes: [{ identifier: licence }] }
        - identifier: licence
          unified_job_template: { name: licence${extra}.yaml, type: job_template }
`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-wf-relaunch-"));
Repository.getWorkflowsRoots = async () => [{ repository: null, root }];

/**
 * A fake job model : each node's job ends with the status `outcome` gives its playbook, its
 * artifacts the ones `stats` gives.
 */
function fakeJob(outcome, stats = {}) {
  let nextId = 1000 + Math.floor(Math.random() * 1000) * 10;
  const launched = [];
  const graphs = [];
  const ended = [];
  const printed = [];
  const FakeJob = {
    lastOrder: async () => 0,
    printJobOutput: async (line) => printed.push(line),
    update: async (rec, id) => {
      if (rec.workflow_hash) db.hashes[id] = rec.workflow_hash;
      if (rec.awx_workflow) graphs.push(JSON.parse(rec.awx_workflow));
    },
    isAbortRequested: async () => false,
    requestAbort: async () => {},
    transitionStatus: async () => true,
    endJobStatus: async (...args) => ended.push(args),
    launch: async ({ formObj, extravars }) => {
      const id = ++nextId;
      launched.push({ playbook: formObj.playbook, extravars });
      db.status[id] = outcome(formObj.playbook);
      db.artifacts[id] = stats[formObj.playbook] || {};
      return { id, completionPromise: Promise.resolve() };
    },
  };
  return { FakeJob, launched, graphs, ended, printed };
}
const run = (FakeJob, jobid, extravars = {}) =>
  runWorkflow({ Job: FakeJob, form: "Onboard", formObj: { workflow: "onboarding.yml" }, user: { username: "alice" }, extravars, credentials: {}, jobid });

beforeEach(() => {
  fs.writeFileSync(path.join(root, "onboarding.yml"), WORKFLOW());
});

// ---------------------------------------------------------------------------------------------
describe("a workflow job keeps its nodes", () => {
  test("their status, job and outputs (what they pass on), and the workflow's hash", async () => {
    db.status[500] = "running";
    const { FakeJob, ended } = fakeJob((p) => (p === "laptop.yaml" ? "failed" : "success"), { "ad.yaml": { account: "jdoe" } });
    await run(FakeJob, 500);
    expect(ended[0][3]).toBe("failed");
    const rows = db.nodeRuns[500];
    expect(rows.ad).toMatchObject({ status: "successful", carried: 0 });
    expect(JSON.parse(rows.ad.artifacts)).toEqual({ account: "jdoe" });
    // what a node passes on : what came to it too
    expect(JSON.parse(rows.mailbox.artifacts)).toEqual({ account: "jdoe" });
    expect(rows.laptop.status).toBe("failed");
    expect(rows.licence).toBeUndefined();
    expect(db.hashes[500]).toBe(workflowHash(workflowsOf(WORKFLOW())[0]));
  }, 20000);

  test("relaunched from the failed node : the nodes before it carried over, their outputs passed on", async () => {
    db.status[600] = "running";
    const { FakeJob, launched, graphs, ended, printed } = fakeJob(() => "success");
    await run(FakeJob, 600, { __relaunchOf__: { id: 500, scope: "failedNode" } });
    expect(ended[0][3]).toBe("success");
    // laptop and licence run again ; ad and mailbox do not
    expect(launched.map((l) => l.playbook)).toEqual(["laptop.yaml", "licence.yaml"]);
    // the account the AD node made reaches the laptop node
    expect(launched[0].extravars.account).toBe("jdoe");
    // the graph : ad and mailbox carried over, from the previous run
    const last = graphs[graphs.length - 1];
    expect(last.nodes.filter((n) => n.carried).map((n) => n.name)).toEqual(["ad", "mailbox"]);
    expect(last.nodes.find((n) => n.name === "ad")).toMatchObject({ status: "successful", job: null });
    expect(printed.join("\n")).toMatch(/WORKFLOW NODE \[ad\] \(successful\) #1 carried over \*+\nok: \[carried over from job 500\]/);
    // kept as carried : a later relaunch carries them over again
    expect(db.nodeRuns[600].ad).toMatchObject({ status: "successful", carried: 1 });
  }, 20000);

  test("the workflow changed since : the relaunch fails, saying so, and runs nothing", async () => {
    fs.writeFileSync(path.join(root, "onboarding.yml"), WORKFLOW("-v2"));
    db.status[700] = "running";
    const { FakeJob, launched, ended } = fakeJob(() => "success");
    await run(FakeJob, 700, { __relaunchOf__: { id: 500, scope: "failedNode" } });
    expect(launched).toEqual([]);
    expect(ended[0][3]).toBe("failed");
    expect(ended[0][4]).toMatch(/the workflow changed since job 500 ran/);
    await expect(previousRun(500, workflowHash(workflowsOf(WORKFLOW("-v2"))[0]))).rejects.toThrow(/changed/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("when a workflow job can be relaunched from its failed node", () => {
  const rows = [
    { node: "ad", status: "successful", artifacts: '{"account":"jdoe"}', elapsed: 3.5 },
    { node: "laptop", status: "failed" },
  ];
  const ok = { status: "failed", rows, hashThen: "sha256:a", hashNow: "sha256:a" };

  test("a failed job that kept its nodes, of the same workflow", () => {
    expect(fromFailedNodeCheck(ok)).toEqual({ ok: true, reason: "" });
  });

  test("not when it did not fail, kept nothing, has nothing to carry or the workflow changed", () => {
    expect(fromFailedNodeCheck({ ...ok, status: "success" }).reason).toBe("not_failed");
    expect(fromFailedNodeCheck({ ...ok, rows: [] }).reason).toBe("no_nodes");
    expect(fromFailedNodeCheck({ ...ok, hashThen: null }).reason).toBe("no_nodes");
    expect(fromFailedNodeCheck({ ...ok, rows: [{ node: "laptop", status: "failed" }] }).reason).toBe("nothing_carried");
    expect(fromFailedNodeCheck({ ...ok, rows: [{ node: "ad", status: "successful" }] }).reason).toBe("no_failed_node");
    expect(fromFailedNodeCheck({ ...ok, hashNow: "sha256:b" }).reason).toBe("changed");
    expect(fromFailedNodeCheck({ ...ok, hashNow: null }).reason).toBe("changed");
  });

  test("the nodes carried : the successful ones, with their outputs", () => {
    expect([...carriedNodes(rows).entries()]).toEqual([["ad", { status: "successful", elapsed: 3.5, artifacts: { account: "jdoe" }, job: null }]]);
  });

  test("the hash : the same workflow the same, any change another", () => {
    const [a] = workflowsOf(WORKFLOW());
    expect(workflowHash(a)).toBe(workflowHash(workflowsOf(WORKFLOW())[0]));
    expect(workflowHash(a)).not.toBe(workflowHash(workflowsOf(WORKFLOW("-v2"))[0]));
  });

  test("a multistep, an AWX or AAP workflow job, a nested one : no such relaunch", async () => {
    expect(await Job.fromFailedNodeOf({ id: 1, job_type: "multistep", status: "failed" }, {})).toBeNull();
    expect(await Job.fromFailedNodeOf({ id: 1, job_type: "workflow", status: "failed", parent_id: 9 }, {})).toBeNull();
    const graph = JSON.stringify({ nodes: [{ status: "successful" }, { status: "failed" }] });
    expect(await Job.fromFailedNodeOf({ id: 1, job_type: "awx", runner_kind: "awx", awx_id: 5, status: "failed", awx_workflow: graph }, {})).toBeNull();
    expect(await Job.fromFailedNodeOf({ id: 1, job_type: "awx", runner_kind: "aap", awx_id: 5, status: "failed", awx_workflow: graph }, {})).toBeNull();
    expect(await Job.fromFailedNodeOf({ id: 1, job_type: "awx", runner_kind: "ascender", awx_id: 5, status: "failed", awx_workflow: graph }, {})).toEqual({ ok: true, reason: "" });
    // an Ascender job template job (no graph) : none
    expect(await Job.fromFailedNodeOf({ id: 1, job_type: "awx", runner_kind: "ascender", awx_id: 5, status: "failed", awx_workflow: null }, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the schema", () => {
  test("the patch adds the table and the column once : run again, it leaves them", async () => {
    const src = fs.readFileSync(new URL("../src/models/schema.model.js", import.meta.url), "utf8");
    expect(src).toMatch(/addTable\("workflow_node_runs", nodeRuns\.toString\(\)\)/);
    expect(src).toMatch(/addColumn\("jobs", "workflow_hash", "varchar\(80\)", true, "NULL"\)/);
    // the table's own file : a plain CREATE TABLE, run only when SHOW TABLES does not list it
    // (addTable), so the patch is the same on MySQL 8 and MariaDB, and twice is once
    const file = fs.readFileSync(new URL("../src/db/create_workflow_node_runs_table.sql", import.meta.url), "utf8");
    expect(file).toMatch(/CREATE TABLE `workflow_node_runs`/);
    // no column type one of them lacks (a JSON column is longtext on MariaDB), nothing generated
    expect(file).not.toMatch(/`\w+` json\b|GENERATED ALWAYS/i);
    const fresh = fs.readFileSync(new URL("../src/db/create_schema_and_tables.sql", import.meta.url), "utf8");
    expect(fresh).toMatch(/`workflow_hash` varchar\(80\) DEFAULT NULL/);
    expect(fresh).toMatch(/CREATE TABLE `workflow_node_runs`/);
  });

  test("the patch run twice creates the table once", async () => {
    const mysql = (await import("../src/models/db.model.js")).default;
    const tables = new Set();
    const columns = new Set();
    const created = [];
    const previous = mysql.do.getMockImplementation();
    mysql.do.mockImplementation(async (sql, params) => {
      if (/^SHOW TABLES FROM/.test(sql)) return tables.has(params[2]) ? [{ name: params[2] }] : [];
      if (/CREATE TABLE `workflow_node_runs`/.test(sql)) {
        tables.add("workflow_node_runs");
        created.push("workflow_node_runs");
        return {};
      }
      if (/^SHOW COLUMNS FROM/.test(sql)) return columns.has(`${params[1]}.${params[2]}`) || params[1] !== "jobs" ? [{ Field: params[2] }] : [];
      if (/^ALTER TABLE \?\?\.\?\? ADD COLUMN/.test(sql)) {
        columns.add(`${params[1]}.${params[2]}`);
        created.push(`${params[1]}.${params[2]}`);
        return {};
      }
      return [];
    });
    const { patchVersion7 } = await import("../src/models/schema.model.js");
    for (let i = 0; i < 2; i++) await patchVersion7([], [], []);
    expect(created.filter((c) => c === "workflow_node_runs")).toHaveLength(1);
    expect(created.filter((c) => c === "jobs.workflow_hash")).toHaveLength(1);
    mysql.do.mockImplementation(previous);
    expect(Schema).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
describe("an Ascender workflow job", () => {
  test("is relaunched with Ascender's own relaunch from the failed nodes, and followed", async () => {
    expect(failedNodesRelaunchBody()).toEqual({ nodes: "failed" });
    const post = vi.spyOn(axios, "post").mockResolvedValueOnce({ data: { id: 88, type: "workflow_job", name: "onboarding", status: "pending" } });
    const update = vi.spyOn(Job, "update").mockResolvedValue();
    vi.spyOn(Job, "printJobOutput").mockResolvedValue();
    const track = vi.spyOn(Awx, "trackJob").mockResolvedValueOnce(true);
    const findTemplate = vi.spyOn(Awx, "findJobTemplateByName");
    const runner = { name: "asc", type: "awx", flavour: "ascender", uri: "https://asc.example.com", token: "t" };
    await Awx.launch(runner, { __template__: "onboarding", __relaunchOf__: { id: 42, scope: "failedNode", awxId: 77 } }, {}, 43, 1);
    expect(post).toHaveBeenCalledWith("https://asc.example.com/api/v2/workflow_jobs/77/relaunch/", { nodes: "failed" }, expect.any(Object));
    expect(findTemplate).not.toHaveBeenCalled();
    expect(JSON.parse(update.mock.calls[0][0].awx_workflow)).toMatchObject({ id: 88, nodes: [] });
    expect(track).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------------------------
describe("issue #1082 : Ascender's retries, carried over and forced nodes", () => {
  const node = (extra = {}) => ({
    id: 12, job: 102, do_not_run: false,
    summary_fields: { job: { name: "deploy", type: "job", status: "failed", elapsed: 4 } },
    related: { job: "/api/v2/jobs/102/" },
    ...extra,
  });

  test("a failed attempt with a retry to come is retrying, not failed ; once the workflow ended, failed", () => {
    const n = node({ max_retries: 2, retry_attempts: 1, retried_jobs: [101] });
    expect(workflowNodeOf(n, true)).toMatchObject({ status: "retrying", job_status: "failed", max_retries: 2, retry_attempts: 1, retried_jobs: [101] });
    expect(workflowNodeOf(n, false).status).toBe("failed");
    // no retries left : failed
    expect(workflowNodeOf(node({ max_retries: 2, retry_attempts: 2 }), true).status).toBe("failed");
    // AWX and AAP : no retry fields at all
    expect(workflowNodeOf(node(), true)).not.toHaveProperty("max_retries");
  });

  test("a node carried over : successful, in its earlier time, marked ; a forced one with its reason", () => {
    const carried = workflowNodeOf({ id: 3, job: null, prior_run_succeeded: true, prior_run_elapsed: 12.5, summary_fields: { unified_job_template: { name: "ad" } } });
    expect(carried).toMatchObject({ status: "successful", elapsed: 12.5, carried: true, job: null });
    const forced = workflowNodeOf({ id: 4, job: null, prior_run_succeeded: true, forced_success: true, forced_success_reason: "done by hand", summary_fields: { unified_job_template: { name: "laptop" } } });
    expect(forced).toMatchObject({ status: "successful", carried: true, forced_success: true, forced_success_reason: "done by hand" });
  });

  test("each attempt is a job of its own, numbered among the attempts the node may make", () => {
    const n = workflowNodeOf(node({ max_retries: 2, retry_attempts: 1, retried_jobs: [101] }), false);
    expect(nodeAttempts(n)).toEqual([
      { job: 101, attempt: 1, of: 3, current: false, key: "12:1", total: 2 },
      { job: 102, attempt: 2, of: 3, current: true, key: "12:2", total: 2 },
    ]);
    expect(nodeAttempts(workflowNodeOf(node(), false))).toEqual([{ job: 102, attempt: 1, of: 0, current: true, key: "12", total: 1 }]);
  });

  test("the banner names the attempt only once the node was retried", () => {
    // retried : every attempt says which it is
    const retried = nodeAttempts(workflowNodeOf(node({ max_retries: 2, retry_attempts: 1, retried_jobs: [101] }), false));
    expect(retried.map(attemptLabel)).toEqual(["attempt 1 of 3", "attempt 2 of 3"]);
    // succeeded at its first attempt : nothing, as a node without retries
    const once = nodeAttempts(workflowNodeOf(node({ max_retries: 2, retry_attempts: 0 }), false));
    expect(once.map(attemptLabel)).toEqual([""]);
    expect(nodeAttempts(workflowNodeOf(node(), false)).map(attemptLabel)).toEqual([""]);
  });

  test("the output : a block per attempt (attempt 1 of 3, attempt 2 of 3), a carried node once", async () => {
    const wfJob = { id: 9, url: "/api/v2/workflow_jobs/9/", name: "release", status: "failed", finished: "2026-11-15", related: { workflow_nodes: "/api/v2/workflow_jobs/9/workflow_nodes/" } };
    const nodes = [
      node({ max_retries: 2, retry_attempts: 1, retried_jobs: [101], summary_fields: { job: { name: "deploy", type: "job", status: "successful", elapsed: 4 } } }),
      { id: 3, job: null, prior_run_succeeded: true, prior_run_elapsed: 2, summary_fields: { unified_job_template: { name: "build" } }, success_nodes: [12] },
    ];
    vi.spyOn(axios, "get").mockImplementation(async (url) => {
      if (url.endsWith("/workflow_jobs/9/")) return { data: wfJob };
      if (url.endsWith("/workflow_nodes/")) return { data: { results: nodes, next: null } };
      const id = Number(url.match(/\/jobs\/(\d+)\/$/)[1]);
      return { data: { id, status: id === 101 ? "failed" : "successful" } };
    });
    vi.spyOn(Awx, "finalJobRead").mockImplementation(async (awx, jobid, job) => ({ job, output: `output of job ${job.id}` }));
    vi.spyOn(Awx, "storeNodeEvents").mockResolvedValue();
    const printed = [];
    vi.spyOn(Job, "printJobOutput").mockImplementation(async (line) => printed.push(line));
    vi.spyOn(Job, "update").mockResolvedValue();
    vi.spyOn(Job, "isAbortRequested").mockResolvedValue(false);
    vi.spyOn(Job, "endJobStatus").mockResolvedValue();
    const runner = { name: "asc", type: "awx", flavour: "ascender", uri: "https://asc.example.com", token: "t" };
    await Awx.trackWorkflowJob(runner, wfJob, 50, 0);
    const out = printed.join("\n");
    expect(out).toMatch(/WORKFLOW NODE \[deploy\] \(failed\) #12 attempt 1 of 3 \*+\noutput of job 101/);
    expect(out).toMatch(/WORKFLOW NODE \[deploy\] \(successful\) #12 attempt 2 of 3 \*+\noutput of job 102/);
    expect(out).toMatch(/WORKFLOW NODE \[build\] \(successful\) #3 carried over \*+\nok: \[carried over from the previous run\]/);
    // followed again : nothing printed twice (by attempt, not by node)
    expect(printedWorkflowKeys(printed.map((output) => ({ output }))).sort()).toEqual(["12:1", "12:2", "3:carried"]);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/v2/job/:id/relaunch with fromFailedNode", () => {
  const user = { username: "alice", type: "local", roles: ["default"], options: { allowJobRelaunch: true } };
  const workflowJob = (extra = {}) => ({
    id: 42, form: "Onboard", status: "failed", user: "alice", user_type: "local", job_type: "workflow",
    extravars: JSON.stringify({ name: "jdoe" }), credentials: "{}", raw_form_data: null, parent_id: null, ...extra,
  });
  let Form;
  beforeEach(async () => {
    Form = (await import("../src/models/form.model.js")).default;
    vi.spyOn(Form, "load").mockResolvedValue({ constants: {}, forms: [{ name: "Onboard", type: "workflow", workflow: "onboarding.yml" }] });
    vi.spyOn(Job, "findById").mockResolvedValue(workflowJob());
    vi.spyOn(Job, "launch").mockResolvedValue({ id: 43 });
    vi.spyOn(Job, "sendEventNotification").mockResolvedValue();
    db.hashes[42] = workflowHash(workflowsOf(WORKFLOW())[0]);
    db.nodeRuns[42] = { ad: { node: "ad", status: "successful", artifacts: "{}" }, laptop: { node: "laptop", status: "failed" } };
  });

  test("the same relaunch, its run told to carry the nodes that succeeded over", async () => {
    const r = await Job.relaunch(user, 42, false, { fromFailedNode: true });
    expect(r).toMatchObject({ id: 43, fromFailedNode: true });
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ form: "Onboard", replay: true });
    expect(arg.serverExtravars).toEqual({ __relaunchOf__: { id: 42, scope: "failedNode" } });
    expect(Job.sendEventNotification).toHaveBeenCalledWith(42, "relaunch", user);
    vi.restoreAllMocks();
  });

  test("the same rights as a relaunch ; not with failedHostsOnly ; not once the workflow changed", async () => {
    Job.findById.mockResolvedValue(workflowJob({ user: "bob" }));
    await expect(Job.relaunch(user, 42, false, { fromFailedNode: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    Job.findById.mockResolvedValue(workflowJob());
    await expect(Job.relaunch({ ...user, options: {} }, 42, false, { fromFailedNode: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    await expect(Job.relaunch(user, 42, false, { fromFailedNode: true, failedHostsOnly: true })).rejects.toMatchObject({ name: "BadRequestError" });
    fs.writeFileSync(path.join(root, "onboarding.yml"), WORKFLOW("-v2"));
    await expect(Job.relaunch(user, 42, false, { fromFailedNode: true })).rejects.toMatchObject({ code: "NOT_FROM_FAILED_NODE", reason: "changed" });
    expect(Job.launch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("a multistep job gets nothing new", async () => {
    Job.findById.mockResolvedValue(workflowJob({ job_type: "multistep" }));
    Form.load.mockResolvedValue({ constants: {}, forms: [{ name: "Onboard", type: "multistep", steps: [] }] });
    await expect(Job.relaunch(user, 42, false, { fromFailedNode: true })).rejects.toMatchObject({ code: "NOT_FROM_FAILED_NODE" });
    vi.restoreAllMocks();
  });
});
