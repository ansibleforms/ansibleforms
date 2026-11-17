// How a schedule of a schedules repository ends : its entry's keys ends, end_at, end_count,
// end_action (a cron or a rrule) and remove_after_run (a one_time_run), checked when it is read,
// written with as few keys as say it, and kept off by a pull once its end is reached - the file
// manages the row, an end only ever turns it off (lib/scheduleEnd.js).
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { parseSchedule, newScheduleEntry, updateScheduleText, scheduleEntryOf, KEY_ORDER } = await import("../src/lib/scheduleFiles.js");
const { valuesOf, default: schedules } = await import("../src/lib/repoObjects/schedules.js");

const base = { name: "Nightly", form: "F", cron: "0 2 * * *" };

describe("an entry's end", () => {
  test("read and checked : a date for ends date, a whole number for ends count", () => {
    const s = parseSchedule({ ...base, ends: "date", end_at: "2030-01-01T10:00:00+02:00", end_action: "remove" }).schedule;
    assert.deepEqual([s.ends, s.endAt, s.endCount, s.endAction], ["date", "2030-01-01T08:00:00Z", null, "remove"]);
    assert.match(parseSchedule({ ...base, ends: "date" }).errors.join(), /end_at is required/);
    assert.match(parseSchedule({ ...base, ends: "count", end_count: 0 }).errors.join(), /end_count must be a whole number/);
    assert.match(parseSchedule({ ...base, ends: "soon" }).errors.join(), /ends must be one of/);
    assert.match(parseSchedule({ ...base, ends: "count", end_count: 2, end_action: "boom" }).errors.join(), /end_action must be one of/);
    assert.equal(parseSchedule(base).schedule.ends, "never");
  });

  test("a one_time_run reads remove_after_run only, true when not said", () => {
    const once = { name: "Once", form: "F", one_time_run: "2030-01-01T00:00:00Z" };
    assert.equal(parseSchedule(once).schedule.removeAfterRun, true);
    assert.equal(parseSchedule({ ...once, remove_after_run: false }).schedule.removeAfterRun, false);
    // its end keys ignored : a one-time run has none
    assert.equal(parseSchedule({ ...once, ends: "count", end_count: 2 }).schedule.ends, "never");
  });

  test("a new entry writes as few keys as say it, in their place", () => {
    assert.equal("ends" in newScheduleEntry({ ...base }), false);
    const e = newScheduleEntry({ ...base, ends: "count", endCount: 3, endAction: "disable" });
    assert.deepEqual([e.ends, e.end_count, e.end_action], ["count", 3, undefined]);
    const keys = Object.keys(e);
    assert.ok(keys.indexOf("ends") > keys.indexOf("cron"));
    assert.deepEqual(KEY_ORDER.slice(KEY_ORDER.indexOf("one_time_run") + 1, -1), ["ends", "end_at", "end_count", "end_action", "remove_after_run"]);
    assert.deepEqual(newScheduleEntry({ name: "O", form: "F", oneTimeRun: "2030-01-01T00:00:00Z", removeAfterRun: false, ends: "count", endCount: 2 }).remove_after_run, false);
  });

  test("an edit writes its end, removes the keys it no longer uses, and a change to once keeps only remove_after_run", () => {
    const text = YAML.stringify({ controller_schedules: [{ ...base, ends: "count", end_count: 3, end_action: "remove" }] });
    let next = updateScheduleText(text, "Nightly", { ends: "date", endAt: "2030-01-01T00:00:00Z" });
    let entry = scheduleEntryOf(next, "Nightly");
    assert.deepEqual([entry.ends, entry.end_at, entry.end_count, entry.end_action], ["date", "2030-01-01T00:00:00Z", undefined, "remove"]);
    next = updateScheduleText(next, "Nightly", { ends: "never" });
    entry = scheduleEntryOf(next, "Nightly");
    assert.deepEqual(["ends", "end_at", "end_count", "end_action"].filter((k) => k in entry), []);
    next = updateScheduleText(text, "Nightly", { oneTimeRun: "2030-01-01T00:00:00Z", removeAfterRun: false });
    entry = scheduleEntryOf(next, "Nightly");
    assert.deepEqual([entry.ends, entry.remove_after_run], [undefined, false]);
  });
});

describe("its row", () => {
  test("stores the end ; kept off once its runs are done or its date passed, whatever enabled says", () => {
    const s = parseSchedule({ ...base, ends: "count", end_count: 2 }).schedule;
    assert.deepEqual(
      (({ ends, end_at, end_count, end_action, remove_after_run, enabled }) => ({ ends, end_at, end_count, end_action, remove_after_run, enabled }))(valuesOf(s, { run_count: 1 })),
      { ends: "count", end_at: null, end_count: 2, end_action: "disable", remove_after_run: 1, enabled: 1 },
    );
    assert.equal(valuesOf(s, { run_count: 2 }).enabled, 0);
    const past = parseSchedule({ ...base, ends: "date", end_at: "2020-01-01T00:00:00Z" }).schedule;
    assert.equal(valuesOf(past).enabled, 0);
  });

  test("a one-time run that ran and says remove_after_run: false is kept, off", () => {
    const s = parseSchedule({ name: "O", form: "F", one_time_run: "2020-01-01T00:00:00Z", remove_after_run: false }).schedule;
    s.pending = false;
    assert.equal(valuesOf(s).enabled, 0);
    assert.equal(valuesOf(s).remove_after_run, 0);
    // imported (kept), where one removed after its run is not
    assert.equal(schedules.notImported(s), null);
    assert.match(schedules.notImported({ ...s, removeAfterRun: true }), /already run/);
  });
});

describe("a key that says its default", () => {
  test("is left as the file writes it when an edit changes nothing of it", () => {
    const text = YAML.stringify({ controller_schedules: [{ name: "O", form: "F", one_time_run: "2030-01-01T00:00:00Z", remove_after_run: true }] });
    const entry = scheduleEntryOf(updateScheduleText(text, "O", { removeAfterRun: true, description: "x" }), "O");
    assert.equal(entry.remove_after_run, true);
    const cron = YAML.stringify({ controller_schedules: [{ ...base, ends: "count", end_count: 2, end_action: "disable" }] });
    assert.equal(scheduleEntryOf(updateScheduleText(cron, "Nightly", { endCount: 3 }), "Nightly").end_action, "disable");
  });
});
