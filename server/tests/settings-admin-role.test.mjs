// Who is an admin is the admin's : a user with settings access but without the admin role edits
// the other roles on Settings > Roles (PUT /api/v2/settings/config), yet could put their own group
// in the admin role through the same save, or through an import of config.yaml. Both now refuse
// it with a 403 (assertAdminRoleUnchanged in lib/adminGrants.js), like the designer's save and
// the users and groups pages already did.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ------------------------------------------------------------------
// the active configuration, what the save writes, and the file the import reads
// ------------------------------------------------------------------
const active = "categories:\n  - name: Default\n    icon: bars\nconstants: {}\nroles:\n  - name: admin\n    groups: [local/admins]\n  - name: default\n    groups: []\n  - name: ops\n    groups: [local/ops]\n";
const written = [];
let importFileRoles = [];
vi.mock("../src/models/settings.model.js", () => ({
  default: {
    getActiveConfig: async () => active,
    saveActiveConfig: async (text) => { written.push(text); },
    // the model's own part (reading and validating the file) is not under test : it hands the
    // roles of the file to the caller's check, then writes
    importConfig: async ({ assertRoles } = {}) => {
      if (assertRoles) await assertRoles(importFileRoles);
      written.push("imported");
      return "config.yaml imported successfully";
    },
  },
}));
vi.mock("../src/models/lock.model.js", () => ({ default: { isHeld: async () => false } }));
vi.mock("../src/lib/configAudit.js", () => ({ auditConfigChange: () => {}, configHash: () => "h" }));

const { default: controller } = await import("../src/controllers/v2/settings.controller.js");

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
      status(c) { this.statusCode = c; return this; },
      json(d) { resolve({ status: this.statusCode, data: d }); return this; },
    };
    handler({ body, params: {}, query: {}, headers: {}, user: { user } }, res);
  });
}

const settingsUser = { username: "bob", type: "local", roles: ["ops", "default"], options: { showSettings: true } };
const admin = { username: "admin", type: "local", roles: ["admin"] };
const escalated = active.replace("groups: [local/admins]", "groups: [local/admins, local/ops]");

beforeEach(() => { written.length = 0; });

describe("saving the configuration (Settings > Roles)", () => {
  test("a settings user who is not an admin cannot grant their own group the admin role", async () => {
    const r = await call(controller.saveConfig, settingsUser, { forms_yaml: escalated });
    expect(r.status).toBe(403);
    expect(r.data.details).toMatch(/Only an admin can change who is an admin/);
    expect(written).toEqual([]);
  });

  test("nor name a user in it", async () => {
    const r = await call(controller.saveConfig, settingsUser, { forms_yaml: active.replace("groups: [local/admins]", "groups: [local/admins]\n    users: [local/bob]") });
    expect(r.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("still changes the other roles, and the admin role written another way", async () => {
    const other = active.replace("groups: [local/ops]", "groups: [local/ops, local/helpdesk]").replace("groups: [local/admins]", "groups:\n      - local/admins\n    users: []");
    const r = await call(controller.saveConfig, settingsUser, { forms_yaml: other });
    expect(r.status).toBe(200);
    expect(written).toEqual([other]);
  });

  test("reads entraid/ and azuread/ as the same group, as the sign-in does", async () => {
    const before = active;
    const entra = active.replace("groups: [local/admins]", "groups: [local/admins, azuread/it]");
    const { default: Settings } = await import("../src/models/settings.model.js");
    const spy = vi.spyOn(Settings, "getActiveConfig").mockResolvedValue(entra);
    const r = await call(controller.saveConfig, settingsUser, { forms_yaml: before.replace("groups: [local/admins]", "groups: [local/admins, entraid/it]") });
    spy.mockRestore();
    expect(r.status).toBe(200);
  });

  test("an admin changes the admin role", async () => {
    const r = await call(controller.saveConfig, admin, { forms_yaml: escalated });
    expect(r.status).toBe(200);
    expect(written).toEqual([escalated]);
  });
});

describe("importing config.yaml", () => {
  test("a settings user who is not an admin cannot import a file that changes the admin role", async () => {
    importFileRoles = [{ name: "admin", groups: ["local/admins", "local/ops"] }, { name: "default", groups: [] }];
    const r = await call(controller.importConfig, settingsUser);
    expect(r.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("nor a ytt template, whose roles cannot be read", async () => {
    importFileRoles = null;
    const r = await call(controller.importConfig, settingsUser);
    expect(r.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("imports a file whose admin role is as it is", async () => {
    importFileRoles = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }, { name: "ops", groups: ["local/x"] }];
    const r = await call(controller.importConfig, settingsUser);
    expect(r.status).toBe(200);
    expect(written).toEqual(["imported"]);
  });

  test("an admin imports any of them", async () => {
    importFileRoles = null;
    const r = await call(controller.importConfig, admin);
    expect(r.status).toBe(200);
  });
});

describe("the import's model", () => {
  test("hands the roles of the file to the check before the restore point and the write", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("../src/models/settings.model.js", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("Settings.importConfig ="), src.indexOf("Settings.exportConfig ="));
    const check = fn.indexOf("await assertRoles(roles)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(fn.indexOf("backupConfig('database')"));
    expect(check).toBeLessThan(fn.indexOf("Settings.update("));
  });
});
