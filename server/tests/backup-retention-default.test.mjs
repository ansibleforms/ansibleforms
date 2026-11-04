// The nightly backups kept by default (NIGHTLY_BACKUP_RETENTION, app.config) : 30 when unset ; 0
// turns the cleanup off ; the help the Settings page shows, and falls back to on a cleared
// field, says the same.
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";

/**
 * The app config as a fresh import reads it, with NIGHTLY_BACKUP_RETENTION as given.
 *
 * Args:
 *   value (string|undefined): the variable's value, undefined for unset.
 *
 * Returns:
 *   Promise<object>: the config.
 */
async function configWith(value) {
  const saved = process.env.NIGHTLY_BACKUP_RETENTION;
  if (value === undefined) delete process.env.NIGHTLY_BACKUP_RETENTION;
  else process.env.NIGHTLY_BACKUP_RETENTION = value;
  try {
    vi.resetModules();
    return (await import("../config/app.config.js")).default;
  } finally {
    if (saved === undefined) delete process.env.NIGHTLY_BACKUP_RETENTION;
    else process.env.NIGHTLY_BACKUP_RETENTION = saved;
  }
}

describe("nightly backups kept", () => {
  test("30 when unset, 0 kept when set to 0, any other value as given", async () => {
    assert.equal((await configWith(undefined)).nightlyBackupRetention, 30);
    assert.equal((await configWith("0")).nightlyBackupRetention, 0);
    assert.equal((await configWith("14")).nightlyBackupRetention, 14);
  });

  test("the help's default, what a cleared Settings field falls back to, is 30", () => {
    const help = YAML.parse(fs.readFileSync(new URL("../help.yaml", import.meta.url), "utf8"));
    const entry = JSON.parse(JSON.stringify(help).match(/\{"name":"NIGHTLY_BACKUP_RETENTION"[^{}]*\}/)[0]);
    assert.equal(entry.default, "30");
  });
});
