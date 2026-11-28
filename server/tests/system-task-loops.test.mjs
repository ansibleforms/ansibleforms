// Jobs > System : the schedule resync and the runner hub's own loops.
//
// The schedule resync, the cron registry's safety net (cron.service.js resync), was a setInterval
// of 5 minutes ; it is a system task now (scheduleResync), on croner like the others, its cron a
// setting (SCHEDULE_RESYNC_CRON), each run recorded with what it did.
//
// The runner hub's loops (runners/rteHub.js : dispatch every 2 seconds, inbound dial every 10,
// ended jobs prune every 60 by default) stay on their timers (lib/hubLoops.js), each one's seconds a
// setting (RUNNER_DISPATCH_SECONDS, RUNNER_DIAL_SECONDS, RUNNER_PRUNE_SECONDS, lib/systemTasks.js
// HUB_LOOPS), what they did kept in memory per node (lib/hubLoops.js).
//
// What has to hold :
//   - the resync runs on its cron where the cron service is active only, its result says what it
//     added, updated and removed, or what it keeps ; no setInterval is left ;
//   - its cron is a setting like the others, applied live ;
//   - a loop's runs, failures, last success and last error are kept, with the node's name ;
//   - a timed failure is a warning once per distinct error, and a row once a minute at most per
//     distinct error ; a timed success writes no row of its own ;
//   - every hour, at the top of the clock's hour, a summary row per loop of the passes of that
//     hour (its counts, its outcome, its window), the counts started again ; none for an hour
//     without a pass ; its timer apart from the loops', kept through a re-arm, cleared by
//     stopLoops, unref'd ; a database error logged once a window, never thrown ;
//   - a Run now pass writes its own row, success or failed, its failure never also a throttled
//     row ; the loops' rows are pruned as a task's ;
//   - a loop's seconds are a whole number within its bounds, refused otherwise ; changed, its
//     timer is armed again at once at the new seconds (the old one cleared), on the node that saved
//     it and on every other through the env change notice ; pinned by the environment, read only ;
//   - the API lists the loops after the tasks, every so many seconds, their seconds changed with
//     PUT { seconds } (400 out of bounds, 403 pinned, audited), their Runs their rows ;
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
// the audit entries written
const audits = [];
vi.mock("../src/models/audit.model.js", () => ({
  default: { log: async (entry) => audits.push(entry), removeOlderThan: async () => 0 },
}));
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
const { SYSTEM_TASKS, HUB_LOOPS, LOOP_SETTINGS, loopSeconds, loopSecondsProblem, hubLoop, resetPruneForTests, pruneRuns, RUNS_KEEP_PER_TASK } =
  await import("../src/lib/systemTasks.js");
const {
  loopRun,
  loopState,
  loopBusy,
  runLoopNow,
  resetLoopsForTests,
  startLoops,
  stopLoops,
  rearmLoop,
  loopTimer,
  writeSummaries,
  summaryText,
  summaryTimerForTests,
  FAILURE_ROW_EVERY_MS,
  SUMMARY_EVERY_MS,
  RUN_NOW_DONE,
} = await import("../src/lib/hubLoops.js");
const { applyChangedEnv } = await import("../src/init/cluster.js");
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

// the loops' settings and their variables, as at start : nothing set
const LOOP_ENVS = ["RUNNER_DISPATCH_SECONDS", "RUNNER_DIAL_SECONDS", "RUNNER_PRUNE_SECONDS"];
const LOOP_CONFIGS = ["runnerDispatchSeconds", "runnerDialSeconds", "runnerPruneSeconds"];

beforeEach(async () => {
  queries.length = 0;
  audits.length = 0;
  answer = () => [];
  for (const env of LOOP_ENVS) delete process.env[env];
  for (const key of LOOP_CONFIGS) appConfig[key] = "";
  appConfig.allowEnvEdit = true;
  appConfig.scheduleResyncCron = "";
  delete process.env.SCHEDULE_RESYNC_CRON;
  resetLoopsForTests(true);
  // no prune of the table in the middle of a test's rows
  resetPruneForTests();
  await fs.rm(process.env.MANAGED_ENV_PATH, { force: true });
});

afterEach(async () => {
  resetLoopsForTests(false);
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
  test("three, every 2, 10 and 60 seconds by default, each a setting with its bounds", () => {
    assert.deepEqual(HUB_LOOPS.map((l) => [l.key, l.seconds, l.schedule]), [
      ["runnerDispatch", 2, { env: "RUNNER_DISPATCH_SECONDS", config: "runnerDispatchSeconds", min: 1, max: 60 }],
      ["runnerDial", 10, { env: "RUNNER_DIAL_SECONDS", config: "runnerDialSeconds", min: 2, max: 300 }],
      ["runnerPrune", 60, { env: "RUNNER_PRUNE_SECONDS", config: "runnerPruneSeconds", min: 10, max: 3600 }],
    ]);
    assert.deepEqual(LOOP_SETTINGS.map((l) => l.env), LOOP_ENVS);
    const hub = read("src/runners/rteHub.js");
    // the timers are the loops' own (lib/hubLoops.js), no fixed pace left in the hub
    assert.doesNotMatch(hub, /DISPATCH_MS|DIAL_MS|PRUNE_MS|loopRun/);
    // Run now runs the same work as the timers
    assert.match(hub, /startLoops\(\{ runnerDispatch: dispatch, runnerDial: dialInbound, runnerPrune: pruneEnded \}\);/);
    assert.match(hub, /stopLoops\(\);/);
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
    const said = warn.mock.calls.map((c) => c[0]).filter((m) => /Dial inbound runners failed/.test(m));
    assert.deepEqual(said, ["Dial inbound runners failed: connect ECONNREFUSED", "Dial inbound runners failed: lease lost"]);
  });

  test("a failure is a row once a minute at most per distinct error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    const fail = (msg) => loopRun("runnerPrune", async () => { throw new Error(msg); });
    await fail("one");
    await fail("one");
    await fail("two");
    assert.deepEqual(inserts().map((q) => [q.params[0], q.params[3], q.params[4], q.params[5], q.params[6]]), [
      ["runnerPrune", "failed", "one", nodeId, null],
      ["runnerPrune", "failed", "two", nodeId, null],
    ]);
    vi.setSystemTime(new Date(Date.now() + FAILURE_ROW_EVERY_MS));
    await fail("one");
    assert.equal(inserts().length, 3);
  });

  test("Run now : one pass of the loop's own work, counted as a timed one, its own row", async () => {
    let passes = 0;
    resetLoopsForTests(true, { runnerDial: async () => passes++ });
    assert.deepEqual(await runLoopNow("runnerDial"), { status: "done", ok: true });
    assert.equal(passes, 1);
    assert.equal(loopState("runnerDial").runs, 1);
    assert.equal(loopState("runnerDial").last_outcome, "success");
    // its row : its start and end, success, Run now: done, this node
    const rows = inserts();
    assert.equal(rows.length, 1);
    const [key, startedAt, endedAt, outcome, result, node, launchedBy] = rows[0].params;
    assert.deepEqual([key, outcome, result, node], ["runnerDial", "success", "Run now: done", nodeId]);
    // no user given : no launcher
    assert.equal(launchedBy, null);
    assert.equal(RUN_NOW_DONE, "Run now: done");
    assert.ok(startedAt instanceof Date && endedAt instanceof Date && endedAt >= startedAt);
  });

  test("Run now : its row says who launched it, failed or not", async () => {
    resetLoopsForTests(true, { runnerDial: async () => {}, runnerPrune: async () => { throw new Error("gone"); } });
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    await runLoopNow("runnerDial", "jane (ldap)");
    await runLoopNow("runnerPrune", "admin (local)");
    assert.deepEqual(inserts().map((q) => [q.params[0], q.params[3], q.params[6]]), [
      ["runnerDial", "success", "jane (ldap)"],
      ["runnerPrune", "failed", "admin (local)"],
    ]);
  });

  test("Run now : a failed pass is warned of as a timed one's, written once, as its own row", async () => {
    const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
    resetLoopsForTests(true, { runnerPrune: async () => { throw new Error("gone"); } });
    assert.deepEqual(await runLoopNow("runnerPrune"), { status: "done", ok: false });
    assert.equal(loopState("runnerPrune").failures, 1);
    // one row, the Run now's : no throttled failure row beside it
    assert.deepEqual(inserts().map((q) => [q.params[0], q.params[3], q.params[4], q.params[5]]), [
      ["runnerPrune", "failed", "gone", nodeId],
    ]);
    assert.ok(warn.mock.calls.some((c) => /Prune stale runner jobs failed: gone/.test(c[0])));
    // each Run now its row, the same error within the minute included
    await runLoopNow("runnerPrune");
    assert.equal(inserts().length, 2);
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
// the hourly summary rows
// ------------------------------------------------------------------
describe("the loops' hourly summary", () => {
  const summaries = () => inserts().filter((q) => /passes?, \d/.test(q.params[4]));
  const row = (q) => ({ key: q.params[0], from: q.params[1].toISOString(), to: q.params[2].toISOString(), outcome: q.params[3], result: q.params[4], node: q.params[5] });

  test("its text : the passes and the failed ones, counted in en-US", () => {
    assert.equal(summaryText(1800, 0), "1,800 passes, 0 failed");
    assert.equal(summaryText(1, 1), "1 pass, 1 failed");
    assert.equal(summaryText(12345, 1200), "12,345 passes, 1,200 failed");
  });

  test("a row per loop at the top of each hour : its counts, outcome and window, then reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T10:30:00Z"));
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    resetLoopsForTests(false);
    let dials = 0;
    startLoops({
      runnerDispatch: async () => {},
      // one dial in 30 fails
      runnerDial: async () => {
        if (++dials === 30) throw new Error("refused");
      },
      runnerPrune: async () => {},
    });
    // the hub's first window : from its start to the top of the hour (the passes due at 11:00
    // exactly go after the summary : the next window's)
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    assert.deepEqual(summaries().map(row), [
      { key: "runnerDispatch", from: "2026-11-17T10:30:00.000Z", to: "2026-11-17T11:00:00.000Z", outcome: "success", result: "899 passes, 0 failed", node: nodeId },
      { key: "runnerDial", from: "2026-11-17T10:30:00.000Z", to: "2026-11-17T11:00:00.000Z", outcome: "failed", result: "179 passes, 1 failed", node: nodeId },
      { key: "runnerPrune", from: "2026-11-17T10:30:00.000Z", to: "2026-11-17T11:00:00.000Z", outcome: "success", result: "29 passes, 0 failed", node: nodeId },
    ]);
    // a summary is no one's : launched_by null
    assert.deepEqual(summaries().map((q) => q.params[6]), [null, null, null]);
    // the next one : a whole hour, its counts from nothing again
    queries.length = 0;
    await vi.advanceTimersByTimeAsync(SUMMARY_EVERY_MS);
    assert.deepEqual(summaries().map(row), [
      { key: "runnerDispatch", from: "2026-11-17T11:00:00.000Z", to: "2026-11-17T12:00:00.000Z", outcome: "success", result: "1,800 passes, 0 failed", node: nodeId },
      { key: "runnerDial", from: "2026-11-17T11:00:00.000Z", to: "2026-11-17T12:00:00.000Z", outcome: "success", result: "360 passes, 0 failed", node: nodeId },
      { key: "runnerPrune", from: "2026-11-17T11:00:00.000Z", to: "2026-11-17T12:00:00.000Z", outcome: "success", result: "60 passes, 0 failed", node: nodeId },
    ]);
    // the in-memory counts since start are not reset
    assert.equal(loopState("runnerDispatch").runs, 2700);
  });

  test("Run now passes are counted in the hour's summary", async () => {
    resetLoopsForTests(true, { runnerPrune: async () => {} });
    await runLoopNow("runnerPrune");
    await loopRun("runnerPrune", async () => { throw new Error("x"); });
    queries.length = 0;
    vi.spyOn(logger, "warning").mockImplementation(() => {});
    assert.equal(await writeSummaries(), 1);
    assert.deepEqual(summaries().map((q) => [q.params[0], q.params[3], q.params[4]]), [["runnerPrune", "failed", "2 passes, 1 failed"]]);
  });

  test("no row for a loop without a pass in the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
    resetLoopsForTests(false);
    // only the dispatch has work : the others make no pass
    startLoops({ runnerDispatch: async () => {} });
    await vi.advanceTimersByTimeAsync(SUMMARY_EVERY_MS);
    assert.deepEqual(summaries().map((q) => q.params[0]), ["runnerDispatch"]);
    // the hub stopped : nothing at all
    queries.length = 0;
    resetLoopsForTests(true);
    assert.equal(await writeSummaries(), 0);
    assert.equal(inserts().length, 0);
  });

  test("its timer : apart from the loops', kept through a re-arm, cleared by stopLoops", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T10:59:00Z"));
    vi.spyOn(logger, "notice").mockImplementation(() => {});
    resetLoopsForTests(false);
    startLoops({ runnerDispatch: async () => {} });
    const timer = summaryTimerForTests();
    assert.ok(timer);
    // a loop armed again leaves it as it is
    assert.equal(rearmLoop("runnerDispatch"), true);
    assert.equal(EnvSettings.applyLive("RUNNER_DISPATCH_SECONDS", "5", "2"), true);
    assert.equal(summaryTimerForTests(), timer);
    // every 5 seconds now : 11 passes before 11:00, the one due at 11:00 after the summary
    await vi.advanceTimersByTimeAsync(60 * 1000);
    assert.deepEqual(summaries().map((q) => [q.params[0], q.params[1].toISOString(), q.params[4]]), [
      ["runnerDispatch", "2026-11-17T10:59:00.000Z", "11 passes, 0 failed"],
    ]);
    // armed again for the next hour
    assert.ok(summaryTimerForTests());
    // stopped : no timer, no row any more
    stopLoops();
    assert.equal(summaryTimerForTests(), null);
    queries.length = 0;
    await vi.advanceTimersByTimeAsync(3 * SUMMARY_EVERY_MS);
    assert.equal(inserts().length, 0);
    EnvSettings.applyLive("RUNNER_DISPATCH_SECONDS", "", "5");
  });

  test("its timer never keeps the process alive", () => {
    resetLoopsForTests(false);
    startLoops({});
    assert.equal(summaryTimerForTests().hasRef(), false);
    stopLoops();
  });

  test("a database error : logged once a window, never thrown", async () => {
    const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
    answer = (sql) => {
      if (/^INSERT/.test(sql)) throw new Error("the database is gone");
      return [];
    };
    for (const loop of HUB_LOOPS) await loopRun(loop.key, async () => {});
    assert.equal(await writeSummaries(), 0);
    const said = () => warn.mock.calls.map((c) => c[0]).filter((m) => /hourly summary/.test(m));
    assert.deepEqual(said(), ["Could not record the hourly summary of the runner hub loops: the database is gone"]);
    // its counts reset all the same ; the next window says it again, once
    for (const loop of HUB_LOOPS) await loopRun(loop.key, async () => {});
    await writeSummaries();
    assert.equal(said().length, 2);
  });

  test("the loops' rows are pruned as a task's : its latest ones kept", async () => {
    await pruneRuns();
    const deletes = queries.filter((q) => /^DELETE/.test(q.sql) && /task_key = \?/.test(q.sql));
    for (const loop of HUB_LOOPS) {
      const q = deletes.find((d) => d.params[0] === loop.key);
      assert.ok(q, loop.key);
      assert.deepEqual(q.params, [loop.key, loop.key, RUNS_KEEP_PER_TASK]);
    }
    // a summary row prunes the table as a task's run does (once an hour at most)
    queries.length = 0;
    resetPruneForTests();
    await loopRun("runnerDial", async () => {});
    await writeSummaries();
    assert.ok(queries.some((q) => /^DELETE/.test(q.sql)));
  });
});

// ------------------------------------------------------------------
// the loops' seconds : settings, applied live
// ------------------------------------------------------------------
describe("the loops' seconds", () => {
  test("a whole number within the loop's bounds", () => {
    const dispatch = hubLoop("runnerDispatch");
    for (const ok of [1, 60, "2", " 30 "]) assert.equal(loopSecondsProblem(dispatch, ok), null, String(ok));
    for (const bad of [0, 61, -1, 2.5, "2.5", "abc", "", null, undefined]) {
      assert.equal(loopSecondsProblem(dispatch, bad), "must be a whole number of seconds from 1 to 60", String(bad));
    }
    assert.equal(loopSecondsProblem(hubLoop("runnerDial"), 1), "must be a whole number of seconds from 2 to 300");
    assert.equal(loopSecondsProblem(hubLoop("runnerPrune"), 3601), "must be a whole number of seconds from 10 to 3600");
  });

  test("validated as a setting, documented, edited on the loop's page only", async () => {
    const help = (await import("../src/models/help.model.js")).default;
    const docs = new Map(((await help.get()).find((x) => x.name == "Environment Variables").items || []).map((x) => [x.name, x]));
    for (const [env, def, min, max] of [
      ["RUNNER_DISPATCH_SECONDS", "2", 1, 60],
      ["RUNNER_DIAL_SECONDS", "10", 2, 300],
      ["RUNNER_PRUNE_SECONDS", "60", 10, 3600],
    ]) {
      const doc = docs.get(env);
      assert.ok(doc, env);
      assert.equal(doc.type, "number");
      assert.equal(doc.default, def);
      assert.equal(doc.allowed, `a whole number of seconds from ${min} to ${max}`);
      assert.equal(EnvSettings.validate(env, String(min), doc), null);
      assert.equal(EnvSettings.validate(env, String(max), doc), null);
      assert.equal(EnvSettings.validate(env, "", doc), null);
      assert.equal(EnvSettings.validate(env, String(min - 1), doc), `${env} must be a whole number of seconds from ${min} to ${max}`);
      assert.equal(EnvSettings.validate(env, String(max + 1), doc), `${env} must be a whole number of seconds from ${min} to ${max}`);
      assert.match(EnvSettings.validate(env, "abc", doc), /must be a whole number/);
      assert.ok(EnvSettings.OWNED_ELSEWHERE.test(env), env);
    }
  });

  test("its default while not set, or set out of its bounds by hand", () => {
    assert.equal(loopSeconds("runnerDispatch"), 2);
    appConfig.runnerDispatchSeconds = "7";
    assert.equal(loopSeconds("runnerDispatch"), 7);
    appConfig.runnerDispatchSeconds = "600";
    assert.equal(loopSeconds("runnerDispatch"), 2);
    assert.throws(() => loopSeconds("notALoop"), /No runner hub loop/);
  });

  test("the hub's start arms each loop at its seconds", async () => {
    vi.useFakeTimers();
    appConfig.runnerPruneSeconds = "15";
    resetLoopsForTests(false);
    const passes = { runnerDispatch: 0, runnerDial: 0, runnerPrune: 0 };
    startLoops(Object.fromEntries(Object.keys(passes).map((k) => [k, async () => passes[k]++])));
    assert.deepEqual(HUB_LOOPS.map((l) => loopTimer(l.key).seconds), [2, 10, 15]);
    await vi.advanceTimersByTimeAsync(30000);
    assert.deepEqual(passes, { runnerDispatch: 15, runnerDial: 3, runnerPrune: 2 });
    assert.ok(loopState("runnerPrune").armed_at);
  });

  test("changed : the old timer cleared, the new one at the new pace from now", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "notice").mockImplementation(() => {});
    const cleared = vi.spyOn(globalThis, "clearInterval");
    resetLoopsForTests(false);
    let passes = 0;
    startLoops({ runnerDispatch: async () => passes++ });
    await vi.advanceTimersByTimeAsync(4000);
    assert.equal(passes, 2);
    const old = loopTimer("runnerDispatch").timer;
    assert.equal(EnvSettings.applyLive("RUNNER_DISPATCH_SECONDS", "5", "2"), true);
    assert.equal(appConfig.runnerDispatchSeconds, "5");
    assert.ok(cleared.mock.calls.some((c) => c[0] === old), "the old timer cleared");
    assert.equal(loopTimer("runnerDispatch").seconds, 5);
    // none at the old pace any more : the next pass 5 seconds after the change
    await vi.advanceTimersByTimeAsync(4999);
    assert.equal(passes, 2);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(passes, 3);
    await vi.advanceTimersByTimeAsync(10000);
    assert.equal(passes, 5);
    // cleared : back to its default
    EnvSettings.applyLive("RUNNER_DISPATCH_SECONDS", "", "2");
    assert.equal(appConfig.runnerDispatchSeconds, "");
    assert.equal(loopTimer("runnerDispatch").seconds, 2);
  });

  test("changed on another node : the env change notice re-arms it here", async () => {
    vi.spyOn(logger, "notice").mockImplementation(() => {});
    resetLoopsForTests(false);
    startLoops({ runnerDial: async () => {} });
    await applyChangedEnv();
    // the other node saved the file : this one reads it and applies what changed
    await EnvSettings.writeManaged(new Map([["RUNNER_DIAL_SECONDS", "45"]]));
    await applyChangedEnv();
    assert.equal(process.env.RUNNER_DIAL_SECONDS, "45");
    assert.equal(loopSeconds("runnerDial"), 45);
    assert.equal(loopTimer("runnerDial").seconds, 45);
    await EnvSettings.writeManaged(new Map());
    await applyChangedEnv();
  });

  test("a node whose hub does not run has no timer to arm", () => {
    resetLoopsForTests(false);
    assert.equal(EnvSettings.applyLive("RUNNER_PRUNE_SECONDS", "30", "60"), true);
    assert.equal(loopTimer("runnerPrune"), null);
    assert.equal(loopSeconds("runnerPrune"), 30);
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
  test("listed after the tasks : every so many seconds, editable, no cron", async () => {
    const res = await call("GET", "/api/v2/system/tasks");
    const keys = res.body.records.map((t) => t.key);
    assert.deepEqual(keys.slice(-3), ["runnerDispatch", "runnerDial", "runnerPrune"]);
    const dispatch = res.body.records.find((t) => t.key === "runnerDispatch");
    assert.equal(dispatch.interval_seconds, 2);
    assert.equal(dispatch.default_interval_seconds, 2);
    assert.equal(dispatch.interval_min, 1);
    assert.equal(dispatch.interval_max, 60);
    assert.equal(dispatch.cron, null);
    assert.equal(dispatch.schedule_env, "RUNNER_DISPATCH_SECONDS");
    assert.equal(dispatch.editable_schedule, true);
    assert.equal(dispatch.enabled, true);
    assert.equal(dispatch.loop.node, nodeId);
    // the tasks : no seconds, no loop
    const job = res.body.records.find((t) => t.key === "jobCleanup");
    assert.equal(job.interval_seconds, null);
    assert.equal(job.interval_min, null);
    assert.equal(job.interval_max, null);
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

  test("its Runs are its rows : summaries, Run now passes and failures", async () => {
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

  test("its seconds changed : its timing and next runs follow", async () => {
    appConfig.runnerDialSeconds = "30";
    await loopRun("runnerDial", async () => {});
    const res = await call("GET", "/api/v2/system/tasks/runnerDial");
    assert.equal(res.body.interval_seconds, 30);
    assert.equal(res.body.default_interval_seconds, 10);
    const next = res.body.next_runs.map((d) => new Date(d).getTime());
    assert.deepEqual([next[1] - next[0], next[2] - next[1]], [30000, 30000]);
  });

  test("PUT { seconds } : saved, applied at once, its timer armed again, audited", async () => {
    vi.spyOn(logger, "notice").mockImplementation(() => {});
    resetLoopsForTests(false);
    startLoops({ runnerDispatch: async () => {}, runnerDial: async () => {}, runnerPrune: async () => {} });
    const old = loopTimer("runnerDispatch").timer;
    const res = await call("PUT", "/api/v2/system/tasks/runnerDispatch/schedule", { seconds: 5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.interval_seconds, 5);
    assert.equal(loopSeconds("runnerDispatch"), 5);
    assert.equal(loopTimer("runnerDispatch").seconds, 5);
    assert.notEqual(loopTimer("runnerDispatch").timer, old);
    // in the settings file, as Settings > System > General writes it
    assert.match(await fs.readFile(process.env.MANAGED_ENV_PATH, "utf8"), /^RUNNER_DISPATCH_SECONDS='?5'?$/m);
    const audit = audits.find((a) => a.action === "system.task.schedule");
    assert.deepEqual(
      { target: audit.target, detail: audit.detail },
      { target: "runnerDispatch", detail: { env: "RUNNER_DISPATCH_SECONDS", from: 2, to: 5 } },
    );
  });

  test("PUT { seconds } : 400 outside its bounds or not a whole number", async () => {
    for (const [key, seconds] of [
      ["runnerDispatch", 0],
      ["runnerDispatch", 61],
      ["runnerDial", 1],
      ["runnerDial", 301],
      ["runnerPrune", 9],
      ["runnerPrune", 3601],
      ["runnerDispatch", 2.5],
      ["runnerDispatch", "abc"],
      ["runnerDispatch", undefined],
    ]) {
      const res = await call("PUT", `/api/v2/system/tasks/${key}/schedule`, { seconds });
      assert.equal(res.status, 400, `${key} ${seconds}`);
      assert.match(res.body.details, /The interval must be a whole number of seconds from \d+ to \d+/);
    }
    // a cron is not seconds
    assert.equal((await call("PUT", "/api/v2/system/tasks/runnerDial/schedule", { cron: "* * * * *" })).status, 400);
    assert.equal(audits.length, 0);
    assert.equal(loopSeconds("runnerDial"), 10);
  });

  test("PUT { seconds } : its bounds themselves are taken", async () => {
    vi.spyOn(logger, "notice").mockImplementation(() => {});
    assert.equal((await call("PUT", "/api/v2/system/tasks/runnerPrune/schedule", { seconds: 10 })).status, 200);
    assert.equal((await call("PUT", "/api/v2/system/tasks/runnerPrune/schedule", { seconds: "3600" })).status, 200);
    assert.equal(loopSeconds("runnerPrune"), 3600);
  });

  test("pinned by the environment, or ALLOW_ENV_EDIT=0 : read only, 403", async () => {
    process.env.RUNNER_DIAL_SECONDS = "20";
    appConfig.runnerDialSeconds = "20";
    let res = await call("GET", "/api/v2/system/tasks/runnerDial");
    assert.equal(res.body.editable_schedule, false);
    assert.equal(res.body.schedule_env, "RUNNER_DIAL_SECONDS");
    assert.equal(res.body.interval_seconds, 20);
    res = await call("PUT", "/api/v2/system/tasks/runnerDial/schedule", { seconds: 30 });
    assert.equal(res.status, 403);
    assert.match(res.body.details, /RUNNER_DIAL_SECONDS is set in the environment/);
    delete process.env.RUNNER_DIAL_SECONDS;
    appConfig.allowEnvEdit = false;
    assert.equal((await call("GET", "/api/v2/system/tasks/runnerDial")).body.editable_schedule, false);
    assert.equal((await call("PUT", "/api/v2/system/tasks/runnerDial/schedule", { seconds: 30 })).status, 403);
    assert.equal(loopSeconds("runnerDial"), 20);
  });

  test("documented : interval_seconds and loop on both reads", () => {
    const doc = JSON.parse(read("src/swagger_v2.json"));
    for (const p of ["/system/tasks", "/system/tasks/{key}"]) {
      const schema = doc.paths[p].get.responses["200"].content["application/json"].schema;
      const props = schema.properties.records?.items?.properties || schema.properties;
      for (const field of ["interval_seconds", "default_interval_seconds", "interval_min", "interval_max", "loop"]) {
        assert.ok(props[field], `${p} ${field}`);
      }
      assert.ok(props.loop.properties.armed_at, `${p} loop.armed_at`);
    }
    // PUT takes { seconds } for a loop, its 400 says so, its 403 no longer refuses a loop
    const op = doc.paths["/system/tasks/{key}/schedule"].put;
    assert.equal(op.requestBody.content["application/json"].schema.properties.seconds.type, "integer");
    assert.match(op.description, /RUNNER_DISPATCH_SECONDS, 1 to 60/);
    assert.match(op.description, /RUNNER_DIAL_SECONDS, 2 to 300/);
    assert.match(op.description, /RUNNER_PRUNE_SECONDS, 10 to 3600/);
    assert.match(op.responses["400"].description, /whole number of seconds/);
    assert.doesNotMatch(op.responses["403"].description, /runner hub loop/);
  });
});
