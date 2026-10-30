// tests for backup integrity : a failed backup must not leave a folder that looks
// like a restore point, and a restore must refuse one that is not.
//
// vitest.config.mjs aliases '../lib/cmd.js', '../lib/logger.js' and
// '../../config/app.config.js' to the shared mocks in tests/__mocks__, which is
// exactly what backup.model.js imports - so the model already runs against those.
// Importing the same mock modules here hands back the same objects, and setting
// fields on them is how this drives the model without touching a real database.
import { test, describe, beforeEach, afterEach, vi } from "vitest";

// the database a restore releases the jobs and claims of the backup's time in : every
// statement recorded, never a real connection
const statements = [];
vi.mock("../src/models/db.model.js", () => ({
  default: { do: async (sql) => { statements.push(sql); return { changedRows: 0, affectedRows: 0 }; } },
}));
// the schema check a restore runs again (Schema.upgradeAfterRestore) : what it answers, per
// test, and the order it ran in against the change notice
let schemaAfterRestore = { upgraded: true };
const order = [];
vi.mock("../src/models/schema.model.js", () => ({
  default: { upgradeAfterRestore: async () => { order.push("schema"); return schemaAfterRestore; } },
}));
vi.mock("../src/lib/epochs.js", () => ({ bump: async (name) => { order.push(`bump ${name}`); } }));
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

// db.config.js throws at import time unless these are present
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// MUST be set BEFORE importing envSettings (through backup.model), because MANAGED_ENV_PATH
// is a module-level constant. Without it the default resolves to the developer's real
// server/persistent/.env, so `npm test` copied live DB_PASSWORD / VAULT_TOKEN values into a
// tmp folder on any machine where the settings page had ever been used.
const ENV_FIXTURE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "af-env-fixture-"));
process.env.MANAGED_ENV_PATH = path.join(ENV_FIXTURE_DIR, ".env");

const appConfig = (await import("./__mocks__/app.config.js")).default;
const Cmd = (await import("./__mocks__/cmd.js")).default;
const BackupModel = (await import("../src/models/backup.model.js")).default;

const realExecute = Cmd.executeSilentCommand;
let tmpRoot;
let cmdCalls;

// the dump is written to the command's stdoutFile (Cmd streams it there, no shell redirect) ;
// a missing dump binary is caught by Cmd.isAvailable before anything is created
function behave({ toolFound = true, dumpWrites = "-- MySQL dump\nCREATE TABLE x();\n", dumpFails = false } = {}) {
  Cmd.isAvailable = () => toolFound;
  Cmd.executeSilentCommand = async (cmd) => {
    cmdCalls.push(cmd.command + (cmd.stdinFile ? ` (input ${cmd.stdinFile})` : ""));
    if (cmd.stdoutFile) await fs.writeFile(cmd.stdoutFile, dumpWrites);
    if (dumpFails) throw new Error("mariadb-dump: not found");
    return "";
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "af-backup-test-"));
  cmdCalls = [];
  appConfig.backupPath = tmpRoot;
  appConfig.configPath = path.join(tmpRoot, "src", "config.yaml");
  appConfig.formsFolderPath = path.join(tmpRoot, "src", "forms");
  appConfig.mysqldumpCommand = "mariadb-dump";
  appConfig.mysqlCommand = "mariadb";
  await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
  await fs.writeFile(appConfig.configPath, "categories: []\n");
  behave();
});

afterEach(async () => {
  Cmd.executeSilentCommand = realExecute;
  Cmd.isAvailable = () => true;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function listFolders() {
  return (await fs.readdir(tmpRoot)).filter((f) => /^\d{14}$/.test(f));
}

describe("doBackup leaves nothing behind when it fails", () => {
  test("a missing dump binary is reported before anything is created", async () => {
    behave({ toolFound: false });
    await assert.rejects(
      () => BackupModel.doBackup("probe"),
      (err) => /was not found on this system/.test(err.message)
    );
    assert.deepEqual(await listFolders(), [], "no backup folder should be created");
  });

  test("a dump that fails removes the half written folder", async () => {
    behave({ dumpWrites: "", dumpFails: true });
    await assert.rejects(() => BackupModel.doBackup("probe"));
    assert.deepEqual(await listFolders(), [], "the incomplete folder must be removed");
  });

  test("a dump that exits 0 but writes an empty file is treated as a failure", async () => {
    behave({ dumpWrites: "" });
    await assert.rejects(
      () => BackupModel.doBackup("probe"),
      (err) => /dump is empty/.test(err.message)
    );
    assert.deepEqual(await listFolders(), [], "an empty dump is not a restore point");
  });

  test("a successful dump keeps the folder, copies config.yaml and writes meta.yaml", async () => {
    const result = await BackupModel.doBackup("good one");
    assert.equal((await listFolders()).length, 1);
    const meta = await fs.readFile(path.join(result.backupFolder, "meta.yaml"), "utf8");
    assert.match(meta, /good one/);
    const copied = await fs.readFile(path.join(result.backupFolder, "config.yaml"), "utf8");
    assert.match(copied, /categories/);
  });
});

describe("backup validity is reported", () => {
  test("an empty dump is invalid, a real one is valid, and list agrees with detail", async () => {
    const bad = path.join(tmpRoot, "20260101000000");
    const good = path.join(tmpRoot, "20260102000000");
    await fs.mkdir(bad, { recursive: true });
    await fs.mkdir(good, { recursive: true });
    await fs.writeFile(path.join(bad, "ansibleforms.sql"), "");
    await fs.writeFile(path.join(good, "ansibleforms.sql"), "-- dump\n");

    const byFolder = Object.fromEntries((await BackupModel.listBackups()).map((b) => [b.folder, b]));
    assert.equal(byFolder["20260101000000"].valid, false);
    // the 0-byte file genuinely exists : that is what made a failed backup look real
    assert.equal(byFolder["20260101000000"].backupFileExists, true);
    assert.equal(byFolder["20260102000000"].valid, true);

    assert.equal((await BackupModel.getBackupByFolder("20260101000000")).valid, false);
    assert.equal((await BackupModel.getBackupByFolder("20260102000000")).valid, true);
  });

  test("a missing dump file is invalid too", async () => {
    await fs.mkdir(path.join(tmpRoot, "20260103000000"), { recursive: true });
    const detail = await BackupModel.getBackupByFolder("20260103000000");
    assert.equal(detail.backupFileExists, false);
    assert.equal(detail.valid, false);
  });
});

describe("restore refuses a backup that is not a restore point", () => {
  test("an empty dump is rejected instead of reporting success", async () => {
    const folder = "20260104000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, folder, "ansibleforms.sql"), "");

    await assert.rejects(
      () => BackupModel.restore(folder, false),
      (err) => /no usable database dump/.test(err.message)
    );
    assert.equal(
      cmdCalls.some((c) => c.includes("< ")),
      false,
      "no restore command should run for an invalid backup"
    );
  });

  test("a missing dump file is rejected", async () => {
    const folder = "20260105000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    await assert.rejects(
      () => BackupModel.restore(folder, false),
      (err) => /no usable database dump/.test(err.message)
    );
  });

  test("a valid backup does run the restore command", async () => {
    const folder = "20260106000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, folder, "ansibleforms.sql"), "-- dump\n");
    const result = await BackupModel.restore(folder, false);
    assert.match(result.message, /Restore completed/);
    // the dump is the restore command's input (Cmd streams the file in, no shell redirect)
    assert.equal(cmdCalls.some((c) => c.includes(`(input ${path.join(tmpRoot, folder, "ansibleforms.sql")})`)), true);
  });
});

describe("the environment file is captured but never silently restored", () => {
  // The backup carries persistent/.env so a rebuild gets DB_*, VAULT_* and the paths back.
  // Two properties matter and neither was covered: the MASTER secrets must be stripped (the
  // dump next to it is AES ciphertext, so shipping the key with it would defeat the
  // encryption), and a NORMAL restore must not touch the live file, because DB_HOST and the
  // paths in it describe the machine the backup came from.
  const LIVE = 'DB_HOST="LIVE"\nENCRYPTION_SECRET="THE-KEY"\nACCESS_TOKEN_SECRET="SIGNER"\nVAULT_TOKEN="hvs.x"\n';

  beforeEach(async () => {
    await fs.writeFile(process.env.MANAGED_ENV_PATH, LIVE, { mode: 0o600 });
  });

  test("the master secrets are stripped, everything else is kept", async () => {
    const folder = path.join(tmpRoot, "envcap");
    await fs.mkdir(folder, { recursive: true });
    await BackupModel.backupFormsAndFolder(folder);
    const text = await fs.readFile(path.join(folder, "managed.env"), "utf8");
    assert.equal(text.includes("THE-KEY"), false, "ENCRYPTION_SECRET must never reach a backup");
    assert.equal(text.includes("SIGNER"), false, "ACCESS_TOKEN_SECRET must never reach a backup");
    assert.match(text, /DB_HOST="LIVE"/);
    assert.match(text, /VAULT_TOKEN="hvs.x"/);
    // and it says why, so a restore onto a new host is not a mystery
    assert.match(text, /removed from this backup on purpose/);
  });

  test("the forms folder's symbolic links are listed beside its copy, and restored as links", async () => {
    const shared = path.join(tmpRoot, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "s.yaml"), "shared");
    await fs.mkdir(appConfig.formsFolderPath, { recursive: true });
    await fs.symlink("../../shared", path.join(appConfig.formsFolderPath, "linked"));
    const folder = path.join(tmpRoot, "links");
    await fs.mkdir(folder, { recursive: true });
    await BackupModel.backupFormsAndFolder(folder);
    const manifest = JSON.parse(await fs.readFile(path.join(folder, "forms-links.json"), "utf8"));
    assert.deepEqual(manifest.links, [{ path: "linked", target: "../../shared" }]);
    // the copy holds the content, for a restore where the target is gone
    assert.equal(await fs.readFile(path.join(folder, "forms", "linked", "s.yaml"), "utf8"), "shared");
    await BackupModel.restoreFormsAndFolder(folder);
    assert.equal(await fs.readlink(path.join(appConfig.formsFolderPath, "linked")), "../../shared");
  });

  test("the copy is not readable by anyone else", async () => {
    const folder = path.join(tmpRoot, "envmode");
    await fs.mkdir(folder, { recursive: true });
    await BackupModel.backupFormsAndFolder(folder);
    const stat = await fs.stat(path.join(folder, "managed.env"));
    assert.equal(stat.mode & 0o077, 0, "it can still hold VAULT_TOKEN and a mail password");
  });

  test("a normal restore leaves the live environment file alone", async () => {
    const folder = path.join(tmpRoot, "20260101000000");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "managed.env"), 'DB_HOST="FROM-BACKUP"\n');
    await BackupModel.restoreFormsAndFolder(folder);
    const live = await fs.readFile(process.env.MANAGED_ENV_PATH, "utf8");
    assert.match(live, /LIVE/, "restoreFormsAndFolder must not move the environment file");
    assert.equal(live.includes("FROM-BACKUP"), false);
  });

  test("restoring it explicitly takes a folder NAME and keeps the previous file", async () => {
    const folder = "20260303000000";
    await fs.mkdir(path.join(appConfig.backupPath, folder), { recursive: true });
    await fs.writeFile(path.join(appConfig.backupPath, folder, "managed.env"), 'DB_HOST="FROM-BACKUP"\n');
    const result = await BackupModel.restoreManagedEnv(folder);
    assert.equal(result.restored, true);
    assert.equal(result.restartRequired, true);
    assert.match(await fs.readFile(process.env.MANAGED_ENV_PATH, "utf8"), /FROM-BACKUP/);
    // a bad DB_HOST here stops the app booting, so the previous file is the only way back
    assert.match(await fs.readFile(`${process.env.MANAGED_ENV_PATH}.bak`, "utf8"), /LIVE/);
  });

  // It used to take a full PATH while every sibling takes a folder name, so the natural
  // wiring looked in the wrong place - and path.join on an unvalidated string could write an
  // arbitrary file over the live persistent/.env.
  for (const bad of ["../../etc", "/etc/passwd", "not-a-folder", "", "2026010100000"]) {
    test(`restoreManagedEnv refuses ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(() => BackupModel.restoreManagedEnv(bad), (e) => e.status === 400);
    });
  }

  test("a valid folder with no environment file reports it instead of throwing", async () => {
    const folder = "20260404000000";
    await fs.mkdir(path.join(appConfig.backupPath, folder), { recursive: true });
    const result = await BackupModel.restoreManagedEnv(folder);
    assert.equal(result.restored, false);
    assert.match(result.reason, /no environment file/);
  });

  test("the backup listing reports whether it carries an environment file", async () => {
    const withEnv = "20260505000000";
    await fs.mkdir(path.join(appConfig.backupPath, withEnv), { recursive: true });
    await fs.writeFile(path.join(appConfig.backupPath, withEnv, "ansibleforms.sql"), "-- dump\n");
    await fs.writeFile(path.join(appConfig.backupPath, withEnv, "managed.env"), 'A="b"\n');
    const listed = (await BackupModel.listBackups()).find((b) => b.folder === withEnv);
    // without this an operator cannot tell that a folder is credential-bearing
    assert.equal(listed.envFileExists, true);
    assert.ok(listed.envFileSize > 0);
  });
});

describe("a restore leaves nothing of the backup's time running", () => {
  // the dump holds the jobs that were running when it was taken and the claims taken then :
  // nothing follows them on this instance, so they are released once the dump is replayed
  test("its running jobs end abandoned, its repository and schedule claims are released", async () => {
    const folder = "20260107000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, folder, "ansibleforms.sql"), "-- dump\n");
    statements.length = 0;
    await BackupModel.restore(folder, false);
    const jobs = statements.find((s) => /UPDATE AnsibleForms.`jobs`/.test(s));
    assert.match(jobs, /SET status='abandoned', abort_requested=0, host=NULL, pid=NULL WHERE status='running' OR \(status='approve' AND job_type='workflow'\)/);
    assert.ok(statements.some((s) => /UPDATE AnsibleForms.`repositories` SET status='failed', pull_status = IF\(pull_status = 'running', 'failed', pull_status\), push_status = IF\(push_status = 'running', 'failed', push_status\), claim_node=NULL WHERE status='running'/.test(s)));
    assert.ok(statements.some((s) => /UPDATE AnsibleForms.`schedule` SET state='idle', claim_node=NULL WHERE state='running'/.test(s)));
  });

  test("the restored schema is checked and patched again before success, then every process told", async () => {
    // the backup taken before an upgrade brings back the older release's schema : without this
    // the cached "schema is up to date" kept this release running on it
    const folder = "20260109000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, folder, "ansibleforms.sql"), "-- dump\n");
    order.length = 0;
    schemaAfterRestore = { upgraded: true };
    const result = await BackupModel.restore(folder, false);
    assert.deepEqual(order, ["schema", "bump restore"]);
    assert.equal(result.message, "Restore completed");
    assert.equal(result.schemaUpgraded, true);
  });

  test("a restored schema whose patching failed: said in the restore's result", async () => {
    const folder = "20260110000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, folder, "ansibleforms.sql"), "-- dump\n");
    schemaAfterRestore = { upgraded: false, failed: ["The database needs upgrading, and the backup before it failed"] };
    const result = await BackupModel.restore(folder, false);
    assert.match(result.message, /^Restore completed, but the restored database could not be upgraded to this release: The database needs upgrading/);
    assert.equal(result.schemaUpgraded, false);
    assert.deepEqual(result.schemaFailed, schemaAfterRestore.failed);
    schemaAfterRestore = { upgraded: true };
  });

  test("nothing is released when the restore was refused", async () => {
    const folder = "20260108000000";
    await fs.mkdir(path.join(tmpRoot, folder), { recursive: true });
    statements.length = 0;
    await assert.rejects(() => BackupModel.restore(folder, false));
    assert.deepEqual(statements, []);
  });
});

describe("the dump and the restore keep the operator's MYSQL_* settings", () => {
  test("MYSQL_* reach the command, MYSQL_PWD does not", async () => {
    const { mysqlClientEnv } = await import("../src/models/backup.model.js");
    const env = mysqlClientEnv({ MYSQL_HOME: "/etc/mysql-af", MYSQL_UNIX_PORT: "/run/mysqld.sock", MYSQL_PWD: "secret", PATH: "/usr/bin" });
    assert.deepEqual(env, { MYSQL_HOME: "/etc/mysql-af", MYSQL_UNIX_PORT: "/run/mysqld.sock" });
  });

  test("the runner leases are runtime state : never dumped", async () => {
    const seen = [];
    Cmd.executeSilentCommand = async (cmd) => {
      seen.push(cmd);
      if (cmd.stdoutFile) await fs.writeFile(cmd.stdoutFile, "-- dump\n");
      return "";
    };
    await BackupModel.doBackup("leases");
    assert.match(seen[0].command, /--ignore-table=AnsibleForms\.runner_leases/);
    assert.equal(seen[0].env.MYSQL_PWD, undefined);
    assert.ok("AF_DB_PASSWORD" in seen[0].env);
  });
});
