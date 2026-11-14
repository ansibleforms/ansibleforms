// Since 7.3 a runner, a secret store and the other connections take their URL and token from
// their credential. A user with connections access but not the admin role could not edit the
// runner, yet could point its credential at another server and receive its jobs' secrets. A
// credential of a type that carries an address, or one a runner names, is an admin's to change,
// as the runner is. And a credential still in use is neither deleted nor renamed (409) : what
// names it would stop working without a word.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const calls = [];
// the credentials there are, by id, and the records naming each (usageCounts)
const rows = {
  1: { id: 1, name: "rte-token", credential_type: "rte" },
  2: { id: 2, name: "plain", credential_type: "userpass" },
  3: { id: 3, name: "runner-login", credential_type: "userpass" },
  4: { id: 4, name: "ldap-bind", credential_type: "ldap" },
  5: { id: 5, name: "sso-client", credential_type: "oidc", issuer: "https://idp" },
  6: { id: 6, name: "smtp-relay", credential_type: "smtp", host: "mail.local", port: 25, password: "stored" },
  7: { id: 7, name: "from-store", credential_type: "database", host: "db.local", port: 3306, secret_store: "vault", secret_ref: "db/app" },
  8: { id: 8, name: "pvwa-api", credential_type: "userpass", user: "api", password: "stored" },
};
const usage = new Map([["ldap-bind", 2], ["runner-login", 1]]);
const runnerRefs = { "runner-login": ["awx1"] };
// the CyberArk stores that write with a credential (secret_stores.pvwa_credential)
const storeRefs = { "pvwa-api": ["cyberark"] };

vi.mock("../src/models/credential.model.v2.js", async () => {
  // the real comparison of which fields say where the secret goes
  const { default: actual } = await vi.importActual("../src/models/credential.model.v2.js");
  return { default: {
    SIGNIN_TYPES: ["ldap", "entraid", "oidc"],
    targetChanged: actual.targetChanged.bind(actual),
    URL_TYPES: ["rte", "awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault", "cyberark"],
    create: async (data) => { calls.push(["create", data]); return 9; },
    update: async (data, id) => { calls.push(["update", data, id]); return true; },
    delete: async (id) => { calls.push(["delete", id]); return true; },
    findById: async (id) => ({ ...rows[id] }),
    usageOf: async (name) => usage.get(name) || 0,
    runnersUsing: async (name) => runnerRefs[name] || [],
    storesWritingWith: async (name) => storeRefs[name] || [],
  } };
});
vi.mock("../src/auth/auth_entraid.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/auth/auth_oidc.js", () => ({ default: { initialize: async () => {} } }));

const { default: controller } = await import("../src/controllers/v2/credential.controller.js");

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

const connectionsUser = { username: "ops", roles: ["ops"], options: { showConnectionsSettings: true } };
const admin = { username: "admin", roles: ["admin"], options: { showSettings: true } };

beforeEach(() => { calls.length = 0; });

describe("a credential a connection takes its address from", () => {
  test.each(["rte", "awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault", "cyberark"])("creating a %s one: refused for a connections user", async (type) => {
    const r = await call(controller.create, connectionsUser, { body: { name: "x", credential_type: type, url: "http://evil" } });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("updating or deleting one: refused for a connections user", async () => {
    expect((await call(controller.update, connectionsUser, { body: { url: "http://evil" }, params: { id: "1" } })).status).toBe(403);
    expect((await call(controller.delete, connectionsUser, { params: { id: "1" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("one a runner names, whatever its type: refused for a connections user", async () => {
    expect((await call(controller.update, connectionsUser, { body: { password: "x" }, params: { id: "3" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("an admin may", async () => {
    expect((await call(controller.create, admin, { body: { name: "x", credential_type: "rte" } })).status).toBeLessThan(300);
    expect((await call(controller.update, admin, { body: { url: "http://new" }, params: { id: "1" } })).status).toBeLessThan(300);
    expect((await call(controller.delete, admin, { params: { id: "1" } })).status).toBeLessThan(300);
    expect(calls.map((c) => c[0])).toEqual(["create", "update", "delete"]);
  });

  test("other credentials stay open to connections users", async () => {
    expect((await call(controller.create, connectionsUser, { body: { name: "y", credential_type: "userpass" } })).status).toBeLessThan(300);
    expect((await call(controller.update, connectionsUser, { body: { password: "p" }, params: { id: "2" } })).status).toBeLessThan(300);
    expect((await call(controller.delete, connectionsUser, { params: { id: "2" } })).status).toBeLessThan(300);
  });
});

describe("the PVWA API user a CyberArk secret store writes with", () => {
  test("updating, renaming or deleting it: refused for a connections user", async () => {
    expect((await call(controller.update, connectionsUser, { body: { password: "x" }, params: { id: "8" } })).status).toBe(403);
    expect((await call(controller.update, connectionsUser, { body: { name: "other" }, params: { id: "8" } })).status).toBe(403);
    expect((await call(controller.delete, connectionsUser, { params: { id: "8" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("an admin may change it", async () => {
    expect((await call(controller.update, admin, { body: { password: "x" }, params: { id: "8" } })).status).toBeLessThan(300);
    expect(calls.length).toBe(1);
  });
});

describe("a credential in use", () => {
  test("is not deleted: 409, naming it", async () => {
    const r = await call(controller.delete, admin, { params: { id: "4" } });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("ldap-bind");
    expect(calls).toEqual([]);
  });

  test("is not renamed: 409", async () => {
    const r = await call(controller.update, admin, { body: { name: "other" }, params: { id: "4" } });
    expect(r.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("may still be changed under its own name", async () => {
    const r = await call(controller.update, admin, { body: { name: "ldap-bind", password: "p" }, params: { id: "4" } });
    expect(r.status).toBeLessThan(300);
    expect(calls.length).toBe(1);
  });
});

describe("a credential a sign-in reads (ldap, entraid, oidc)", () => {
  test.each(["ldap", "entraid", "oidc"])("creating a %s one: refused for a connections user", async (type) => {
    const r = await call(controller.create, connectionsUser, { body: { name: "x", credential_type: type, host: "evil" } });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("updating or deleting one: refused for a connections user", async () => {
    expect((await call(controller.update, connectionsUser, { body: { host: "evil" }, params: { id: "4" } })).status).toBe(403);
    expect((await call(controller.update, connectionsUser, { body: { issuer: "https://evil" }, params: { id: "5" } })).status).toBe(403);
    expect((await call(controller.delete, connectionsUser, { params: { id: "5" } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("an admin may", async () => {
    expect((await call(controller.create, admin, { body: { name: "x", credential_type: "oidc" } })).status).toBeLessThan(300);
    expect((await call(controller.update, admin, { body: { issuer: "https://new" }, params: { id: "5" } })).status).toBeLessThan(300);
  });
});

describe("a credential moved to another target", () => {
  test("by a connections user without a new password: the stored one is cleared", async () => {
    const r = await call(controller.update, connectionsUser, { body: { host: "evil", password: "**********" }, params: { id: "6" } });
    expect(r.status).toBeLessThan(300);
    expect(calls[0][1].password).toBe("");
  });

  test("a new port alone counts as another target", async () => {
    await call(controller.update, connectionsUser, { body: { port: "2525" }, params: { id: "6" } });
    expect(calls[0][1].password).toBe("");
  });

  test("a password typed again is kept", async () => {
    await call(controller.update, connectionsUser, { body: { host: "new", password: "typed" }, params: { id: "6" } });
    expect(calls[0][1].password).toBe("typed");
  });

  test("the same target sent back keeps the stored password", async () => {
    await call(controller.update, connectionsUser, { body: { host: " mail.local ", port: "25", password: "**********" }, params: { id: "6" } });
    expect(calls[0][1].password).toBe("**********");
  });

  test("a secret store reference sent back as it is is cleared too", async () => {
    await call(controller.update, connectionsUser, { body: { host: "evil", secret_store: "vault", secret_ref: "db/app" }, params: { id: "7" } });
    expect(calls[0][1]).toMatchObject({ password: "", secret_store: null, secret_ref: null });
  });

  test("an admin's change is left as it is", async () => {
    await call(controller.update, admin, { body: { host: "new", password: "**********" }, params: { id: "6" } });
    expect(calls[0][1].password).toBe("**********");
  });
});
