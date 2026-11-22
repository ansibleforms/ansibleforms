// An RTE that registers again changes its runner or its runner's credential (its mode, its
// address) : one a repository holds (lib/repoObjects) has its file follow the change, so the
// repository's next pull does not undo it - in the background, the registration never waiting for
// a pull or a push of that repository.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── the models ───────────────────────────────────────────────────────────────

// the runners and the credentials, by name
let runners;
let credentials;
const byId = (rows, id) => Object.values(rows).find((r) => r.id === id);
vi.mock("../src/models/runner.model.js", () => ({
  SOCKET_MODES: ["outbound", "inbound"],
  PENDING_MAX: 20,
  default: {
    countPending: async () => 0,
    findByName: async (name) => (runners[name] ? { ...runners[name] } : undefined),
    findStoredById: async (id) => ({ ...byId(runners, id) }),
    update: async (data, id) => Object.assign(byId(runners, id), data) && true,
  },
}));
vi.mock("../src/models/runnerJoinToken.model.js", () => ({ default: { use: async () => null } }));
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    findByName: async (name) => (credentials[name] ? { ...credentials[name] } : undefined),
    findById: async (id) => ({ ...byId(credentials, id) }),
    update: async (data, id) => Object.assign(byId(credentials, id), data) && true,
  },
}));
vi.mock("../src/models/job.model.js", () => ({ default: { registerOutputSecrets: async () => {}, lastOrder: async () => 0 } }));

// the repository-backed objects : what the hub asks of them, the claim held until released
const followed = [];
let release;
vi.mock("../src/lib/repoObjects/index.js", () => ({
  default: {
    holding: async (_keys, change) => {
      await new Promise((resolve) => (release = resolve));
      return change();
    },
    appUpdated: async (key, before, id) => followed.push({ key, before, id }),
  },
}));

const { default: mysql } = await import("../src/models/db.model.js");
mysql.do = async (sql) => (sql.startsWith("SELECT") ? [] : { affectedRows: 1 });
mysql.tryDo = async () => ({ affectedRows: 0 });

const hub = await import("../src/runners/rteHub.js");

const headers = { authorization: "Bearer rte-token-0123456789", "x-af-rte-name": "dmz-in", "x-af-rte-id": "rte-in-8443" };

beforeEach(() => {
  followed.length = 0;
  release = null;
});

describe("an RTE registering again", () => {
  test("its credential a repository holds : its file follows the new address, after the registration", async () => {
    credentials = { "dmz-in-rte": { id: 7, name: "dmz-in-rte", credential_type: "rte", password: "rte-token-0123456789", url: "https://old:8443", repository: "creds", repo_file: "credentials/dmz-in-rte.yaml" } };
    runners = { "dmz-in": { id: 1, name: "dmz-in", type: "rte", credential: "dmz-in-rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://old:8443" } };
    const res = await hub.authenticate(headers, { mode: "inbound", url: "https://new:8443" });
    assert.ok(res.runner, JSON.stringify(res));
    // the registration answered while the repository is still busy
    assert.equal(credentials["dmz-in-rte"].url, "https://new:8443");
    assert.deepEqual(followed, []);
    await vi.waitFor(() => assert.ok(release));
    release();
    await vi.waitFor(() => assert.equal(followed.length, 1));
    assert.equal(followed[0].key, "credentials");
    assert.equal(followed[0].id, 7);
    assert.equal(followed[0].before.url, "https://old:8443", "compared with the credential as it was");
  });

  test("its runner a repository holds : its file follows the new mode", async () => {
    credentials = {};
    runners = { "dmz-in": { id: 1, name: "dmz-in", type: "rte", token: "rte-token-0123456789", rte_mode: "outbound", uri: "", repository: "run", repo_file: "runners/dmz-in.yaml" } };
    await hub.authenticate(headers, { mode: "inbound", url: "https://new:8443" });
    assert.equal(runners["dmz-in"].rte_mode, "inbound");
    await vi.waitFor(() => assert.ok(release));
    release();
    await vi.waitFor(() => assert.equal(followed.length, 1));
    assert.deepEqual([followed[0].key, followed[0].id, followed[0].before.rte_mode], ["runners", 1, "outbound"]);
  });

  test("one the app keeps alone : nothing asked of a repository", async () => {
    credentials = {};
    runners = { "dmz-in": { id: 1, name: "dmz-in", type: "rte", token: "rte-token-0123456789", rte_mode: "outbound", uri: "" } };
    await hub.authenticate(headers, { mode: "inbound", url: "https://new:8443" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(release, null);
    assert.deepEqual(followed, []);
  });
});
