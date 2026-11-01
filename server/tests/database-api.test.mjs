// /api/v2/database : the databases of Connections > Databases (controllers/v2/database.controller.js).
// The credentials' role options (showSettings or showConnectionsSettings), the credentials' admin
// rule (a user who is not an admin names no credential only an admin may : a runner's, one reading
// a secret store), each write audited as a database's, its Used by count from the forms, and Test
// connection on its credential.
import { describe, test, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, "..", p), "utf8");

// ------------------------------------------------------------------
// the model, the credentials' admin rule, the forms and the test
// ------------------------------------------------------------------
const calls = [];
const stored = {
  1: { id: 1, name: "cmdb", credential: "cmdb-login", db_type: "mysql" },
  2: { id: 2, name: "vaulted", credential: "from-store", db_type: "postgres" },
  3: { id: 3, name: "untyped", credential: "no-type", db_type: "" },
};
// the credentials only an admin may name (Credential.isAdminGuarded)
const guarded = new Set(["from-store", "runner-login"]);

vi.mock("../src/models/database.model.js", async () => {
  const { default: actual } = await vi.importActual("../src/models/database.model.js");
  return {
    default: {
      formCounts: actual.formCounts.bind(actual),
      create: async (data) => { calls.push(["create", data]); return 4; },
      update: async (data, id) => { calls.push(["update", data, id]); return true; },
      delete: async (id) => { calls.push(["delete", id]); return true; },
      findById: async (id) => (stored[id] ? { ...stored[id] } : null),
      findByName: async (name) => Object.values(stored).find((d) => d.name === name) || null,
      findAll: async () => Object.values(stored).map((d) => ({ ...d })),
    },
  };
});
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    firstAdminGuarded: async (names) => names.find((n) => guarded.has(n)) || null,
    exactPattern: (name) => `^${name}$`,
  },
}));
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: async () => ({
      forms: [
        { name: "Servers", fields: [{ name: "srv", type: "enum", dbConfig: "cmdb", query: "select 1" }] },
        { name: "Old", fields: [{ name: "srv", type: "enum", dbConfig: { name: "cmdb-login", type: "mysql" }, query: "select 1" }] },
        { name: "Other", fields: [{ name: "x", type: "enum", dbConfig: ["elsewhere"], query: "select 1" }] },
      ],
    }),
  },
}));
const tested = [];
vi.mock("../src/models/query.model.js", () => ({
  default: {
    testConnection: async (credential, dbType) => {
      tested.push([credential, dbType]);
      if (!dbType) throw Object.assign(new Error("Database type not set"), { code: "NO_DB_TYPE" });
      return true;
    },
  },
}));
vi.mock("../src/auth/auth_entraid.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/auth/auth_oidc.js", () => ({ default: { initialize: async () => {} } }));

const { default: controller } = await import("../src/controllers/v2/database.controller.js");

function call(handler, user, { body = {}, params = { id: "1" }, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; },
    };
    handler({ body, params, query, headers: {}, user: { user } }, res);
  });
}

const connections = { username: "ops", roles: ["ops"], options: { showConnectionsSettings: true } };
const admin = { username: "admin", roles: ["admin"], options: { showSettings: true } };

beforeEach(() => {
  calls.length = 0;
  tested.length = 0;
});

// ------------------------------------------------------------------
// the routes
// ------------------------------------------------------------------
describe("the routes", () => {
  test("are mounted behind the credentials' role options", () => {
    const app = read("src/app.js");
    expect(app).toMatch(/app\.use\(`\/api\/v2\/database`, cors\(\), authobj, Middleware\.checkConnectionsMiddleware, databaseRoutesv2\)/);
    expect(app).toMatch(/app\.use\(`\/api\/v2\/credential`, cors\(\), authobj, Middleware\.checkConnectionsMiddleware,/);
  });

  test("list, read, create, update, delete and test", () => {
    const routes = read("src/routes/v2/database.routes.js");
    for (const r of ["get('/'", "post('/'", "get('/:id'", "put('/:id'", "delete('/:id'", "post('/:id/check'"]) {
      expect(routes).toContain(`router.${r}`);
    }
  });

  test("are audited as a database : its crud config names its table and its name", async () => {
    const { default: crud } = await import("../config/crud.config.js");
    expect(crud.database.table).toBe("AnsibleForms.databases");
    expect(crud.database.fields.find((f) => f.isNaturalKey)?.name).toBe("name");
    // no secret of its own : nothing encrypted, nothing to mask
    expect(crud.database.fields.some((f) => f.isEncrypted)).toBe(false);
  });
});

// ------------------------------------------------------------------
// the credential a write names
// ------------------------------------------------------------------
describe("the credential a database names", () => {
  test("a connections user names a plain database credential", async () => {
    const r = await call(controller.create, connections, { body: { name: "new", credential: "cmdb-login" } });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ id: 4 });
    expect(calls).toEqual([["create", { name: "new", credential: "cmdb-login" }]]);
  });

  test("a connections user names no credential only an admin may", async () => {
    const r = await call(controller.create, connections, { body: { name: "new", credential: "from-store" } });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
    const u = await call(controller.update, connections, { body: { credential: "runner-login" } });
    expect(u.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("the one it names already is not checked again", async () => {
    const r = await call(controller.update, connections, { params: { id: "2" }, body: { name: "vaulted", credential: "from-store", description: "d" } });
    expect(r.status).toBe(200);
    expect(calls).toEqual([["update", { name: "vaulted", credential: "from-store", description: "d" }, "2"]]);
  });

  test("an admin names any", async () => {
    const r = await call(controller.create, admin, { body: { name: "new", credential: "from-store" } });
    expect(r.status).toBe(201);
  });

  test("an empty body is refused, an unknown database is not found", async () => {
    expect((await call(controller.create, admin, { body: {} })).status).toBe(400);
    expect((await call(controller.update, admin, { params: { id: "99" }, body: { name: "x" } })).status).toBe(404);
    expect((await call(controller.findById, admin, { params: { id: "99" } })).status).toBe(404);
  });

  test("a delete removes the database only", async () => {
    const r = await call(controller.delete, connections, { params: { id: "1" } });
    expect(r.status).toBe(200);
    expect(calls).toEqual([["delete", "1"]]);
  });
});

// ------------------------------------------------------------------
// the list and Test connection
// ------------------------------------------------------------------
describe("the list", () => {
  test("counts the forms naming each database, or its credential, in dbConfig", async () => {
    const r = await call(controller.find, connections);
    const byName = Object.fromEntries(r.data.records.map((d) => [d.name, d.used_by_count]));
    expect(byName).toEqual({ cmdb: 2, vaulted: 0, untyped: 0 });
  });

  test("never hands out a login", async () => {
    const r = await call(controller.find, connections);
    for (const d of r.data.records) {
      expect(d).not.toHaveProperty("password");
      expect(d).not.toHaveProperty("user");
    }
  });
});

describe("Test connection", () => {
  test("tests its credential, by its exact name, with its database type", async () => {
    const r = await call(controller.check, connections, { params: { id: "2" } });
    expect(r.status).toBe(200);
    expect(tested).toEqual([["^from-store$", "postgres"]]);
  });

  test("a credential without a database type is a bad request", async () => {
    const r = await call(controller.check, connections, { params: { id: "3" } });
    expect(r.status).toBe(400);
  });
});
