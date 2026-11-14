// A credential's typed user and password written to a secret store (secret_write, with or without
// secret_overwrite) only once the save is going to pass its own checks : a name another credential
// has, a field the credential cannot be saved with, a credential that is not there or is managed by
// the config seed refuse the save, and the store is never written. A save that still fails after
// the write (the database refusing it) logs where the secret was written, never the secret.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ---------------------------------------------------------------------------------------------
// the database : the credentials there, and what was written to it
// ---------------------------------------------------------------------------------------------
const rows = [
  { id: 1, name: "db1", credential_type: "userpass", user: "", password: "", secret_store: "vault", secret_ref: "secret/ansibleforms/db1", managed: 0 },
  { id: 2, name: "db2", credential_type: "userpass", user: "", password: "", secret_store: "vault", secret_ref: "secret/ansibleforms/db2", managed: 0 },
  { id: 3, name: "seeded", credential_type: "userpass", user: "", password: "", secret_store: "vault", secret_ref: "secret/ansibleforms/seeded", managed: 1 },
];
const dbWrites = [];
let failWrite = null;
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params) => {
      // the writes : recorded, or refused as the test asks
      if (/^\s*(INSERT|UPDATE)\s/i.test(sql) && /credentials/.test(sql)) {
        if (failWrite) throw failWrite;
        dbWrites.push({ sql, params });
        return { insertId: 9, affectedRows: 1 };
      }
      // the reads : by id (exists, managed, the row) or by name
      if (/credentials/.test(sql + JSON.stringify(params)) && /WHERE\s+(\?\?|id)\s*=\s*\?/i.test(sql)) {
        const id = Array.isArray(params) ? params[params.length - 1] : params;
        return rows.filter((r) => String(r.id) === String(id)).map((r) => ({ ...r }));
      }
      if (/credentials/.test(sql) && /WHERE\s+name\s*=\s*\?/i.test(sql)) {
        return rows.filter((r) => r.name === params[0]).map((r) => ({ ...r }));
      }
      return [];
    },
  },
}));
vi.mock("../src/lib/epochs.js", () => ({ bump: async () => {} }));
vi.mock("../src/auth/auth_entraid.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/auth/auth_oidc.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: () => {} } }));
// what the app logged
const errors = [];
vi.mock("../src/lib/logger.js", () => ({
  default: {
    error: (m) => errors.push(String(m)),
    warning: () => {},
    warn: () => {},
    info: () => {},
    notice: () => {},
    debug: () => {},
  },
}));
// the store's writes
const written = [];
vi.mock("../src/secrets/providers/index.js", async () => {
  const actual = await vi.importActual("../src/secrets/providers/index.js");
  return {
    ...actual,
    writeSecret: async (store, ref, payload, opts) => {
      written.push({ store, ref, payload, opts });
      return { store, ref, replaced: !!opts?.overwrite };
    },
  };
});

const { default: controller } = await import("../src/controllers/v2/credential.controller.js");

/**
 * Calls a controller handler as a user, and gives what it answered.
 *
 * Args:
 *   handler (function): the handler.
 *   user (object): the signed-in user.
 *   req (object): the request's body and params.
 *
 * Returns:
 *   Promise<object>: { status, data } as it answered.
 */
function call(handler, user, { body = {}, params = { id: "1" } } = {}) {
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
    handler({ body, params, query: {}, headers: {}, ip: "127.0.0.1", user: { user } }, res);
  });
}

const admin = { username: "admin", type: "local", roles: ["admin"] };
// a new credential written over the place another one reads, replacing the secret there
const NEW = { name: "db3", credential_type: "userpass", user: "svc", password: "s3cret!", secret_store: "vault", secret_ref: "secret/ansibleforms/db1", secret_write: true, secret_overwrite: true };

beforeEach(() => {
  written.length = 0;
  dbWrites.length = 0;
  errors.length = 0;
  failWrite = null;
});

describe("a new credential with Write and Overwrite", () => {
  test("a name another credential has : 409, the store never written", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW, name: "db1" } });
    expect(r.status).toBe(409);
    expect(written).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  test("an invalid field (a port) : 400, the store never written", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW, port: "99999" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  test("a field its type needs missing (an smtp one's host) : 400, the store never written", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW, credential_type: "smtp" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });

  test("an unknown type : 400, the store never written", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW, credential_type: "nope" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });

  test("no name : 400, the store never written", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW, name: "" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });

  test("a valid one : the store written, then the credential with the reference only", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW } });
    expect(r.status).toBe(200);
    expect(written).toEqual([{ store: "vault", ref: "secret/ansibleforms/db1", payload: { username: "svc", password: "s3cret!" }, opts: { overwrite: true } }]);
    expect(dbWrites).toHaveLength(1);
    expect(dbWrites[0].params).toMatchObject({ name: "db3", secret_store: "vault", secret_ref: "secret/ansibleforms/db1", user: "" });
  });

  test("the database refusing the save after the write : the error answered, where it was written logged without the secret", async () => {
    failWrite = Object.assign(new Error("Duplicate entry 'db3' for key 'name'"), { code: "ER_DUP_ENTRY" });
    const r = await call(controller.create, admin, { body: { ...NEW } });
    expect(r.status).toBe(409);
    expect(written).toHaveLength(1);
    const line = errors.find((e) => e.includes("was not saved after its secret was written"));
    expect(line).toContain("'db3'");
    expect(line).toContain("'vault'");
    expect(line).toContain("'secret/ansibleforms/db1'");
    expect(errors.join("\n")).not.toContain("s3cret!");
  });
});

describe("a credential changed with Write and Overwrite", () => {
  const CHANGE = { user: "svc2", password: "n3w!", secret_write: true, secret_overwrite: true };

  test("renamed to a name another credential has : 409, the store never written", async () => {
    const r = await call(controller.update, admin, { body: { ...CHANGE, name: "db2" }, params: { id: "1" } });
    expect(r.status).toBe(409);
    expect(written).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  test("an invalid field (a port) : 400, the store never written", async () => {
    const r = await call(controller.update, admin, { body: { ...CHANGE, port: "abc" }, params: { id: "1" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });

  test("another type than the one it was made as : 400, the store never written", async () => {
    const r = await call(controller.update, admin, { body: { ...CHANGE, credential_type: "ssh" }, params: { id: "1" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });

  test("one managed by the config seed : 403, the store never written", async () => {
    const r = await call(controller.update, admin, { body: { ...CHANGE }, params: { id: "3" } });
    expect(r.status).toBe(403);
    expect(written).toEqual([]);
  });

  test("its own name sent back : written, then saved", async () => {
    const r = await call(controller.update, admin, { body: { ...CHANGE, name: "db1" }, params: { id: "1" } });
    expect(r.status).toBe(200);
    expect(written).toEqual([{ store: "vault", ref: "secret/ansibleforms/db1", payload: { username: "svc2", password: "n3w!" }, opts: { overwrite: true } }]);
    expect(dbWrites).toHaveLength(1);
  });
});
