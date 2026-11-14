// A credential's user and password typed in the app and written to a secret store (the dialog's
// Write to a secret store : secret_write) : the store first, then the credential with the
// reference only ; an admin's ; refused with nothing saved when the store refuses.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// what the model was asked to write, and the credentials there are
const calls = [];
const rows = {
  2: { id: 2, name: "vaulted", credential_type: "userpass", user: "", secret_store: "vault", secret_ref: "secret/ansibleforms/app" },
};
vi.mock("../src/models/credential.model.v2.js", async () => {
  const { default: actual } = await vi.importActual("../src/models/credential.model.v2.js");
  return {
    default: {
      SIGNIN_TYPES: actual.SIGNIN_TYPES,
      URL_TYPES: actual.URL_TYPES,
      TARGET_FIELDS: actual.TARGET_FIELDS,
      targetChanged: actual.targetChanged,
      isAdminGuarded: actual.isAdminGuarded,
      create: async (data) => {
        calls.push(["create", { ...data }]);
        return 9;
      },
      update: async (data, id) => {
        calls.push(["update", { ...data }, id]);
        return true;
      },
      // the save's own checks, run before the store is written (credential-secret-write-checks)
      assertSavable: async () => {},
      findById: async (id) => ({ ...rows[id] }),
      usageOf: async () => 0,
      runnersUsing: async () => [],
    },
  };
});
vi.mock("../src/auth/auth_entraid.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/auth/auth_oidc.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: (e) => audits.push(e) } }));
// the store's writes, and what it answers
const audits = [];
const written = [];
let refuse = null;
vi.mock("../src/secrets/providers/index.js", () => ({
  writeSecret: async (store, ref, payload, opts) => {
    if (refuse) throw refuse;
    written.push({ store, ref, payload, opts });
    return { store, ref, replaced: !!opts?.overwrite };
  },
}));

const { default: controller } = await import("../src/controllers/v2/credential.controller.js");
const Errors = (await import("../src/lib/errors.js")).default;

function call(handler, user, { body = {}, params = { id: "2" } } = {}) {
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
const operator = { username: "bob", type: "local", roles: ["ops"], options: { showConnectionsSettings: true } };
const NEW = { name: "db-login", description: "x", credential_type: "userpass", user: "svc", password: "s3cret!", secret_store: "vault", secret_ref: "secret/ansibleforms/db", secret_write: true };

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  audits.length = 0;
  refuse = null;
});

describe("a new credential written to a secret store", () => {
  test("the store first, then the credential with the reference only, audited without the secret", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW } });
    expect(r.status).toBe(200);
    expect(written).toEqual([{ store: "vault", ref: "secret/ansibleforms/db", payload: { username: "svc", password: "s3cret!" }, opts: { overwrite: false } }]);
    const [, saved] = calls[0];
    expect(saved).toMatchObject({ name: "db-login", secret_store: "vault", secret_ref: "secret/ansibleforms/db", user: "", password: "" });
    expect(saved.secret_write).toBeUndefined();
    expect(audits[0]).toMatchObject({ action: "credential.secret_write", target: "db-login", detail: { store: "vault", ref: "secret/ansibleforms/db" } });
    expect(JSON.stringify(audits)).not.toMatch(/s3cret/);
  });

  test("an admin's : anyone else refused, nothing written nor saved", async () => {
    const r = await call(controller.create, operator, { body: { ...NEW } });
    expect(r.status).toBe(403);
    expect(written).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("the store refusing (a secret there, no overwrite) : its answer, nothing saved", async () => {
    refuse = Object.assign(new Errors.ConflictError("Secret store 'vault' has a secret at secret/ansibleforms/db already: tick Overwrite to replace it"), { code: "secretExists" });
    const r = await call(controller.create, admin, { body: { ...NEW } });
    expect(r.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("no password typed (the mask sent back) : refused, nothing written", async () => {
    const r = await call(controller.create, admin, { body: { ...NEW, password: "********" } });
    expect(r.status).toBe(400);
    expect(written).toEqual([]);
  });
});

describe("a new password for a credential that reads a store", () => {
  test("written over the secret it reads, with overwrite ; the credential keeps its reference", async () => {
    const r = await call(controller.update, admin, { body: { user: "svc2", password: "n3w!", secret_write: true, secret_overwrite: true } });
    expect(r.status).toBe(200);
    expect(written).toEqual([{ store: "vault", ref: "secret/ansibleforms/app", payload: { username: "svc2", password: "n3w!" }, opts: { overwrite: true } }]);
    expect(calls[0][1]).toMatchObject({ secret_store: "vault", secret_ref: "secret/ansibleforms/app", user: "", password: "" });
  });
});
