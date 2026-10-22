// The designer's forms save (POST /api/v2/config, Form.save) never writes a form file onto a file a
// usage type of its repository owns (lib/repoObjects/ownedPaths.js) : a forms repository serving its
// forms from its root, used for the roles as well, took a form saved as roles.yaml over its roles.
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

// one repository, 'ops' : its forms at its root (no forms folder), and the roles
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-designer-owned-"));
const OPS = { name: "ops", status: "success", head: "abc", use_for_forms: 1, use_for_roles: 1, use_for_categories: 0, use_for_constants: 0 };
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => {
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_forms/.test(sql)) return [OPS];
      if (/SELECT name, use_for_roles, use_for_categories, use_for_constants FROM/.test(sql)) return [OPS];
      if (/WHERE use_for_roles OR use_for_categories OR use_for_constants/.test(sql)) return [OPS];
      if (/^SELECT \* FROM AnsibleForms\.`repositories` WHERE name = \?/.test(sql)) return [OPS];
      return [];
    },
  },
}));
vi.mock("../src/models/repo.model.js", () => {
  const folderOf = (name) => path.join(ROOT, name);
  return { default: { folderOf, isValidName: () => true }, repoFolder: folderOf };
});
vi.mock("../src/models/settings.model.js", () => ({ default: { findFormsYaml: async () => ({}), resolveConfigInDatabase: () => false, getActiveConfig: async () => "" } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: configController } = await import("../src/controllers/v2/config.controller.js");

const ROLES = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const ROLES_TEXT = YAML.stringify({ roles: ROLES });
const admin = { username: "admin", roles: ["admin"], options: { showDesigner: true, allowFormDesign: true } };
const form = (name, source) => ({ name, type: "ansible", playbook: "x.yaml", roles: ["admin"], categories: [], fields: [], source });
const save = async (forms) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await configController.save({ user: { user: admin }, body: { forms: YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {}, forms }) }, ip: "::1" }, res);
  return res;
};
const ops = (file) => path.join(ROOT, "ops", file);

beforeEach(() => {
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "ops", ".git"), { recursive: true });
  fs.writeFileSync(ops("roles.yaml"), ROLES_TEXT);
  fs.writeFileSync(ops("deploy.yaml"), YAML.stringify(form("Deploy")));
  appConfig.configPath = path.join(ROOT, "config.yaml");
  appConfig.formsStagingPath = path.join(ROOT, "staging");
  appConfig.useYtt = false;
});

test("a form saved as roles.yaml is refused, saying why, and the roles stay as they are", async () => {
  const res = await save([form("Deploy", "deploy.yaml"), form("Escalate", "roles.yaml")]);
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.match(res.body.details, /The form file 'roles\.yaml' belongs to the roles of repository 'ops': save the form to another file/);
  assert.equal(fs.readFileSync(ops("roles.yaml"), "utf8"), ROLES_TEXT);
});

test("a form file of the repository's own still saves ; config.yaml, the roles may be read from, is refused too", async () => {
  const ok = await save([{ ...form("Deploy", "deploy.yaml"), description: "edited" }]);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(YAML.parse(fs.readFileSync(ops("deploy.yaml"), "utf8")).description, "edited");
  // config.yaml : the roles may be read from it too
  assert.equal((await save([form("Deploy", "deploy.yaml"), form("Other", "config.yaml")])).code, 409);
});
