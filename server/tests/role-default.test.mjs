// The role every signed-in user has is `default` ; `public` is its name before 7 and an alias for
// good. Every user carries both names, so a form listing either matches. Its options are
// everyone's defaults : they fill what none of the user's own roles set, never overwrite them ;
// between the user's own roles the most restrictive wins.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
let config;
vi.mock("../src/models/form.model.js", async (importOriginal) => {
  const actual = await importOriginal();
  const Form = actual.default;
  return { default: Object.assign(Object.create(Form), Form, { load: async () => config }) };
});

const { default: User } = await import("../src/models/user.model.js");
const { default: Form } = await vi.importActual("../src/models/form.model.js");
const { isEveryoneRole, everyoneEntry, renameLegacyRole } = await import("../src/lib/defaultRole.js");

const user = { type: "local", username: "bob" };
const admin = { name: "admin", groups: ["local/admins"] };

beforeEach(() => {
  config = { roles: [admin, { name: "default", groups: [], options: { allowLogin: false, allowChat: false } }, { name: "ops", groups: ["local/ops"], options: { allowLogin: true } }, { name: "audit", groups: ["local/audit"], options: { allowChat: true, showLogs: false } }, { name: "lead", groups: ["local/lead"], options: { showLogs: true } }] };
});

describe("the role every user has", () => {
  test("every user carries default and public, so a form listing either matches", async () => {
    const { roles } = await User.getRolesAndOptions([], user);
    expect(roles).toEqual(expect.arrayContaining(["default", "public"]));
    expect(isEveryoneRole("public")).toBe(true);
    expect(isEveryoneRole("default")).toBe(true);
    expect(isEveryoneRole("ops")).toBe(false);
  });

  test("its options are the defaults: they fill what the user's roles leave open", async () => {
    const nobody = await User.getRolesAndOptions([], user);
    expect(nobody.options.allowLogin).toBe(false);
    expect(nobody.options.allowChat).toBe(false);
  });

  test("a role the user has overrides them, in either direction", async () => {
    const ops = await User.getRolesAndOptions(["local/ops"], user);
    expect(ops.options.allowLogin).toBe(true);
    const audit = await User.getRolesAndOptions(["local/audit"], user);
    expect(audit.options.allowChat).toBe(true);
  });

  test("between the user's own roles, the most restrictive wins", async () => {
    const both = await User.getRolesAndOptions(["local/audit", "local/lead"], user);
    expect(both.options.showLogs).toBe(false);
  });

  test("an old config that says public works the same, and the role is its entry", async () => {
    config.roles = config.roles.map((r) => (r.name === "default" ? { ...r, name: "public" } : r));
    expect(everyoneEntry(config.roles).name).toBe("public");
    const { roles, options } = await User.getRolesAndOptions([], user);
    expect(roles).toEqual(expect.arrayContaining(["default", "public"]));
    expect(options.allowLogin).toBe(false);
  });
});

describe("the config", () => {
  const base = (roles) => ({ categories: [{ name: "Default", icon: "bars" }], roles, constants: {} });

  test("default or public is required, alongside admin", () => {
    expect(() => Form.assertRequiredRoles({ roles: [admin, { name: "default", groups: [] }] })).not.toThrow();
    expect(() => Form.assertRequiredRoles({ roles: [admin, { name: "public", groups: [] }] })).not.toThrow();
    expect(() => Form.assertRequiredRoles({ roles: [admin] })).toThrow(/default cannot be deleted/);
  });

  test("not both: they are one role", () => {
    expect(() => Form.assertRequiredRoles({ roles: [admin, { name: "default", groups: [] }, { name: "public", groups: [] }] })).toThrow(/keep one, 'default'/);
  });

  test("a role named default may not have groups or users: it would apply to everyone", () => {
    expect(() => Form.validateConfig(base([admin, { name: "default", groups: [] }]))).not.toThrow();
    expect(() => Form.validateConfig(base([admin, { name: "default", groups: ["local/ops"] }]))).toThrow();
    expect(() => Form.validateConfig(base([admin, { name: "default", groups: [], users: ["local/bob"] }]))).toThrow();
    expect(() => Form.validateConfig(base([admin, { name: "public", groups: [], runners: ["x"] }]))).toThrow();
  });
});

// A config from before 7 has its `public` role renamed `default` in the file when it loads : only
// the name changes, its comments and options stay as written.
describe("an old config's public role is renamed default", () => {
  test("only the name changes: comments, options and the other roles stay", () => {
    const text = "# the roles\nroles:\n  - name: admin\n    groups: [local/admins]\n  # everyone's\n  - name: public # was public\n    groups: []\n    options:\n      allowChat: false\n";
    const out = renameLegacyRole(text);
    expect(out).toBe("# the roles\nroles:\n  - name: admin\n    groups: [local/admins]\n  # everyone's\n  - name: default # was public\n    groups: []\n    options:\n      allowChat: false\n");
  });

  test("nothing to rename: no public role, a default one already, no roles, or no YAML", () => {
    expect(renameLegacyRole("roles:\n  - name: admin\n  - name: default\n")).toBe(null);
    expect(renameLegacyRole("roles:\n  - name: default\n  - name: public\n")).toBe(null);
    expect(renameLegacyRole("forms:\n  - name: public\n")).toBe(null);
    expect(renameLegacyRole("roles: [")).toBe(null);
    expect(renameLegacyRole("")).toBe(null);
  });
});

test("a quoted name is renamed too, default needs no quotes", () => {
  expect(renameLegacyRole("roles:\n  - name: admin\n  - name: \"public\"\n    groups: []\n")).toBe("roles:\n  - name: admin\n  - name: default\n    groups: []\n");
});

describe("designAllForms : every form in the designer, or only those of the user's roles", () => {
  test("on by default ; false wins across the user's roles ; the default role fills it ; always on for an admin", async () => {
    expect((await User.getRolesAndOptions(["local/ops"], user)).options.designAllForms).toBe(true);
    config.roles = config.roles.map((r) => (r.name === "audit" ? { ...r, options: { ...r.options, designAllForms: false } } : r.name === "lead" ? { ...r, options: { ...r.options, designAllForms: true } } : r));
    expect((await User.getRolesAndOptions(["local/audit", "local/lead"], user)).options.designAllForms).toBe(false);
    config.roles = config.roles.map((r) => (r.name === "default" ? { ...r, options: { ...r.options, designAllForms: false } } : r));
    expect((await User.getRolesAndOptions(["local/ops"], user)).options.designAllForms).toBe(false);
    expect((await User.getRolesAndOptions(["local/admins", "local/audit"], user)).options.designAllForms).toBe(true);
  });
});

describe("designAllPlaybooks and designAllWorkflows : as designAllForms", () => {
  test.each(["designAllPlaybooks", "designAllWorkflows"])("%s : on by default, false wins, the default role fills it, always on for an admin", async (option) => {
    expect((await User.getRolesAndOptions(["local/ops"], user)).options[option]).toBe(true);
    config.roles = config.roles.map((r) => (r.name === "audit" ? { ...r, options: { ...r.options, [option]: false } } : r.name === "lead" ? { ...r, options: { ...r.options, [option]: true } } : r));
    expect((await User.getRolesAndOptions(["local/audit", "local/lead"], user)).options[option]).toBe(false);
    config.roles = config.roles.map((r) => (r.name === "default" ? { ...r, options: { ...r.options, [option]: false } } : r));
    expect((await User.getRolesAndOptions(["local/ops"], user)).options[option]).toBe(false);
    expect((await User.getRolesAndOptions(["local/admins", "local/audit"], user)).options[option]).toBe(true);
  });
});
