// The SSH page kept in a git repository (lib/repoObjects/ssh.js) : one controller_ssh: map, its
// private key an ${ENV} reference only (never written to git), its known hosts one known_hosts
// line each ; applied as the page saves them, written back when the page changes them ; the
// config seed's ssh: section the same map.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));
vi.mock("../src/lib/liveEvents.js", () => ({ publish: () => {}, onLive: () => {} }));
// the key and the known hosts, in memory : what the page's models keep on disk
const ssh = { key: "", hosts: [], updates: 0 };
vi.mock("../src/models/ssh.model.js", () => ({
  default: {
    privateKey: async () => ssh.key,
    update: async (record) => {
      ssh.key = record.key;
      ssh.updates++;
    },
  },
}));
vi.mock("../src/models/knownhosts.model.js", () => ({
  default: {
    findAll: async () => [...ssh.hosts],
    replaceAll: async (lines) => {
      ssh.hosts = [...lines];
    },
  },
}));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const { validateSeed } = await import("../src/lib/seed-schema.js");
const desc = () => RepoObjects.descriptorOf("ssh");

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
const OTHER_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
const GIT = "git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const LAN = "10.0.0.12 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=";

const write = (text) => {
  fs.mkdirSync(path.join(fx.ROOT, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, "cfg", "ssh.yaml"), text);
};

beforeEach(() => {
  Object.assign(ssh, { key: KEY, hosts: [GIT], updates: 0 });
  process.env.SSH_KEY = OTHER_KEY;
  fx.reset({ repositories: [{ id: 1, name: "cfg", use_for_ssh: 1 }] });
  CrudModel.flushAllLocal();
});

describe("the SSH page in git : controller_ssh:", () => {
  test("turned on : the known hosts written, the private key never", async () => {
    fx.cloneEmpty("cfg");
    const report = await RepoObjects.activate(await desc(), "cfg", { pull: false });
    assert.deepEqual(report.written, ["SSH"]);
    assert.deepEqual(fx.readMap("cfg", "ssh.yaml", "ssh"), { known_hosts: [GIT] });
  });

  test("a pull : the hosts replaced in their order, the key from the environment", async () => {
    write(`controller_ssh:\n  private_key: \${SSH_KEY}\n  known_hosts:\n    - ${LAN}\n    - ${GIT}\n`);
    const summary = await RepoObjects.syncRepository(await desc(), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.deepEqual(ssh.hosts, [LAN, GIT]);
    assert.equal(ssh.key.trim(), OTHER_KEY);
    assert.equal(ssh.updates, 1);
    assert.equal((await RepoObjects.syncRepository(await desc(), "cfg")).unchanged, 1);
  });

  test("a file without the key keeps the app's ; an empty list clears the hosts", async () => {
    write("controller_ssh:\n  known_hosts: []\n");
    const summary = await RepoObjects.syncRepository(await desc(), "cfg");
    assert.equal(summary.updated, 1, JSON.stringify(summary));
    assert.deepEqual(ssh.hosts, []);
    assert.equal(ssh.key, KEY);
    assert.equal(ssh.updates, 0);
  });

  test("refused : a plain key, a line that is no known host ; nothing applied", async () => {
    write(`controller_ssh:\n  private_key: plain\n`);
    assert.match((await RepoObjects.syncRepository(await desc(), "cfg")).refused[0].reasons.join(" "), /private_key must be an \$\{ENV\} reference/);
    write(`controller_ssh:\n  known_hosts:\n    - ${GIT}\n    - "just a host"\n`);
    const why = (await RepoObjects.syncRepository(await desc(), "cfg")).refused[0].reasons.join(" ");
    assert.match(why, /known_hosts: 'just a host' is not a known_hosts line/);
    process.env.SSH_KEY = "not a key";
    write("controller_ssh:\n  private_key: ${SSH_KEY}\n");
    assert.match((await RepoObjects.syncRepository(await desc(), "cfg")).refused[0].reasons.join(" "), /private_key is not a private key/);
    assert.deepEqual(ssh.hosts, [GIT]);
    assert.equal(ssh.key, KEY);
  });

  test("a host added on the page is written into the file", async () => {
    write(`controller_ssh:\n  known_hosts:\n    - ${GIT}\n`);
    await RepoObjects.syncRepository(await desc(), "cfg");
    const before = await RepoObjects.snapshot("ssh");
    ssh.hosts.push(LAN);
    await RepoObjects.appUpdated("ssh", before);
    assert.deepEqual(fx.readMap("cfg", "ssh.yaml", "ssh"), { known_hosts: [GIT, LAN] });
  });

  test("the config seed's ssh: section : the same map, applied as a file's", async () => {
    assert.equal(validateSeed({ ssh: { private_key: OTHER_KEY, known_hosts: [LAN] } }), true);
    assert.throws(() => validateSeed({ ssh: { known_hosts: "one" } }), /validation failed/);
    assert.throws(() => validateSeed({ ssh: { public_key: "x" } }), /validation failed/);
    const done = await RepoObjects.applyDeclared(await desc(), { private_key: OTHER_KEY, known_hosts: [LAN] }, { fromSeed: true, resolved: true });
    assert.deepEqual(done.updated, ["ssh"]);
    assert.deepEqual(ssh.hosts, [LAN]);
    assert.equal(ssh.key.trim(), OTHER_KEY);
  });
});
