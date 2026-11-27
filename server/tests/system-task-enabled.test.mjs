// Jobs > System : an admin may turn off the system tasks that only tidy up (the nightly backup,
// the cleanups, the config seed reload), each by its switch setting (NIGHTLY_BACKUP_ENABLED and the
// like, lib/systemTasks.js canDisable), saved with the task's cron through
// PUT /api/v2/system/tasks/:key/schedule { cron, enabled }.
//
// What has to hold :
//   - only those six may be turned off ; a stray NIGHTLY... switch of another task changes nothing ;
//   - turned off, the task does not run on its cron (registered paused, no next runs, Off) and
//     Run now still runs it ;
//   - saved, it applies at once on every node (applyLive), cleared it is on again ;
//   - the endpoint refuses enabled for a task that cannot be turned off (400), a value that is not
//     a boolean (400), a variable the environment sets (403), and audits the change ;
//   - the variables are true or false (1 or 0), documented, and not on Settings > General.
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
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "afswitch-"));
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
        // what the app asked : paused (a task turned off) or not
        this.askedPaused = !!opts?.paused;
      }
    },
  };
});

const EnvSettings = (await import("../src/lib/envSettings.js")).default;
const { SYSTEM_TASKS, SCHEDULE_SETTINGS, ENABLED_SETTINGS, taskEnabled, taskRunnable, taskSwitchedOn } = await import("../src/lib/systemTasks.js");
const cronService = (await import("../src/services/cron.service.js")).default;
const SystemTask = (await import("../src/models/systemTask.model.js")).default;
const Middleware = (await import("../src/lib/middleware.js")).default;
const systemRoutes = (await import("../src/routes/v2/system.routes.js")).default;
const appConfig = (await import("./__mocks__/app.config.js")).default;


const TASK_SWITCHES = {
  nightlyBackup: "NIGHTLY_BACKUP_ENABLED",
  jobCleanup: "JOB_CLEANUP_ENABLED",
  auditCleanup: "AUDIT_CLEANUP_ENABLED",
  storedJobsCleanup: "STORED_JOB_CLEANUP_ENABLED",
  tokenCleanup: "TOKEN_CLEANUP_ENABLED",
  configSeedReload: "CONFIG_SEED_RELOAD_ENABLED",
};

// what the tasks' work did, by its name
const ran = [];
/** Starts the scheduler's system tasks, as the worker does. */
async function startTasks() {
  const Job = { abandon: async () => 0, abandonDeadNodes: async () => 0, removeOlderThan: async () => (ran.push("jobs"), 0) };
  const Token = { cleanup: async () => 0 };
  const Backup = { doBackup: async () => (ran.push("backup"), {}), listBackups: async () => [], deleteBackup: async () => {} };
  await cronService.initializeSystemTasks(Job, Token, Backup, appConfig);
}
const job = (key) => cronService.jobs.system.get(key);

beforeEach(async () => {
  audits.length = 0;
  saved.length = 0;
  ran.length = 0;
  appConfig.allowEnvEdit = true;
  for (const s of [...SCHEDULE_SETTINGS, ...ENABLED_SETTINGS]) {
    delete appConfig[s.config];
    delete process.env[s.env];
  }
  appConfig.configSeedPath = "";
  appConfig.configSeedReloadSeconds = "";
  await fs.rm(process.env.MANAGED_ENV_PATH, { force: true });
});

afterEach(async () => {
  await cronService.stopAll(0);
});

async function call(method, url, options, body) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { user: { username: "admin", type: "local", roles: [], options } };
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
const put = (key, body) => call("PUT", `/api/v2/system/tasks/${key}/schedule`, ADMIN, body);

describe("which tasks may be turned off", () => {
  test("the six that tidy up, each with its switch ; the others never", () => {
    const can = SYSTEM_TASKS.filter((t) => t.canDisable).map((t) => [t.key, t.enabledSetting.env]);
    assert.deepEqual(Object.fromEntries(can), TASK_SWITCHES);
    assert.deepEqual(ENABLED_SETTINGS.map((s) => s.env).sort(), Object.values(TASK_SWITCHES).sort());
    for (const key of ["abandonedJobs", "deadNodes", "scheduleEnds", "scheduleResync"]) {
      assert.equal(SYSTEM_TASKS.find((t) => t.key === key).canDisable, undefined, key);
    }
  });

  test("on by default ; false or 0 turns one off, any other value leaves it on", () => {
    assert.equal(taskEnabled("nightlyBackup"), true);
    for (const off of [false, "false", "FALSE", "0", " 0 "]) {
      appConfig.nightlyBackupEnabled = off;
      assert.equal(taskSwitchedOn("nightlyBackup"), false, String(off));
      assert.equal(taskEnabled("nightlyBackup"), false, String(off));
      assert.equal(taskRunnable("nightlyBackup"), true, "Run now still runs it");
    }
    for (const on of [true, "true", "1", ""]) {
      appConfig.nightlyBackupEnabled = on;
      assert.equal(taskEnabled("nightlyBackup"), true, String(on));
    }
  });

  test("the API says it : Off, no next runs, still runnable ; a task that cannot be turned off says so", async () => {
    appConfig.jobCleanupEnabled = false;
    const all = await SystemTask.list();
    const jobs = all.find((t) => t.key === "jobCleanup");
    assert.equal(jobs.enabled, false);
    assert.equal(jobs.switched_on, false);
    assert.equal(jobs.can_disable, true);
    assert.equal(jobs.enabled_env, "JOB_CLEANUP_ENABLED");
    assert.equal(jobs.editable_enabled, true);
    assert.equal(jobs.runnable, true);
    assert.equal(jobs.next_run, null);
    assert.deepEqual(jobs.next_runs, []);
    assert.equal(jobs.cron, "30 2 * * *", "its cron kept, what it runs on once on again");
    const dead = all.find((t) => t.key === "deadNodes");
    assert.deepEqual([dead.can_disable, dead.switched_on, dead.enabled_env, dead.editable_enabled, dead.runnable], [false, true, null, false, true]);
    const loop = all.find((t) => t.key === "runnerDispatch");
    assert.deepEqual([loop.can_disable, loop.enabled_env, loop.editable_enabled], [false, null, false]);
  });

  test("pinned by the environment, or ALLOW_ENV_EDIT=0 : its switch not editable", async () => {
    process.env.NIGHTLY_BACKUP_ENABLED = "false";
    assert.equal((await SystemTask.get("nightlyBackup")).editable_enabled, false);
    delete process.env.NIGHTLY_BACKUP_ENABLED;
    appConfig.allowEnvEdit = false;
    assert.equal((await SystemTask.get("nightlyBackup")).editable_enabled, false);
  });
});

describe("the scheduler", () => {
  test("a task turned off is registered paused : it never fires on its cron", async () => {
    appConfig.nightlyBackupEnabled = false;
    await startTasks();
    assert.equal(job("nightlyBackup").askedPaused, true);
    assert.equal(job("jobCleanup").askedPaused, false);
  });

  test("Run now still runs a task turned off, recorded as any run", async () => {
    appConfig.jobCleanupEnabled = false;
    appConfig.jobRetentionDays = 30;
    await startTasks();
    const started = cronService.runSystemTaskNow("jobCleanup", "admin (local)");
    assert.equal(started.status, "started");
    await started.done;
    assert.deepEqual(ran, ["jobs"]);
  });

  test("turned off and on again live : registered again, paused then not", async () => {
    await startTasks();
    const before = job("nightlyBackup");
    EnvSettings.applyLive("NIGHTLY_BACKUP_ENABLED", "false", "true");
    process.env.NIGHTLY_BACKUP_ENABLED = "false";
    EnvSettings.applyLive("NIGHTLY_BACKUP_ENABLED", "false", "true");
    await vi.waitFor(() => assert.equal(job("nightlyBackup").askedPaused, true));
    assert.equal(before.isStopped(), true, "the old one fires no more");
    assert.equal(appConfig.nightlyBackupEnabled, false);
    // cleared : on again, its default
    delete process.env.NIGHTLY_BACKUP_ENABLED;
    EnvSettings.applyLive("NIGHTLY_BACKUP_ENABLED", "", "true");
    await vi.waitFor(() => assert.equal(job("nightlyBackup").askedPaused, false));
    assert.equal(appConfig.nightlyBackupEnabled, true);
  });

  test("the config seed reload turned off : paused with a seed, not registered without one", async () => {
    appConfig.configSeedReloadEnabled = false;
    appConfig.configSeedPath = "/tmp/seed.yaml";
    await startTasks();
    assert.equal(job("configSeedReload").askedPaused, true);
    await cronService.stopAll(0);
    appConfig.configSeedPath = "";
    await startTasks();
    assert.equal(cronService.jobs.system.has("configSeedReload"), false);
    assert.equal((await SystemTask.get("configSeedReload")).runnable, false);
  });
});

describe("PUT /api/v2/system/tasks/:key/schedule { enabled }", () => {
  test("turns a task off and on, in one write with its cron, applied at once and answered", async () => {
    await startTasks();
    let res = await put("nightlyBackup", { cron: "0 1 * * *", enabled: false });
    assert.equal(res.status, 200);
    assert.deepEqual(saved, [{ NIGHTLY_BACKUP_CRON: "0 1 * * *", NIGHTLY_BACKUP_ENABLED: "false" }]);
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.switched_on, false);
    assert.equal(res.body.cron, "0 1 * * *");
    assert.deepEqual(res.body.next_runs, []);
    await vi.waitFor(() => assert.equal(job("nightlyBackup").askedPaused, true));
    assert.equal((await EnvSettings.readManaged()).get("NIGHTLY_BACKUP_ENABLED"), "false");
    // the switch alone
    res = await put("nightlyBackup", { enabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.next_runs.length, 3);
    await vi.waitFor(() => assert.equal(job("nightlyBackup").askedPaused, false));
  });

  test("audits the change, apart from the cron's ; an unchanged switch is not audited", async () => {
    await put("auditCleanup", { enabled: false });
    const entry = audits.find((a) => a.action === "system.task.enabled");
    assert.ok(entry);
    assert.equal(entry.target, "auditCleanup");
    assert.deepEqual(entry.detail, { env: "AUDIT_CLEANUP_ENABLED", from: true, to: false });
    assert.equal(audits.some((a) => a.action === "system.task.schedule"), false, "no cron sent, none audited");
    audits.length = 0;
    await put("auditCleanup", { enabled: false });
    assert.equal(audits.length, 0);
  });

  test("a task that cannot be turned off is 400, and so is a value that is not a boolean, or nothing sent", async () => {
    let res = await put("deadNodes", { enabled: false });
    assert.equal(res.status, 400);
    assert.match(res.body.details, /can't be turned off/);
    res = await put("jobCleanup", { enabled: "no" });
    assert.equal(res.status, 400);
    assert.match(res.body.details, /enabled must be true or false/);
    res = await put("jobCleanup", {});
    assert.equal(res.status, 400);
    assert.equal(saved.length, 0);
  });

  test("its variable set in the environment is 403, even with a cron that may be saved", async () => {
    process.env.TOKEN_CLEANUP_ENABLED = "true";
    const res = await put("tokenCleanup", { cron: "0 4 * * *", enabled: false });
    assert.equal(res.status, 403);
    assert.match(res.body.details, /TOKEN_CLEANUP_ENABLED is set in the environment/);
    assert.equal(saved.length, 0);
  });

  test("Run now runs a task turned off (not 400)", async () => {
    appConfig.jobCleanupEnabled = false;
    appConfig.jobRetentionDays = 30;
    await startTasks();
    const res = await call("POST", "/api/v2/system/tasks/jobCleanup/run", ADMIN, {});
    assert.equal(res.status, 200);
    assert.deepEqual(ran, ["jobs"]);
  });
});

describe("the variables", () => {
  test("true or false (1 or 0), anything else refused", () => {
    for (const ok of ["true", "false", "1", "0", "FALSE", ""]) assert.equal(EnvSettings.validate("NIGHTLY_BACKUP_ENABLED", ok), null, ok);
    assert.match(EnvSettings.validate("NIGHTLY_BACKUP_ENABLED", "no"), /NIGHTLY_BACKUP_ENABLED must be true or false/);
  });

  test("documented with their default, on the task's page only, never handed to a playbook", async () => {
    const help = read("help.yaml");
    const { APP_ENV } = await import("../src/lib/playbookEnv.js");
    for (const env of Object.values(TASK_SWITCHES)) {
      assert.match(help, new RegExp(`- name: ${env}\\n    version: 7\\.9\\.0\\n    type: boolean\\n[\\s\\S]*?default: true`), env);
      assert.equal(EnvSettings.classify(env), "live", env);
      assert.equal(EnvSettings.OWNED_ELSEWHERE.test(env), true, `${env} not on Settings > General`);
      assert.ok(APP_ENV.has(env), env);
    }
  });

  test("the save's body and the task's fields are documented", () => {
    const doc = JSON.parse(read("src/swagger_v2.json"));
    const body = doc.paths["/system/tasks/{key}/schedule"].put.requestBody.content["application/json"].schema;
    assert.equal(body.properties.enabled.type, "boolean");
    for (const p of ["/system/tasks", "/system/tasks/{key}"]) {
      const schema = doc.paths[p].get.responses["200"].content["application/json"].schema;
      const props = schema.properties.records?.items?.properties || schema.properties;
      for (const field of ["can_disable", "switched_on", "enabled_env", "editable_enabled", "runnable"]) assert.ok(props[field], `${p} ${field}`);
    }
  });
});
