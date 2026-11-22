// The REAL SCHEMA_MANIFEST against the REAL fresh-install SQL.
//
// health.model.js's schema check compares the manifest with information_schema, so the
// manifest is the definition of "complete". The existing health tests feed it a fabricated
// two-entry manifest, which exercises the set-difference algorithm - not the part that
// drifts. What drifts is the manifest itself: a table or column added to
// create_schema_and_tables.sql and to a patch, but forgotten in the manifest, makes the
// Status page report `schema: complete` on a database that is missing it. That is the one
// thing that row exists to catch, so it needs a test that reads both real files.
//
// Deliberately parsed as TEXT rather than imported: schema.model.js pulls in db.model and
// init, i.e. a database connection, and this needs neither.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(here, "../src/db/create_schema_and_tables.sql");
const MODEL_PATH = path.join(here, "../src/models/schema.model.js");

const sql = readFileSync(SQL_PATH, "utf8");
const model = readFileSync(MODEL_PATH, "utf8");

// ── what the fresh-install SQL builds ────────────────────────────────────────────────
const sqlTables = new Set(
  [...sql.matchAll(/CREATE TABLE\s+`?(\w+)`?/gi)].map((m) => m[1])
);
// columns, per CREATE TABLE block
const sqlColumns = new Set();
for (const block of sql.split(/CREATE TABLE\s+/i).slice(1)) {
  const table = /^`?(\w+)`?/.exec(block)?.[1];
  const body = block.slice(0, block.search(/\)\s*ENGINE=/i));
  for (const m of body.matchAll(/^\s*`(\w+)`\s+\w/gm)) sqlColumns.add(`${table}.${m[1]}`);
}
const sqlIndexes = new Set();
for (const block of sql.split(/CREATE TABLE\s+/i).slice(1)) {
  const table = /^`?(\w+)`?/.exec(block)?.[1];
  for (const m of block.matchAll(/^\s*(?:UNIQUE\s+)?KEY\s+`(\w+)`/gim)) sqlIndexes.add(`${table}.${m[1]}`);
}

// ── what the manifest claims must exist ──────────────────────────────────────────────
function manifest() {
  const block = /const SCHEMA_MANIFEST = \{[\s\S]*?\n\};/.exec(model)[0];
  const pick = (name) => {
    const out = new Set();
    for (const m of block.matchAll(new RegExp(`${name}: \\[([\\s\\S]*?)\\]`, "g"))) {
      for (const v of m[1].matchAll(/'([\w.]+)'/g)) out.add(v[1]);
    }
    return out;
  };
  return { tables: pick("tables"), columns: pick("columns"), indexes: pick("indexes") };
}

// ── what the patches add ─────────────────────────────────────────────────────────────
const patchColumns = new Set(
  [...model.matchAll(/addColumn\("(\w+)",\s*"(\w+)"/g)].map((m) => `${m[1]}.${m[2]}`)
);
// the columns a later patch drops again (a column 7 no longer uses, schedule.run_at once
// one_time_run holds the moment) : a fresh install never has them
const droppedColumns = new Set([
  ...[...model.matchAll(/dropColumn\("(\w+)",\s*"(\w+)"\)/g)].map((m) => `${m[1]}.${m[2]}`),
  ...[...model.matchAll(/ALTER TABLE AnsibleForms\.`(\w+)` DROP COLUMN `(\w+)`/g)].map((m) => `${m[1]}.${m[2]}`),
]);
// the managed columns are added by a loop over a table list, not literal calls
const managedLoop = /for \(const table of \[([^\]]+)\]\)[\s\S]{0,200}?addColumn\(table, "managed"/.exec(model);
if (managedLoop) {
  for (const m of managedLoop[1].matchAll(/"(\w+)"/g)) patchColumns.add(`${m[1]}.managed`);
}
const patchTables = new Set([...model.matchAll(/addTable\("(\w+)"/g)].map((m) => m[1]));
const patchIndexes = new Set(
  [...model.matchAll(/addIndex\("(\w+)",\s*"(\w+)"/g)].map((m) => `${m[1]}.${m[2]}`)
);

describe("the schema manifest describes what the code actually builds", () => {
  const M = manifest();

  test("the manifest was parsed at all", () => {
    // a silent parse failure would make every assertion below vacuously true - the same
    // trap as reading SCHEMA_MANIFEST off the default export, which yielded undefined and
    // reported 'complete' for ever
    assert.ok(M.tables.size > 5, `only found ${M.tables.size} manifest tables`);
    assert.ok(M.columns.size > 10, `only found ${M.columns.size} manifest columns`);
    assert.ok(sqlTables.size > 10, `only found ${sqlTables.size} tables in the SQL`);
  });

  // Direction 1: a fresh install must satisfy the manifest, or the Status page reports a
  // problem on a database that was just created correctly.
  test("every table the fresh SQL creates is in the manifest", () => {
    const missing = [...sqlTables].filter(
      (t) => !M.tables.has(t) && !patchTables.has(t)
    ).sort();
    assert.deepEqual(missing, [], "tables in create_schema_and_tables.sql but not in SCHEMA_MANIFEST");
  });

  test("every column the fresh SQL creates is in the manifest or is a base column", () => {
    // The manifest lists base TABLES and patch COLUMNS - it deliberately does not enumerate
    // every base column. So the check that matters is the reverse one below. What IS checked
    // here: a column the SQL creates AND a patch adds must appear in the manifest, because
    // that is exactly the "added to both paths, forgotten in the manifest" case.
    const inBoth = [...sqlColumns].filter((c) => patchColumns.has(c));
    const missing = inBoth.filter((c) => !M.columns.has(c)).sort();
    assert.deepEqual(missing, [], "columns added by a patch AND the fresh SQL but absent from SCHEMA_MANIFEST");
  });

  test("every index a patch adds is in the manifest and in the fresh SQL", () => {
    const notInManifest = [...patchIndexes].filter((i) => !M.indexes.has(i)).sort();
    assert.deepEqual(notInManifest, [], "indexes added by a patch but absent from SCHEMA_MANIFEST");
    const notInSql = [...patchIndexes].filter((i) => !sqlIndexes.has(i)).sort();
    assert.deepEqual(notInSql, [], "indexes added by a patch but never created by the fresh SQL");
  });

  // Direction 2: the manifest must not demand something nothing builds, or the Status page
  // reports a permanent error nobody can clear. This is the failure that already shipped
  // once - the manifest listed azuread/oidc, which the fresh install does not create.
  test("every manifest column is created by the fresh SQL or by a patch", () => {
    // a column on a table the fresh install does not build is judged by its patch only
    const orphans = [...M.columns]
      .filter((c) => !sqlColumns.has(c) && !patchColumns.has(c))
      .sort();
    assert.deepEqual(orphans, [], "SCHEMA_MANIFEST demands columns that nothing creates");
  });

  test("every manifest table is created by the fresh SQL or by a patch", () => {
    const orphans = [...M.tables].filter((t) => !sqlTables.has(t) && !patchTables.has(t)).sort();
    assert.deepEqual(orphans, [], "SCHEMA_MANIFEST demands tables that nothing creates");
  });

  // The base tables are what a fresh install must build by itself : the patches run after
  // the create script, but a table only a patch makes was missing from a fresh install until
  // the first patch run (job_events, runner_leases and runner_join_tokens were, in 7.3).
  test("every base table of the manifest is created by the fresh SQL", () => {
    const block = /base:\s*\{\s*tables:\s*\[([\s\S]*?)\]/.exec(model)[1];
    const base = [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.ok(base.length > 10, `only found ${base.length} base tables`);
    const missing = base.filter((t) => !sqlTables.has(t)).sort();
    assert.deepEqual(missing, [], "base tables of SCHEMA_MANIFEST that create_schema_and_tables.sql does not create");
  });

  // The script runs only on an empty database, but a table it creates without dropping it
  // first fails the whole script when it is there (a half-created schema, run again).
  test("every table the fresh SQL creates is dropped first", () => {
    const dropped = new Set([...sql.matchAll(/DROP TABLE IF EXISTS\s+`?(\w+)`?/gi)].map((m) => m[1]));
    const missing = [...sqlTables].filter((t) => !dropped.has(t)).sort();
    assert.deepEqual(missing, [], "tables created without a DROP TABLE IF EXISTS before them");
  });

  // The rule written down in CLAUDE.md: a patch and the fresh install must stay in step.
  test("every column a patch adds is also in the fresh SQL", () => {
    const missing = [...patchColumns].filter((c) => {
      const table = c.split(".")[0];
      // only for tables the fresh install actually builds - patchVersion5 still adds columns
      // to legacy azuread/oidc tables that a fresh install deliberately never creates
      return sqlTables.has(table) && !sqlColumns.has(c) && !droppedColumns.has(c);
    }).sort();
    assert.deepEqual(missing, [], "a patch adds these but a fresh install would not have them");
  });
});

// ─── optional columns must be insertable without them ─────────
//
// `description` is optional metadata - crud.config.js does not mark it required and the
// other description columns in this schema are already DEFAULT NULL - but credentials and
// repositories declared it `text NOT NULL` with no default, so MySQL refused any insert
// that omitted it. An API client creating either without a description got a raw
// "Field 'description' doesn't have a default value" error instead of the record. The UI
// always sends the field, which is why it went unnoticed; it cost two debugging rounds.
//
// A TEXT column cannot carry a literal DEFAULT, so the fix is nullable, not DEFAULT ''.
describe("a column the API does not require must be insertable without it", () => {
  const sql = readFileSync(path.join(here, "../src/db/create_schema_and_tables.sql"), "utf8");
  const model = readFileSync(path.join(here, "../src/models/schema.model.js"), "utf8");

  test("the fresh-install schema has no NOT NULL description column", () => {
    // every `description` column, whatever its type
    const cols = [...sql.matchAll(/`description`\s+[A-Za-z0-9()]+[^,\n]*/gi)].map((m) => m[0]);
    assert.ok(cols.length >= 5, `expected several description columns, found ${cols.length}`);
    const bad = cols.filter((c) => /NOT NULL/i.test(c) && !/DEFAULT/i.test(c));
    assert.deepEqual(bad, [], "a NOT NULL description with no default makes the API refuse a valid create");
  });

  test("existing installs are migrated too, not just fresh ones", () => {
    // both paths must stay in sync - a fresh install gets the SQL, an upgrade gets the patch
    for (const table of ["credentials", "repositories"]) {
      assert.match(
        model,
        new RegExp(`makeColumnNullable\\("${table}", "description", "text"\\)`),
        `${table}.description is fixed for a fresh install but not for an upgrade`
      );
    }
  });
});

// ─── NOT NULL columns the API does not require ────────────────
//
// This is the check that would have caught the `description` bug - twice. A column that is
// NOT NULL with no DEFAULT must be supplied on every insert, so if nothing guarantees a
// value the API answers a raw "Field 'x' doesn't have a default value" instead of creating
// the record. crud.config.js's `required` flag is one such guarantee; a model that fills
// the field in is another.
//
// Parsed from the schema FILE, not information_schema, so it needs no database.
describe("every NOT NULL column is guaranteed a value", () => {
  const sql = readFileSync(path.join(here, "../src/db/create_schema_and_tables.sql"), "utf8");
  const cfg = readFileSync(path.join(here, "../config/crud.config.js"), "utf8");

  // Columns the model fills in on create, so the database constraint is satisfied even
  // though crud.config does not mark them required. DERIVED from `setDefault: true`
  // rather than hand-listed: CrudModel.getFieldValues writes '' for such a field when the
  // payload omits it (crud.model.js, the `if(field.setDefault && !isUpdate)` branch), so
  // the guarantee is the flag itself. Confirmed behaviourally too - creating an A.A.P.
  // connection with only a token, and a user with no email, both succeed and store ''.
  //
  // Deriving it matters: a hand-written allow-list would let a genuinely unguaranteed
  // column be waved through by whoever added it, which is the mistake this whole test
  // exists to catch.
  function filledByModel() {
    const filled = new Set();
    for (const e of cfg.matchAll(/table:\s*['"`]AnsibleForms\.`?(\w+)`?['"`][\s\S]*?fields:\s*\[([\s\S]*?)\n\s*\]/g)) {
      const [, table, body] = e;
      for (const f of body.matchAll(/\{\s*name:\s*['"`](\w+)['"`]([^}]*)\}/g)) {
        if (/setDefault:\s*true/.test(f[2])) filled.add(`${table}.${f[1]}`);
      }
    }
    return filled;
  }

  function notNullColumns() {
    const out = [];
    for (const t of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+`?(?:AnsibleForms`?\.`?)?(\w+)`?\s*\(([\s\S]*?)\n\)/g)) {
      const [, table, body] = t;
      for (const line of body.split("\n")) {
        const m = /^\s*`(\w+)`\s+([^,]*)/.exec(line);
        if (!m) continue;
        const [, col, def] = m;
        if (/AUTO_INCREMENT/i.test(def)) continue;
        if (/NOT NULL/i.test(def) && !/DEFAULT/i.test(def)) out.push(`${table}.${col}`);
      }
    }
    return out;
  }

  // tables CrudModel manages : the rest (tokens, job_output, staging, ...) are written by
  // their own models with explicit values and never from a client payload, so the
  // required-flag contract does not apply to them
  function managedTables() {
    const t = new Set();
    for (const e of cfg.matchAll(/table:\s*['"`]AnsibleForms\.`?(\w+)`?['"`]/g)) t.add(e[1]);
    return t;
  }

  function requiredInConfig() {
    const req = new Set();
    // bounded by the entry's own `fields: [ ... ]` array : an end-bound of "the next line
    // with four spaces and a brace" stopped short and missed most of the declarations,
    // so genuinely-required columns looked unguaranteed
    for (const e of cfg.matchAll(/table:\s*['"`]AnsibleForms\.`?(\w+)`?['"`][\s\S]*?fields:\s*\[([\s\S]*?)\n\s*\]/g)) {
      const [, table, body] = e;
      for (const f of body.matchAll(/\{\s*name:\s*['"`](\w+)['"`]([^}]*)\}/g)) {
        if (/required:\s*true/.test(f[2]) || /isKey:\s*true/.test(f[2])) req.add(`${table}.${f[1]}`);
      }
    }
    return req;
  }

  test("the schema really was parsed, so these assertions are not vacuous", () => {
    const cols = notNullColumns();
    assert.ok(cols.length > 10, `only found ${cols.length} NOT NULL columns`);
    assert.ok(cols.includes("users.username"), "expected users.username among them");
  });

  test("none is left for the caller to guess at", () => {
    const required = requiredInConfig();
    const managed = managedTables();
    const filled = filledByModel();
    const gaps = notNullColumns().filter(
      (c) => managed.has(c.split('.')[0]) && !required.has(c) && !filled.has(c)
    );
    assert.deepEqual(gaps, [],
      "these columns must be supplied on every insert but nothing guarantees a value - " +
      "the API will answer a raw \"doesn't have a default value\" error. Give the column a " +
      "DEFAULT (or make it nullable), mark it required in crud.config.js, or add it to " +
      "FILLED_BY_MODEL with the reason.");
  });
});
