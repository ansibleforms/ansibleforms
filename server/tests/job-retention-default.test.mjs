// Finished jobs are kept 90 days by default (JOB_RETENTION_DAYS, app.config) : unset, the
// nightly cleanup prunes what is older ; set to 0, every job is kept ; the help the Settings
// page shows, and falls back to on a cleared field, says the same.
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";

/**
 * The app config as a fresh import reads it, with JOB_RETENTION_DAYS as given.
 *
 * Args:
 *   value (string|undefined): the variable's value, undefined for unset.
 *
 * Returns:
 *   Promise<object>: the config.
 */
async function configWith(value) {
  const saved = process.env.JOB_RETENTION_DAYS;
  if (value === undefined) delete process.env.JOB_RETENTION_DAYS;
  else process.env.JOB_RETENTION_DAYS = value;
  try {
    vi.resetModules();
    return (await import("../config/app.config.js")).default;
  } finally {
    if (saved === undefined) delete process.env.JOB_RETENTION_DAYS;
    else process.env.JOB_RETENTION_DAYS = saved;
  }
}

describe("job history retention", () => {
  test("90 days when unset, 0 kept when set to 0, any other value as given", async () => {
    assert.equal((await configWith(undefined)).jobRetentionDays, 90);
    assert.equal((await configWith("0")).jobRetentionDays, 0);
    assert.equal((await configWith("45")).jobRetentionDays, 45);
  });

  test("the help's default, what a cleared Settings field falls back to, is 90", () => {
    const help = YAML.parse(fs.readFileSync(new URL("../help.yaml", import.meta.url), "utf8"));
    const all = JSON.stringify(help);
    const entry = JSON.parse(all.match(/\{"name":"JOB_RETENTION_DAYS"[^{}]*\}/)[0]);
    assert.equal(entry.default, "90");
  });
});
