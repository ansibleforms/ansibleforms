// A role's Admin option (issue #1313) : any role whose options say `admin: true` makes its users admins, as the
// role named admin does (lib/adminRole.js) - so a team's own naming (platformAdmins) grants admin.
//   sign-in      its users carry the admin role, with an admin's option defaults
//   grants       only an admin changes who such a role makes admin (its members, the switch on a
//                role with members) ; its local groups are groups that grant admin
//   lockout      an admin's save that would take admin away from them is refused (409)
//   schema       never on the default role, every user's
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ------------------------------------------------------------------
// the active configuration, what a save writes, the groups of the user saving
// ------------------------------------------------------------------
let configRoles = [];
const active =
  "categories:\n  - name: Default\n    icon: bars\nconstants: {}\nroles:\n  - name: admin\n    groups: [local/admins]\n  - name: default\n    groups: []\n  - name: ops\n    groups: [local/ops]\n";
const written = [];
let myGroups = ["local/admins"];
vi.mock("../src/models/settings.model.js", () => ({
  default: {
    getActiveConfig: async () => active,
    saveActiveConfig: async (text) => {
      written.push(text);
    },
  },
}));
vi.mock("../src/models/lock.model.js", () => ({ default: { isHeld: async () => false } }));
vi.mock("../src/lib/configAudit.js", () => ({ auditConfigChange: () => {}, configHash: () => "h" }));
vi.mock("../src/lib/userGroups.js", () => ({ groupsOf: async () => myGroups }));

const { default: controller } = await import("../src/controllers/v2/settings.controller.js");
const { default: User } = await import("../src/models/user.model.js");
const { default: Form } = await import("../src/models/form.model.js");
const { adminGrantsFromRoles } = await import("../src/lib/adminGrants.js");
const { grantsAdmin } = await import("../src/lib/adminRole.js");

/**
 * Calls a controller handler and waits for its answer.
 *
 * Args:
 *   handler (function): the controller handler.
 *   user (object): the signed-in user.
 *   body (object): the request body.
 *
 * Returns:
 *   Promise<{status: number, data: object}>: the answer.
 */
function call(handler, user, body = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(d) {
        resolve({ status: this.statusCode, data: d });
        return this;
      },
    };
    handler({ body, params: {}, query: {}, headers: {}, user: { user } }, res);
  });
}

const admin = { username: "admin", type: "local", roles: ["admin"] };
const settingsUser = { username: "bob", type: "local", roles: ["ops", "default"], options: { showSettings: true } };

beforeEach(() => {
  written.length = 0;
  myGroups = ["local/admins"];
});

describe("which roles make admins", () => {
  test("the admin role, a role with admin: true ; never the default role", () => {
    expect(grantsAdmin({ name: "admin" })).toBe(true);
    expect(grantsAdmin({ name: "platformAdmins", options: { admin: true } })).toBe(true);
    expect(grantsAdmin({ name: "ops" })).toBe(false);
    expect(grantsAdmin({ name: "ops", options: { admin: "yes" } })).toBe(false);
    expect(grantsAdmin({ name: "default", options: { admin: true } })).toBe(false);
  });
});

describe("at sign-in", () => {
  test("a user of a role with admin: true carries the admin role, with an admin's option defaults", async () => {
    configRoles = [
      { name: "admin", groups: ["local/admins"] },
      { name: "default", groups: [] },
      { name: "platformAdmins", options: { admin: true }, groups: ["ldap/Platform Admins"] },
    ];
    const spy = vi.spyOn(Form, "load").mockImplementation(async () => ({ roles: configRoles }));
    try {
      const ro = await User.getRolesAndOptions(["ldap/Platform Admins"], { type: "ldap", username: "pat" });
      expect(ro.roles).toContain("platformAdmins");
      expect(ro.roles).toContain("admin");
      expect(ro.options.showSettings).toBe(true);
      expect(ro.options.showDesigner).toBe(true);
      expect(ro.options.admin).toBe(true);
      // without the switch : no admin
      configRoles[2] = { name: "platformAdmins", groups: ["ldap/Platform Admins"] };
      const plain = await User.getRolesAndOptions(["ldap/Platform Admins"], { type: "ldap", username: "pat" });
      expect(plain.roles).not.toContain("admin");
      expect(plain.options.showSettings).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("who may grant admin", () => {
  test("the local groups and users of every role that makes admins", () => {
    const grants = adminGrantsFromRoles([
      { name: "admin", groups: ["local/admins"] },
      { name: "infra_admins", options: { admin: true }, groups: ["local/infra", "ldap/Infra"], users: ["local/carol"] },
      { name: "ops", groups: ["local/ops"] },
    ]);
    expect([...grants.groups].sort()).toEqual(["admins", "infra"]);
    expect([...grants.users]).toEqual(["carol"]);
  });

  test("a settings user who is not an admin cannot turn Admin on for a role with members", async () => {
    const flipped = active.replace("  - name: ops\n    groups: [local/ops]\n", "  - name: ops\n    options: { admin: true }\n    groups: [local/ops]\n");
    const r = await call(controller.saveConfig, settingsUser, { forms_yaml: flipped });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/Only an admin can change who is an admin/);
    expect(written).toEqual([]);
  });
});

describe("an admin never locks themselves out", () => {
  test("a save taking their own group out of every role that makes admins : refused", async () => {
    const without = active.replace("groups: [local/admins]", "groups: [local/platform]");
    const r = await call(controller.saveConfig, admin, { forms_yaml: without });
    expect(r.status).toBe(409);
    expect(r.data.details).toMatch(/This save would take admin away from you \(local\/admin\)/);
    expect(written).toEqual([]);
  });

  test("their group moved to a role with Admin on : saved", async () => {
    const moved = active
      .replace("groups: [local/admins]", "groups: [local/platform]")
      .replace("  - name: ops\n", "  - name: platformAdmins\n    options: { admin: true }\n    groups: [local/admins]\n  - name: ops\n");
    const r = await call(controller.saveConfig, admin, { forms_yaml: moved });
    expect(r.status).toBe(200);
    expect(written.length).toBe(1);
  });
});

describe("the base schema", () => {
  test("admin: true on the default role is refused ; on another role it passes", () => {
    const base = { categories: [{ name: "Default", icon: "bars" }], constants: {} };
    expect(() => Form.validateConfig({ ...base, roles: [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [], options: { admin: true } }] })).toThrow();
    expect(() =>
      Form.validateConfig({ ...base, roles: [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }, { name: "platformAdmins", options: { admin: true }, groups: ["local/platform"] }] }),
    ).not.toThrow();
  });
});
