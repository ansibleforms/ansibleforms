// A form name defined in two forms repositories : the loader keeps the copy of the folder read
// first and skips the other, so the designer never receives the skipped copy. A designer save
// rewriting the skipped copy's file (because another form of that file changed) wrote only the
// forms it was sent, and the skipped copy was dropped from its file - and from git at the next
// push. It is now kept in its place, exactly as it was, the way a form that does not load is
// (formsToKeep).
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-form-dup-save-"));
// the forms repositories as the database gives them back, in this order
let formsRepos = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => {
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_forms/.test(sql)) return formsRepos.map((name, i) => ({ id: i + 1, name, status: "success", head: "abc" }));
      return [];
    },
  },
}));
vi.mock("../src/models/repo.model.js", () => {
  const folderOf = (name) => path.join(ROOT, name);
  return { default: { folderOf, isValidName: () => true }, repoFolder: folderOf };
});
vi.mock("../src/models/settings.model.js", () => ({ default: { findConfigYaml: async () => ({}), resolveConfigInDatabase: () => false } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: Form } = await import("../src/models/form.model.js");

const BASE = path.join(ROOT, "config.yaml");
const ROLES = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const CATEGORIES = [{ name: "Default", icon: "bars" }];
const form = (name, description) => ({ name, type: "ansible", playbook: "x.yaml", description, roles: ["default"], categories: [], fields: [] });
const writeFile = (repo, file, text) => {
  fs.mkdirSync(path.join(ROOT, repo, "forms"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, repo, "forms", file), text);
};
const readFile = (repo, file) => fs.readFileSync(path.join(ROOT, repo, "forms", file), "utf8");
const save = (forms) => Form.save({ forms: YAML.stringify({ categories: CATEGORIES, roles: ROLES, constants: {}, forms }) });

// the team's file : its copy of Deploy (skipped, forms-ops is read first), with a comment, and a
// form of its own
const skippedEntry = "# the team's own deploy, kept apart\n- name: Deploy\n  type: ansible\n  playbook: x.yaml\n  description: team\n  roles: [default]\n  categories: []\n  fields: []\n";
const teamFile = skippedEntry + "\n" + YAML.stringify([form("Team Only", "team")]);

beforeEach(() => {
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  fs.writeFileSync(BASE, YAML.stringify({ categories: CATEGORIES, roles: ROLES, constants: {} }));
  appConfig.configPath = BASE;
  appConfig.formsStagingPath = path.join(ROOT, "staging");
  appConfig.useYtt = false;
  formsRepos = ["forms-ops", "forms-team"];
  writeFile("forms-ops", "deploy.yaml", YAML.stringify(form("Deploy", "ops")));
  writeFile("forms-team", "deploy.yaml", teamFile);
});

describe("a skipped copy of a form name, in a file with other forms", () => {
  test("the loader skips it, so the designer never has it", async () => {
    const { forms } = await Form.load(undefined, undefined, true);
    assert.deepEqual(forms.filter((f) => f.name === "Deploy").map((f) => [f.description, f.repository]), [["ops", "forms-ops"]]);
    assert.ok(forms.some((f) => f.name === "Team Only"));
  });

  test("saving another form of its file keeps it byte for byte, in its place", async () => {
    // what the designer sends : the copy used, and the team's form edited
    await save([
      { ...form("Deploy", "ops"), source: "deploy.yaml", repository: "forms-ops" },
      { ...form("Team Only", "team, edited"), source: "deploy.yaml", repository: "forms-team" },
    ]);
    const text = readFile("forms-team", "deploy.yaml");
    assert.ok(text.includes(skippedEntry), "the skipped copy is written back as it was");
    assert.deepEqual(YAML.parse(text).map((f) => [f.name, f.description]), [["Deploy", "team"], ["Team Only", "team, edited"]]);
    // the copy used is still forms-ops', the other still skipped
    const { forms } = await Form.load(undefined, undefined, true);
    assert.equal(forms.find((f) => f.name === "Deploy").description, "ops");
  });

  test("deleting the other form of its file deletes that form only, the skipped copy kept", async () => {
    await save([{ ...form("Deploy", "ops"), source: "deploy.yaml", repository: "forms-ops" }]);
    const text = readFile("forms-team", "deploy.yaml");
    assert.ok(text.includes(skippedEntry));
    assert.deepEqual(YAML.parse(text).map((f) => f.name), ["Deploy"]);
  });

  test("deleting the copy used leaves the skipped copy's file as it was", async () => {
    writeFile("forms-team", "deploy.yaml", skippedEntry);
    await save([{ ...form("Other", "ops"), source: "other.yaml", repository: "forms-ops" }]);
    assert.equal(fs.existsSync(path.join(ROOT, "forms-ops", "forms", "deploy.yaml")), false);
    assert.equal(readFile("forms-team", "deploy.yaml"), skippedEntry);
  });

  test("the copy used is saved as sent, and a form not skipped is still dropped when deleted", async () => {
    writeFile("forms-ops", "deploy.yaml", YAML.stringify([form("Deploy", "ops"), form("Ops Only", "ops")]));
    await save([
      { ...form("Deploy", "ops, edited"), source: "deploy.yaml", repository: "forms-ops" },
      { ...form("Team Only", "team"), source: "deploy.yaml", repository: "forms-team" },
    ]);
    // the used copy's file : as sent, Ops Only gone
    assert.deepEqual([].concat(YAML.parse(readFile("forms-ops", "deploy.yaml"))).map((f) => [f.name, f.description]), [["Deploy", "ops, edited"]]);
    // the skipped copy's file : untouched
    assert.deepEqual(YAML.parse(readFile("forms-team", "deploy.yaml")).map((f) => [f.name, f.description]), [["Deploy", "team"], ["Team Only", "team"]]);
  });
});
