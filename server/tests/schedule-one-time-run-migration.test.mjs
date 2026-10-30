// 7.5.0 : a schedule's one-time run is one column holding its moment (one_time_run), instead of
// the 6.2.0 flag with run_at beside it (models/schema.model.js oneTimeRunMoment). Each row keeps
// exactly one timing : a one-time row its moment (its stale cron and rrule cleared), a recurring
// one its cron or rrule (its stale run_at dropped), a job a user planned its moment and owner ; a
// row flagged one-time without a time is kept as it is, logged. A start that stopped halfway
// finishes it, a second run changes nothing.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
const warnings = [];
// the logger the test config puts in place of ../lib/logger.js (vitest.config.js)
vi.mock("./__mocks__/logger.js", () => ({
  default: { warning: (m) => warnings.push(String(m)), error: () => {}, notice: () => {}, info: () => {}, debug: () => {}, crit: () => {} },
  sendAuditLine: () => {},
  applySyslogServers: () => ({ log: 0, audit: 0, failed: [] }),
  sendTestLine: async () => {},
}));

const { oneTimeRunMoment, oneTimeRunIsMoment } = await import("../src/models/schema.model.js");

// ─── the schedule table, for the statements the migration runs ──────────────────
let columns;
let rows;
const statements = [];
const query = async (sql) => {
  statements.push(sql);
  if (/^SHOW COLUMNS FROM AnsibleForms\.`schedule`/.test(sql)) return [...columns].map(([Field, Type]) => ({ Field, Type }));
  let m;
  if ((m = sql.match(/^ALTER TABLE AnsibleForms\.`schedule` ADD COLUMN `(\w+)` (\w+)/))) {
    columns.set(m[1], m[2]);
    rows.forEach((r) => (r[m[1]] = null));
    return { affectedRows: 0 };
  }
  if ((m = sql.match(/^ALTER TABLE AnsibleForms\.`schedule` DROP COLUMN `(\w+)`/))) {
    columns.delete(m[1]);
    rows.forEach((r) => delete r[m[1]]);
    return { affectedRows: 0 };
  }
  if ((m = sql.match(/^ALTER TABLE AnsibleForms\.`schedule` CHANGE COLUMN `(\w+)` `(\w+)` (\w+)/))) {
    columns.delete(m[1]);
    columns.set(m[2], m[3]);
    rows.forEach((r) => {
      r[m[2]] = r[m[1]];
      delete r[m[1]];
    });
    return { affectedRows: 0 };
  }
  const once = (r) => Number(r.one_time_run ?? 0) === 1;
  if (/SET one_time_moment = run_at, cron = NULL, rrule = NULL WHERE COALESCE\(one_time_run,0\) = 1 AND run_at IS NOT NULL/.test(sql)) {
    const hit = rows.filter((r) => once(r) && r.run_at !== null);
    hit.forEach((r) => Object.assign(r, { one_time_moment: r.run_at, cron: null, rrule: null }));
    return { affectedRows: hit.length };
  }
  if (/SET one_time_moment = NULL WHERE COALESCE\(one_time_run,0\) <> 1/.test(sql)) {
    const hit = rows.filter((r) => !once(r));
    hit.forEach((r) => (r.one_time_moment = null));
    return { affectedRows: hit.length };
  }
  if (/^SELECT id, name FROM AnsibleForms\.`schedule` WHERE COALESCE\(one_time_run,0\) = 1 AND run_at IS NULL/.test(sql)) {
    return rows.filter((r) => once(r) && r.run_at === null).map((r) => ({ id: r.id, name: r.name }));
  }
  throw new Error(`unexpected statement: ${sql}`);
};

// a 7.4 table : the flag and run_at, rows of every kind (some with stale fields)
const OLD_COLUMNS = () => new Map([["id", "int(11)"], ["name", "varchar(255)"], ["one_time_run", "tinyint(4)"], ["cron", "varchar(50)"], ["run_at", "datetime"], ["rrule", "text"], ["owner", "longtext"]]);
const OLD_ROWS = () => [
  { id: 1, name: "cron", one_time_run: 0, cron: "0 2 * * *", run_at: "2026-01-01 00:00:00", rrule: null, owner: null },
  { id: 2, name: "rrule", one_time_run: 0, cron: null, run_at: null, rrule: "DTSTART:20300101T000000Z RRULE:FREQ=DAILY;INTERVAL=1", owner: null },
  { id: 3, name: "once", one_time_run: 1, cron: "0 3 * * *", run_at: "2030-02-03 04:05:00", rrule: null, owner: null },
  { id: 4, name: "planned", one_time_run: 1, cron: null, run_at: "2030-05-06 07:08:00", rrule: null, owner: '{"username":"bob"}' },
  { id: 5, name: "odd", one_time_run: 1, cron: "0 4 * * *", run_at: null, rrule: null, owner: null },
];

beforeEach(() => {
  columns = OLD_COLUMNS();
  rows = OLD_ROWS();
  statements.length = 0;
  warnings.length = 0;
});

const byName = (name) => rows.find((r) => r.name === name);

describe("one_time_run holds the moment of the one run", () => {
  test("rows of each kind keep exactly one timing ; the flag and run_at are gone", async () => {
    assert.equal(await oneTimeRunIsMoment(query), false);
    await oneTimeRunMoment(query);
    assert.deepEqual([...columns.keys()], ["id", "name", "cron", "rrule", "owner", "one_time_run"]);
    assert.equal(columns.get("one_time_run"), "datetime");
    assert.equal(await oneTimeRunIsMoment(query), true);
    // a cron : its stale run_at dropped
    assert.deepEqual(byName("cron"), { id: 1, name: "cron", cron: "0 2 * * *", rrule: null, owner: null, one_time_run: null });
    // a rrule
    assert.deepEqual([byName("rrule").cron, byName("rrule").one_time_run], [null, null]);
    assert.ok(byName("rrule").rrule);
    // a one-time run : its moment, its stale cron cleared
    assert.deepEqual([byName("once").cron, byName("once").rrule, byName("once").one_time_run], [null, null, "2030-02-03 04:05:00"]);
    // a job a user planned : its moment and owner, unchanged otherwise
    assert.deepEqual([byName("planned").one_time_run, byName("planned").owner], ["2030-05-06 07:08:00", '{"username":"bob"}']);
    // flagged once without a time : kept as it is (its cron), logged
    assert.deepEqual([byName("odd").cron, byName("odd").one_time_run], ["0 4 * * *", null]);
    assert.ok(warnings.some((w) => w.includes("Schedule 'odd' (5) was a one-time run without its time")));
  });

  test("a second run changes nothing", async () => {
    await oneTimeRunMoment(query);
    const after = JSON.stringify(rows);
    statements.length = 0;
    const message = await oneTimeRunMoment(query);
    assert.equal(JSON.stringify(rows), after);
    assert.ok(statements.every((s) => s.startsWith("SHOW COLUMNS")), "nothing but a look at the columns");
    assert.match(message, /hold their moment already/);
  });

  test("a start that stopped halfway (the flag dropped, run_at still there) finishes it, the moments kept", async () => {
    await query("ALTER TABLE AnsibleForms.`schedule` ADD COLUMN `one_time_moment` datetime NULL DEFAULT NULL");
    rows.forEach((r) => (r.one_time_moment = Number(r.one_time_run) === 1 && r.run_at ? r.run_at : null));
    await query("ALTER TABLE AnsibleForms.`schedule` DROP COLUMN `one_time_run`");
    await oneTimeRunMoment(query);
    assert.deepEqual([...columns.keys()], ["id", "name", "cron", "rrule", "owner", "one_time_run"]);
    assert.equal(byName("once").one_time_run, "2030-02-03 04:05:00");
    assert.equal(byName("cron").one_time_run, null);
  });

  test("a fresh install (one_time_run a datetime already) : nothing to do", async () => {
    columns = new Map([["id", "int(11)"], ["name", "varchar(255)"], ["one_time_run", "datetime"], ["cron", "varchar(50)"], ["rrule", "text"]]);
    rows = [{ id: 1, name: "x", one_time_run: "2030-01-01 00:00:00", cron: null, rrule: null }];
    await oneTimeRunMoment(query);
    assert.deepEqual(rows, [{ id: 1, name: "x", one_time_run: "2030-01-01 00:00:00", cron: null, rrule: null }]);
    assert.equal(await oneTimeRunIsMoment(query), true);
  });
});
