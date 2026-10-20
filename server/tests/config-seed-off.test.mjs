// Turning the config seed off (CONFIG_SEED_PATH unset) releases what it managed.
//
// Only an APPLIED seed used to release a row it no longer declared. Removing the variable
// applied nothing, so every row the seed had made stayed `managed` - read-only in the
// interface, 403 from the API - for ever, with no seed left to change it either. An instance
// upgraded from 7.2 could not change its own runner any more.
//
// Four properties, each of which fails silently :
//
//  1. Unset, every managed row of every seedable table is released, its values kept.
//  2. Set but missing, NOTHING is released : the start is refused as before, because a
//     mounted file may only be late, and unlocking everything on a slow mount is wrong.
//  3. Releasing is once : a start with nothing left to release writes nothing at all.
//  4. Every table with a `managed` column is covered, so a new seedable table cannot stay
//     locked after the seed is turned off.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ---------------------------------------------------------------------------------
// A tiny in-memory database : per table, rows of { name, managed, value }. It answers the
// two statements the release uses and records the audit INSERT ; everything else is empty.
// ---------------------------------------------------------------------------------
let tables = {};
const queries = [];
const audits = [];

/**
 * The table a statement names, with or without the schema prefix and the backticks.
 *
 * Args:
 *   sql (string): the statement.
 *
 * Returns:
 *   (string|null) the bare table name, or null when the statement names none.
 */
function tableOf(sql) {
  const m = /(?:FROM|UPDATE|INTO)\s+(?:AnsibleForms\.)?`?(\w+)`?/i.exec(sql);
  return m ? m[1] : null;
}

vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      queries.push({ sql, vars });
      const table = tableOf(sql);
      if (/^INSERT INTO AnsibleForms\.`audit`/.test(sql)) {
        audits.push(vars);
        return { insertId: audits.length };
      }
      // the branding fields the seed manages (lib/brandingManaged.js), kept in the settings row
      if (/^SELECT branding_managed FROM/.test(sql)) return (tables.settings || []).slice(0, 1);
      if (/^UPDATE AnsibleForms\.`settings` SET branding_managed = \?/.test(sql)) {
        for (const r of tables.settings || []) r.branding_managed = vars[0];
        return { affectedRows: 1 };
      }
      if (/^SELECT name FROM .* WHERE managed=1$/.test(sql)) {
        return (tables[table] || []).filter((r) => r.managed === 1).map((r) => ({ name: r.name }));
      }
      if (/^UPDATE .* SET managed=0 WHERE managed=1$/.test(sql)) {
        let affectedRows = 0;
        for (const r of tables[table] || []) {
          if (r.managed === 1) { r.managed = 0; affectedRows++; }
        }
        return { affectedRows };
      }
      return [];
    },
  },
}));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { applyConfigSeed, listSections, singleRowSections } = await import("../src/lib/seed.js");
const CrudModel = (await import("../src/models/crud.model.js")).default;

/** The bare table name of a list section, from its crud config. */
const listTable = (section) => CrudModel.getConfig(section.modelName).table.replace(/^AnsibleForms\./, "").replace(/`/g, "");

/** The statements that changed a `managed` flag. */
const releases = () => queries.filter((q) => /SET managed=0/.test(q.sql));

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-seed-off-"));
  queries.length = 0;
  audits.length = 0;
  // what a 7.2 instance that once ran a seed looks like : the seed's rows next to hand-made ones
  tables = {
    runners: [
      { name: "rte", managed: 1, value: "https://rte:8443" },
      { name: "by-hand", managed: 0, value: "https://other" },
    ],
    credentials: [{ name: "rte", managed: 1, value: "token" }],
    labels: [{ name: "prod", managed: 1, value: "red" }],
    ldap: [{ name: "ldap", managed: 1, value: "ldap.example.com" }],
    settings: [{ name: "settings", managed: 0, value: "https://x" }],
    chat_settings: [{ name: "chat", managed: 1, value: "https://llm" }],
  };
});

afterEach(() => {
  appConfig.configSeedPath = "";
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CONFIG_SEED_PATH unset releases what the seed managed", () => {
  test("the branding fields its branding section declared are released too", async () => {
    appConfig.configSeedPath = "";
    tables.settings[0].branding_managed = JSON.stringify(["app_name", "logo"]);
    await applyConfigSeed();
    assert.equal(tables.settings[0].branding_managed, null);
    const detail = JSON.parse(audits[0][7]);
    assert.ok(detail.released.includes("branding:app_name") && detail.released.includes("branding:logo"), JSON.stringify(detail));
  });

  test("every managed row becomes editable, with its values kept", async () => {
    appConfig.configSeedPath = "";
    assert.equal(await applyConfigSeed(), null, "an off seed still reports nothing applied");

    for (const [table, rows] of Object.entries(tables)) {
      for (const row of rows) assert.equal(row.managed, 0, `${table} '${row.name}' is released`);
    }
    assert.equal(tables.runners[0].value, "https://rte:8443", "the row and its values stay");
    assert.equal(tables.runners.length, 2, "nothing is deleted");
  });

  test("an audit entry names what was released, and nothing else", async () => {
    appConfig.configSeedPath = "";
    await applyConfigSeed();

    assert.equal(audits.length, 1);
    // actor, actor_type, ip, action, target_type, target, outcome, detail
    const [, , , action, targetType, , outcome, detail] = audits[0];
    assert.equal(action, "seed.release");
    assert.equal(targetType, "seed");
    assert.equal(outcome, "success");
    assert.deepEqual(JSON.parse(detail).released.sort(), [
      "chat", "credential:rte", "label:prod", "ldap", "runner:rte",
    ]);
  });

  // the second start of an instance whose seed was turned off : nothing left to release
  test("is once : a later start writes no flag and no audit entry", async () => {
    appConfig.configSeedPath = "";
    await applyConfigSeed();
    queries.length = 0;
    audits.length = 0;

    await applyConfigSeed();
    assert.equal(audits.length, 0, "no audit entry for a start that released nothing");
    // the single-row sections are released by a bare UPDATE, which matches nothing now
    for (const q of releases()) {
      assert.ok(singleRowSections.some((s) => q.sql.includes(`\`${s.table}\``)), `unexpected write: ${q.sql}`);
    }
    for (const rows of Object.values(tables)) for (const row of rows) assert.equal(row.managed, 0);
  });
});

describe("CONFIG_SEED_PATH set leaves the managed rows alone", () => {
  // a ConfigMap or secret volume that is not mounted yet : refusing to start is safe, the
  // next try finds it. Releasing would unlock every managed object because a mount was slow.
  test("a missing file still refuses to start, and releases nothing", async () => {
    appConfig.configSeedPath = path.join(dir, "not-there.yaml");
    await assert.rejects(applyConfigSeed(), /does not exist/);
    assert.equal(releases().length, 0);
    assert.equal(audits.length, 0);
    assert.equal(tables.runners[0].managed, 1);
    assert.equal(tables.ldap[0].managed, 1);
  });

  test("a directory instead of the file refuses too, and releases nothing", async () => {
    appConfig.configSeedPath = dir;
    await assert.rejects(applyConfigSeed(), /is a directory/);
    assert.equal(releases().length, 0);
    assert.equal(tables.credentials[0].managed, 1);
  });
});

describe("the release covers every seedable table", () => {
  // Read from the schema itself rather than restated : a table that gains a `managed` column
  // and is not added to the seed's sections fails here instead of staying locked in the field.
  test("every table with a managed column is released", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = fs.readFileSync(path.join(here, "../src/db/create_schema_and_tables.sql"), "utf8");
    const withManaged = [];
    for (const m of sql.matchAll(/CREATE TABLE `(\w+)` \(([\s\S]*?)\)\s*ENGINE/g)) {
      if (/`managed`/.test(m[2])) withManaged.push(m[1]);
    }
    assert.ok(withManaged.length > 5, "the schema was parsed");

    const covered = new Set([...listSections.map(listTable), ...singleRowSections.map((s) => s.table)]);
    for (const table of withManaged) assert.ok(covered.has(table), `${table} has a managed column but is never released`);
  });
});
