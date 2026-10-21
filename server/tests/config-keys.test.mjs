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
vi.mock("../src/models/repository.model.js", async () => ({ default: { ...(await import("./fixtures/repoObjects.mjs")).repository, getConfigPath: async () => "", getFormsFolders: async () => [] } }));
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

// the base configuration : a file of the test's own
const BASE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-config-")), "config.yaml");
const writeRaw = (repo, file, obj) => {
  fs.mkdirSync(path.join(fx.ROOT, repo), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, repo, file), typeof obj === "string" ? obj : YAML.stringify(obj));
};
const readObj = (repo, file) => YAML.parse(fs.readFileSync(path.join(fx.ROOT, repo, file), "utf8"));
const read = (file) => fs.readFileSync(file, "utf8");

beforeEach(() => {
  warnings.length = 0;
  fx.reset({
    repositories: [
      { id: 1, name: "access", use_for_roles: 1 },
      { id: 2, name: "design", use_for_categories: 1, use_for_constants: 1 },
    ],
    settings: [{ id: 1, config_yaml: null, config_source: null }],
  });
  fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "base-role" }], categories: [{ name: "Base" }], constants: { base: 1 } }));
  appConfig.configPath = BASE;
});

describe("each key from its own file", () => {
  test("roles.yaml, categories.yaml, constants.yaml : read, laid over the base", async () => {
    writeRaw("access", "roles.yaml", { roles: [{ name: "admin" }] });
    writeRaw("design", "categories.yaml", { categories: [{ name: "Ops" }] });
    writeRaw("design", "constants.yaml", { constants: { env: "prod" } });
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
    assert.equal(keys.deprecationNotice(roles), "roles read from config.yaml: deprecated, move them to roles.yaml (config.yaml is no longer read in 8.0.0)");
    assert.deepEqual(await keys.repositoryDeprecations("access"), [{ key: "roles", file: "roles.yaml", notice: keys.deprecationNotice(roles) }]);
    assert.match(await keys.deprecationLines("access"), /^\nDeprecated: roles read from config.yaml/);
    // only its own key : the categories of that config.yaml are not the design repository's
    const doc = YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read));
    assert.deepEqual(doc.roles, [{ name: "old" }]);
    assert.deepEqual(doc.categories, [{ name: "Base" }]);
    writeRaw("access", "roles.yaml", { roles: [{ name: "new" }] });
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
    assert.deepEqual(readObj("design", "categories.yaml"), { categories: [{ name: "Ops" }] });
    assert.deepEqual(readObj("design", "constants.yaml"), { constants: { a: 1 } });
    assert.equal(rest.roles, undefined);
    // what no repository holds goes to the base, the base's other keys kept
    const base = YAML.parse(keys.mergeIntoBase(read(BASE), { extra: true }));
    assert.deepEqual(base.roles, [{ name: "base-role" }]);
    assert.equal(base.extra, true);
  });

  test("the claim of each repository is taken when the caller does not hold it", async () => {
    fx.cloneEmpty("access");
    await keys.writeConfigKeys({ roles: [] }, await keys.keySources(), { claim: true });
    assert.deepEqual(fx.state.calls, ["claim:access", "release:access"]);
  });
});

describe("the Config usage of before", () => {
  test("the schema patch sets the three flags on the repository that had use_for_config, once", async () => {
    fx.state.tables.repositories.push({ id: 3, name: "old", use_for_config: 1 });
    const { splitConfigUsage } = await import("../src/models/schema.model.js");
    assert.match(await splitConfigUsage(), /repository 'old' is now Roles, Categories and Constants/);
    assert.deepEqual(fx.rowNamed("repositories", "old"), { id: 3, name: "old", use_for_config: 0, use_for_roles: 1, use_for_categories: 1, use_for_constants: 1 });
    assert.equal(await splitConfigUsage(), null, "a second start changes nothing");
  });

  test("two that had it : the one 7.3 read (the lowest id) gets the three flags, the other none, said", async () => {
    fx.state.tables.repositories.push({ id: 9, name: "aaa-later", use_for_config: 1 }, { id: 4, name: "zzz-first", use_for_config: 1 });
    const { splitConfigUsage } = await import("../src/models/schema.model.js");
    assert.match(await splitConfigUsage(), /'zzz-first' is now Roles, Categories and Constants ; 'aaa-later' had it too/);
    assert.equal(fx.rowNamed("repositories", "zzz-first").use_for_roles, 1);
    assert.equal(fx.rowNamed("repositories", "aaa-later").use_for_roles, undefined);
    assert.equal(fx.rowNamed("repositories", "aaa-later").use_for_config, 0);
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

  test("the seed's use_for_config : a deprecated alias of the three, one repository at most each", async () => {
    const { foldConfigFlag, validateSeed } = await import("../src/lib/seed-schema.js");
    const repo = (name, flags) => ({ name, uri: "https://x/y.git", ...flags });
    const { doc, folded } = foldConfigFlag({ repositories: { items: [repo("cfg", { use_for_config: true }), repo("forms", { use_for_forms: true })] } });
    assert.deepEqual(folded, ["cfg"]);
    assert.deepEqual(doc.repositories.items[0], { use_for_roles: true, use_for_categories: true, use_for_constants: true, name: "cfg", uri: "https://x/y.git" });
    assert.throws(() => validateSeed({ repositories: { items: [repo("a", { use_for_config: true }), repo("b", { use_for_roles: true })] } }), /use_for_roles on more than one repository: a, b/);
  });
});
