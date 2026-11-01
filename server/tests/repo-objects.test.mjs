// The repository-backed objects (lib/repoObjects) : the generic engine, and the Credentials and
// Runners types on it. Entries of the type's key (credentials:, runners:) in any YAML file of the
// repository, any name, any folder, in the config seed's format :
//   git to app   a pull creates, updates and deletes ; a bad file is refused alone ; a plain secret
//                is refused, an ${ENV} one resolved ; a runner whose credential is not there yet
//                waits, and is read when the credentials are next pulled ; a credential's entry
//                removed while a runner uses it is refused
//   activation   the app's objects written to git without their secrets, git winning on a name,
//                what the config seed manages kept in the app
//   app to git   an edit rewrites only its changed fields ; a new object is a new entry ; a delete
//                removes the entry
//   deactivation the objects unlinked, kept in the app, the files untouched
//   the rules    one repository per type, the fixed order
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const Engine = await import("../src/lib/repoObjects/engine.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const types = await import("../src/lib/repoObjects/types.js");
const credentials = await RepoObjects.descriptorOf("credentials");
const runners = await RepoObjects.descriptorOf("runners");

// ─── helpers ───────────────────────────────────────────────────────────────────
const repoRow = (id, name, flags = {}) => ({ id, name, uri: "https://git/x.git", ...flags });
const gitCredential = (name, extra = {}) => ({ name, credential_type: "git", user: "bot", password: "${GIT_PW}", ...extra });
const rteRunner = (name, extra = {}) => ({ name, type: "rte", rte_mode: "outbound", credential: "rte-cred", ...extra });
const rteCredential = { name: "rte-cred", credential_type: "rte", password: "${RTE_SECRET}" };

beforeEach(() => {
  process.env.GIT_PW = "s3cret";
  process.env.RTE_SECRET = "rte-token";
  delete process.env.MISSING_PW;
  fx.reset({
    repositories: [repoRow(1, "creds", { use_for_credentials: 1 }), repoRow(2, "ops", { use_for_runners: 1 }), repoRow(3, "other")],
  });
  CrudModel.flushAllLocal();
});

// ─── git to app ────────────────────────────────────────────────────────────────
describe("a pull reads the credentials entries", () => {
  test("new files make credentials, linked to their file, their ${ENV} secret resolved and encrypted", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.created, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.repository, "creds");
    assert.equal(row.repo_file, "credentials/git.yaml");
    assert.equal(row.password, "enc:s3cret");
    assert.equal(row.user, "bot");
  });

  test("a plain secret is refused, said with the file ; an unset variable too ; the others still sync", async () => {
    fx.writeEntry("creds", "credentials/a.yaml", "credentials", gitCredential("a"));
    fx.writeEntry("creds", "credentials/plain.yaml", "credentials", gitCredential("plain", { password: "hunter2" }));
    fx.writeEntry("creds", "credentials/unset.yaml", "credentials", gitCredential("unset", { password: "${MISSING_PW}" }));
    fx.writeEntry("creds", "credentials/key.yaml", "credentials", gitCredential("key", { client_key: "-----BEGIN KEY-----" }));
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.created, 1);
    assert.deepEqual(summary.refused.map((r) => r.file), ["credentials/key.yaml#key", "credentials/plain.yaml#plain", "credentials/unset.yaml#unset"]);
    assert.match(summary.refused[0].reasons[0], /client_key must be an \$\{ENV\} reference/);
    assert.match(summary.refused[1].reasons[0], /password must be an \$\{ENV\} reference: a secret is never written plain in git/);
    assert.match(summary.refused[2].reasons[0], /MISSING_PW/);
    assert.equal(fx.rowNamed("credentials", "plain"), undefined);
    assert.ok(RepoObjects.summaryText(credentials, summary).includes("Refused credentials/plain.yaml#plain:"));
  });

  test("a secret naming one of the server's own variables is refused, never read : its token secret, its database password", async () => {
    process.env.ACCESS_TOKEN_SECRET ||= "jwt-key";
    process.env.DB_PASSWORD ||= "db-pw";
    process.env.RTE_JOIN_TOKEN = "join";
    process.env.VAULT_TOKEN = "vault";
    fx.writeEntry("creds", "credentials/jwt.yaml", "credentials", gitCredential("jwt", { password: "${ACCESS_TOKEN_SECRET}" }));
    fx.writeEntry("creds", "credentials/db.yaml", "credentials", gitCredential("db", { password: "${DB_PASSWORD}", client_key: "${ENCRYPTION_SECRET}" }));
    fx.writeEntry("creds", "credentials/join.yaml", "credentials", gitCredential("join", { password: "${RTE_JOIN_TOKEN}" }));
    // a token an object is meant to carry : the Vault's
    fx.writeEntry("creds", "credentials/vault.yaml", "credentials", gitCredential("vault", { password: "${VAULT_TOKEN}" }));
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.deepEqual(summary.refused.map((r) => r.file), ["credentials/db.yaml#db", "credentials/join.yaml#join", "credentials/jwt.yaml#jwt"]);
    assert.match(summary.refused[0].reasons[0], /it references DB_PASSWORD, ENCRYPTION_SECRET, the server's own: a repository's object never reads them/);
    assert.match(summary.refused[2].reasons[0], /ACCESS_TOKEN_SECRET/);
    assert.equal(fx.rowNamed("credentials", "jwt"), undefined);
    assert.equal(fx.rowNamed("credentials", "vault").password, "enc:vault");
    delete process.env.RTE_JOIN_TOKEN;
    delete process.env.VAULT_TOKEN;
  });

  test("only the secret fields resolve their ${ENV} references : anywhere else a ${NAME} is plain text", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git", { description: "${GIT_PW}" }));
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).created, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.password, "enc:s3cret");
    assert.equal(row.description, "${GIT_PW}");
  });

  test("a key taken out of the file is taken out of the app : the value a new credential gets", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git", { description: "the bot", url: "https://git" }));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.updated, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.description, "");
    assert.equal(row.url ?? null, null);
    assert.equal(row.password, "enc:s3cret", "a secret the file still gives is kept");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).unchanged, 1, "then unchanged");
  });

  test("a file the seed's schema refuses, or the app's type rules, is refused alone", async () => {
    fx.writeEntry("creds", "credentials/typo.yaml", "credentials", { name: "typo", pasword: "x" });
    fx.writeEntry("creds", "credentials/smtp.yaml", "credentials", { name: "smtp", credential_type: "smtp" });
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.match(summary.refused.find((r) => r.file.endsWith("typo.yaml#typo")).reasons[0], /'pasword'/);
    assert.match(summary.refused.find((r) => r.file.endsWith("smtp.yaml#smtp")).reasons[0], /not saved: An smtp credential needs its mail server/);
  });

  test("a changed file updates its credential, an unchanged one changes nothing", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git", { description: "the bot" }));
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).updated, 1);
    assert.equal(fx.rowNamed("credentials", "git").description, "the bot");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).unchanged, 1);
  });

  test("a removed file removes its credential ; one a runner uses is refused, kept, the reason said", async () => {
    fx.writeEntry("creds", "credentials/a.yaml", "credentials", gitCredential("a"));
    fx.writeEntry("creds", "credentials/b.yaml", "credentials", gitCredential("b"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.state.tables.runners.push({ id: 50, name: "rte1", type: "rte", credential: "b" });
    fx.removeFile("creds", "credentials", "a.yaml");
    fx.removeFile("creds", "credentials", "b.yaml");
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.deleted, 1);
    assert.equal(fx.rowNamed("credentials", "a"), undefined);
    assert.equal(fx.rowNamed("credentials", "b").repository, "creds");
    assert.match(summary.refused[0].reasons[0], /its entry is gone, but runner 'rte1' still uses 'b'/);
  });

  test("a folder that cannot be read (no access) : the sync refused, said, nothing deleted", async () => {
    fx.writeEntry("creds", "credentials/a.yaml", "credentials", gitCredential("a"));
    await RepoObjects.syncRepository(credentials, "creds");
    const dir = path.join(fx.ROOT, "creds", "credentials");
    fs.chmodSync(dir, 0o000);
    let out;
    let preview;
    try {
      out = await RepoObjects.syncText(credentials, "creds");
      preview = await RepoObjects.preview(credentials, "creds");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.match(out, /Credentials not synchronized: the folder credentials cannot be read: EACCES/);
    assert.equal(fx.rowNamed("credentials", "a").repository, "creds");
    assert.match(JSON.stringify(preview.refused), /the folder cannot be read: EACCES/);
    // the folder gone : no entry, the credential goes
    fs.rmSync(dir, { recursive: true });
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).deleted, 1);
  });
});

describe("the value a new row gets, as information_schema says it", () => {
  test("a text unquoted, none, an expression as none, whether it may be empty", async () => {
    fx.state.columns.defaults_probe = [
      { name: "mode", value: "'outbound'", nullable: "NO" },
      { name: "note", value: "NULL", nullable: "YES" },
      { name: "since", value: "current_timestamp()", nullable: "NO" },
      { name: "enabled", value: "1", nullable: "NO", type: "tinyint" },
    ];
    const columns = await Engine.columnDefaults("AnsibleForms.`defaults_probe`");
    assert.deepEqual(Object.fromEntries(columns), {
      mode: { value: "outbound", nullable: false },
      note: { value: null, nullable: true },
      since: { value: null, nullable: false },
      enabled: { value: 1, nullable: false },
    });
  });
});

describe("an entry moved to another file in git", () => {
  test("its object follows it : the same row, its secret kept in the database, its new fields applied", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "bot", password: "enc:dbonly" });
    fx.cloneEmpty("creds");
    await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.equal(fx.rowNamed("credentials", "git").repo_file, "credentials.yaml");
    const entry = fx.readEntry("creds", "credentials.yaml", "credentials", "git");
    fx.removeFile("creds", ".", "credentials.yaml");
    fx.writeEntry("creds", "team/deep/git-bot.yml", "credentials", { ...entry, user: "robot" });
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.deleted, 0);
    assert.equal(summary.created, 0);
    assert.equal(summary.updated, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.id, 7);
    assert.equal(row.repo_file, "team/deep/git-bot.yml");
    assert.equal(row.password, "enc:dbonly");
    assert.equal(row.user, "robot");
  });

  test("moved only : its link follows, nothing else changes ; one a runner uses follows it too, never refused", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.state.tables.runners.push({ id: 50, name: "rte1", type: "rte", credential: "git" });
    fx.removeFile("creds", "credentials", "git.yaml");
    fx.writeEntry("creds", "all.yaml", "credentials", gitCredential("git"));
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.updated, 0);
    assert.equal(fx.rowNamed("credentials", "git").repo_file, "all.yaml");
  });
});

describe("a link in the repository that leads outside it", () => {
  test("a folder or a file a link : turning it on writes nothing outside, the credential written beside it, a pull keeps it", async () => {
    fx.state.tables.credentials.push({ id: 8, name: "smb", credential_type: "git", user: "u", password: "enc:pw" });
    fx.cloneEmpty("creds");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-"));
    fs.writeFileSync(path.join(outside, "x.yaml"), "kept: as it is\n");
    fs.symlinkSync(outside, path.join(fx.ROOT, "creds", "credentials"));
    fs.symlinkSync(path.join(outside, "x.yaml"), path.join(fx.ROOT, "creds", "credentials.yaml"));
    const report = await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.deepEqual(fs.readdirSync(outside), ["x.yaml"]);
    assert.equal(fs.readFileSync(path.join(outside, "x.yaml"), "utf8"), "kept: as it is\n");
    assert.deepEqual(report.written, ["smb"]);
    assert.equal(fx.rowNamed("credentials", "smb").repo_file, "credentials-2.yaml");
    CrudModel.flushAllLocal();
    await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(fx.rowNamed("credentials", "smb").password, "enc:pw");
  });

  test("a file that is a link leading outside : refused in the pull output and the preview, never read ; what it held kept", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    fx.writeEntry("creds", "credentials/planted.yaml", "credentials", gitCredential("planted"));
    await RepoObjects.syncRepository(credentials, "creds");
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-")), "x.yaml");
    fs.writeFileSync(outside, YAML.stringify({ controller_credentials: [gitCredential("planted", { user: "evil" }), gitCredential("other")] }));
    fx.removeFile("creds", "credentials", "planted.yaml");
    fs.symlinkSync(outside, path.join(fx.ROOT, "creds", "credentials", "planted.yaml"));
    fs.symlinkSync(path.dirname(outside), path.join(fx.ROOT, "creds", "linked"));
    const out = await RepoObjects.afterGit("creds", fx.state.tables.repositories[0]);
    assert.match(out, /Refused credentials\/planted\.yaml: a link that leads outside the repository: never read/);
    // never read : nothing of it taken, the credential it held kept as it was
    assert.equal(fx.rowNamed("credentials", "other"), undefined);
    assert.equal(fx.rowNamed("credentials", "planted").user, "bot");
    assert.equal(fx.rowNamed("credentials", "planted").repository, "creds");
    const preview = await RepoObjects.preview(credentials, "creds");
    assert.deepEqual(
      preview.refused.map((r) => [r.file, r.reasons[0]]),
      [["credentials/planted.yaml", "a link that leads outside the repository: never read"]],
    );
  });

  test("a linked object's file replaced by a link : its edit never written through it", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-")), "x.yaml");
    fs.writeFileSync(outside, "name: x\n");
    fx.removeFile("creds", "credentials", "git.yaml");
    fs.symlinkSync(outside, path.join(fx.ROOT, "creds", "credentials", "git.yaml"));
    fx.rowNamed("credentials", "git").user = "alice";
    CrudModel.flushAllLocal();
    assert.equal(await RepoObjects.appUpdated("credentials", before, before.id), null);
    assert.equal(fs.readFileSync(outside, "utf8"), "name: x\n");
  });
});

describe("a runner names its credential by name", () => {
  test("its credential not there yet : it waits, said ; a pull of the credentials reads it again", async () => {
    fx.writeEntry("ops", "runners/rte1.yaml", "runners", rteRunner("rte1", { rte_max_jobs: 4, enabled: false }));
    const summary = await RepoObjects.syncRepository(runners, "ops");
    assert.equal(summary.created, 0);
    assert.deepEqual(summary.waiting.map((w) => w.file), ["runners/rte1.yaml#rte1"]);
    assert.match(RepoObjects.summaryText(runners, summary), /Waiting runners\/rte1.yaml#rte1: waits for the credential 'rte-cred' \(credential\), not there yet/);
    // the credentials repository is pulled : the runners repository is read again, the runner made
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", rteCredential);
    fx.state.calls.length = 0;
    const out = await RepoObjects.afterGit("creds", fx.rowNamed("repositories", "creds"));
    assert.match(out, /Credentials: 1 created/);
    assert.match(out, /Runners of repository 'ops', read again: 1 created/);
    assert.deepEqual(fx.state.calls, ["claim:ops", "release:ops"]);
    const row = fx.rowNamed("runners", "rte1");
    assert.equal(row.repository, "ops");
    assert.equal(row.rte_max_jobs, 4);
    assert.equal(row.enabled, 0);
    assert.equal(row.credential, "rte-cred");
  });

  test("a runner's whole life : made, changed, its edit in the app written back, unlinked, deleted", async () => {
    fx.state.tables.credentials.push({ id: 1, name: "rte-cred", credential_type: "rte", password: "enc:t" });
    fx.writeEntry("ops", "runners/rte1.yaml", "runners", rteRunner("rte1", { description: "first" }));
    assert.equal((await RepoObjects.syncRepository(runners, "ops")).created, 1);
    fx.writeEntry("ops", "runners/rte1.yaml", "runners", rteRunner("rte1", { description: "second", rte_files: "local" }));
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(runners, "ops")).updated, 1);
    const row = fx.rowNamed("runners", "rte1");
    assert.equal(row.rte_files, "local");
    // turned off in the app : the file says enabled: false, nothing else rewritten
    const before = { ...row };
    row.enabled = 0;
    CrudModel.flushAllLocal();
    await RepoObjects.appUpdated("runners", before, row.id);
    assert.equal(fx.readEntry("ops", "runners/rte1.yaml", "runners")[0].enabled, false);
    assert.equal(fx.readEntry("ops", "runners/rte1.yaml", "runners")[0].description, "second");
    // a plain token is refused
    fx.writeEntry("ops", "runners/rte1.yaml", "runners", rteRunner("rte1", { token: "plain" }));
    assert.match((await RepoObjects.syncRepository(runners, "ops")).refused[0].reasons[0], /token must be an \$\{ENV\} reference/);
    // its file removed : the runner goes
    fx.removeFile("ops", "runners", "rte1.yaml");
    assert.equal((await RepoObjects.syncRepository(runners, "ops")).deleted, 1);
    assert.equal(fx.rowNamed("runners", "rte1"), undefined);
  });

  test("one repository holding both : the credentials are read first, the runner made at once", async () => {
    fx.state.tables.repositories[0].use_for_runners = 1;
    fx.state.tables.repositories[1].use_for_runners = 0;
    fx.writeEntry("creds", "runners/a.yaml", "runners", rteRunner("a"));
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", rteCredential);
    const out = await RepoObjects.afterGit("creds", fx.rowNamed("repositories", "creds"));
    assert.ok(out.indexOf("Credentials:") < out.indexOf("Runners:"));
    assert.match(out, /Runners: 1 created/);
  });

  test("at the worker's start the types are read in their fixed order", async () => {
    fx.writeEntry("ops", "runners/a.yaml", "runners", rteRunner("a"));
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", rteCredential);
    await RepoObjects.syncAll();
    assert.ok(fx.rowNamed("runners", "a"), "the runner found its credential");
    assert.deepEqual(fx.state.calls, ["claim:creds", "release:creds", "claim:ops", "release:ops"]);
    assert.deepEqual(types.APPLY_ORDER.slice(0, 5), ["credentials", "repositories", "secret_stores", "databases", "runners"]);
  });
});

// ─── activation and deactivation ───────────────────────────────────────────────
describe("made the credentials repository, it takes the app's credentials", () => {
  const appCredentials = () => {
    fx.state.tables.credentials.push(
      { id: 1, name: "api", credential_type: "api", user: "u", password: "enc:pw", description: "the api", is_database: 0, secure: 0 },
      { id: 2, name: "seeded", credential_type: "git", password: "enc:x", managed: 1 },
      { id: 3, name: "Clash", credential_type: "git", password: "enc:old", description: "app's" },
    );
    fx.writeEntry("creds", "credentials/clash.yaml", "credentials", { name: "Clash", credential_type: "git", description: "git's" });
  };

  test("the preview says what it would do, changing nothing", async () => {
    appCredentials();
    const before = JSON.stringify(fx.state.tables);
    const p = await RepoObjects.preview(credentials, "creds");
    assert.deepEqual(p.written, ["api"]);
    assert.deepEqual(p.withoutSecret, ["api"]);
    assert.deepEqual(p.clashes, ["Clash"]);
    assert.deepEqual(p.kept, [{ name: "seeded", reason: "managed by the config seed", code: "seed" }]);
    assert.equal(p.files, 1);
    // written to the first file holding credentials:
    assert.equal(p.file, "credentials/clash.yaml");
    assert.equal(JSON.stringify(fx.state.tables), before);
  });

  test("activation : pulled, git wins on a name keeping the secret, the others written without their secrets", async () => {
    appCredentials();
    const report = await RepoObjects.activate(credentials, "creds");
    assert.equal(report.pull, "pulled");
    assert.deepEqual(report.matched, ["Clash"]);
    assert.deepEqual(report.written, ["api"]);
    assert.deepEqual(report.withoutSecret, ["api"]);
    const clash = fx.rowNamed("credentials", "Clash");
    assert.equal(clash.description, "git's");
    assert.equal(clash.password, "enc:old", "its secret kept from the database");
    // appended to the first file holding credentials:, after the entry there
    const file = fx.readEntry("creds", "credentials/clash.yaml", "credentials");
    assert.deepEqual(file.map((e) => e.name), ["Clash", "api"]);
    assert.deepEqual(file[1], { name: "api", description: "the api", user: "u", credential_type: "api" });
    assert.equal(fx.rowNamed("credentials", "api").repo_file, "credentials/clash.yaml");
    assert.equal(fx.rowNamed("credentials", "seeded").repository, undefined);
    // and the next pull finds nothing to change
    CrudModel.flushAllLocal();
    const again = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(again.unchanged, 2);
    assert.deepEqual(again.secretsKept.sort(), ["Clash", "api"]);
    assert.match(RepoObjects.summaryText(credentials, again), /Not in git, their secrets kept from the database: /);
  });

  test("deactivation : pulled once more, unlinked, kept in the app, the files untouched", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const text = fx.readText("creds", "credentials", "git.yaml");
    const report = await RepoObjects.deactivate(credentials, "creds");
    assert.equal(report.unlinked, 1);
    assert.equal(fx.rowNamed("credentials", "git").repository, null);
    assert.equal(fx.rowNamed("credentials", "git").password, "enc:s3cret");
    assert.equal(fx.readText("creds", "credentials", "git.yaml"), text);
    assert.ok(fx.state.calls.includes("pull:creds"));
  });

  test("runners its RTE registered, or waiting for approval, stay in the app", async () => {
    fx.state.tables.runners.push(
      { id: 1, name: "joined", type: "rte", node_id: "n1" },
      { id: 2, name: "asking", type: "rte", pending: 1 },
    );
    const p = await RepoObjects.preview(runners, "ops");
    assert.deepEqual(p.kept.map((k) => k.reason), ["waiting for approval", "registered by its RTE"]);
  });
});

// ─── app to git ────────────────────────────────────────────────────────────────
describe("a save while the repository is busy", () => {
  const { CLAIM_WAIT } = Engine;
  const wait = { ...CLAIM_WAIT };
  afterEach(() => Object.assign(CLAIM_WAIT, wait));

  test("waits for the claim, taken before the save, then saves and writes the file under it", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 2000, everyMs: 1 });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    fx.state.busy.creds = 2;
    fx.state.calls.length = 0;
    await RepoObjects.holding([], async () => {
      fx.state.calls.push("save");
      fx.rowNamed("credentials", "git").user = "alice";
      CrudModel.flushAllLocal();
      await RepoObjects.appUpdated("credentials", before, before.id);
    }, before);
    assert.deepEqual(fx.state.calls, ["busy:creds", "busy:creds", "claim:creds", "save", "release:creds"]);
    assert.equal(fx.readEntry("creds", "credentials/git.yaml", "credentials")[0].user, "alice");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).unchanged, 1, "the next pull keeps the edit");
  });

  test("still busy once the wait is over : refused with a conflict, nothing saved", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 20, everyMs: 1 });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    fx.state.busy.creds = Infinity;
    let saved = false;
    await assert.rejects(
      RepoObjects.holding([], async () => {
        saved = true;
      }, before),
      (e) => e.name === "ConflictError" && /Repository 'creds' is busy .*nothing was saved/.test(e.message),
    );
    assert.equal(saved, false);
  });

  test("turning the usage on reads and writes under the claim, a busy repository waited for", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 2000, everyMs: 1 });
    fx.state.tables.credentials.push({ id: 7, name: "app", credential_type: "git", user: "u", password: "enc:p" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    fx.state.busy.creds = 2;
    fx.state.calls.length = 0;
    const report = await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.deepEqual(fx.state.calls, ["busy:creds", "busy:creds", "claim:creds", "release:creds"]);
    assert.equal(report.created, 1);
    assert.deepEqual(report.written, ["app"]);
  });

  test("turning the usage on while it stays busy : nothing read in nor written, the error in the report", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 20, everyMs: 1 });
    fx.state.tables.credentials.push({ id: 7, name: "app", credential_type: "git", user: "u", password: "enc:p" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    fx.state.busy.creds = Infinity;
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 }, { pull: false });
    assert.match(report.credentials.error, /Repository 'creds' is busy/);
    assert.equal(fx.rowNamed("credentials", "git"), undefined);
    assert.equal(fx.rowNamed("credentials", "app").repository ?? null, null);
  });

  test("a file write outside a save, still busy : said to the caller, never a silent success", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 20, everyMs: 1 });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    fx.state.busy.creds = Infinity;
    await assert.rejects(RepoObjects.appUpdated("credentials", before, before.id), { name: "ConflictError" });
  });
});

describe("an edit in the app goes to the file", () => {
  test("only the changed fields are written : the ${ENV} reference, the comments and the unknown order kept", async () => {
    // its entry among others, the file holding another key the app does not read
    const original = `# the bot's\ncontroller_credentials:\n  - name: git # ours\n    password: \${GIT_PW}\n    credential_type: git\n    user: bot\n  # the other one\n  - name: other\n    credential_type: git\nnotes: kept\n`;
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", original);
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    Object.assign(fx.rowNamed("credentials", "git"), { description: "edited", password: "enc:typed-in-app" });
    CrudModel.flushAllLocal();
    assert.equal(await RepoObjects.appUpdated("credentials", before, before.id), true);
    const text = fx.readText("creds", "credentials", "git.yaml");
    assert.equal(text, original.replace("  - name: git # ours\n", "  - name: git # ours\n    description: edited\n"));
    assert.ok(!text.includes("typed-in-app"));
  });

  test("a new credential is a new entry of credentials.yaml, made, without its secret ; a delete removes it, and the file it empties", async () => {
    fx.cloneEmpty("creds");
    fx.state.tables.credentials.push({ id: 7, name: "New One", credential_type: "userpass", user: "me", password: "enc:pw" });
    const made = await RepoObjects.appCreated("credentials", 7);
    assert.deepEqual(made, { repository: "creds", file: "credentials.yaml", withoutSecret: true });
    assert.deepEqual(fx.readEntry("creds", "credentials.yaml", "credentials", "New One"), { name: "New One", user: "me", credential_type: "userpass" });
    assert.equal(await RepoObjects.appDeleted("credentials", fx.rowNamed("credentials", "New One")), true);
    assert.equal(fx.exists("creds", "credentials.yaml"), false);
  });

  test("a new object goes to the first file holding its key, whatever its name ; else to <key>.yaml, never over a file of that name that is not its", async () => {
    // credentials.yaml there, holding no credentials (a form) : never written to
    fx.writeFile("creds", ".", "credentials.yaml", { name: "a form", type: "ansible", playbook: "x.yml", roles: ["public"] });
    fx.state.tables.credentials.push({ id: 7, name: "first", credential_type: "userpass", user: "me", password: "enc:pw" });
    assert.equal((await RepoObjects.appCreated("credentials", 7)).file, "credentials-2.yaml");
    assert.equal(fx.readObject("creds", ".", "credentials.yaml").name, "a form");
    // a file holding the key : the first by path, at any depth
    fx.writeEntry("creds", "z/later.yaml", "credentials", gitCredential("z"));
    fx.writeEntry("creds", "a/deep/b.yml", "credentials", gitCredential("b"));
    fx.removeFile("creds", ".", "credentials-2.yaml");
    fx.rowNamed("credentials", "first").repository = null;
    fx.state.tables.credentials.push({ id: 8, name: "second", credential_type: "userpass", user: "me", password: "enc:pw" });
    assert.equal((await RepoObjects.appCreated("credentials", 8)).file, "a/deep/b.yml");
    assert.deepEqual(fx.readEntry("creds", "a/deep/b.yml", "credentials").map((e) => e.name), ["b", "second"]);
  });

  test("deleting the last entry of a key : the key goes, the file stays with its other keys", async () => {
    fx.writeFile("creds", ".", "mixed.yaml", `labels:\n  - name: kept\ncontroller_credentials:\n  - name: git\n    credential_type: git\n`);
    await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(await RepoObjects.appDeleted("credentials", fx.rowNamed("credentials", "git")), true);
    assert.equal(fx.textOf("creds", "mixed.yaml"), "labels:\n  - name: kept\n");
  });

  test("no repository for the type : nothing is written", async () => {
    fx.state.tables.repositories[1].use_for_runners = 0;
    fx.state.tables.runners.push({ id: 9, name: "r", type: "rte" });
    assert.equal(await RepoObjects.appCreated("runners", 9), null);
  });
});

// ─── the rules ─────────────────────────────────────────────────────────────────
describe("the rules of the usages", () => {
  test("one repository per object type : a second one is refused, naming the one in use", async () => {
    await assert.rejects(RepoObjects.assertUsageAllowed({ use_for_credentials: 1 }, "other", {}), /Repository 'creds' is already used for credentials/);
    await RepoObjects.assertUsageAllowed({ use_for_credentials: 1 }, "creds", { use_for_credentials: 1 });
    // forms, workflows and inventories : several repositories, as before
    await RepoObjects.assertUsageAllowed({ use_for_forms: 1, use_for_workflows: 1, use_for_inventories: 1 }, "other", {});
  });

  test("the types and their descriptors agree : what a runner names, every category, every flag once", () => {
    assert.deepEqual(runners.references.map((r) => r.type), types.typeOf("runners").references);
    assert.equal(new Set(types.USAGE_FLAGS).size, 28);
    // Appearance : one type per menu item, in the menu's order (Defaults, Logo, Icon, Name, Links ...)
    assert.deepEqual(types.USAGE_TYPES.filter((t) => t.category === "appearance").map((t) => t.key), ["defaults", "logo", "icon", "name", "links", "labels", "announcements"]);
    for (const key of ["defaults", "logo", "icon", "name"]) assert.equal(types.typeOf(key).oneOnly, true, key);
    for (const t of types.USAGE_TYPES) assert.ok(types.CATEGORIES.includes(t.category), t.key);
    // every object type has its descriptor : none is of a later version
    assert.deepEqual(
      [...RepoObjects.BUILT_OBJECT_TYPES].sort(),
      types.USAGE_TYPES.filter((t) => t.objects).map((t) => t.key).sort(),
    );
    for (const t of types.USAGE_TYPES) assert.equal(t.built, undefined, t.key);
  });

  test("turning several usages on at once : in the fixed order, the repository pulled once", async () => {
    fx.writeEntry("other", "credentials/rte.yaml", "credentials", rteCredential);
    fx.writeEntry("other", "runners/a.yaml", "runners", rteRunner("a"));
    const report = {};
    await RepoObjects.afterUsageChange({}, "other", { use_for_credentials: 1, use_for_runners: 1 }, { report });
    assert.deepEqual(Object.keys(report), ["credentials", "runners"]);
    assert.equal(report.credentials.activated.pull, "pulled");
    assert.equal(report.runners.activated.pull, "pulled");
    assert.deepEqual(fx.state.calls.filter((c) => c.startsWith("pull")), ["pull:other"]);
    assert.equal(fx.rowNamed("runners", "a").repository, "other");
  });

  test("what turning them on did reads as lines for the pull output, a failure and a repository not cloned too", async () => {
    fx.writeEntry("other", "credentials/rte.yaml", "credentials", rteCredential);
    fx.state.tables.credentials.push({ id: 1, name: "api", credential_type: "api", password: "enc:pw" });
    const report = {};
    await RepoObjects.afterUsageChange({}, "other", { use_for_credentials: 1 }, { report });
    const text = await RepoObjects.usageReportText(report);
    assert.match(text, /^\nNow holds the credentials: 1 read from its files, 0 replaced by an entry of the same name, 1 written to credentials\/rte\.yaml \(waiting for Push, 1 without their secrets/);
    assert.equal(
      await RepoObjects.usageReportText({ runners: { error: "disk full" }, credentials: { activated: { pull: "not cloned" } } }),
      "\nNot cloned: the credentials will be taken once it is\nRunners could not follow the usage: disk full",
    );
    assert.equal(await RepoObjects.usageReportText({}), "");
  });

  test("the lines its pull said already are not said again after it : each refusal and note once", async () => {
    fx.writeEntry("other", "credentials/rte.yaml", "credentials", rteCredential);
    fx.writeEntry("other", "credentials/bad.yaml", "credentials", { name: "bad", credential_type: "git", password: "plain" });
    // the pull of the usage just turned on reads the files in (afterGit), its lines in its output
    const pulled = await Engine.syncText(credentials, "other");
    assert.match(pulled, /\nRefused credentials\/bad\.yaml#bad: /);
    const report = {};
    await RepoObjects.afterUsageChange({}, "other", { use_for_credentials: 1 }, { report, pull: false });
    const output = pulled + (await RepoObjects.usageReportText(report));
    assert.equal(output.match(/Refused credentials\/bad\.yaml#bad/g).length, 1, output);
    assert.match(output, /\nNow holds the credentials: /);
    // no pull before it (its lines never said) : the activation says them
    fx.writeEntry("other", "credentials/bad.yaml", "credentials", { name: "bad", credential_type: "git", password: "plainer" });
    const again = {};
    await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 }, { report: again, pull: false });
    assert.match(await RepoObjects.usageReportText(again), /\nRefused credentials\/bad\.yaml#bad: /);
  });
});

describe("an edit or a delete read before a pull that moved its entry", () => {
  // the controller reads the credential, then waits for the claim a pull holds ; the pull moves its
  // entry from git.yaml to github.yaml in git, the credential following it
  async function renamedMeanwhile() {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    fx.removeFile("creds", "credentials", "git.yaml");
    fx.writeEntry("creds", "credentials/github.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    return before;
  }

  test("the edit goes to the file it follows now, its old file never written back", async () => {
    const before = await renamedMeanwhile();
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.repo_file, "credentials/github.yaml");
    row.description = "edited";
    CrudModel.flushAllLocal();
    assert.equal(await RepoObjects.appUpdated("credentials", before, row.id), true);
    assert.deepEqual(fx.listFiles("creds", "credentials"), ["github.yaml"]);
    assert.equal(fx.readEntry("creds", "credentials/github.yaml", "credentials")[0].description, "edited");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).refused.length, 0);
  });

  test("the delete removes the entry where it is now : the next pull does not make it again", async () => {
    const before = await renamedMeanwhile();
    fx.state.tables.credentials = fx.state.tables.credentials.filter((r) => r.id !== before.id);
    assert.equal(await RepoObjects.appDeleted("credentials", before), true);
    assert.deepEqual(fx.listFiles("creds", "credentials"), []);
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).created, 0);
  });
});

describe("a file that renames its credential", () => {
  test("refused while something uses it by its name, said ; taken once nothing does", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.state.tables.runners.push({ id: 50, name: "rte1", type: "rte", credential: "git" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git-bot"));
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.updated, 0);
    assert.match(summary.refused[0].reasons[0], /it renames 'git' to 'git-bot', but runner 'rte1' still uses 'git': kept as it was until nothing uses it/);
    assert.ok(fx.rowNamed("credentials", "git"));
    assert.match(RepoObjects.summaryText(credentials, summary), /Refused credentials\/git\.yaml#git-bot: it renames 'git'/);
    // nothing uses it any more : the rename is taken
    fx.state.tables.runners = [];
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).updated, 1);
    assert.ok(fx.rowNamed("credentials", "git-bot"));
  });

  test("renamed in one commit with the runner that names it : taken, the runner following it in the same pull", async () => {
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", { ...rteCredential });
    fx.writeEntry("ops", "runners/edge.yaml", "runners", rteRunner("edge"));
    await RepoObjects.afterGit("creds", fx.rowNamed("repositories", "creds"));
    await RepoObjects.afterGit("ops", fx.rowNamed("repositories", "ops"));
    assert.equal(fx.rowNamed("runners", "edge").credential, "rte-cred");
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", { ...rteCredential, name: "rte-cred-v2" });
    fx.writeEntry("ops", "runners/edge.yaml", "runners", rteRunner("edge", { credential: "rte-cred-v2" }));
    CrudModel.flushAllLocal();
    const out = await RepoObjects.afterGit("creds", fx.rowNamed("repositories", "creds"));
    assert.doesNotMatch(out, /Refused/);
    assert.ok(fx.rowNamed("credentials", "rte-cred-v2"));
    assert.equal(fx.rowNamed("runners", "edge").credential, "rte-cred-v2");
  });

  test("a user whose file still names the old name : refused, the pull output says what to do", async () => {
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", { ...rteCredential });
    fx.writeEntry("ops", "runners/edge.yaml", "runners", rteRunner("edge"));
    await RepoObjects.afterGit("creds", fx.rowNamed("repositories", "creds"));
    await RepoObjects.afterGit("ops", fx.rowNamed("repositories", "ops"));
    fx.writeEntry("creds", "credentials/rte.yaml", "credentials", { ...rteCredential, name: "rte-cred-v2" });
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.match(summary.refused[0].reasons[0], /still uses 'rte-cred': kept as it was until nothing uses it - name 'rte-cred-v2' in the entries of what uses it in the same commit/);
    assert.equal(fx.rowNamed("runners", "edge").credential, "rte-cred");
  });
});

describe("a name two entries give", () => {
  test("in two files : both refused, naming each other ; the object of that name kept as it was, never a database duplicate", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.writeEntry("creds", "credentials/a-dup.yaml", "credentials", gitCredential("git", { description: "the copy" }));
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git", { description: "changed" }));
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.deepEqual(summary.refused.map((r) => r.file), ["credentials/a-dup.yaml#git", "credentials/git.yaml#git"]);
    assert.match(summary.refused[0].reasons[0], /^the name 'git' is given twice: here \(credentials\/a-dup\.yaml, entry 1\) and in credentials\/git\.yaml \(entry 1\)/);
    assert.match(summary.refused[1].reasons[0], /and in credentials\/a-dup\.yaml \(entry 1\)/);
    assert.equal(summary.updated + summary.created + summary.deleted, 0);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.repo_file, "credentials/git.yaml");
    assert.equal(row.description ?? "", "");
    assert.equal(fx.state.tables.credentials.length, 1);
  });

  test("in one file : both refused ; a new name given twice makes nothing", async () => {
    fx.writeEntry("creds", "all.yaml", "credentials", [gitCredential("x"), gitCredential("ok"), gitCredential("X", { description: "again" })]);
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.deepEqual(summary.refused.map((r) => r.file), ["all.yaml#x", "all.yaml#X"]);
    assert.match(summary.refused[0].reasons[0], /given twice: here \(all\.yaml, entry 1\) and in all\.yaml \(entry 3\)/);
    assert.equal(summary.created, 1);
    assert.equal(fx.rowNamed("credentials", "x"), undefined);
  });
});

describe("a pull goes on past what fails", () => {
  test("a credential its file removed that cannot be removed : said, the other files still applied", async () => {
    fx.writeEntry("creds", "credentials/a.yaml", "credentials", gitCredential("a"));
    fx.writeEntry("creds", "credentials/b.yaml", "credentials", gitCredential("b"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.removeFile("creds", "credentials", "a.yaml");
    fx.writeEntry("creds", "credentials/b.yaml", "credentials", gitCredential("b", { description: "changed" }));
    fx.writeEntry("creds", "credentials/c.yaml", "credentials", gitCredential("c"));
    CrudModel.flushAllLocal();
    fx.state.failing = /^DELETE FROM/;
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.match(summary.refused[0].reasons[0], /its entry is gone, but 'a' could not be removed: Lock wait timeout exceeded/);
    assert.equal(fx.rowNamed("credentials", "a").repository, "creds");
    assert.equal(fx.rowNamed("credentials", "b").description, "changed");
    assert.ok(fx.rowNamed("credentials", "c"));
  });

  test("a moved entry its credential cannot follow : refused, the credential kept on its old file", async () => {
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    fx.writeEntry("creds", "credentials/b.yaml", "credentials", gitCredential("b"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.removeFile("creds", "credentials", "git.yaml");
    fx.writeEntry("creds", "credentials/github.yaml", "credentials", gitCredential("git"));
    fx.writeEntry("creds", "credentials/b.yaml", "credentials", gitCredential("b", { description: "changed" }));
    CrudModel.flushAllLocal();
    fx.state.failing = /^UPDATE \S+ SET repository = \?, repo_file = \?/;
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    fx.state.failing = null;
    assert.deepEqual(summary.refused.map((r) => r.file), ["credentials/github.yaml#git"]);
    assert.equal(summary.deleted, 0);
    assert.equal(fx.rowNamed("credentials", "git").repo_file, "credentials/git.yaml");
    assert.equal(fx.rowNamed("credentials", "b").description, "changed");
  });

  test("a file of too many aliases (an alias bomb) is refused alone, the others still read", async () => {
    fx.writeEntry("creds", "credentials/good.yaml", "credentials", gitCredential("good"));
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (const [i, n] of ["b", "c", "d", "e", "f", "g"].entries()) lines.push(`${n}: &${n} [${Array(10).fill(`*${"abcdef"[i]}`).join(", ")}]`);
    fs.mkdirSync(path.join(fx.ROOT, "creds", "credentials"), { recursive: true });
    fs.writeFileSync(path.join(fx.ROOT, "creds", "credentials", "bomb.yaml"), [...lines, "controller_credentials:", "  - name: bomb", "    credential_type: git", ""].join("\n"));
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.created, 1);
    assert.ok(fx.rowNamed("credentials", "good"));
    assert.equal(summary.refused[0].file, "credentials/bomb.yaml");
    assert.match(summary.refused[0].reasons[0], /^not valid YAML: Excessive alias count/);
  });
});

describe("a repository not cloned when it is made the credentials repository", () => {
  test("its clone failed : said not cloned, never 'now holds' ; its first clone then takes the app's credentials", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "app-cred", credential_type: "git", user: "u", password: "enc:pw" });
    fx.state.cloneFails = true;
    // the flag saved first, as Repository.update saves it
    fx.rowNamed("repositories", "other").use_for_credentials = 1;
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 });
    assert.equal(report.credentials.activated.pull, "not cloned");
    assert.equal(await RepoObjects.usageReportText(report), "\nNot cloned: the credentials will be taken once it is");
    assert.equal(fx.rowNamed("credentials", "app-cred").repository ?? null, null);
    // its first clone (Repository.clone, the claim held) : the app's credential written and linked
    fx.cloneEmpty("other");
    const text = await RepoObjects.afterGit("other", { name: "other", use_for_credentials: 1 }, { activate: true });
    assert.match(text, /^\nNow holds the credentials: 0 read from its files, 0 replaced by an entry of the same name, 1 written to credentials\.yaml/);
    assert.equal(fx.rowNamed("credentials", "app-cred").repo_file, "credentials.yaml");
    assert.ok(fx.readEntry("other", "credentials.yaml", "credentials", "app-cred"));
    // under the clone's claim : never waited for nor taken again
    assert.deepEqual(fx.state.calls.filter((c) => /^(claim|busy):other/.test(c)), []);
  });
});

describe("what turning the usage on did, the repository read in by its pull first", () => {
  test("says what that pull took : git's version replacing the app's, the files read in, the files gone", async () => {
    fx.state.tables.credentials.push(
      { id: 7, name: "git", credential_type: "git", user: "app", password: "enc:pw" },
      { id: 8, name: "old", credential_type: "git", user: "u", password: "enc:x", repository: "creds", repo_file: "credentials/old.yaml" },
    );
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    fx.writeEntry("creds", "credentials/new.yaml", "credentials", gitCredential("new"));
    // its clone (or pull) reads the files in, then the usage follows, not pulled again
    await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 });
    CrudModel.flushAllLocal();
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 }, { pull: false });
    assert.deepEqual(report.credentials.activated.matched, ["git"]);
    assert.equal(report.credentials.activated.created, 1);
    assert.match(await RepoObjects.usageReportText(report), /^\nNow holds the credentials: 1 read from its files, 1 replaced by an entry of the same name, 1 removed \(their entries gone\), 0 written to it/);
    // said once : the next activation's report is its own
    fx.rowNamed("repositories", "creds").use_for_credentials = 0;
    await RepoObjects.afterUsageChange({ use_for_credentials: 1 }, "creds", { use_for_credentials: 0 }, { pull: false });
    fx.rowNamed("repositories", "creds").use_for_credentials = 1;
    CrudModel.flushAllLocal();
    const again = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 }, { pull: false });
    assert.deepEqual(again.credentials.activated.matched, ["git", "new"]);
    assert.equal(again.credentials.activated.created, 0);
  });
});

describe("turning the usage on beside an entry of the same name it refuses", () => {
  test("the app's object stays in the app, said, never written as a second file of its name ; the question says the clash", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "app", password: "enc:pw" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git", { password: "plain" }));
    const p = await RepoObjects.preview(credentials, "creds");
    assert.deepEqual(p.clashes, ["git"]);
    assert.deepEqual(p.written, []);
    const report = await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.deepEqual(report.written, []);
    assert.deepEqual(report.kept.map((k) => k.name), ["git"]);
    assert.match(report.kept[0].reason, /^creds\/credentials\/git\.yaml#git has its name but is not read in \(refused or waiting\): it follows that entry once it is$/);
    assert.deepEqual(fx.listFiles("creds", "credentials"), ["git.yaml"]);
    assert.equal(fx.rowNamed("credentials", "git").repository ?? null, null);
    // the file fixed : the next pull takes the app's object over, git winning
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    CrudModel.flushAllLocal();
    assert.deepEqual((await RepoObjects.syncRepository(credentials, "creds")).matched, ["git"]);
  });

  test("a file waiting for what it names counts as well", async () => {
    fx.state.tables.runners.push({ id: 7, name: "rte1", type: "rte", rte_mode: "outbound", credential: "", enabled: 1 });
    fx.writeEntry("ops", "runners/rte1.yaml", "runners", rteRunner("rte1", { credential: "missing-cred" }));
    const report = await RepoObjects.activate(runners, "ops", { pull: false });
    assert.equal(report.waiting.length, 1);
    assert.deepEqual(report.written, []);
    assert.deepEqual(fx.listFiles("ops", "runners"), ["rte1.yaml"]);
  });

  test("a file of its name that cannot take it over (its model refuses the change) : kept in the app, never a second file", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "rte-cred", credential_type: "rte", password: "enc:x", repository: null, repo_file: null });
    // the app's runner a Semaphore one, git's file of the same name an RTE
    fx.state.tables.runners.push({ id: 50, name: "edge", type: "semaphore", uri: "https://semaphore", token: "enc:t", enabled: 1, is_default: 1, description: "", repository: null, repo_file: null });
    fx.writeEntry("ops", "runners/edge.yaml", "runners", rteRunner("edge"));
    const report = await RepoObjects.activate(runners, "ops", { pull: false });
    assert.equal(report.refused.length, 1, JSON.stringify(report));
    assert.deepEqual(report.written, []);
    assert.match(report.kept.find((k) => k.name === "edge").reason, /^ops\/runners\/edge\.yaml#edge has its name but is not read in/);
    assert.deepEqual(fx.listFiles("ops", "runners"), ["edge.yaml"]);
  });

  test("an object made in the app with the name a refused file declares : kept in the app, said, never a second file", async () => {
    fx.writeEntry("creds", "credentials/db.yaml", "credentials", gitCredential("db", { password: "plain" }));
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).refused.length, 1);
    fx.state.tables.credentials.push({ id: 60, name: "db", credential_type: "git", user: "u", password: "enc:p", repository: null, repo_file: null });
    assert.equal(await RepoObjects.appCreated("credentials", 60), null);
    assert.deepEqual(fx.listFiles("creds", "credentials"), ["db.yaml"]);
    assert.equal(fx.rowNamed("credentials", "db").repository ?? null, null);
    // git's file fixed : it takes the app's object over
    fx.writeEntry("creds", "credentials/db.yaml", "credentials", gitCredential("db"));
    CrudModel.flushAllLocal();
    const next = await RepoObjects.syncRepository(credentials, "creds");
    assert.deepEqual(next.refused, []);
    assert.deepEqual(next.matched, ["db"]);
  });
});

describe("a usage turned off while a pull of the repository runs", () => {
  test("the pull's sync, its row read before, never takes back the objects let go meanwhile ; why they were not read in is said", async () => {
    fx.writeEntry("creds", "credentials/a.yaml", "credentials", gitCredential("a"));
    await RepoObjects.syncRepository(credentials, "creds");
    // the flag saved off while a long pull holds the claim : the deactivation waits, then lets go
    const wait = { ...Engine.CLAIM_WAIT };
    Object.assign(Engine.CLAIM_WAIT, { totalMs: 30, everyMs: 10 });
    try {
      fx.rowNamed("repositories", "creds").use_for_credentials = 0;
      fx.state.busy.creds = Infinity;
      const report = await RepoObjects.afterUsageChange({ use_for_credentials: 1 }, "creds", { use_for_credentials: 0 }, { pull: false });
      assert.match(await RepoObjects.usageReportText(report), /No longer holds the credentials: 1 unlinked, kept in the app \(not read in: .*busy.*: they stay as the last pull left them\)/);
    } finally {
      Object.assign(Engine.CLAIM_WAIT, wait);
      fx.state.busy = {};
    }
    // the pull read its row with the flag on, before the change ; git done, it reads its files in
    CrudModel.flushAllLocal();
    await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 });
    assert.equal(fx.rowNamed("credentials", "a").repository, null);
  });
});

describe("a reset clones the repository again from its remote", () => {
  test("a credential whose file was never pushed is kept in the app, unlinked, its secret with it", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "app-cred", credential_type: "git", user: "u", password: "enc:pw" });
    fx.cloneEmpty("creds");
    await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.equal(fx.rowNamed("credentials", "app-cred").repository, "creds");
    assert.equal(fx.rowNamed("credentials", "app-cred").repo_file, "credentials.yaml");
    // the reset : the working tree as the (empty) remote has it
    fs.rmSync(path.join(fx.ROOT, "creds"), { recursive: true, force: true });
    fx.cloneEmpty("creds");
    CrudModel.flushAllLocal();
    const text = await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 }, { reset: true });
    assert.match(text, /0 deleted/);
    assert.match(text, /credentials\.yaml#app-cred: not in the repository as cloned again \(never pushed\?\): 'app-cred' kept in the app, no longer linked to it/);
    const row = fx.rowNamed("credentials", "app-cred");
    assert.equal(row.repository, null);
    assert.equal(row.password, "enc:pw");
  });

  test("a first clone where the working tree was gone : a credential never pushed kept in the app, unlinked", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "app-cred", credential_type: "git", user: "u", password: "enc:pw" });
    fx.cloneEmpty("creds");
    await RepoObjects.activate(credentials, "creds", { pull: false });
    // the tree gone (a reset whose clone failed, a volume lost), then cloned again : a first clone
    fs.rmSync(path.join(fx.ROOT, "creds"), { recursive: true, force: true });
    fx.cloneEmpty("creds");
    CrudModel.flushAllLocal();
    const text = await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 }, { activate: true, reset: true });
    assert.match(text, /^\nNow holds the credentials/);
    const row = fx.rowNamed("credentials", "app-cred");
    assert.equal(row?.password, "enc:pw");
  });

  test("a plain pull still removes a credential whose file is gone", async () => {
    fx.writeEntry("creds", "credentials/a.yaml", "credentials", gitCredential("a"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.removeFile("creds", "credentials", "a.yaml");
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).deleted, 1);
  });
});

describe("a fresh clone that turns the usage on, where an entry was deleted in git", () => {
  test("its object is unlinked and kept in the app, never written back to the repository by that activation", async () => {
    // 'old' lives in git, linked ; someone deletes credentials/old.yaml in git and pushes
    fx.writeEntry("creds", "credentials/old.yaml", "credentials", gitCredential("old"));
    await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(fx.rowNamed("credentials", "old").repository, "creds");
    // an object the app holds that was never in the repository : that one moves
    fx.state.tables.credentials.push({ id: 7, name: "app-cred", credential_type: "git", user: "u", password: "enc:pw" });
    // the tree gone (a reset whose clone failed) ; the Pull button clones it fresh, without old.yaml
    fs.rmSync(path.join(fx.ROOT, "creds"), { recursive: true, force: true });
    fx.cloneEmpty("creds");
    CrudModel.flushAllLocal();
    const text = await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 }, { activate: true, reset: true });
    const row = fx.rowNamed("credentials", "old");
    assert.equal(row.repository ?? null, null);
    assert.equal(row.password, "enc:s3cret");
    assert.equal(fx.fileExists("creds", "credentials", "old.yaml"), false);
    assert.match(text, /old: its entry is not in the repository as cloned again \(deleted in git, or never pushed\): kept in the app, not written back/);
    assert.equal(fx.rowNamed("credentials", "app-cred").repository, "creds");
    assert.deepEqual(fx.readEntry("creds", "credentials.yaml", "credentials").map((e) => e.name), ["app-cred"]);
  });

  test("the same when the activation's own pull made the fresh clone", async () => {
    fx.writeEntry("other", "credentials/old.yaml", "credentials", gitCredential("old"));
    await RepoObjects.syncRepository(credentials, "other");
    fs.rmSync(path.join(fx.ROOT, "other"), { recursive: true, force: true });
    // the clone the activation runs reads the empty tree as cloned again (Repository.clone's afterGit)
    const clone = fx.repository.clone;
    fx.repository.clone = async (name) => {
      await clone(name);
      await RepoObjects.afterGit(name, { name, use_for_credentials: 1 }, { reset: true });
    };
    try {
      fx.rowNamed("repositories", "creds").use_for_credentials = 0;
      fx.rowNamed("repositories", "other").use_for_credentials = 1;
      CrudModel.flushAllLocal();
      const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 });
      assert.deepEqual(report.credentials.activated.written, []);
      assert.deepEqual(report.credentials.activated.kept.map((k) => k.name), ["old"]);
    } finally {
      fx.repository.clone = clone;
    }
    assert.equal(fx.rowNamed("credentials", "old").repository ?? null, null);
    assert.equal(fx.fileExists("other", "credentials", "old.yaml"), false);
  });
});

describe("turning the usage on while the repository is busy", () => {
  test("the flag is turned off again and the report says so ; saving it again hands the app's objects over", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "app-cred", credential_type: "git", user: "u", password: "enc:pw" });
    fx.rowNamed("repositories", "creds").use_for_credentials = 0;
    fx.cloneEmpty("other");
    // saved by Repository.update first
    fx.rowNamed("repositories", "other").use_for_credentials = 1;
    const wait = { ...Engine.CLAIM_WAIT };
    Object.assign(Engine.CLAIM_WAIT, { totalMs: 30, everyMs: 10 });
    // a push or a long pull holds the claim all the wait
    fx.state.busy.other = Infinity;
    let report;
    try {
      report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 }, { pull: false });
    } finally {
      Object.assign(Engine.CLAIM_WAIT, wait);
      fx.state.busy = {};
    }
    assert.equal(report.credentials.turnedOff, true);
    assert.match(
      await RepoObjects.usageReportText(report),
      /^\nCredentials could not follow the usage: Repository 'other' is busy \(a pull or a push is running\): the usage was not turned on, nothing was read in nor written - save it again in a moment$/,
    );
    assert.doesNotMatch(report.credentials.error, /nothing was saved/);
    assert.equal(fx.rowNamed("repositories", "other").use_for_credentials, 0);
    assert.equal(fx.rowNamed("credentials", "app-cred").repository ?? null, null);
    // saved again : the flag changes again, the activation runs
    fx.rowNamed("repositories", "other").use_for_credentials = 1;
    CrudModel.flushAllLocal();
    const again = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 }, { pull: false });
    assert.deepEqual(again.credentials.activated.written, ["app-cred"]);
    assert.equal(fx.rowNamed("credentials", "app-cred").repository, "other");
  });

  test("its own pull read the files in before the wait : what it linked is unlinked again, kept in the app", async () => {
    fx.rowNamed("repositories", "creds").use_for_credentials = 0;
    fx.cloneEmpty("other");
    fx.writeEntry("other", "credentials/git.yaml", "credentials", gitCredential("git"));
    fx.rowNamed("repositories", "other").use_for_credentials = 1;
    // the pull reads its object files in, as the model's pull does, then a push holds the claim
    const pull = fx.repository.pull;
    fx.repository.pull = async (name) => {
      await RepoObjects.afterGit(name, fx.rowNamed("repositories", name));
      fx.state.busy[name] = Infinity;
    };
    const wait = { ...Engine.CLAIM_WAIT };
    Object.assign(Engine.CLAIM_WAIT, { totalMs: 30, everyMs: 10 });
    let report;
    try {
      report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 });
    } finally {
      fx.repository.pull = pull;
      Object.assign(Engine.CLAIM_WAIT, wait);
      fx.state.busy = {};
    }
    assert.equal(report.credentials.turnedOff, true);
    assert.match(report.credentials.error, /the usage was not turned on, nothing was handed over \(the 1 credential\(s\) its pull read in stay in the app, no longer linked to it\)/);
    assert.equal(fx.rowNamed("repositories", "other").use_for_credentials, 0);
    assert.ok(fx.rowNamed("credentials", "git"), "kept in the app");
    assert.equal(fx.rowNamed("credentials", "git").repository ?? null, null);
  });

  test("the flag that cannot be turned off again is said as it is", async () => {
    fx.rowNamed("repositories", "creds").use_for_credentials = 0;
    fx.cloneEmpty("other");
    fx.rowNamed("repositories", "other").use_for_credentials = 1;
    const wait = { ...Engine.CLAIM_WAIT };
    Object.assign(Engine.CLAIM_WAIT, { totalMs: 30, everyMs: 10 });
    fx.state.busy.other = Infinity;
    fx.state.failing = /^UPDATE AnsibleForms\.`repositories` SET \?/;
    let report;
    try {
      report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "other", { use_for_credentials: 1 }, { pull: false });
    } finally {
      Object.assign(Engine.CLAIM_WAIT, wait);
      fx.state.busy = {};
      fx.state.failing = null;
    }
    assert.equal(report.credentials.turnedOff, false);
    assert.match(report.credentials.error, /the usage is saved but nothing was handed over - turn it off, save, and turn it on again/);
  });
});

describe("the pull summary an activation reports", () => {
  test("one kept from before the working tree changed (another node's deactivation and pull) is not reported", async () => {
    // this node pulled 'creds' while it held the credentials : git took 'git' over
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "app", password: "enc:pw" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 });
    // turned off on another node (this node's memory untouched), the file gone in git since
    fx.rowNamed("repositories", "creds").use_for_credentials = 0;
    await RepoObjects.unlinkRepository(credentials, "creds");
    fx.removeFile("creds", "credentials", "git.yaml");
    // turned on here again, its pull failing
    fx.rowNamed("repositories", "creds").use_for_credentials = 1;
    fx.state.pullFails = true;
    CrudModel.flushAllLocal();
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 });
    assert.deepEqual(report.credentials.activated.matched, []);
    assert.equal(report.credentials.activated.created, 0);
  });

  test("one whose working tree moved to another commit is not reported either", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "app", password: "enc:pw" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    fs.mkdirSync(path.join(fx.ROOT, "creds", ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(fx.ROOT, "creds", ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(fx.ROOT, "creds", ".git", "refs", "heads", "main"), "aaaa\n");
    await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 });
    // another node pulled : the same files, another commit
    fs.writeFileSync(path.join(fx.ROOT, "creds", ".git", "refs", "heads", "main"), "bbbb\n");
    CrudModel.flushAllLocal();
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 }, { pull: false });
    assert.deepEqual(report.credentials.activated.matched, []);
  });

  test("one of the tree as it still is, its pull just before, is reported", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "app", password: "enc:pw" });
    fx.writeEntry("creds", "credentials/git.yaml", "credentials", gitCredential("git"));
    await RepoObjects.afterGit("creds", { name: "creds", use_for_credentials: 1 });
    CrudModel.flushAllLocal();
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 }, { pull: false });
    assert.deepEqual(report.credentials.activated.matched, ["git"]);
  });
});

describe("a usage turned on over a file written in flow style", () => {
  test("the app's objects written in block style, the list they join too ; the file's other flow keys and entries as written", async () => {
    fx.writeFile("creds", ".", "credentials.yaml", 'controller_credentials: [{name: git, credential_type: git, user: bot, password: "${GIT_PW}"}]\nnotes: [kept]\n');
    fx.state.tables.credentials.push({ id: 8, name: "smb", credential_type: "git", user: "u", password: "enc:pw" });
    fx.state.tables.credentials.push({ id: 9, name: "web", credential_type: "git", user: "w", password: "enc:pw" });
    const report = await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.deepEqual(report.written.sort(), ["smb", "web"]);
    const text = fx.textOf("creds", "credentials.yaml");
    assert.match(text, /^controller_credentials:\n {2}- \{name: git, credential_type: git, user: bot, password: "\$\{GIT_PW\}"\}\n {2}- name: smb\n/);
    assert.match(text, /\n {2}- name: web\n {4}user: w\n {4}credential_type: git\n/);
    assert.match(text, /\nnotes: \[kept\]\n$/);
    assert.doesNotMatch(text.split("\n").slice(2, -2).join("\n"), /[[{]/);
  });
});
