// The app's side of the RTE sockets (server/src/runners/rteHub.js), against an RTE that does not
// behave : a runner waiting for approval writes nothing, an RTE writes the jobs of its own runner
// only, its id is never an app node's nor another runner's RTE's, one hello per socket, a runner
// removed closes its socket, a job is handed over once however many callers find it, and the
// upgrades to the socket have a ceiling per address.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import http from "http";
import { EventEmitter } from "events";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

// the runners, by name
let runners;
vi.mock("../src/models/runner.model.js", () => ({
  SOCKET_MODES: ["outbound", "inbound"],
  PENDING_MAX: 20,
  default: {
    countPending: async () => 0,
    findByName: async (name) => (runners[name] ? { ...runners[name] } : undefined),
    create: async () => 1,
    update: async () => true,
  },
}));
vi.mock("../src/models/runnerJoinToken.model.js", () => ({ default: { use: async () => null } }));
vi.mock("../src/models/credential.model.v2.js", () => ({ default: { findByName: async () => undefined } }));

const outputs = [];
vi.mock("../src/models/job.model.js", () => ({
  default: {
    createOutputOnce: async (record) => {
      outputs.push(record);
      return true;
    },
    endJobStatus: async () => {},
    resetAbortRequested: async () => {},
    printJobOutput: async () => {},
    lastOrder: async () => 0,
    registerOutputSecrets: async () => {},
  },
}));
vi.mock("../src/models/jobEvent.model.js", () => ({ default: { create: async () => 0 } }));

// the database : the jobs (id -> { runner, host }), the nodes (id -> { role, info, alive }),
// the leases of other runners (rte_id -> runner), and every statement run
let jobs;
let nodes;
let leases;
const queries = [];
const { default: mysql } = await import("../src/models/db.model.js");
mysql.do = async (sql, params = []) => {
  queries.push({ sql, params });
  if (sql.includes("LEFT JOIN AnsibleForms.`nodes` n ON n.id = j.host")) {
    const j = jobs[params[0]];
    if (!j) return [];
    const n = nodes[j.host] || {};
    return [{ runner: j.runner, host: j.host || null, role: n.role || null, info: n.info || null }];
  }
  if (sql.startsWith("SELECT role, info, last_seen")) {
    const n = nodes[params[1]];
    return n ? [{ role: n.role, info: n.info || null, alive: n.alive ? 1 : 0 }] : [];
  }
  if (sql.includes("FROM AnsibleForms.`runner_leases` l JOIN")) {
    const other = leases[params[0]];
    return other && other !== params[1] ? [{ runner: other }] : [];
  }
  if (sql.startsWith("SELECT")) return [];
  return { affectedRows: 1, changedRows: 1 };
};
mysql.tryDo = async (sql, params = []) => {
  queries.push({ sql, params });
  return { affectedRows: 0 };
};

const hub = await import("../src/runners/rteHub.js");
// the logger the hub writes to (aliased to the mock, vitest.config.js)
const { default: logger } = await import("./__mocks__/logger.js");
// the app settings the hub reads (aliased to tests/__mocks__/app.config.js, vitest.config.js)
const { default: appConfig } = await import("../../config/app.config.js");
const { CLOSE } = await import("../src/rte/socket/protocol.js");

/**
 * A socket as the hub sees it : messages in as events, what it sends and how it closed, kept.
 */
class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closedWith = null;
    this.open = true;
    this.ws = { bufferedAmount: 0 };
  }

  send(msg) {
    if (!this.open) return false;
    this.sent.push(msg);
    return true;
  }

  close(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.closedWith = { code, reason };
    this.emit("close", code, reason);
  }
}

// an entry as adopt() makes it, welcomed already
const entryOf = (runner, rteId = "rte-host-a-8000") => ({
  session: new FakeSession(), runner, direction: "outbound", hello: { id: rteId }, health: null, rteId,
  allowed: new Map(), refused: new Set(), hashes: new Set(),
});
const settle = () => new Promise((r) => setTimeout(r, 30));
const hello = (session, extra = {}) => session.emit("m:hello", { t: "hello", id: "rte-host-a-8000", contract: 3, version: "7.3.0", running: [], spooled: [], ...extra });

beforeEach(() => {
  runners = { "dmz-1": { id: 1, name: "dmz-1", type: "rte", token: "rte-token-0123456789", rte_mode: "outbound" } };
  jobs = {};
  nodes = {};
  leases = {};
  outputs.length = 0;
  queries.length = 0;
});

afterEach(() => {
  // every session closed : no lease timer left behind
  for (const e of [...hub.sessions.values()]) e.session.close(CLOSE.GOING_AWAY, "test over");
});

describe("what an RTE sends", () => {
  const item = (jobId, seq = 1) => ({ t: "item", jobId, item: { seq, kind: "output", record: { output: "ok", output_type: "stdout", order: seq } } });

  test("an item of a job of its own runner is stored and acked, the check made once per job", async () => {
    jobs[5] = { runner: "dmz-1", host: "rte-host-a-8000" };
    const entry = entryOf(runners["dmz-1"]);
    hub.onItem(entry, item(5, 1));
    hub.onItem(entry, item(5, 2));
    await settle();
    assert.equal(outputs.length, 2);
    assert.deepEqual(entry.session.sent.map((m) => [m.t, m.seq]), [["ack", 1], ["ack", 2]]);
    assert.equal(queries.filter((q) => q.sql.includes("LEFT JOIN AnsibleForms.`nodes`")).length, 1);
  });

  test("an item of another runner's job is dropped, never acked", async () => {
    jobs[6] = { runner: "prod-1", host: null };
    const entry = entryOf(runners["dmz-1"]);
    hub.onItem(entry, item(6));
    await settle();
    assert.equal(outputs.length, 0);
    assert.equal(entry.session.sent.length, 0);
  });

  test("an item of a job another runner's RTE holds is dropped ; one an RTE of the same runner held is taken", async () => {
    jobs[7] = { runner: "dmz-1", host: "rte-other-8000" };
    nodes["rte-other-8000"] = { role: "rte", info: JSON.stringify({ runner: "prod-1" }) };
    const entry = entryOf(runners["dmz-1"]);
    hub.onItem(entry, item(7));
    await settle();
    assert.equal(outputs.length, 0);
    // the same runner's RTE, come back under another id (a new container with its spool)
    jobs[8] = { runner: "dmz-1", host: "rte-old-8000" };
    nodes["rte-old-8000"] = { role: "rte", info: JSON.stringify({ runner: "dmz-1" }) };
    hub.onItem(entry, item(8));
    await settle();
    assert.equal(outputs.length, 1);
  });

  test("a runner waiting for approval writes nothing and fetches nothing", async () => {
    jobs[9] = { runner: "dmz-1", host: null };
    const entry = entryOf({ ...runners["dmz-1"], pending: 1 });
    hub.onItem(entry, item(9));
    await settle();
    assert.equal(outputs.length, 0);
    assert.equal(queries.length, 0, "not even looked up");
    entry.hashes.add("a".repeat(64));
    hub.onFetch(entry, { t: "fetch", hash: "a".repeat(64) });
    assert.match(entry.session.sent[0].error, /not sent to this runner/);
  });

  test("files are sent only when they are the files of a job sent to that RTE", () => {
    const entry = entryOf(runners["dmz-1"]);
    hub.onFetch(entry, { t: "fetch", hash: "b".repeat(64) });
    assert.match(entry.session.sent[0].error, /not sent to this runner/);
  });
});

describe("an RTE's hello", () => {
  test("the id of an app node is refused, its row in nodes never written", async () => {
    nodes["rte-host-a-8000"] = { role: "app", alive: true };
    const session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    await settle();
    assert.equal(session.closedWith?.code, CLOSE.ID_TAKEN);
    assert.ok(!queries.some((q) => q.sql.includes("runner_leases` (runner")), "no lease taken");
    assert.ok(!queries.some((q) => /INSERT[^;]*`nodes`|UPDATE AnsibleForms.`nodes`/.test(q.sql)));
  });

  test("the id a live RTE of another runner goes by, or another runner's socket holds, is refused", async () => {
    nodes["rte-host-a-8000"] = { role: "rte", alive: true, info: JSON.stringify({ runner: "prod-1" }) };
    let session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    await settle();
    assert.equal(session.closedWith?.code, CLOSE.ID_TAKEN);
    nodes = {};
    leases["rte-host-a-8000"] = "prod-1";
    session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    await settle();
    assert.equal(session.closedWith?.code, CLOSE.ID_TAKEN);
  });

  test("its heartbeat never writes over a row of another role, and a second hello is ignored", async () => {
    const session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    await settle();
    hello(session);
    await settle();
    assert.equal(session.sent.filter((m) => m.t === "welcome").length, 1);
    assert.equal(queries.filter((q) => q.sql.includes("INSERT INTO AnsibleForms.`runner_leases`")).length, 1, "one lease taken");
    const writes = queries.filter((q) => q.sql.includes("`nodes`") && !q.sql.startsWith("SELECT"));
    assert.ok(writes.some((q) => q.sql.includes("WHERE id=? AND role='rte'")));
    assert.ok(writes.some((q) => q.sql.startsWith("INSERT IGNORE")));
    assert.ok(!writes.some((q) => q.sql.includes("ON DUPLICATE KEY")), "never an upsert over another node");
  });

  test("a runner waiting for approval : no heartbeat, and the jobs of its id are not abandoned", async () => {
    runners["dmz-1"].pending = 1;
    const session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    await settle();
    assert.equal(session.sent[0].pending, true);
    assert.ok(!queries.some((q) => q.sql.includes("`nodes`") && !q.sql.startsWith("SELECT")));
    assert.ok(!queries.some((q) => q.sql.includes("status='running' AND host=?")));
  });

  test("a hello on a socket closed meanwhile goes no further", async () => {
    const session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    session.close(CLOSE.GOING_AWAY, "gone");
    await settle();
    assert.ok(!queries.some((q) => q.sql.includes("INSERT INTO AnsibleForms.`runner_leases`")));
    assert.equal(session.sent.length, 0);
  });
});

describe("a runner removed", () => {
  test("its socket closes as unauthorized at the next renewal, on whichever node holds it", async () => {
    const entry = entryOf(runners["dmz-1"]);
    delete runners["dmz-1"];
    await hub.renewTick(entry);
    assert.equal(entry.session.closedWith?.code, CLOSE.UNAUTHORIZED);
  });

  test("approved meanwhile : it takes jobs from the next renewal", async () => {
    const entry = entryOf({ ...runners["dmz-1"], pending: 1 });
    // an admin approved it : its row says so now
    runners["dmz-1"].pending = 0;
    await hub.renewTick(entry);
    assert.equal(entry.session.closedWith, null);
    assert.equal(Number(entry.runner.pending || 0), 0);
  });
});

describe("a job handed over", () => {
  test("two callers at once (kick and dispatch) : one hand-over, one claim", async () => {
    const entry = entryOf(runners["dmz-1"]);
    await Promise.all([hub.sendJob(41, entry), hub.sendJob(41, entry)]);
    assert.equal(queries.filter((q) => q.sql.includes("SET host=? WHERE id=? AND status='running' AND host IS NULL")).length, 1);
  });

  test("abandoned : its wait and its cancel sent are forgotten", async () => {
    hub.waiting.set(42, { firstWait: Date.now(), retryAt: 0, said: true });
    hub.cancelSent.set(42, {});
    await hub.storeItem(entryOf(runners["dmz-1"]), 42, { kind: "abandon", message: "lost" });
    assert.equal(hub.waiting.has(42), false);
    assert.equal(hub.cancelSent.has(42), false);
  });

  test("the jobs an RTE came back without : only its own runner's", async () => {
    await hub.abandonLost(entryOf(runners["dmz-1"]), { running: [], spooled: [] });
    const select = queries.find((q) => q.sql.includes("status='running' AND host=?"));
    assert.match(select.sql, /AND runner=\?/);
    assert.deepEqual(select.params, ["rte-host-a-8000", "dmz-1"]);
  });
});

describe("the folders a job's run message names", () => {
  test("the playbooks of the repository the app takes them from : the one added first, not the first by name", async () => {
    // the job's credentials : none
    const { default: Credential } = await import("../src/models/credential.model.v2.js");
    Credential.resolveCredentialMap = async () => ({});
    const doBefore = mysql.do;
    mysql.do = async (sql, params) => {
      if (sql.startsWith("SELECT form, extravars, credentials")) return [{ form: "f", extravars: "{}", credentials: "{}" }];
      // the rows in any order : by name here
      if (sql.includes("WHERE use_for_playbooks")) return [{ id: 7, name: "aaa-later" }, { id: 3, name: "zzz-first" }];
      return doBefore(sql, params);
    };
    try {
      const entry = entryOf({ ...runners["dmz-1"], rte_files: "local" });
      const handed = hub.sendJob(51, entry);
      await settle();
      const run = entry.session.sent.find((m) => m.t === "run");
      assert.ok(run, "the job is sent");
      assert.equal(run.paths.playbookRepo, "zzz-first");
      // its answer : refused, the hand-over over
      const claim = hub.claims.get(51);
      clearTimeout(claim?.timer);
      claim?.resolve({ claimed: false, error: "test over" });
      await handed;
    } finally {
      mysql.do = doBefore;
    }
  });
});

describe("a job whose form names its playbook's repository (playbookRepository)", () => {
  test("its run message names that repository, run from its root ; a job without one, as before", async () => {
    const { default: Credential } = await import("../src/models/credential.model.v2.js");
    Credential.resolveCredentialMap = async () => ({});
    const doBefore = mysql.do;
    const sent = async (jobId, extravars) => {
      mysql.do = async (sql, params) => {
        if (sql.startsWith("SELECT form, extravars, credentials")) return [{ form: "f", extravars: JSON.stringify(extravars), credentials: "{}" }];
        if (sql.includes("WHERE use_for_playbooks")) return [{ id: 3, name: "first" }, { id: 7, name: "infra" }];
        return doBefore(sql, params);
      };
      const entry = entryOf({ ...runners["dmz-1"], rte_files: "local" });
      const handed = hub.sendJob(jobId, entry);
      await settle();
      const run = entry.session.sent.find((m) => m.t === "run");
      const claim = hub.claims.get(jobId);
      clearTimeout(claim?.timer);
      claim?.resolve({ claimed: false, error: "test over" });
      await handed;
      return run;
    };
    try {
      const named = await sent(61, { __playbookRepository__: "infra" });
      assert.equal(named.paths.playbookRepo, "infra");
      assert.equal(named.paths.playbookRoot, true);
      const plain = await sent(62, {});
      assert.equal(plain.paths.playbookRepo, "first");
      assert.equal("playbookRoot" in plain.paths, false, "nothing new in a job without one");
    } finally {
      mysql.do = doBefore;
    }
  });
});

describe("an abort of a socket-mode job", () => {
  // the aborts the database holds (dispatch's second query) : the job, its RTE and its runner
  const withAborts = async (list, fn) => {
    const doBefore = mysql.do;
    mysql.do = async (sql, params) => {
      if (sql.includes("abort_requested=1 AND host IN")) return list;
      return doBefore(sql, params);
    };
    try {
      await fn();
    } finally {
      mysql.do = doBefore;
    }
  };

  test("a cancel while the job is still handed over is not marked : sent again once the RTE claimed it", async () => {
    const entry = entryOf(runners["dmz-1"]);
    hub.sessions.set("dmz-1", entry);
    try {
      // claimed in the database, the run message on its way : the RTE does not know the job yet
      hub.sending.add(50);
      assert.equal(hub.cancel(50, runners["dmz-1"]), true, "sent : the RTE keeps it until the run comes");
      assert.equal(hub.cancelSent.has(50), false, "but never marked as received");
      await withAborts([{ id: 50, host: "rte-host-a-8000", runner: "dmz-1" }], async () => {
        await hub.dispatch();
        assert.equal(entry.session.sent.filter((m) => m.t === "cancel").length, 1, "not resent while handed over");
        // the RTE said claimed : the next round sends it, and marks it
        hub.sending.delete(50);
        await hub.dispatch();
        assert.equal(entry.session.sent.filter((m) => m.t === "cancel").length, 2);
        assert.equal(hub.cancelSent.get(50), entry);
        await hub.dispatch();
        assert.equal(entry.session.sent.filter((m) => m.t === "cancel").length, 2, "once marked, sent once");
      });
    } finally {
      hub.sending.delete(50);
      hub.cancelSent.delete(50);
      hub.sessions.delete("dmz-1");
    }
  });

  test("the cancels sent on a socket are forgotten when it closes : the next socket sends them again", async () => {
    const session = new FakeSession();
    hub.adopt(session, runners["dmz-1"], "outbound");
    hello(session);
    await settle();
    assert.equal(hub.cancel(60, runners["dmz-1"]), true);
    assert.ok(hub.cancelSent.has(60));
    session.close(CLOSE.GOING_AWAY, "gone");
    assert.equal(hub.cancelSent.has(60), false);
    // the RTE back on a new socket : dispatch sends the cancel there
    const again = new FakeSession();
    hub.adopt(again, runners["dmz-1"], "outbound");
    hello(again);
    await settle();
    await withAborts([{ id: 60, host: "rte-host-a-8000", runner: "dmz-1" }], () => hub.dispatch());
    assert.deepEqual(again.sent.filter((m) => m.t === "cancel"), [{ t: "cancel", jobId: 60 }]);
    hub.cancelSent.delete(60);
  });
});

describe("what a node keeps of the jobs", () => {
  test("the jobs that ended elsewhere are forgotten : masks, cancels, waits and the sessions' answers ; the running ones and the ones in hand stay", async () => {
    const entry = entryOf(runners["dmz-1"]);
    hub.sessions.set("dmz-1", entry);
    const doBefore = mysql.do;
    // jobs 71 and 74 still run ; 72 and 73 ended on another node
    mysql.do = async (sql, params) => {
      if (sql.includes("WHERE id IN (?) AND status='running'")) return params[0].filter((id) => [71, 74].includes(id)).map((id) => ({ id }));
      return doBefore(sql, params);
    };
    try {
      hub.masked.add(71);
      hub.masked.add(72);
      hub.cancelSent.set(72, entry);
      hub.waiting.set(73, { firstWait: 0, retryAt: 0, said: false });
      entry.allowed.set(73, Promise.resolve(true));
      entry.refused.add(72);
      // 75 ended too, but is being handed over now : left alone
      hub.masked.add(75);
      hub.sending.add(75);
      assert.equal(await hub.pruneEnded(), 2, "72 and 73");
      assert.deepEqual([hub.masked.has(71), hub.masked.has(72), hub.masked.has(75)], [true, false, true]);
      assert.equal(hub.cancelSent.has(72), false);
      assert.equal(hub.waiting.has(73), false);
      assert.equal(entry.allowed.has(73), false);
      assert.equal(entry.refused.has(72), false);
    } finally {
      mysql.do = doBefore;
      hub.sending.delete(75);
      for (const id of [71, 72, 75]) hub.masked.delete(id);
      hub.sessions.delete("dmz-1");
    }
  });

  test("a session keeps at most ALLOWED_MAX answers of whether it may write a job", async () => {
    const entry = entryOf(runners["dmz-1"]);
    for (let id = 1; id <= hub.ALLOWED_MAX + 10; id++) jobs[id] = { runner: "dmz-1", host: null };
    for (let id = 1; id <= hub.ALLOWED_MAX + 10; id++) hub.onItem(entry, { t: "item", jobId: id, item: { seq: 1, kind: "exited" } });
    await settle();
    assert.equal(entry.allowed.size, hub.ALLOWED_MAX);
    assert.equal(entry.allowed.has(1), false, "the oldest went");
    assert.equal(entry.allowed.has(hub.ALLOWED_MAX + 10), true);
  });
});

describe("the socket's door", () => {
  test("upgrades have a ceiling per address (AUTH_RATE_LIMIT a minute), 0 turns it off", () => {
    const before = appConfig.authRateLimit;
    try {
      appConfig.authRateLimit = 3;
      const t = 1_000_000;
      assert.deepEqual([1, 2, 3, 4].map(() => hub.upgradeAllowed("10.9.9.9", t)), [true, true, true, false]);
      assert.equal(hub.upgradeAllowed("10.9.9.8", t), true, "another address counts on its own");
      assert.equal(hub.upgradeAllowed("10.9.9.9", t + 61000), true, "a new minute");
      appConfig.authRateLimit = 0;
      assert.equal(hub.upgradeAllowed("10.9.9.9", t + 61001), true);
    } finally {
      appConfig.authRateLimit = before;
    }
  });

  test("an upgrade let in does not count against its address ; a refused one does", () => {
    const before = appConfig.authRateLimit;
    try {
      appConfig.authRateLimit = 2;
      const t = 2_000_000;
      for (let i = 0; i < 5; i++) {
        assert.equal(hub.upgradeAllowed("10.8.8.8", t), true, `reconnect ${i + 1}`);
        hub.upgradeSucceeded("10.8.8.8");
      }
      assert.deepEqual([1, 2, 3].map(() => hub.upgradeAllowed("10.8.8.8", t)), [true, true, false]);
    } finally {
      appConfig.authRateLimit = before;
    }
  });

  test("the client's address follows TRUST_PROXY, as express's req.ip does", () => {
    const before = process.env.TRUST_PROXY;
    const req = { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" }, socket: { remoteAddress: "10.0.0.1" } };
    try {
      delete process.env.TRUST_PROXY;
      assert.equal(hub.clientAddress(req), "10.0.0.1", "no trust proxy : the TCP peer, the header ignored");
      process.env.TRUST_PROXY = "1";
      assert.equal(hub.clientAddress(req), "10.0.0.2", "one hop trusted");
      process.env.TRUST_PROXY = "10.0.0.0/8";
      assert.equal(hub.clientAddress(req), "203.0.113.7", "the proxies by range");
      process.env.TRUST_PROXY = "not-an-address";
      assert.equal(hub.clientAddress(req), "10.0.0.1", "invalid : nothing trusted");
    } finally {
      if (before === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = before;
    }
  });

  test("an inbound RTE that refuses the socket is dialed again : its close comes", async () => {
    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { nodeId } = await import("../src/lib/role.js");
      runners["in-1"] = { id: 2, name: "in-1", type: "rte", rte_mode: "inbound", token: "rte-token-0123456789", uri: `http://127.0.0.1:${server.address().port}` };
      const doBefore = mysql.do;
      mysql.do = async (sql, params) => {
        if (sql.startsWith("SELECT name FROM AnsibleForms.`runners`")) return [{ name: "in-1" }];
        if (sql.startsWith("SELECT node_id FROM")) return [{ node_id: nodeId }];
        return doBefore(sql, params);
      };
      try {
        await hub.dialInbound();
        assert.equal(hub.dialing.has("in-1"), true, "dialing");
        for (let i = 0; i < 50 && hub.dialing.has("in-1"); i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(hub.dialing.has("in-1"), false, "the refusal closed the socket : dialed again at the next round");
      } finally {
        mysql.do = doBefore;
      }
    } finally {
      server.close();
    }
  });

  test("an inbound RTE that cannot be reached is said at warning, with why, once per cause, never its token", async () => {
    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      const body = JSON.stringify({ error: "wrong token" });
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      socket.destroy();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const warn = vi.spyOn(logger, "warning");
    try {
      const { nodeId } = await import("../src/lib/role.js");
      runners["in-2"] = { id: 3, name: "in-2", type: "rte", rte_mode: "inbound", token: "rte-token-0123456789", uri: `http://127.0.0.1:${server.address().port}` };
      hub.dialReports.delete("in-2");
      const doBefore = mysql.do;
      mysql.do = async (sql, params) => {
        if (sql.startsWith("SELECT name FROM AnsibleForms.`runners`")) return [{ name: "in-2" }];
        if (sql.startsWith("SELECT node_id FROM")) return [{ node_id: nodeId }];
        return doBefore(sql, params);
      };
      try {
        // two rounds, the same refusal : said once
        for (let round = 0; round < 2; round++) {
          await hub.dialInbound();
          // the refusal counted and the socket closed (a busy machine : up to 5 s)
          for (let i = 0; i < 250 && (hub.dialing.has("in-2") || (hub.dialReports.get("in-2")?.failures || 0) <= round); i++) await new Promise((r) => setTimeout(r, 20));
        }
        const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("Runner 'in-2'") && !m.includes("plain http"));
        assert.equal(said.length, 1, said.join("\n"));
        assert.match(said[0], /cannot reach it at ws:\/\/127\.0\.0\.1:\d+\/rte\/v1\/socket/);
        assert.match(said[0], /HTTP 401: wrong token/);
        assert.match(said[0], /RTE_TOKEN/);
        assert.ok(!said[0].includes("rte-token-0123456789"), "never the token");
        assert.equal(hub.dialReports.get("in-2").failures, 2, "the second failure counted, not said");
      } finally {
        mysql.do = doBefore;
      }
    } finally {
      warn.mockRestore();
      server.close();
    }
  });
});
