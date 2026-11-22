// Jobs > System > a task > Run now : POST /api/v2/system/tasks/:key/run runs a system task once,
// at once, recorded as a scheduled run is (lib/systemTaskRun.js).
//
// What has to hold :
//   - the run is the task's croner job triggered : its work, recorded as a row with its outcome
//     and result, the task answered as GET answers it once the run ended (200) ;
//   - the nightly backup is answered at once (202), its run going on ;
//   - no second run while one runs (409), and a scheduled tick during it is skipped (croner busy) ;
//   - an unknown key is 404, a task that is off 400, a user without the settings 403 ;
//   - a runner hub loop runs one pass on the node that received the request, as its timer runs
//     it : counted, written as its own row, success or failed (once) ; 409 on a node whose hub does not
//     run, and while a pass of it goes, no second one started ;
//   - on a node that does not run the tasks, the run is handed to the worker through its change
//     notice (lib/epochs.js), which the worker reacts to (init/cluster.js) ; the request waits
//     for its row, refuses while the worker says it runs (409), and answers 503 without a worker ;
//   - it is audited (system.task.run) and documented.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, "..", p), "utf8");

// ─── the database : the rows of system_task_runs, and the nodes ─────────────
const db = vi.hoisted(() => ({ runs: [], nodes: [], nextId: 1 }));
vi.mock("../src/models/db.model.js", () => {
  const run = async (sql, values) => {
    if (/INSERT INTO AnsibleForms\.`system_task_runs`/.test(sql)) {
      const [task_key, started_at, ended_at, outcome, result, node, launched_by] = values;
      db.runs.push({ id: db.nextId++, task_key, started_at, ended_at, outcome, result, node, launched_by });
      return { affectedRows: 1 };
    }
    if (/^UPDATE AnsibleForms\.`system_task_runs` SET launched_by = \? WHERE id = \? AND launched_by IS NULL$/.test(sql)) {
      const row = db.runs.find((r) => r.id === values[1] && r.launched_by == null);
      if (row) row.launched_by = values[0];
      return { affectedRows: row ? 1 : 0 };
    }
    if (/SELECT MAX\(id\) AS id FROM AnsibleForms\.`system_task_runs`/.test(sql)) {
      const ids = db.runs.filter((r) => r.task_key === values[0]).map((r) => r.id);
      return [{ id: ids.length ? Math.max(...ids) : null }];
    }
    if (/SELECT \* FROM AnsibleForms\.`system_task_runs` WHERE task_key = \?/.test(sql)) {
      return db.runs.filter((r) => r.task_key === values[0]).reverse();
    }
    if (/FROM AnsibleForms\.`nodes`/.test(sql)) return db.nodes;
    return [];
  };
  return { default: { do: run, tryDo: run } };
});
// the audit entries written
const audits = vi.hoisted(() => []);
vi.mock("../src/models/audit.model.js", () => ({
  default: { log: async (entry) => audits.push(entry), removeOlderThan: async () => 0 },
}));
// whether this process holds the worker lock
const lock = vi.hoisted(() => ({ held: true }));
vi.mock("../src/lib/workerLock.js", () => ({
  confirmWorkerLock: async () => lock.held,
  holdsWorkerLock: () => lock.held,
}));
// the change notices sent : the worker's side is played by the test (worker)
const notices = vi.hoisted(() => ({ sent: [], worker: null }));
vi.mock("../src/lib/epochs.js", () => ({
  bump: async (name) => {
    notices.sent.push(name);
    notices.worker?.(name);
  },
  onEpoch: () => {},
  startEpochs: () => {},
}));
// each task registered paused : only Run now runs it
vi.mock("croner", async (importOriginal) => {
  const real = await importOriginal();
  return {
    Cron: class extends real.Cron {
      constructor(pattern, opts, fn) {
        super(pattern, { ...(opts || {}), paused: true }, fn);
      }
    },
  };
});

const cronService = (await import("../src/services/cron.service.js")).default;
const Middleware = (await import("../src/lib/middleware.js")).default;
const systemRoutes = (await import("../src/routes/v2/system.routes.js")).default;
const TaskRun = await import("../src/lib/systemTaskRun.js");
const HubLoops = await import("../src/lib/hubLoops.js");
const { nodeId } = await import("../src/lib/role.js");
const appConfig = (await import("./__mocks__/app.config.js")).default;

// the work of the abandoned jobs sweep : how many it abandons, and a gate it may wait on
const work = { abandoned: 3, gate: null, calls: 0 };

/** Starts the scheduler's system tasks, as the worker does. */
async function startTasks() {
  const Job = {
    abandon: async () => {
      work.calls++;
      if (work.gate) await work.gate;
      return work.abandoned;
    },
    abandonDeadNodes: async () => 0,
    removeOlderThan: async () => 0,
  };
  const Token = { cleanup: async () => 0 };
  const Backup = { doBackup: async () => ({}), listBackups: async () => [], deleteBackup: async () => {} };
  await cronService.initializeSystemTasks(Job, Token, Backup, appConfig);
}

/**
 * Answers a request to the system routes, mounted as app.js mounts them, as a user with the given
 * role options.
 */
async function call(method, url, options = { showSettings: true }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { user: { username: "admin", roles: [], options } };
    next();
  });
  app.use("/api/v2/system", Middleware.checkSettingsMiddleware, systemRoutes);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}
const runNow = (key, options) => call("POST", `/api/v2/system/tasks/${key}/run`, options);

/** A gate a task's work waits on, and its opening. */
function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

beforeEach(() => {
  db.runs.length = 0;
  db.nodes.length = 0;
  audits.length = 0;
  notices.sent.length = 0;
  notices.worker = null;
  lock.held = true;
  work.abandoned = 3;
  work.gate = null;
  work.calls = 0;
  appConfig.configSeedPath = "";
  appConfig.configSeedReloadSeconds = "";
  TaskRun.resetRunsForTests();
  HubLoops.resetLoopsForTests(false);
});

afterEach(async () => {
  vi.useRealTimers();
  await cronService.stopAll(0);
});

// ------------------------------------------------------------------
// on the node that runs the tasks
// ------------------------------------------------------------------
describe("Run now on the node that runs the tasks", () => {
  test("runs the task's croner job once, recorded as a run, and answers the task once it ended", async () => {
    await startTasks();
    const res = await runNow("abandonedJobs");
    assert.equal(res.status, 200);
    assert.equal(work.calls, 1);
    assert.equal(db.runs.length, 1);
    assert.equal(db.runs[0].task_key, "abandonedJobs");
    assert.equal(db.runs[0].outcome, "success");
    assert.equal(db.runs[0].result, "Abandoned 3 jobs");
    // the task as GET answers it, its new run as its last
    assert.equal(res.body.key, "abandonedJobs");
    assert.equal(res.body.running, false);
    assert.equal(res.body.last_run.result, "Abandoned 3 jobs");
    assert.equal(res.body.runs.length, 1);
    // nothing handed to another node
    assert.deepEqual(notices.sent, []);
  });

  test("its row says who launched it, as the Jobs list names a user ; the run answers it", async () => {
    await startTasks();
    const res = await runNow("abandonedJobs");
    assert.equal(db.runs[0].launched_by, "admin (local)");
    assert.equal(res.body.runs[0].launched_by, "admin (local)");
    assert.equal(res.body.last_run.launched_by, "admin (local)");
  });

  test("a timed run says no one launched it, a Run now just before included", async () => {
    await startTasks();
    await runNow("abandonedJobs");
    // the croner job's own run (a tick) : no launcher left over
    await cronService.jobs.system.get("abandonedJobs").trigger();
    assert.deepEqual(db.runs.map((r) => r.launched_by), ["admin (local)", null]);
  });

  test("a work that throws is a failed run, recorded with its error", async () => {
    await startTasks();
    work.gate = Promise.reject(new Error("database gone"));
    work.gate.catch(() => {});
    const res = await runNow("abandonedJobs");
    assert.equal(res.status, 200);
    assert.equal(res.body.last_run.outcome, "failed");
    assert.match(res.body.last_run.result, /database gone/);
  });

  test("no second run while one runs : 409, and a scheduled tick meanwhile is skipped", async () => {
    await startTasks();
    const g = gate();
    work.gate = g.promise;
    const first = runNow("abandonedJobs");
    await vi.waitFor(() => assert.equal(work.calls, 1));
    assert.equal(cronService.systemTaskBusy("abandonedJobs"), true);
    // the page sees it running
    const seen = await call("GET", "/api/v2/system/tasks/abandonedJobs");
    assert.equal(seen.body.running, true);
    // a second Run now is refused
    const second = await runNow("abandonedJobs");
    assert.equal(second.status, 409);
    assert.match(second.body.details, /A run of this task is going/);
    // croner's own trigger would start one : runSystemTaskNow refuses a busy job
    assert.equal(cronService.runSystemTaskNow("abandonedJobs").status, "busy");
    g.open();
    assert.equal((await first).status, 200);
    assert.equal(work.calls, 1);
    assert.equal(db.runs.length, 1);
    assert.equal(cronService.systemTaskBusy("abandonedJobs"), false);
  });

  test("the nightly backup is answered at once (202), its run going on", async () => {
    await startTasks();
    const res = await runNow("nightlyBackup");
    assert.equal(res.status, 202);
    assert.equal(res.body.key, "nightlyBackup");
    assert.equal(res.body.running, true);
    await vi.waitFor(() => assert.equal(db.runs.filter((r) => r.task_key === "nightlyBackup").length, 1));
  });

  test("the run is audited : the task, where it ran and how it went", async () => {
    await startTasks();
    await runNow("abandonedJobs");
    const entry = audits.find((a) => a.action === "system.task.run");
    assert.ok(entry);
    assert.equal(entry.target, "abandonedJobs");
    assert.equal(entry.targetType, "system_task");
    assert.equal(entry.outcome, "success");
    assert.deepEqual(entry.detail, { node: "this node", run: "success", result: "Abandoned 3 jobs" });
  });
});

// ------------------------------------------------------------------
// refused
// ------------------------------------------------------------------
describe("Run now refused", () => {
  test("an unknown key is 404", async () => {
    await startTasks();
    assert.equal((await runNow("notATask")).status, 404);
  });

  test("a task that is off is 400 : the config seed reload without CONFIG_SEED_PATH", async () => {
    await startTasks();
    const res = await runNow("configSeedReload");
    assert.equal(res.status, 400);
    assert.match(res.body.details, /off/);
    assert.equal(db.runs.length, 0);
  });

  test("a user without the settings is 403, nothing run", async () => {
    await startTasks();
    const res = await runNow("abandonedJobs", { showJobs: true, allowScheduledJobs: true });
    assert.equal(res.status, 403);
    assert.equal(work.calls, 0);
  });
});

// ------------------------------------------------------------------
// a runner hub loop
// ------------------------------------------------------------------
describe("Run now of a runner hub loop", () => {
  /** The hub started here, each loop's work counting its passes ; a gate its work may wait on. */
  const passes = { runnerDispatch: 0, runnerDial: 0, runnerPrune: 0 };
  const loopWork = { gate: null, error: null };
  const startHub = () => {
    for (const key of Object.keys(passes)) passes[key] = 0;
    loopWork.gate = null;
    loopWork.error = null;
    const fn = (key) => async () => {
      passes[key]++;
      if (loopWork.gate) await loopWork.gate;
      if (loopWork.error) throw new Error(loopWork.error);
    };
    HubLoops.resetLoopsForTests(true, Object.fromEntries(Object.keys(passes).map((k) => [k, fn(k)])));
  };

  test("runs one pass of each loop here, counted as a timed one, its own row, and answers the loop", async () => {
    startHub();
    for (const key of Object.keys(passes)) {
      const res = await runNow(key);
      assert.equal(res.status, 200, key);
      assert.equal(passes[key], 1, key);
      assert.equal(res.body.key, key);
      assert.equal(res.body.running, false);
      assert.equal(res.body.loop.runs, 1);
      assert.equal(res.body.loop.node, nodeId);
      assert.equal(res.body.last_run.outcome, "success");
      assert.equal(res.body.last_run.node, nodeId);
    }
    // each pass its own row, Run now: done, who launched it ; nothing handed to another node
    assert.deepEqual(
      db.runs.map((r) => [r.task_key, r.outcome, r.result, r.node, r.launched_by]),
      Object.keys(passes).map((key) => [key, "success", "Run now: done", nodeId, "admin (local)"]),
    );
    assert.deepEqual(notices.sent, []);
  });

  test("a pass that fails : counted, its error kept and written once, as its own row", async () => {
    startHub();
    loopWork.error = "no socket";
    const res = await runNow("runnerDial");
    assert.equal(res.status, 200);
    assert.equal(res.body.last_run.outcome, "failed");
    assert.equal(res.body.last_run.result, "no socket");
    assert.equal(res.body.loop.failures, 1);
    assert.deepEqual(db.runs.map((r) => [r.task_key, r.outcome, r.result]), [["runnerDial", "failed", "no socket"]]);
  });

  test("audited as a task's run : the loop, this node and how it went", async () => {
    startHub();
    await runNow("runnerPrune");
    const entry = audits.find((a) => a.action === "system.task.run");
    assert.ok(entry);
    assert.equal(entry.target, "runnerPrune");
    assert.equal(entry.targetType, "system_task");
    assert.deepEqual(entry.detail, { node: nodeId, run: "success", result: null });
  });

  test("409 on a node whose hub does not run, no pass run", async () => {
    HubLoops.resetLoopsForTests(false);
    for (const key of Object.keys(passes)) {
      const res = await runNow(key);
      assert.equal(res.status, 409, key);
      assert.match(res.body.details, /runner hub does not run on this node/);
      assert.equal(HubLoops.loopState(key).runs, 0);
    }
    assert.equal(audits.length, 0);
  });

  test("no overlapping pass : 409 while one goes, its timer's or a Run now's", async () => {
    startHub();
    const g = gate();
    loopWork.gate = g.promise;
    // a pass going (the timer's, or a first Run now)
    const first = runNow("runnerDispatch");
    await vi.waitFor(() => assert.equal(passes.runnerDispatch, 1));
    assert.equal(HubLoops.loopBusy("runnerDispatch"), true);
    const second = await runNow("runnerDispatch");
    assert.equal(second.status, 409);
    assert.match(second.body.details, /A pass of this loop is going/);
    // a pass of one loop does not hold the others
    assert.equal(HubLoops.loopBusy("runnerDial"), false);
    g.open();
    assert.equal((await first).status, 200);
    assert.equal(passes.runnerDispatch, 1);
    assert.equal(HubLoops.loopState("runnerDispatch").runs, 1);
    assert.equal(HubLoops.loopBusy("runnerDispatch"), false);
    // then a pass runs again
    assert.equal((await runNow("runnerDispatch")).status, 200);
    assert.equal(passes.runnerDispatch, 2);
  });

  test("a user without the settings is 403, no pass run", async () => {
    startHub();
    const res = await runNow("runnerDispatch", { showJobs: true, allowScheduledJobs: true });
    assert.equal(res.status, 403);
    assert.equal(passes.runnerDispatch, 0);
  });
});

// ------------------------------------------------------------------
// from another node
// ------------------------------------------------------------------
describe("Run now from a node that does not run the tasks", () => {
  /** The worker's row in `nodes`, alive, with what its scheduler last said. */
  const worker = (tasks = []) => ({
    id: "worker-host-8443",
    role: "worker",
    is_worker: 1,
    age: 2,
    info: JSON.stringify({ scheduler: { counts: { system: 10 }, tasks } }),
  });

  test("is handed to the worker through its change notice, and waits for its run", async () => {
    lock.held = false;
    db.nodes.push(worker());
    // the worker runs it on the notice and records it
    notices.worker = (name) => {
      setTimeout(() => {
        db.runs.push({ id: db.nextId++, task_key: "jobCleanup", started_at: new Date(), ended_at: new Date(), outcome: "success", result: "Removed 2 jobs", node: "worker-host-8443" });
      }, 50);
      return name;
    };
    const res = await runNow("jobCleanup");
    assert.equal(res.status, 200);
    assert.deepEqual(notices.sent, ["systemtask-run:jobCleanup"]);
    assert.equal(res.body.last_run.result, "Removed 2 jobs");
    // the worker recorded it without a launcher (a notice carries none) : this node wrote it
    assert.equal(db.runs[0].launched_by, "admin (local)");
    assert.equal(res.body.last_run.launched_by, "admin (local)");
    assert.equal(audits.find((a) => a.action === "system.task.run").detail.node, "worker-host-8443");
  });

  test("a run not waited for (a backup) has who launched it written once its row is there", async () => {
    lock.held = false;
    db.nodes.push(worker());
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    assert.deepEqual(await TaskRun.runNow("nightlyBackup", "jane (ldap)"), { status: "started", node: "worker-host-8443" });
    // the worker's row, minutes later, without a launcher
    db.runs.push({ id: db.nextId++, task_key: "nightlyBackup", started_at: new Date(), ended_at: new Date(), outcome: "success", result: "Backed up", node: "worker-host-8443", launched_by: null });
    await vi.advanceTimersByTimeAsync(TaskRun.FOLLOW_POLL_MS);
    assert.equal(db.runs[0].launched_by, "jane (ldap)");
  });

  test("the worker's run on a notice is recorded without a launcher, the asking node writes it", async () => {
    await startTasks();
    assert.equal(TaskRun.runNoticed("abandonedJobs"), "started");
    await vi.waitFor(() => assert.equal(db.runs.length, 1));
    assert.equal(db.runs[0].launched_by, null);
  });

  test("refused while the worker says it runs (409), no notice sent", async () => {
    lock.held = false;
    db.nodes.push(worker([{ name: "jobCleanup", nextRun: null, busy: true }]));
    const res = await runNow("jobCleanup");
    assert.equal(res.status, 409);
    assert.deepEqual(notices.sent, []);
  });

  test("the nightly backup handed over is answered at once (202)", async () => {
    lock.held = false;
    db.nodes.push(worker());
    const res = await runNow("nightlyBackup");
    assert.equal(res.status, 202);
    assert.equal(res.body.running, true);
    assert.deepEqual(notices.sent, ["systemtask-run:nightlyBackup"]);
  });

  test("no worker alive : 503, nothing sent", async () => {
    lock.held = false;
    const res = await runNow("jobCleanup");
    assert.equal(res.status, 503);
    assert.deepEqual(notices.sent, []);
  });

  test("the worker runs it on the notice, once, a second notice during the run starting nothing", async () => {
    await startTasks();
    const g = gate();
    work.gate = g.promise;
    assert.equal(TaskRun.runNoticed("abandonedJobs"), "started");
    await vi.waitFor(() => assert.equal(work.calls, 1));
    assert.equal(TaskRun.runNoticed("abandonedJobs"), "busy");
    g.open();
    await vi.waitFor(() => assert.equal(db.runs.length, 1));
    assert.equal(work.calls, 1);
    // the worker subscribes to every task's notice, while it holds the lock
    const cluster = read("src/init/cluster.js");
    assert.match(cluster, /onEpoch\(runNotice\(task\.key\)/);
    assert.match(cluster, /if \(!holdsWorkerLock\(\)\) return;\s*runNoticed\(task\.key\)/);
  });

  test("its scheduler tells the other nodes which task runs (the heartbeat's busy)", async () => {
    await startTasks();
    const g = gate();
    work.gate = g.promise;
    cronService.runSystemTaskNow("abandonedJobs");
    const tasks = cronService.describe().tasks;
    assert.equal(tasks.find((t) => t.name === "abandonedJobs").busy, true);
    assert.equal(tasks.find((t) => t.name === "deadNodes").busy, false);
    g.open();
  });
});

// ------------------------------------------------------------------
// documented and translated
// ------------------------------------------------------------------
describe("documented and translated", () => {
  test("is documented, under the system tag, with every answer", () => {
    const doc = JSON.parse(read("src/swagger_v2.json"));
    const op = doc.paths["/system/tasks/{key}/run"]?.post;
    assert.ok(op, "documented");
    assert.deepEqual(op.tags, ["system"]);
    for (const status of ["200", "202", "400", "403", "404", "409", "503"]) assert.ok(op.responses[status], status);
  });

  test("its failure's title is in every language", () => {
    for (const lang of ["en", "de", "fr", "it", "es", "nl", "ca", "pt", "ja", "zh", "pl"]) {
      assert.match(read(`src/locales/${lang}.js`), /systemTaskRunFailed: /, lang);
    }
  });
});
