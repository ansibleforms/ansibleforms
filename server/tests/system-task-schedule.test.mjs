// Jobs > System : when every system task runs is an admin's to change. Each one takes its cron
// from a setting (JOB_CLEANUP_CRON and the like, lib/systemTasks.js), saved as Settings > System >
// General saves its variables (lib/envSave.js) through PUT /api/v2/system/tasks/:key/schedule. The
// config seed reload's (CONFIG_SEED_RELOAD_CRON) replaces its seconds of before 7.8
// (CONFIG_SEED_RELOAD_SECONDS), deprecated, still read as a cron while the new one is not set.
//
// What has to hold :
//   - a cron setting is 5 fields croner accepts and that runs again, refused otherwise ;
//   - saved, it applies at once : the scheduler registers the task again on its new cron, here
//     and on every other node (the 'env' epoch, init/cluster.js applyChangedEnv), without a
//     restart, and cleared it goes back to the task's default ;
//   - no task keeps a timing of its own ;
//   - the endpoint is the settings', refuses a bad cron (400), a task whose variable the
//     environment sets (403) and an unknown key (404), and is audited ;
//   - the seed reload runs on its croner job only with a seed, its deprecated seconds read as a
//     cron while CONFIG_SEED_RELOAD_CRON is not set, which a save on its page writes and wins ;
//   - the API says which task may be changed (editable_schedule) and its variable, a runner hub
//     loop's seconds too (tests/system-task-loops.test.mjs) ;
//   - it is documented.
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
// an empty settings file of the test's own : nothing pinned by it
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "afcron-"));
process.env.MANAGED_ENV_PATH = path.join(tmp, ".env");

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, "..", p), "utf8");

// the database answers nothing : no run recorded yet
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
// the audit entries written
const audits = [];
vi.mock("../src/models/audit.model.js", () => ({
  default: { log: async (entry) => audits.push(entry), removeOlderThan: async () => 0 },
}));
// the tasks run only in the worker holding the lock : this one does
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => true, holdsWorkerLock: () => true }));
// the documented variables (help.yaml) : the real ones, read from the file
vi.mock("../src/models/help.model.js", async () => {
  const yaml = await import("yaml");
  const { readFileSync: readFile } = await import("fs");
  const { fileURLToPath: toPath } = await import("url");
  const doc = yaml.parse(readFile(toPath(new URL("../help.yaml", import.meta.url)), "utf8"));
  return { default: { get: async () => doc } };
});
// the settings' save : the values applied as lib/envSave.js applies them (applyLive, the real
// one), the file written ; what the endpoint asked is kept
const saved = [];
vi.mock("../src/lib/envSave.js", async () => {
  const EnvSettings = (await import("../src/lib/envSettings.js")).default;
  class EnvSaveError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  return {
    EnvSaveError,
    saveEnvValues: async (updates) => {
      saved.push(updates);
      const managed = await EnvSettings.readManaged();
      for (const [name, value] of Object.entries(updates)) managed.set(name, value);
      await EnvSettings.writeManaged(managed);
      for (const [name, value] of Object.entries(updates)) EnvSettings.applyLive(name, value);
      return { changed: Object.keys(updates), restartRequired: [] };
    },
  };
});
// each task registered paused, its pattern known ; the real croner otherwise
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

const EnvSettings = (await import("../src/lib/envSettings.js")).default;
const { SYSTEM_TASKS, SCHEDULE_SETTINGS, taskCron, scheduleCronProblem } = await import("../src/lib/systemTasks.js");
const cronService = (await import("../src/services/cron.service.js")).default;
const SystemTask = (await import("../src/models/systemTask.model.js")).default;
const Middleware = (await import("../src/lib/middleware.js")).default;
const systemRoutes = (await import("../src/routes/v2/system.routes.js")).default;
const appConfig = (await import("./__mocks__/app.config.js")).default;

// every task and its variable, with its default
const TASKS = {
  abandonedJobs: ["ABANDONED_JOBS_CRON", "0 * * * *"],
  deadNodes: ["DEAD_NODES_CRON", "* * * * *"],
  scheduleEnds: ["SCHEDULE_ENDS_CRON", "* * * * *"],
  scheduleResync: ["SCHEDULE_RESYNC_CRON", "*/5 * * * *"],
  tokenCleanup: ["TOKEN_CLEANUP_CRON", "0 3 * * *"],
  auditCleanup: ["AUDIT_CLEANUP_CRON", "30 3 * * *"],
  jobCleanup: ["JOB_CLEANUP_CRON", "30 2 * * *"],
  nightlyBackup: ["NIGHTLY_BACKUP_CRON", "0 0 * * *"],
  storedJobsCleanup: ["STORED_JOB_CLEANUP_CRON", "0 4 * * *"],
  configSeedReload: ["CONFIG_SEED_RELOAD_CRON", "* * * * *"],
};

/** Starts the scheduler's system tasks, as the worker does. */
async function startTasks() {
  const Job = { abandon: async () => 0, abandonDeadNodes: async () => 0, removeOlderThan: async () => 0 };
  const Token = { cleanup: async () => 0 };
  const Backup = { doBackup: async () => ({}), listBackups: async () => [], deleteBackup: async () => {} };
  await cronService.initializeSystemTasks(Job, Token, Backup, appConfig);
}

/** The pattern a task is registered on. */
const registered = (key) => cronService.jobs.system.get(key)?.getPattern();

beforeEach(async () => {
  audits.length = 0;
  saved.length = 0;
  appConfig.allowEnvEdit = true;
  // every setting back to unset : the defaults
  for (const s of SCHEDULE_SETTINGS) {
    appConfig[s.config] = "";
    delete process.env[s.env];
  }
  // no seed, no deprecated seconds
  appConfig.configSeedPath = "";
  appConfig.configSeedReloadSeconds = "";
  delete process.env.CONFIG_SEED_RELOAD_SECONDS;
  await fs.rm(process.env.MANAGED_ENV_PATH, { force: true });
});

afterEach(async () => {
  await cronService.stopAll(0);
});

// ------------------------------------------------------------------
// the settings
// ------------------------------------------------------------------
describe("the cron settings", () => {
  test("every task has one, its default the cron it always had (the seed reload : every minute)", () => {
    const declared = Object.fromEntries(SCHEDULE_SETTINGS.map((s) => [s.key, [s.env, s.default]]));
    assert.deepEqual(declared, TASKS);
    assert.ok(SYSTEM_TASKS.every((t) => t.schedule), "no task keeps a timing of its own");
    // the runner hub's loops are no task : read only, on their own timers (HUB_LOOPS)
  });

  // a text matched as it is inside a regex : every character a regex reads specially escaped
  const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  test("documented in help.yaml with their default, applied live, shown on the task's page only", () => {
    const help = read("help.yaml");
    for (const [env, cron] of Object.values(TASKS)) {
      assert.match(help, new RegExp(`- name: ${env}\\n    version: 7\\.8\\.0\\n    type: string\\n[\\s\\S]*?default: "${escapeRegex(cron)}"`), env);
      assert.equal(EnvSettings.classify(env), "live", env);
      // not on Settings > System > General, nor in a General repository's file
      assert.ok(EnvSettings.OWNED_ELSEWHERE.test(env), env);
    }
  });

  test("a cron of 5 fields croner runs is accepted, an empty value goes back to the default", () => {
    assert.equal(EnvSettings.validate("JOB_CLEANUP_CRON", "15 1 * * *"), null);
    assert.equal(EnvSettings.validate("JOB_CLEANUP_CRON", "0 22 * * MON-FRI"), null);
    assert.equal(EnvSettings.validate("JOB_CLEANUP_CRON", ""), null);
  });

  test("not 5 fields, not a cron, or one that never runs is refused", () => {
    assert.match(EnvSettings.validate("JOB_CLEANUP_CRON", "* * *"), /JOB_CLEANUP_CRON must be a cron of 5 fields/);
    // croner's seconds field is not offered
    assert.match(EnvSettings.validate("NIGHTLY_BACKUP_CRON", "0 30 2 * * *"), /5 fields/);
    assert.match(EnvSettings.validate("TOKEN_CLEANUP_CRON", "0 0 * * 5-1"), /TOKEN_CLEANUP_CRON is not a cron that runs/);
    assert.match(EnvSettings.validate("AUDIT_CLEANUP_CRON", "61 2 * * *"), /is not a cron that runs/);
    // 30 February : it compiles, and never fires
    assert.match(EnvSettings.validate("STORED_JOB_CLEANUP_CRON", "0 0 30 2 *"), /never run/);
    assert.match(scheduleCronProblem(""), /must be a cron/);
  });

  test("the scheduler takes the setting's cron, and the default for an invalid one", () => {
    appConfig.jobCleanupCron = "15 1 * * *";
    assert.equal(taskCron("jobCleanup"), "15 1 * * *");
    appConfig.jobCleanupCron = "not a cron";
    assert.equal(taskCron("jobCleanup"), "30 2 * * *");
    appConfig.jobCleanupCron = "";
    assert.equal(taskCron("jobCleanup"), "30 2 * * *");
  });
});

// ------------------------------------------------------------------
// applied live
// ------------------------------------------------------------------
describe("a saved cron applies at once", () => {
  test("the scheduler starts each nightly task on its setting's cron", async () => {
    appConfig.nightlyBackupCron = "0 1 * * *";
    await startTasks();
    assert.equal(registered("nightlyBackup"), "0 1 * * *");
    assert.equal(registered("jobCleanup"), "30 2 * * *");
  });

  test("applied, the task is registered again on its new cron, the old one stopped", async () => {
    await startTasks();
    const before = cronService.jobs.system.get("jobCleanup");
    const count = cronService.jobs.system.size;
    assert.equal(EnvSettings.applyLive("JOB_CLEANUP_CRON", "15 1 * * *", "30 2 * * *"), true);
    await vi.waitFor(() => assert.equal(registered("jobCleanup"), "15 1 * * *"));
    assert.equal(appConfig.jobCleanupCron, "15 1 * * *");
    assert.equal(before.isStopped(), true, "the old one fires no more");
    assert.equal(cronService.jobs.system.size, count, "one task for one, none beside it");
    // the other tasks untouched
    assert.equal(registered("auditCleanup"), "30 3 * * *");
  });

  test("cleared, it goes back to the task's default", async () => {
    await startTasks();
    EnvSettings.applyLive("TOKEN_CLEANUP_CRON", "45 5 * * *", "0 3 * * *");
    await vi.waitFor(() => assert.equal(registered("tokenCleanup"), "45 5 * * *"));
    EnvSettings.applyLive("TOKEN_CLEANUP_CRON", "", "0 3 * * *");
    await vi.waitFor(() => assert.equal(registered("tokenCleanup"), "0 3 * * *"));
  });

  test("a node whose scheduler does not run the tasks has nothing to register", async () => {
    await cronService.stopAll(0);
    assert.equal(cronService.rescheduleSystemTask("jobCleanup"), false);
    assert.equal(cronService.jobs.system.size, 0);
  });

  test("another node's save reaches this one : the 'env' epoch applies the changed variable", async () => {
    const { applyChangedEnv } = await import("../src/init/cluster.js");
    await startTasks();
    // what this node applied so far : the file as it is
    await applyChangedEnv();
    // another node writes the file (its save bumps the 'env' epoch, which calls this here)
    await EnvSettings.writeManaged(new Map([["STORED_JOB_CLEANUP_CRON", "20 4 * * 0"]]));
    await applyChangedEnv();
    await vi.waitFor(() => assert.equal(registered("storedJobsCleanup"), "20 4 * * 0"));
    assert.match(read("src/init/cluster.js"), /onEpoch\("env", \(\) => applyChangedEnv\(\)\)/);
    assert.match(read("src/lib/envSave.js"), /bump\("env"\)/);
  });
});

// ------------------------------------------------------------------
// the API
// ------------------------------------------------------------------
/**
 * Answers a request to the system routes, mounted as app.js mounts them, as a user with the given
 * role options.
 */
async function call(method, url, options, body) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { user: { username: "admin", roles: [], options } };
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
const ADMIN = { showSettings: true };
const put = (key, cron, options = ADMIN) => call("PUT", `/api/v2/system/tasks/${key}/schedule`, options, { cron });

describe("which task may be changed, as the API says it", () => {
  test("every task, with its variable ; the runner hub's loops too, their seconds", async () => {
    const all = await SystemTask.list();
    const loops = all.filter((t) => t.interval_seconds);
    assert.deepEqual(loops.map((t) => [t.key, t.interval_seconds, t.editable_schedule, t.schedule_env]), [
      ["runnerDispatch", 2, true, "RUNNER_DISPATCH_SECONDS"],
      ["runnerDial", 10, true, "RUNNER_DIAL_SECONDS"],
      ["runnerPrune", 60, true, "RUNNER_PRUNE_SECONDS"],
    ]);
    const list = all.filter((t) => !t.interval_seconds);
    assert.deepEqual(list.map((t) => t.key).sort(), Object.keys(TASKS).sort());
    for (const task of list) {
      assert.equal(task.editable_schedule, true, task.key);
      assert.equal(task.schedule_env, TASKS[task.key][0]);
      assert.equal(task.default_cron, TASKS[task.key][1]);
      assert.equal(task.schedule_deprecated, null, task.key);
    }
  });

  test("pinned by the environment, or ALLOW_ENV_EDIT=0 : not editable, its variable still said", async () => {
    process.env.JOB_CLEANUP_CRON = "0 5 * * *";
    let job = (await SystemTask.list()).find((t) => t.key === "jobCleanup");
    assert.equal(job.editable_schedule, false);
    assert.equal(job.schedule_env, "JOB_CLEANUP_CRON");
    delete process.env.JOB_CLEANUP_CRON;
    appConfig.allowEnvEdit = false;
    job = (await SystemTask.list()).find((t) => t.key === "jobCleanup");
    assert.equal(job.editable_schedule, false);
  });

  test("the cron in force and its next runs follow the setting", async () => {
    appConfig.auditCleanupCron = "0 6 * * *";
    const audit = await SystemTask.get("auditCleanup");
    assert.equal(audit.cron, "0 6 * * *");
    assert.equal(audit.default_cron, "30 3 * * *");
    assert.equal(audit.next_runs.length, 3);
  });
});

describe("PUT /api/v2/system/tasks/:key/schedule", () => {
  test("saves the cron through the settings' save, applies it live and answers the task", async () => {
    await startTasks();
    const res = await put("jobCleanup", " 15 1 * * * ");
    assert.equal(res.status, 200);
    assert.deepEqual(saved, [{ JOB_CLEANUP_CRON: "15 1 * * *" }]);
    assert.equal(res.body.key, "jobCleanup");
    assert.equal(res.body.cron, "15 1 * * *");
    assert.equal(res.body.editable_schedule, true);
    // the next run changed : 01:15
    assert.ok(res.body.next_run);
    await vi.waitFor(() => assert.equal(registered("jobCleanup"), "15 1 * * *"));
    // written to the settings file, as the settings page writes it
    assert.equal((await EnvSettings.readManaged()).get("JOB_CLEANUP_CRON"), "15 1 * * *");
  });

  test("audits the change : the task, its variable, the cron before and after", async () => {
    await put("nightlyBackup", "0 1 * * *");
    const entry = audits.find((a) => a.action === "system.task.schedule");
    assert.ok(entry);
    assert.equal(entry.target, "nightlyBackup");
    assert.equal(entry.outcome, "success");
    assert.deepEqual(entry.detail, { env: "NIGHTLY_BACKUP_CRON", from: "0 0 * * *", to: "0 1 * * *" });
  });

  test("a bad cron is 400, nothing saved", async () => {
    for (const cron of ["", "* * *", "0 30 2 * * *", "0 0 * * 5-1", "0 0 30 2 *"]) {
      const res = await put("jobCleanup", cron);
      assert.equal(res.status, 400, cron);
      assert.ok(res.body.error && res.body.details, cron);
    }
    assert.equal(saved.length, 0);
  });

  test("every task may be changed : the tasks of every minute and every hour too", async () => {
    await startTasks();
    for (const key of ["abandonedJobs", "deadNodes", "scheduleEnds"]) {
      const res = await put(key, "*/5 * * * *");
      assert.equal(res.status, 200, key);
      await vi.waitFor(() => assert.equal(registered(key), "*/5 * * * *"));
    }
    assert.doesNotMatch(read("src/controllers/v2/systemTask.controller.js"), /systemTaskScheduleFixed/);
    for (const lang of ["en", "de", "fr", "it", "es", "nl", "ca", "pt", "ja", "zh", "pl"]) {
      assert.doesNotMatch(read(`src/locales/${lang}.js`), /systemTaskScheduleFixed/, lang);
    }
  });

  test("a variable set in the environment is 403, and so is ALLOW_ENV_EDIT=0", async () => {
    process.env.AUDIT_CLEANUP_CRON = "0 5 * * *";
    let res = await put("auditCleanup", "0 1 * * *");
    assert.equal(res.status, 403);
    assert.match(res.body.details, /AUDIT_CLEANUP_CRON is set in the environment/);
    delete process.env.AUDIT_CLEANUP_CRON;
    appConfig.allowEnvEdit = false;
    res = await put("auditCleanup", "0 1 * * *");
    assert.equal(res.status, 403);
    assert.match(res.body.details, /ALLOW_ENV_EDIT=0/);
    assert.equal(saved.length, 0);
  });

  test("an unknown key is 404", async () => {
    const res = await put("notATask", "0 1 * * *");
    assert.equal(res.status, 404);
  });

  test("a user without the settings is 403", async () => {
    const res = await put("jobCleanup", "0 1 * * *", { showJobs: true, allowScheduledJobs: true, showAppearanceSettings: true });
    assert.equal(res.status, 403);
    assert.equal(saved.length, 0);
  });

  test("is documented, under the system tag, with its body and every answer", () => {
    const doc = JSON.parse(read("src/swagger_v2.json"));
    const op = doc.paths["/system/tasks/{key}/schedule"]?.put;
    assert.ok(op, "documented");
    assert.deepEqual(op.tags, ["system"]);
    // { cron } for a task, { seconds } for a runner hub loop
    const body = op.requestBody.content["application/json"].schema;
    assert.equal(body.properties.cron.type, "string");
    assert.equal(body.properties.seconds.type, "integer");
    for (const status of ["200", "400", "403", "404"]) assert.ok(op.responses[status], status);
    for (const p of ["/system/tasks", "/system/tasks/{key}"]) {
      const schema = doc.paths[p].get.responses["200"].content["application/json"].schema;
      const props = schema.properties.records?.items?.properties || schema.properties;
      for (const field of ["cron", "default_cron", "schedule_env", "editable_schedule"]) assert.ok(props[field], `${p} ${field}`);
    }
  });
});

// ------------------------------------------------------------------
// the config seed reload : a cron, its deprecated seconds still read
// ------------------------------------------------------------------
describe("the config seed reload", () => {
  // a seed set : the task runs
  beforeEach(() => {
    appConfig.configSeedPath = "/tmp/seed.yaml";
  });

  test("runs on its croner job, every minute by default, as the other tasks", async () => {
    await startTasks();
    assert.equal(registered("configSeedReload"), "* * * * *");
    assert.equal(taskCron("configSeedReload"), "* * * * *");
    // its own seconds timer is gone
    assert.equal(typeof cronService.scheduleConfigSeedReload, "undefined");
    assert.doesNotMatch(read("src/services/cron.service.js"), /interval: |'\* \* \* \* \* \*'/);
  });

  test("without CONFIG_SEED_PATH it is off : not registered, Off on its page", async () => {
    appConfig.configSeedPath = "";
    await startTasks();
    assert.equal(cronService.jobs.system.has("configSeedReload"), false);
    const seed = await SystemTask.get("configSeedReload");
    assert.equal(seed.enabled, false);
    assert.equal(seed.next_run, null);
    assert.deepEqual(seed.next_runs, []);
  });

  test("its deprecated seconds are read as a cron while CONFIG_SEED_RELOAD_CRON is not set", async () => {
    appConfig.configSeedReloadSeconds = "300";
    await startTasks();
    assert.equal(registered("configSeedReload"), "*/5 * * * *");
    const seed = await SystemTask.get("configSeedReload");
    assert.equal(seed.cron, "*/5 * * * *");
    assert.deepEqual(seed.schedule_deprecated, { env: "CONFIG_SEED_RELOAD_SECONDS", value: "300", cron: "*/5 * * * *", off: false, exact: true });
    // still editable : a cron saved there replaces it
    assert.equal(seed.editable_schedule, true);
  });

  test("seconds under a minute run on a seconds cron, 0 still turns it off", async () => {
    appConfig.configSeedReloadSeconds = "30";
    await startTasks();
    assert.equal(registered("configSeedReload"), "*/30 * * * * *");
    assert.equal((await SystemTask.get("configSeedReload")).next_runs.length, 3);
    appConfig.configSeedReloadSeconds = "0";
    await startTasks();
    assert.equal(cronService.jobs.system.has("configSeedReload"), false);
    const seed = await SystemTask.get("configSeedReload");
    assert.equal(seed.enabled, false);
    assert.equal(seed.schedule_deprecated.off, true);
  });

  test("CONFIG_SEED_RELOAD_CRON set wins : the deprecated seconds are ignored", async () => {
    appConfig.configSeedReloadSeconds = "300";
    appConfig.configSeedReloadCron = "*/10 * * * *";
    await startTasks();
    assert.equal(registered("configSeedReload"), "*/10 * * * *");
    assert.equal((await SystemTask.get("configSeedReload")).schedule_deprecated, null);
    // turned off by the seconds no more either
    appConfig.configSeedReloadSeconds = "0";
    assert.equal((await SystemTask.get("configSeedReload")).enabled, true);
  });

  test("a cron saved on its page writes CONFIG_SEED_RELOAD_CRON, which wins at once", async () => {
    appConfig.configSeedReloadSeconds = "30";
    await startTasks();
    const res = await put("configSeedReload", "*/2 * * * *");
    assert.equal(res.status, 200);
    assert.deepEqual(saved, [{ CONFIG_SEED_RELOAD_CRON: "*/2 * * * *" }]);
    assert.equal(res.body.cron, "*/2 * * * *");
    assert.equal(res.body.schedule_deprecated, null);
    await vi.waitFor(() => assert.equal(registered("configSeedReload"), "*/2 * * * *"));
    // the editor takes 5 fields only : the seconds cron the old variable read as is refused
    assert.equal((await put("configSeedReload", "*/30 * * * * *")).status, 400);
  });

  test("applied live, here and on every node, as the other crons : re-registered, the old job stopped", async () => {
    await startTasks();
    const before = cronService.jobs.system.get("configSeedReload");
    assert.equal(EnvSettings.applyLive("CONFIG_SEED_RELOAD_CRON", "*/15 * * * *", "* * * * *"), true);
    await vi.waitFor(() => assert.equal(registered("configSeedReload"), "*/15 * * * *"));
    assert.equal(before.isStopped(), true);
    // cleared : the default again, or the deprecated seconds while they are set
    process.env.CONFIG_SEED_RELOAD_SECONDS = "120";
    appConfig.configSeedReloadSeconds = "120";
    EnvSettings.applyLive("CONFIG_SEED_RELOAD_CRON", "", "* * * * *");
    await vi.waitFor(() => assert.equal(registered("configSeedReload"), "*/2 * * * *"));
    assert.equal(appConfig.configSeedReloadCron, "");
    // the deprecated variable changed in the settings file by hand : registered again on it
    EnvSettings.applyLive("CONFIG_SEED_RELOAD_SECONDS", "3600");
    await vi.waitFor(() => assert.equal(registered("configSeedReload"), "0 * * * *"));
    // another node's save reaches this one through the 'env' epoch
    const { applyChangedEnv } = await import("../src/init/cluster.js");
    await applyChangedEnv();
    await EnvSettings.writeManaged(new Map([["CONFIG_SEED_RELOAD_CRON", "*/3 * * * *"]]));
    await applyChangedEnv();
    await vi.waitFor(() => assert.equal(registered("configSeedReload"), "*/3 * * * *"));
  });

  test("its variables are not on Settings > System > General : the task's page is the place", () => {
    assert.ok(EnvSettings.OWNED_ELSEWHERE.test("CONFIG_SEED_RELOAD_CRON"));
    assert.ok(EnvSettings.OWNED_ELSEWHERE.test("CONFIG_SEED_RELOAD_SECONDS"));
    assert.doesNotMatch(read("../client/src/pages/admin/settings.vue"), /'CONFIG_SEED_RELOAD_SECONDS'/);
    assert.equal(EnvSettings.validate("CONFIG_SEED_RELOAD_CRON", "*/30 * * * * *").includes("5 fields"), true);
  });

  test("the deprecated variable is documented as such", () => {
    const help = read("help.yaml");
    assert.match(help, /- name: CONFIG_SEED_RELOAD_SECONDS[\s\S]*?short: Config seed reload interval \(seconds\) \(deprecated\)[\s\S]*?\*\*Deprecated: use `CONFIG_SEED_RELOAD_CRON` ; removed in 8\.0\.\*\*/);
    assert.match(read("../DEPRECATED.md"), /^\| `CONFIG_SEED_RELOAD_SECONDS` .*\| `CONFIG_SEED_RELOAD_CRON`.*\| 7\.8\.0 \|$/m);
    assert.match(read("src/app-start.js"), /for \(const warning of seedReloadWarnings\(\)\) logger\.warning\(warning\);/);
  });
});
