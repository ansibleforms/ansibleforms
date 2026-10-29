// The repository's files read by their content (lib/repoObjects/repoFiles.js, lib/repoObjects/engine.js) :
// any YAML file, any name, any folder, at any depth, whose top-level key is a type's key holds that
// type. On the shared fixture :
//   where        any name, folder and depth ; hidden folders and files never read ; a form, a
//                playbook, a key with a text under it, or a file of unknown keys none of theirs
//   several      several types in one file, a type over several files, the unknown keys of a file
//                left alone ; a key of a type the repository does not hold said once as a hint
//   identity     an object is its name within its type : an entry moved keeps its object, a name
//                two entries give is refused in both, a rename in a file is the one gone and the one
//                new name of that file - else a delete and a new object
//   a file not read  its objects kept as they are : one that cannot be read, a refused entry
//                with no name in it
//   one of       a type the app has one of given by two files : refused, both named ; its images
//                relative to its file
//   the keys     the roles read from the file giving them, any name ; two files : neither read
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
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
vi.mock("../src/routes/v2/app.routes.js", () => ({ forgetAppDefaults: () => {} }));
vi.mock("../src/lib/liveEvents.js", () => ({ publish: () => {}, onLive: () => {} }));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const { contentOf, scanRepository } = await import("../src/lib/repoObjects/repoFiles.js");
const keys = await import("../src/lib/configKeys.js");
const credentials = await RepoObjects.descriptorOf("credentials");
const runners = await RepoObjects.descriptorOf("runners");

const git = (name, extra = {}) => ({ name, credential_type: "git", user: "bot", password: "${GIT_PW}", ...extra });
const rte = (name, extra = {}) => ({ name, type: "rte", rte_mode: "outbound", credential: "rte-cred", ...extra });
const write = (repo, file, content) => {
  if (!Buffer.isBuffer(content)) return fx.writeFile(repo, path.dirname(file), path.basename(file), content);
  fs.mkdirSync(path.dirname(path.join(fx.ROOT, repo, file)), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, repo, file), content);
};
const sync = (desc, repo = "ops") => {
  CrudModel.flushAllLocal();
  return RepoObjects.syncRepository(desc, repo);
};

beforeEach(() => {
  process.env.GIT_PW = "s3cret";
  process.env.RTE_SECRET = "rte-token";
  fx.reset({ repositories: [{ id: 1, name: "ops", uri: "https://git/ops.git", use_for_credentials: 1, use_for_runners: 1 }] });
  CrudModel.flushAllLocal();
});

// ─── where ─────────────────────────────────────────────────────────────────────
describe("any YAML file, any name, any folder, any depth", () => {
  test("each file giving the key is read, wherever it is ; hidden folders and files never", async () => {
    write("ops", "a/b/c/d/deep.yml", { credentials: [git("deep")] });
    write("ops", "Some Name.YAML", { credentials: [git("odd")] });
    write("ops", ".hidden/x.yaml", { credentials: [git("hidden")] });
    write("ops", ".dotted.yaml", { credentials: [git("dotted")] });
    write("ops", ".git/config.yaml", { credentials: [git("in-git")] });
    write("ops", "notes.txt", "credentials:\n  - name: not-yaml\n");
    const summary = await sync(credentials);
    assert.equal(summary.created, 2);
    assert.equal(fx.rowNamed("credentials", "deep").repo_file, "a/b/c/d/deep.yml");
    assert.equal(fx.rowNamed("credentials", "odd").repo_file, "Some Name.YAML");
    for (const n of ["hidden", "dotted", "in-git", "not-yaml"]) assert.equal(fx.rowNamed("credentials", n), undefined, n);
  });

  test("a form, a playbook, a key with a text under it, or unknown keys : none of the types'", () => {
    assert.deepEqual(contentOf(YAML.stringify({ name: "Deploy", type: "ansible", roles: ["public"], categories: ["Ops"], icon: "x" })).keys, []);
    assert.deepEqual(contentOf(YAML.stringify([{ hosts: "all", tasks: [] }])).keys, []);
    assert.deepEqual(contentOf("name: web\nicon: server\nlinks: none\n").keys, []);
    assert.deepEqual(contentOf("all:\n  hosts:\n    web1: {}\n").keys, []);
    assert.deepEqual(contentOf("labels: []\nname:\n  app_name: X\nnotes: kept\n").keys, ["labels", "name"]);
    // a flow map is read too ; a text that cannot be read says the keys its lines seem to give
    assert.deepEqual(contentOf("{credentials: [{name: a}]}\n").keys, ["credentials"]);
    assert.deepEqual(contentOf("credentials:\n  - name: [broken\n").hints, ["credentials"]);
  });
});

// ─── several ───────────────────────────────────────────────────────────────────
describe("several types in one file, a type over several files", () => {
  test("one file holding the credentials and the runners : each type takes its entries, the rest of the file left alone", async () => {
    const text = `# the platform's\ncredentials:\n  - name: rte-cred\n    credential_type: rte\n    password: \${RTE_SECRET}\nrunners:\n  - name: edge\n    type: rte\n    rte_mode: outbound\n    credential: rte-cred\nnotes: kept as it is\nforms_view: not ours\n`;
    write("ops", "platform.yaml", text);
    const out = await RepoObjects.afterGit("ops", fx.rowNamed("repositories", "ops"));
    assert.match(out, /Credentials: 1 created/);
    assert.match(out, /Runners: 1 created/);
    assert.doesNotMatch(out, /notes|forms_view|Refused/);
    assert.equal(fx.rowNamed("runners", "edge").repo_file, "platform.yaml");
    assert.equal(fx.rowNamed("credentials", "rte-cred").repo_file, "platform.yaml");
    // an edit of one : the other type's entries and the unknown keys byte for byte
    const before = { ...fx.rowNamed("runners", "edge") };
    fx.rowNamed("runners", "edge").description = "the edge";
    CrudModel.flushAllLocal();
    assert.equal(await RepoObjects.appUpdated("runners", before, before.id), true);
    // in its type's key order : after its type
    assert.equal(fx.textOf("ops", "platform.yaml"), text.replace("  - name: edge\n    type: rte\n", "  - name: edge\n    type: rte\n    description: the edge\n"));
  });

  test("one type over several files : each entry linked to its own file", async () => {
    write("ops", "team-a/creds.yaml", { credentials: [git("a1"), git("a2")] });
    write("ops", "team-b/creds.yaml", { credentials: [git("b1")] });
    assert.equal((await sync(credentials)).created, 3);
    assert.deepEqual(
      fx.state.tables.credentials.map((r) => [r.name, r.repo_file]),
      [["a1", "team-a/creds.yaml"], ["a2", "team-a/creds.yaml"], ["b1", "team-b/creds.yaml"]],
    );
    // a delete in the app : only its entry goes, from its own file
    assert.equal(await RepoObjects.appDeleted("credentials", fx.rowNamed("credentials", "a1")), true);
    assert.deepEqual(fx.readEntry("ops", "team-a/creds.yaml", "credentials").map((e) => e.name), ["a2"]);
    assert.deepEqual(fx.readEntry("ops", "team-b/creds.yaml", "credentials").map((e) => e.name), ["b1"]);
  });

  test("a key of a type the repository does not hold : never read, said once as a hint", async () => {
    write("ops", "a.yaml", { credentials: [git("a")], labels: [{ name: "PROD" }], sso: [] });
    write("ops", "b.yaml", { labels: [{ name: "DEV" }] });
    const out = await RepoObjects.afterGit("ops", fx.rowNamed("repositories", "ops"));
    assert.equal(out.match(/Not read, the repository is not used for them/g).length, 1);
    assert.match(out, /\nNot read, the repository is not used for them: labels: \(a\.yaml, b\.yaml\), sso: \(a\.yaml\) - turn the usage on to read them/);
    assert.deepEqual(fx.state.tables.labels, []);
    assert.ok(fx.rowNamed("credentials", "a"));
  });
});

// ─── identity ──────────────────────────────────────────────────────────────────
describe("an object is its name within its type", () => {
  test("a rename in its file - the one name gone from it, the one new in it - keeps the object : its id, its secret, what uses it", async () => {
    fx.state.tables.credentials.push({ id: 7, name: "git", credential_type: "git", user: "bot", password: "enc:db-only", repository: "ops", repo_file: "creds.yaml" });
    write("ops", "creds.yaml", { credentials: [git("other"), { name: "git", credential_type: "git", user: "bot" }] });
    await sync(credentials);
    fx.state.tables.runners.push({ id: 50, name: "rte1", type: "rte", credential: "github", repository: "ops", repo_file: "runners.yaml" });
    write("ops", "runners.yaml", { runners: [{ name: "rte1", type: "rte", rte_mode: "outbound", credential: "github" }] });
    write("ops", "creds.yaml", { credentials: [git("other"), { name: "github", credential_type: "git", user: "bot" }] });
    const summary = await sync(credentials);
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.created, 0);
    assert.equal(summary.deleted, 0);
    assert.equal(summary.updated, 1);
    const row = fx.rowNamed("credentials", "github");
    assert.equal(row.id, 7);
    assert.equal(row.password, "enc:db-only");
  });

  test("two names gone and two new in a file, or a name gone from one file and new in another : deleted and made anew", async () => {
    write("ops", "x.yaml", { credentials: [git("a"), git("b")] });
    write("ops", "y.yaml", { credentials: [git("c")] });
    await sync(credentials);
    const ids = Object.fromEntries(fx.state.tables.credentials.map((r) => [r.name, r.id]));
    write("ops", "x.yaml", { credentials: [git("a2"), git("b2")] });
    write("ops", "y.yaml", { credentials: [] });
    write("ops", "z.yaml", { credentials: [git("c2")] });
    const summary = await sync(credentials);
    assert.equal(summary.deleted, 3);
    assert.equal(summary.created, 3);
    for (const n of ["a2", "b2", "c2"]) assert.ok(!Object.values(ids).includes(fx.rowNamed("credentials", n).id), n);
  });

  test("an entry moved to another file : its object follows, nothing else changes", async () => {
    write("ops", "x.yaml", { credentials: [git("a"), git("b")] });
    await sync(credentials);
    const id = fx.rowNamed("credentials", "a").id;
    write("ops", "x.yaml", { credentials: [git("b")] });
    write("ops", "moved/here.yml", { runners: [], credentials: [git("a")] });
    const summary = await sync(credentials);
    assert.deepEqual([summary.created, summary.deleted, summary.updated, summary.unchanged], [0, 0, 0, 2]);
    assert.equal(fx.rowNamed("credentials", "a").id, id);
    assert.equal(fx.rowNamed("credentials", "a").repo_file, "moved/here.yml");
  });

  test("a name two entries give, in two files : both refused, naming both places ; the object kept as it was", async () => {
    write("ops", "x.yaml", { credentials: [git("a", { description: "x" })] });
    await sync(credentials);
    write("ops", "y.yaml", { credentials: [git("A", { description: "y" })] });
    const summary = await sync(credentials);
    assert.deepEqual(summary.refused.map((r) => r.file), ["x.yaml#a", "y.yaml#A"]);
    assert.match(summary.refused[0].reasons[0], /the name 'a' is given twice: here \(x\.yaml, entry 1\) and in y\.yaml \(entry 1\)/);
    assert.equal(fx.rowNamed("credentials", "a").description, "x");
    assert.equal(fx.rowNamed("credentials", "a").repo_file, "x.yaml");
  });
});

// ─── a file not read ───────────────────────────────────────────────────────────
describe("what a file not read held stays as it is", () => {
  test("a file that cannot be read : its objects kept and still linked, the file refused when its lines give the key", async () => {
    write("ops", "x.yaml", { credentials: [git("a"), git("b")] });
    await sync(credentials);
    write("ops", "x.yaml", "credentials:\n  - name: a\n    user: [broken\n");
    const summary = await sync(credentials);
    assert.equal(summary.deleted, 0);
    assert.deepEqual(summary.refused.map((r) => r.file), ["x.yaml"]);
    assert.match(summary.refused[0].reasons[0], /^not valid YAML/);
    assert.equal(fx.rowNamed("credentials", "b").repository, "ops");
    // nor deleted when its text no longer seems to give it : never read, kept
    write("ops", "x.yaml", "{ unclosed\n");
    assert.equal((await sync(credentials)).deleted, 0);
  });

  test("a refused entry with no name : the objects of its file whose entries are gone are kept", async () => {
    write("ops", "x.yaml", { credentials: [git("a"), git("b")] });
    write("ops", "y.yaml", { credentials: [git("c")] });
    await sync(credentials);
    write("ops", "x.yaml", { credentials: [git("a"), { credential_type: "git" }] });
    write("ops", "y.yaml", { credentials: [] });
    const summary = await sync(credentials);
    assert.deepEqual(summary.refused.map((r) => r.file), ["x.yaml#2"]);
    assert.ok(fx.rowNamed("credentials", "b"), "kept : the refused entry may be it");
    assert.equal(fx.rowNamed("credentials", "c"), undefined, "another file's : gone");
    assert.equal(summary.deleted, 1);
  });
});

// ─── one of ────────────────────────────────────────────────────────────────────
describe("a type the app has one of", () => {
  beforeEach(() => {
    fx.reset({
      repositories: [{ id: 1, name: "look", use_for_name: 1, use_for_logo: 1 }],
      settings: [{ id: 1, app_name: "Old name", header_links: null, default_theme: "system", logo: null, favicon: null }],
    });
  });

  test("given by two files : refused, both named, nothing applied ; by one, wherever it is, applied", async () => {
    write("look", "a/branding.yaml", { name: { app_name: "A" } });
    write("look", "b/branding.yaml", { name: { app_name: "B" }, labels: [] });
    const name = await RepoObjects.descriptorOf("name");
    const summary = await sync(name, "look");
    assert.deepEqual(summary.refused, [{ file: "a/branding.yaml, b/branding.yaml", reasons: ["name: is given by 2 files (a/branding.yaml, b/branding.yaml): one file at most gives it"] }]);
    assert.equal(fx.state.tables.settings[0].app_name, "Old name");
    fs.rmSync(path.join(fx.ROOT, "look", "a"), { recursive: true });
    assert.equal((await sync(name, "look")).updated, 1);
    assert.equal(fx.state.tables.settings[0].app_name, "B");
    assert.deepEqual(await RepoObjects.singleSource("name"), { repository: "look", repo_file: "b/branding.yaml" });
  });

  test("its image named relative to its file, inside the repository ; an edit writes into that file only", async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("logo")]);
    write("look", "assets/img/logo.png", PNG);
    write("look", "site/app.yaml", { name: { app_name: "Site" }, logo: { logo: "../assets/img/logo.png" } });
    const logo = await RepoObjects.descriptorOf("logo");
    const applied = await sync(logo, "look");
    assert.equal(applied.updated, 1, JSON.stringify(applied));
    assert.equal(fx.state.tables.settings[0].logo, `data:image/png;base64,${PNG.toString("base64")}`);
    // a new logo in the app : written where the map names it, the file's other keys as they were
    const text = fx.textOf("look", "site/app.yaml");
    const before = await RepoObjects.snapshot("logo");
    const other = Buffer.concat([PNG, Buffer.from("v2")]);
    fx.state.tables.settings[0].logo = `data:image/png;base64,${other.toString("base64")}`;
    assert.equal(await RepoObjects.appUpdated("logo", before), true);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(fx.ROOT, "look", "assets/img/logo.png")), other), 0);
    assert.equal(fx.textOf("look", "site/app.yaml"), text);
    // outside the repository : refused
    write("look", "site/app.yaml", { name: { app_name: "Site" }, logo: { logo: "../../outside.png" } });
    assert.match((await sync(logo, "look")).refused[0].reasons[0], /not a file of the repository/);
  });
});

// ─── the configuration's keys ──────────────────────────────────────────────────
describe("the roles, the categories and the constants, by their key", () => {
  beforeEach(() => {
    keys.resetKeyReadsForTests();
    fx.reset({ repositories: [{ id: 1, name: "access", use_for_roles: 1, use_for_constants: 1 }] });
  });

  test("read from the file giving them, any name, any folder ; several keys in one file", async () => {
    write("access", "team/access.yml", { roles: [{ name: "admin", groups: ["local/admins"] }], constants: { env: "prod" } });
    const sources = await keys.keySources();
    assert.deepEqual(sources.map((s) => [s.key, s.file, s.exists]), [["roles", "team/access.yml", true], ["constants", "team/access.yml", true]]);
    assert.deepEqual(await keys.repositoryKeyProblems("access"), []);
  });

  test("two files giving them : neither read, both named", async () => {
    write("access", "a.yaml", { roles: [{ name: "admin" }] });
    write("access", "b/c.yaml", { roles: [{ name: "admin", users: ["local/eve"] }] });
    const problems = await keys.repositoryKeyProblems("access");
    assert.equal(problems.length, 1);
    assert.equal(problems[0].reason, "2 files give its roles (a.yaml, b/c.yaml): one file at most gives them");
  });

  test("a scan reads each file once : unchanged files are not parsed again", () => {
    write("access", "a.yaml", { roles: [] });
    const first = scanRepository(path.join(fx.ROOT, "access"));
    const second = scanRepository(path.join(fx.ROOT, "access"));
    assert.equal(first.stamp, second.stamp);
    write("access", "a.yaml", { roles: [{ name: "x" }] });
    assert.notEqual(scanRepository(path.join(fx.ROOT, "access")).stamp, first.stamp);
    assert.deepEqual(scanRepository(path.join(fx.ROOT, "access")).holding("roles")[0].value, [{ name: "x" }]);
  });
});

// ─── runners naming credentials, over files ────────────────────────────────────
describe("what an entry names, in another file", () => {
  test("a runner names a credential of another file : found, whatever the files", async () => {
    write("ops", "x/credentials.yaml", { credentials: [{ name: "rte-cred", credential_type: "rte", password: "${RTE_SECRET}" }] });
    write("ops", "y/runners.yaml", { runners: [rte("edge")] });
    await RepoObjects.afterGit("ops", fx.rowNamed("repositories", "ops"));
    assert.equal(fx.rowNamed("runners", "edge").credential, "rte-cred");
    assert.equal(fx.rowNamed("runners", "edge").repo_file, "y/runners.yaml");
    assert.equal((await sync(runners)).unchanged, 1);
  });
});
