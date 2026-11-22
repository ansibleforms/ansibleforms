// A schedule of the app taken by a schedules repository : its row stored as a pull reads the entry
// written for it, so the first pull after turning the usage on finds it unchanged (it said
// "1 updated" : the extra vars kept as the app's JSON text while the pull reads them as YAML).
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the statements run, with their values
const statements = [];
vi.mock("../src/models/db.model.js", () => ({ default: { do: async (sql, vars) => statements.push({ sql, vars }) } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const { default: schedules } = await import("../src/lib/repoObjects/schedules.js");
const { parseSchedule } = await import("../src/lib/scheduleFiles.js");

describe("an app schedule linked to the entry written for it", () => {
  test("its row is what a pull reads from that entry : the next pull finds it unchanged", async () => {
    const row = { id: 7, name: "Nightly cleanup", description: "weekday nights", form: "Nightly", cron: "30 2 * * 1-5", rrule: null, enabled: 1, extra_vars: '{"retention_days": 14}', launch_options: null };
    const c = schedules.candidateOf(row);
    assert.deepEqual(c.timing, { rrule: null, cron: "30 2 * * 1-5", oneTimeRun: null }, "its cron, as it is");
    statements.length = 0;
    await schedules.linkCandidate(c, "ops", "schedules/nightly-cleanup.yaml");
    const { sql, vars } = statements[0];
    // the row as stored, by the columns the statement sets
    const columns = sql.match(/SET (.*) WHERE/)[1].split(",").map((part) => part.trim().split("=")[0]);
    const stored = { ...row };
    let i = 0;
    for (const col of columns) if (!/NULL$/.test(sql.split(`${col}=`)[1].split(",")[0])) stored[col] = vars[i++];
    assert.equal(stored.repository, "ops");
    assert.equal(stored.repo_file, "schedules/nightly-cleanup.yaml");
    assert.equal(stored.extra_vars, "retention_days: 14\n");
    const fromFile = parseSchedule(structuredClone(schedules.entryOf(c))).schedule;
    assert.equal(schedules.store.changed(stored, fromFile), false);
  });

  test.each([
    ["a rrule", { rrule: "DTSTART;TZID=UTC:20300101T080000 RRULE:FREQ=WEEKLY;INTERVAL=1" }, { rrule: "DTSTART;TZID=UTC:20300101T080000 RRULE:FREQ=WEEKLY;INTERVAL=1", cron: null, one_time_run: null }],
    ["a one time run", { one_time_run: new Date("2030-02-03T04:05:00Z") }, { rrule: null, cron: null, one_time_run: "2030-02-03 04:05:00" }],
  ])("%s handed over as it is, its row unchanged by the next pull", async (_label, timing, columns) => {
    const row = { id: 8, name: "Other", description: "", form: "Nightly", cron: null, rrule: null, one_time_run: null, enabled: 1, extra_vars: "", launch_options: null, ...timing };
    const c = schedules.candidateOf(row);
    statements.length = 0;
    await schedules.linkCandidate(c, "ops", "schedules.yaml");
    const { sql, vars } = statements[0];
    const set = sql.match(/SET (.*) WHERE/)[1].split(",").map((part) => part.trim().split("=")[0]);
    const stored = { ...row, ...Object.fromEntries(set.map((col, i) => [col, vars[i]])) };
    assert.deepEqual({ rrule: stored.rrule, cron: stored.cron, one_time_run: stored.one_time_run }, columns);
    const fromFile = parseSchedule(structuredClone(schedules.entryOf(c))).schedule;
    assert.equal(schedules.store.changed(stored, fromFile), false);
    // the row as the table reads it back : its moment a Date
    if (row.one_time_run) assert.equal(schedules.store.changed({ ...stored, one_time_run: row.one_time_run }, fromFile), false);
  });
});
