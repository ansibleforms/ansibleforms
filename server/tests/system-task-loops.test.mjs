// Jobs > System : the schedule resync and the runner hub's own loops.
//
// The schedule resync, the cron registry's safety net (cron.service.js resync), was a setInterval
// of 5 minutes ; it is a system task now (scheduleResync), on croner like the others, its cron a
// setting (SCHEDULE_RESYNC_CRON), each run recorded with what it did.
//
// The runner hub's loops (runners/rteHub.js : dispatch every 2 seconds, inbound dial every 10,
// ended jobs prune every 60) stay on their timers and have no setting : they are listed read only
// (lib/systemTasks.js HUB_LOOPS), what they did kept in memory per node (lib/hubLoops.js).
//
// What has to hold :
//   - the resync runs on its cron where the cron service is active only, its result says what it
//     added, updated and removed, or what it keeps ; no setInterval is left ;
//   - its cron is a setting like the others, applied live ;
//   - a loop's runs, failures, last success and last error are kept, with the node's name ;
//   - a failure is a warning once per distinct error, and a row once a minute at most per
//     distinct error ; a success writes no row ;
//   - the API lists the loops after the tasks, every so many seconds, read only (403 on PUT),
//     their Runs their failures ;
//   - Run now runs one pass of a loop with the work its timer runs (runLoopNow), never two at
//     once, never where the hub does not run.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "afloops-"));
process.env.MANAGED_ENV_PATH = path.join(tmp, ".env");

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, "..", p), "utf8");

// every query ; what the database answers (a function of the sql)
const queries = [];
let answer = () => [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params) => {
      queries.push({ sql, params });
      return answer(sql, params);
    },
  },
}));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: async () => {}, removeOlderThan: async () => 0 } }));
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => true, holdsWorkerLock: () => true }));
vi.mock("../src/models/help.model.js", async () => {
  const yaml = await import("yaml");
  const { readFileSync: readFile } = await import("fs");
  const { fileURLToPath: toPath } = await import("url");
  const doc = yaml.parse(readFile(toPath(new URL("../help.yaml", import.meta.url)), "utf8"));
  return { default: { get: async () => doc } };
});
// each task registered paused, its pattern and its run known
vi.mock("croner", async (importOriginal) => {
  const real = await importOriginal();
  return {
    Cron: class extends real.Cron {
      constructor(pattern, opts, fn) {
        super(pattern, { ...(opts || {}), paused: true }, fn);
        this.run = fn;
      }
    },
  };
});

const logger = (await import("../src/lib/logger.js")).default;
const EnvSettings = (await import("../src/lib/envSettings.js")).default;
const { SYSTEM_TASKS, HUB_LOOPS, resetPruneForTests } = await import("../src/lib/systemTasks.js");
const { loopRun, loopState, loopBusy, runLoopNow, resetLoopsForTests, FAILURE_ROW_EVERY_MS } = await import(
  "../src/lib/hubLoops.js"
);
const cronModule = await import("../src/services/cron.service.js");
const cronService = cronModule.default;
const { resyncResult } = cronModule;
const Middleware = (await import("../src/lib/middleware.js")).default;
const systemRoutes = (await import("../src/routes/v2/system.routes.js")).default;
const appConfig = (await import("./__mocks__/app.config.js")).default;
const { nodeId } = await import("../src/lib/role.js");

const inserts = () => queries.filter((q) => /^INSERT INTO AnsibleForms\.`system_task_runs`/.test(q.sql));

/** Starts the scheduler, as the worker does : the registry, then the system tasks. */
async function startTasks() {
  const Job = { abandon: async () => 0, abandonDeadNodes: async () => 0, removeOlderThan: async () => 0 };
  const Token = { cleanup: async () => 0 };
  const Backup = { doBackup: async () => ({}), listBackups: async () => [], deleteBackup: async () => {} };
  await cronService.initializeAll();
  await cronService.initializeSystemTasks(Job, Token, Backup, appConfig);
}

beforeEach(async () => {
  queries.length = 0;
  answer = () => [];
  appConfig.allowEnvEdit = true;
  appConfig.scheduleResyncCron = "";
  delete process.env.SCHEDULE_RESYNC_CRON;
  resetLoopsForTests(true);
  // no prune of the table in the middle of a test's rows
  resetPruneForTests();
  await fs.rm(process.env.MANAGED_ENV_PATH, { force: true });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cronService.stopAll(0);
  cronService.active = false;
});

// ------------------------------------------------------------------
// the schedule resync
// ------------------------------------------------------------------
describe("the schedule resync", () => {
  test("a system task on croner, every 5 minutes by default, its cron a setting", async () => {
    const task = SYSTEM_TASKS.find((t) => t.key === "scheduleResync");
    assert.equal(task.cron, "*/5 * * * *");
    assert.deepEqual(task.schedule, { env: "SCHEDULE_RESYNC_CRON", config: "scheduleResyncCron", deprecated: null });
    await startTasks();
    assert.equal(cronService.jobs.system.get("scheduleResync").getPattern(), "*/5 * * * *");
  });

  test("the setInterval is gone", () => {
    const source = read("src/services/cron.service.js");
    assert.doesNotMatch(source, /RESYNC_SAFETY_MS|safetyTimer|setInterval/);
  });

  test("only where the cron service is active", async () => {
    const Job = { abandon: async () => 0, abandonDeadNodes: async () => 0, removeOlderThan: async () => 0 };
    await cronService.initializeSystemTasks(Job, { cleanup: async () => 0 }, {}, appConfig);
    assert.equal(cronService.jobs.system.has("scheduleResync"), false);
    assert.equal(await cronService.resync(), null);
  });

  test("its run is recorded, saying what it loaded", async () => {
    answer = (sql) => (/FROM AnsibleForms\.`schedule`/.test(sql) ? [{ id: 1, name: "a", one_time_run: null, cron: "0 1 * * *", rrule: "" }] : []);
    await startTasks();
    queries.length = 0;
    const run = await cronService.jobs.system.get("scheduleResync").run();
    assert.equal(run.outcome, "success");
    assert.equal(run.result, "Loaded 1 schedule and 0 repository pulls");
    assert.equal(inserts()[0].params[0], "scheduleResync");
  });

  test("a change is said : added, updated, removed", async () => {
    let rows = [{ id: 11, name: "a", one_time_run: null, cron: "0 1 * * *", rrule: "" }];
    answer = (sql) => (/FROM AnsibleForms\.`schedule`/.test(sql) ? rows : /FROM AnsibleForms\.`repositories`/.test(sql) ? [{ name: "r", cron: "0 2 * * *" }] : []);
    await startTasks();
    rows = [{ id: 12, name: "b", one_time_run: null, cron: "0 3 * * *", rrule: "" }];
    const run = await cronService.jobs.system.get("scheduleResync").run();
    assert.equal(run.result, "Added 1, removed 1");
    assert.equal(run.changed, 2);
  });

  test("its words", () => {
    assert.equal(resyncResult({ added: 1, updated: 0, removed: 2, schedules: 4, repositories: 1, failed: [] }), "Added 1, removed 2");
    assert.equal(resyncResult({ added: 0, updated: 3, removed: 0, schedules: 4, repositories: 1, failed: [] }), "Updated 3");
    assert.equal(resyncResult({ added: 0, updated: 0, removed: 0, schedules: 12, repositories: 3, failed: [] }), "Loaded 12 schedules and 3 repository pulls");
    assert.equal(
      resyncResult({ added: 0, updated: 0, removed: 0, schedules: 0, repositories: 0, failed: ["schedules: gone"] }),
      "Failed on schedules: gone, loaded 0 schedules and 0 repository pulls",
    );
  });

  test("a failed part is a failed run", async () => {
    await startTasks();
    answer = (sql) => {
      if (/FROM AnsibleForms\.`schedule`/.test(sql)) throw new Error("the database is gone");
      return [];
    };
    const run = await cronService.jobs.system.get("scheduleResync").run();
    assert.equal(run.outcome, "failed");
    assert.match(run.result, /^Failed on schedules: the database is gone/);
  });

  test("its cron applied live : registered again, the old one stopped", async () => {
    await startTasks();
    const before = cronService.jobs.system.get("scheduleResync");
    assert.equal(EnvSettings.applyLive("SCHEDULE_RESYNC_CRON", "*/10 * * * *", "*/5 * * * *"), true);
    await vi.waitFor(() => assert.equal(cronService.jobs.system.get("scheduleResync").getPattern(), "*/10 * * * *"));
    assert.equal(before.isStopped(), true);
    assert.ok(EnvSettings.OWNED_ELSEWHERE.test("SCHEDULE_RESYNC_CRON"));
  });
});

// ------------------------------------------------------------------
// the runner hub's loops
// ------------------------------------------------------------------
describe("the runner hub's loops", () => {
  test("three, read only, every 2, 10 and 60 seconds as the hub's timers", () => {
    assert.deepEqual(HUB_LOOPS.map((l) => [l.key, l.seconds]), [
      ["runnerDispatch", 2],
      ["runnerDial", 10],
      ["runnerPrune", 60],
    ]);
    const hub = read("src/runners/rteHub.js");
    assert.match(hub, /const DISPATCH_MS = 2000;/);
    assert.match(hub, /const DIAL_MS = 10000;/);
    assert.match(hub, /const PRUNE_MS = 60000;/);
    assert.match(hub, /setInterval\(\(\) => loopRun\("runnerDispatch", dispatch\), DISPATCH_MS\)/);
    assert.match(hub, /setInterval\(\(\) => loopRun\("runnerDial", dialInbound\), DIAL_MS\)/);
    assert.match(hub, /setInterval\(\(\) => loopRun\("runnerPrune", pruneEnded\), PRUNE_MS\)/);
    // Run now runs the same work as the timers
    assert.match(
      hub,
      /markLoopsStarted\(\{ runnerDispatch: dispatch, runnerDial: dialInbound, runnerPrune: pruneEnded \}\);/,
    );
    // no failure said at debug only any more
    assert.doesNotMatch(hub, /logger\.debug\(`RTE (dispatch|inbound dial|prune):/);
  });

  test("a run is kept in memory, with the node's name ; a success writes no row", async () => {
    assert.equal(await loopRun("runnerDispatch", async () => {}), true);
    assert.equal(await loopRun("runnerDispatch", async () => {}), true);
    const state = loopState("runnerDispatch");
    assert.equal(state.node, nodeId);
    assert.equal(state.running, true);
    assert.equal(state.runs, 2);
    assert.equal(state.failures, 0);
    assert.equal(state.last_outcome, "success");
    assert.ok(state.last_success_at);
    assert.equal(state.last_error, null);
    assert.equal(inserts().length, 0);
  });

  test("a failure : counted, its error kept with its time, warned of once per distinct error", async () => {
    const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) await loopRun("runnerDial", async () => { throw new Error("connect ECONNREFUSED"); });
    await loopRun("runnerDial", async () => { throw new Error("lease lost"); });
    const state = loopState("runnerDial");
    assert.equal(state.runs, 6);
    assert.equal(state.failures, 6);
    assert.equal(state.last_outcome, "failed");
    assert.equal(state.last_error.message, "lease lost");
    assert.ok(state.last_error.at);
    const said = warn.mock.calls.map((c) => c[0]).filter((m) => /Runner inbound dial failed/.test(m));
    assert.deepEqual(said, ["Runner inbound dial failed: connect ECONNREFUSED", "Runner inbound dial failed: lease lost"]);
  });

  test("a failure is a row once a minute at most per distinct error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    const fail = (msg) => loopRun("runnerPrune", async () => { throw new Error(msg); });
    await fail("one");
    await fail("one");
    await fail("two");
    assert.deepEqual(inserts().map((q) => [q.params[0], q.params[3], q.params[4], q.params[5]]), [
      ["runnerPrune", "failed", "one", nodeId],
      ["runnerPrune", "failed", "two", nodeId],
    ]);
    vi.setSystemTime(new Date(Date.now() + FAILURE_ROW_EVERY_MS));
    await fail("one");
    assert.equal(inserts().length, 3);
  });

  test("Run now : one pass of the loop's own work, counted as a timed one", async () => {
    let passes = 0;
    resetLoopsForTests(true, { runnerDial: async () => passes++ });
    assert.deepEqual(await runLoopNow("runnerDial"), { status: "done", ok: true });
    assert.equal(passes, 1);
    assert.equal(loopState("runnerDial").runs, 1);
    assert.equal(loopState("runnerDial").last_outcome, "success");
  });

  test("Run now : a failed pass is said as a timed one's, a row and a warning", async () => {
    const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
    resetLoopsForTests(true, { runnerPrune: async () => { throw new Error("gone"); } });
    assert.deepEqual(await runLoopNow("runnerPrune"), { status: "done", ok: false });
    assert.equal(loopState("runnerPrune").failures, 1);
    assert.equal(inserts().length, 1);
    assert.ok(warn.mock.calls.some((c) => /Runner ended jobs prune failed: gone/.test(c[0])));
  });

  test("Run now : never two passes of a loop at once, a timed one going included", async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    let passes = 0;
    const work = async () => {
      passes++;
      await gate;
    };
    resetLoopsForTests(true, { runnerDispatch: work });
    // the timer's pass, going
    const timed = loopRun("runnerDispatch", work);
    assert.equal(loopBusy("runnerDispatch"), true);
    assert.deepEqual(await runLoopNow("runnerDispatch"), { status: "busy" });
    // once it ended, Run now runs one
    open();
    await timed;
    assert.equal(loopBusy("runnerDispatch"), false);
    assert.deepEqual(await runLoopNow("runnerDispatch"), { status: "done", ok: true });
    assert.equal(passes, 2);
    assert.equal(loopState("runnerDispatch").runs, 2);
  });

  test("Run now : refused where the hub does not run, and for a key no loop has", async () => {
    resetLoopsForTests(false);
    assert.deepEqual(await runLoopNow("runnerDispatch"), { status: "noHub" });
    assert.equal(loopState("runnerDispatch").runs, 0);
    assert.deepEqual(await runLoopNow("notALoop"), { status: "unknown" });
  });

  test("an unknown loop is refused at the hub's start", () => {
    assert.throws(() => loopRun("notALoop", async () => {}), /No runner hub loop/);
  });
});

// ------------------------------------------------------------------
// the API
// ------------------------------------------------------------------
/** Answers a request to the system routes, as an admin. */
async function call(method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { user: { username: "admin", roles: [], options: { showSettings: true } } };
    next();
  });
  app.use("/api/v2/system", Middleware.checkSettingsMiddleware, systemRoutes);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe("the loops as the API answers them", () => {
  test("listed after the tasks : every so many seconds, read only, no cron", async () => {
    const res = await call("GET", "/api/v2/system/tasks");
    const keys = res.body.records.map((t) => t.key);
    assert.deepEqual(keys.slice(-3), ["runnerDispatch", "runnerDial", "runnerPrune"]);
    const dispatch = res.body.records.find((t) => t.key === "runnerDispatch");
    assert.equal(dispatch.interval_seconds, 2);
    assert.equal(dispatch.cron, null);
    assert.equal(dispatch.schedule_env, null);
    assert.equal(dispatch.editable_schedule, false);
    assert.equal(dispatch.enabled, true);
    assert.equal(dispatch.loop.node, nodeId);
    // the tasks : no seconds, no loop
    const job = res.body.records.find((t) => t.key === "jobCleanup");
    assert.equal(job.interval_seconds, null);
    assert.equal(job.loop, null);
  });

  test("its last run and outcome from this node's memory, the node named", async () => {
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    await loopRun("runnerDispatch", async () => { throw new Error("no socket"); });
    const res = await call("GET", "/api/v2/system/tasks/runnerDispatch");
    assert.equal(res.status, 200);
    assert.equal(res.body.last_run.outcome, "failed");
    assert.equal(res.body.last_run.result, "no socket");
    assert.equal(res.body.last_run.node, nodeId);
    assert.equal(res.body.loop.failures, 1);
    assert.ok(Array.isArray(res.body.runs));
  });

  test("its next runs : its seconds after its last run, three of them", async () => {
    await loopRun("runnerDial", async () => {});
    const res = await call("GET", "/api/v2/system/tasks/runnerDial");
    const last = new Date(res.body.last_run.started_at).getTime();
    const next = res.body.next_runs.map((d) => new Date(d).getTime());
    assert.equal(next.length, 3);
    assert.equal(res.body.next_run, res.body.next_runs[0]);
    assert.ok(next[0] >= last + 10000 - 5 && next[0] <= Date.now() + 11000);
    assert.deepEqual([next[1] - next[0], next[2] - next[1]], [10000, 10000]);
  });

  test("not run yet : its first run its seconds after the hub started", async () => {
    const res = await call("GET", "/api/v2/system/tasks/runnerPrune");
    assert.equal(res.body.last_run, null);
    assert.equal(new Date(res.body.next_run).getTime(), new Date(res.body.loop.since).getTime() + 60000);
    assert.equal(res.body.next_runs.length, 3);
  });

  test("no next run where no hub runs", async () => {
    resetLoopsForTests(false);
    const res = await call("GET", "/api/v2/system/tasks/runnerDial");
    assert.equal(res.body.next_run, null);
    assert.deepEqual(res.body.next_runs, []);
  });

  test("its Runs are its failures, the rows of its key", async () => {
    answer = (sql, params) =>
      /^SELECT \* FROM AnsibleForms\.`system_task_runs` WHERE task_key = \?/.test(sql) && params[0] === "runnerDial"
        ? [{ id: 9, task_key: "runnerDial", started_at: new Date(), ended_at: new Date(), outcome: "failed", result: "refused", node: "af-x" }]
        : [];
    const res = await call("GET", "/api/v2/system/tasks/runnerDial");
    assert.deepEqual(res.body.runs.map((r) => [r.outcome, r.result]), [["failed", "refused"]]);
  });

  test("a node that runs no hub : not running, its latest failed row as its last run", async () => {
    resetLoopsForTests(false);
    answer = (sql) =>
      /^SELECT \* FROM AnsibleForms\.`system_task_runs` WHERE task_key = \?/.test(sql)
        ? [{ id: 9, task_key: "runnerPrune", started_at: new Date(), ended_at: new Date(), outcome: "failed", result: "x", node: "af-y" }]
        : [];
    const res = await call("GET", "/api/v2/system/tasks/runnerPrune");
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.last_run.node, "af-y");
  });

  test("a loop's schedule cannot be changed : 403", async () => {
    const res = await call("PUT", "/api/v2/system/tasks/runnerDispatch/schedule", { cron: "* * * * *" });
    assert.equal(res.status, 403);
    assert.match(res.body.details, /runner hub's loops run as often as the runners need them/);
  });

  test("documented : interval_seconds and loop on both reads", () => {
    const doc = JSON.parse(read("src/swagger_v2.json"));
    for (const p of ["/system/tasks", "/system/tasks/{key}"]) {
      const schema = doc.paths[p].get.responses["200"].content["application/json"].schema;
      const props = schema.properties.records?.items?.properties || schema.properties;
      for (const field of ["interval_seconds", "loop"]) assert.ok(props[field], `${p} ${field}`);
    }
  });
});
