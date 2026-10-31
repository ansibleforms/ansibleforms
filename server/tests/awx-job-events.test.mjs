// A job run on AWX, AAP or Ascender has its structured events, as a playbook run on an RTE has :
// while the app follows the job it reads AWX's job events (/jobs/<id>/job_events/) and stores them
// in job_events in the shape the af_events callback plugin writes, so the job page's Hosts and
// tasks panel, its recap and its clickable result lines work for it.
//
// The fixtures (tests/fixtures/awx-events) come from one playbook (three hosts : ok, changed, a
// role's task, a handler, loop items, a skipped host, a failure ignored, a failure, an unreachable
// host) run twice with ansible-core 2.21 and -v : once through ansible-runner, which writes the
// events AWX stores (awx-job-events.json, in the shape of AWX's API, and its stdout
// awx-stdout.txt), and once with the RTE's af_events plugin (af-events.jsonl). The tests run the
// real tracker against a small test AWX, with the database mocked.
import { test, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

const { default: Job } = await import("../src/models/job.model.js");
const { default: JobEvent } = await import("../src/models/jobEvent.model.js");
const { Awx } = await import("../src/runners/awx/api.js");
const { mapAwxEvent, createAwxEventReader, EVENT_PROCESSING_WAIT } = await import("../src/runners/awx/events.js");
const { default: logger } = await import("../src/lib/logger.js");
const { default: mysql } = await import("../src/models/db.model.js");
const { default: appConfig } = await import("../config/app.config.js");
const { registerJobSecrets, forgetJobSecrets } = await import("../src/lib/outputMask.js");
const { RUNNER_TYPE_OF, jobTypeOf } = await import("../src/lib/jobTypes.js");
const { getRunner } = await import("../src/runners/index.js");

// --------------------------------------------------------------------------------------
// the fixtures
// --------------------------------------------------------------------------------------
const FIXTURES = new URL("./fixtures/awx-events/", import.meta.url);
const AWX_EVENTS = JSON.parse(fs.readFileSync(new URL("awx-job-events.json", FIXTURES), "utf8"));
const AWX_STDOUT = fs.readFileSync(new URL("awx-stdout.txt", FIXTURES), "utf8");
const AF_EVENTS = fs
  .readFileSync(new URL("af-events.jsonl", FIXTURES), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const STORED = JSON.parse(fs.readFileSync(new URL("awx-stored-events.json", FIXTURES), "utf8"));

// --------------------------------------------------------------------------------------
// the test database : the job's output rows, its events, its row
// --------------------------------------------------------------------------------------
var jobRow = {};
var rows = [];
var events = [];
var nextId = 1;
var failEventWrites = false;
mysql.do = async function (sql, params) {
  if (sql.includes("INSERT IGNORE INTO AnsibleForms.`job_events`")) {
    if (failEventWrites) throw new Error("the database is gone");
    let affected = 0;
    for (const [job_id, order, type, play, task, host, duration, time, data, result] of params[0]) {
      if (events.some((e) => e.job_id === job_id && e.order === order)) continue;
      events.push({ job_id, order, type, play, task, host, duration, time, data, result });
      affected++;
    }
    return { affectedRows: affected };
  }
  if (sql.includes("SELECT MAX(`order`) AS last FROM AnsibleForms.`job_events`")) {
    const mine = events.filter((e) => e.job_id === params[0]).map((e) => e.order);
    return [{ last: mine.length ? Math.max(...mine) : null }];
  }
  if (sql.includes("DELETE FROM AnsibleForms.`job_events` WHERE job_id=?")) {
    const before = events.length;
    events = events.filter((e) => e.job_id !== params[0]);
    return { affectedRows: before - events.length };
  }
  // JobEvent.findByJob
  if (sql.includes("(result IS NOT NULL) AS detailed FROM AnsibleForms.`job_events`")) {
    return events
      .filter((e) => e.job_id === params[0])
      .sort((a, b) => a.order - b.order)
      .map((e) => ({ ...e, detailed: e.result !== null ? 1 : 0 }));
  }
  if (sql.includes("INSERT INTO AnsibleForms.`job_output`")) {
    const row = { id: nextId++, ...params[0] };
    rows.push(row);
    return { insertId: row.id };
  }
  if (sql.includes("DELETE FROM AnsibleForms.`job_output` WHERE job_id=? AND output_type='stdout'")) {
    const [, fromOrder, keepId] = params;
    rows = rows.filter((r) => !(r.output_type == "stdout" && r.order >= fromOrder && r.id != keepId));
    return { affectedRows: 1 };
  }
  if (sql.includes("UPDATE AnsibleForms.`jobs` set ?")) {
    Object.assign(jobRow, params[0]);
    return { changedRows: 1 };
  }
  // Job.transitionStatus : only from the statuses it names
  if (sql.includes("UPDATE AnsibleForms.`jobs` SET ? WHERE id=? AND status IN (?)")) {
    if (!params[2].includes(jobRow.status ?? "running")) return { affectedRows: 0 };
    Object.assign(jobRow, params[0]);
    return { affectedRows: 1, changedRows: 1 };
  }
  if (sql.includes("SELECT abort_requested")) return [{ abort_requested: 0 }];
  if (sql.includes("SELECT id FROM AnsibleForms.`jobs`")) return [{ id: params[0] }];
  return [];
};
Job.sendStatusNotification = async () => {};

// --------------------------------------------------------------------------------------
// the test AWX : job 77 runs for `polls` polls ; its events come in as it runs (all of them by
// its last poll), a page at a time as AWX serves them (counter__gt, order_by, page_size, next)
// --------------------------------------------------------------------------------------
var awx = {};
var requests = [];

/**
 * The events AWX has stored by now : counters up to a share of the run, those `late` holds
 * only from a later poll on (AWX stores them slightly out of order).
 */
function visibleEvents() {
  const share = Math.min(1, awx.poll / awx.polls);
  const upTo = Math.ceil(share * awx.events.length);
  return awx.events.filter((e) => e.counter <= upTo && awx.poll >= (awx.late[e.counter] ?? 0) && (settled(77) || e.counter <= awx.heldAfter));
}

/**
 * Whether AWX has saved all of a job's events (its event_processing_finished) : job 77 `settle`
 * polls after it has finished, a node's job on its `settle`th read ; undefined when the job
 * does not say (an older API, the field absent), as AWX said nothing before.
 */
function settled(id) {
  if (id == 77) return awx.settle === undefined ? undefined : awx.poll >= awx.polls + awx.settle;
  const node = awx.nodes[id];
  return node?.settle === undefined ? undefined : node.gets >= node.settle;
}

/**
 * A job's output as AWX serves it : its last lines missing until AWX has saved all its events
 * (AWX assembles the output from them).
 */
function servedStdout(id, full) {
  if (settled(id) !== false) return full;
  const lines = full.split("\n");
  return lines.slice(0, Math.max(1, lines.length - 3)).join("\n");
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.slice(awx.prefix.length);
  requests.push({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, poll: awx.poll });
  if (!url.pathname.startsWith(awx.prefix)) return send(res, 404, {});
  // the template a form names, and its launch (a form of type awx, aap or ascender)
  if (path == "/job_templates/" && req.method == "GET") {
    return send(res, 200, { count: 1, results: [{ id: 5, name: "deploy", related: { launch: `${awx.prefix}/job_templates/5/launch/` } }] });
  }
  if (path == "/job_templates/5/credentials/") return send(res, 200, { count: 0, results: [] });
  if (path == "/job_templates/5/launch/" && req.method == "POST") return send(res, 201, awxJob(77));
  let m = /^\/jobs\/(\d+)\/$/.exec(path);
  if (m) {
    const id = Number(m[1]);
    if (id == 77) awx.poll++;
    else if (awx.nodes[id]) awx.nodes[id].gets = (awx.nodes[id].gets || 0) + 1;
    return send(res, 200, awxJob(id));
  }
  m = /^\/jobs\/(\d+)\/stdout\/$/.exec(path);
  if (m) return send(res, 200, servedStdout(m[1], Number(m[1]) == 77 ? AWX_STDOUT : awx.nodes[m[1]]?.stdout || ""));
  m = /^\/jobs\/(\d+)\/job_events\/$/.exec(path);
  if (m) {
    if (awx.eventsStatus) return send(res, awx.eventsStatus, { detail: "events are down" });
    const id = Number(m[1]);
    const node = awx.nodes[id];
    // a node's job : its events after `heldAfter` saved only once AWX has saved them all
    const all = id == 77 ? visibleEvents() : (node?.events || []).filter((e) => settled(id) !== false || e.counter <= node.heldAfter);
    const after = Number(url.searchParams.get("counter__gt") || 0);
    const size = Number(url.searchParams.get("page_size") || 25);
    const left = all.filter((e) => e.counter > after).sort((a, b) => a.counter - b.counter);
    const page = left.slice(0, size);
    const next = left.length > size ? `${awx.prefix}/jobs/${id}/job_events/?page=2` : null;
    return send(res, 200, { count: left.length, next, previous: null, results: page });
  }
  // a workflow : two playbook nodes and an approval
  if (path == "/workflow_jobs/90/") {
    awx.wfPoll++;
    const done = awx.wfPoll >= 2;
    return send(res, 200, {
      id: 90,
      type: "workflow_job",
      name: "wf",
      url: `${awx.prefix}/workflow_jobs/90/`,
      status: done ? "successful" : "running",
      finished: done ? "2026-01-01T10:00:00Z" : null,
      related: { workflow_nodes: `${awx.prefix}/workflow_jobs/90/workflow_nodes/` },
    });
  }
  if (path == "/workflow_jobs/90/workflow_nodes/") {
    const done = awx.wfPoll >= 2;
    const node = (id, job, name, type) => ({
      id,
      job,
      related: { job: `${awx.prefix}/${type == "workflow_approval" ? "workflow_approvals" : "jobs"}/${job}/` },
      summary_fields: { job: { id: job, name, type, status: done ? "successful" : "running", elapsed: 1 } },
      success_nodes: [],
      failure_nodes: [],
      always_nodes: [],
    });
    return send(res, 200, { count: 3, next: null, results: [node(1, 91, "first", "job"), node(2, 95, "approve", "workflow_approval"), node(3, 92, "second", "job")] });
  }
  if (path == "/workflow_approvals/95/") return send(res, 200, { id: 95, type: "workflow_approval", status: "successful", related: {} });
  return send(res, 404, {});
}

/**
 * An AWX job as AWX's API returns it : job 77 (the fixture's run) or a workflow node's job.
 */
function awxJob(id) {
  const finished = id != 77 || awx.poll >= awx.polls;
  const related = { stdout: `${awx.prefix}/jobs/${id}/stdout/` };
  if (awx.relatedEvents) related.job_events = `${awx.prefix}/jobs/${id}/job_events/`;
  return {
    id,
    type: "job",
    name: id == 77 ? "deploy" : `node job ${id}`,
    url: `${awx.prefix}/jobs/${id}/`,
    status: finished ? "successful" : "running",
    finished: finished ? "2026-01-01T10:00:00Z" : null,
    verbosity: awx.verbosity,
    artifacts: {},
    related,
    // AWX's flag, when the test sets it : all the job's events saved
    ...(settled(id) === undefined ? {} : { event_processing_finished: settled(id) }),
  };
}

var server;
var base;
beforeAll(async () => {
  server = http.createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  jobRow = {};
  rows = [];
  events = [];
  nextId = 1;
  requests = [];
  failEventWrites = false;
  awx = { prefix: "/api/v2", poll: 0, polls: 7, events: AWX_EVENTS, late: {}, verbosity: 1, relatedEvents: true, eventsStatus: 0, wfPoll: 0, nodes: {}, settle: undefined, heldAfter: Infinity };
});

const runner = () => ({ uri: base, token: "test-token", ignore_certs: true });
const job77 = () => ({ id: 77, url: `${awx.prefix}/jobs/77/`, verbosity: awx.verbosity, related: awxJob(77).related });
const eventRequests = () => requests.filter((r) => /\/job_events\/$/.test(r.pathname));
const storedOf = (jobId) => events.filter((e) => e.job_id === jobId).sort((a, b) => a.order - b.order);

/**
 * Events as the comparisons read them : the times left out (two runs never share them), their
 * keys in order, and those of a play, a task or the recap each starting a group whose results
 * are sorted (the hosts of a task answer in any order).
 */
function groups(list) {
  const canon = (v) =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  const out = [];
  for (const e of list) {
    const o = { ...e };
    // present on the same events, their values differ from run to run
    for (const k of ["time", "duration", "start"]) if (k in o) o[k] = "T";
    // a command's own times and a skipped host's result (below) : not the same run
    if (o.result) o.result = Object.fromEntries(Object.entries(o.result).filter(([k]) => !["start", "end", "delta"].includes(k)));
    if (o.type === "skipped") {
      delete o.data;
      delete o.result;
    }
    if (["play", "task", "stats"].includes(o.type) || !out.length) out.push([]);
    out[out.length - 1].push(JSON.stringify(canon(o)));
  }
  return out.map((g) => [g[0], ...g.slice(1).sort()]);
}

// --------------------------------------------------------------------------------------
// the mapping : AWX's events as the af_events plugin writes them
// --------------------------------------------------------------------------------------
test("AWX's events of a run map to the events af_events writes for the same playbook", () => {
  const state = { play: "", task: "" };
  const mapped = AWX_EVENTS.flatMap((e) => mapAwxEvent(e, state, true));
  assert.equal(mapped.length, AF_EVENTS.length);
  assert.deepEqual(groups(mapped), groups(AF_EVENTS));
  // the times too : a host's result has when it started and how long it took
  for (const e of mapped.filter((x) => ["ok", "changed", "failed", "unreachable"].includes(x.type))) {
    assert.equal(typeof e.time, "number");
    assert.equal(typeof e.duration, "number");
    assert.ok(Math.abs(e.time - e.start - e.duration) < 0.01, "time is the end : start + duration");
  }
});

test("a skipped host's result comes from its line of the output : AWX's event has none of its own", () => {
  const state = { play: "", task: "" };
  const mapped = AWX_EVENTS.flatMap((e) => mapAwxEvent(e, state, true)).filter((e) => e.type === "skipped");
  const af = AF_EVENTS.filter((e) => e.type === "skipped");
  assert.equal(mapped.length, af.length);
  for (const e of mapped) {
    const twin = af.find((x) => x.task === e.task && x.host === e.host);
    assert.ok(e.result && Object.keys(e.result).length, `${e.task} ${e.host} has a result`);
    for (const [k, v] of Object.entries(e.result)) assert.deepEqual(twin.result[k], v);
  }
});

test("a skipped host whose line says little has the result af_events stores for a skipped host", () => {
  const skip = (stdout, full) => mapAwxEvent({ counter: 1, event: "runner_on_skipped", event_data: { host: "h1" }, stdout }, { play: "", task: "" }, full)[0];
  const AF_SKIP = { changed: false, skip_reason: "Conditional result was False" };
  // the job not verbose : the line has no result
  assert.deepEqual(skip("skipping: [h1]", false).data, AF_SKIP);
  assert.deepEqual(skip("skipping: [h1]", true).result, AF_SKIP);
  // a debug task's line : its condition only, the rest as af_events stores it
  const debug = skip('skipping: [h1] => {"false_condition": "x == 1"}', true);
  assert.deepEqual(debug.data, AF_SKIP);
  assert.deepEqual(debug.result, { ...AF_SKIP, false_condition: "x == 1" });
  // a line that says why : kept as it is
  assert.equal(skip('skipping: [h1] => {"changed": false, "skip_reason": "No items in the list"}', true).data.skip_reason, "No items in the list");
  // as af_events stores it for the same playbook
  assert.deepEqual(AF_EVENTS.find((e) => e.type === "skipped").data, AF_SKIP);
});

test("each event type maps to its type, its task named as the output names it", () => {
  const state = { play: "", task: "" };
  const at = "2026-01-01T10:00:00.250000+00:00";
  const map = (event, event_data = {}, extra = {}) => mapAwxEvent({ counter: 1, event, event_data, created: at, ...extra }, state, false);
  assert.deepEqual(map("playbook_on_play_start", { name: "Site" }, { stdout: "\r\nPLAY [Site] ****" }), [{ type: "play", time: 1767261600.25, play: "Site", task: "" }]);
  // a role's task : the output's head line says role : name, AWX's own task has the name only
  assert.deepEqual(map("playbook_on_task_start", { task: "Install", role: "web", task_action: "ansible.builtin.package" }, { stdout: "TASK [web : Install] ***" }), [
    { type: "task", time: 1767261600.25, play: "Site", task: "web : Install", action: "ansible.builtin.package" },
  ]);
  // without its text : event_data.name, else role : task
  assert.equal(map("playbook_on_task_start", { task: "Install", role: "web" })[0].task, "web : Install");
  assert.equal(map("playbook_on_task_start", { task: "Install", name: "db : Install" })[0].task, "db : Install");
  assert.equal(map("playbook_on_handler_task_start", { task: "Restart" }, { stdout: "RUNNING HANDLER [Restart] ****" })[0].task, "Restart");
  const res = (r) => ({ host: "h1", task_action: "ansible.builtin.command", res: r, start: "2026-01-01T10:00:00", end: "2026-01-01T10:00:01.5", duration: 1.5 });
  assert.equal(map("runner_on_ok", res({ changed: false }))[0].type, "ok");
  const changed = map("runner_on_ok", res({ changed: true, rc: 0, stdout: "x" }))[0];
  // a time without its zone is UTC ; the event's time is its end
  assert.deepEqual(changed, { type: "changed", time: 1767261601.5, play: "Site", task: "Restart", host: "h1", duration: 1.5, start: 1767261600, data: { rc: 0, changed: true }, action: "ansible.builtin.command" });
  assert.deepEqual(map("runner_on_failed", { ...res({ msg: "boom" }), ignore_errors: true }).map((e) => [e.type, e.host]), [["failed", "h1"], ["ignored", "h1"]]);
  assert.deepEqual(map("runner_on_failed", res({ msg: "boom" })).map((e) => e.type), ["failed"]);
  assert.equal(map("runner_on_unreachable", res({ msg: "gone", unreachable: true }))[0].type, "unreachable");
  assert.equal(map("runner_on_skipped", { host: "h1" }, { stdout: "skipping: [h1]" })[0].type, "skipped");
  const item = (event, r) => map(event, { host: "h1", res: r })[0];
  assert.deepEqual([item("runner_item_on_ok", { item: "a" }).status, item("runner_item_on_ok", { item: "a", changed: true }).status], ["ok", "changed"]);
  assert.equal(item("runner_item_on_failed", { item: 1 }).status, "failed");
  assert.equal(item("runner_item_on_skipped", { item: true }).status, "skipped");
  assert.equal(item("runner_item_on_ok", { item: "a" }).type, "item");
  // the recap : AWX names unreachable dark ; the hosts sorted, every count there
  const stats = map("playbook_on_stats", { ok: { h2: 2, h1: 1 }, dark: { h2: 1 }, processed: { h2: 1, h1: 1 } })[0];
  assert.deepEqual(stats.data, {
    h1: { ok: 1, changed: 0, unreachable: 0, failures: 0, skipped: 0, rescued: 0, ignored: 0 },
    h2: { ok: 2, changed: 0, unreachable: 1, failures: 0, skipped: 0, rescued: 0, ignored: 0 },
  });
  assert.equal(stats.task, "");
  // what the plugin writes nothing for
  for (const kind of ["verbose", "runner_on_start", "playbook_on_start", "playbook_on_include", "playbook_on_notify", "runner_retry"]) assert.deepEqual(map(kind, { host: "h1" }), []);
});

test("a host's whole result is kept only when the job runs verbose, as on an RTE", () => {
  const ev = { counter: 1, event: "runner_on_ok", event_data: { host: "h1", res: { changed: false, msg: "hi", stdout: "x" } } };
  assert.equal(mapAwxEvent(ev, { play: "", task: "" }, false)[0].result, undefined);
  assert.deepEqual(mapAwxEvent(ev, { play: "", task: "" }, true)[0].result, { changed: false, msg: "hi", stdout: "x" });
});

test("secrets are masked : a secret key's value, a loop item's, the module's arguments, the job's own secrets", async () => {
  const state = { play: "", task: "" };
  const ev = {
    counter: 1,
    event: "runner_item_on_ok",
    event_data: {
      host: "h1",
      res: {
        msg: "logged in with hunter2-secret",
        api_token: "abc",
        nested: { password: "p", list: [{ authorization: "Bearer x" }] },
        invocation: { module_args: { password: "p" } },
        _ansible_no_log: false,
        item: { name: "a", password: "pw" },
      },
    },
  };
  const [e] = mapAwxEvent(ev, state, true);
  assert.equal(e.item, '{"name": "a", "password": "********"}');
  assert.equal(e.result.api_token, "********");
  assert.equal(e.result.nested.password, "********");
  assert.equal(e.result.nested.list[0].authorization, "********");
  assert.equal("invocation" in e.result, false);
  assert.equal("_ansible_no_log" in e.result, false);
  // stored : the job's own secrets (its credentials, its password fields) masked as its output
  registerJobSecrets(31, ["hunter2-secret"]);
  try {
    await JobEvent.create(31, [{ ...e, order: 1 }]);
  } finally {
    forgetJobSecrets(31);
  }
  const [row] = storedOf(31);
  assert.doesNotMatch(row.data, /hunter2-secret/);
  assert.doesNotMatch(row.result, /hunter2-secret/);
  assert.match(row.data, /logged in with \*{8}/);
});

test("a result is capped as af_events caps it : long texts cut, then too large to keep", () => {
  const state = { play: "", task: "" };
  const big = (res) => mapAwxEvent({ counter: 1, event: "runner_on_ok", event_data: { host: "h1", res } }, state, true)[0];
  // a message over 2000 characters is cut on the summary
  assert.equal(big({ msg: "m".repeat(2500) }).data.msg, "m".repeat(2000) + "...");
  // past 64 KB of JSON : its texts cut at 8000 characters, its lists at 200 items
  const cut = big({ stdout: "s".repeat(70000), lines: Array.from({ length: 300 }, (_, i) => `line ${i}`) }).result;
  assert.equal(cut.stdout, "s".repeat(8000) + "...");
  assert.equal(cut.lines.length, 201);
  assert.equal(cut.lines[200], "... 100 more");
  // still too large once cut : its keys only
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(7000)]));
  assert.deepEqual(big(many).result, { msg: "The result is too large to keep", keys: Object.keys(many).sort() });
});

// --------------------------------------------------------------------------------------
// the reader : pages, increments, gaps, failures
// --------------------------------------------------------------------------------------
test("the events are read a page at a time, in order, each stored once", async () => {
  const pages = [];
  const all = AWX_EVENTS;
  const reader = createAwxEventReader({
    jobid: 40,
    full: true,
    fetchPage: async (after) => {
      pages.push(after);
      const left = all.filter((e) => e.counter > after);
      return { results: left.slice(0, 20), next: left.length > 20 ? "more" : null };
    },
  });
  await reader.finish();
  // 67 events, 20 a page
  assert.deepEqual(pages, [0, 20, 40, 60]);
  const stored = storedOf(40);
  assert.deepEqual(stored.map((e) => e.order), AF_EVENTS.map((_, i) => i + 1));
  // a second read finds nothing new
  await reader.finish();
  assert.equal(storedOf(40).length, AF_EVENTS.length);
});

test("while the job runs a counter missing is waited for ; the read when it has ended takes it", async () => {
  const shown = AWX_EVENTS.filter((e) => e.counter !== 5 && e.counter <= 12);
  const reader = createAwxEventReader({ jobid: 41, fetchPage: async (after) => ({ results: shown.filter((e) => e.counter > after), next: null }) });
  reader.poll();
  // the background read : counters 1 to 4, stopped before the missing 5
  await new Promise((r) => setTimeout(r, 50));
  const first = storedOf(41).length;
  const expected = (upTo) => AWX_EVENTS.filter((e) => e.counter <= upTo).flatMap((e) => mapAwxEvent(e, { play: "", task: "" }, false)).length;
  assert.equal(first, expected(4));
  // 5 comes, the job ends
  shown.push(AWX_EVENTS.find((e) => e.counter === 5));
  await reader.finish();
  const stored = storedOf(41);
  assert.equal(stored.length, expected(12));
  assert.deepEqual(stored.map((e) => e.order), stored.map((_, i) => i + 1));
});

test("an events read that fails is logged and never thrown, a store that fails as well", async () => {
  const failing = createAwxEventReader({ jobid: 42, fetchPage: async () => Promise.reject(new Error("AWX is down")) });
  await failing.finish();
  failEventWrites = true;
  const storing = createAwxEventReader({ jobid: 42, fetchPage: async () => ({ results: AWX_EVENTS.slice(0, 5), next: null }) });
  await storing.finish();
  assert.equal(storedOf(42).length, 0);
});

// --------------------------------------------------------------------------------------
// following a job : the real tracker against the test AWX
// --------------------------------------------------------------------------------------
test("while a job runs its events are read as they come, and all of them once it has ended", { timeout: 30000 }, async () => {
  // counter 9 comes two polls after those that follow it
  awx.late = { 9: 4 };
  await Awx.trackJob(runner(), job77(), 77, 0);
  assert.equal(jobRow.status, "success");
  const reads = eventRequests();
  // read while the job ran (the job had more polls to go), not only at its end
  assert.ok(reads.some((r) => r.poll < awx.polls), "a read while the job ran");
  assert.ok(reads.length >= 3, `several reads (${reads.length})`);
  // each read from the last counter on, in order, a page of 200
  for (const r of reads) assert.deepEqual([r.query.order_by, r.query.page_size], ["counter", "200"]);
  // every event once, in order : as the stored fixture the job page reads
  assert.deepEqual(await JobEvent.findByJob(77), STORED);
});

test("the stored events are there before the job ends", { timeout: 30000 }, async () => {
  awx.polls = 2;
  let atEnd = null;
  const end = Job.endJobStatus;
  Job.endJobStatus = async (...args) => {
    atEnd = storedOf(77).length;
    return end.apply(Job, args);
  };
  try {
    await Awx.trackJob(runner(), job77(), 77, 0);
  } finally {
    Job.endJobStatus = end;
  }
  assert.equal(atEnd, STORED.length);
});

test("a job whose events cannot be read ends as it would without them", { timeout: 30000 }, async () => {
  awx.eventsStatus = 500;
  awx.polls = 3;
  const started = Date.now();
  await Awx.trackJob(runner(), job77(), 77, 0);
  assert.equal(jobRow.status, "success");
  assert.equal(storedOf(77).length, 0);
  assert.ok(eventRequests().length >= 1);
  // no slower : a poll a second, as before
  assert.ok(Date.now() - started < 8000);
});

test("a job that is not verbose stores its events without their whole results", { timeout: 30000 }, async () => {
  awx.verbosity = 0;
  awx.polls = 2;
  await Awx.trackJob(runner(), job77(), 77, 0);
  const stored = await JobEvent.findByJob(77);
  assert.equal(stored.length, STORED.length);
  assert.ok(stored.every((e) => !e.detailed));
});

test("a job followed again after a restart has its events read again, none twice", { timeout: 30000 }, async () => {
  awx.polls = 2;
  // what an earlier node stored before it stopped
  await JobEvent.create(77, [{ type: "play", play: "old", order: 1 }, { type: "task", task: "old", order: 2 }]);
  rows.push({ id: nextId++, job_id: 77, order: 1, output: "ok: [Launched template deploy with jobid 77]", output_type: "stdout" });
  await Awx.resume(runner(), { id: 77, awx_id: 77, awx_workflow: null });
  const stored = await JobEvent.findByJob(77);
  assert.equal(stored.length, STORED.length);
  assert.equal(stored[0].play, "Configure web");
});

// --------------------------------------------------------------------------------------
// AAP, Ascender : the same API, its prefix and its links as every other request
// --------------------------------------------------------------------------------------
test("the events are read from the job's own link, and else from the runner's uri and prefix", async () => {
  // AAP 2.5 : the uri carries the controller's API path, AWX's links are root-relative
  awx.prefix = "/api/controller/v2";
  const aap = { uri: `${base}/api/controller/v2`, use_credentials: true, username: "admin", password: "pw", ignore_certs: true };
  await Awx.getJobEvents(aap, { id: 77, related: { job_events: "/api/controller/v2/jobs/77/job_events/" } }, 4, 200);
  // no link : built as the other requests are
  await Awx.getJobEvents(aap, { id: 77 }, 0, 200);
  const reads = eventRequests();
  assert.deepEqual(reads.map((r) => r.pathname), ["/api/controller/v2/jobs/77/job_events/", "/api/controller/v2/jobs/77/job_events/"]);
  assert.deepEqual(reads.map((r) => r.query.counter__gt), ["4", "0"]);
  assert.equal(reads[0].auth, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
  // a uri without an API path : AWX_API_PREFIX, whatever it is set to
  const prefix = appConfig.awxApiPrefix;
  appConfig.awxApiPrefix = "/custom/api/v2";
  awx.prefix = "/custom/api/v2";
  try {
    await Awx.getJobEvents(runner(), { id: 77 }, 0, 200);
  } finally {
    appConfig.awxApiPrefix = prefix;
  }
  const last = eventRequests().at(-1);
  assert.equal(last.pathname, "/custom/api/v2/jobs/77/job_events/");
  assert.equal(last.auth, "Bearer test-token");
});

for (const formType of ["aap", "ascender"]) {
  test(`a form of type ${formType} launched on its runner stores its job's events`, { timeout: 30000 }, async () => {
    // the form type runs an awx job on an awx runner
    assert.equal(jobTypeOf(formType), "awx");
    awx.prefix = formType == "aap" ? "/api/controller/v2" : "/api/v2";
    awx.polls = 2;
    const row = { type: "awx", flavour: formType, uri: formType == "aap" ? `${base}/api/controller/v2` : base, token: "test-token", ignore_certs: true };
    const result = await getRunner(RUNNER_TYPE_OF[formType]).launch({ jobId: 77, extravars: { __template__: "deploy" }, credentialMap: {}, runner: row });
    assert.equal(result, true);
    assert.equal(jobRow.status, "success");
    assert.ok(eventRequests().every((r) => r.pathname == `${awx.prefix}/jobs/77/job_events/`));
    assert.deepEqual(await JobEvent.findByJob(77), STORED);
  });
}

test("a job without a link to its events (an older AWX) has them read from the prefix", { timeout: 30000 }, async () => {
  awx.relatedEvents = false;
  awx.polls = 2;
  await Awx.trackJob(runner(), job77(), 77, 0);
  assert.ok(eventRequests().length > 0);
  assert.ok(eventRequests().every((r) => r.pathname == "/api/v2/jobs/77/job_events/"));
  assert.equal(storedOf(77).length, STORED.length);
});

// --------------------------------------------------------------------------------------
// a workflow : each node's job's events, in the order of the output
// --------------------------------------------------------------------------------------
test("a workflow stores each node's job's events after the node's output, one after the other", { timeout: 30000 }, async () => {
  const play = (counter, name) => ({ counter, event: "playbook_on_play_start", event_data: { name }, stdout: `PLAY [${name}] ***` });
  const task = (counter, name) => ({ counter, event: "playbook_on_task_start", event_data: { task: name, task_action: "debug" }, stdout: `TASK [${name}] ***` });
  const ok = (counter, host) => ({ counter, event: "runner_on_ok", event_data: { host, res: { changed: false, msg: "hi" } } });
  awx.nodes = {
    91: { stdout: "PLAY [one] ***\nTASK [a] ***\nok: [h1]", events: [play(1, "one"), task(2, "a"), ok(3, "h1")] },
    92: { stdout: "PLAY [two] ***\nTASK [b] ***\nok: [h2]", events: [play(1, "two"), task(2, "b"), ok(3, "h2")] },
  };
  const wf = { id: 90, type: "workflow_job", url: "/api/v2/workflow_jobs/90/", related: { workflow_nodes: "/api/v2/workflow_jobs/90/workflow_nodes/" } };
  await Awx.trackWorkflowJob(runner(), wf, 90, 0);
  assert.equal(jobRow.status, "success");
  const stored = await JobEvent.findByJob(90);
  assert.deepEqual(
    stored.map((e) => [e.order, e.type, e.play, e.task, e.host]),
    [
      [1, "play", "one", "", null],
      [2, "task", "one", "a", null],
      [3, "ok", "one", "a", "h1"],
      [4, "play", "two", "", null],
      [5, "task", "two", "b", null],
      [6, "ok", "two", "b", "h2"],
    ].map(([o, t, p, k, h]) => [o, t, p, k || null, h]),
  );
  // the approval has no events : never asked for
  assert.ok(!eventRequests().some((r) => r.pathname.includes("/95/")));
});

// --------------------------------------------------------------------------------------
// AWX saves a job's last events a moment after it reports the job ended : the final read waits
// for its event_processing_finished
// --------------------------------------------------------------------------------------
test("a job's last events, saved by AWX after the job ended, are all stored, its output whole", { timeout: 30000 }, async () => {
  // the events after counter 60 and the output's last lines : saved 4 polls after the job ended
  awx.polls = 2;
  awx.settle = 4;
  awx.heldAfter = 60;
  await Awx.trackJob(runner(), job77(), 77, 0);
  assert.equal(jobRow.status, "success");
  assert.deepEqual(await JobEvent.findByJob(77), STORED);
  // the output : AWX's whole stdout, its recap included
  const stdout = rows.filter((r) => r.output_type == "stdout").map((r) => r.output).join("\n");
  assert.match(stdout, /h3 +: ok=1 +changed=0 +unreachable=1/);
});

test("a workflow node's last events and output, saved by AWX after the node ended, are all stored", { timeout: 30000 }, async () => {
  const play = (counter, name) => ({ counter, event: "playbook_on_play_start", event_data: { name }, stdout: `PLAY [${name}] ***` });
  const task = (counter, name) => ({ counter, event: "playbook_on_task_start", event_data: { task: name, task_action: "debug" }, stdout: `TASK [${name}] ***` });
  const ok = (counter, host) => ({ counter, event: "runner_on_ok", event_data: { host, res: { changed: false, msg: "hi" } } });
  // each node's host result : saved on the third read of its job
  awx.nodes = {
    91: { stdout: "PLAY [one] ***\nTASK [a] ***\nok: [h1]", events: [play(1, "one"), task(2, "a"), ok(3, "h1")], settle: 3, heldAfter: 2 },
    92: { stdout: "PLAY [two] ***\nTASK [b] ***\nok: [h2]", events: [play(1, "two"), task(2, "b"), ok(3, "h2")], settle: 3, heldAfter: 2 },
  };
  const wf = { id: 90, type: "workflow_job", url: "/api/v2/workflow_jobs/90/", related: { workflow_nodes: "/api/v2/workflow_jobs/90/workflow_nodes/" } };
  await Awx.trackWorkflowJob(runner(), wf, 90, 0);
  assert.equal(jobRow.status, "success");
  const stored = await JobEvent.findByJob(90);
  assert.deepEqual(
    stored.map((e) => [e.type, e.play, e.host]),
    [
      ["play", "one", null],
      ["task", "one", null],
      ["ok", "one", "h1"],
      ["play", "two", null],
      ["task", "two", null],
      ["ok", "two", "h2"],
    ],
  );
  const output = rows.map((r) => r.output).join("\n");
  assert.match(output, /ok: \[h1\]/);
  assert.match(output, /ok: \[h2\]/);
});

test("a job whose events AWX never finishes saving stores what there is, with one warning", { timeout: 30000 }, async () => {
  awx.polls = 2;
  awx.settle = 1000;
  awx.heldAfter = 60;
  const limits = { ...EVENT_PROCESSING_WAIT };
  Object.assign(EVENT_PROCESSING_WAIT, { waitMs: 1500, pollMs: 200 });
  const warnings = [];
  const warning = logger.warning;
  logger.warning = (message, ...rest) => {
    warnings.push(String(message));
    return warning.call(logger, message, ...rest);
  };
  const started = Date.now();
  try {
    await Awx.trackJob(runner(), job77(), 77, 0);
  } finally {
    Object.assign(EVENT_PROCESSING_WAIT, limits);
    logger.warning = warning;
  }
  assert.equal(jobRow.status, "success");
  // the events AWX had saved : all up to counter 60
  const upTo60 = AWX_EVENTS.filter((e) => e.counter <= 60).flatMap((e) => mapAwxEvent(e, { play: "", task: "" }, true)).length;
  assert.equal(storedOf(77).length, upTo60);
  assert.equal(warnings.filter((w) => /event_processing_finished|saving its events/.test(w)).length, 1);
  // the wait is bounded
  assert.ok(Date.now() - started < 10000);
});
