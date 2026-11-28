// The app's side of the RTE sockets (server/src/runners/rteHub.js) : who an RTE that calls in
// is (its own token, or a join token that adds it), and what its items do once stored - each
// one safe to store twice, as after a reconnect.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

// the runners, by name ; what was created and updated
let runners;
const created = [];
const updated = [];
vi.mock("../src/models/runner.model.js", () => ({
  SOCKET_MODES: ["outbound", "inbound"],
  PENDING_MAX: 2,
  default: {
    countPending: async () => Object.values(runners).filter((r) => r.pending).length,
    findByName: async (name) => (runners[name] ? { ...runners[name] } : undefined),
    create: async (data) => {
      created.push(data);
      runners[data.name] = { id: created.length, ...data };
      return created.length;
    },
    update: async (data, id) => {
      updated.push({ id, ...data });
      const name = Object.keys(runners).find((n) => runners[n].id === id);
      Object.assign(runners[name], data);
      return true;
    },
  },
}));

// the join tokens : one usable, counted
let joinUses;
vi.mock("../src/models/runnerJoinToken.model.js", () => ({
  default: {
    use: async (token) => {
      if (token !== "afj_good") return null;
      joinUses++;
      return { id: 1, name: "dmz" };
    },
  },
}));

// the credentials : by name, what was created and updated
let credentials;
const credCreated = [];
const credUpdated = [];
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    findByName: async (name) => (credentials[name] ? { ...credentials[name] } : undefined),
    create: async (data) => {
      credCreated.push(data);
      credentials[data.name] = { id: credCreated.length, ...data };
      return credCreated.length;
    },
    update: async (data, id) => {
      credUpdated.push({ id, ...data });
      const name = Object.keys(credentials).find((n) => credentials[n].id === id);
      Object.assign(credentials[name], data);
      return true;
    },
  },
}));

const outputs = [];
const ends = [];
vi.mock("../src/models/job.model.js", () => ({
  default: {
    createOutputOnce: async (record) => {
      // the database failing on one line (the store test below)
      if (record.output === "db down") throw new Error("connection lost");
      if (outputs.some((o) => o.job_id === record.job_id && o.order === record.order)) return false;
      outputs.push(record);
      return true;
    },
    endJobStatus: async (...args) => {
      // written once : a second end of the same job finds it ended
      if (ends.some((e) => e[0] === args[0])) return;
      ends.push(args);
    },
    resetAbortRequested: async () => {},
    printJobOutput: async () => {},
    lastOrder: async () => 0,
    registerOutputSecrets: async () => {},
  },
}));
const events = [];
vi.mock("../src/models/jobEvent.model.js", () => ({
  default: { create: async (jobId, list) => events.push(...list.map((e) => ({ jobId, ...e }))) },
}));

const queries = [];
const { default: mysql } = await import("../src/models/db.model.js");
mysql.do = async (sql, params) => {
  queries.push({ sql, params });
  return { affectedRows: 1, changedRows: 1 };
};

const { authenticate, storeItem } = await import("../src/runners/rteHub.js");

beforeEach(() => {
  runners = {};
  credentials = {};
  credCreated.length = 0;
  credUpdated.length = 0;
  created.length = 0;
  updated.length = 0;
  joinUses = 0;
  outputs.length = 0;
  ends.length = 0;
  events.length = 0;
  queries.length = 0;
});

const headers = (extra = {}) => ({ authorization: "Bearer rte-token-0123456789", "x-af-rte-name": "dmz-1", "x-af-rte-id": "rte-host-8000", ...extra });

describe("an RTE calling in", () => {
  test("its own token lets in the runner of its name, and moves it to outbound", async () => {
    runners["dmz-1"] = { id: 1, name: "dmz-1", type: "rte", token: "rte-token-0123456789", rte_mode: null };
    const res = await authenticate(headers());
    assert.equal(res.runner.name, "dmz-1");
    assert.deepEqual(updated, [{ id: 1, rte_mode: "outbound" }]);
    assert.equal(joinUses, 0);
  });

  test("an unknown RTE without a join token asks to join : a runner waiting for approval, turned off", async () => {
    const res = await authenticate(headers({ "x-af-rte-host": "dmz-host", "x-af-rte-version": "7.3.0" }), { ip: "10.0.0.9" });
    assert.equal(res.pending, true);
    const row = created.at(-1);
    assert.equal(row.name, "dmz-1");
    assert.equal(row.pending, 1);
    assert.equal(row.enabled, 0);
    assert.equal(row.credential, "dmz-1-rte", "its token kept in a credential of its own");
    const info = JSON.parse(row.pending_info);
    assert.deepEqual([info.host, info.ip, info.version, info.mode], ["dmz-host", "10.0.0.9", "7.3.0", "outbound"]);
    assert.match(info.fingerprint, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
    // its token, again (findByName reads it from the runner's credential) : the same runner, still waiting
    runners["dmz-1"].token = "rte-token-0123456789";
    const again = await authenticate(headers());
    assert.equal(again.runner.name, "dmz-1");
    assert.equal(created.length, 1);
  });

  test("another token for a runner waiting : refused ; too many waiting : refused", async () => {
    await authenticate(headers());
    assert.equal((await authenticate(headers({ authorization: "Bearer another-token-0123456789" }))).status, 401);
    await authenticate(headers({ "x-af-rte-name": "dmz-2" }));
    const third = await authenticate(headers({ "x-af-rte-name": "dmz-3" }));
    assert.equal(third.status, 429);
    assert.match(third.error, /wait for approval/);
  });

  test("a join token adds it, its token in a credential of type rte the runner names", async () => {
    const res = await authenticate(headers({ "x-af-rte-join": "afj_good" }));
    assert.equal(res.runner.name, "dmz-1");
    assert.equal(created.length, 1);
    assert.equal(created[0].token, undefined, "no token of its own on the runner");
    assert.equal(created[0].credential, "dmz-1-rte");
    assert.equal(created[0].rte_mode, "outbound");
    assert.equal(created[0].node_id, undefined, "not a registered row the worker would sweep away");
    assert.deepEqual([credCreated[0].name, credCreated[0].credential_type, credCreated[0].password], ["dmz-1-rte", "rte", "rte-token-0123456789"]);
    assert.equal(joinUses, 1);
  });

  test("a credential name taken : the next free one", async () => {
    credentials["dmz-1-rte"] = { id: 99, name: "dmz-1-rte", credential_type: "ssh" };
    await authenticate(headers({ "x-af-rte-join": "afj_good" }));
    assert.equal(created[0].credential, "dmz-1-rte-2");
  });

  test("a wrong token is refused ; a join token gives a runner waiting for approval a new token", async () => {
    credentials["dmz-1-rte"] = { id: 5, name: "dmz-1-rte", credential_type: "rte", password: "the-old-token-0123456789" };
    runners["dmz-1"] = { id: 1, name: "dmz-1", type: "rte", credential: "dmz-1-rte", token: "the-old-token-0123456789", rte_mode: "outbound", pending: 1 };
    assert.equal((await authenticate(headers())).status, 401);
    assert.equal((await authenticate(headers({ "x-af-rte-join": "afj_bad" }))).status, 401);
    const res = await authenticate(headers({ "x-af-rte-join": "afj_good" }));
    assert.ok(res.runner);
    assert.equal(credentials["dmz-1-rte"].password, "rte-token-0123456789");
    assert.equal(credCreated.length, 0, "the runner's own credential, not a new one");
    assert.equal(runners["dmz-1"].pending, 1, "still waiting for an admin");
  });

  test("a join token never takes over an approved runner : its credential, mode and address stay", async () => {
    credentials["dmz-1-rte"] = { id: 5, name: "dmz-1-rte", credential_type: "rte", password: "the-old-token-0123456789", url: "https://rte.dmz:8443" };
    runners["dmz-1"] = { id: 1, name: "dmz-1", type: "rte", credential: "dmz-1-rte", token: "the-old-token-0123456789", rte_mode: "inbound", pending: 0 };
    for (const opts of [{}, { mode: "inbound", url: "https://evil.example:8443" }]) {
      const res = await authenticate(headers({ "x-af-rte-join": "afj_good" }), opts);
      assert.equal(res.status, 409, JSON.stringify(opts));
      assert.match(res.error, /approved/);
    }
    assert.equal(joinUses, 0, "refused before the join token is used");
    assert.deepEqual([credUpdated.length, credCreated.length, updated.length], [0, 0, 0], "nothing written");
    assert.equal(credentials["dmz-1-rte"].password, "the-old-token-0123456789");
    // its current token still lets it in
    const own = await authenticate(headers({ authorization: "Bearer the-old-token-0123456789" }), { mode: "inbound", url: "https://rte.dmz:8443" });
    assert.equal(own.runner.name, "dmz-1");
  });

  test("an inbound registration stores the address the app dials, in the credential", async () => {
    const res = await authenticate(headers({ "x-af-rte-join": "afj_good" }), { mode: "inbound", url: "http://rte.dmz:8000" });
    assert.equal(res.runner.rte_mode, "inbound");
    assert.equal(credCreated[0].url, "http://rte.dmz:8000");
    // inbound needs an address
    runners = {};
    assert.equal((await authenticate(headers({ "x-af-rte-join": "afj_good" }), { mode: "inbound" })).status, 400);
  });

  test("a runner of another type, a short token, a bad name : refused", async () => {
    runners["dmz-1"] = { id: 1, name: "dmz-1", type: "awx" };
    assert.equal((await authenticate(headers())).status, 409);
    assert.equal((await authenticate(headers({ authorization: "Bearer short" }))).status, 401);
    assert.equal((await authenticate(headers({ "x-af-rte-name": "bad name!" }))).status, 400);
  });

  test("a seeded runner keeps the token the seed sets", async () => {
    runners["dmz-1"] = { id: 1, name: "dmz-1", type: "rte", token: "seeded-token-0123456789", managed: 1 };
    assert.equal((await authenticate(headers({ "x-af-rte-join": "afj_good" }))).status, 409);
    assert.equal(joinUses, 0, "refused before the join token is used : it keeps its uses");
  });

  test("two unknown RTEs asking at once cannot both pass the count of the ones waiting", async () => {
    // PENDING_MAX is 2 here : one waits already, two more ask at the same time
    await authenticate(headers({ "x-af-rte-name": "dmz-0" }));
    const both = await Promise.all([
      authenticate(headers({ "x-af-rte-name": "dmz-2" })),
      authenticate(headers({ "x-af-rte-name": "dmz-3" })),
    ]);
    assert.deepEqual(both.map((r) => r.status || 200).sort(), [200, 429]);
    assert.equal(created.length, 2);
  });
});

describe("a builder calling in (AF_ROLE=builder)", () => {
  const builder = (extra = {}) => headers({ "x-af-peer-kind": "builder", ...extra });

  test("unknown, without a join token : a builder waiting for approval, never a runner", async () => {
    const res = await authenticate(builder());
    assert.equal(res.pending, true);
    assert.equal(created[0].type, "builder");
    assert.equal(created[0].pending, 1);
  });

  test("a join token adds it as a builder, its token in an rte credential", async () => {
    const res = await authenticate(builder({ "x-af-rte-join": "afj_good" }));
    assert.equal(res.runner.type, "builder");
    assert.equal(credCreated[0].credential_type, "rte");
  });

  test("a builder never takes a runner's name, nor a runner a builder's ; it is never dialed", async () => {
    runners["dmz-1"] = { id: 1, name: "dmz-1", type: "rte", token: "rte-token-0123456789", rte_mode: "outbound" };
    assert.equal((await authenticate(builder())).status, 409);
    runners["dmz-1"].type = "builder";
    assert.equal((await authenticate(headers())).status, 409);
    assert.equal((await authenticate(builder(), { mode: "inbound", url: "https://b:8000" })).status, 400);
  });
});

describe("an RTE's items", () => {
  const entry = { rteId: "rte-host-8000", runner: { name: "dmz-1" } };

  test("an output resent after a reconnect is stored once", async () => {
    const item = { kind: "output", record: { output: "ok: [h1]", output_type: "stdout", order: 4 } };
    await storeItem(entry, 5, item);
    await storeItem(entry, 5, item);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].job_id, 5);
  });

  test("the end is written once, its notifications from the app", async () => {
    const item = { kind: "end", order: 9, stream: "stdout", status: "success", message: "done", artifacts: { a: 1 } };
    await storeItem(entry, 6, item);
    await storeItem(entry, 6, item);
    assert.equal(ends.length, 1);
    // a failure thrown back (rethrow) : the item is not acked, and the RTE sends it again
    assert.deepEqual(ends[0], [6, 9, "stdout", "success", "done", { a: 1 }, { rethrow: true }]);
  });

  test("a builder's last line is a closing line : ok: [...] when built, [ERROR]: when it failed", async () => {
    const builderEntry = { rteId: "builder-host-8099", runner: { name: "builder-1", type: "builder" } };
    await storeItem(builderEntry, 16, { kind: "end", order: 3, stream: "stdout", status: "success", message: "RTE image r:1 built and pushed" });
    await storeItem(builderEntry, 17, { kind: "end", order: 3, stream: "stdout", status: "failed", message: "the build failed: x" });
    const last = ends.filter((e) => e[0] === 16 || e[0] === 17).map((e) => [e[2], e[4]]);
    assert.deepEqual(last, [
      ["stdout", "ok: [RTE image r:1 built and pushed]"],
      ["stderr", "[ERROR]: the build failed: x"],
    ]);
    const { closingLine } = await import("../src/runners/rteHub.js");
    assert.deepEqual(closingLine({ status: "aborted", stream: "stderr", message: "aborted" }), { stream: "stderr", message: "aborted" });
    assert.deepEqual(closingLine({ status: "success", stream: "stdout", message: "ok: [x y]" }), { stream: "stdout", message: "ok: [x y]" });
  });

  test("events, the log and the process's start go where a database-mode RTE wrote them", async () => {
    await storeItem(entry, 7, { kind: "events", events: [{ order: 1, type: "play" }] });
    await storeItem(entry, 7, { kind: "log", content: "a log" });
    await storeItem(entry, 7, { kind: "started", pid: 42 });
    assert.equal(events.length, 1);
    assert.ok(queries.some((q) => q.sql.includes("SET job_log=?") && q.params[1] === 7));
    assert.ok(queries.some((q) => q.sql.includes("SET pid=?, host=?") && q.params[0] === 42 && q.params[1] === "rte-host-8000"));
  });

  test("a job the RTE lost when it restarted ends as abandoned", async () => {
    await storeItem(entry, 8, { kind: "abandon", message: "the RTE restarted while the playbook ran" });
    assert.ok(queries.some((q) => q.sql.includes("status='abandoned'") && q.params[0] === 8));
  });
});

describe("an RTE's settings from its runner page", async () => {
  const { sessions, filesMode, sendSettings, pushSettings } = await import("../src/runners/rteHub.js");
  const fakeEntry = (runner, said = {}) => {
    const sent = [];
    return { runner, hello: said, health: null, sent, session: { open: true, send: (m) => sent.push(m) } };
  };

  test("the app sends the runner's settings, the empty ones left to the RTE's defaults", () => {
    const entry = fakeEntry({ name: "dmz", rte_max_jobs: 4, rte_cache_mb: null, rte_files: "local", rte_drain_seconds: "" });
    sendSettings(entry);
    assert.deepEqual(entry.sent, [{ t: "settings", settings: { maxJobs: 4, files: "local" } }]);
  });

  test("where an RTE gets a job's files : its runner's setting, else its variable, else transfer", () => {
    assert.equal(filesMode(fakeEntry({ name: "a" }, { files: "transfer", env: {} })), "transfer");
    assert.equal(filesMode(fakeEntry({ name: "a", rte_files: "local" }, { files: "transfer", env: {} })), "local");
    // the runner page wins over RTE_FILES set on the RTE
    assert.equal(filesMode(fakeEntry({ name: "a", rte_files: "transfer" }, { env: { files: "local" } })), "transfer");
    // an empty field : the RTE's own RTE_FILES, as its health (newer than its hello) says
    const entry = fakeEntry({ name: "a" }, { env: {} });
    entry.health = { env: { files: "local" } };
    assert.equal(filesMode(entry), "local");
  });

  test("a saved runner's settings go at once to the RTE this node holds, and only its settings change", () => {
    const entry = fakeEntry({ name: "dmz", token: "kept", rte_max_jobs: 2 }, { files: "transfer" });
    sessions.set("dmz", entry);
    try {
      pushSettings({ name: "dmz", token: "other", rte_max_jobs: 6, rte_cache_mb: 0 });
      assert.deepEqual(entry.sent.at(-1), { t: "settings", settings: { maxJobs: 6, cacheMb: 0 } });
      assert.equal(entry.runner.token, "kept");
      // not held here : nothing sent, nothing thrown
      pushSettings({ name: "elsewhere", rte_max_jobs: 1 });
    } finally {
      sessions.delete("dmz");
    }
  });
});

describe("an item that could not be stored", async () => {
  const { onItem } = await import("../src/runners/rteHub.js");

  test("is never acked by a later one : the socket closes and the RTE sends both again", async () => {
    const sent = [];
    const closed = [];
    const entry = {
      runner: { name: "dmz" },
      rteId: "rte-dmz",
      hello: {},
      allowed: new Map([[31, Promise.resolve(true)]]),
      refused: new Set(),
      session: { open: true, send: (m) => sent.push(m), close: (code, why) => closed.push([code, why]) },
    };
    onItem(entry, { jobId: 31, item: { kind: "output", seq: 1, record: { order: 1, output: "db down" } } });
    onItem(entry, { jobId: 31, item: { kind: "output", seq: 2, record: { order: 2, output: "next line" } } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(sent.filter((m) => m.t === "ack"), []);
    assert.equal(closed.length, 1);
    assert.equal(outputs.some((o) => o.job_id === 31), false);
  });
});
