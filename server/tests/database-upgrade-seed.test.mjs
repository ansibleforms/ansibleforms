// Connections > Databases on an upgrade and in the config seed.
//   - the schema : the databases table on a fresh install and on an upgrade, in the manifest
//   - the upgrade fills the section once : a database for each database credential, by its name
//     and naming it (models/schema.model.js addDatabasesForCredentials) ; the credentials keep
//     everything they have, and a second run (or a database deleted later) makes nothing
//   - the seed : a databases section, after the credentials it names
//   - a credential a database names is in use : its delete and its rename are refused
// The upgrade itself on MariaDB and MySQL is .github/workflows/ci.yml's (scripts/ci-upgrade.mjs).
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
// the fake database : the statements of addDatabasesForCredentials
// ------------------------------------------------------------------
const db = { markers: new Set(), credentials: [], databases: [], statements: [] };
async function run(sql, params = []) {
  db.statements.push(sql);
  if (/FROM AnsibleForms\.`schema_migrations` WHERE name = \?/.test(sql)) return db.markers.has(params[0]) ? [{ 1: 1 }] : [];
  if (/INSERT IGNORE INTO AnsibleForms\.`schema_migrations`/.test(sql)) {
    db.markers.add(params[0]);
    return { affectedRows: 1 };
  }
  if (/FROM AnsibleForms\.`credentials` c/.test(sql)) {
    // the statement's own rule : of type database, or no type and the flag ; no database of its name
    return db.credentials
      .filter((c) => c.credential_type === "database" || (!c.credential_type && c.is_database === 1))
      .filter((c) => !db.databases.some((d) => d.name === c.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (/INSERT INTO AnsibleForms\.`databases`/.test(sql)) {
    db.databases.push({ name: params[0], description: params[1], credential: params[2] });
    return { affectedRows: 1 };
  }
  return [];
}
vi.mock("../src/models/db.model.js", () => ({
  default: { do: (sql, params) => run(sql, params), tryDo: async () => [], transaction: async (fn) => fn(run) },
}));

const { addDatabasesForCredentials, SCHEMA_MANIFEST } = await import("../src/models/schema.model.js");
const { validateSeed } = await import("../src/lib/seed-schema.js");
const { listSections } = await import("../src/lib/seed.js");

beforeEach(() => {
  db.markers = new Set();
  db.statements.length = 0;
  db.databases = [{ name: "taken", description: "mine", credential: "other" }];
  db.credentials = [
    { name: "cmdb", credential_type: "database", is_database: 1, description: "The CMDB" },
    { name: "legacy", credential_type: null, is_database: 1, description: "" },
    { name: "taken", credential_type: "database", is_database: 1, description: "" },
    { name: "ssh", credential_type: "ssh", is_database: 0, description: "" },
  ];
});

// ------------------------------------------------------------------
// the schema
// ------------------------------------------------------------------
describe("the databases table", () => {
  test("a fresh install and an upgrade make the same one", () => {
    const table = (sql) => /CREATE TABLE `databases` \(([\s\S]*?)\) ENGINE/.exec(sql)?.[1].replace(/\s+/g, " ").trim();
    const fresh = table(read("src/db/create_schema_and_tables.sql"));
    expect(fresh).toBeTruthy();
    expect(fresh).toBe(table(read("src/db/create_databases_table.sql")));
    expect(fresh).toMatch(/`credential` varchar\(250\) NOT NULL/);
    expect(fresh).toMatch(/UNIQUE KEY .*\(`name`\)/);
  });

  test("is in the schema manifest, and the 7 patch adds it", () => {
    expect(SCHEMA_MANIFEST.base.tables).toContain("databases");
    expect(SCHEMA_MANIFEST.patches.patchVersion7.tables).toContain("databases");
    const patch = /async function patchVersion7\([\s\S]*?\n\}/.exec(read("src/models/schema.model.js"))[0];
    expect(patch).toMatch(/addTable\("databases"/);
    expect(patch.indexOf('addTable("databases"')).toBeLessThan(patch.indexOf("addDatabasesForCredentials()"));
  });
});

// ------------------------------------------------------------------
// the upgrade : the section filled once
// ------------------------------------------------------------------
describe("the upgrade", () => {
  test("makes a database for each database credential, by its name and naming it", async () => {
    const message = await addDatabasesForCredentials();
    expect(db.databases).toEqual([
      { name: "taken", description: "mine", credential: "other" },
      { name: "cmdb", description: "The CMDB", credential: "cmdb" },
      { name: "legacy", description: null, credential: "legacy" },
    ]);
    expect(message).toMatch(/cmdb, legacy/);
    expect(db.markers.has("databases_from_credentials")).toBe(true);
  });

  test("changes no credential", async () => {
    await addDatabasesForCredentials();
    expect(db.statements.filter((s) => /UPDATE|DELETE/i.test(s) && /credentials/.test(s))).toEqual([]);
  });

  test("a second run makes nothing, a database deleted after it does not come back", async () => {
    await addDatabasesForCredentials();
    db.databases = db.databases.filter((d) => d.name !== "cmdb");
    const before = db.databases.length;
    expect(await addDatabasesForCredentials()).toBeNull();
    expect(db.databases.length).toBe(before);
  });

  test("a fresh install records it too, with nothing to make", async () => {
    db.credentials = [];
    expect(await addDatabasesForCredentials()).toBeNull();
    expect(db.markers.has("databases_from_credentials")).toBe(true);
  });
});

// ------------------------------------------------------------------
// the config seed
// ------------------------------------------------------------------
describe("the seed's databases section", () => {
  test("declares a name, a description and a credential", () => {
    expect(() =>
      validateSeed({
        credentials: { items: [{ name: "cmdb-login", credential_type: "database", db_type: "mysql", host: "db" }] },
        databases: { items: [{ name: "cmdb", description: "The CMDB", credential: "cmdb-login" }] },
      }),
    ).not.toThrow();
  });

  test("its credential is required, and nothing else is accepted", () => {
    expect(() => validateSeed({ databases: { items: [{ name: "cmdb" }] } })).toThrow(/validation failed/);
    expect(() => validateSeed({ databases: { items: [{ name: "cmdb", credential: "" }] } })).toThrow(/validation failed/);
    expect(() => validateSeed({ databases: { items: [{ name: "cmdb", credential: "c", host: "db" }] } })).toThrow(/'host'/);
    expect(() => validateSeed({ databases: { items: [{ name: "a", credential: "c" }, { name: "a", credential: "c" }] } })).toThrow(
      /duplicate databases names/,
    );
  });

  test("is applied after the credentials it names", () => {
    const keys = listSections.map((s) => s.key);
    expect(keys).toContain("databases");
    expect(keys.indexOf("credentials")).toBeLessThan(keys.indexOf("databases"));
    expect(listSections.find((s) => s.key === "databases").modelName).toBe("database");
  });

  test("an old seed with database credentials and no databases section is still valid", () => {
    expect(() =>
      validateSeed({ credentials: { items: [{ name: "cmdb", is_database: true, db_type: "mysql", host: "db", db_name: "cmdb" }] } }),
    ).not.toThrow();
  });
});

// ------------------------------------------------------------------
// a credential a database names is in use
// ------------------------------------------------------------------
describe("the credential a database names", () => {
  test("counts as used : its delete and its rename are refused (assertUnused reads usageCounts)", () => {
    const usage = /static async usageCounts\(\) \{([\s\S]*?)\n {2}\}/.exec(read("src/models/credential.model.v2.js"))[1];
    expect(usage).toMatch(/SELECT credential FROM AnsibleForms\.`databases`/);
  });
});
