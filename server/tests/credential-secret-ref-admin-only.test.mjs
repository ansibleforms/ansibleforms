// A credential naming a secret store and a secret_ref (or the deprecated vault_path) is given that
// secret when it is used. A user with only connections access could point a credential of theirs
// at any path of any store and name it in a webhook to receive the secret. These pin the rules :
// setting or changing secret_store, secret_ref or vault_path is an admin's on any credential (sent
// back unchanged, or all emptied, is left to the others), and a credential that reads a secret
// store is one only an admin may name elsewhere (isAdminGuarded).
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ---------------------------------------------------------------------------------------------
// The credentials there are, and what the model was asked to write
// ---------------------------------------------------------------------------------------------

const calls = [];
const rows = {
  1: { id: 1, name: "plain", credential_type: "userpass", user: "u", password: "stored" },
  2: { id: 2, name: "vaulted", credential_type: "userpass", user: "u", secret_store: "vault", secret_ref: "team-a/app" },
  3: { id: 3, name: "legacy", credential_type: "userpass", user: "u", vault_path: "old/path" },
};

vi.mock("../src/models/credential.model.v2.js", async () => {
  // the real comparisons of which fields say where the secret goes, and who may name a credential
  const { default: actual } = await vi.importActual("../src/models/credential.model.v2.js");
  return { default: {
    SIGNIN_TYPES: actual.SIGNIN_TYPES,
    URL_TYPES: actual.URL_TYPES,
    TARGET_FIELDS: actual.TARGET_FIELDS,
    targetChanged: actual.targetChanged,
    isAdminGuarded: actual.isAdminGuarded,
    create: async (data) => { calls.push(["create", { ...data }]); return 9; },
    update: async (data, id) => { calls.push(["update", { ...data }, id]); return true; },
    findById: async (id) => ({ ...rows[id] }),
    usageOf: async () => 0,
    runnersUsing: async () => [],
    storesWritingWith: async () => [],
  } };
});
vi.mock("../src/auth/auth_entraid.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/auth/auth_oidc.js", () => ({ default: { initialize: async () => {} } }));

const { default: controller } = await import("../src/controllers/v2/credential.controller.js");
const { default: Credential } = await import("../src/models/credential.model.v2.js");

/**
 * Calls a controller handler as the given user, and answers what it sent.
 *
 * Args:
 *   handler (Function): the controller's handler.
 *   user (object): the signed-in user (its roles).
 *   opts (object): { body, params } of the request.
 *
 * Returns:
 *   Promise<{status: number, data: object}>: the answer.
 */
function call(handler, user, { body = {}, params = { id: "1" } } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; },
    };
    handler({ body, params, headers: {}, user: { user } }, res);
  });
}

const ops = { username: "ops", roles: ["ops"], options: { showConnectionsSettings: true } };
const admin = { username: "admin", roles: ["admin"] };

beforeEach(() => { calls.length = 0; });

// ---------------------------------------------------------------------------------------------
// Choosing the secret a credential reads
// ---------------------------------------------------------------------------------------------

describe("a connections user", () => {
  test("may not create a credential that reads a secret store", async () => {
    expect((await call(controller.create, ops, { body: { name: "x", credential_type: "userpass", secret_store: "vault", secret_ref: "team-b/db" } })).status).toBe(403);
    expect((await call(controller.create, ops, { body: { name: "x", credential_type: "userpass", vault_path: "team-b/db" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test.each([
    ["a store on a plain one", "1", { secret_store: "vault", secret_ref: "team-b/db" }],
    ["the secret_ref", "2", { secret_store: "vault", secret_ref: "team-b/db" }],
    ["the store", "2", { secret_store: "other" }],
    ["the vault_path", "3", { vault_path: "team-b/db" }],
    ["the store, emptying it only", "2", { secret_store: "" }],
  ])("may not set or change %s", async (_label, id, body) => {
    expect((await call(controller.update, ops, { body, params: { id } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("may save one with them sent back unchanged", async () => {
    const r = await call(controller.update, ops, { body: { secret_store: "vault", secret_ref: " team-a/app ", user: "v" }, params: { id: "2" } });
    expect(r.status).toBeLessThan(300);
    expect(calls[0][1].user).toBe("v");
  });

  test("may drop the reference altogether", async () => {
    const r = await call(controller.update, ops, { body: { secret_store: "", secret_ref: "", vault_path: "" }, params: { id: "2" } });
    expect(r.status).toBeLessThan(300);
  });

  test("may still create a plain credential", async () => {
    expect((await call(controller.create, ops, { body: { name: "y", credential_type: "userpass", password: "p" } })).status).toBeLessThan(300);
  });
});

describe("an admin", () => {
  test("may set and change them", async () => {
    expect((await call(controller.create, admin, { body: { name: "x", credential_type: "userpass", secret_store: "vault", secret_ref: "a/b" } })).status).toBeLessThan(300);
    expect((await call(controller.update, admin, { body: { secret_ref: "c/d" }, params: { id: "2" } })).status).toBeLessThan(300);
    expect(calls.map((c) => c[0])).toEqual(["create", "update"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Naming a credential that reads a secret store
// ---------------------------------------------------------------------------------------------

describe("isAdminGuarded", () => {
  test("a credential reading a secret store (or a vault_path) is an admin's to name", async () => {
    expect(await Credential.isAdminGuarded({ credential_type: "userpass", secret_store: "vault", secret_ref: "x" })).toBe(true);
    expect(await Credential.isAdminGuarded({ credential_type: "userpass", vault_path: "x" })).toBe(true);
  });

  test("a plain one is not", async () => {
    expect(await Credential.isAdminGuarded({ credential_type: "userpass", secret_store: null, vault_path: "" })).toBe(false);
  });
});
