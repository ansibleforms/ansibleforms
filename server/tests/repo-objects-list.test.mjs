// The Repositories type (lib/repoObjects/repositories.js) : the other repositories in a
// repository's repositories.yaml, the engine's list mode (one file, a list of entries found by
// their name), on the shared fixture. Its guard rails : the holder never in its own file, no
// chains, a usage another repository holds refused, a credential waited for, an entry gone deleting
// its repository as the app does - never one with changes not pushed yet -, no secret in the file.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the repositories as the app saves them : the fixture's table, each call recorded
const unpushed = new Set();
vi.mock("../src/models/repository.model.js", async () => {
  const fx = await import("./fixtures/repoObjects.mjs");
  const rows = () => fx.state.tables.repositories;
  return {
    default: {
      ...fx.repository,
      create: async (d) => {
        const id = fx.state.nextId++;
        rows().push({ id, repository: null, repo_file: null, ...d });
        fx.state.calls.push(`create:${d.name}`);
        return id;
      },
      update: async (d, name) => {
        Object.assign(rows().find((r) => r.name === name), d);
        fx.state.calls.push(`update:${name}`);
      },
      delete: async (name) => {
        fx.state.tables.repositories = rows().filter((r) => r.name !== name);
        fx.state.calls.push(`delete:${name}`);
      },
      findById: async (id) => rows().find((r) => r.id === Number(id)),
      withUnpushed: async (list) => list.map((r) => ({ ...r, unpushed: unpushed.has(r.name) })),
    },
  };
});
vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const types = await import("../src/lib/repoObjects/types.js");
const desc = () => RepoObjects.descriptorOf("repositories");

const writeList = (items) => {
  fs.mkdirSync(path.join(fx.ROOT, "hub"), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, "hub", "repositories.yaml"), YAML.stringify({ repositories: items }));
};
const readList = () => YAML.parse(fs.readFileSync(path.join(fx.ROOT, "hub", "repositories.yaml"), "utf8")).repositories;
const entry = (name, extra = {}) => ({ name, uri: `https://git.example.com/${name}.git`, branch: "main", ...extra });

beforeEach(() => {
  unpushed.clear();
  fx.reset({
    repositories: [{ id: 1, name: "hub", uri: "https://git/hub.git", use_for_repositories: 1 }],
    credentials: [{ id: 1, name: "git-bot", credential_type: "git", password: "enc:p" }],
  });
  // the usage flags as information_schema describes them : a tinyint, its default the text "0"
  // (read once per table and kept : the same for every test of this file)
  fx.state.columns.repositories = types.USAGE_FLAGS.map((name) => ({ name, value: "0", nullable: "NO", type: "tinyint" }));
  CrudModel.flushAllLocal();
});

describe("a usage taken out of an entry", () => {
  test("turns it off - the number 0, never the text '0' the model would save as on - and the next pull changes nothing", async () => {
    writeList([entry("forms", { use_for_forms: true, use_for_workflows: true })]);
    await RepoObjects.syncRepository(await desc(), "hub");
    writeList([entry("forms", { use_for_forms: true })]);
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await desc(), "hub")).updated, 1);
    assert.strictEqual(fx.rowNamed("repositories", "forms").use_for_workflows, 0);
    CrudModel.flushAllLocal();
    assert.equal((await RepoObjects.syncRepository(await desc(), "hub")).updated, 0);
  });
});

describe("a pull of repositories.yaml", () => {
  test("creates, updates and deletes the repositories it lists, each found by its name", async () => {
    writeList([entry("forms", { use_for_forms: true }), entry("ops", { description: "ops" })]);
    let summary = await RepoObjects.syncRepository(await desc(), "hub");
    assert.equal(summary.created, 2, JSON.stringify(summary));
    assert.equal(fx.rowNamed("repositories", "forms").repository, "hub");
    assert.equal(fx.rowNamed("repositories", "forms").repo_file, "repositories.yaml");
    assert.equal(fx.rowNamed("repositories", "forms").use_for_forms, true, "its usage applied as if ticked");
    writeList([entry("forms", { use_for_forms: true, branch: "dev" })]);
    CrudModel.flushAllLocal();
    summary = await RepoObjects.syncRepository(await desc(), "hub");
    assert.equal(summary.updated, 1);
    assert.equal(summary.deleted, 1);
    assert.equal(fx.rowNamed("repositories", "forms").branch, "dev");
    assert.equal(fx.rowNamed("repositories", "ops"), undefined);
    assert.ok(fx.state.calls.includes("delete:ops"), "deleted as the app deletes one");
  });

  test("a key taken out of an entry is taken out of the repository : a usage off, a description emptied", async () => {
    writeList([entry("forms", { use_for_forms: true, description: "the forms" })]);
    await RepoObjects.syncRepository(await desc(), "hub");
    writeList([entry("forms")]);
    CrudModel.flushAllLocal();
    const summary = await RepoObjects.syncRepository(await desc(), "hub");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.equal(Number(fx.rowNamed("repositories", "forms").use_for_forms), 0);
    assert.equal(fx.rowNamed("repositories", "forms").description, "");
  });

  test("a repositories.yaml that is a link leading outside the repository is never read", async () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-outside-")), "list.yaml");
    fs.writeFileSync(outside, YAML.stringify({ repositories: [entry("planted")] }));
    fs.mkdirSync(path.join(fx.ROOT, "hub"), { recursive: true });
    fs.symlinkSync(outside, path.join(fx.ROOT, "hub", "repositories.yaml"));
    const out = await RepoObjects.syncText(await desc(), "hub");
    assert.match(out, /not synchronized/);
    assert.equal(fx.rowNamed("repositories", "planted"), undefined);
  });

  test("the holder is never its own file's : its entry not imported, said", async () => {
    writeList([entry("hub", { branch: "other" }), entry("forms")]);
    const summary = await RepoObjects.syncRepository(await desc(), "hub");
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.created, 1);
    assert.equal(fx.rowNamed("repositories", "hub").branch, undefined);
    assert.match(RepoObjects.summaryText(await desc(), summary), /Not imported, the repository holding this file: hub \(repositories.yaml#hub\)/);
  });

  test("no chains, and no usage another repository holds : refused, said, the rest applied", async () => {
    fx.state.tables.repositories.push({ id: 2, name: "creds", use_for_credentials: 1 });
    writeList([entry("forms", { use_for_repositories: true, use_for_credentials: true, use_for_forms: true })]);
    const summary = await RepoObjects.syncRepository(await desc(), "hub");
    const row = fx.rowNamed("repositories", "forms");
    assert.equal(row.use_for_repositories, undefined);
    assert.equal(row.use_for_credentials, undefined);
    assert.equal(row.use_for_forms, true);
    const text = RepoObjects.summaryText(await desc(), summary);
    assert.match(text, /repositories.yaml#forms: use_for_repositories refused: a repository of repositories.yaml cannot hold repositories itself/);
    assert.match(text, /repositories.yaml#forms: use_for_credentials refused: repository 'creds' holds the credentials already/);
  });

  test("use_for_config : applied as the three flags it is now, said, and the next pull changes nothing", async () => {
    writeList([entry("cfg", { use_for_config: true })]);
    const summary = await RepoObjects.syncRepository(await desc(), "hub");
    const row = fx.rowNamed("repositories", "cfg");
    assert.equal(Number(row.use_for_roles), 1);
    assert.equal(Number(row.use_for_categories), 1);
    assert.equal(Number(row.use_for_constants), 1);
    assert.match(RepoObjects.summaryText(await desc(), summary), /repositories.yaml#cfg: use_for_config is deprecated since 7.4.0 and removed in 8: applied as use_for_roles, use_for_categories and use_for_constants/);
    CrudModel.flushAllLocal();
    const again = await RepoObjects.syncRepository(await desc(), "hub");
    assert.equal(again.updated, 0, JSON.stringify(again));
  });

  test("a credential not there yet : it waits ; a secret in the file is refused", async () => {
    writeList([entry("forms", { credential: "missing" }), entry("tok", { uri: "https://bot:tok123@git.example.com/x.git" }), entry("pw", { password: "${PW}" })]);
    process.env.PW = "x";
    const summary = await RepoObjects.syncRepository(await desc(), "hub");
    assert.match(summary.waiting[0].reasons[0], /waits for the credential 'missing'/);
    const why = summary.refused.map((r) => `${r.file}: ${r.reasons.join(" ")}`).join("\n");
    assert.match(why, /repositories.yaml#tok: uri must not carry a user or a token/);
    assert.match(why, /repositories.yaml#pw: user and password are refused/);
  });

  test("an entry gone : never a repository with changes not pushed yet, kept and said", async () => {
    writeList([entry("forms")]);
    await RepoObjects.syncRepository(await desc(), "hub");
    unpushed.add("forms");
    writeList([]);
    const summary = await RepoObjects.syncRepository(await desc(), "hub");
    assert.equal(summary.deleted, 0);
    assert.ok(fx.rowNamed("repositories", "forms"));
    assert.match(summary.refused[0].reasons[0], /'forms' has changes not pushed yet/);
  });

  test("no repositories.yaml, or one that is no list : nothing changes", async () => {
    writeList([entry("forms")]);
    await RepoObjects.syncRepository(await desc(), "hub");
    fs.writeFileSync(path.join(fx.ROOT, "hub", "repositories.yaml"), "repositories: nope\n");
    const broken = await RepoObjects.syncRepository(await desc(), "hub");
    assert.equal(broken.deleted, 0);
    assert.match(broken.refused[0].reasons[0], /'repositories' must be a list/);
    fs.rmSync(path.join(fx.ROOT, "hub", "repositories.yaml"));
    assert.equal((await RepoObjects.syncRepository(await desc(), "hub")).deleted, 0);
    assert.ok(fx.rowNamed("repositories", "forms"));
  });
});

describe("the app's repositories to repositories.yaml", () => {
  test("turned on : written to it, never the holder ; an edit and a delete follow", async () => {
    fx.cloneEmpty("hub");
    fx.state.tables.repositories.push({ id: 5, name: "forms", uri: "https://git/forms.git", branch: "main", use_for_forms: 1, description: "", password: "enc:old" });
    const p = await RepoObjects.preview(await desc(), "hub");
    assert.deepEqual(p.written, ["forms"]);
    assert.deepEqual(p.kept, [{ name: "hub", reason: "it holds the repositories itself, never in its own file", code: "holder" }]);
    await RepoObjects.activate(await desc(), "hub", { pull: false });
    assert.deepEqual(readList(), [{ name: "forms", uri: "https://git/forms.git", branch: "main", use_for_forms: true }]);
    const before = { ...fx.rowNamed("repositories", "forms") };
    fx.rowNamed("repositories", "forms").branch = "dev";
    CrudModel.flushAllLocal();
    await RepoObjects.appUpdated("repositories", before, 5);
    assert.equal(readList()[0].branch, "dev");
    await RepoObjects.appDeleted("repositories", fx.rowNamed("repositories", "forms"));
    assert.deepEqual(readList(), []);
  });

  test("the question asked before the flag is saved : the repository asked about is the holder, never written", async () => {
    fx.cloneEmpty("hub");
    fx.rowNamed("repositories", "hub").use_for_repositories = 0;
    fx.state.tables.repositories.push({ id: 5, name: "forms", uri: "https://git/forms.git", branch: "main", use_for_forms: 1, description: "" });
    CrudModel.flushAllLocal();
    const p = await RepoObjects.preview(await desc(), "hub");
    assert.deepEqual(p.written, ["forms"]);
    assert.deepEqual(p.kept, [{ name: "hub", reason: "it holds the repositories itself, never in its own file", code: "holder" }]);
  });

  test("the order : the credentials, then the repositories, then every other type", async () => {
    assert.deepEqual(types.APPLY_ORDER.slice(0, 2), ["credentials", "repositories"]);
    assert.deepEqual(types.USAGE_TYPES.filter((t) => t.category === "connections").map((t) => t.key), [
      "repositories",
      "credentials",
      "secret_stores",
      "runners",
      "notifications",
      "chat_assistant",
      "mcp",
      "syslog",
    ]);
    assert.equal(types.USAGE_FLAGS.length, 24);
    // the files follow the labels ; the seed's sections keep their names, one format for both
    const chat = await RepoObjects.descriptorOf("chat_assistant");
    const notifications = await RepoObjects.descriptorOf("notifications");
    assert.equal(chat.file, "chat-assistant.yaml");
    assert.equal(notifications.folder, "notifications");
    const { itemValidator, chatFileItem } = await import("../src/lib/seed-schema.js");
    assert.deepEqual(notifications.keyOrder, itemValidator("notification_channels").keys);
    assert.deepEqual(chat.keyOrder, itemValidator(chatFileItem).keys);
  });
});
