// #1437 : stored jobs unused for N days expire.
//
// STORED_JOB_UNUSED_DAYS (Settings > Environment > Retention) removes the stored jobs no job was
// launched from for that many days ; 0, the default, never does, so nothing changes on an
// upgrade. A stored job may ask for fewer days of its own (stored_jobs.unused_days), never more
// and never none while the setting is above 0 ; with the setting 0 any number or none. The days
// that count are the shorter of the two, a 0 or none left aside. The daily cleanup that removes
// the expired stored jobs removes these too : whichever comes first.
import { test, describe, vi, beforeEach, expect } from "vitest";
import fs from "node:fs";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// capture each task's callback instead of scheduling it
const tasks = new Map();
vi.mock("croner", () => ({
  Cron: class {
    constructor(pattern, opts, fn) { this.pattern = pattern; this.fn = fn; if (fn) tasks.set(pattern, fn); }
    stop() {}
    resume() {}
    nextRun() { return new Date(0); }
  },
}));
// every query the cleanup sends
const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: vi.fn(async (sql, params) => {
      queries.push({ sql, params });
      return { affectedRows: 0 };
    }),
  },
}));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: async () => {} } }));
vi.mock("../src/lib/workerLock.js", () => ({ confirmWorkerLock: async () => true }));

const { settingDays, effectiveUnusedDays, unusedDaysRefusal, unusedDaysValue, cleanupQuery } = await import("../src/lib/storedJobExpiry.js");
const cronService = (await import("../src/services/cron.service.js")).default;

describe("the days that count", () => {
  test("the setting : a whole number of at least 1, anything else never (0)", () => {
    expect(settingDays(30)).toBe(30);
    expect(settingDays("30")).toBe(30);
    for (const v of [0, -5, "abc", null, undefined, 1.5]) expect(settingDays(v)).toBe(0);
  });

  test("the shorter of the setting and the stored job's own, a 0 or none left aside", () => {
    expect(effectiveUnusedDays(30, 10)).toBe(10);
    expect(effectiveUnusedDays(10, 30)).toBe(10);
    expect(effectiveUnusedDays(30, null)).toBe(30);
    expect(effectiveUnusedDays(0, 12)).toBe(12);
    expect(effectiveUnusedDays(0, null)).toBeNull();
    expect(effectiveUnusedDays(0, 0)).toBeNull();
  });
});

describe("what a stored job may ask for", () => {
  test("with a setting : 1 to the setting's days, never more ; none follows the setting", () => {
    expect(unusedDaysRefusal(30, 1)).toBeNull();
    expect(unusedDaysRefusal(30, 30)).toBeNull();
    expect(unusedDaysRefusal(30, "12")).toBeNull();
    expect(unusedDaysRefusal(30, 31)).toBe("tooLong");
    // none : the setting's days, which still remove it (a stored job removed on a date)
    expect(unusedDaysRefusal(30, null)).toBeNull();
    expect(unusedDaysRefusal(30, "")).toBeNull();
  });

  test("without a setting (0) : any whole number of at least 1, or none", () => {
    expect(unusedDaysRefusal(0, 365)).toBeNull();
    expect(unusedDaysRefusal(0, null)).toBeNull();
    expect(unusedDaysRefusal(0, "")).toBeNull();
  });

  test("not a whole number of at least 1 : refused either way", () => {
    for (const v of [0, -1, 1.5, "abc", true]) {
      expect(unusedDaysRefusal(0, v)).toBe("invalid");
      expect(unusedDaysRefusal(30, v)).toBe("invalid");
    }
  });

  test("nothing given : nothing to check, and the column is left alone", () => {
    expect(unusedDaysRefusal(30, undefined)).toBeNull();
    expect(unusedDaysValue(undefined)).toBeUndefined();
    expect(unusedDaysValue("")).toBeNull();
    expect(unusedDaysValue("12")).toBe(12);
  });
});

describe("the cleanup's query", () => {
  test("the expired ones, and the ones unused for longer than their days, from their last use or creation", () => {
    const { sql, params } = cleanupQuery(30);
    expect(sql).toMatch(/^DELETE FROM AnsibleForms\.stored_jobs WHERE \(expires_at IS NOT NULL AND expires_at < NOW\(\)\)/);
    expect(sql).toMatch(/OR COALESCE\(last_used_at, created_at\) < NOW\(\) - INTERVAL \(CASE/);
    expect(sql).toMatch(/WHEN \? > 0 AND unused_days > 0 THEN LEAST\(\?, unused_days\)/);
    expect(sql).toMatch(/WHEN unused_days > 0 THEN unused_days END\) DAY$/);
    expect(params).toEqual([30, 30, 30, 30]);
  });

  test("the setting 0 (or not a number) : only the stored jobs' own days count", () => {
    expect(cleanupQuery(0).params).toEqual([0, 0, 0, 0]);
    expect(cleanupQuery("abc").params).toEqual([0, 0, 0, 0]);
  });
});

describe("the daily cleanup", () => {
  const appConfig = { nightlyBackupRetention: 0, auditRetentionDays: 0, jobRetentionDays: 0, storedJobUnusedDays: 45 };

  beforeEach(async () => {
    tasks.clear();
    queries.length = 0;
    await cronService.initializeSystemTasks(
      { abandon: async () => 0, removeOlderThan: async () => 0 },
      { removeExpired: async () => 0, cleanup: async () => 0 },
      { doBackup: async () => ({}), listBackups: async () => [], deleteBackup: async () => {} },
      appConfig
    );
  });

  test("at 4:00 AM it removes the expired and the unused stored jobs, with the setting read at the run", async () => {
    appConfig.storedJobUnusedDays = 20;
    await tasks.get("0 4 * * *")();
    const q = queries.find((x) => /DELETE FROM AnsibleForms\.stored_jobs/.test(x.sql));
    expect(q).toEqual(cleanupQuery(20));
  });
});

describe("the setting", () => {
  /**
   * The app config as a fresh import reads it, with STORED_JOB_UNUSED_DAYS as given.
   *
   * Args:
   *   value (string|undefined): the variable's value, undefined for unset.
   *
   * Returns:
   *   Promise<object>: the config.
   */
  async function configWith(value) {
    const saved = process.env.STORED_JOB_UNUSED_DAYS;
    if (value === undefined) delete process.env.STORED_JOB_UNUSED_DAYS;
    else process.env.STORED_JOB_UNUSED_DAYS = value;
    try {
      vi.resetModules();
      return (await import("../config/app.config.js")).default;
    } finally {
      if (saved === undefined) delete process.env.STORED_JOB_UNUSED_DAYS;
      else process.env.STORED_JOB_UNUSED_DAYS = saved;
    }
  }

  test("0 when unset : nothing changes on an upgrade ; any other value as given", async () => {
    expect((await configWith(undefined)).storedJobUnusedDays).toBe(0);
    expect((await configWith("30")).storedJobUnusedDays).toBe(30);
  });

  test("documented beside the job retention, with the default 0", () => {
    const help = YAML.parse(fs.readFileSync(new URL("../help.yaml", import.meta.url), "utf8"));
    const env = help.find((s) => s.name === "Environment Variables").items;
    const names = env.map((e) => e.name);
    expect(names.indexOf("STORED_JOB_UNUSED_DAYS")).toBe(names.indexOf("JOB_RETENTION_DAYS") + 1);
    expect(env.find((e) => e.name === "STORED_JOB_UNUSED_DAYS")).toMatchObject({ type: "number", default: "0" });
  });

  test("saved on the settings page, it applies at once", async () => {
    vi.resetModules();
    const Env = await import("../src/lib/envSettings.js");
    // the config envSettings.js reads : the test alias of its import (vitest.config.js)
    const { default: liveConfig } = await import("./__mocks__/app.config.js");
    expect(Env.applyLive("STORED_JOB_UNUSED_DAYS", "14")).toBe(true);
    expect(liveConfig.storedJobUnusedDays).toBe(14);
    Env.applyLive("STORED_JOB_UNUSED_DAYS", "0");
    expect(liveConfig.storedJobUnusedDays).toBe(0);
  });
});
