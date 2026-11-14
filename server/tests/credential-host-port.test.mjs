// A user and password or an api credential may carry an optional host and port (issue #1326) :
// stored as an ssh or a database one's are, and handed to the playbook and the expressions with
// the credential, so a playbook reads `cred.host` and `cred.port` from the credential it is sent
// rather than from a separate field. A credential that reads its secret from a store keeps its own
// host and port, and only takes the secret's where it leaves them empty.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH ||= "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── the database : rows by name, the resolver's REGEXP emulated with RegExp ────────────────────
let rows = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      if (/WHERE name REGEXP \?/.test(sql)) {
        const re = new RegExp(Array.isArray(vars) ? vars[0] : vars);
        return rows.filter((r) => re.test(r.name)).map((r) => ({ ...r }));
      }
      if (/WHERE name\s*=\s*\?|WHERE `?name`?\s*=\s*\?/i.test(sql)) {
        const name = Array.isArray(vars) ? vars[0] : vars;
        return rows.filter((r) => r.name === name).map((r) => ({ ...r }));
      }
      return [];
    },
  },
}));

// ─── the secret store : the payload a test sets, mapped as the real providers map it ───────────
const store = { payload: {} };
vi.mock("../src/secrets/providers/index.js", () => ({
  VAULT_STORE_NAME: "vault",
  readSecret: async () => store.payload,
  mapPayloadToCredential: (p) => ({ ...p, user: p.user ?? p.username ?? "", password: p.password ?? "" }),
  parseInlineSecret: () => null,
}));

const appConfig = (await import("./__mocks__/app.config.js")).default;
appConfig.encryptionSecret ||= "0123456789abcdef0123456789abcdef";
const crypto = (await import("../src/lib/crypto.js")).default;
const Credential = (await import("../src/models/credential.model.v2.js")).default;
const { validateSeed } = await import("../src/lib/seed-schema.js");

/**
 * A credentials row as the table holds it : a user and password one with a host and a port.
 *
 * Args:
 *   over (object): the columns that differ.
 *
 * Returns:
 *   object: the row.
 */
const row = (over = {}) => ({
  name: "netapp", credential_type: "userpass", user: "admin", password: crypto.encrypt("s3cret"),
  host: "cluster1.example.com", port: 443, db_name: "", db_type: "", secure: 0, is_database: 0,
  vault_path: null, secret_store: null, secret_ref: null, ...over,
});

beforeEach(() => {
  Credential.getCache("credential")?.flushAll();
  rows = [];
  store.payload = {};
});

describe("a user and password or an api credential's host and port are stored", () => {
  test("a create keeps them for both types, the port as a number", () => {
    for (const credential_type of ["userpass", "api"]) {
      const data = Credential.requireTypeFields(
        Credential.mirrorType(Credential.normalizePort({ credential_type, host: "api.example.com", port: "8443" }), true),
        true,
      );
      assert.equal(data.host, "api.example.com");
      assert.equal(data.port, 8443);
      assert.equal(data.is_database, 0);
    }
  });

  test("they stay optional : none is refused, and an empty port is saved as NULL", () => {
    for (const credential_type of ["userpass", "api"]) {
      const data = Credential.requireTypeFields(
        Credential.mirrorType(Credential.normalizePort({ credential_type, host: "", port: "" }), true),
        true,
      );
      assert.equal(data.host, "");
      assert.equal(data.port, null);
    }
  });

  test("a port out of range is refused, as for the other types", () => {
    assert.throws(() => Credential.normalizePort({ credential_type: "api", port: "70000" }), /1 to 65535/);
  });
});

describe("they reach the playbook and the expressions", () => {
  test("resolveCredential hands out the host and port of a user and password credential", async () => {
    rows = [row()];
    const c = await Credential.resolveCredential("netapp");
    assert.equal(c.user, "admin");
    assert.equal(c.password, "s3cret");
    assert.equal(c.host, "cluster1.example.com");
    assert.equal(c.port, 443);
  });

  test("a form's credential map (the playbook's extra vars) carries them", async () => {
    rows = [row({ name: "rest_api", credential_type: "api", host: "api.example.com", port: 8443 })];
    const creds = await Credential.resolveCredentialMap({ cred_api: "rest_api" });
    assert.equal(creds.cred_api.host, "api.example.com");
    assert.equal(creds.cred_api.port, 8443);
  });

  test("fnCredentials (an expression) gets them too", async () => {
    rows = [row()];
    const { default: fn } = await import("../src/functions/default.js");
    const c = await fn.fnCredentials("netapp");
    assert.equal(c.host, "cluster1.example.com");
    assert.equal(c.port, 443);
  });
});

describe("a credential read from a secret store", () => {
  test("takes the secret's host and port only where the row leaves them empty", async () => {
    rows = [row({ secret_store: "vault", secret_ref: "kv/netapp", password: null, host: "", port: null })];
    store.payload = { username: "svc", password: "pw", host: "from-secret.example.com", port: 8443 };
    const c = await Credential.resolveCredential("netapp");
    assert.equal(c.user, "svc");
    assert.equal(c.host, "from-secret.example.com");
    assert.equal(c.port, 8443);
  });

  test("keeps the host and port the row sets", async () => {
    rows = [row({ secret_store: "vault", secret_ref: "kv/netapp", password: null })];
    store.payload = { username: "svc", password: "pw", host: "elsewhere.example.com", port: 9999 };
    const c = await Credential.resolveCredential("netapp");
    assert.equal(c.host, "cluster1.example.com");
    assert.equal(c.port, 443);
  });
});

describe("the config seed", () => {
  test("accepts a host and a port on a user and password and an api credential", () => {
    assert.equal(
      validateSeed({
        version: 1,
        credentials: {
          items: [
            { name: "netapp", credential_type: "userpass", user: "admin", password: "x", host: "cluster1", port: 443 },
            { name: "rest", credential_type: "api", user: "svc", password: "y", host: "api.example.com", port: "8443" },
          ],
        },
      }),
      true,
    );
  });
});
