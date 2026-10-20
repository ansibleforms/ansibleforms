// The role option designAllForms (lib/designerForms.js) : with it on (the default, always for an
// admin) the designer shows and saves every form, as before ; off, only the forms of the user's
// roles - the subforms those use shown read only, a hidden form never named, a form saved keeping
// one of the user's roles, a file holding several forms keeping its hidden ones as they are.
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

// one forms repository, its working tree a folder of the test's own
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-designer-forms-"));
vi.mock("../src/models/db.model.js", () => ({
  default: { do: async (sql) => (/FROM AnsibleForms\.`repositories` WHERE use_for_forms/.test(sql) ? [{ name: "forms", status: "success", head: "abc" }] : []) },
}));
vi.mock("../src/models/repo.model.js", () => {
  const folderOf = (name) => path.join(ROOT, name);
  return { default: { folderOf, isValidName: () => true }, repoFolder: folderOf };
});
vi.mock("../src/models/settings.model.js", () => ({ default: { findConfigYaml: async () => ({}), resolveConfigInDatabase: () => false, getActiveConfig: async () => fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8") } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: Form } = await import("../src/models/form.model.js");
const { designsAllForms, designerConfig, designerSave, fileVisibility, designerListing, assertFileShown } = await import("../src/lib/designerForms.js");
const { default: ansibleConfig } = await import("../config/ansible.config.js");
const { default: ProjectFiles } = await import("../src/models/projectFiles.model.js");
const { listWorkflows } = await import("../src/models/workflowRun.js");
const { default: configController } = await import("../src/controllers/v2/config.controller.js");

const ROLES = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const form = (name, roles, extra = {}) => ({ name, type: "ansible", playbook: "x.yaml", roles, categories: [], fields: [], ...extra });
const OPS = form("Ops deploy", ["ops"], { fields: [{ name: "hosts", type: "list", subform: "Host row" }] });
const TEAM = form("Team deploy", ["team"]);
const SUB = { name: "Host row", type: "subform", fields: [{ name: "host", type: "text" }] };
const OPEN = form("Everyone", ["default"]);

const limited = { username: "olga", roles: ["ops", "default", "public"], options: { showDesigner: true, allowFormDesign: true, designAllForms: false } };
const everything = { ...limited, options: { ...limited.options, designAllForms: true } };
const admin = { username: "admin", roles: ["admin", "default"], options: { designAllForms: false } };
const names = (forms) => forms.map((f) => f.name);
const load = () => Form.load(undefined, undefined, true);
const call = async (handler, req) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
};

beforeEach(() => {
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  const dir = path.join(ROOT, "forms", "forms");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "forms", ".git"));
  fs.writeFileSync(path.join(ROOT, "config.yaml"), YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {} }));
  // one file holding a form of the user's, one hidden, one for everyone
  fs.writeFileSync(path.join(dir, "deploy.yaml"), YAML.stringify([OPS, TEAM, OPEN]));
  fs.writeFileSync(path.join(dir, "subforms.yaml"), YAML.stringify(SUB));
  appConfig.configPath = path.join(ROOT, "config.yaml");
  appConfig.formsStagingPath = path.join(ROOT, "staging");
  appConfig.useYtt = false;
});

describe("with designAllForms on (the default), and always for an admin", () => {
  test("every form shown and saved, as before", async () => {
    const config = await load();
    assert.equal(designsAllForms(everything), true);
    assert.equal(designsAllForms(admin), true, "an admin designs every form whatever a role says");
    assert.equal(designsAllForms({ roles: ["ops"], options: {} }), true, "absent is on");
    assert.deepEqual(names((await designerConfig(config, everything)).forms), names(config.forms));
    assert.deepEqual(names((await designerConfig(config, admin)).forms), names(config.forms));
    assert.deepEqual(designerSave(config.forms, config.forms, everything), config.forms);
  });
});

describe("with designAllForms off", () => {
  test("the designer's config : the forms of the user's roles, the subforms they use read only", async () => {
    const res = await call(configController.findAll, { user: { user: limited } });
    assert.equal(res.code, 200);
    const forms = res.body.forms;
    assert.deepEqual(names(forms).sort(), ["Everyone", "Host row", "Ops deploy"]);
    assert.equal(forms.find((f) => f.name === "Host row").readOnly, true);
    assert.equal(forms.find((f) => f.name === "Ops deploy").readOnly, undefined);
    // the hidden form is nowhere in the answer
    assert.doesNotMatch(JSON.stringify(res.body), /Team deploy/);
  });

  test("a save : the user's forms as sent, the hidden one kept in its file, in its place", async () => {
    const config = await designerConfig(await load(), limited);
    const sent = config.forms.map((f) => (f.name === "Ops deploy" ? { ...f, description: "edited" } : f));
    const saved = designerSave(sent, (await load()).forms, limited);
    assert.deepEqual(names(saved), ["Ops deploy", "Team deploy", "Everyone", "Host row"]);
    assert.equal(saved[0].description, "edited");
    assert.equal(saved[1].source, "deploy.yaml");
    assert.deepEqual(saved.find((f) => f.name === "Team deploy").roles, ["team"]);
    assert.equal(saved.some((f) => "readOnly" in f), false);
    // deleting the hidden form, or the read-only subform, from what is sent changes nothing for them
    const fewer = designerSave(sent.filter((f) => f.name !== "Host row"), (await load()).forms, limited);
    assert.ok(names(fewer).includes("Team deploy") && names(fewer).includes("Host row"));
  });

  test("the read-only subform changed : refused", async () => {
    const config = await designerConfig(await load(), limited);
    const sent = config.forms.map((f) => (f.name === "Host row" ? { ...f, fields: [] } : f));
    const stored = (await load()).forms;
    assert.throws(() => designerSave(sent, stored, limited), { status: 403, message: /The subform 'Host row' is read only here/ });
    // unchanged, as shown : it passes
    assert.ok(names(designerSave(config.forms, stored, limited)).includes("Host row"));
  });

  test("a form saved without one of the user's roles : refused, saying which to keep", async () => {
    const stored = (await load()).forms;
    const sent = [form("Mine", ["team"], { source: "mine.yaml" })];
    assert.throws(() => designerSave(sent, stored, limited), { status: 400, message: "Form 'Mine': keep one of your roles (ops, default, public) in its roles, or you would no longer see it" });
  });

  test("a hidden form's name : taken, nothing more said", async () => {
    const stored = (await load()).forms;
    let caught;
    try {
      designerSave([form("Team deploy", ["ops"], { source: "new.yaml" })], stored, limited);
    } catch (e) {
      caught = e;
    }
    assert.equal(caught.status, 409);
    assert.equal(caught.message, "The form name 'Team deploy' is already taken");
    assert.doesNotMatch(caught.message, /deploy\.yaml|forms\/|team\b/);
  });

  test("the whole save through the API keeps the hidden form in the file holding several", async () => {
    const config = await designerConfig(await load(), limited);
    const forms = config.forms.map((f) => (f.name === "Ops deploy" ? { ...f, description: "edited" } : f));
    const body = { forms: YAML.stringify({ categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {}, forms }) };
    const res = await call(configController.save, { user: { user: limited }, body, ip: "::1" });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    const file = YAML.parse(fs.readFileSync(path.join(ROOT, "forms", "forms", "deploy.yaml"), "utf8"));
    assert.deepEqual(file.map((f) => f.name), ["Ops deploy", "Team deploy", "Everyone"]);
    assert.equal(file[0].description, "edited");
    assert.ok(file.some((f) => f.name === "Team deploy" && f.roles[0] === "team"), JSON.stringify(file));
  });

  test("a backup restore : refused, it replaces every form", async () => {
    const res = await call(configController.restore, { user: { user: limited }, params: { backupName: "x" }, query: {} });
    assert.equal(res.code, 403);
  });
});

// ─── the playbooks and the workflows ───────────────────────────────────────────
describe("designAllPlaybooks and designAllWorkflows : what the user's forms use, and what no form uses", () => {
  const write = (dir, file, text) => {
    fs.mkdirSync(path.dirname(path.join(ROOT, dir, file)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, dir, file), text);
  };
  const flow = (name, nodes) =>
    YAML.stringify({
      workflow_job_templates: [
        { name, related: { workflow_nodes: nodes.map(([type, ref], i) => ({ identifier: `n${i}`, unified_job_template: { type, name: ref } })) } },
      ],
    });
  const files = async (kind, user) => (await designerListing(kind, await ProjectFiles.list(kind), user)).files.map((f) => f.path).sort();
  const opts = (o) => ({ ...limited, options: { ...limited.options, designAllForms: true, ...o } });

  beforeEach(() => {
    ansibleConfig.path = path.join(ROOT, "playbooks");
    appConfig.workflowsPath = path.join(ROOT, "workflows");
    // Ops deploy runs x.yaml (the fixture's) ; a playbook form of team's, two workflow forms
    fs.writeFileSync(
      path.join(ROOT, "forms", "forms", "flows.yaml"),
      YAML.stringify([
        form("Team play", ["team"], { playbook: "team.yml" }),
        form("Ops steps", ["ops"], { type: "multistep", playbook: undefined, steps: [{ type: "ansible", name: "one", playbook: "step.yml" }] }),
        form("Team steps", ["team"], { type: "multistep", playbook: undefined, steps: [{ type: "ansible", name: "one", playbook: "team-step.yml" }] }),
        { name: "Ops flow", type: "workflow", workflow: "main.yml", roles: ["ops"], categories: [], fields: [] },
        { name: "Team flow", type: "workflow", workflow: "Team flow", roles: ["team"], categories: [], fields: [] },
      ]),
    );
    for (const f of ["x.yaml", "team.yml", "step.yml", "team-step.yml", "wf-play.yml", "nested-play.yml", "team-node.yml", "team-nested-play.yml", "free.yml"]) write("playbooks", f, "- hosts: all\n");
    write("workflows", "main.yml", flow("Main", [["job_template", "wf-play.yml"], ["workflow_job_template", "Nested"]]));
    write("workflows", "sub/nested.yml", flow("Nested", [["job_template", "nested-play.yml"]]));
    write("workflows", "team.yml", flow("Team flow", [["job_template", "team-node.yml"], ["workflow_job_template", "team-nested.yml"]]));
    write("workflows", "team-nested.yml", flow("Team nested", [["job_template", "team-nested-play.yml"]]));
    write("workflows", "free.yml", flow("Free", [["job_template", "free.yml"]]));
  });

  test("on by default, and always for an admin : every file", async () => {
    assert.equal(await fileVisibility("playbooks", everything), null);
    assert.equal(await fileVisibility("workflows", admin), null);
    assert.equal(await fileVisibility("playbooks", { ...admin, options: { designAllPlaybooks: false } }), null);
    assert.equal(await fileVisibility("vars", opts({ designAllPlaybooks: false })), null, "the other kinds stay whole");
    assert.equal((await files("playbooks", everything)).length, 9);
  });

  test("off, designAllForms on : every used one counts, the unused ones shown too", async () => {
    assert.deepEqual(await files("playbooks", opts({ designAllPlaybooks: false })), [
      "free.yml",
      "nested-play.yml",
      "step.yml",
      "team-nested-play.yml",
      "team-node.yml",
      "team-step.yml",
      "team.yml",
      "wf-play.yml",
      "x.yaml",
    ]);
  });

  test("off with designAllForms off : the playbooks of the user's forms (their steps and their workflows' nodes, nested), and the unused ones", async () => {
    const user = { ...limited, options: { ...limited.options, designAllPlaybooks: false, designAllWorkflows: false } };
    assert.deepEqual(await files("playbooks", user), ["free.yml", "nested-play.yml", "step.yml", "wf-play.yml", "x.yaml"]);
    // the team's : its form's playbook, its steps', its workflow's nodes and its nested workflow's, all hidden
    assert.deepEqual(await files("workflows", user), ["free.yml", "main.yml", "sub/nested.yml"]);
    assert.deepEqual((await listWorkflows(await fileVisibility("workflows", user))).map((w) => w.name), ["Free", "Main", "Nested"]);
    // designAllForms off but designAllPlaybooks on : every playbook
    assert.equal((await files("playbooks", { ...limited })).length, 9);
  });

  test("a hidden file : not read, its delete not found, its save a name taken ; a new unused file shown", async () => {
    const user = { ...limited, options: { ...limited.options, designAllPlaybooks: false, designAllWorkflows: false } };
    await assert.rejects(assertFileShown("playbooks", "team.yml", user, "read"), { status: 404, message: "File 'team.yml' not found" });
    await assert.rejects(assertFileShown("playbooks", "team.yml", user, "delete"), { status: 404 });
    await assert.rejects(assertFileShown("playbooks", "team.yml", user, "save"), { status: 409, message: "The name 'team.yml' is already taken" });
    await assert.rejects(assertFileShown("workflows", "team.yml", user, "create"), { status: 409 });
    await assertFileShown("playbooks", "x.yaml", user, "save");
    write("playbooks", "brand-new.yml", "- hosts: all\n");
    await assertFileShown("playbooks", "brand-new.yml", user, "read");
    assert.ok((await files("playbooks", user)).includes("brand-new.yml"));
  });
});
