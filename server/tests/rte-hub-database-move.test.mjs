// A 7.2 runner (database mode) whose own RTE, upgraded to 7.3, now talks over the socket
// (server/src/runners/rteHub.js, authenticate) : moved to the mode its RTE runs in at once and
// without an approval when it signs in with the runner's own token, never with a join token,
// never for a runner the config seed declares in database mode or one waiting for approval.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import { makeCertificate } from "./helpers/certificates.mjs";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

// ─── the models, in memory ────────────────────────────────────────────────────

// the runners, by name ; what was created and updated
let runners;
const created = [];
const updated = [];
vi.mock("../src/models/runner.model.js", () => ({
  SOCKET_MODES: ["outbound", "inbound"],
  PENDING_MAX: 20,
  default: {
    countPending: async () => Object.values(runners).filter((r) => r.pending).length,
    findByName: async (name) => (runners[name] ? { ...runners[name] } : undefined),
    create: async (data) => {
      created.push(data);
      runners[data.name] = { id: created.length + 100, ...data };
      return created.length + 100;
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
      credentials[data.name] = { id: credCreated.length + 100, ...data };
      return credCreated.length + 100;
    },
    update: async (data, id) => {
      credUpdated.push({ id, ...data });
      const name = Object.keys(credentials).find((n) => credentials[n].id === id);
      Object.assign(credentials[name], data);
      return true;
    },
  },
}));

// what the browsers are told (the Runners page follows "runners")
const published = [];
vi.mock("../src/lib/liveEvents.js", async (importOriginal) => ({
  ...(await importOriginal()),
  publish: (topic) => published.push(topic),
}));

const { default: mysql } = await import("../src/models/db.model.js");
mysql.do = async () => ({ affectedRows: 0, changedRows: 0 });

const { authenticate } = await import("../src/runners/rteHub.js");

beforeEach(() => {
  runners = {};
  credentials = {};
  credCreated.length = 0;
  credUpdated.length = 0;
  created.length = 0;
  updated.length = 0;
  published.length = 0;
  joinUses = 0;
});

// ─── helpers ──────────────────────────────────────────────────────────────────

// the token the 7.2 RTE had all along (RTE_TOKEN), and the one an impostor tries
const TOKEN = "the-72-rte-token-0123456789";
const OTHER = "someone-elses-token-0123456789";

// what the upgraded RTE sends : its token, its runner's name (RTE_NAME), a new id
const headers = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, "x-af-rte-name": "rte", "x-af-rte-id": "rte-0f1e2d3c4b5a-8000", ...extra });

// a runner the 7.2 RTE registered itself : its token on the row, its node id, no mode
const registered = (extra = {}) => ({ id: 1, name: "rte", type: "rte", uri: "http://rte:8000", token: TOKEN, node_id: "rte-a1b2c3d4e5f6-8000", rte_mode: null, pending: 0, ...extra });

// a self-signed certificate, made with openssl, as an inbound RTE with an https RTE_URL sends it :
// valid from a day ago (tests/helpers/certificates.mjs)
function selfSigned() {
  return makeCertificate({ cn: "10.0.0.5", san: "IP:10.0.0.5" }).cert;
}
const CERT = selfSigned();

// ─── moved at once ────────────────────────────────────────────────────────────

describe("a 7.2 runner whose RTE signs in with the runner's own token", () => {
  test("a registered runner moves to outbound, stops being a registered row, and the page is told", async () => {
    runners.rte = registered();
    const res = await authenticate(headers());
    assert.equal(res.runner.name, "rte");
    assert.equal(res.runner.rte_mode, "outbound");
    assert.equal(res.runner.node_id, null, "the session sees it as the socket's runner");
    assert.deepEqual(updated, [{ id: 1, rte_mode: "outbound", node_id: null }]);
    assert.equal(runners.rte.node_id, null, "the sweep of unresponsive RTEs no longer removes it");
    assert.equal(runners.rte.token, TOKEN, "its token stays as it was");
    assert.deepEqual(published, ["runners"]);
    assert.equal(joinUses, 0);
    assert.equal(created.length + credCreated.length, 0, "no new runner, no new credential");
  });

  test("RTE_MODE database said in so many words is database mode too", async () => {
    runners.rte = registered({ rte_mode: "database" });
    await authenticate(headers());
    assert.equal(runners.rte.rte_mode, "outbound");
    assert.equal(runners.rte.node_id, null);
  });

  test("a runner added by hand, its token in a credential since 7.3, moves too and keeps its credential", async () => {
    credentials["rte-token"] = { id: 7, name: "rte-token", credential_type: "rte", password: TOKEN };
    runners.rte = registered({ node_id: null, token: TOKEN, credential: "rte-token" });
    const res = await authenticate(headers());
    assert.equal(res.runner.rte_mode, "outbound");
    assert.deepEqual(updated, [{ id: 1, rte_mode: "outbound" }]);
    assert.equal(credUpdated.length, 0, "outbound : nothing of its credential changes");
  });

  test("inbound with its own token on the row : its address and the certificate it sends", async () => {
    runners.rte = registered();
    const res = await authenticate(headers(), { mode: "inbound", url: "https://10.0.0.5:8000", cert: CERT });
    assert.equal(res.runner.rte_mode, "inbound");
    assert.equal(runners.rte.uri, "https://10.0.0.5:8000");
    assert.equal(runners.rte.node_id, null);
    assert.equal(runners.rte.ignore_certs, 0, "dialed pinned to the certificate it sent");
    assert.ok(String(runners.rte.ca_bundle).includes("BEGIN CERTIFICATE"));
    assert.equal(updated.length, 1, "one write : its mode, address, pin and registration together");
  });

  test("inbound through its rte credential : the address goes there, the runner names it", async () => {
    credentials["rte-token"] = { id: 7, name: "rte-token", credential_type: "rte", password: TOKEN, url: "http://rte:8000" };
    runners.rte = registered({ node_id: null, credential: "rte-token", uri: "" });
    const res = await authenticate(headers(), { mode: "inbound", url: "https://10.0.0.5:8000" });
    assert.equal(res.runner.rte_mode, "inbound");
    assert.equal(credentials["rte-token"].url, "https://10.0.0.5:8000");
    assert.deepEqual(updated, [{ id: 1, rte_mode: "inbound", uri: "" }]);
    assert.deepEqual(published, ["runners"]);
  });

  test("inbound through a credential of before 7.3 (api) : an rte one beside it, and the runner names that one", async () => {
    credentials["rte-token"] = { id: 7, name: "rte-token", credential_type: "api", password: TOKEN };
    runners.rte = registered({ node_id: null, credential: "rte-token", uri: "" });
    await authenticate(headers(), { mode: "inbound", url: "https://10.0.0.5:8000" });
    assert.equal(credCreated.length, 1);
    assert.equal(credCreated[0].name, "rte-rte");
    assert.equal(credCreated[0].url, "https://10.0.0.5:8000");
    assert.equal(runners.rte.credential, "rte-rte", "never left naming a credential without the address");
    assert.equal(runners.rte.rte_mode, "inbound");
  });

  test("signed in again once moved : nothing written, nothing published", async () => {
    runners.rte = registered();
    await authenticate(headers());
    updated.length = 0;
    published.length = 0;
    const res = await authenticate(headers());
    assert.equal(res.runner.rte_mode, "outbound");
    assert.deepEqual([updated.length, published.length], [0, 0]);
  });
});

// ─── refused ──────────────────────────────────────────────────────────────────

describe("a 7.2 runner that is not moved", () => {
  test("another token : refused, nothing written", async () => {
    runners.rte = registered();
    const res = await authenticate(headers({ authorization: `Bearer ${OTHER}` }));
    assert.equal(res.status, 401);
    assert.deepEqual([updated.length, published.length], [0, 0]);
    assert.equal(runners.rte.rte_mode, null);
  });

  test("a join token never moves it : refused before the join token is used", async () => {
    runners.rte = registered();
    const res = await authenticate(headers({ authorization: `Bearer ${OTHER}`, "x-af-rte-join": "afj_good" }));
    assert.equal(res.status, 409);
    assert.match(res.error, /approved/);
    assert.equal(joinUses, 0);
    assert.deepEqual([updated.length, created.length, credCreated.length], [0, 0, 0]);
  });

  test("declared by the config seed in database mode : refused, the seed says how", async () => {
    runners.rte = registered({ managed: 1, node_id: null });
    for (const [opts, mode] of [[{}, "outbound"], [{ mode: "inbound", url: "https://10.0.0.5:8000" }, "inbound"]]) {
      const res = await authenticate(headers(), opts);
      assert.equal(res.status, 409);
      assert.match(res.error, /config seed in database mode/);
      assert.match(res.error, new RegExp(`rte_mode: ${mode}`));
    }
    assert.deepEqual([updated.length, published.length], [0, 0]);
  });

  test("declared by the config seed in the mode its RTE runs in already : let in, nothing written", async () => {
    runners.rte = registered({ managed: 1, node_id: null, rte_mode: "outbound" });
    const res = await authenticate(headers());
    assert.equal(res.runner.name, "rte");
    assert.deepEqual([updated.length, published.length], [0, 0]);
  });

  test("waiting for approval : never moved out of an admin's sight", async () => {
    runners.rte = registered({ pending: 1 });
    const res = await authenticate(headers());
    assert.equal(res.status, 409);
    assert.match(res.error, /approval/);
    assert.equal(updated.length, 0);
  });

  test("a token never appears in what is refused", async () => {
    runners.rte = registered({ managed: 1 });
    const res = await authenticate(headers());
    assert.ok(!res.error.includes(TOKEN));
  });
});
