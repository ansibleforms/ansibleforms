// The object types on the engine (lib/repoObjects) beyond the credentials and the runners : secret
// stores, notification channels, SSO providers, LDAP directories, syslog servers and labels. Each
// type runs the same table of cases, on the shared fixture :
//   a pull       makes its object from its file, linked to it, in the seed's format
//   secrets      a plain one refused (the types that have secrets)
//   references   an object whose credential is not there yet waits (the types that name one)
//   activation   an object of the app written to its folder, without its secrets
//   write-back   an edit in the app rewrites only the changed field
//   deactivation unlinked, kept in the app
// and what is new on the engine : the main LDAP directory is never deleted, its file removed
// refused ; the labels and the directories keep their places, a move rewriting them.
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
const { default: CrudModel } = await import("../src/models/crud.model.js");
// the sign-in providers read again after a change : nothing here
for (const auth of ["auth_entraid", "auth_oidc"]) (await import(`../src/auth/${auth}.js`)).default.initialize = async () => {};

/**
 * Calls a controller as a request of an admin would.
 *
 * Args:
 *   handler (function): the controller's function.
 *   req (object): { body, params }.
 *
 * Returns:
 *   Promise<object>: { status, data }.
 */
function asAdmin(handler, { body = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(data) {
        resolve({ status: this.statusCode, data });
        return this;
      },
    };
    handler({ body, params, headers: {}, query: {}, user: { user: { username: "admin", roles: ["admin"], options: { showSettings: true } } } }, res);
  });
}

// ─── the types, as the table of cases reads them ───────────────────────────────
//   key, repo (its repository, flag), folder, table : where it lives
//   file      a valid file, naming its credential when it names one
//   check     what its row then holds
//   secret    a secret field (a plain value refused), when it has one
//   app       an object of the app (activation), its secret set when it has one
//   edit      a field an edit in the app changes, and its new value
const TYPES = [
  {
    key: "secret_stores",
    folder: "secret-stores",
    table: "secret_stores",
    file: { name: "vault", type: "vault", credential: "vault-token", kv_version: 2 },
    check: (r) => assert.equal(r.credential, "vault-token"),
    secret: "token",
    app: { id: 30, name: "app-vault", type: "vault", url: "https://vault", token: "enc:tok", description: "" },
    edit: ["description", "the main vault"],
  },
  {
    key: "notifications",
    folder: "notifications",
    table: "notification_channels",
    file: { name: "mail", type: "mail", credential: "smtp-login", from_address: "af@example.com" },
    check: (r) => assert.equal(r.from_address, "af@example.com"),
    secret: "webhook_url",
    app: { id: 30, name: "teams", type: "teams", webhook_url: "enc:https://hook", enabled: 1, description: "" },
    edit: ["description", "the team's channel"],
  },
  {
    key: "sso",
    folder: "sso",
    table: "oauth2_providers",
    file: { name: "corp", provider: "azuread", credential: "corp-client", enable: false },
    check: (r) => assert.equal(r.credential, "corp-client"),
    secret: "client_secret",
    app: { id: 30, name: "google", provider: "oidc", issuer: "https://accounts.google.com", client_id: "id", client_secret: "enc:sec", enable: 0 },
    edit: ["scope", "openid email"],
  },
  {
    key: "ldap",
    folder: "ldap",
    table: "ldap",
    file: { name: "corp", credential: "corp-bind", search_base: "dc=corp", username_attribute: "sAMAccountName", position: 2 },
    check: (r) => assert.equal(r.search_base, "dc=corp"),
    secret: "bind_user_pw",
    app: { id: 30, name: "emea", position: 3, server: "ldap.emea", port: 636, bind_user_dn: "cn=bind", bind_user_pw: "enc:pw", search_base: "dc=emea" },
    edit: ["search_base", "dc=emea,dc=corp"],
  },
  {
    key: "syslog",
    folder: "syslog",
    table: "syslog_servers",
    file: { name: "siem", host: "siem.example.com", port: 514, protocol: "udp4", receives: "audit" },
    check: (r) => assert.equal(r.receives, "audit"),
    app: { id: 30, name: "local", host: "localhost", port: 514, protocol: "udp4", level: "info", type: "BSD", receives: "both", enabled: 1, description: "" },
    edit: ["level", "warning"],
  },
  {
    key: "labels",
    folder: "labels",
    table: "labels",
    file: { name: "PRODUCTION", color: "red", position: 1 },
    check: (r) => assert.equal(r.color, "red"),
    app: { id: 30, name: "EU", color: "blue", enabled: 1, position: 2 },
    edit: ["color", "green"],
  },
];

// the credentials the files name, each of the kind its model checks
const CREDENTIALS = [
  { id: 1, name: "vault-token", credential_type: "vault", url: "https://vault.example.com", password: "enc:t" },
  { id: 2, name: "smtp-login", credential_type: "smtp", host: "smtp.example.com", port: 587, password: "enc:p" },
  { id: 3, name: "corp-client", credential_type: "entraid", tenant_id: "contoso.onmicrosoft.com", user: "app-id", password: "enc:s" },
  { id: 4, name: "corp-bind", credential_type: "ldap", host: "ldap.corp", port: 636, user: "cn=bind", password: "enc:b" },
];

// the main directory there always is
const MAIN = { id: 1, name: "main", position: 1, server: "ldap.main", port: 389, bind_user_dn: "cn=admin", bind_user_pw: "enc:m", search_base: "dc=main", enable: 0 };

// the repository of each type, one each
const flag = (key) => `use_for_${key}`;
const repoOf = (key) => `${key}-repo`;

beforeEach(() => {
  process.env.HOOK_URL = "https://hook.example.com/x";
  fx.reset({
    repositories: TYPES.map((t, i) => ({ id: i + 1, name: repoOf(t.key), uri: "https://git/x.git", [flag(t.key)]: 1 })),
    credentials: CREDENTIALS,
    ldap: [{ ...MAIN }],
  });
  CrudModel.flushAllLocal();
});

describe.each(TYPES)("$key", (type) => {
  const repo = repoOf(type.key);
  const desc = () => RepoObjects.descriptorOf(type.key);

  test("a pull makes its object from its file, linked to it", async () => {
    fx.writeFile(repo, type.folder, "a.yaml", type.file);
    const summary = await RepoObjects.syncRepository(await desc(), repo);
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.created, 1);
    const row = fx.rowNamed(type.table, type.file.name);
    assert.equal(row.repository, repo);
    assert.equal(row.repo_file, `${type.folder}/a.yaml`);
    type.check(row);
  });

  test("activation : the app's object written to its folder, without its secret ; deactivation unlinks it", async () => {
    fx.state.tables[type.table].push({ ...type.app });
    const report = await RepoObjects.activate(await desc(), repo);
    assert.ok(report.written.includes(type.app.name), JSON.stringify(report));
    const files = fx.listFiles(repo, type.folder);
    const file = files.map((f) => fx.readObject(repo, type.folder, f)).find((o) => o.name === type.app.name);
    assert.ok(file, files.join(", "));
    if (type.secret) {
      assert.equal(file[type.secret], undefined);
      assert.ok(report.withoutSecret.includes(type.app.name));
    }
    assert.equal(fx.rowNamed(type.table, type.app.name).repository, repo);
    const off = await RepoObjects.deactivate(await desc(), repo);
    assert.ok(off.unlinked >= 1);
    assert.equal(fx.rowNamed(type.table, type.app.name).repository, null);
  });

  test("an edit in the app rewrites only the changed field", async () => {
    fx.writeFile(repo, type.folder, "a.yaml", type.file);
    await RepoObjects.syncRepository(await desc(), repo);
    const row = fx.rowNamed(type.table, type.file.name);
    const before = { ...row };
    row[type.edit[0]] = type.edit[1];
    CrudModel.flushAllLocal();
    assert.equal(await RepoObjects.appUpdated(type.key, before, row.id), true);
    assert.deepEqual(fx.readObject(repo, type.folder, "a.yaml"), { ...type.file, [type.edit[0]]: type.edit[1] });
  });
});

describe.each(TYPES.filter((t) => t.secret))("$key : its secret", (type) => {
  const repo = repoOf(type.key);
  const desc = () => RepoObjects.descriptorOf(type.key);

  test("a plain secret is refused, an ${ENV} one taken", async () => {
    fx.writeFile(repo, type.folder, "plain.yaml", { ...type.file, [type.secret]: "plain-text" });
    const summary = await RepoObjects.syncRepository(await desc(), repo);
    assert.match(summary.refused[0].reasons[0], new RegExp(`${type.secret} must be an \\$\\{ENV\\} reference`));
    fx.writeFile(repo, type.folder, "plain.yaml", { ...type.file, [type.secret]: "${HOOK_URL}" });
    assert.equal((await RepoObjects.syncRepository(await desc(), repo)).refused.length, 0);
  });
});

describe.each(TYPES.filter((t) => t.file.credential))("$key : its credential", (type) => {
  const repo = repoOf(type.key);
  const desc = () => RepoObjects.descriptorOf(type.key);

  test("its credential not there yet : it waits", async () => {
    fx.state.tables.credentials = [];
    fx.writeFile(repo, type.folder, "a.yaml", type.file);
    const summary = await RepoObjects.syncRepository(await desc(), repo);
    assert.equal(summary.created, 0);
    assert.match(summary.waiting[0].reasons[0], new RegExp(`waits for the credential '${type.file.credential}'`));
  });
});

describe("what the new types bring to the engine", () => {
  test("the main LDAP directory is never deleted : its file removed is refused, it stays linked", async () => {
    fx.writeFile(repoOf("ldap"), "ldap", "main.yaml", { name: "main", search_base: "dc=git" });
    const first = await RepoObjects.syncRepository(await RepoObjects.descriptorOf("ldap"), repoOf("ldap"));
    assert.deepEqual(first.matched, ["main"], "a file named main takes the main directory over");
    assert.equal(fx.rowNamed("ldap", "main").search_base, "dc=git");
    assert.equal(fx.rowNamed("ldap", "main").bind_user_pw, "enc:m", "its password kept from the database");
    fx.removeFile(repoOf("ldap"), "ldap", "main.yaml");
    const summary = await RepoObjects.syncRepository(await RepoObjects.descriptorOf("ldap"), repoOf("ldap"));
    assert.equal(summary.deleted, 0);
    assert.match(summary.refused[0].reasons[0], /the directory 'main' is never deleted \(turn it off instead\): kept, and still linked/);
    assert.equal(fx.rowNamed("ldap", "main").repository, repoOf("ldap"));
  });

  test("the labels keep their places : written in their order, a move rewrites the places in the files", async () => {
    fx.state.tables.labels.push(
      { id: 41, name: "Second", color: "blue", enabled: 1, position: 2 },
      { id: 40, name: "First", color: "red", enabled: 1, position: 1 },
    );
    const report = await RepoObjects.activate(await RepoObjects.descriptorOf("labels"), repoOf("labels"));
    assert.deepEqual(report.written, ["First", "Second"]);
    assert.equal(fx.readObject(repoOf("labels"), "labels", "first.yaml").position, 1);
    // moved in the app : the places swap, both files follow
    const before = fx.state.tables.labels.map((r) => ({ ...r }));
    fx.rowNamed("labels", "First").position = 2;
    fx.rowNamed("labels", "Second").position = 1;
    CrudModel.flushAllLocal();
    await RepoObjects.appChangedRows("labels", before);
    assert.equal(fx.readObject(repoOf("labels"), "labels", "first.yaml").position, 2);
    assert.equal(fx.readObject(repoOf("labels"), "labels", "second.yaml").position, 1);
    // and a pull of them changes nothing
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await RepoObjects.descriptorOf("labels"), repoOf("labels"))).unchanged, 2);
  });

  test("a credential any of them names cannot lose its file", async () => {
    fx.state.tables.credentials = [];
    fx.state.tables.repositories.push({ id: 99, name: "creds", use_for_credentials: 1 });
    fx.writeFile("creds", "credentials", "corp-bind.yaml", { name: "corp-bind", credential_type: "ldap", host: "ldap.corp" });
    const credentials = await RepoObjects.descriptorOf("credentials");
    await RepoObjects.syncRepository(credentials, "creds");
    fx.state.tables.ldap.push({ id: 5, name: "corp", credential: "corp-bind" });
    fx.removeFile("creds", "credentials", "corp-bind.yaml");
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.match(summary.refused[0].reasons[0], /LDAP directory 'corp' still uses 'corp-bind'/);
  });
});

describe("a value as the database gives it", () => {
  test("an SSO provider's extra, a JSON column read back parsed : written as its JSON text, the next pull unchanged", async () => {
    fx.state.tables.oauth2_providers.push({ id: 30, name: "google", provider: "oidc", issuer: "https://accounts.google.com", client_id: "id", client_secret: "enc:sec", enable: 1, extra: { prompt: "login" } });
    const desc = await RepoObjects.descriptorOf("sso");
    await RepoObjects.activate(desc, repoOf("sso"));
    assert.equal(fx.readObject(repoOf("sso"), "sso", "google.yaml").extra, '{"prompt":"login"}');
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(desc, repoOf("sso"));
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.unchanged, 1);
  });
});

describe("a yes or no whose default is on", () => {
  test("a webhook channel's certificate not checked : written off, a new app made from the file keeps it off", async () => {
    fx.state.tables.notification_channels.push({ id: 30, name: "hook", type: "webhook", url: "https://hook.example.com", method: "POST", verify_tls: 0, enabled: 1, description: "" });
    const desc = await RepoObjects.descriptorOf("notifications");
    await RepoObjects.activate(desc, repoOf("notifications"));
    assert.equal(fx.readObject(repoOf("notifications"), "notifications", "hook.yaml").verify_tls, false);
    // the same file pulled into an app without the channel (another instance, a database rebuilt)
    fx.state.tables.notification_channels = [];
    CrudModel.flushAllLocal();
    await RepoObjects.syncRepository(desc, repoOf("notifications"));
    assert.equal(Number(fx.rowNamed("notification_channels", "hook").verify_tls), 0);
  });
});

describe("a change in the app that changes other objects of the type too", () => {
  test("a runner made the default : the former default's file says so too", async () => {
    fx.state.tables.repositories.push({ id: 90, name: "run-repo", use_for_runners: 1 });
    const runner = (name, isDefault) => ({ name, type: "rte", uri: `https://${name}:8000`, token: "enc:t", is_default: isDefault, enabled: 1, description: "", repository: "run-repo", repo_file: `runners/${name}.yaml` });
    fx.state.tables.runners.push({ id: 51, ...runner("a", 1) }, { id: 52, ...runner("b", 0) });
    fx.writeFile("run-repo", "runners", "a.yaml", { name: "a", type: "rte", uri: "https://a:8000", is_default: true, enabled: true });
    fx.writeFile("run-repo", "runners", "b.yaml", { name: "b", type: "rte", uri: "https://b:8000", enabled: true });
    const { default: controller } = await import("../src/controllers/v2/runner.controller.js");
    const r = await asAdmin(controller.update, { body: { is_default: 1 }, params: { id: "52" } });
    assert.ok(r.status < 300, JSON.stringify(r.data));
    assert.equal(fx.readObject("run-repo", "runners", "b.yaml").is_default, true);
    assert.equal(fx.readObject("run-repo", "runners", "a.yaml").is_default, undefined, "a is no longer the default");
    // and the next pull changes nothing : the user's choice stays
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await RepoObjects.descriptorOf("runners"), "run-repo")).updated, 0);
    assert.equal(fx.rowNamed("runners", "b").is_default, 1);
  });

  test("an SSO provider enabled : the other provider of its type turned off in its file too", async () => {
    const provider = (id, name, enable) => ({ id, name, provider: "oidc", issuer: "https://idp", client_id: "id", client_secret: "enc:s", enable, managed: 0, repository: repoOf("sso"), repo_file: `sso/${name}.yaml` });
    fx.state.tables.oauth2_providers.push(provider(61, "one", 1), provider(62, "two", 0));
    fx.writeFile(repoOf("sso"), "sso", "one.yaml", { name: "one", provider: "oidc", issuer: "https://idp", client_id: "id", enable: true });
    fx.writeFile(repoOf("sso"), "sso", "two.yaml", { name: "two", provider: "oidc", issuer: "https://idp", client_id: "id", enable: false });
    const { default: controller } = await import("../src/controllers/v2/oauth2.controller.js");
    const r = await asAdmin(controller.update, { body: { provider: "oidc", enable: 1 }, params: { id: "62" } });
    assert.ok(r.status < 300, JSON.stringify(r.data));
    assert.equal(fx.readObject(repoOf("sso"), "sso", "two.yaml").enable, true);
    assert.equal(fx.readObject(repoOf("sso"), "sso", "one.yaml").enable, false, "one is turned off");
  });
});
