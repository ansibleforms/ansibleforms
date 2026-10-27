// A stop waits for the cron runs already going (cron.service.js stopAll) : lib/shutdown.js closes
// the database pool right after the scheduler, and the minute's stopped-node sweep, caught by a
// SIGTERM on the minute, logged "Pool is closed" three times - a red CI run on mariadb.
import { test, describe, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { Cron } from "croner";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [], tryDo: async () => [] } }));

const { default: cronService } = await import("../src/services/cron.service.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// a system task that runs for `ms` once triggered, as the sweep's queries do
function slowTask(ms) {
  const run = { done: false };
  const task = new Cron("0 0 1 1 *", { protect: true }, async () => {
    await sleep(ms);
    run.done = true;
  });
  task.trigger();
  return { task, run };
}

afterEach(() => cronService.jobs.system.clear());

describe("stopAll", () => {
  test("waits for a run already going before it resolves", async () => {
    const { task, run } = slowTask(200);
    cronService.jobs.system.set("sweep", task);
    await sleep(10);
    assert.equal(task.isBusy(), true);
    await cronService.stopAll();
    assert.equal(run.done, true, "resolved while the run was still going");
    assert.equal(task.isStopped(), true);
  });

  test("gives up after its wait, so a hanging run does not hold the stop", async () => {
    const { task, run } = slowTask(2000);
    cronService.jobs.system.set("hang", task);
    await sleep(10);
    const started = Date.now();
    await cronService.stopAll(100);
    assert.ok(Date.now() - started < 1000, "waited past its limit");
    assert.equal(run.done, false);
  });

  test("resolves at once when nothing runs", async () => {
    cronService.jobs.system.set("idle", new Cron("0 0 1 1 *", () => {}));
    const started = Date.now();
    await cronService.stopAll();
    assert.ok(Date.now() - started < 100);
  });
});
