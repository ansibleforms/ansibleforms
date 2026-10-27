// A backup taken before forms/ was included holds only ansibleforms.sql : a valid restore point.
// Listing the backups warned "getDirSize: failed to read .../forms: ENOENT" for each of them, on
// every load of the page (#1192). A folder that cannot be read for another reason still warns.
import { test, describe, beforeAll, beforeEach, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
const warnings = [];
// the logger the test config puts in place of ../lib/logger.js (vitest.config.js)
vi.mock("./__mocks__/logger.js", () => ({
  default: {
    warning: (m) => warnings.push(String(m)),
    error: () => {}, notice: () => {}, info: () => {}, debug: () => {},
  },
}));

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
const ENV_FIXTURE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "af-env-fixture-"));
process.env.MANAGED_ENV_PATH = path.join(ENV_FIXTURE_DIR, ".env");

const appConfig = (await import("./__mocks__/app.config.js")).default;
const BackupModel = (await import("../src/models/backup.model.js")).default;

let tmpRoot;
let saved;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "af-backups-"));
  saved = { backupPath: appConfig.backupPath, configPath: appConfig.configPath };
  appConfig.backupPath = tmpRoot;
  appConfig.configPath = path.join(tmpRoot, "src", "config.yaml");
});
afterAll(async () => {
  Object.assign(appConfig, saved);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(ENV_FIXTURE_DIR, { recursive: true, force: true });
});
beforeEach(() => { warnings.length = 0; });

describe("listing a backup without a forms folder", () => {
  test("lists it as valid, without forms, and warns about nothing", async () => {
    const folder = path.join(tmpRoot, "20250101000000");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "ansibleforms.sql"), "-- MySQL dump\n");
    const b = await BackupModel.getBackupByFolder("20250101000000");
    assert.equal(b.valid, true);
    assert.equal(b.formsDirExists, false);
    assert.equal(b.formsDirFileCount, 0);
    assert.deepEqual(warnings.filter((w) => /getDirSize/.test(w)), []);
  });

  test("a forms path that cannot be read for another reason still warns", async () => {
    // forms as a file : readdir answers ENOTDIR, not ENOENT
    const folder = path.join(tmpRoot, "20250102000000");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "ansibleforms.sql"), "-- MySQL dump\n");
    await fs.writeFile(path.join(folder, "forms"), "not a folder");
    await BackupModel.getBackupByFolder("20250102000000");
    assert.equal(warnings.filter((w) => /getDirSize/.test(w)).length, 1);
  });
});
