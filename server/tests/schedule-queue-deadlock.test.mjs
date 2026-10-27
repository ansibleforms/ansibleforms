// Two schedules queued in the same instant deadlock in Schedule.queue (#1214) : its MAX+1
// subquery takes shared locks on every row of `schedule`, then each UPDATE wants its own row,
// and InnoDB rolls one back with ER_LOCK_DEADLOCK. The cron handler only logged it, so that
// occurrence of the schedule was lost. The statement now runs again (mysql.doRetryingDeadlock),
// and a retry is a warning, not an error line in the log.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the pool's query : fails with the next errors of `failures`, then answers
let failures = [];
let calls = [];
vi.mock("mysql2/promise", () => ({
  default: {
    createPool: () => ({
      on() { return this; },
      end: async () => {},
      query: async (sql, vars) => {
        calls.push({ sql, vars });
        const err = failures.shift();
        if (err) throw err;
        return [{ affectedRows: 1 }];
      },
    }),
  },
}));

const logged = { error: [], warning: [] };
// the logger the test config puts in place of ../lib/logger.js (vitest.config.js)
vi.mock("./__mocks__/logger.js", () => ({
  default: {
    error: (m) => logged.error.push(String(m)),
    warning: (m) => logged.warning.push(String(m)),
    notice: () => {}, info: () => {}, debug: () => {},
  },
}));

const deadlock = () => Object.assign(new Error("Deadlock found when trying to get lock; try restarting transaction"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });

const mysql = (await import("../src/models/db.model.js")).default;
const { default: Schedule } = await import("../src/models/schedule.model.js");

beforeEach(() => {
  failures = [];
  calls = [];
  logged.error = [];
  logged.warning = [];
});

describe("a schedule queued while another is", () => {
  test("is queued after a deadlock, with a warning and no error", async () => {
    failures = [deadlock(), deadlock()];
    await Schedule.queue(7);
    const updates = calls.filter((c) => /UPDATE AnsibleForms.`schedule` SET state='queued'/.test(c.sql));
    assert.equal(updates.length, 3);
    assert.deepEqual(updates[2].vars, [7]);
    assert.equal(logged.warning.filter((m) => /Deadlock/.test(m)).length, 2);
    assert.deepEqual(logged.error, []);
  });

  test("gives up after the last attempt, and that one is an error", async () => {
    failures = Array.from({ length: 5 }, deadlock);
    await assert.rejects(mysql.doRetryingDeadlock("UPDATE x", [], 5), /Deadlock/);
    assert.equal(calls.length, 5);
    assert.equal(logged.error.length, 1);
  });

  test("any other error is not run again", async () => {
    failures = [Object.assign(new Error("Table 'schedule' doesn't exist"), { code: "ER_NO_SUCH_TABLE" })];
    await assert.rejects(mysql.doRetryingDeadlock("UPDATE x", []), /doesn't exist/);
    assert.equal(calls.length, 1);
    assert.deepEqual(logged.warning, []);
    assert.equal(logged.error.length, 1);
  });
});
