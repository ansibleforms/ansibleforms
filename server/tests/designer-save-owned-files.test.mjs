// The designer's forms save (POST /api/v2/config, Form.save) never writes a form file onto a file a
// usage type of its repository owns (lib/repoObjects/ownedPaths.js) : a forms repository serving its
// forms from its root, used for the roles as well, took a form saved as roles.yaml over its roles. A
// new file is staged, and the next Push moves it into the forms repository : checked there too.
import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// one repository, 'ops' : its forms at its root (no forms folder), and the roles ; a test may add
// others (REPOS)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-designer-owned-"));
const OPS = { id: 1, name: "ops", status: "success", head: "abc", use_for_forms: 1, use_for_roles: 1, use_for_categories: 0, use_for_constants: 0 };
const REPOS = [];
const used = (flag) => REPOS.filter((r) => Number(r[flag]));
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, args = []) => {
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_forms/.test(sql)) return used("use_for_forms");
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_playbooks/.test(sql)) return used("use_for_playbooks");
      if (/SELECT name, use_for_roles, use_for_categories, use_for_constants FROM/.test(sql)) return [...REPOS];
      if (/WHERE use_for_roles OR use_for_categories OR use_for_constants/.test(sql)) return REPOS.filter((r) => r.use_for_roles || r.use_for_categories || r.use_for_constants);
      if (/^SELECT \* FROM AnsibleForms\.`repositories` WHERE name = \?/.test(sql)) return REPOS.filter((r) => r.name === args[0]);
      if (/^SELECT \* FROM AnsibleForms\.`repositories`$/.test(sql)) return [...REPOS];
      return [];
    },
  },
}));
vi.mock("../src/models/repo.model.js", () => {
  const folderOf = (name) => path.join(ROOT, name);
  return { default: { folderOf, isValidName: () => true }, repoFolder: folderOf };
});
vi.mock("../src/models/settings.model.js", () => ({ default: { findConfigYaml: async () => ({}), resolveConfigInDatabase: () => false, getActiveConfig: async () => "" } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));
// the forms model's own import of the configuration ('./../../config/app.config.js') : the mock too
vi.mock("../config/app.config.js", async () => await import("./__mocks__/app.config.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: configController } = await import("../src/controllers/v2/config.controller.js");

const ROLES = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const ROLES_TEXT = YAML.stringify({ roles: ROLES });
// the roles as their own file gives them
const ROLES_FILE = YAML.stringify({ controller_roles: ROLES });
const admin = { username: "admin", roles: ["admin"], options: { showDesigner: true, allowFormDesign: true } };
const form = (name, source) => ({ name, type: "ansible", playbook: "x.yaml", roles: ["admin"], categories: [], fields: [], source });
const save = async (forms) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await configController.save({ user: { user: admin }, body: { forms: YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {}, forms }) }, ip: "::1" }, res);
  return res;
};
const ops = (file) => path.join(ROOT, "ops", file);

beforeEach(() => {
  REPOS.splice(0, REPOS.length, { ...OPS });
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "ops", ".git"), { recursive: true });
  fs.writeFileSync(ops("roles.yaml"), ROLES_FILE);
  fs.writeFileSync(ops("deploy.yaml"), YAML.stringify(form("Deploy")));
  appConfig.configPath = path.join(ROOT, "config.yaml");
  appConfig.formsStagingPath = path.join(ROOT, "staging");
  appConfig.formsFolderPath = path.join(ROOT, "local", "forms");
  appConfig.formsBackupPath = path.join(ROOT, "backups");
  appConfig.useYtt = false;
});

test("a form saved as roles.yaml is refused, saying why, and the roles stay as they are", async () => {
  const res = await save([form("Deploy", "deploy.yaml"), form("Escalate", "roles.yaml")]);
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.match(res.body.details, /The form file 'roles\.yaml' belongs to the roles of repository 'ops': save the form to another file/);
  assert.equal(fs.readFileSync(ops("roles.yaml"), "utf8"), ROLES_FILE);
});

test("a form file of the repository's own still saves ; config.yaml, the roles may be read from, is refused even before it is there", async () => {
  const ok = await save([{ ...form("Deploy", "deploy.yaml"), description: "edited" }]);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(YAML.parse(fs.readFileSync(ops("deploy.yaml"), "utf8")).description, "edited");
  // config.yaml, the roles may be read from, not there yet : the new file would be staged, then
  // moved onto it by the next Push - refused as well, nothing staged
  const staged = await save([form("Deploy", "deploy.yaml"), form("Other", "config.yaml")]);
  assert.equal(staged.code, 409, JSON.stringify(staged.body));
  assert.match(staged.body.details, /'config\.yaml' belongs to the roles of repository 'ops'/);
  assert.equal(fs.existsSync(path.join(appConfig.formsStagingPath, "config.yaml")), false);
  assert.equal(fs.existsSync(ops("config.yaml")), false);
});

test("a form file outside its folder is refused : '../forms/roles.yaml' never reaches the next repository's roles", async () => {
  // 'ops' serves its forms from its root ; 'forms', beside it, holds the roles
  REPOS.splice(0, REPOS.length, { ...OPS, use_for_roles: 0 }, { id: 2, name: "forms", status: "success", head: "abc", use_for_forms: 0, use_for_roles: 1, use_for_categories: 0, use_for_constants: 0 });
  fs.rmSync(ops("roles.yaml"));
  fs.mkdirSync(path.join(ROOT, "forms", ".git"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "forms", "config.yaml"), ROLES_TEXT);
  const escalate = { ...form("Escalate", "../forms/roles.yaml"), roles: [{ name: "admin", groups: ["local/admins"], users: ["local/eve"] }] };
  const res = await save([form("Deploy", "deploy.yaml"), escalate]);
  assert.equal(res.code, 400, JSON.stringify(res.body));
  assert.match(res.body.details, /Invalid form source '\.\.\/forms\/roles\.yaml': must be a path inside the forms folder/);
  assert.equal(fs.existsSync(path.join(ROOT, "forms", "roles.yaml")), false);
  // a link committed in 'ops' to the next repository : checked where the file really lands
  fs.symlinkSync(path.join("..", "forms"), ops("sub"));
  const linked = await save([form("Deploy", "deploy.yaml"), form("Escalate", "sub/roles.yaml")]);
  assert.equal(linked.code, 409, JSON.stringify(linked.body));
  assert.match(linked.body.details, /The form file 'sub\/roles\.yaml' belongs to the roles of repository 'forms': save the form to another file/);
  assert.equal(fs.existsSync(path.join(ROOT, "forms", "roles.yaml")), false);
});

test("config.yaml serving the whole configuration (no repository holds the roles) is refused as a form file", async () => {
  // the 7.3 layout : the roles in the forms repository's config.yaml, no repository flagged for them
  REPOS.splice(0, REPOS.length, { ...OPS, use_for_roles: 0 });
  fs.rmSync(ops("roles.yaml"));
  fs.writeFileSync(ops("config.yaml"), ROLES_TEXT);
  const res = await save([form("Deploy", "deploy.yaml"), form("Escalate", "config.yaml")]);
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.match(res.body.details, /The form file 'config\.yaml' belongs to the configuration of repository 'ops'/);
  assert.equal(fs.readFileSync(ops("config.yaml"), "utf8"), ROLES_TEXT);
});

test("a playbook, the playbooks folder and the vars folder of a forms repository's root are not form files", async () => {
  REPOS.splice(0, REPOS.length, { ...OPS, use_for_playbooks: 1 });
  fs.mkdirSync(ops("playbooks"));
  fs.mkdirSync(ops("vars"));
  // a new form file in a folder of its own saves (staged, for the next Push)
  const ok = await save([form("Deploy", "deploy.yaml"), form("New", "team/new.yaml")]);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.match(fs.readFileSync(path.join(appConfig.formsStagingPath, "team", "new.yaml"), "utf8"), /name: New/);
  // a playbook at the root : a form named like one of its plays would replace that play
  const PLAYS = "- name: Site\n  hosts: all\n  tasks: []\n";
  fs.writeFileSync(ops("site.yml"), PLAYS);
  const play = await save([form("Deploy", "deploy.yaml"), form("Site", "site.yml")]);
  assert.equal(play.code, 409, JSON.stringify(play.body));
  assert.match(play.body.details, /The file 'site\.yml' holds no forms: save the form to another file/);
  assert.equal(fs.readFileSync(ops("site.yml"), "utf8"), PLAYS);
  // the playbooks folder, the vars folder : another usage's
  for (const folder of ["playbooks", "vars"]) {
    const res = await save([form("Deploy", "deploy.yaml"), form("New", `${folder}/new.yaml`)]);
    assert.equal(res.code, 409, JSON.stringify(res.body));
    assert.match(res.body.details, new RegExp(`The form file '${folder}/new\\.yaml' is in the playbooks or the vars files folder`));
    assert.equal(fs.existsSync(ops(`${folder}/new.yaml`)), false);
  }

});

test("the forms load of a repository serving its forms from its root never reads a file giving a type's key as forms", async () => {
  // ops holds labels and credentials as well : the files giving them (any name, any folder) and its
  // roles.yaml are theirs
  REPOS[0] = { ...OPS, use_for_labels: 1, use_for_credentials: 1 };
  fs.mkdirSync(ops("team/deep"), { recursive: true });
  fs.writeFileSync(ops("team/deep/branding.yml"), YAML.stringify({ controller_labels: [{ name: "prod", color: "red" }] }));
  fs.writeFileSync(ops("secrets.yaml"), YAML.stringify({ controller_credentials: [{ name: "git", credential_type: "git", user: "bot", password: "${GIT_PW}" }] }));
  const { default: Form } = await import("../src/models/form.model.js");
  const loaded = await Form.load(["admin"], "", true);
  assert.deepEqual(loaded.forms.map((f) => f.name), ["Deploy"]);
  assert.deepEqual(loaded.errors, [], "no file of the labels, the credentials or the roles read as a form");
  // the same usages turned off : a file giving a type's key is still no form, whatever the
  // repository holds ; a file giving none (a form without its type) is read, and said
  REPOS[0] = { ...OPS, use_for_roles: 0 };
  assert.deepEqual((await Form.load(["admin"], "", true)).errors, []);
  fs.writeFileSync(ops("broken.yaml"), YAML.stringify({ name: "broken", description: "no type" }));
  assert.match((await Form.load(["admin"], "", true)).errors.join("\n"), /no name|Failed to validate form/);
});

test("a configuration saved with a key of a usage type (controller_syslog:) : refused, nothing written", async () => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const planted = { categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {}, controller_syslog: [{ name: "s", host: "1.2.3.4" }], forms: [form("Deploy", "deploy.yaml")] };
  await configController.save({ user: { user: admin }, body: { forms: YAML.stringify(planted) }, ip: "::1" }, res);
  // the base configuration's schema refuses it first ; written past it, the configuration keys refuse it (config-keys)
  assert.ok([400, 403].includes(res.code), JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /controller_syslog/);
  assert.equal(fs.existsSync(appConfig.configPath), false);
});
