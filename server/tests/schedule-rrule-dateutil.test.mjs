// The runs of a rrule (lib/scheduleRrule.js walkRuns) are the runs python-dateutil, the reference
// implementation of the iCal rrule, gives : a few hundred random rules of every frequency, their
// BYxxx parts mixed, with COUNT, UNTIL and EXRULE, in zones with DST and asked their runs before
// a DST change, and the fixed cases a review found (a COUNT rule from decades ago ...), compared
// with dateutil's runs kept in tests/fixtures/rrule-dateutil.json (made by
// tests/fixtures/rrule-dateutil.py, which says how to make it again).
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import { walkRuns } from "../src/lib/scheduleRrule.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/rrule-dateutil.json", import.meta.url), "utf8"));

describe(`the runs of ${fixture.cases.length} rules are dateutil ${fixture.dateutil}'s`, () => {
  test("the fixture holds both halves", () => {
    assert.ok(fixture.cases.length >= 300);
    assert.ok(fixture.cases.some((c) => c.runs.length === 0) && fixture.cases.some((c) => c.runs.length > 1));
  });

  for (const c of fixture.cases) {
    test(`${c.rrule} after ${new Date(c.after).toISOString()}`, () => {
      const runs = walkRuns(c.rrule, { after: new Date(c.after), count: c.count }).map((d) => d.toISOString());
      assert.deepEqual(runs, c.runs.map((ms) => new Date(ms).toISOString()));
    });
  }
});
