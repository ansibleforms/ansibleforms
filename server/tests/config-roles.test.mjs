// The roles a repository holds, each read on its own (lib/configRoles.js, lib/configKeys.js) :
//   one role      a role that is not valid is refused alone - its last version served, else left out
//                 - the others served, the forms and the configuration still loading
//   required      the admin and the default role a pull no longer gives : the last ones kept, else
//                 the closed ones ; said, never a refusal
//   several files the roles of each file giving them, one list ; a name given twice refused, both
//                 places named ; a save writes each role where it is, only those changed
//   references    a local group, a local user or a runner a role names that is not there : said
//   saves         refused while git has a role the app refuses (fixed in git first)
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
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const keys = await import("../src/lib/configKeys.js");
const { roleError } = await import("../src/lib/configRoles.js");
const appConfig = (await import("./__mocks__/app.config.js")).default;
const realConfig = (await import("../config/app.config.js")).default;

const BASE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "af-roles-")), "config.yaml");
const write = (file, obj) => {
  const abs = path.join(fx.ROOT, "access", file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof obj === "string" ? obj : YAML.stringify(obj));
};
const readObj = (file) => YAML.parse(fs.readFileSync(path.join(fx.ROOT, "access", file), "utf8"));
const read = (file) => fs.readFileSync(file, "utf8");
const served = async () => YAML.parse(keys.composeConfig(read(BASE), await keys.keySources(), read)).roles;

const ADMIN = { name: "admin", groups: ["local/admins"] };
const DEFAULT = { name: "default", groups: [] };
const OPS = { name: "ops", groups: ["local/ops"] };

beforeEach(() => {
  keys.resetKeyReadsForTests();
  fx.reset({
    repositories: [{ id: 1, name: "access", use_for_roles: 1 }],
    settings: [{ id: 1, forms_yaml: null, config_source: null }],
    groups: [{ id: 1, name: "admins" }, { id: 2, name: "ops" }],
  });
  fs.writeFileSync(BASE, YAML.stringify({ roles: [{ name: "base-role", groups: [] }], categories: [{ name: "Default", icon: "bars" }], constants: {} }));
  appConfig.configPath = BASE;
  realConfig.configPath = BASE;
});

describe("one role", () => {
  test("the base schema's words : no groups and no users said once", () => {
    assert.equal(roleError({ name: "ops" }), "it names no groups and no users");
    assert.equal(roleError(ADMIN), null);
    assert.match(roleError({ name: "ops", users: ["bob"] }), /users\.0 must match pattern/);
  });

  test("a role that is not valid : refused alone, its last version served, the others served", async () => {
    write("roles.yaml", { controller_roles: [ADMIN, DEFAULT, OPS] });
    assert.deepEqual(await served(), [ADMIN, DEFAULT, OPS]);
    // ops broken in git : its last version stays ; a new broken one is left out
    write("roles.yaml", { controller_roles: [ADMIN, DEFAULT, { name: "ops" }, { name: "dev" }] });
    assert.deepEqual(await served(), [ADMIN, DEFAULT, OPS]);
    const notices = await keys.repositoryKeyNotices("access");
    assert.ok(notices.some((n) => /role 'ops' of roles\.yaml \(entry 3\) is refused: it names no groups and no users - served as last read/.test(n)), notices.join("\n"));
    assert.ok(notices.some((n) => /role 'dev' of roles\.yaml \(entry 4\) is refused/.test(n)), notices.join("\n"));
    // no file problem : the file is read
    assert.deepEqual(await keys.repositoryKeyProblems("access"), []);
  });

  test("the forms and the configuration load with a broken role : never a failure", async () => {
    write("roles.yaml", { controller_roles: [ADMIN, DEFAULT, { name: "broken", options: { showDesigner: "yes" } }] });
    const { default: Form } = await import("../src/models/form.model.js");
    assert.deepEqual((await Form.load(["admin"], "", false, true)).roles.map((r) => r.name), ["admin", "default"]);
  });

  test("a file's comments kept in the configuration shown, a refused role taken out of it", async () => {
    write("roles.yaml", "controller_roles:\n  # the way in\n  - name: admin\n    groups:\n      - local/admins\n  - name: default\n    groups: []\n  - name: bad\n");
    const shown = keys.composeConfig(read(BASE), await keys.keySources(), read);
    assert.match(shown, /# the way in\n {2}- name: admin/);
    assert.doesNotMatch(shown, /name: bad/);
  });
});

describe("the admin and the default role", () => {
  test("a pull no longer giving the admin role : the one last read kept ; never read : the closed one", async () => {
    write("roles.yaml", { controller_roles: [{ name: "admin", groups: ["local/admins", "local/ops"] }, DEFAULT] });
    await served();
    write("roles.yaml", { controller_roles: [DEFAULT, OPS] });
    assert.deepEqual(await served(), [DEFAULT, OPS, { name: "admin", groups: ["local/admins", "local/ops"] }]);
    assert.ok((await keys.repositoryKeyNotices("access")).some((n) => /the admin role is not given: the one last read is served/.test(n)));
    // a node that never read it : the closed one
    keys.resetKeyReadsForTests();
    assert.deepEqual(await served(), [DEFAULT, OPS, ADMIN]);
  });
});

describe("several files", () => {
  test("one list, in the order of their files ; a save writes each role where it is", async () => {
    write("roles.yaml", "# the platform\ncontroller_roles:\n  - name: admin\n    groups:\n      - local/admins\n  - name: default\n    groups: []\n");
    write("teams/ops.yaml", { controller_roles: [OPS, { name: "net", groups: ["local/net"] }] });
    assert.deepEqual(await served(), [ADMIN, DEFAULT, OPS, { name: "net", groups: ["local/net"] }]);
    // saved from Settings > Roles : ops changed, net removed, dev new
    const sources = await keys.keySources();
    await keys.writeConfigKeys({ roles: [ADMIN, DEFAULT, { name: "ops", groups: ["local/ops", "local/oncall"] }, { name: "dev", groups: ["local/dev"] }] }, sources, { claim: false });
    assert.deepEqual(readObj("teams/ops.yaml"), { controller_roles: [{ name: "ops", groups: ["local/ops", "local/oncall"] }] });
    // the first file : untouched roles and its comment kept, the new role at its end
    const first = fs.readFileSync(path.join(fx.ROOT, "access", "roles.yaml"), "utf8");
    assert.match(first, /^# the platform\n/);
    assert.deepEqual(YAML.parse(first).controller_roles.map((r) => r.name), ["admin", "default", "dev"]);
  });
});

describe("what a role names", () => {
  test("a local group or user, a runner that is not there : said, the role served", async () => {
    write("roles.yaml", { controller_roles: [ADMIN, DEFAULT, { name: "vmware", groups: ["local/vmware", "ldap/VMware"], users: ["local/bob"], runners: ["rte-vmware"] }] });
    assert.deepEqual((await served()).map((r) => r.name), ["admin", "default", "vmware"]);
    const notices = await keys.repositoryKeyNotices("access");
    assert.ok(notices.includes("no local group 'vmware', which role 'vmware' names: it grants nothing until there is one"), notices.join("\n"));
    assert.ok(notices.some((n) => /no local user 'bob'/.test(n)));
    assert.ok(notices.some((n) => /no runner 'rte-vmware'/.test(n)));
    // the directory's own groups are not checked
    assert.equal(notices.some((n) => /VMware/.test(n)), false);
    assert.match(await keys.deprecationLines("access"), /\nRoles: no local group 'vmware'/);
  });
});

describe("a save of the roles", () => {
  test("refused while git has a role the app refuses : fixed in git first", async () => {
    write("roles.yaml", { controller_roles: [ADMIN, DEFAULT, { name: "ops" }] });
    const sources = await keys.keySources();
    assert.throws(() => keys.assertKeysWritable({ roles: [ADMIN, DEFAULT] }, sources, {}), {
      status: 409,
      message: /cannot be saved while git has a role it refuses \(role 'ops' of roles\.yaml \(entry 3\) is refused/,
    });
  });
});
