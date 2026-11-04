// A MySQL query connects with the credential's connection options only (lib/mysql.js) : a
// credential's other columns (tenant_id, issuer, redirect_uri, its secret store) made mysql2 warn
// on every connection, and a later mysql2 refuses them.
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";

const connected = [];
vi.mock("mysql2/promise.js", () => ({
  default: {
    createConnection: async (config) => {
      connected.push(config);
      return { query: async () => [[{ ok: 1 }]], end: async () => {} };
    },
  },
}));
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    resolveCredential: async () => ({
      name: "cmdb",
      host: "db.example.com",
      port: 3306,
      user: "reader",
      password: "s3cret",
      db_name: "cmdb",
      db_type: "mysql",
      secure: 0,
      is_database: 1,
      tenant_id: null,
      issuer: null,
      redirect_uri: null,
      secret_store: "vault",
      secret_ref: "secret/cmdb",
    }),
  },
}));

const MySql = (await import("../src/lib/mysql.js")).default;

describe("a MySQL connection", () => {
  test("only the options mysql2 knows, the database and TLS from the credential", async () => {
    assert.deepEqual(await MySql.query("cmdb", "select 1"), [{ ok: 1 }]);
    assert.deepEqual(Object.keys(connected[0]).sort(), [
      "database",
      "host",
      "multipleStatements",
      "password",
      "port",
      "ssl",
      "user",
    ]);
    assert.equal(connected[0].database, "cmdb");
    assert.equal(connected[0].ssl.sslmode, "none");
  });

  test("an option not set is left out, never sent empty", () => {
    assert.deepEqual(MySql.clean({ host: "h", port: null, user: "u", tenant_id: "t" }), { host: "h", user: "u" });
  });
});
