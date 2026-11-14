// An LDAP or SSO user who has the admin role is the admin role's own to change, as a local admin
// account is (lib/adminGrants.js assertMayTouchAdmin) : a user with settings access but not the
// admin role could otherwise block every admin's sign-in, end their sessions, forget them or
// revoke their api tokens. Admin by the config's admin role (the user or one of its groups), or
// by a role whose options say admin: true (lib/adminRole.js), or by the roles it had at its last
// sign-in.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the users seen at a sign-in, and the config's roles
const seen = [
  { type: "ldap", username: "Boss", groups: ["ldap/domain admins"], roles: ["public"] },
  { type: "oidc", username: "ceo", groups: [], roles: ["public", "admin"] },
  { type: "ldap", username: "jdoe", groups: ["ldap/ops"], roles: ["public", "ops"] },
  // an admin through a role with admin: true, its last sign-in before the option was set
  { type: "ldap", username: "infraboss", groups: ["ldap/infra-admins"], roles: ["public", "platformAdmins"] },
];
const roles = [
  { name: "admin", groups: ["ldap/domain admins"], users: ["azuread/root"] },
  { name: "ops", groups: ["ldap/ops"], users: [] },
  { name: "platformAdmins", groups: ["ldap/infra-admins"], users: ["oidc/cto"], options: { admin: true } },
  { name: "public", groups: [], users: [] },
];
const changes = [];
vi.mock("../src/models/directoryUser.model.js", () => ({
  DIRECTORY_TYPES: ["ldap", "azuread", "oidc"],
  default: {
    findAll: async () => seen.map((u) => ({ ...u })),
    setBlocked: async (type, name, blocked) => { changes.push(["block", type, name, blocked]); },
    forget: async (type, name) => { changes.push(["forget", type, name]); return true; },
  },
}));
vi.mock("../src/lib/roleCounts.js", () => ({ configRoles: async () => roles }));
vi.mock("../src/lib/tokenRevocation.js", () => ({ revokeUser: async (name, type) => { changes.push(["revoke", type, name]); } }));
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
vi.mock("../src/models/apiToken.model.js", () => ({
  default: { revoke: async (sid, name, type) => { changes.push(["token", type, name, sid]); return true; }, findForUser: async () => [] },
}));

const { default: controller } = await import("../src/controllers/v2/directory.controller.js");
const { default: tokens } = await import("../src/controllers/v2/apiToken.controller.js");

function call(handler, user, params, body = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; },
    };
    handler({ params, body, headers: {}, user: { user } }, res);
  });
}

const settingsUser = { username: "helpdesk", type: "local", roles: ["helpdesk"], options: { showSettings: true } };
const admin = { username: "admin", type: "local", roles: ["admin"], options: { showSettings: true } };

beforeEach(() => { changes.length = 0; });

describe("a directory user with the admin role, changed by a settings user who is not an admin", () => {
  test("admin through a group of the admin role: blocking, ending sessions, forgetting refused", async () => {
    const params = { type: "ldap", name: "boss" };
    expect((await call(controller.setBlocked, settingsUser, params, { blocked: true })).status).toBe(403);
    expect((await call(controller.endUserSessions, settingsUser, params)).status).toBe(403);
    expect((await call(controller.forgetUser, settingsUser, params)).status).toBe(403);
    expect(changes).toEqual([]);
  });

  test("admin by its roles at its last sign-in: refused", async () => {
    expect((await call(controller.setBlocked, settingsUser, { type: "oidc", name: "ceo" }, { blocked: true })).status).toBe(403);
  });

  test("admin by name in the admin role, never seen: refused", async () => {
    expect((await call(controller.endUserSessions, settingsUser, { type: "azuread", name: "root" })).status).toBe(403);
  });

  test("admin through a role with admin: true, by a group seen: blocking, ending sessions, forgetting refused", async () => {
    const params = { type: "ldap", name: "infraboss" };
    expect((await call(controller.setBlocked, settingsUser, params, { blocked: true })).status).toBe(403);
    expect((await call(controller.endUserSessions, settingsUser, params)).status).toBe(403);
    expect((await call(controller.forgetUser, settingsUser, params)).status).toBe(403);
    expect((await call(tokens.revokeForUser, settingsUser, { ...params, sid: "s1" })).status).toBe(403);
    expect(changes).toEqual([]);
  });

  test("admin by name in a role with admin: true, never seen: refused", async () => {
    expect((await call(controller.setBlocked, settingsUser, { type: "oidc", name: "cto" }, { blocked: true })).status).toBe(403);
    expect(changes).toEqual([]);
  });

  test("its api tokens: not revoked", async () => {
    expect((await call(tokens.revokeForUser, settingsUser, { type: "ldap", name: "boss", sid: "s1" })).status).toBe(403);
    expect(changes).toEqual([]);
  });

  test("another user stays theirs to change", async () => {
    const params = { type: "ldap", name: "jdoe" };
    expect((await call(controller.setBlocked, settingsUser, params, { blocked: true })).status).toBe(200);
    expect((await call(tokens.revokeForUser, settingsUser, { ...params, sid: "s1" })).status).toBe(200);
  });

  test("an admin changes an admin", async () => {
    expect((await call(controller.endUserSessions, admin, { type: "ldap", name: "boss" })).status).toBe(200);
    expect((await call(controller.forgetUser, admin, { type: "oidc", name: "ceo" })).status).toBe(200);
  });
});
