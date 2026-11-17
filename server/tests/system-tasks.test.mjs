// Jobs > System : the app's own maintenance tasks (services/cron.service.js initializeSystemTasks)
// were in no table and on no page - a nightly job cleanup that failed for weeks left one line in a
// log file. Each run is now recorded (lib/systemTasks.js, the system_task_runs table) and read
// back by an admin (GET /api/v2/system/tasks, models/systemTask.model.js).
//
// What has to hold :
//   - every run writes one row, with its outcome, a short result and the node that ran it ; a
//     task that throws is a failed run, and the scheduler never sees the error ;
//   - every run is a row, a task of every minute's too, also one that changed nothing ;
//   - the table keeps itself small : a month, and 1000 rows a task at most ;
//   - the scheduler registers each task on the cron the API reports ;
//   - the API is the admin settings' (checkSettingsMiddleware) and documented.
import { test, describe, beforeEach, vi } from "vitest";
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

// every query, and what the next ones answer (a function of the sql, or nothing)
const queries = [];
let answer = () => [];
let failWrites = false;
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params) => {
      queries.push({ sql, params });
      if (failWrites && /^(INSERT|DELETE)/.test(sql)) throw new Error("the database is gone");
      return answer(sql, params);
    },
  },
}));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: async () => {}, removeOlderThan: async () => 0 } }));
// the tasks run only in the worker holding the lock : this one does
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => true }));
// the settings file : JOB_RETENTION_DAYS set in the process's own environment (not editable)
vi.mock("../src/lib/envSettings.js", () => ({
  readManaged: async () => new Map(),
  isOverridden: (name) => name === "JOB_RETENTION_DAYS",
}));
// capture each task's callback instead of scheduling it ; the real croner for the next runs
const tasks = new Map();
vi.mock("croner", async (importOriginal) => {
  const real = await importOriginal();
  return {
    Cron: class extends real.Cron {
      constructor(pattern, opts, fn) {
        super(pattern, { ...(opts || {}), paused: true });
        if (typeof fn === "function") tasks.set(`${pattern}|${tasks.size}`, { pattern, fn });
      }
    },
  };
});

const systemTasks = await import("../src/lib/systemTasks.js");
const { SYSTEM_TASKS, HUB_LOOPS, recorded, recordRun, pruneRuns, resetPruneForTests, RUNS_KEEP_DAYS, RUNS_KEEP_PER_TASK } = systemTasks;
const cronService = (await import("../src/services/cron.service.js")).default;
const SystemTask = (await import("../src/models/systemTask.model.js")).default;
const Middleware = (await import("../src/lib/middleware.js")).default;
const systemRoutes = (await import("../src/routes/v2/system.routes.js")).default;
const appConfig = (await import("./__mocks__/app.config.js")).default;

const inserts = () => queries.filter((q) => /^INSERT INTO AnsibleForms\.`system_task_runs`/.test(q.sql));
const deletes = () => queries.filter((q) => /^DELETE FROM AnsibleForms\.`system_task_runs`/.test(q.sql));

beforeEach(() => {
  queries.length = 0;
  answer = () => [];
  failWrites = false;
});

// ------------------------------------------------------------------
// the record of a run
// ------------------------------------------------------------------
describe("a run is recorded", () => {
  test("one row : the task, when, success, what it did and the node", async () => {
    const run = recorded("jobCleanup", async () => ({ changed: 3, result: "Removed 3 finished jobs" }));
    const out = await run();
    assert.deepEqual(out, { outcome: "success", result: "Removed 3 finished jobs", changed: 3 });
    const [row] = inserts();
    assert.ok(row, "a row is written");
    assert.doesNotMatch(row.sql, /ON DUPLICATE KEY/);
    const [key, started, ended, outcome, result, node] = row.params;
    assert.equal(key, "jobCleanup");
    assert.ok(started instanceof Date && ended instanceof Date && ended >= started);
    assert.equal(outcome, "success");
    assert.equal(result, "Removed 3 finished jobs");
    assert.ok(node, "the node that ran it");
  });

  test("a work that throws is a failed run with its error, and the error goes no further", async () => {
    const run = recorded("tokenCleanup", async () => {
      throw new Error("Deadlock found");
    });
    const out = await run();
    assert.equal(out.outcome, "failed");
    const [row] = inserts();
    assert.equal(row.params[3], "failed");
    assert.equal(row.params[4], "Deadlock found");
  });

  test("a part that failed (failed: true) is a failed run", async () => {
    await recorded("storedJobsCleanup", async () => ({ failed: true, result: "Failed on nodes" }))();
    assert.equal(inserts()[0].params[3], "failed");
  });

  test("a long result is cut to the column's size", async () => {
    await recorded("jobCleanup", async () => ({ result: "x".repeat(5000) }))();
    assert.equal(inserts()[0].params[4].length, 1000);
  });

  test("a row that cannot be written is logged : the task has run, nothing throws", async () => {
    failWrites = true;
    const out = await recorded("jobCleanup", async () => ({ result: "ok" }))();
    assert.equal(out.outcome, "success");
  });

  test("a key no task has is refused when the scheduler starts", () => {
    assert.throws(() => recorded("notATask", async () => ({})));
    assert.throws(() => systemTasks.taskCron("notATask"), /No system task/);
  });
});

describe("every run is a row of its own", () => {
  test.each([
    ["deadNodes", { changed: 0, result: "Nothing to free" }],
    ["deadNodes", { changed: 2, result: "Abandoned 2 jobs" }],
    ["scheduleEnds", { failed: true, result: "Failed" }],
    ["tokenCleanup", { changed: 0, result: "No expired token" }],
  ])("%s : %o", async (key, out) => {
    await recorded(key, async () => out)();
    const [row] = inserts();
    assert.match(row.sql, /\(task_key, started_at, ended_at, outcome, result, node\) VALUES \(\?, \?, \?, \?, \?, \?\)$/);
    assert.equal(row.params[0], key);
  });
});

describe("the table keeps itself small", () => {
  test("its rows older than a month go, then each task's beyond its latest 1000", async () => {
    answer = (sql) => (/^DELETE/.test(sql) ? { affectedRows: 2 } : []);
    const removed = await pruneRuns();
    const [old, ...perTask] = deletes();
    assert.match(old.sql, /WHERE started_at < UTC_TIMESTAMP\(\) - INTERVAL \? DAY/);
    assert.deepEqual(old.params, [RUNS_KEEP_DAYS]);
    assert.equal(RUNS_KEEP_DAYS, 30);
    // the runner hub's loops' rows (their failures) too
    assert.equal(perTask.length, SYSTEM_TASKS.length + HUB_LOOPS.length);
    for (const q of perTask) {
      assert.match(q.sql, /id NOT IN \(SELECT id FROM \(SELECT id FROM AnsibleForms\.`system_task_runs` WHERE task_key = \? ORDER BY started_at DESC, id DESC LIMIT \?\) kept\)/);
      assert.equal(q.params[2], RUNS_KEEP_PER_TASK);
    }
    assert.equal(removed, 2 * (1 + SYSTEM_TASKS.length + HUB_LOOPS.length));
  });

  test("pruned after a recorded run, once an hour at most", async () => {
    resetPruneForTests();
    const task = SYSTEM_TASKS.find((t) => t.key === "jobCleanup");
    const run = { startedAt: new Date(), endedAt: new Date(), outcome: "success", result: "", changed: 1 };
    await recordRun(task, run);
    assert.ok(deletes().length > 0, "the first run prunes");
    queries.length = 0;
    await recordRun(task, run);
    assert.equal(deletes().length, 0, "the next one within the hour does not");
  });

  test("a prune that fails is logged, never thrown", async () => {
    failWrites = true;
    assert.equal(await pruneRuns(), 0);
  });
});

// ------------------------------------------------------------------
// the scheduler
// ------------------------------------------------------------------
describe("the scheduler records every task", () => {
  const Job = {
    abandon: async () => 0,
    abandonDeadNodes: async () => 0,
    removeOlderThan: async () => 120,
  };
  const Token = { cleanup: async () => 4 };
  const Backup = { doBackup: async () => ({ backupFolder: "/b/1", timestamp: "20261117000000" }), listBackups: async () => [], deleteBackup: async () => {} };

  beforeEach(async () => {
    tasks.clear();
    await cronService.initializeSystemTasks(Job, Token, Backup, { jobRetentionDays: 90, auditRetentionDays: 0, nightlyBackupRetention: 0, storedJobUnusedDays: 0 });
  });

  const run = async (pattern, index = 0) => {
    const found = [...tasks.values()].filter((t) => t.pattern === pattern)[index];
    assert.ok(found, `a task at ${pattern}`);
    queries.length = 0;
    await found.fn();
  };

  test("each task on the cron the API reports, the seed reload only with a seed", () => {
    // no CONFIG_SEED_PATH here : the config seed reload is off, not registered ; the cron
    // service not active (initializeAll) : no registry, no schedule resync
    const running = SYSTEM_TASKS.filter((t) => !["configSeedReload", "scheduleResync"].includes(t.key));
    const patterns = [...tasks.values()].map((t) => t.pattern).sort();
    assert.deepEqual(patterns, running.map((t) => t.cron).sort());
    assert.deepEqual([...cronService.jobs.system.keys()].sort(), running.map((t) => t.key).sort());
  });

  test("the job cleanup says how many jobs it removed", async () => {
    await run("30 2 * * *");
    const [row] = inserts();
    assert.equal(row.params[0], "jobCleanup");
    assert.equal(row.params[4], "Removed 120 finished jobs older than 90 days");
  });

  test("a retention of 0 is said, not hidden", async () => {
    await run("30 3 * * *");
    assert.match(inserts()[0].params[4], /Retention is off \(AUDIT_RETENTION_DAYS=0\)/);
  });

  test("the stopped-node sweep that found nothing writes its row", async () => {
    answer = (sql) => (/^\s*SELECT/i.test(sql) ? [] : { affectedRows: 0, changedRows: 0 });
    await run("* * * * *", 0);
    const [row] = inserts();
    assert.equal(row.params[0], "deadNodes");
    assert.equal(row.params[4], "Nothing to free");
    assert.doesNotMatch(row.sql, /ON DUPLICATE KEY/);
  });

  test("the token cleanup counts what it removed", async () => {
    answer = (sql) => (/^DELETE/.test(sql) ? { affectedRows: 1 } : []);
    await run("0 3 * * *");
    assert.equal(inserts()[0].params[4], "Removed 4 tokens, 1 revocation and 1 API token");
  });

  test("a nightly backup that fails is a failed run", async () => {
    Backup.doBackup = async () => {
      throw new Error("mysqldump: not found");
    };
    await run("0 0 * * *");
    const [row] = inserts();
    assert.equal(row.params[3], "failed");
    assert.match(row.params[4], /mysqldump: not found/);
  });
});

// ------------------------------------------------------------------
// the API
// ------------------------------------------------------------------
describe("the tasks as the API answers them", () => {
  const last = (key, outcome = "success") => ({
    id: 7, task_key: key, started_at: new Date("2026-11-17T02:30:00Z"), ended_at: new Date("2026-11-17T02:30:01.250Z"),
    outcome, result: "Removed 120 finished jobs older than 90 days", node: "af-host-8000",
  });

  test("every task, in the scheduler's order, with its last run, next run and setting", async () => {
    Object.assign(appConfig, { jobRetentionDays: 90, auditRetentionDays: 365, configSeedPath: "", configSeedReloadSeconds: "" });
    answer = (sql) => (/^SELECT/.test(sql) ? [last("jobCleanup")] : []);
    const list = await SystemTask.list();
    // the tasks, then the runner hub's loops
    assert.deepEqual(list.map((t) => t.key), [...SYSTEM_TASKS, ...HUB_LOOPS].map((t) => t.key));
    const job = list.find((t) => t.key === "jobCleanup");
    assert.equal(job.cron, "30 2 * * *");
    assert.deepEqual(job.last_run, {
      id: 7, started_at: "2026-11-17T02:30:00.000Z", ended_at: "2026-11-17T02:30:01.250Z", duration_ms: 1250,
      outcome: "success", result: "Removed 120 finished jobs older than 90 days", node: "af-host-8000",
    });
    assert.ok(new Date(job.next_run) > new Date(), "its next run is ahead");
    // set in the process's environment : not changed in the app
    assert.deepEqual(job.setting, { env: "JOB_RETENTION_DAYS", value: 90, editable: false, link: null, where: null });
    const audit = list.find((t) => t.key === "auditCleanup");
    assert.equal(audit.last_run, null);
    assert.deepEqual(audit.setting, {
      env: "AUDIT_RETENTION_DAYS", value: 365, editable: true, link: "/settings/general/retention",
      where: "Settings > System > General > Retention",
    });
    assert.equal(list.find((t) => t.key === "tokenCleanup").setting, null);
    // no config seed : the reload does not run
    const seed = list.find((t) => t.key === "configSeedReload");
    assert.equal(seed.enabled, false);
    assert.equal(seed.next_run, null);
    assert.equal(seed.cron, "* * * * *");
    assert.equal(seed.schedule_deprecated, null);
    assert.equal(seed.interval_seconds, null);
  });

  test("ALLOW_ENV_EDIT=0 : every setting is the environment's", async () => {
    appConfig.allowEnvEdit = false;
    try {
      const list = await SystemTask.list();
      assert.ok(list.filter((t) => t.setting).every((t) => !t.setting.editable && !t.setting.link));
    } finally {
      appConfig.allowEnvEdit = true;
    }
  });

  test("one task with its recent runs, the latest first ; none for an unknown key", async () => {
    answer = (sql) => (/^SELECT/.test(sql) ? [last("jobCleanup"), { ...last("jobCleanup", "failed"), id: 6 }] : []);
    const one = await SystemTask.get("jobCleanup");
    assert.equal(one.runs.length, 2);
    assert.equal(one.runs[1].outcome, "failed");
    assert.match(queries.at(-1).sql, /WHERE task_key = \? ORDER BY started_at DESC, id DESC LIMIT \?/);
    assert.equal(await SystemTask.get("notATask"), null);
  });
});

describe("the API is the admin settings'", () => {
  /**
   * Answers a request to the system routes, mounted as app.js mounts them, as a user with the
   * given role options.
   */
  async function call(url, options) {
    const app = express();
    app.use((req, res, next) => {
      req.user = { user: { roles: [], options } };
      next();
    });
    app.use("/api/v2/system", Middleware.checkSettingsMiddleware, systemRoutes);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  test("app.js mounts it behind the settings guard", () => {
    const mount = read("src/app.js").split("\n").find((l) => l.includes("`/api/v2/system`"));
    assert.ok(mount);
    assert.match(mount, /authobj, Middleware\.checkSettingsMiddleware, systemRoutesv2/);
  });

  test("a user without the settings is refused with 403", async () => {
    const res = await call("/api/v2/system/tasks", { showJobs: true, allowScheduledJobs: true });
    assert.equal(res.status, 403);
  });

  test("an admin reads the list, and one task ; an unknown key is 404", async () => {
    const list = await call("/api/v2/system/tasks", { showSettings: true });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, SYSTEM_TASKS.length + HUB_LOOPS.length);
    const one = await call("/api/v2/system/tasks/jobCleanup", { showSettings: true });
    assert.equal(one.status, 200);
    assert.equal(one.body.key, "jobCleanup");
    assert.ok(Array.isArray(one.body.runs));
    const none = await call("/api/v2/system/tasks/notATask", { showSettings: true });
    assert.equal(none.status, 404);
  });

  test("the routes are reads, and the nightly tasks' schedule only (tests/system-task-schedule.test.mjs)", () => {
    const routes = read("src/routes/v2/system.routes.js");
    const writes = [...routes.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(writes, ["put /tasks/:key/schedule"]);
  });

  test("both are documented, under the system tag", () => {
    const doc = JSON.parse(read("src/swagger_v2.json"));
    for (const p of ["/system/tasks", "/system/tasks/{key}"]) {
      assert.ok(doc.paths[p]?.get, p);
      assert.deepEqual(doc.paths[p].get.tags, ["system"]);
      assert.ok(doc.paths[p].get.responses["403"], `${p} says who may call it`);
    }
  });
});

// ------------------------------------------------------------------
// the table, everywhere a table lives
// ------------------------------------------------------------------
describe("the table", () => {
  test("the fresh install creates it, a patch adds it, the manifest expects it", () => {
    const sql = read("src/db/create_schema_and_tables.sql");
    assert.match(sql, /DROP TABLE IF EXISTS `system_task_runs`;\nCREATE TABLE `system_task_runs`/);
    const model = read("src/models/schema.model.js");
    assert.match(model, /addTable\("system_task_runs", taskRuns\.toString\(\)\)/);
    assert.equal((model.match(/'system_task_runs'/g) || []).length, 2, "the base tables and patchVersion7's");
    const own = read("src/db/create_system_task_runs_table.sql");
    assert.doesNotMatch(own, /quiet_of/);
  });
});
