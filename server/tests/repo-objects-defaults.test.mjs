// A yes or no field a file no longer declares (lib/repoObjects : the value a new object gets) :
// information_schema gives a column's default as a text, and a text "0" is a yes to the crud model
// that saves it. Read as the number it is, the field turns off, and the next pull changes nothing -
// for the runners (ignore_certs, is_default : the default runner moved in git stays where git put
// it), the notification channels (is_active, secure) and the SSO providers (auto_login).
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));
// what a save tells the rest of the app (the header's labels, the sign-in providers) : nothing here
vi.mock("../src/routes/v2/app.routes.js", () => ({ forgetAppDefaults: () => {} }));
vi.mock("../src/lib/liveEvents.js", () => ({ publish: () => {} }));
// a runner's RTE told its settings : nothing here
vi.mock("../src/runners/rteHub.js", () => ({ socketState: () => null, isSocketRunner: () => false, dropSocket: () => {}, pushSettings: () => {} }));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const Engine = await import("../src/lib/repoObjects/engine.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
// the sign-in providers read again after a change : nothing here
for (const auth of ["auth_entraid", "auth_oidc"]) (await import(`../src/auth/${auth}.js`)).default.initialize = async () => {};

// a yes or no column as MariaDB and MySQL describe it : its default a text
const tinyint = (name, value = "0") => ({ name, value, nullable: "YES", type: "tinyint" });

beforeEach(() => {
  process.env.RTE_TOKEN = "rte-token";
  process.env.SSO_SECRET = "sso-secret";
  fx.reset({
    repositories: [
      { id: 1, name: "run-repo", uri: "https://git/x.git", use_for_runners: 1 },
      { id: 2, name: "note-repo", uri: "https://git/x.git", use_for_notifications: 1 },
      { id: 3, name: "sso-repo", uri: "https://git/x.git", use_for_sso: 1 },
    ],
    credentials: [{ id: 1, name: "smtp-login", credential_type: "smtp", host: "smtp.example.com", port: 587, password: "enc:p" }],
  });
  // read once per table and kept : the same columns for every test of this file
  fx.state.columns.runners = [tinyint("ignore_certs"), tinyint("is_default"), tinyint("enabled", "1")];
  fx.state.columns.notification_channels = [tinyint("is_active"), tinyint("secure"), tinyint("enabled", "1")];
  fx.state.columns.oauth2_providers = [tinyint("auto_login"), tinyint("enable")];
  CrudModel.flushAllLocal();
});

describe("a column's default, as the type of the column says", () => {
  test("a number column's text default is a number ; a text column's stays a text", async () => {
    fx.state.columns.defaults_typed = [tinyint("flag"), { name: "port", value: "389", nullable: "NO", type: "int" }, { name: "mode", value: "0", nullable: "NO", type: "varchar" }];
    const columns = await Engine.columnDefaults("AnsibleForms.`defaults_typed`");
    assert.strictEqual(columns.get("flag").value, 0);
    assert.strictEqual(columns.get("port").value, 389);
    assert.strictEqual(columns.get("mode").value, "0");
  });
});

/**
 * Syncs a type's repository once with a field on, then with it taken out of the file.
 *
 * Args:
 *   key (string): the type.
 *   repo (string): its repository.
 *   folder (string): its folder.
 *   file (object): the file without the field.
 *   field (string): the yes or no field.
 *   table (string): its table.
 *
 * Returns:
 *   Promise<object>: { row (after the field is taken out), again (the next pull's summary) }.
 */
async function takenOut(key, repo, folder, file, field, table) {
  const desc = await RepoObjects.descriptorOf(key);
  fx.writeEntry(repo, `${folder}/${file.name}.yaml`, key, { ...file, [field]: true });
  const first = await RepoObjects.syncRepository(desc, repo);
  assert.equal(first.created, 1, JSON.stringify(first.refused));
  assert.equal(Number(fx.rowNamed(table, file.name)[field]), 1, `${field} on`);
  fx.writeEntry(repo, `${folder}/${file.name}.yaml`, key, file);
  CrudModel.flushAllLocal();
  const summary = await RepoObjects.syncRepository(desc, repo);
  assert.equal(summary.updated, 1);
  const row = fx.rowNamed(table, file.name);
  CrudModel.flushAllLocal();
  return { row, again: await RepoObjects.syncRepository(desc, repo) };
}

const runnerFile = (name, extra = {}) => ({ name, type: "rte", uri: `https://${name}:8000`, token: "${RTE_TOKEN}", enabled: true, ...extra });
const mailFile = { name: "mail", type: "mail", credential: "smtp-login", from_address: "af@example.com" };
const ssoFile = { name: "corp", provider: "oidc", issuer: "https://idp", client_id: "id", client_secret: "${SSO_SECRET}", enable: true };

describe.each([
  ["runners", "run-repo", "runners", runnerFile("rte1"), "ignore_certs", "runners"],
  ["runners", "run-repo", "runners", runnerFile("rte1"), "is_default", "runners"],
  ["notifications", "note-repo", "notifications", mailFile, "is_active", "notification_channels"],
  ["notifications", "note-repo", "notifications", mailFile, "secure", "notification_channels"],
  ["sso", "sso-repo", "sso", ssoFile, "auto_login", "oauth2_providers"],
])("%s : %s", (key, repo, folder, file, field, table) => {
  test(`${field} taken out of its file turns it off, the next pull changes nothing`, async () => {
    const { row, again } = await takenOut(key, repo, folder, file, field, table);
    assert.equal(Number(row[field]), 0, `${field} off`);
    assert.equal(again.updated, 0, "unchanged after");
    assert.equal(again.unchanged, 1);
  });
});

describe("the default runner moved in git", () => {
  test("taken off one file, put on another : the new one is the default, the old one not, and it stays so", async () => {
    const desc = await RepoObjects.descriptorOf("runners");
    fx.writeEntry("run-repo", "runners/a.yaml", "runners", runnerFile("a", { is_default: true }));
    fx.writeEntry("run-repo", "runners/b.yaml", "runners", runnerFile("b"));
    await RepoObjects.syncRepository(desc, "run-repo");
    assert.equal(Number(fx.rowNamed("runners", "a").is_default), 1);
    fx.writeEntry("run-repo", "runners/a.yaml", "runners", runnerFile("a"));
    fx.writeEntry("run-repo", "runners/b.yaml", "runners", runnerFile("b", { is_default: true }));
    CrudModel.flushAllLocal();
    await RepoObjects.syncRepository(desc, "run-repo");
    assert.equal(Number(fx.rowNamed("runners", "a").is_default), 0);
    assert.equal(Number(fx.rowNamed("runners", "b").is_default), 1, "b stays the default");
    CrudModel.flushAllLocal();
    const again = await RepoObjects.syncRepository(desc, "run-repo");
    assert.equal(again.updated, 0);
    assert.equal(Number(fx.rowNamed("runners", "b").is_default), 1);
  });
});
