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
    assert.ok(c.rrule, "the cron is written as a rrule");
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
});
