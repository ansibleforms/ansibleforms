// The repository-backed objects (lib/repoObjects) : the generic engine, and the Credentials and
// Runners types on it. One object per YAML file in the type's folder, in the config seed's format :
//   git to app   a pull creates, updates and deletes ; a bad file is refused alone ; a plain secret
//                is refused, an ${ENV} one resolved ; a runner whose credential is not there yet
//                waits, and is read when the credentials are next pulled ; a credential's file
//                removed while a runner uses it is refused
//   activation   the app's objects written to git without their secrets, git winning on a name,
//                what the config seed manages kept in the app
//   app to git   an edit rewrites only its changed fields ; a new object is a new file ; a delete
//                removes the file
//   deactivation the objects unlinked, kept in the app, the files untouched
//   the rules    one repository per type, the fixed order
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
describe("a pull reads the credentials folder", () => {
  test("new files make credentials, linked to their file, their ${ENV} secret resolved and encrypted", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.created, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.repository, "creds");
    assert.equal(row.repo_file, "credentials/git.yaml");
    assert.equal(row.password, "enc:s3cret");
    assert.equal(row.user, "bot");
  });

  test("a plain secret is refused, said with the file ; an unset variable too ; the others still sync", async () => {
    fx.writeFile("creds", "credentials", "a.yaml", gitCredential("a"));
    fx.writeFile("creds", "credentials", "plain.yaml", gitCredential("plain", { password: "hunter2" }));
    fx.writeFile("creds", "credentials", "unset.yaml", gitCredential("unset", { password: "${MISSING_PW}" }));
    fx.writeFile("creds", "credentials", "key.yaml", gitCredential("key", { client_key: "-----BEGIN KEY-----" }));
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.created, 1);
    assert.deepEqual(summary.refused.map((r) => r.file), ["credentials/key.yaml", "credentials/plain.yaml", "credentials/unset.yaml"]);
    assert.match(summary.refused[0].reasons[0], /client_key must be an \$\{ENV\} reference/);
    assert.match(summary.refused[1].reasons[0], /password must be an \$\{ENV\} reference: a secret is never written plain in git/);
    assert.match(summary.refused[2].reasons[0], /MISSING_PW/);
    assert.equal(fx.rowNamed("credentials", "plain"), undefined);
    assert.ok(RepoObjects.summaryText(credentials, summary).includes("Refused credentials/plain.yaml:"));
  });

  test("only the secret fields resolve their ${ENV} references : anywhere else a ${NAME} is plain text", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git", { description: "${GIT_PW}" }));
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).created, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.password, "enc:s3cret");
    assert.equal(row.description, "${GIT_PW}");
  });

  test("a key taken out of the file is taken out of the app : the value a new credential gets", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git", { description: "the bot", url: "https://git" }));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
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
    fx.writeFile("creds", "credentials", "typo.yaml", { name: "typo", pasword: "x" });
    fx.writeFile("creds", "credentials", "smtp.yaml", { name: "smtp", credential_type: "smtp" });
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.match(summary.refused.find((r) => r.file.endsWith("typo.yaml")).reasons[0], /'pasword'/);
    assert.match(summary.refused.find((r) => r.file.endsWith("smtp.yaml")).reasons[0], /not saved: An smtp credential needs its mail server/);
  });

  test("a changed file updates its credential, an unchanged one changes nothing", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git", { description: "the bot" }));
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).updated, 1);
    assert.equal(fx.rowNamed("credentials", "git").description, "the bot");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).unchanged, 1);
  });

  test("a removed file removes its credential ; one a runner uses is refused, kept, the reason said", async () => {
    fx.writeFile("creds", "credentials", "a.yaml", gitCredential("a"));
    fx.writeFile("creds", "credentials", "b.yaml", gitCredential("b"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.state.tables.runners.push({ id: 50, name: "rte1", type: "rte", credential: "b" });
    fx.removeFile("creds", "credentials", "a.yaml");
    fx.removeFile("creds", "credentials", "b.yaml");
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.deleted, 1);
    assert.equal(fx.rowNamed("credentials", "a"), undefined);
    assert.equal(fx.rowNamed("credentials", "b").repository, "creds");
    assert.match(summary.refused[0].reasons[0], /its file is gone, but runner 'rte1' still uses 'b'/);
  });
});

describe("the value a new row gets, as information_schema says it", () => {
  test("a text unquoted, none, an expression as none, whether it may be empty", async () => {
    fx.state.columns.defaults_probe = [
      { name: "mode", value: "'outbound'", nullable: "NO" },
      { name: "note", value: "NULL", nullable: "YES" },
      { name: "since", value: "current_timestamp()", nullable: "NO" },
      { name: "enabled", value: "1", nullable: "NO" },
    ];
    const columns = await Engine.columnDefaults("AnsibleForms.`defaults_probe`");
    assert.deepEqual(Object.fromEntries(columns), {
      mode: { value: "outbound", nullable: false },
      note: { value: null, nullable: true },
      since: { value: null, nullable: false },
      enabled: { value: "1", nullable: false },
    });
  });
});

describe("a file renamed in git", () => {
  test("its object follows it : the same row, its secret kept in the database, its new fields applied", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "bot", password: "enc:dbonly" });
    fx.cloneEmpty("creds");
    await RepoObjects.activate(credentials, "creds", { pull: false });
    const text = fx.readText("creds", "credentials", "git.yaml");
    fx.removeFile("creds", "credentials", "git.yaml");
    fx.writeFile("creds", "credentials", "git-bot.yaml", text.replace("user: bot", "user: robot"));
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(summary.deleted, 0);
    assert.equal(summary.created, 0);
    assert.equal(summary.updated, 1);
    const row = fx.rowNamed("credentials", "git");
    assert.equal(row.id, 7);
    assert.equal(row.repo_file, "credentials/git-bot.yaml");
    assert.equal(row.password, "enc:dbonly");
    assert.equal(row.user, "robot");
  });

  test("one a runner uses follows it too, never refused", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    fx.state.tables.runners.push({ id: 50, name: "rte1", type: "rte", credential: "git" });
    fx.removeFile("creds", "credentials", "git.yaml");
    fx.writeFile("creds", "credentials", "git-bot.yaml", gitCredential("git"));
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(credentials, "creds");
    assert.deepEqual(summary.refused, []);
    assert.equal(fx.rowNamed("credentials", "git").repo_file, "credentials/git-bot.yaml");
  });
});

describe("a link in the repository that leads outside it", () => {
  test("its folder a link : turning it on writes nothing outside, the credential stays in the app, a pull keeps it", async () => {
    fx.state.tables.credentials.push({ id: 8, name: "smb", credential_type: "git", user: "u", password: "enc:pw" });
    fx.cloneEmpty("creds");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-"));
    fs.symlinkSync(outside, path.join(fx.ROOT, "creds", "credentials"));
    const report = await RepoObjects.activate(credentials, "creds", { pull: false });
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(report.written, []);
    assert.match(report.kept[0].reason, /not written/);
    assert.equal(fx.rowNamed("credentials", "smb").repository ?? null, null);
    CrudModel.flushAllLocal();
    await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(fx.rowNamed("credentials", "smb").password, "enc:pw");
  });

  test("a linked object's file replaced by a link : its edit never written through it", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
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
    fx.writeFile("ops", "runners", "rte1.yaml", rteRunner("rte1", { rte_max_jobs: 4, enabled: false }));
    const summary = await RepoObjects.syncRepository(runners, "ops");
    assert.equal(summary.created, 0);
    assert.deepEqual(summary.waiting.map((w) => w.file), ["runners/rte1.yaml"]);
    assert.match(RepoObjects.summaryText(runners, summary), /Waiting runners\/rte1.yaml: waits for the credential 'rte-cred' \(credential\), not there yet/);
    // the credentials repository is pulled : the runners repository is read again, the runner made
    fx.writeFile("creds", "credentials", "rte.yaml", rteCredential);
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
    fx.writeFile("ops", "runners", "rte1.yaml", rteRunner("rte1", { description: "first" }));
    assert.equal((await RepoObjects.syncRepository(runners, "ops")).created, 1);
    fx.writeFile("ops", "runners", "rte1.yaml", rteRunner("rte1", { description: "second", rte_files: "local" }));
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(runners, "ops")).updated, 1);
    const row = fx.rowNamed("runners", "rte1");
    assert.equal(row.rte_files, "local");
    // turned off in the app : the file says enabled: false, nothing else rewritten
    const before = { ...row };
    row.enabled = 0;
    CrudModel.flushAllLocal();
    await RepoObjects.appUpdated("runners", before, row.id);
    assert.equal(fx.readObject("ops", "runners", "rte1.yaml").enabled, false);
    assert.equal(fx.readObject("ops", "runners", "rte1.yaml").description, "second");
    // a plain token is refused
    fx.writeFile("ops", "runners", "rte1.yaml", rteRunner("rte1", { token: "plain" }));
    assert.match((await RepoObjects.syncRepository(runners, "ops")).refused[0].reasons[0], /token must be an \$\{ENV\} reference/);
    // its file removed : the runner goes
    fx.removeFile("ops", "runners", "rte1.yaml");
    assert.equal((await RepoObjects.syncRepository(runners, "ops")).deleted, 1);
    assert.equal(fx.rowNamed("runners", "rte1"), undefined);
  });

  test("one repository holding both : the credentials are read first, the runner made at once", async () => {
    fx.state.tables.repositories[0].use_for_runners = 1;
    fx.state.tables.repositories[1].use_for_runners = 0;
    fx.writeFile("creds", "runners", "a.yaml", rteRunner("a"));
    fx.writeFile("creds", "credentials", "rte.yaml", rteCredential);
    const out = await RepoObjects.afterGit("creds", fx.rowNamed("repositories", "creds"));
    assert.ok(out.indexOf("Credentials:") < out.indexOf("Runners:"));
    assert.match(out, /Runners: 1 created/);
  });

  test("at the worker's start the types are read in their fixed order", async () => {
    fx.writeFile("ops", "runners", "a.yaml", rteRunner("a"));
    fx.writeFile("creds", "credentials", "rte.yaml", rteCredential);
    await RepoObjects.syncAll();
    assert.ok(fx.rowNamed("runners", "a"), "the runner found its credential");
    assert.deepEqual(fx.state.calls, ["claim:creds", "release:creds", "claim:ops", "release:ops"]);
    assert.deepEqual(types.APPLY_ORDER.slice(0, 4), ["credentials", "repositories", "secret_stores", "runners"]);
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
    fx.writeFile("creds", "credentials", "clash.yaml", { name: "Clash", credential_type: "git", description: "git's" });
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
    const file = fx.readObject("creds", "credentials", "api.yaml");
    assert.deepEqual(file, { name: "api", description: "the api", user: "u", credential_type: "api" });
    assert.equal(fx.rowNamed("credentials", "api").repo_file, "credentials/api.yaml");
    assert.equal(fx.rowNamed("credentials", "seeded").repository, undefined);
    // and the next pull finds nothing to change
    CrudModel.flushAllLocal();
    const again = await RepoObjects.syncRepository(credentials, "creds");
    assert.equal(again.unchanged, 2);
    assert.deepEqual(again.secretsKept.sort(), ["Clash", "api"]);
    assert.match(RepoObjects.summaryText(credentials, again), /Not in git, their secrets kept from the database: /);
  });

  test("deactivation : pulled once more, unlinked, kept in the app, the files untouched", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
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
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
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
    assert.equal(fx.readObject("creds", "credentials", "git.yaml").user, "alice");
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(credentials, "creds")).unchanged, 1, "the next pull keeps the edit");
  });

  test("still busy once the wait is over : refused with a conflict, nothing saved", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 20, everyMs: 1 });
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
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
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
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
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
    fx.state.busy.creds = Infinity;
    const report = await RepoObjects.afterUsageChange({ use_for_credentials: 0 }, "creds", { use_for_credentials: 1 }, { pull: false });
    assert.match(report.credentials.error, /Repository 'creds' is busy/);
    assert.equal(fx.rowNamed("credentials", "git"), undefined);
    assert.equal(fx.rowNamed("credentials", "app").repository ?? null, null);
  });

  test("a file write outside a save, still busy : said to the caller, never a silent success", async () => {
    Object.assign(CLAIM_WAIT, { totalMs: 20, everyMs: 1 });
    fx.writeFile("creds", "credentials", "git.yaml", gitCredential("git"));
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    fx.state.busy.creds = Infinity;
    await assert.rejects(RepoObjects.appUpdated("credentials", before, before.id), { name: "ConflictError" });
  });
});

describe("an edit in the app goes to the file", () => {
  test("only the changed fields are written : the ${ENV} reference, the comments and the unknown order kept", async () => {
    fx.writeFile("creds", "credentials", "git.yaml", `# the bot's\nname: git\npassword: \${GIT_PW}\ncredential_type: git\nuser: bot\n`);
    await RepoObjects.syncRepository(credentials, "creds");
    const before = { ...fx.rowNamed("credentials", "git") };
    Object.assign(fx.rowNamed("credentials", "git"), { description: "edited", password: "enc:typed-in-app" });
    CrudModel.flushAllLocal();
    assert.equal(await RepoObjects.appUpdated("credentials", before, before.id), true);
    const text = fx.readText("creds", "credentials", "git.yaml");
    assert.equal(text, "# the bot's\nname: git\ndescription: edited\npassword: ${GIT_PW}\ncredential_type: git\nuser: bot\n");
    assert.ok(!text.includes("typed-in-app"));
  });

  test("a new credential is a new file, without its secret ; a delete removes it", async () => {
    fx.cloneEmpty("creds");
    fx.state.tables.credentials.push({ id: 7, name: "New One", credential_type: "userpass", user: "me", password: "enc:pw" });
    const made = await RepoObjects.appCreated("credentials", 7);
    assert.deepEqual(made, { repository: "creds", file: "credentials/new-one.yaml", withoutSecret: true });
    assert.deepEqual(fx.readObject("creds", "credentials", "new-one.yaml"), { name: "New One", user: "me", credential_type: "userpass" });
    assert.equal(await RepoObjects.appDeleted("credentials", fx.rowNamed("credentials", "New One")), true);
    assert.equal(fx.fileExists("creds", "credentials", "new-one.yaml"), false);
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
    assert.equal(new Set(types.USAGE_FLAGS).size, 24);
    for (const t of types.USAGE_TYPES) assert.ok(types.CATEGORIES.includes(t.category), t.key);
    // every object type has its descriptor : none is of a later version
    assert.deepEqual(
      [...RepoObjects.BUILT_OBJECT_TYPES].sort(),
      types.USAGE_TYPES.filter((t) => t.objects).map((t) => t.key).sort(),
    );
    for (const t of types.USAGE_TYPES) assert.equal(t.built, undefined, t.key);
  });

  test("turning several usages on at once : in the fixed order, the repository pulled once", async () => {
    fx.writeFile("other", "credentials", "rte.yaml", rteCredential);
    fx.writeFile("other", "runners", "a.yaml", rteRunner("a"));
    const report = {};
    await RepoObjects.afterUsageChange({}, "other", { use_for_credentials: 1, use_for_runners: 1 }, { report });
    assert.deepEqual(Object.keys(report), ["credentials", "runners"]);
    assert.equal(report.credentials.activated.pull, "pulled");
    assert.equal(report.runners.activated.pull, "pulled");
    assert.deepEqual(fx.state.calls.filter((c) => c.startsWith("pull")), ["pull:other"]);
    assert.equal(fx.rowNamed("runners", "a").repository, "other");
  });
});
