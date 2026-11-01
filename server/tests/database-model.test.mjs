// Connections > Databases (models/database.model.js) : a database is a name of its own and the
// credential of type database it connects with, as a runner names its credential. A field's
// dbConfig names a database first, else a credential (the forms of before databases), and the query
// engine connects with the database's credential : its host, port, database and login.
//
// The database is a fake answering the model's own statements : the real CrudModel, Credential,
// Query and engine libs run on it, only the drivers (mysql2, pg) record what they are handed.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ------------------------------------------------------------------
// the fake database : the databases and credentials tables
// ------------------------------------------------------------------
const state = { databases: [], credentials: [], inserted: [] };
const rowsOf = (sql) => (/databases/.test(sql) ? state.databases : state.credentials);
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params) => {
      // a natural key lookup (CrudModel.findByName)
      let m = /FROM AnsibleForms\.(databases|credentials) WHERE name = \?/.exec(sql);
      if (m) return rowsOf(m[1]).filter((r) => r.name === params[0]).map((r) => ({ ...r }));
      // what a database shows of its credentials (Database.withConnection)
      if (/credentials` WHERE name IN \(\?\)/.test(sql)) return state.credentials.filter((c) => params[0].includes(c.name));
      // the credential a pattern finds (Credential.resolveCredential), as MySQL's REGEXP
      if (/credentials` WHERE name REGEXP \?/.test(sql)) {
        const re = new RegExp(Array.isArray(params) ? params[0] : params);
        return state.credentials.filter((c) => re.test(c.name)).map((r) => ({ ...r }));
      }
      if (/^INSERT INTO AnsibleForms\.databases SET \?/.test(sql)) {
        state.inserted.push(params);
        return { insertId: 7 };
      }
      return [];
    },
    tryDo: async () => [],
  },
}));

// the drivers : what each engine connects with
const connected = [];
vi.mock("mysql2/promise.js", () => ({
  default: {
    createConnection: async (config) => {
      connected.push({ engine: "mysql", ...config });
      return { query: async () => [[{ ok: 1 }]], end: async () => {} };
    },
  },
}));
vi.mock("pg", () => ({
  Client: class {
    constructor(config) {
      connected.push({ engine: "postgres", ...config });
    }
    async connect() {}
    async query() {
      return { rows: [{ ok: 1 }] };
    }
    async end() {}
  },
}));

const appConfig = (await import("./__mocks__/app.config.js")).default;
appConfig.encryptionSecret ||= "0123456789abcdef0123456789abcdef";
const crypto = (await import("../src/lib/crypto.js")).default;
const CrudModel = (await import("../src/models/crud.model.js")).default;
const Database = (await import("../src/models/database.model.js")).default;
const Credential = (await import("../src/models/credential.model.v2.js")).default;
const Query = (await import("../src/models/query.model.js")).default;

// a credential of type database : where it connects and as whom
const dbCredential = (name, extra = {}) => ({
  name,
  credential_type: "database",
  is_database: 1,
  db_type: "mysql",
  host: `${name}.example.com`,
  port: 3307,
  db_name: "cmdb",
  secure: 0,
  user: `${name}-user`,
  password: crypto.encrypt(`${name}-secret`),
  ...extra,
});

beforeEach(() => {
  CrudModel.flushAllLocal();
  connected.length = 0;
  state.inserted.length = 0;
  state.credentials = [
    dbCredential("cmdb-login"),
    dbCredential("old-cmdb", { host: "old.example.com" }),
    // from before the types : its database flag only
    dbCredential("legacy-flag", { credential_type: null }),
    dbCredential("pg-login", { db_type: "postgres", port: 5432, db_name: "inventory" }),
    { name: "ssh-login", credential_type: "ssh", is_database: 0, host: "jump", user: "root", password: crypto.encrypt("x") },
  ];
  state.databases = [
    { id: 1, name: "cmdb", description: "The CMDB", credential: "cmdb-login", managed: 0 },
    { id: 2, name: "inventory", description: "", credential: "pg-login", managed: 0 },
    // a database named as a credential, naming another one : the database wins
    { id: 3, name: "old-cmdb", description: "", credential: "cmdb-login", managed: 0 },
  ];
});

// ------------------------------------------------------------------
// the credential a database names
// ------------------------------------------------------------------
describe("a database's credential", () => {
  test("is required on a create", async () => {
    await expect(Database.create({ name: "x" })).rejects.toThrow(/needs its credential/);
    await expect(Database.create({ name: "x", credential: "  " })).rejects.toThrow(/needs its credential/);
    expect(state.inserted).toEqual([]);
  });

  test("must exist", async () => {
    await expect(Database.create({ name: "x", credential: "nope" })).rejects.toThrow(/No credential named 'nope'/);
  });

  test("must be of type database", async () => {
    await expect(Database.create({ name: "x", credential: "ssh-login" })).rejects.toThrow(/type database: 'ssh-login' is ssh/);
    expect(state.inserted).toEqual([]);
  });

  test("a database credential is taken, one from before the types by its flag too", async () => {
    await Database.create({ name: "x", credential: "cmdb-login" });
    await Database.create({ name: "y", credential: "legacy-flag" });
    expect(state.inserted.map((r) => r.credential)).toEqual(["cmdb-login", "legacy-flag"]);
  });

  test("an update that does not send it does not check it", async () => {
    expect(await Database.assertCredentialUsable({ description: "d" })).toEqual({ description: "d" });
    await expect(Database.assertCredentialUsable({ credential: "ssh-login" })).rejects.toThrow(/type database/);
  });
});

// ------------------------------------------------------------------
// what a database shows of its credential
// ------------------------------------------------------------------
describe("a database read", () => {
  test("shows its credential's database type, database, host and port, never its login", async () => {
    const db = await Database.findByName("cmdb");
    expect(db).toMatchObject({ name: "cmdb", credential: "cmdb-login", db_type: "mysql", db_name: "cmdb", host: "cmdb-login.example.com", port: 3307 });
    expect(db).not.toHaveProperty("user");
    expect(db).not.toHaveProperty("password");
  });

  test("a credential that is gone leaves them empty", async () => {
    const [db] = await Database.withConnection([{ name: "z", credential: "gone" }]);
    expect(db).toMatchObject({ db_type: "", db_name: "", host: "", port: null });
  });
});

// ------------------------------------------------------------------
// dbConfig : a database first, else a credential
// ------------------------------------------------------------------
describe("a dbConfig name", () => {
  test("of a database connects with its credential, by its exact name", async () => {
    expect(await Database.credentialFor("cmdb")).toBe("^cmdb-login$");
    expect(Credential.exactPattern("a.b[1]")).toBe("^a\\.b\\[1\\]$");
  });

  test("of no database is a credential's, as before databases", async () => {
    expect(await Database.credentialFor("legacy-flag")).toBe("legacy-flag");
  });

  test("a string : the database's credential gives the host and the login", async () => {
    await Query.findAll("select 1", "", "cmdb", true);
    expect(connected).toEqual([
      expect.objectContaining({ engine: "mysql", host: "cmdb-login.example.com", port: 3307, database: "cmdb", user: "cmdb-login-user", password: "cmdb-login-secret" }),
    ]);
  });

  test("the database wins over a credential of the same name", async () => {
    await Query.findAll("select 1", "", "old-cmdb", true);
    expect(connected[0]).toMatchObject({ host: "cmdb-login.example.com", user: "cmdb-login-user" });
  });

  test("a credential's name still works (the forms of before databases)", async () => {
    await Query.findAll("select 1", "", "legacy-flag", true);
    expect(connected[0]).toMatchObject({ engine: "mysql", host: "legacy-flag.example.com", user: "legacy-flag-user", password: "legacy-flag-secret" });
  });

  test("an array : each its own engine, a database and a credential alike", async () => {
    const rows = await Query.findAll("select 1", "", ["inventory", "legacy-flag"], true);
    expect(rows.length).toBe(2);
    expect(connected.map((c) => [c.engine, c.host, c.user])).toEqual([
      ["postgres", "pg-login.example.com", "pg-login-user"],
      ["mysql", "legacy-flag.example.com", "legacy-flag-user"],
    ]);
    expect(connected[0]).toMatchObject({ database: "inventory", port: 5432, password: "pg-login-secret" });
  });

  test("the legacy object : its name a database too, its type as given", async () => {
    await Query.findAll("select 1", "", { name: "inventory", type: "postgres" }, true);
    expect(connected[0]).toMatchObject({ engine: "postgres", host: "pg-login.example.com" });
  });

  test("a type without an engine is refused", async () => {
    await expect(Query.findAll("select 1", "", { name: "cmdb", type: "toString" }, true)).rejects.toThrow(/Unsupported database type/);
  });
});

// ------------------------------------------------------------------
// Test connection
// ------------------------------------------------------------------
describe("Test connection", () => {
  test("runs its engine's least query on the credential", async () => {
    await Query.testConnection("^pg-login$", "postgres");
    expect(connected[0]).toMatchObject({ engine: "postgres", host: "pg-login.example.com" });
  });

  test("a credential without a database type says so", async () => {
    await expect(Query.testConnection("^cmdb-login$", "")).rejects.toMatchObject({ code: "NO_DB_TYPE" });
  });
});

// ------------------------------------------------------------------
// Used by : the forms naming a database, or its credential, in dbConfig
// ------------------------------------------------------------------
describe("the forms that use a database", () => {
  test("are counted by its name and its credential's, once per form", () => {
    const forms = [
      { name: "A", credentials: [{ name: "cmdb", where: "field x (dbConfig)" }, { name: "cmdb-login", where: "field y (dbConfig)" }] },
      { name: "B", credentials: [{ name: "cmdb-login", where: "field z (dbConfig)" }] },
      // a credential named for a playbook is no query
      { name: "C", credentials: [{ name: "cmdb", where: "credentials: db" }] },
    ];
    const counts = Database.formCounts(state.databases, forms);
    expect(counts.get("cmdb")).toBe(2);
    expect(counts.get("old-cmdb")).toBe(2);
    expect(counts.get("inventory")).toBeUndefined();
  });
});
