// Several processes on one database : which jobs a starting process may end, the designer
// lock in the database, and what AF_ROLE means.
import { test, describe, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const here = path.dirname(fileURLToPath(import.meta.url));
const { default: Job } = await import("../src/models/job.model.js");
const { default: Lock } = await import("../src/models/lock.model.js");
const { default: mysql } = await import("../src/models/db.model.js");
const { currentRole } = await import("../src/lib/role.js");
const appConfig = (await import("./__mocks__/app.config.js")).default;

let calls;
let lockRow;
beforeEach(() => {
  calls = [];
  lockRow = null;
  mysql.do = async (sql, params) => {
    calls.push({ sql, params });
    // the designer_lock row : one row, its data the holder as JSON
    const holderIs = (u, t) => lockRow && (() => { try { const d = JSON.parse(lockRow.data); return d.username === u && d.type === t; } catch { return false; } })();
    if (/^INSERT IGNORE INTO AnsibleForms.`designer_lock`/.test(sql)) {
      if (lockRow) return { affectedRows: 0 };
      lockRow = { data: params[1] };
      return { affectedRows: 1 };
    }
    // taking it : its holder's own, or an admin's force-release record (free)
    const released = () => { try { return JSON.parse(lockRow?.data).released === true; } catch { return false; } };
    if (/^UPDATE AnsibleForms.`designer_lock` SET data=\?, created=NOW\(\) WHERE id=\? AND \(\(JSON_VALID\(data\) AND JSON_UNQUOTE/.test(sql)) {
      if (!holderIs(params[2], params[3]) && !released()) return { affectedRows: 0 };
      lockRow = { data: params[0] };
      return { affectedRows: 1 };
    }
    if (/^DELETE FROM AnsibleForms.`designer_lock` WHERE id=\? AND JSON_VALID\(data\) AND JSON_UNQUOTE/.test(sql)) {
      if (!holderIs(params[1], params[2])) return { affectedRows: 0 };
      lockRow = null;
      return { affectedRows: 1 };
    }
    if (/^DELETE FROM AnsibleForms.`designer_lock`/.test(sql)) { const had = !!lockRow; lockRow = null; return { affectedRows: had ? 1 : 0 }; }
    if (/^SELECT data FROM AnsibleForms.`designer_lock`/.test(sql)) return lockRow ? [lockRow] : [];
    return { changedRows: 0, affectedRows: 0 };
  };
});

describe("a starting process ends only the jobs it may", () => {
  test("an app node: only the jobs it followed itself", async () => {
    await Job.abandonOwn("app-a");
    const { sql, params } = calls[0];
    assert.match(sql, /host IS NULL and \(tracker=\?\)/);
    assert.deepEqual(params, ["app-a"]);
    assert.doesNotMatch(sql, /tracker IS NULL/, "jobs nobody follows are the worker's to end, once");
  });

  test("the worker: its own, and the jobs from before 7 that nobody follows", async () => {
    await Job.abandonOwn("worker-a", { untracked: true });
    assert.match(calls[0].sql, /\(tracker=\? or tracker IS NULL\)/);
  });

  test("a starting app node never ends a job an RTE runs (host set): it carries on", async () => {
    await Job.abandonOwn("app-a");
    assert.match(calls[0].sql, /host IS NULL/);
  });

  test("the dead-node sweep: the RTE running a job owns it, else the node following it", async () => {
    await Job.abandonDeadNodes("worker-a");
    const { sql, params } = calls[0];
    const owner = "COALESCE\\(j\\.host, j\\.tracker\\)";
    assert.match(sql, new RegExp(`${owner}<>\\?`), "never the worker's own jobs");
    assert.match(sql, new RegExp(`NOT EXISTS \\(SELECT 1 FROM AnsibleForms.\`nodes\` n WHERE n\\.id=${owner} AND n\\.last_seen > \\(NOW\\(\\) - INTERVAL \\? SECOND\\)\\)`));
    assert.equal(params[0], "worker-a");
    assert.ok(params[1] >= 60, "a node is given at least a minute of missed heartbeats");
  });

  test("a socket-mode RTE's running jobs are kept for RTE_QUEUE_MINUTES while its connection is down", async () => {
    const { NODE_DEAD_SECONDS } = await import("../src/lib/role.js");
    const saved = process.env.RTE_QUEUE_MINUTES;
    try {
      // the default : 60 minutes from the RTE's last heartbeat (written while its socket is open)
      delete process.env.RTE_QUEUE_MINUTES;
      await Job.abandonDeadNodes("worker-a");
      const { sql, params } = calls[0];
      assert.match(sql, /and NOT \(j\.host IS NOT NULL AND EXISTS \(SELECT 1 FROM AnsibleForms.`runners` r WHERE r\.name=j\.runner AND r\.type='rte' AND r\.rte_mode IN \(\?\)\)/,
        "only a job an RTE claimed, on a runner in a socket mode");
      assert.match(sql, /EXISTS \(SELECT 1 FROM AnsibleForms.`nodes` rn WHERE rn\.id=j\.host AND rn\.role='rte' AND rn\.last_seen > \(NOW\(\) - INTERVAL \? SECOND\)\)\)$/);
      assert.deepEqual(params, ["worker-a", NODE_DEAD_SECONDS, ["outbound", "inbound"], 3600]);
      // a setting of its own, read at each sweep
      process.env.RTE_QUEUE_MINUTES = "5";
      await Job.abandonDeadNodes("worker-a");
      assert.equal(calls[1].params[3], 300);
      // 0 : kept for ever, until the RTE comes back with or without them, or they are aborted
      process.env.RTE_QUEUE_MINUTES = "0";
      await Job.abandonDeadNodes("worker-a");
      assert.doesNotMatch(calls[2].sql, /rn\.last_seen/);
      assert.deepEqual(calls[2].params, ["worker-a", NODE_DEAD_SECONDS, ["outbound", "inbound"]]);
    } finally {
      if (saved === undefined) delete process.env.RTE_QUEUE_MINUTES;
      else process.env.RTE_QUEUE_MINUTES = saved;
    }
  });

  test("a database-mode RTE, an app and a worker node keep NODE_DEAD_SECONDS", async () => {
    const { NODE_DEAD_SECONDS } = await import("../src/lib/role.js");
    await Job.abandonDeadNodes("worker-a");
    const { sql, params } = calls[0];
    // the rule every owner meets first : its row seen within NODE_DEAD_SECONDS
    assert.match(sql, /n\.id=COALESCE\(j\.host, j\.tracker\) AND n\.last_seen > \(NOW\(\) - INTERVAL \? SECOND\)\) and NOT/);
    assert.equal(params[1], NODE_DEAD_SECONDS);
    // the window is only for a runner in a socket mode : never database, never an unclaimed job
    assert.ok(!params[2].includes("database"));
    assert.match(sql, /j\.host IS NOT NULL AND EXISTS/);
  });

  test("a new job names the node that follows it", async () => {
    let inserted;
    mysql.do = async (sql, record) => { inserted = record; return { insertId: 7 }; };
    await Job.create({ form: "f", status: "running" });
    assert.ok(inserted.tracker, "jobs.tracker must be set");
  });
});

describe("the designer lock lives in the database", () => {
  const user = { username: "alice", type: "local", options: { showDesigner: true } };
  const bob = { username: "bob", type: "local", options: { showDesigner: true } };

  test("free, taken, seen by another user, released", async () => {
    appConfig.showDesigner = true;
    assert.equal(await Lock.isHeld(), false);
    assert.deepEqual(await Lock.status(user), { free: true });
    await Lock.set(user);
    assert.equal(await Lock.isHeld(), true);
    const seen = await Lock.status(bob);
    assert.equal(seen.free, false);
    assert.equal(seen.match, false);
    assert.equal(seen.lock.username, "alice");
    assert.ok(seen.lock.created, "the age shown on the Status page comes from here");
    assert.equal((await Lock.status(user)).match, true);
    await Lock.delete(user);
    assert.equal(await Lock.isHeld(), false);
    assert.equal((await Lock.delete(user)).deleted, false, "deleting a free lock is idempotent");
  });

  test("exclusive: a held lock is refused to another user with 423, and kept", async () => {
    appConfig.showDesigner = true;
    await Lock.set(user);
    await assert.rejects(Lock.set(bob), (e) => e.status === 423 && /locked by alice/.test(e.message));
    assert.equal((await Lock.status(user)).match, true, "alice still holds it");
  });

  test("the holder taking it again refreshes it", async () => {
    appConfig.showDesigner = true;
    await Lock.set(user);
    await Lock.set(user);
    assert.equal((await Lock.status(user)).match, true);
  });

  test("onlyMine never releases somebody else's lock", async () => {
    appConfig.showDesigner = true;
    await Lock.set(bob);
    assert.equal((await Lock.delete(user, { onlyMine: true })).deleted, false);
    assert.equal((await Lock.status(bob)).match, true, "bob keeps it");
    await Lock.delete(bob, { onlyMine: true });
    assert.equal(await Lock.isHeld(), false);
  });

  test("an unreadable lock is still held, by somebody unknown", async () => {
    lockRow = { data: "not json" };
    assert.equal(await Lock.isHeld(), true);
  });
});

describe("AF_ROLE", () => {
  test("every process names itself <role>-<hostname>-<port>: nothing to set", async () => {
    const { nodeId } = await import("../src/lib/role.js");
    const os = await import("os");
    assert.equal(nodeId, `af-${os.hostname()}-${process.env.PORT || 8000}`);
  });

  test("unset means all, as AnsibleForms always ran ; case and spaces do not matter", () => {
    assert.equal(currentRole({}), "all");
    assert.equal(currentRole({ AF_ROLE: "" }), "all");
    assert.equal(currentRole({ AF_ROLE: " Worker " }), "worker");
  });

  test("an unknown role refuses to start, before anything connects", () => {
    const r = spawnSync(process.execPath, ["index.js"], {
      cwd: path.join(here, ".."),
      env: { ...process.env, AF_ROLE: "workr", NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AF_ROLE='workr' is not one of all, controller, worker, rte/);
  });
});
