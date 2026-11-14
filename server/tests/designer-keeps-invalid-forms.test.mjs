// A designer save never removes a form it did not mean to remove. The loader leaves out a form
// failing validation, so the designer never has it ; the save rewrote the file from the forms
// the designer sent, and a save of ANOTHER form of the same file dropped it - from the file,
// and from git at the next push. Such a form is now written back exactly as it was, in its
// place ; only the forms the user edited or deleted change.
import { describe, test, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import yaml from "yaml";

vi.setConfig({ testTimeout: 30000 });

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const dirs = vi.hoisted(() => {
  const nodeFs = require("fs");
  const nodeOs = require("os");
  const nodePath = require("path");
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "af-keep-"));
  return { root, forms: nodePath.join(root, "forms"), config: nodePath.join(root, "config.yaml") };
});

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
vi.mock("../config/app.config.js", () => ({
  default: { formsFolderPath: dirs.forms, configPath: dirs.config, formsBackupPath: path.join(dirs.root, "backups"), formsStagingPath: path.join(dirs.root, "staging"), repoPath: path.join(dirs.root, "repos") },
}));
// local mode : no forms repository, the base config in a file
vi.mock("../src/models/repository.model.js", () => ({
  default: { getFormsFolders: async () => [], getConfigPath: async () => null, claimForWrite: async () => null, releaseWrite: async () => {} },
}));
vi.mock("../src/models/settings.model.js", () => ({
  default: { findConfigYaml: async () => ({}), resolveConfigInDatabase: () => false, getActiveConfig: async () => "" },
}));

const { default: Form } = await import("../src/models/form.model.js");
// the snapshot before a save is not what is tested here
Form.backup = async () => null;

const roles = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const categories = [{ name: "Default", icon: "bars" }];
const save = (forms) => Form.save({ forms: yaml.stringify({ categories, roles, constants: {}, forms }) });
const read = (file) => fs.readFileSync(path.join(dirs.forms, file), "utf8");

// a file of three forms : the subform in the middle fails validation (a subform has no roles)
const invalidEntry = "# the rows of a deploy, still being written\n- name: Rows\n  type: subform\n  roles:   [ default ]   # not allowed on a subform\n  fields:\n    - name: host\n      type: text\n";
const fileText = "- name: Deploy\n  type: ansible\n  playbook: deploy.yaml\n  roles: [default]\n  categories: []\n  fields: []\n\n" + invalidEntry + "\n- name: Remove\n  type: ansible\n  playbook: remove.yaml\n  roles: [default]\n  categories: []\n  fields: []\n";
const deploy = (extra = {}) => ({ name: "Deploy", type: "ansible", playbook: "deploy.yaml", roles: ["default"], categories: [], fields: [], source: "deploy.yaml", ...extra });
const remove = { name: "Remove", type: "ansible", playbook: "remove.yaml", roles: ["default"], categories: [], fields: [], source: "deploy.yaml" };

describe("a file of several forms, one of them failing validation", () => {
  beforeEach(() => {
    fs.rmSync(dirs.forms, { recursive: true, force: true });
    fs.mkdirSync(dirs.forms, { recursive: true });
    fs.writeFileSync(path.join(dirs.forms, "deploy.yaml"), fileText);
  });

  test("the subform really does not load, so the designer never has it", async () => {
    const loaded = (await Form.load(undefined, undefined, true));
    expect(loaded.forms.map((f) => f.name).sort()).toEqual(["Deploy", "Remove"]);
    expect(loaded.errors.join("\n")).toMatch(/Failed to validate form 'Rows'/);
  });

  test("saving another form of the file keeps it byte for byte, in its place", async () => {
    await save([deploy({ description: "edited" }), remove]);
    const text = read("deploy.yaml");
    expect(text).toContain(invalidEntry);
    const names = yaml.parse(text).map((f) => f.name);
    expect(names).toEqual(["Deploy", "Rows", "Remove"]);
    expect(yaml.parse(text)[0].description).toBe("edited");
  });

  test("deleting a valid form of the file keeps it", async () => {
    await save([deploy()]);
    const text = read("deploy.yaml");
    expect(text).toContain(invalidEntry);
    expect(yaml.parse(text).map((f) => f.name)).toEqual(["Deploy", "Rows"]);
  });

  test("deleting every form the designer had keeps the file, with that form only", async () => {
    fs.writeFileSync(path.join(dirs.forms, "other.yaml"), yaml.stringify({ ...deploy(), name: "Other", source: undefined }));
    await save([{ ...deploy(), name: "Other", source: "other.yaml" }]);
    const text = read("deploy.yaml");
    expect(text).toContain(invalidEntry);
    expect(yaml.parse(text).map((f) => f.name)).toEqual(["Rows"]);
  });

  test("a file holding only forms that do not load is left as it is", async () => {
    fs.writeFileSync(path.join(dirs.forms, "deploy.yaml"), invalidEntry);
    fs.writeFileSync(path.join(dirs.forms, "other.yaml"), yaml.stringify({ ...deploy(), name: "Other", source: undefined }));
    await save([{ ...deploy(), name: "Other", source: "other.yaml" }]);
    expect(read("deploy.yaml")).toBe(invalidEntry);
  });

  test("editing the invalid form itself, still invalid, is refused with the reason (400) and writes nothing", async () => {
    // valid for the designer's schema check, but removed in 7.0.0 for the loader : it would not load either
    const rows = { name: "Rows", type: "subform", fields: [{ name: "host", type: "text" }], source: "deploy.yaml" };
    const spy = vi.spyOn(Form, "validateForm").mockImplementation((f) => {
      if (f?.name === "Rows") throw new Error("Rows is still broken");
      return f;
    });
    const err = await save([deploy(), rows, remove]).catch((e) => e);
    spy.mockRestore();
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Form 'Rows' is not valid: Rows is still broken/);
    expect(read("deploy.yaml")).toBe(fileText);
  });

  test("editing the invalid form into a valid one replaces it", async () => {
    const rows = { name: "Rows", type: "subform", fields: [{ name: "host", type: "text" }], source: "deploy.yaml" };
    await save([deploy(), rows, remove]);
    const forms = yaml.parse(read("deploy.yaml"));
    expect(forms.map((f) => f.name)).toEqual(["Deploy", "Rows", "Remove"]);
    expect(forms[1].roles).toBeUndefined();
  });
});

describe("the save endpoint", () => {
  test("answers that refusal as a 400 with its reason, not a 500", async () => {
    vi.resetModules();
    vi.doMock("../src/models/lock.model.js", () => ({
      default: { status: async () => ({ free: false, match: true }), set: async () => {}, delete: async () => {} },
    }));
    const Errors = (await import("../src/lib/errors.js")).default;
    vi.doMock("../src/models/form.model.js", () => {
      class FormMock { constructor(body) { this.forms = body.forms; } }
      FormMock.parse = (d) => yaml.parse(d.forms);
      FormMock.save = async () => { throw new Errors.BadRequestError("Form 'Rows' is not valid: still broken"); };
      return { default: FormMock };
    });
    const controller = (await import("../src/controllers/v2/config.controller.js")).default;
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const user = { username: "dee", roles: ["admin"], options: { showDesigner: true } };
    await controller.save({ body: { forms: yaml.stringify({ roles, forms: [] }) }, user: { user }, ip: "127.0.0.1", headers: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.details).toMatch(/Form 'Rows' is not valid/);
  });
});
