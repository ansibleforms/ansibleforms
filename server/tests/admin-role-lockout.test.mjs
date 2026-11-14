// Only admins change what admins may do. A user's options are the and of every role naming them
// (user.model.js rolesAndOptionsFrom), so a user with settings access but without the admin role
// could lock every admin out through Settings > Roles (PUT /api/v2/settings/config) : allowLogin
// or showSettings off on the admin role, on a new role naming the admins' group, or on the default
// role whose options fill what the admin role does not set. Who the admin role names stayed the
// same, so assertAdminRoleUnchanged let it through. It now compares each admin member's options
// as a sign-in would give them, before and after the save, and refuses (403) any option taken
// away. An admin keeps full control, but never turns off their own sign-in or settings (409).
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ------------------------------------------------------------------
// the active configuration, what a save writes, the groups of the user saving
// ------------------------------------------------------------------
const active =
  "categories:\n  - name: Default\n    icon: bars\nconstants: {}\nroles:\n  - name: admin\n    groups: [local/admins]\n  - name: default\n    groups: []\n  - name: ops\n    groups: [local/ops]\n    options: { showSettings: true }\n";
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

/**
 * The active configuration with one text replaced, checked to be there.
 *
 * Args:
 *   from (string): the text of the active configuration to replace.
 *   to (string): what replaces it.
 *
 * Returns:
 *   string: the changed configuration.
 */
function edited(from, to) {
  expect(active.includes(from)).toBe(true);
  return active.replace(from, to);
}

const ADMIN_ROLE = "  - name: admin\n    groups: [local/admins]\n";
const DEFAULT_ROLE = "  - name: default\n    groups: []\n";
const OPS_ROLE = "  - name: ops\n    groups: [local/ops]\n    options: { showSettings: true }\n";

const admin = { username: "admin", type: "local", roles: ["admin"] };
const settingsUser = { username: "bob", type: "local", roles: ["ops", "default"], options: { showSettings: true } };

beforeEach(() => {
  written.length = 0;
  myGroups = ["local/admins"];
});

describe("the roles and options of a sign-in, from given roles", () => {
  test("an option is the and of every role naming the user ; the default role fills the rest", () => {
    const roles = [
      { name: "admin", groups: ["local/admins"] },
      { name: "default", groups: [], options: { allowLogin: false } },
      { name: "lock", groups: ["local/admins"], options: { showSettings: false } },
    ];
    const { roles: names, options } = User.rolesAndOptionsFrom(roles, ["local/admins"], "local/admin");
    expect(names).toContain("admin");
    expect(options.admin).toBe(true);
    expect(options.showSettings).toBe(false);
    expect(options.allowLogin).toBe(false);
  });
});

describe("a settings user who is not an admin cannot lock the admins out", () => {
  test("allowLogin off on the admin role : refused", async () => {
    const r = await call(controller.saveConfig, settingsUser, {
      config_yaml: edited(ADMIN_ROLE, ADMIN_ROLE + "    options: { allowLogin: false }\n"),
    });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/Only an admin can take an option away from an admin: 'allowLogin' of local\/admins/);
    expect(written).toEqual([]);
  });

  test("showSettings off on the admin role : refused", async () => {
    const r = await call(controller.saveConfig, settingsUser, {
      config_yaml: edited(ADMIN_ROLE, ADMIN_ROLE + "    options: { showSettings: false }\n"),
    });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/'showSettings' of local\/admins/);
    expect(written).toEqual([]);
  });

  test("a new role naming the admins' group with allowLogin off : refused", async () => {
    const r = await call(controller.saveConfig, settingsUser, {
      config_yaml: edited(OPS_ROLE, OPS_ROLE + "  - name: lockout\n    groups: [local/admins]\n    options: { allowLogin: false }\n"),
    });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/'allowLogin' of local\/admins/);
    expect(written).toEqual([]);
  });

  test("any other option an admin has, turned off through a role naming them : refused", async () => {
    const r = await call(controller.saveConfig, settingsUser, {
      config_yaml: edited(OPS_ROLE, OPS_ROLE + "  - name: lockout\n    groups: [local/admins]\n    options: { showDesigner: false }\n"),
    });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/'showDesigner' of local\/admins/);
    expect(written).toEqual([]);
  });

  test("allowLogin off on the default role, which fills what the admin role does not set : refused", async () => {
    const r = await call(controller.saveConfig, settingsUser, {
      config_yaml: edited(DEFAULT_ROLE, DEFAULT_ROLE + "    options: { allowLogin: false }\n"),
    });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/'allowLogin' of local\/admins/);
    expect(written).toEqual([]);
  });

  test("the answer is in the language of the request", async () => {
    const r = await new Promise((resolve) => {
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
      controller.saveConfig(
        {
          body: { config_yaml: edited(ADMIN_ROLE, ADMIN_ROLE + "    options: { allowLogin: false }\n") },
          params: {},
          query: {},
          headers: { cookie: "af_language=fr" },
          user: { user: settingsUser },
        },
        res,
      );
    });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/Seul un admin peut retirer une option/);
  });

  test("allowLogin off on a role that names no admin : saved", async () => {
    const r = await call(controller.saveConfig, settingsUser, {
      config_yaml: edited(OPS_ROLE, OPS_ROLE + "  - name: guests\n    groups: [local/guests]\n    options: { allowLogin: false }\n"),
    });
    expect(r.status).toBe(200);
    expect(written.length).toBe(1);
  });
});

describe("an admin keeps full control, but not over their own way back in", () => {
  test("allowLogin off on the admin role they are in : refused", async () => {
    const r = await call(controller.saveConfig, admin, {
      config_yaml: edited(ADMIN_ROLE, ADMIN_ROLE + "    options: { allowLogin: false }\n"),
    });
    expect(r.status).toBe(409);
    expect(r.data.details).toMatch(/This save would turn 'allowLogin' off for you \(local\/admin\)/);
    expect(written).toEqual([]);
  });

  test("showSettings off through a new role naming their group : refused", async () => {
    const r = await call(controller.saveConfig, admin, {
      config_yaml: edited(OPS_ROLE, OPS_ROLE + "  - name: lockout\n    groups: [local/admins]\n    options: { showSettings: false }\n"),
    });
    expect(r.status).toBe(409);
    expect(r.data.details).toMatch(/'showSettings' off for you/);
    expect(written).toEqual([]);
  });

  test("other options on the admin role : saved", async () => {
    const r = await call(controller.saveConfig, admin, {
      config_yaml: edited(ADMIN_ROLE, ADMIN_ROLE + "    options: { showDesigner: false }\n"),
    });
    expect(r.status).toBe(200);
    expect(written.length).toBe(1);
  });
});
