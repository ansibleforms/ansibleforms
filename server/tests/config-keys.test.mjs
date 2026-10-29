// The roles, the categories and the constants, each held by a repository of its own usage type
// (lib/configKeys.js) : read from its own file (roles.yaml, categories.yaml, constants.yaml), else
// from config.yaml (deprecated, said once per load), the new file preferred when both are there ;
// written back to the file it was read from, or a new file of its own ; the Config usage of before
// split into the three by the schema patch, and the seed's use_for_config folded into them.
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

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo, repoFolder: (await import("./fixtures/repoObjects.mjs")).repo.folderOf }));
vi.mock("../src/models/repository.model.js", async () => ({ default: { ...(await import("./fixtures/repoObjects.mjs")).repository, getConfigPath: async () => "", getFormsFolders: async () => [], afterUsageChange: async () => null } }));
// the warnings, recorded : the server log of the models (aliased to the test logger) and of lib/
const warnings = [];
vi.mock("./__mocks__/logger.js", async (importOriginal) => {
  const mock = await importOriginal();
  return { ...mock, default: { ...mock.default, warning: (m) => warnings.push(m) } };
});
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const keys = await import("../src/lib/configKeys.js");
const appConfig = (await import("./__mocks__/app.config.js")).default;
// the models that import it as ./../../config/app.config.js read the real one
const realConfig = (await import("../config/app.config.js")).default;

// the base configuration : a file of the test's own
const BASE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-config-")), "config.yaml");
const writeRaw = (repo, file, obj) => {
  fs.mkdirSync(path.dirname(path.join(fx.ROOT, repo, file)), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, repo, file), typeof obj === "string" ? obj : YAML.stringify(obj));
};
const readObj = (repo, file) => YAML.parse(fs.readFileSync(path.join(fx.ROOT, repo, file), "utf8"));
const read = (file) => fs.readFileSync(file, "utf8");

beforeEach(() => {
  warnings.length = 0;
  // each test a node just started : no key file read yet
  keys.resetKeyReadsForTests();
  fx.reset({
    repositories: [
      { id: 1, name: "access", use_for_roles: 1 },
      { id: 2, name: "design", use_for_categories: 1, use_for_constants: 1 },
    ],
    settings: [{ id: 1, config_yaml: null, config_source: null }],
  });
  fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "base-role" }], categories: [{ name: "Base" }], constants: { base: 1 } }));
  appConfig.configPath = BASE;
  realConfig.configPath = BASE;
});

describe("each key from its own file", () => {
  test("roles.yaml, categories.yaml, constants.yaml : read, laid over the base", async () => {
    writeRaw("access", "roles.yaml", { controller_roles: [{ name: "admin" }] });
    writeRaw("design", "categories.yaml", { controller_categories: [{ name: "Ops" }] });
    writeRaw("design", "constants.yaml", { controller_constants: { env: "prod" } });
    const sources = await keys.keySources();
    assert.deepEqual(sources.map((s) => [s.key, s.repository, path.basename(s.path), s.deprecated]), [
      ["roles", "access", "roles.yaml", false],
      ["categories", "design", "categories.yaml", false],
      ["constants", "design", "constants.yaml", false],
    ]);
    const doc = YAML.parse(keys.composeConfig(read(BASE), sources, read));
    assert.deepEqual(doc.roles, [{ name: "admin" }]);
    assert.deepEqual(doc.categories, [{ name: "Ops" }]);
    assert.deepEqual(doc.constants, { env: "prod" });
  });

  test("no own file : config.yaml read, deprecated ; the new file preferred when both are there", async () => {
    writeRaw("access", "config.yaml", { roles: [{ name: "old" }], categories: [{ name: "Old" }] });
    let [roles] = await keys.keySources();
    assert.equal(path.basename(roles.path), "config.yaml");
    assert.equal(roles.deprecated, true);
    assert.equal(keys.deprecationNotice(roles), "roles read from config.yaml: deprecated, move them to a file of their own (controller_roles: in any file, roles.yaml for instance ; config.yaml is no longer read in 8.0.0)");
    assert.deepEqual(await keys.repositoryDeprecations("access"), [{ key: "roles", file: "roles.yaml", notice: keys.deprecationNotice(roles) }]);
    assert.match(await keys.deprecationLines("access"), /^\nDeprecated: roles read from config.yaml/);
    // only its own key : the categories of that config.yaml are not the design repository's
    const doc = YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read));
    assert.deepEqual(doc.roles, [{ name: "old" }]);
    assert.deepEqual(doc.categories, [{ name: "Base" }]);
    writeRaw("access", "roles.yaml", { controller_roles: [{ name: "new" }] });
    [roles] = await keys.keySources();
    assert.equal(path.basename(roles.path), "roles.yaml");
    assert.deepEqual(await keys.repositoryDeprecations("access"), []);
  });

  test("the base configuration read once per load : one deprecation notice, not one per request", async () => {
    writeRaw("access", "config.yaml", { roles: [{ name: "admin" }] });
    const { default: Form } = await import("../src/models/form.model.js");
    await Form.load(["admin"], "", false, true).catch(() => null);
    await Form.load(["admin"], "", false, true).catch(() => null);
    const notices = warnings.filter((w) => /roles read from config.yaml: deprecated/.test(w));
    assert.equal(notices.length, 1, warnings.join("\n"));
  });
});

describe("written back to the file it was read from", () => {
  test("config.yaml stays config.yaml (its other keys kept) ; a repository with neither file gets its own", async () => {
    writeRaw("access", "config.yaml", "# ours\nroles:\n  - name: old\ncategories:\n  - name: Old\n");
    fx.cloneEmpty("design");
    const sources = await keys.keySources();
    const { rest, repositories } = await keys.writeConfigKeys(
      { roles: [{ name: "admin" }], categories: [{ name: "Ops" }], constants: { a: 1 }, forms: undefined },
      sources,
      { claim: false },
    );
    assert.deepEqual(repositories.sort(), ["access", "design"]);
    const config = read(path.join(fx.ROOT, "access", "config.yaml"));
    assert.ok(config.startsWith("# ours\nroles:\n  - name: admin\n"), config);
    assert.match(config, /categories:\n {2}- name: Old/);
    assert.deepEqual(readObj("design", "categories.yaml"), { controller_categories: [{ name: "Ops" }] });
    assert.deepEqual(readObj("design", "constants.yaml"), { controller_constants: { a: 1 } });
    assert.equal(rest.roles, undefined);
    // what no repository holds goes to the base, the base's other keys kept
    const base = YAML.parse(keys.mergeIntoBase(read(BASE), { extra: true }));
    assert.deepEqual(base.roles, [{ name: "base-role" }]);
    assert.equal(base.extra, true);
  });

  test("a key whose repository is not cloned : not read, and a save of it refused, never written to the base", async () => {
    // access holds the roles but has no working copy (its clone failed)
    fx.cloneEmpty("design");
    const sources = await keys.keySources();
    const roles = sources.find((s) => s.key === "roles");
    assert.equal(roles.missing, true);
    // never read on this node : closed, never the base's
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), sources, read)).roles, [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }]);
    await assert.rejects(keys.writeConfigKeys({ roles: [{ name: "admin" }], categories: [] }, sources, { claim: false }), {
      status: 409,
      message: /The roles are held by repository 'access', which is not cloned/,
    });
    assert.equal(fs.existsSync(path.join(fx.ROOT, "design", "categories.yaml")), false, "nothing written");
    assert.deepEqual(YAML.parse(read(BASE)).roles, [{ name: "base-role" }]);
    // the keys it does not hold are still saved
    await keys.writeConfigKeys({ categories: [{ name: "Ops" }] }, sources, { claim: false });
    assert.deepEqual(readObj("design", "categories.yaml"), { controller_categories: [{ name: "Ops" }] });
  });

  test("the claim of each repository is taken when the caller does not hold it", async () => {
    fx.cloneEmpty("access");
    await keys.writeConfigKeys({ roles: [] }, await keys.keySources(), { claim: true });
    assert.deepEqual(fx.state.calls, ["claim:access", "release:access"]);
  });
});

describe("as it is written : its comments, a ytt template", () => {
  const COMMENTED = "# who may do what\nroles:\n  # the admins\n  - name: admin\n    groups:\n      - local/admins\n";

  test("the configuration shown has each key as its file writes it, and a save from it keeps the comments, the new ones too", async () => {
    writeRaw("access", "config.yaml", COMMENTED);
    const { default: Settings } = await import("../src/models/settings.model.js");
    const shown = await Settings.getActiveConfig();
    assert.match(shown, /# who may do what\nroles:\n {2}# the admins\n {2}- name: admin/);
    // the base's own keys and comments kept around it
    assert.match(shown, /categories:\n {2}- name: Base/);
    // a role added in the editor, with a comment of its own : the file keeps both
    const edited = shown.replace("      - local/admins\n", "      - local/admins\n  # the operators\n  - name: ops\n    groups:\n      - local/ops\n");
    await Settings.saveActiveConfig(edited, { ignoreDesignerLock: true });
    const file = read(path.join(fx.ROOT, "access", "config.yaml"));
    assert.match(file, /^# who may do what\nroles:\n {2}# the admins\n {2}- name: admin/);
    assert.match(file, /# the operators\n {2}- name: ops/);
    // the base unchanged : not written
    assert.deepEqual(YAML.parse(read(BASE)), { roles: [{ name: "base-role" }], categories: [{ name: "Base" }], constants: { base: 1 } });
  });

  test("a key file that is a ytt template : said templated, never written over, the same value saved left alone", async () => {
    const TEMPLATE = '#@ load("@ytt:data", "data")\ncontroller_constants:\n  env: #@ data.values.env\n';
    writeRaw("design", "constants.yaml", TEMPLATE);
    fx.cloneEmpty("access");
    const { default: Settings } = await import("../src/models/settings.model.js");
    assert.equal(await Settings.isTemplated(), true);
    // the configuration shown keeps the directive of the value
    assert.match(await Settings.getActiveConfig(), /env: #@ data\.values\.env/);
    const sources = await keys.keySources();
    // the designer sends every key : the constants as served (ytt's expansion here) are not written
    const served = { roles: [{ name: "base-role" }], categories: [{ name: "Base" }], constants: { env: "prod" } };
    await keys.writeConfigKeys({ ...served, roles: [{ name: "admin" }] }, sources, { claim: false, served });
    assert.equal(read(path.join(fx.ROOT, "design", "constants.yaml")), TEMPLATE);
    // changed : refused, nothing written
    await assert.rejects(keys.writeConfigKeys({ ...served, constants: { env: "dev" } }, sources, { claim: false, served }), {
      status: 409,
      message: /The constants are in design\/constants\.yaml, a ytt template: change them in git/,
    });
    assert.equal(read(path.join(fx.ROOT, "design", "constants.yaml")), TEMPLATE);
    // the base a ytt template : a key it holds changed is refused, unchanged it is not written
    const base = "#@ load(\"@ytt:data\", \"data\")\nextra: #@ data.values.extra\n";
    assert.equal(keys.mergeIntoBase(base, { extra: "x" }, { extra: "x" }), null);
    assert.throws(() => keys.mergeIntoBase(base, { extra: "y" }, { extra: "x" }), { status: 409, message: /The base configuration is a ytt template/ });
    // a key of a usage type (controller_syslog) : never written into a base configuration
    assert.throws(() => keys.mergeIntoBase("extra: 1\n", { extra: 1, controller_syslog: [{ name: "s" }] }, { extra: 1 }), {
      status: 403,
      message: /controller_syslog:, a key of the objects the app keeps in a repository/,
    });
    // a plain base : its comments kept, only the key changed written
    assert.equal(keys.mergeIntoBase("# ours\nextra: 1\nother: 2\n", { extra: 3, other: 2 }, { extra: 1, other: 2 }), "# ours\nextra: 3\nother: 2\n");
    fs.writeFileSync(BASE, base);
    assert.equal(await Settings.isTemplated(), true);
    fs.writeFileSync(BASE, "roles: []\n");
    fs.rmSync(path.join(fx.ROOT, "design", "constants.yaml"));
    assert.equal(await Settings.isTemplated(), false);
  });

  test("a save giving a key of a repository not cloned as it is served : not refused (the designer sends every key)", async () => {
    fx.cloneEmpty("design");
    const sources = await keys.keySources();
    const served = YAML.parse(keys.composeConfig(read(BASE), sources, read));
    assert.doesNotThrow(() => keys.assertKeysWritable(served, sources, served));
    const { rest } = await keys.writeConfigKeys({ ...served, categories: [{ name: "Ops" }] }, sources, { claim: false, served });
    assert.equal(rest.roles, undefined, "never written to the base in its place");
    assert.deepEqual(readObj("design", "categories.yaml"), { controller_categories: [{ name: "Ops" }] });
    assert.throws(() => keys.assertKeysWritable({ ...served, roles: [{ name: "admin" }] }, sources, served), { status: 409, message: /held by repository 'access', which is not cloned/ });
  });

  test("a designer backup restored : the keys a repository holds go back to its file, not into the base", async () => {
    writeRaw("access", "roles.yaml", "# the roles\ncontroller_roles:\n  - name: admin\n");
    fx.cloneEmpty("design");
    const backups = fs.mkdtempSync(path.join(os.tmpdir(), "af-config-backups-"));
    realConfig.formsBackupPath = backups;
    realConfig.formsFolderPath = path.join(backups, "forms-folder");
    realConfig.oldBackupDays = 3650;
    const { default: Form } = await import("../src/models/form.model.js");
    const name = await Form.backup(true);
    assert.ok(name);
    // changed since : in git and in the base
    writeRaw("access", "roles.yaml", "# the roles\ncontroller_roles:\n  - name: admin\n  - name: later\n");
    fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "base-role" }], categories: [{ name: "Base" }], constants: { base: 2 } }));
    await Form.restoreBackup(name, true);
    assert.equal(read(path.join(fx.ROOT, "access", "roles.yaml")), "# the roles\ncontroller_roles:\n  - name: admin\n");
    assert.deepEqual(YAML.parse(read(BASE)).roles, [{ name: "base-role" }], "the repository's roles not baked into the base");
    // the constants design holds (no file of its own yet) : given one, as a save would
    assert.deepEqual(readObj("design", "constants.yaml"), { controller_constants: { base: 1 } });
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).constants, { base: 1 });
  });
});

describe("the Config usage of before", () => {
  test("the schema patch sets the three flags on the repository that had use_for_config, once", async () => {
    fx.state.tables.repositories.push({ id: 3, name: "old", use_for_config: 1 });
    const { splitConfigUsage } = await import("../src/models/schema.model.js");
    assert.match(await splitConfigUsage(), /repository 'old' is now Roles, Categories and Constants/);
    assert.deepEqual(fx.rowNamed("repositories", "old"), { id: 3, name: "old", use_for_config: 0, use_for_roles: 1, use_for_categories: 1, use_for_constants: 1 });
    assert.equal(await splitConfigUsage(), null, "a second start changes nothing");
    // the schema model is a large module : its first import is slow on a loaded machine
  }, 30000);

  test("two that had it : the one 7.3 read (the lowest id) gets the three flags, the other none, said", async () => {
    fx.state.tables.repositories.push({ id: 9, name: "aaa-later", use_for_config: 1 }, { id: 4, name: "zzz-first", use_for_config: 1 });
    const { splitConfigUsage } = await import("../src/models/schema.model.js");
    assert.match(await splitConfigUsage(), /'zzz-first' is now Roles, Categories and Constants ; 'aaa-later' had it too/);
    assert.equal(fx.rowNamed("repositories", "zzz-first").use_for_roles, 1);
    assert.equal(fx.rowNamed("repositories", "aaa-later").use_for_roles, undefined);
    assert.equal(fx.rowNamed("repositories", "aaa-later").use_for_config, 0);
  });

  test("the configuration kept in the database : 7.3 read no repository, so none gets the flags, said", async () => {
    fx.state.tables.repositories.push({ id: 3, name: "old", use_for_config: 1 });
    fx.state.tables.settings = [{ id: 1, config_source: "database", config_yaml: "roles:\n  - name: db-role\n" }];
    const { splitConfigUsage } = await import("../src/models/schema.model.js");
    assert.match(await splitConfigUsage(), /kept in the database: the Config usage of 'old' was not read and is not given/);
    assert.equal(fx.rowNamed("repositories", "old").use_for_roles, undefined);
    assert.equal(fx.rowNamed("repositories", "old").use_for_config, 0);
    assert.equal(await splitConfigUsage(), null, "a second start changes nothing");
    // an empty database copy : 7.3 fell back to the repository's file, so it gets them
    fx.state.tables.repositories.push({ id: 4, name: "other", use_for_config: 1 });
    fx.state.tables.settings = [{ id: 1, config_source: "database", config_yaml: "  " }];
    assert.match(await splitConfigUsage(), /'other' is now Roles, Categories and Constants/);
  });

  test("a seed of 7.3 with use_for_config on two repositories : warned, the first one has the flags, never refused", async () => {
    const { foldConfigFlag, validateSeed } = await import("../src/lib/seed-schema.js");
    const repo = (name, flags) => ({ name, uri: "https://x/y.git", ...flags });
    const seed = { repositories: { items: [repo("one", { use_for_config: true }), repo("two", { use_for_config: true })] } };
    assert.equal(validateSeed(seed), true);
    const { doc, holder, dropped } = foldConfigFlag(seed);
    assert.equal(holder, "one");
    assert.deepEqual(dropped, ["two"]);
    assert.equal(doc.repositories.items[0].use_for_roles, true);
    assert.deepEqual(doc.repositories.items[1], { name: "two", uri: "https://x/y.git" });
  });

  test("a seed of 7.3 naming another use_for_config repository first than the one the patch chose : the patch's keeps them, the seed applied", async () => {
    fx.state.tables.repositories = [
      { id: 1, name: "aaa", use_for_config: 1, managed: 1 },
      { id: 2, name: "bbb", use_for_config: 1, managed: 1 },
    ];
    const { splitConfigUsage } = await import("../src/models/schema.model.js");
    await splitConfigUsage();
    const { foldConfigFlag } = await import("../src/lib/seed-schema.js");
    const { listSections } = await import("../src/lib/seed.js");
    const section = listSections.find((s) => s.key === "repositories");
    const repo = (name) => ({ name, uri: "https://x/y.git", branch: "main", use_for_config: true });
    for (const items of [[repo("bbb"), repo("aaa")], [repo("bbb")]]) {
      const { doc, holder, dropped } = foldConfigFlag({ repositories: { items } }, ["aaa"]);
      assert.equal(holder, "aaa");
      assert.deepEqual(dropped, ["bbb"]);
      // what the seed's update does with each : never refused
      for (const item of doc.repositories.items) await section.update({ ...item, managed: true }, fx.rowNamed("repositories", item.name));
      assert.equal(fx.rowNamed("repositories", "aaa").use_for_roles, 1);
      assert.ok(!Number(fx.rowNamed("repositories", "bbb").use_for_roles));
    }
    // the seed taking them off the one holding them : the next one declaring it gets them
    const moved = foldConfigFlag({ repositories: { items: [repo("bbb"), { ...repo("aaa"), use_for_config: false }] } }, ["aaa"]);
    assert.equal(moved.holder, "bbb");
    assert.deepEqual(moved.doc.repositories.items[1].use_for_roles, false);
  }, 30000);

  test("the seed's use_for_config : a deprecated alias of the three, one repository at most each", async () => {
    const { foldConfigFlag, validateSeed } = await import("../src/lib/seed-schema.js");
    const repo = (name, flags) => ({ name, uri: "https://x/y.git", ...flags });
    const { doc, folded } = foldConfigFlag({ repositories: { items: [repo("cfg", { use_for_config: true }), repo("forms", { use_for_forms: true })] } });
    assert.deepEqual(folded, ["cfg"]);
    assert.deepEqual(doc.repositories.items[0], { use_for_roles: true, use_for_categories: true, use_for_constants: true, name: "cfg", uri: "https://x/y.git" });
    assert.throws(() => validateSeed({ repositories: { items: [repo("a", { use_for_config: true }), repo("b", { use_for_roles: true })] } }), /use_for_roles on more than one repository: a, b/);
  });
});

describe("a key file with anchors, or one that is not read", () => {
  test("a 7.3 config.yaml whose roles name an anchor of its constants : laid as the values they read as", async () => {
    writeRaw("access", "config.yaml", "constants:\n  admins: &admins\n    - local/admin\nroles:\n  - name: admin\n    groups: *admins\n");
    const doc = YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read));
    assert.deepEqual(doc.roles, [{ name: "admin", groups: ["local/admin"] }]);
    assert.deepEqual(doc.constants, { base: 1 }, "the constants are not the access repository's");
  });

  test("a base whose replaced key has an anchor another key names : the base read as it was, that key replaced", async () => {
    writeRaw("design", "constants.yaml", { controller_constants: { env: "prod" } });
    // the roles' repository cloned without a roles file : the base's (not cloned, they would be closed)
    fx.cloneEmpty("access");
    const base = "constants: &c\n  base: 1\nextra: *c\n";
    const doc = YAML.parse(keys.composeConfig(base, await keys.keySources(), read));
    assert.deepEqual(doc, { constants: { env: "prod" }, extra: { base: 1 } });
  });

  test("a key file that is not read : its key as last read, else the base's ; said on its page and in its pull output", async () => {
    writeRaw("access", "roles.yaml", { controller_roles: [{ name: "admin" }] });
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).roles, [{ name: "admin" }]);
    // a top-level list, then not YAML at all : the roles last read stay
    for (const broken of ["- name: admin\n", "controller_roles: [\n", "controller_roles:\n  admin: {}\n"]) {
      writeRaw("access", "roles.yaml", broken);
      const doc = YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read));
      assert.deepEqual(doc.roles, [{ name: "admin" }], broken);
    }
    assert.match((await keys.repositoryKeyProblems("access"))[0].reason, /its roles must be a list/);
    assert.match(await keys.deprecationLines("access"), /\nNot read: roles\.yaml: its roles must be a list/);
    // never read before (a repository of its own) : the base's
    fx.rowNamed("repositories", "design").use_for_categories = 0;
    fx.state.tables.repositories.push({ id: 3, name: "late", use_for_categories: 1 });
    writeRaw("late", "categories.yaml", "- Ops\n");
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).categories, [{ name: "Base" }]);
    assert.deepEqual(await keys.repositoryKeyProblems("late"), [{ key: "categories", file: "categories.yaml", reason: "not a YAML dictionary" }]);
    // a save of its key : refused, the file never overwritten by halves
    const sources = await keys.keySources();
    assert.throws(() => keys.assertKeysWritable({ categories: [{ name: "New" }] }, sources, {}), {
      status: 409,
      message: /late\/categories\.yaml, which is not read \(not a YAML dictionary\): fix it in git/,
    });
    // a file of another name that cannot be read, seeming to give them : the same
    fs.rmSync(path.join(fx.ROOT, "late", "categories.yaml"));
    writeRaw("late", "team/cats.yml", "controller_categories: [\n");
    assert.match((await keys.repositoryKeyProblems("late"))[0].reason, /^not valid YAML/);
    assert.equal((await keys.repositoryKeyProblems("late"))[0].file, "team/cats.yml");
  });

  test("a key's own file without its key (a plain map, a typo) : not read, said ; config.yaml of before may leave keys out", async () => {
    writeRaw("design", "constants.yaml", { controller_constants: { env: "prod" } });
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).constants, { env: "prod" });
    // the plain map : the constants last read stay, never the base's
    writeRaw("design", "constants.yaml", { env: "test" });
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).constants, { env: "prod" });
    assert.deepEqual(await keys.repositoryKeyProblems("design"), [{ key: "constants", file: "constants.yaml", reason: "it does not give its constants (a top-level 'controller_constants:' key)" }]);
    // a typo in the roles' key : the roles last read (else closed), never the base's
    writeRaw("access", "roles.yaml", { role: [{ name: "everyone", groups: ["local/users"] }] });
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).roles.map((r) => r.name), ["admin", "default"]);
    assert.match(await keys.deprecationLines("access"), /\nNot read: roles\.yaml: it does not give its roles/);
    // config.yaml of before giving the roles only : read, the categories the base's
    fs.rmSync(path.join(fx.ROOT, "access", "roles.yaml"));
    writeRaw("access", "config.yaml", { roles: [{ name: "old" }] });
    fx.rowNamed("repositories", "access").use_for_categories = 1;
    fx.rowNamed("repositories", "design").use_for_categories = 0;
    assert.deepEqual(await keys.repositoryKeyProblems("access"), []);
    assert.deepEqual(YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).categories, [{ name: "Base" }]);
  });

  test("the forms load with a key file broken in git : the roles last read served, never a failure", async () => {
    fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "base-role", groups: [] }], categories: [{ name: "Default", icon: "bars" }], constants: {} }));
    writeRaw("access", "roles.yaml", { controller_roles: [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }] });
    const { default: Form } = await import("../src/models/form.model.js");
    assert.deepEqual((await Form.load(["admin"], "", false, true)).roles.map((r) => r.name), ["admin", "default"]);
    writeRaw("access", "roles.yaml", "- name: admin\n");
    assert.deepEqual((await Form.load(["admin"], "", false, true)).roles.map((r) => r.name), ["admin", "default"]);
  });
});

describe("the config seed's use_for_config, the configuration kept in the database", () => {
  test("7.3 served the database copy : no repository gets the flags, each said", async () => {
    const { foldConfigFlag } = await import("../src/lib/seed-schema.js");
    const repo = (name, flags) => ({ name, uri: "https://x/y.git", ...flags });
    const seed = { repositories: { items: [repo("cfg", { use_for_config: true }), repo("off", { use_for_config: false }), repo("forms", { use_for_forms: true })] } };
    const { doc, holder, dropped, folded } = foldConfigFlag(seed, [], { inDatabase: true });
    assert.equal(holder, null);
    assert.deepEqual(dropped, ["cfg", "off"]);
    assert.deepEqual(folded, []);
    assert.deepEqual(doc.repositories.items, [repo("cfg"), repo("off"), repo("forms", { use_for_forms: true })]);
  });
});

describe("the base configuration saved from a text while a repository holds a key", () => {
  const served = { categories: [{ name: "Default", icon: "bars" }], constants: { old: 1 }, roles: [{ name: "admin" }] };
  const base = "categories:\n  - name: Default\n    icon: bars\nconstants:\n  old: 1\n";
  const held = ["roles"];

  test("a key the text no longer gives : taken out of the base ; its new comments kept", async () => {
    const text = "# my categories\ncategories:\n  - name: Default # the main one\n    icon: bars\nroles:\n  - name: admin\n";
    const next = keys.mergeIntoBase(base, keys.withoutHeldKeys(YAML.parse(text), [{ key: "roles" }]), served, { text, held });
    assert.equal(next, "# my categories\ncategories:\n  - name: Default # the main one\n    icon: bars\n");
  });

  test("the text as served : nothing written ; a held key or one never served is never taken out", async () => {
    const text = "categories:\n  - name: Default\n    icon: bars\nconstants:\n  old: 1\nroles:\n  - name: admin\n";
    assert.equal(keys.mergeIntoBase(base, keys.withoutHeldKeys(YAML.parse(text), [{ key: "roles" }]), served, { text, held }), null);
    const withStale = `${base}roles:\n  - name: stale\n`;
    assert.equal(keys.mergeIntoBase(withStale, keys.withoutHeldKeys(YAML.parse(text), [{ key: "roles" }]), served, { text, held }), null);
    // the designer's save (no text, no held keys) : a key it leaves out stays
    assert.equal(keys.mergeIntoBase(base, { categories: served.categories }, served), null);
  });
});

describe("the config seed's use_for_config checked as it is applied", () => {
  const repo = (name, flags) => ({ name, uri: "https://x/y.git", ...flags });
  const seed = () => ({ repositories: { items: [repo("a", { use_for_config: true }), repo("b", { use_for_roles: true })] } });

  test("the configuration kept in the database, or another repository holding the keys : not refused", async () => {
    const { validateSeed, foldConfigFlag } = await import("../src/lib/seed-schema.js");
    assert.equal(validateSeed(seed(), { inDatabase: true }), true);
    assert.equal(validateSeed(seed(), { held: ["b"] }), true);
    assert.deepEqual(foldConfigFlag(seed(), ["b"]).dropped, ["a"]);
    // a fresh database : a would get the roles too, refused as before
    assert.throws(() => validateSeed(seed()), /use_for_roles on more than one repository: a, b/);
  });
});

describe("the config seed applied with use_for_config", () => {
  test("the configuration kept in the database : a seed whose other repository has use_for_roles starts", async () => {
    fx.state.tables.settings = [{ id: 1, config_source: "database", forms_yaml: "roles: []\n" }];
    // made on an earlier start : updated, the database's repository model is not the fixture's
    fx.state.tables.repositories = [
      { id: 1, name: "a", uri: "https://x/a.git", branch: "main", managed: 1 },
      { id: 2, name: "b", uri: "https://x/b.git", branch: "main", use_for_roles: 1, managed: 1 },
    ];
    const seedPath = path.join(path.dirname(BASE), "seed.yaml");
    fs.writeFileSync(seedPath, YAML.stringify({ repositories: { items: [{ name: "a", uri: "https://x/a.git", branch: "main", use_for_config: true }, { name: "b", uri: "https://x/b.git", branch: "main", use_for_roles: true }] } }));
    for (const config of [appConfig, realConfig]) config.configSeedPath = seedPath;
    try {
      const { applyConfigSeed, _resetSeedState } = await import("../src/lib/seed.js");
      _resetSeedState();
      // the sections after the repositories go to tables the fixture does not know : what matters
      // is that the validation let it through, and what the repositories' section applied
      const outcome = await applyConfigSeed().catch((e) => e);
      assert.doesNotMatch(String(outcome?.message ?? ""), /Seed file/);
      assert.ok(Number(fx.rowNamed("repositories", "b").use_for_roles));
      assert.ok(!Number(fx.rowNamed("repositories", "a").use_for_roles));
    } finally {
      for (const config of [appConfig, realConfig]) config.configSeedPath = undefined;
    }
  });
});

describe("the editor saved after a key file's anchors were laid as their values", () => {
  test("the keys not touched keep their text in the base : their comments, their aliases", async () => {
    // the constants held by a repository ; the base's roles name an anchor of the base's constants :
    // the configuration shown is the whole text as read, its comments and aliases gone
    const base = "# my config\ncategories:\n  # the ops team\n  - name: Ops # main\n    icon: bars\nconstants: &c\n  admins: &admins\n    - local/admins\nroles:\n  # admin role\n  - name: admin\n    groups: *admins\n";
    const sources = [{ key: "constants", repository: "design", path: "/x/constants.yaml", exists: true }];
    const shown = keys.composeConfig(base, sources, () => "controller_constants:\n  env: prod\n");
    assert.doesNotMatch(shown, /# admin role/);
    const served = YAML.parse(shown);
    // a category added, nothing else changed
    const text = shown.replace("icon: bars", "icon: bars\n  - name: Dev\n    icon: code");
    const next = keys.mergeIntoBase(base, keys.withoutHeldKeys(YAML.parse(text), sources), served, { text, servedText: shown, held: ["constants"] });
    assert.match(next, /roles:\n {2}# admin role\n {2}- name: admin\n {4}groups: \*admins\n/);
    assert.match(next, /^# my config\n/);
    assert.deepEqual(YAML.parse(next).categories, [{ name: "Ops", icon: "bars" }, { name: "Dev", icon: "code" }]);
    // only a comment changed : written as the text has it
    // the settings' editor : the same, the text it showed being the one served
    fx.rowNamed("repositories", "access").use_for_roles = 0;
    fs.writeFileSync(BASE, base);
    writeRaw("design", "constants.yaml", "controller_constants:\n  env: prod\n");
    const { default: Settings } = await import("../src/models/settings.model.js");
    const editor = await Settings.getActiveConfig();
    await Settings.saveActiveConfig(editor.replace("icon: bars", "icon: bars\n  - name: Dev\n    icon: code"), { ignoreDesignerLock: true });
    assert.match(read(BASE), /roles:\n {2}# admin role\n {2}- name: admin\n {4}groups: \*admins\n/);
    const commented = shown.replace("categories:", "# the teams\ncategories:");
    assert.match(keys.mergeIntoBase(base, keys.withoutHeldKeys(YAML.parse(commented), sources), served, { text: commented, servedText: shown, held: ["constants"] }), /# the teams\ncategories:/);
  });
});

describe("a config.yaml of before giving several keys, one of them not read", () => {
  // the roles and the categories of one config.yaml : each read and checked on its own, its last
  // good value its own
  const sources = (dir) => {
    const p = path.join(fx.ROOT, dir, "config.yaml");
    return [
      { key: "roles", repository: dir, path: p, exists: true, deprecated: true },
      { key: "categories", repository: dir, path: p, exists: true, deprecated: true },
    ];
  };
  const base = "roles:\n  - name: base-role\ncategories:\n  - name: Base\n";

  test("its roles broken : the roles last read, never the broken ones the categories' read of the same file kept", async () => {
    let file = "roles:\n  - name: admin\n    groups:\n      - local/admins\ncategories:\n  - name: Ops\n";
    const src = sources("legacy-roles");
    assert.deepEqual(YAML.parse(keys.composeConfig(base, src, () => file)).roles, [{ name: "admin", groups: ["local/admins"] }]);
    file = "roles:\n  admin:\n    groups:\n      - local/admins\ncategories:\n  - name: Ops\n";
    for (let i = 0; i < 3; i++) {
      const doc = YAML.parse(keys.composeConfig(base, src, () => file));
      assert.deepEqual(doc.roles, [{ name: "admin", groups: ["local/admins"] }], `read ${i + 1}`);
      assert.deepEqual(doc.categories, [{ name: "Ops" }]);
    }
  });

  test("its categories broken, its roles read : the categories last read, not the broken ones", async () => {
    let file = "roles:\n  - name: admin\ncategories:\n  - name: Ops\n";
    const src = sources("legacy-categories");
    keys.composeConfig(base, src, () => file);
    file = "roles:\n  - name: admin\ncategories:\n  Ops: {}\n";
    assert.deepEqual(YAML.parse(keys.composeConfig(base, src, () => file)).categories, [{ name: "Ops" }]);
  });
});

describe("a roles file never read on this node, broken", () => {
  test("closed : only the admin role of local/admins, never the base configuration's roles ; said so", async () => {
    fx.rowNamed("repositories", "access").use_for_roles = 0;
    fx.state.tables.repositories.push({ id: 3, name: "fresh-roles", use_for_roles: 1 });
    fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "admin", groups: ["corp/everyone"] }, { name: "default", groups: [] }], categories: [{ name: "Base" }] }));
    writeRaw("fresh-roles", "roles.yaml", "controller_roles:\n  admin: {}\n");
    const doc = YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read));
    assert.deepEqual(doc.roles, [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }]);
    assert.deepEqual(doc.categories, [{ name: "Base" }], "the other keys untouched");
    assert.match(await keys.deprecationLines("fresh-roles"), /the roles last read from it \(else only the admin role of local\/admins\) are used/);
    // the users : a member of corp/everyone is no admin, a local admin still is
    const { default: User } = await import("../src/models/user.model.js");
    const everyone = await User.getRolesAndOptions(["corp/everyone"], { username: "joe", type: "ldap" });
    assert.ok(!everyone.roles.includes("admin"));
    const local = await User.getRolesAndOptions(["local/admins"], { username: "admin", type: "local" });
    assert.ok(local.roles.includes("admin"));
  });

  test("the closed roles pass the base schema : the default role without groups, no option granting anything", async () => {
    const { default: Form } = await import("../src/models/form.model.js");
    const closed = keys.CONFIG_KEYS.find((k) => k.key === "roles").closed;
    // the set alone, laid over a base giving the other keys : valid
    const doc = { roles: JSON.parse(JSON.stringify(closed)), categories: [{ name: "Default", icon: "bars" }], constants: {} };
    assert.doesNotThrow(() => Form.validateConfig(doc));
    // the default role : no groups, no users, no options (nothing more than the app's defaults)
    const everyone = closed.find((r) => r.name === "default");
    assert.deepEqual(everyone.groups, []);
    assert.equal(everyone.options, undefined);
    assert.equal(everyone.users, undefined);
  });

  test("the whole configuration loads with the roles closed : the forms list and the configuration served, admin included", async () => {
    fx.rowNamed("repositories", "access").use_for_roles = 0;
    fx.state.tables.repositories.push({ id: 3, name: "fresh-roles", use_for_roles: 1 });
    fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "admin", groups: ["corp/everyone"] }, { name: "default", groups: [] }], categories: [{ name: "Default", icon: "bars" }], constants: {} }));
    // broken in git, never read on this node (a restart) : closed
    writeRaw("fresh-roles", "roles.yaml", "controller_roles:\n  - name: admin\n    groups: [local/admins\n");
    const { default: Form } = await import("../src/models/form.model.js");
    const config = await Form.load(["admin"], "", false, true);
    assert.deepEqual(config.roles.map((r) => r.name), ["admin", "default"]);
    assert.deepEqual(config.roles.find((r) => r.name === "admin").groups, ["local/admins"]);
    // its repository not cloned either : the same
    keys.resetKeyReadsForTests();
    fs.rmSync(path.join(fx.ROOT, "fresh-roles"), { recursive: true });
    assert.deepEqual((await Form.load(["admin"], "", false, true)).roles.map((r) => r.name), ["admin", "default"]);
  });
});

describe("a key file not there to read : gone from its repository, or its repository not cloned", () => {
  // the base keeps the roles of before the repository held them (a save never takes a held key out
  // of it) : bob was admin then, the repository's roles.yaml took that away
  const base = YAML.stringify({ roles: [{ name: "admin", users: ["local/bob"], groups: ["local/admins"] }, { name: "default" }], categories: [{ name: "Base" }], constants: { base: 1 } });
  const repoRoles = { controller_roles: [{ name: "admin", groups: ["local/admins"] }, { name: "default" }] };
  const holding = (name, flags = { use_for_roles: 1 }) => {
    fx.rowNamed("repositories", "access").use_for_roles = 0;
    fx.state.tables.repositories.push({ id: 3, name, ...flags });
  };
  const served = async () => YAML.parse(keys.composeConfig(base, await keys.keySources(), read));
  const admins = (doc) => doc.roles.find((r) => r.name === "admin").users || [];

  test("roles.yaml read, then deleted in git : the roles last read, never the base's ; said on its page and in its pull output", async () => {
    holding("moved-roles");
    writeRaw("moved-roles", "roles.yaml", repoRoles);
    assert.deepEqual(admins(await served()), []);
    fs.rmSync(path.join(fx.ROOT, "moved-roles", "roles.yaml"));
    assert.deepEqual((await served()).roles, repoRoles.controller_roles, "bob never admin again");
    assert.deepEqual(await keys.repositoryKeyProblems("moved-roles"), [{ key: "roles", file: "roles.yaml", reason: "no file of its repository gives controller_roles: any more" }]);
    assert.match(await keys.deprecationLines("moved-roles"), /\nNot read: roles\.yaml: no file of its repository gives controller_roles: any more - the roles last read from it/);
    // a save of the roles writes the file again
    await keys.writeConfigKeys({ roles: [{ name: "admin", groups: ["local/admins"] }] }, await keys.keySources(), { claim: false });
    assert.deepEqual(readObj("moved-roles", "roles.yaml"), { controller_roles: [{ name: "admin", groups: ["local/admins"] }] });
    assert.deepEqual(await keys.repositoryKeyProblems("moved-roles"), []);
  });

  test("the roles repository not cloned (a clone failing, a reset re-cloning it) : the roles last read, else closed", async () => {
    // never read on this node : closed, never the base's
    holding("uncloned-roles");
    assert.deepEqual((await served()).roles, [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }]);
    assert.deepEqual(await keys.repositoryKeyProblems("uncloned-roles"), [{ key: "roles", file: "roles.yaml", reason: "its repository is not cloned" }]);
    assert.match(await keys.deprecationLines("uncloned-roles"), /\nNot read: roles\.yaml: its repository is not cloned - the roles last read from it \(else only the admin role of local\/admins\)/);
    // read once, then its working copy gone while it is cloned again : the roles last read
    writeRaw("uncloned-roles", "roles.yaml", repoRoles);
    assert.deepEqual((await served()).roles, repoRoles.controller_roles);
    fs.rmSync(path.join(fx.ROOT, "uncloned-roles"), { recursive: true });
    assert.deepEqual((await served()).roles, repoRoles.controller_roles);
  });

  test("the categories and the constants : the same rule, the base's as their last resort", async () => {
    holding("gone-design", { use_for_categories: 1, use_for_constants: 1 });
    fx.rowNamed("repositories", "design").use_for_categories = 0;
    fx.rowNamed("repositories", "design").use_for_constants = 0;
    // never read, not cloned : the base's, said
    assert.deepEqual((await served()).categories, [{ name: "Base" }]);
    assert.deepEqual((await keys.repositoryKeyProblems("gone-design")).map((p) => p.reason), ["its repository is not cloned", "its repository is not cloned"]);
    // never there on this node : the base's, nothing said (the first save writes the file)
    fx.cloneEmpty("gone-design");
    assert.deepEqual((await served()).constants, { base: 1 });
    assert.deepEqual(await keys.repositoryKeyProblems("gone-design"), []);
    // read, then deleted in git : the ones last read
    writeRaw("gone-design", "categories.yaml", { controller_categories: [{ name: "Ops" }] });
    writeRaw("gone-design", "constants.yaml", { controller_constants: { env: "prod" } });
    assert.deepEqual((await served()).constants, { env: "prod" });
    fs.rmSync(path.join(fx.ROOT, "gone-design", "categories.yaml"));
    fs.rmSync(path.join(fx.ROOT, "gone-design", "constants.yaml"));
    const doc = await served();
    assert.deepEqual(doc.categories, [{ name: "Ops" }]);
    assert.deepEqual(doc.constants, { env: "prod" });
    assert.deepEqual((await keys.repositoryKeyProblems("gone-design")).map((p) => p.key), ["categories", "constants"]);
  });
});

describe("the roles, categories and constants the app writes : block style, never flow", () => {
  const FLOW_ROLES = "controller_roles: [{name: admin, groups: [local/admins], users: [root]}]\nnotes: [kept]\n";

  test("roles saved from their values (Settings > Roles) : their groups and users in block style, the file's other flow keys as written", async () => {
    writeRaw("access", "roles.yaml", FLOW_ROLES);
    fx.cloneEmpty("design");
    const sources = await keys.keySources();
    await keys.writeConfigKeys({ roles: [{ name: "admin", groups: ["local/admins", "corp/ops"], users: ["root"] }] }, sources, { claim: false });
    assert.equal(
      read(path.join(fx.ROOT, "access", "roles.yaml")),
      "controller_roles:\n  - name: admin\n    groups:\n      - local/admins\n      - corp/ops\n    users:\n      - root\nnotes: [kept]\n",
    );
    // a new key file, a dictionary with a list : the same
    await keys.writeConfigKeys({ categories: [{ name: "Ops", icon: "bars" }], constants: { hosts: ["a", "b"], db: { port: 1 } } }, sources, { claim: false });
    assert.equal(read(path.join(fx.ROOT, "design", "constants.yaml")), "controller_constants:\n  hosts:\n    - a\n    - b\n  db:\n    port: 1\n");
  });

  test("shown as the file writes them ; saved from the editor's text in flow style, written in block style", async () => {
    writeRaw("access", "roles.yaml", FLOW_ROLES);
    fx.cloneEmpty("design");
    const sources = await keys.keySources();
    const shown = keys.composeConfig(read(BASE), sources, read);
    assert.match(shown, /^roles: \[ ?\{ ?name: admin, groups: \[ ?local\/admins ?\], users: \[ ?root ?\] ?\} ?\]\n/m);
    const text = shown.replace(/users: \[ ?root ?\]/, "users: [root, bob]");
    await keys.writeConfigKeys(YAML.parse(text), sources, { claim: false, text, served: YAML.parse(shown) });
    assert.equal(
      read(path.join(fx.ROOT, "access", "roles.yaml")),
      "controller_roles:\n  - name: admin\n    groups:\n      - local/admins\n    users:\n      - root\n      - bob\nnotes: [kept]\n",
    );
    // the base saved from a text : a key it writes in block style too
    const base = keys.mergeIntoBase("# ours\nextra: 1\n", { extra: { hosts: ["a"] } }, { extra: 1 }, { text: "extra: {hosts: [a]}\n" });
    assert.equal(base, "# ours\nextra:\n  hosts:\n    - a\n");
  });
});
