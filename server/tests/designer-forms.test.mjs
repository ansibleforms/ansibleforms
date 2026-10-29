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
// the runners as the database gives them back (a workflow node on an rte runner runs a playbook)
let runners = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql) => {
      if (/FROM AnsibleForms\.`repositories` WHERE use_for_forms/.test(sql)) return [{ name: "forms", status: "success", head: "abc" }];
      if (/FROM AnsibleForms\.`runners`/.test(sql)) return runners;
      return [];
    },
  },
}));
vi.mock("../src/models/repo.model.js", () => {
  const folderOf = (name) => path.join(ROOT, name);
  return { default: { folderOf, isValidName: () => true }, repoFolder: folderOf };
});
vi.mock("../src/models/settings.model.js", () => ({ default: { findFormsYaml: async () => ({}), resolveConfigInDatabase: () => false, getActiveConfig: async () => fs.readFileSync(path.join(ROOT, "config.yaml"), "utf8") } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: Form } = await import("../src/models/form.model.js");
const { designsAllForms, duplicateShown, designerConfig, designerSave, fileVisibility, designerListing, assertFileShown, assertWorkflowFileShown, designerGitOutput, designerRepositories } = await import("../src/lib/designerForms.js");
const { default: ansibleConfig } = await import("../config/ansible.config.js");
const { default: ProjectFiles } = await import("../src/models/projectFiles.model.js");
const { listWorkflows } = await import("../src/models/workflowRun.js");
const { default: configController } = await import("../src/controllers/v2/config.controller.js");

const ROLES = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const form = (name, roles, extra = {}) => ({ name, type: "ansible", playbook: "x.yaml", roles, categories: [], fields: [], ...extra });
const OPS = form("Ops deploy", ["ops"], { fields: [{ name: "hosts", type: "list", subform: "Host row" }] });
// the team's form uses the ops form's subform too : read only for olga
const TEAM = form("Team deploy", ["team"], { fields: [{ name: "hosts", type: "list", subform: "Host row" }] });
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
  runners = [];
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
    await assert.rejects(assertFileShown("playbooks", "team.yml", user, "save"), { status: 409, message: "File 'team.yml' exists already" });
    await assert.rejects(assertFileShown("workflows", "team.yml", user, "create"), { status: 409 });
    await assertFileShown("playbooks", "x.yaml", user, "save");
    write("playbooks", "brand-new.yml", "- hosts: all\n");
    await assertFileShown("playbooks", "brand-new.yml", user, "read");
    assert.ok((await files("playbooks", user)).includes("brand-new.yml"));
  });
});

// ─── nothing hidden reached another way ────────────────────────────────────────
describe("with designAllForms off : no other way to a hidden form", () => {
  const DIR = () => path.join(ROOT, "forms", "forms");
  const BASE = { categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {} };
  const save = (user, forms) => call(configController.save, { user: { user }, body: { forms: YAML.stringify({ ...BASE, forms }) }, ip: "::1" });
  const mine = async (user = limited) => (await designerConfig(await load(), user, await Form.unloaded())).forms.filter((f) => !f.readOnly);
  // a team form that does not load (a field of no type there is)
  const BROKEN = { name: "Secret payroll", type: "ansible", playbook: "x.yaml", roles: ["team"], categories: [], fields: [{ name: "x", type: "bogus" }] };

  test("a list field naming a hidden form that is no subform shows nothing of it", async () => {
    const forms = (await mine()).map((f) => (f.name === "Ops deploy" ? { ...f, fields: [...f.fields, { name: "peek", type: "list", subform: "Team deploy" }] } : f));
    assert.equal((await save(limited, forms)).code, 200);
    const res = await call(configController.findAll, { user: { user: limited } });
    assert.equal(res.body.forms.some((f) => f.name === "Team deploy"), false, JSON.stringify(names(res.body.forms)));
  });

  test("a hidden form that does not load : not named in the errors, its name and its file refused", async () => {
    fs.writeFileSync(path.join(DIR(), "secret.yaml"), YAML.stringify(BROKEN));
    // one of the user's that does not load : its error still shown
    fs.writeFileSync(path.join(DIR(), "mine.yaml"), YAML.stringify({ ...BROKEN, name: "Ops broken", roles: ["ops"] }));
    const res = await call(configController.findAll, { user: { user: limited } });
    assert.doesNotMatch(JSON.stringify(res.body), /Secret payroll/);
    assert.match(JSON.stringify(res.body.errors), /Ops broken/);
    // its name : taken, nothing more said, the file left as it was
    const named = await save(limited, [...(await mine()), form("Secret payroll", ["ops"], { source: "other.yaml" })]);
    assert.equal(named.code, 409);
    assert.equal(named.body.details, "The form name 'Secret payroll' is already taken");
    // its file : taken too
    const placed = await save(limited, [...(await mine()), form("Mine too", ["ops"], { source: "secret.yaml" })]);
    assert.equal(placed.code, 409);
    assert.equal(placed.body.details, "The file 'secret.yaml' is already taken");
    assert.deepEqual(YAML.parse(fs.readFileSync(path.join(DIR(), "secret.yaml"), "utf8")), BROKEN);
  });

  test("subforms : a new one and those only the user's forms use are theirs, those a hidden form uses are not", async () => {
    const rows = { name: "My rows", type: "subform", fields: [{ name: "a", type: "text" }], source: "deploy.yaml" };
    const withRows = (forms) => forms.map((f) => (f.name === "Ops deploy" ? { ...f, fields: [...f.fields, { name: "rows", type: "list", subform: "My rows" }] } : f));
    // a new subform, used by a form of theirs : saved, then shown theirs to edit
    const first = await save(limited, withRows([...(await mine()), rows]));
    assert.equal(first.code, 200, JSON.stringify(first.body));
    const shown = (await designerConfig(await load(), limited)).forms.find((f) => f.name === "My rows");
    assert.equal(shown.readOnly, undefined);
    const edited = (await mine()).map((f) => (f.name === "My rows" ? { ...f, fields: [{ name: "b", type: "text" }] } : f));
    const second = await save(limited, edited);
    assert.equal(second.code, 200, JSON.stringify(second.body));
    assert.equal(YAML.parse(fs.readFileSync(path.join(DIR(), "deploy.yaml"), "utf8")).find((f) => f.name === "My rows").fields[0].name, "b");
    // a subform only a hidden form uses : neither shown, nor named by a form of theirs, nor its name taken
    fs.writeFileSync(path.join(DIR(), "team.yaml"), YAML.stringify([form("Team rows form", ["team"], { fields: [{ name: "r", type: "list", subform: "Team rows" }] }), { name: "Team rows", type: "subform", fields: [{ name: "t", type: "text" }] }]));
    assert.equal((await designerConfig(await load(), limited)).forms.some((f) => f.name === "Team rows"), false);
    const naming = (await mine()).map((f) => (f.name === "Ops deploy" ? { ...f, fields: [...f.fields, { name: "t", type: "list", subform: "Team rows" }] } : f));
    assert.equal((await save(limited, naming)).body.details, "The form name 'Team rows' is already taken");
    const taking = [...(await mine()), { name: "Team rows", type: "subform", fields: [{ name: "t", type: "text" }], source: "deploy.yaml" }];
    assert.equal((await save(limited, taking)).code, 409);
  });
});

describe("designAllPlaybooks and designAllWorkflows off : no other way to a hidden file", () => {
  const DIR = () => path.join(ROOT, "forms", "forms");
  const BASE = { categories: [{ name: "Default", icon: "bars" }], roles: ROLES, constants: {} };
  const user = { ...limited, options: { ...limited.options, designAllPlaybooks: false, designAllWorkflows: false } };
  const write = (dir, file, text) => {
    fs.mkdirSync(path.dirname(path.join(ROOT, dir, file)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, dir, file), text);
  };
  const flow = (name, nodes) => YAML.stringify({ workflow_job_templates: [{ name, related: { workflow_nodes: nodes.map((n, i) => ({ identifier: `n${i}`, ...n })) } }] });
  const files = async (kind) => (await designerListing(kind, await ProjectFiles.list(kind), user)).files.map((f) => f.path).sort();

  beforeEach(() => {
    ansibleConfig.path = path.join(ROOT, "playbooks");
    appConfig.workflowsPath = path.join(ROOT, "workflows");
    for (const f of ["x.yaml", "team.yml", "team-node.yml", "rte-node.yml"]) write("playbooks", f, "- hosts: secret\n");
  });

  test("another explorer whose folder holds the forms and the playbooks shows neither a hidden playbook nor a form file", async () => {
    fs.writeFileSync(path.join(DIR(), "team.yaml"), YAML.stringify(form("Team play", ["team"], { playbook: "team.yml" })));
    // the workflows' folder : the whole tree, as a repository used for forms, playbooks and workflows is
    appConfig.workflowsPath = ROOT;
    const listed = await files("workflows");
    assert.ok(listed.includes("playbooks/x.yaml"), "a playbook of theirs stays");
    assert.equal(listed.includes("playbooks/team.yml"), false, "the hidden playbook");
    assert.deepEqual(listed.filter((f) => f.startsWith("forms/")), [], "the form files");
    await assert.rejects(assertFileShown("workflows", "playbooks/team.yml", user, "read"), { status: 404 });
    await assert.rejects(assertFileShown("workflows", "forms/forms/team.yaml", user, "read"), { status: 404 });
    await assert.rejects(assertFileShown("workflows", "forms/forms/team.yaml", user, "save"), { status: 409 });
    // a designer of every form reads them, as before
    const all = { ...limited, options: { ...limited.options, designAllForms: true } };
    assert.ok((await designerListing("workflows", await ProjectFiles.list("workflows"), all)).files.some((f) => f.path === "forms/forms/team.yaml"));
  });

  test("a form file is never written through another explorer, for anyone : neither changed, made nor deleted", async () => {
    appConfig.workflowsPath = ROOT;
    const denied = { status: 403, message: /is a form file: it is written by the designer's forms, where it is checked/ };
    const before = fs.readFileSync(path.join(DIR(), "deploy.yaml"), "utf8");
    // a hidden form given the user's role, a new form of a hidden one's name : Form.save's checks skipped
    await assert.rejects(ProjectFiles.write("workflows", "forms/forms/deploy.yaml", YAML.stringify(form("Team deploy", ["team", "ops"]))), denied);
    await assert.rejects(ProjectFiles.write("workflows", "forms/forms/a.yaml", YAML.stringify(form("Team deploy", ["ops"])), true), denied);
    // the staging folder, not made yet (the forms model reads its own configuration)
    const { default: formsConfig } = await import("../config/app.config.js");
    const staging = formsConfig.formsStagingPath;
    formsConfig.formsStagingPath = path.join(ROOT, "staging");
    try {
      await assert.rejects(ProjectFiles.write("workflows", "staging/new.yaml", YAML.stringify(form("New", ["ops"])), true), denied);
    } finally {
      formsConfig.formsStagingPath = staging;
    }
    await assert.rejects(ProjectFiles.remove("workflows", "forms/forms/deploy.yaml"), denied);
    assert.equal(fs.readFileSync(path.join(DIR(), "deploy.yaml"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(DIR(), "a.yaml")), false);
    // read : the designer of every form still may
    assert.equal((await ProjectFiles.read("workflows", "forms/forms/deploy.yaml")).content, before);
    // the rest of the tree stays writable
    await ProjectFiles.write("workflows", "playbooks/x.yaml", "- hosts: all\n");
  });

  test("a forms repository serving its forms from its root : its yaml files are form files, its other files are not", async () => {
    fs.renameSync(DIR(), path.join(ROOT, "forms", "flat"));
    appConfig.workflowsPath = ROOT;
    await assert.rejects(ProjectFiles.write("workflows", "forms/flat/deploy.yaml", "x: 1\n"), { status: 403 });
    await assert.rejects(ProjectFiles.write("workflows", "forms/new.yml", "x: 1\n", true), { status: 403 });
    await ProjectFiles.write("workflows", "forms/notes.txt", "notes\n", true);
  });

  test("a new or changed expression the server runs : refused while something is hidden from them, theirs kept", async () => {
    const READ = "fn.fnReadYamlFile('/app/dist/persistent/playbooks/team.yml')";
    // saved in the forms repository (never the staging folder, which is the server's own)
    const probe = (fields, name = "Probe") => form(name, ["ops"], { source: `${name.toLowerCase()}.yaml`, repository: "forms", fields });
    const save = (u, forms) => call(configController.save, { user: { user: u }, body: { forms: YAML.stringify({ ...BASE, forms }) }, ip: "::1" });
    const mine = async (u) => (await designerConfig(await load(), u)).forms.filter((f) => !f.readOnly);
    for (const u of [user, { ...limited, options: { ...limited.options, designAllForms: true, designAllPlaybooks: false } }]) {
      const res = await save(u, [...(await mine(u)), probe([{ name: "leak", type: "expression", expression: READ }])]);
      assert.equal(res.code, 403, JSON.stringify(res.body));
      assert.match(res.body.details, /Form 'Probe': an expression or a query the server runs is only added or changed by a designer who sees every form, playbook and workflow/);
      // a query, the same
      assert.equal((await save(u, [...(await mine(u)), probe([{ name: "q", type: "enum", query: "select 1", dbConfig: { name: "db" } }])])).code, 403);
    }
    // the browser's own expressions stay theirs
    const local = await save(user, [...(await mine(user)), probe([{ name: "l", type: "expression", expression: "1+1", runLocal: true }])]);
    assert.equal(local.code, 200, JSON.stringify(local.body));
    // a form of theirs an admin gave an expression : kept on their saves, never changed
    fs.writeFileSync(path.join(DIR(), "probe.yaml"), YAML.stringify(probe([{ name: "e", type: "expression", expression: "fn.fnTime()" }])));
    const kept = (await mine(user)).map((f) => (f.name === "Probe" ? { ...f, description: "edited" } : f));
    assert.equal((await save(user, kept)).code, 200);
    const changed = (await mine(user)).map((f) => (f.name === "Probe" ? { ...f, fields: [{ name: "e", type: "expression", expression: READ }] } : f));
    assert.equal((await save(user, changed)).code, 403);
    // a designer of everything adds any
    const all = { ...limited, options: { ...limited.options, designAllForms: true } };
    assert.equal((await save(all, [...(await mine(all)), probe([{ name: "leak", type: "expression", expression: READ }], "Other")])).code, 200);
  });

  test("a form of the user's pointed at a hidden playbook : refused, the playbook still hidden", async () => {
    fs.writeFileSync(path.join(DIR(), "team.yaml"), YAML.stringify(form("Team play", ["team"], { playbook: "team.yml" })));
    const forms = (await designerConfig(await load(), user)).forms.filter((f) => !f.readOnly).map((f) => (f.name === "Everyone" ? { ...f, playbook: "team.yml" } : f));
    const res = await call(configController.save, { user: { user }, body: { forms: YAML.stringify({ ...BASE, forms }) }, ip: "::1" });
    assert.equal(res.code, 409);
    assert.equal(res.body.details, "Form 'Everyone': the playbook it runs is not available to you");
    await assert.rejects(assertFileShown("playbooks", "team.yml", user, "read"), { status: 404 });
  });

  test("a second workflow of a hidden one's name shows neither it nor its playbooks", async () => {
    fs.writeFileSync(path.join(DIR(), "flows.yaml"), YAML.stringify([{ name: "Team flow", type: "workflow", workflow: "Team flow", roles: ["team"], categories: [], fields: [] }]));
    write("workflows", "team.yml", flow("Team flow", [{ unified_job_template: { type: "job_template", name: "team-node.yml" } }]));
    write("workflows", "mine.yml", flow("Team flow", []));
    // the second one is one the form's reference may mean as well : hidden too
    assert.deepEqual(await files("workflows"), []);
    assert.deepEqual(await files("playbooks"), ["rte-node.yml", "team.yml", "x.yaml"]);
    await assert.rejects(assertFileShown("workflows", "team.yml", user, "read"), { status: 404 });
  });

  test("a node on an rte runner runs a playbook : hidden with its workflow ; on another runner, a template", async () => {
    runners = [
      { name: "edge", type: "rte" },
      { name: "pipeline", type: "semaphore" },
    ];
    fs.writeFileSync(path.join(DIR(), "flows.yaml"), YAML.stringify([{ name: "Team flow", type: "workflow", workflow: "team.yml", roles: ["team"], categories: [], fields: [] }]));
    write("workflows", "team.yml", flow("Team flow", [{ runner: "edge", unified_job_template: { type: "job_template", name: "rte-node.yml" } }, { runner: "pipeline", unified_job_template: { type: "job_template", name: "team-node.yml" } }]));
    assert.deepEqual(await files("playbooks"), ["team-node.yml", "team.yml", "x.yaml"]);
  });

  test("a workflow of the user's saved or made with a node running a hidden playbook or workflow : refused, both still hidden", async () => {
    fs.writeFileSync(
      path.join(DIR(), "flows.yaml"),
      YAML.stringify([
        form("Team play", ["team"], { playbook: "team.yml" }),
        { name: "Ops flow", type: "workflow", workflow: "mine.yml", roles: ["ops"], categories: [], fields: [] },
        { name: "Team flow", type: "workflow", workflow: "team-flow.yml", roles: ["team"], categories: [], fields: [] },
      ]),
    );
    write("workflows", "mine.yml", flow("Mine", []));
    write("workflows", "team-flow.yml", flow("Team flow", []));
    const job = (name) => ({ unified_job_template: { type: "job_template", name } });
    const nested = (name) => ({ unified_job_template: { type: "workflow_job_template", name } });
    // the user's own workflow (one of their forms runs it), naming the hidden playbook or workflow
    const err = await assertWorkflowFileShown(flow("Mine", [job("team.yml")]), user).catch((e) => e);
    assert.equal(err.status, 409);
    assert.equal(err.message, "The workflow runs a playbook that is not available to you");
    await assert.rejects(assertWorkflowFileShown(flow("Mine", [nested("team-flow.yml")]), user), { status: 409, message: "The workflow runs a workflow that is not available to you" });
    await assert.rejects(assertWorkflowFileShown(flow("Mine", [nested("Team flow")]), user), { status: 409 });
    // a new workflow file one of their forms will run : the same
    await assert.rejects(assertWorkflowFileShown(flow("New", [job("team.yml")]), user), { status: 409 });
    assert.deepEqual(await files("playbooks"), ["rte-node.yml", "team-node.yml", "x.yaml"]);
    assert.deepEqual(await files("workflows"), ["mine.yml"]);
    // a node running a shown one, or nothing at all, passes ; so does a designer who sees every file
    await assertWorkflowFileShown(flow("Mine", [job("x.yaml"), nested("mine.yml")]), user);
    await assertWorkflowFileShown("not: [valid", user);
    await assertWorkflowFileShown(flow("Mine", [job("team.yml")]), limited);
  });

  test("a hidden file answers as a missing one, or as one there already, in the same words", async () => {
    fs.writeFileSync(path.join(DIR(), "team.yaml"), YAML.stringify(form("Team play", ["team"], { playbook: "team.yml" })));
    const missing = await ProjectFiles.read("playbooks", "/nope.yml").catch((e) => e);
    const hidden = await assertFileShown("playbooks", "/team.yml", user, "read").catch((e) => e);
    assert.equal(hidden.status, missing.status);
    assert.equal(hidden.message, missing.message.replace("nope.yml", "team.yml"));
    const there = await ProjectFiles.write("playbooks", "x.yaml", "", true).catch((e) => e);
    const created = await assertFileShown("playbooks", "team.yml", user, "create").catch((e) => e);
    assert.equal(created.status, there.status);
    assert.equal(created.message, there.message.replace("x.yaml", "team.yml"));
  });

  test("git outputs : the lines naming files left out", async () => {
    const push = "[main abc123] Playbooks sync by olga\n 2 files changed, 3 insertions(+)\n create mode 100644 team.yml\n delete mode 100644 old.yml\n rename a.yml => b.yml (100%)\nTo origin";
    assert.equal(designerGitOutput(push, user), "[main abc123] Playbooks sync by olga\n 2 files changed, 3 insertions(+)\nTo origin");
    assert.equal(designerGitOutput(push, everything), push);
    // a repository's stored pull and push outputs, as the user reads them
    const pull = "Updating 1..2\n forms/team.yaml | 3 ++-\n 1 file changed";
    const [row] = designerRepositories([{ name: "forms", pull_output: pull, push_output: push }], limited);
    assert.equal(row.pull_output, "Updating 1..2\n 1 file changed");
    assert.doesNotMatch(row.push_output, /team\.yml/);
    assert.equal(designerRepositories([{ pull_output: pull }], everything)[0].pull_output, pull);
  });
});

describe("a form name defined twice : its warning only to a designer who reaches both copies", () => {
  test("the loader's warning left out of the designer's config when a copy is hidden", async () => {
    // a second copy of the user's form, the team's
    fs.writeFileSync(path.join(ROOT, "forms", "forms", "zz-copy.yaml"), YAML.stringify(form("Ops deploy", ["team"])));
    const warning = Form.duplicateWarning("Ops deploy");
    assert.ok((await load()).warnings.includes(warning), "the loader warns");
    const [d] = await Form.duplicates();
    assert.deepEqual(d, { name: "Ops deploy", used: { roles: ["ops"] }, skipped: { roles: ["team"] }, notice: warning });
    assert.equal(duplicateShown(d, limited), false);
    assert.equal(duplicateShown(d, everything), true);
    assert.equal(duplicateShown({ ...d, skipped: { roles: ["default"] } }, limited), true);
    const res = await call(configController.findAll, { user: { user: limited } });
    assert.equal(res.body.warnings.includes(warning), false);
    assert.ok((await call(configController.findAll, { user: { user: everything } })).body.warnings.includes(warning));
  });
});

// ─── the other routes naming forms and workflow files ──────────────────────────
describe("the routes outside the designer's config name nothing hidden from a limited user", () => {
  const settingsPart = (o = {}) => ({ ...limited, options: { ...limited.options, showConnectionsSettings: true, showAppearanceSettings: true, ...o } });
  const named = (res) => JSON.stringify(res.body);

  test("the forms list and a form opened : the user's forms as for everyone, no warning naming a hidden form", async () => {
    // a copy of the team's form read first : the loader warns of the second, whoever it belongs to
    fs.writeFileSync(path.join(ROOT, "forms", "forms", "a-copy.yaml"), YAML.stringify(form("Team deploy", ["team"])));
    const warning = Form.duplicateWarning("Team deploy");
    const list = await call(configController.findList, { user: { user: limited } });
    assert.deepEqual(names(list.body.forms).sort(), ["Everyone", "Ops deploy"]);
    assert.doesNotMatch(named(list), /Team deploy/);
    // a form opened : the loader stops at it, warning of no other form's copies
    const one = await call(configController.findOne, { user: { user: limited }, query: { name: "Everyone" } });
    assert.equal(one.code, 200);
    assert.doesNotMatch(named(one), /Team deploy/);
    // a designer of every form is still warned
    assert.ok((await call(configController.findList, { user: { user: everything } })).body.warnings.includes(warning));
  });

  test("the settings pages' Forms tabs : the forms the user's designer shows, every form with the full settings", async () => {
    const res = await call(configController.formsLinked, { user: { user: settingsPart() } });
    assert.deepEqual(res.body.records.map((f) => f.name).sort(), ["Everyone", "Ops deploy"]);
    assert.doesNotMatch(named(res), /Team deploy/);
    const full = await call(configController.formsLinked, { user: { user: settingsPart({ showSettings: true }) } });
    assert.ok(full.body.records.some((f) => f.name === "Team deploy"));
    assert.ok((await call(configController.formsLinked, { user: { user: { ...everything, options: { ...everything.options, showConnectionsSettings: true } } } })).body.records.some((f) => f.name === "Team deploy"));
  });

  test("a credential's Used by tab : no hidden form, no hidden workflow file", async () => {
    appConfig.workflowsPath = path.join(ROOT, "workflows");
    fs.mkdirSync(appConfig.workflowsPath, { recursive: true });
    const node = { identifier: "n0", unified_job_template: { type: "job_template", name: "x.yaml" }, related: { credentials: [{ name: "vault-team" }] } };
    const wf = (name) => YAML.stringify({ workflow_job_templates: [{ name, related: { workflow_nodes: [node] } }] });
    fs.writeFileSync(path.join(appConfig.workflowsPath, "team-flow.yml"), wf("Team flow"));
    fs.writeFileSync(path.join(appConfig.workflowsPath, "free.yml"), wf("Free"));
    fs.writeFileSync(
      path.join(ROOT, "forms", "forms", "deploy.yaml"),
      YAML.stringify([
        { ...OPS, ansibleCredentials: "ops-ssh" },
        { ...TEAM, ansibleCredentials: "team-ssh" },
        OPEN,
        { name: "Team flow form", type: "workflow", workflow: "team-flow.yml", roles: ["team"], categories: [], fields: [] },
      ]),
    );
    const user = settingsPart({ designAllWorkflows: false });
    const forms = await call(configController.formsCredentials, { user: { user } });
    assert.deepEqual(forms.body.records.map((f) => f.name), ["Ops deploy"]);
    assert.doesNotMatch(named(forms), /Team deploy|team-ssh/);
    const flows = await call(configController.workflowsCredentials, { user: { user } });
    assert.deepEqual(flows.body.records.map((f) => f.file), ["free.yml"]);
    // the full settings : every one
    const full = settingsPart({ designAllWorkflows: false, showSettings: true });
    assert.equal((await call(configController.formsCredentials, { user: { user: full } })).body.records.length, 2);
    assert.deepEqual((await call(configController.workflowsCredentials, { user: { user: full } })).body.records.map((f) => f.file).sort(), ["free.yml", "team-flow.yml"]);
  });
});
