// A form name defined in two forms repositories : the forms repositories read in one fixed order
// (the order they were added, as 7.3 read them, whatever order the database returns them in), so
// the same copy wins every time - in
// the list, a single form and the designer alike. The warning names both copies (the one used,
// the one skipped), and each repository involved says so in its pull output and on its page. A
// new form whose name another forms repository already defines is refused by the save.
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

// the repositories' working trees : a folder of the test's own
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-form-dups-"));
// the forms repositories as the database gives them back : in no particular order ; their ids (the
// order they were added in)
let formsRepos = [];
let ids = {};
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => {
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_playbooks/.test(sql)) return formsRepos.map((name) => ({ id: ids[name], name }));
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_forms/.test(sql)) return formsRepos.map((name) => ({ id: ids[name], name, status: "success", head: "abc" }));
      return [];
    },
  },
}));
vi.mock("../src/models/repo.model.js", () => {
  const folderOf = (name) => path.join(ROOT, name);
  return { default: { folderOf, isValidName: () => true }, repoFolder: folderOf };
});
vi.mock("../src/models/settings.model.js", () => ({ default: { findConfigYaml: async () => ({}), resolveConfigInDatabase: () => false } }));
// the warnings, recorded
const warnings = [];
vi.mock("./__mocks__/logger.js", async (importOriginal) => {
  const mock = await importOriginal();
  return { ...mock, default: { ...mock.default, warning: (m) => warnings.push(m) } };
});
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: Form } = await import("../src/models/form.model.js");
const { default: Repository, sortedByName, sortedById } = await import("../src/models/repository.model.js");

const BASE = path.join(ROOT, "config.yaml");
const ROLES = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const form = (name, description) => ({ name, type: "ansible", playbook: "x.yaml", description, roles: ["default"], categories: [], fields: [] });
const writeForm = (repo, file, obj) => {
  fs.mkdirSync(path.join(ROOT, repo, "forms"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, repo, "forms", file), YAML.stringify(obj));
};

beforeEach(() => {
  warnings.length = 0;
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  fs.writeFileSync(BASE, YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {} }));
  appConfig.configPath = BASE;
  appConfig.formsStagingPath = path.join(ROOT, "staging");
  appConfig.useYtt = false;
  ids = { "forms-ops": 1, "forms-team": 2, "forms-alone": 3 };
  writeForm("forms-team", "deploy.yaml", form("Deploy", "team"));
  writeForm("forms-ops", "deploy.yaml", form("Deploy", "ops"));
  writeForm("forms-ops", "other.yaml", form("Other", "ops"));
});

describe("the forms repositories in one fixed order", () => {
  test("in the order they were added, whatever order the database returns them in", async () => {
    for (const order of [["forms-team", "forms-ops"], ["forms-ops", "forms-team"]]) {
      formsRepos = order;
      assert.deepEqual((await Repository.getFormsFolders()).map((f) => f.name), ["forms-ops", "forms-team"]);
      assert.deepEqual((await Repository.findFormsRepositories()).map((r) => r.name), ["forms-ops", "forms-team"]);
      // not by name : the one added first, the one 7.3 read first
      ids = { "forms-team": 1, "forms-ops": 2 };
      assert.deepEqual((await Repository.getFormsFolders()).map((f) => f.name), ["forms-team", "forms-ops"]);
      ids = { "forms-ops": 1, "forms-team": 2 };
    }
    assert.deepEqual(sortedById([{ id: 3, name: "a" }, { id: 1, name: "c" }, { id: 2, name: "b" }]).map((r) => r.name), ["c", "b", "a"]);
    assert.deepEqual(sortedByName([{ name: "b" }, { name: "A" }, { name: "a" }]).map((r) => r.name), ["A", "a", "b"]);
  });

  test("the one added first wins, in the list, a single form and the designer alike", async () => {
    for (const [first, second, description] of [["forms-ops", "forms-team", "ops"], ["forms-team", "forms-ops", "team"]]) {
      ids = { [first]: 1, [second]: 2 };
      for (const order of [["forms-team", "forms-ops"], ["forms-ops", "forms-team"]]) {
        formsRepos = order;
        const list = await Form.load(["admin"]);
        assert.deepEqual(list.forms.filter((f) => f.name === "Deploy").map((f) => f.description), [description]);
        assert.equal((await Form.load(["admin"], "Deploy")).forms[0].description, description);
        const designer = await Form.load(["admin"], "", true);
        assert.deepEqual(designer.forms.filter((f) => f.name === "Deploy").map((f) => [f.description, f.repository]), [[description, first]]);
      }
    }
  });
});

describe("where the first one wins, the one added first", () => {
  test("the playbooks and the config.yaml of a forms repository : the one 7.3 read, not the first by name", async () => {
    ids = { "forms-team": 1, "forms-ops": 2 };
    formsRepos = ["forms-ops", "forms-team"];
    fs.writeFileSync(path.join(ROOT, "forms-ops", "config.yaml"), "roles: []\n");
    fs.writeFileSync(path.join(ROOT, "forms-team", "config.yaml"), "roles: []\n");
    assert.equal(await Repository.getAnsiblePath(), path.join(ROOT, "forms-team"));
    assert.equal(await Repository.getConfigPath(), path.join(ROOT, "forms-team", "config.yaml"));
  });
});

describe("the duplicate said, naming both copies", () => {
  const NOTICE = "Form 'Deploy' is defined twice: forms-ops/forms/deploy.yaml is used, forms-team/forms/deploy.yaml is skipped (form names must be unique across forms repositories)";

  test("in the load's warnings and the server log", async () => {
    formsRepos = ["forms-team", "forms-ops"];
    const list = await Form.load(["admin"]);
    assert.deepEqual(list.warnings, [NOTICE]);
    assert.ok(warnings.includes(NOTICE));
  });

  test("in the pull output and on the page of each repository involved, none for the others", async () => {
    formsRepos = ["forms-team", "forms-ops", "forms-alone"];
    writeForm("forms-alone", "solo.yaml", form("Solo", "alone"));
    assert.equal(await Form.duplicateLines("forms-ops"), `\nWarning: ${NOTICE}`);
    assert.equal(await Form.duplicateLines("forms-team"), `\nWarning: ${NOTICE}`);
    assert.equal(await Form.duplicateLines("forms-alone"), "");
    assert.deepEqual(await Form.duplicates("forms-team"), [
      { name: "Deploy", used: { repository: "forms-ops", place: "forms-ops/forms/deploy.yaml", roles: ["default"] }, skipped: { repository: "forms-team", place: "forms-team/forms/deploy.yaml", roles: ["default"] }, notice: NOTICE },
    ]);
    // the pull and the clone add them to their output ; the page reads them
    const model = fs.readFileSync(new URL("../src/models/repository.model.js", import.meta.url), "utf8");
    assert.equal(model.match(/output \+= await \(await formModel\(\)\)\.duplicateLines\(name\)/g).length, 2);
    const controller = fs.readFileSync(new URL("../src/controllers/v2/repository.controller.js", import.meta.url), "utf8");
    assert.match(controller, /repository\.formDuplicates = \(await Form\.duplicates\(repository\.name\)/);
    // a designer limited to the forms of their roles is told only of copies they reach
    const { duplicateShown } = await import("../src/lib/designerForms.js");
    const [d] = await Form.duplicates("forms-team");
    const limited = { roles: ["ops", "default"], options: { designAllForms: false } };
    assert.equal(duplicateShown(d, limited), true);
    assert.equal(duplicateShown({ ...d, skipped: { ...d.skipped, roles: ["team"] } }, limited), false);
    assert.equal(duplicateShown({ ...d, skipped: { ...d.skipped, roles: ["team"] } }, { roles: ["ops"], options: {} }), true);
  });
});

describe("a save that would define a form name twice", () => {
  const save = (forms) => Form.save({ forms: YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {}, forms }) });

  test("a new form whose name another forms repository defines : refused, saying where", async () => {
    formsRepos = ["forms-team", "forms-ops"];
    fs.rmSync(path.join(ROOT, "forms-team"), { recursive: true });
    writeForm("forms-team", "solo.yaml", form("Solo", "team"));
    // Deploy is forms-ops' : a new one in the staging folder is refused
    await assert.rejects(
      save([{ ...form("Solo", "team"), source: "solo.yaml", repository: "forms-team" }, { ...form("Deploy", "new"), source: "new-deploy.yaml" }, { ...form("Other", "ops"), source: "other.yaml", repository: "forms-ops" }]),
      /form names must be unique|Form names must be unique across forms repositories/i,
    );
    // a 409, saying where the name already is
    await assert.rejects(save([{ ...form("Deploy", "new"), source: "new-deploy.yaml" }]), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already in forms-ops\/forms\/deploy\.yaml/);
      return true;
    });
    // twice in what is saved : refused before, by the save's own check (assertUniqueFormNames)
    await assert.rejects(save([{ ...form("Other", "a"), source: "a.yaml" }, { ...form("Other", "b"), source: "b.yaml" }]), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /A form named 'Other' already exists/);
      return true;
    });
  });

  test("the copy used saved where it is, as before, the skipped one left alone", async () => {
    formsRepos = ["forms-team", "forms-ops"];
    const outcome = await save([
      { ...form("Deploy", "ops, edited"), source: "deploy.yaml", repository: "forms-ops" },
      { ...form("Other", "ops"), source: "other.yaml", repository: "forms-ops" },
    ]).then(() => null, (e) => e);
    assert.doesNotMatch(String(outcome?.message || ""), /unique|defined twice/i);
    assert.equal(YAML.parse(fs.readFileSync(path.join(ROOT, "forms-team", "forms", "deploy.yaml"), "utf8")).description, "team");
  });

  test("a skipped copy in a file with other forms : kept in its place when that file is saved", async () => {
    formsRepos = ["forms-team", "forms-ops"];
    writeForm("forms-team", "deploy.yaml", [form("Deploy", "team"), form("Team Only", "team")]);
    await save([
      { ...form("Deploy", "ops"), source: "deploy.yaml", repository: "forms-ops" },
      { ...form("Other", "ops"), source: "other.yaml", repository: "forms-ops" },
      { ...form("Team Only", "team, edited"), source: "deploy.yaml", repository: "forms-team" },
    ]);
    const team = YAML.parse(fs.readFileSync(path.join(ROOT, "forms-team", "forms", "deploy.yaml"), "utf8"));
    assert.deepEqual(team.map((f) => [f.name, f.description]), [["Deploy", "team"], ["Team Only", "team, edited"]]);
    // the copy used is still forms-ops', the other still skipped and said
    const { forms } = await Form.load(undefined, undefined, true);
    assert.equal(forms.find((f) => f.name === "Deploy").description, "ops");
  });
});

describe("a designer without designAllForms", () => {
  test("a name another forms repository defines : said taken, never where", async () => {
    formsRepos = ["forms-team", "forms-ops"];
    const data = { forms: YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {}, forms: [{ ...form("Deploy", "new"), source: "new-deploy.yaml" }] }) };
    await assert.rejects(Form.save(data, { conceal: true }), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, "The form name 'Deploy' is already taken");
      return true;
    });
  });
});
