// Jobs > System : when the nightly system tasks run is an admin's to change. Each of the five
// (jobCleanup, auditCleanup, tokenCleanup, storedJobsCleanup, nightlyBackup) takes its cron from a
// setting (JOB_CLEANUP_CRON and the like, lib/systemTasks.js), saved as Settings > System >
// General saves its variables (lib/envSave.js) through PUT /api/v2/system/tasks/:key/schedule.
//
// What has to hold :
//   - a cron setting is 5 fields croner accepts and that runs again, refused otherwise ;
//   - saved, it applies at once : the scheduler registers the task again on its new cron, here
//     and on every other node (the 'env' epoch, init/cluster.js applyChangedEnv), without a
//     restart, and cleared it goes back to the task's default ;
//   - the tasks the app needs often (every minute, every hour, the seed reload) keep theirs ;
//   - the endpoint is the settings', refuses a bad cron (400), a task that is not editable or
//     whose variable the environment sets (403) and an unknown key (404), and is audited ;
//   - the API says which task may be changed (editable_schedule) and its variable ;
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

// the five nightly tasks and their variables
const NIGHTLY = {
  tokenCleanup: ["TOKEN_CLEANUP_CRON", "0 3 * * *"],
  auditCleanup: ["AUDIT_CLEANUP_CRON", "30 3 * * *"],
  jobCleanup: ["JOB_CLEANUP_CRON", "30 2 * * *"],
  nightlyBackup: ["NIGHTLY_BACKUP_CRON", "0 0 * * *"],
  storedJobsCleanup: ["STORED_JOB_CLEANUP_CRON", "0 4 * * *"],
};
const FIXED = ["abandonedJobs", "deadNodes", "scheduleEnds", "configSeedReload"];

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
  await fs.rm(process.env.MANAGED_ENV_PATH, { force: true });
});

afterEach(async () => {
  await cronService.stopAll(0);
});

// ------------------------------------------------------------------
// the settings
// ------------------------------------------------------------------
describe("the five cron settings", () => {
  test("each nightly task has one, its default the cron it always had ; the others none", () => {
    const declared = Object.fromEntries(SCHEDULE_SETTINGS.map((s) => [s.key, [s.env, s.default]]));
    assert.deepEqual(declared, NIGHTLY);
    for (const key of FIXED) assert.equal(SYSTEM_TASKS.find((t) => t.key === key).schedule, null, key);
  });

  test("documented in help.yaml with their default, applied live, shown on the task's page only", () => {
    const help = read("help.yaml");
    for (const [env, cron] of Object.values(NIGHTLY)) {
      assert.match(help, new RegExp(`- name: ${env}\\n    version: 7\\.8\\.0\\n    type: string\\n[\\s\\S]*?default: "${cron.replace(/\*/g, "\\*")}"`), env);
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
  test("the five nightly tasks, with their variable ; the others are the app's own", async () => {
    const list = await SystemTask.list();
    for (const task of list) {
      if (NIGHTLY[task.key]) {
        assert.equal(task.editable_schedule, true, task.key);
        assert.equal(task.schedule_env, NIGHTLY[task.key][0]);
        assert.equal(task.default_cron, NIGHTLY[task.key][1]);
      } else {
        assert.equal(task.editable_schedule, false, task.key);
        assert.equal(task.schedule_env, null, task.key);
      }
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

  test("a task whose timing is the app's own is 403", async () => {
    for (const key of FIXED) {
      const res = await put(key, "0 1 * * *");
      assert.equal(res.status, 403, key);
    }
    assert.equal(saved.length, 0);
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
    assert.deepEqual(op.requestBody.content["application/json"].schema.required, ["cron"]);
    for (const status of ["200", "400", "403", "404"]) assert.ok(op.responses[status], status);
    for (const p of ["/system/tasks", "/system/tasks/{key}"]) {
      const schema = doc.paths[p].get.responses["200"].content["application/json"].schema;
      const props = schema.properties.records?.items?.properties || schema.properties;
      for (const field of ["cron", "default_cron", "schedule_env", "editable_schedule"]) assert.ok(props[field], `${p} ${field}`);
    }
  });
});
