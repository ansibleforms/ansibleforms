// The config seed reload's timing (lib/seedReloadCron.js) : a cron since 7.8.0,
// CONFIG_SEED_RELOAD_CRON. Its seconds of before (CONFIG_SEED_RELOAD_SECONDS) are deprecated,
// removed in 8.0.0, and still read as a cron while the new variable is not set.
//
// What has to hold :
//   - every number of seconds reads as the cron of the table, the nearest one when none runs at
//     the same moments, and 0 still turns the reload off ;
//   - the old variable is read only when it is set and CONFIG_SEED_RELOAD_CRON is not ;
//   - the warning at start says it is deprecated, and what it reads as or that the new one wins.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { Cron } from "croner";
import { secondsToCron, deprecatedSeedReload, seedReloadWarnings, SEED_RELOAD_DEFAULT_CRON } from "../src/lib/seedReloadCron.js";

const cronOf = (seconds) => secondsToCron(seconds).cron;

describe("the seconds as a cron", () => {
  test("60 is every minute, a multiple of 60 up to an hour every so many minutes, 3600 every hour", () => {
    assert.equal(cronOf(60), "* * * * *");
    assert.equal(cronOf(120), "*/2 * * * *");
    assert.equal(cronOf(300), "*/5 * * * *");
    assert.equal(cronOf(900), "*/15 * * * *");
    assert.equal(cronOf(1800), "*/30 * * * *");
    assert.equal(cronOf(3540), "*/59 * * * *");
    assert.equal(cronOf(3600), "0 * * * *");
    for (const s of [60, 120, 300, 900, 1800, 3600]) assert.equal(secondsToCron(s).exact, true, s);
  });

  test("under a minute and dividing 60 : a cron of 6 fields, its first the seconds", () => {
    assert.equal(cronOf(1), "* * * * * *");
    for (const s of [2, 3, 4, 5, 6, 10, 12, 15, 20, 30]) {
      assert.deepEqual(secondsToCron(s), { cron: `*/${s} * * * * *`, off: false, exact: true }, s);
    }
  });

  test("0 or less turns the reload off, as 0 always did", () => {
    assert.deepEqual(secondsToCron(0), { cron: null, off: true, exact: true });
    assert.deepEqual(secondsToCron("-5"), { cron: null, off: true, exact: true });
  });

  test("any other number : the nearest cron, the more frequent on a tie, said not exact", () => {
    // under a minute : the nearest step dividing 60, or a minute
    assert.deepEqual(secondsToCron(7), { cron: "*/6 * * * * *", off: false, exact: false });
    assert.equal(cronOf(8), "*/6 * * * * *");
    assert.equal(cronOf(25), "*/20 * * * * *");
    assert.equal(cronOf(45), "*/30 * * * * *");
    assert.equal(cronOf(50), "* * * * *");
    // up to an hour : whole minutes
    assert.deepEqual(secondsToCron(90), { cron: "* * * * *", off: false, exact: false });
    assert.equal(cronOf(150), "*/2 * * * *");
    assert.equal(cronOf(3590), "0 * * * *");
    // over an hour : hours dividing a day, a day at most
    assert.deepEqual(secondsToCron(7200), { cron: "0 */2 * * *", off: false, exact: true });
    assert.equal(cronOf(21600), "0 */6 * * *");
    assert.deepEqual(secondsToCron(86400), { cron: "0 0 * * *", off: false, exact: true });
    assert.deepEqual(secondsToCron(18000), { cron: "0 */4 * * *", off: false, exact: false });
    assert.equal(cronOf(604800), "0 0 * * *");
  });

  test("not a number : the default, said not exact", () => {
    assert.deepEqual(secondsToCron("abc"), { cron: SEED_RELOAD_DEFAULT_CRON, off: false, exact: false });
    assert.deepEqual(secondsToCron("1.5"), { cron: SEED_RELOAD_DEFAULT_CRON, off: false, exact: false });
  });

  test("every cron it answers is one croner runs", () => {
    for (let s = 1; s <= 7300; s += 7) {
      const { cron } = secondsToCron(s);
      const job = new Cron(cron, { paused: true });
      assert.ok(job.nextRun(), `${s} -> ${cron}`);
      job.stop();
    }
  });
});

describe("the deprecated variable", () => {
  test("read when it is set and CONFIG_SEED_RELOAD_CRON is not", () => {
    assert.deepEqual(deprecatedSeedReload({ CONFIG_SEED_RELOAD_SECONDS: " 300 " }), {
      env: "CONFIG_SEED_RELOAD_SECONDS", value: "300", cron: "*/5 * * * *", off: false, exact: true,
    });
  });

  test("not read when it is not set, nor when CONFIG_SEED_RELOAD_CRON is", () => {
    assert.equal(deprecatedSeedReload({}), null);
    assert.equal(deprecatedSeedReload({ CONFIG_SEED_RELOAD_SECONDS: "" }), null);
    assert.equal(deprecatedSeedReload({ CONFIG_SEED_RELOAD_SECONDS: "300", CONFIG_SEED_RELOAD_CRON: "*/10 * * * *" }), null);
  });

  test("said once at start : deprecated, and what it reads as", () => {
    assert.deepEqual(seedReloadWarnings({}), []);
    assert.deepEqual(seedReloadWarnings({ CONFIG_SEED_RELOAD_SECONDS: "300" }), [
      "CONFIG_SEED_RELOAD_SECONDS is deprecated, use CONFIG_SEED_RELOAD_CRON (removed in 8.0) : CONFIG_SEED_RELOAD_SECONDS=300 is read as CONFIG_SEED_RELOAD_CRON=*/5 * * * *",
    ]);
    assert.deepEqual(seedReloadWarnings({ CONFIG_SEED_RELOAD_SECONDS: "45" }), [
      "CONFIG_SEED_RELOAD_SECONDS is deprecated, use CONFIG_SEED_RELOAD_CRON (removed in 8.0) : CONFIG_SEED_RELOAD_SECONDS=45 has no cron of the same timing, it is read as the nearest one, CONFIG_SEED_RELOAD_CRON=*/30 * * * * *",
    ]);
    assert.deepEqual(seedReloadWarnings({ CONFIG_SEED_RELOAD_SECONDS: "0" }), [
      "CONFIG_SEED_RELOAD_SECONDS is deprecated, use CONFIG_SEED_RELOAD_CRON (removed in 8.0) : CONFIG_SEED_RELOAD_SECONDS=0 turns the config seed reload off",
    ]);
    assert.deepEqual(seedReloadWarnings({ CONFIG_SEED_RELOAD_SECONDS: "300", CONFIG_SEED_RELOAD_CRON: "* * * * *" }), [
      "CONFIG_SEED_RELOAD_SECONDS is deprecated, use CONFIG_SEED_RELOAD_CRON (removed in 8.0) : CONFIG_SEED_RELOAD_CRON is set too and wins, CONFIG_SEED_RELOAD_SECONDS is ignored",
    ]);
  });
});
