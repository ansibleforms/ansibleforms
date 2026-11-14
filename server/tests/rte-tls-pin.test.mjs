// An inbound RTE over TLS, its certificate pinned : the RTE sends its certificate (HTTPS_CERT)
// when it registers with an https RTE_URL, the app keeps it as the ca_bundle of the runner's
// credential (ignore_certs off), shows its fingerprint on a runner waiting for approval, and
// dials the RTE pinned to it - whatever name the certificate was made for, and never to another
// certificate. A plain http address on another host is said in the log, once per runner.
import { test, describe, beforeAll, afterAll, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import { createHash } from "crypto";
import { makeCertificate, CERTIFICATE_TIMEOUT_MS } from "./helpers/certificates.mjs";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── the models ───────────────────────────────────────────────────────────────

// the runners, by name ; what was updated
let runners;
const updated = [];
vi.mock("../src/models/runner.model.js", () => ({
  SOCKET_MODES: ["outbound", "inbound"],
  PENDING_MAX: 20,
  default: {
    countPending: async () => 0,
    findByName: async (name) => (runners[name] ? { ...runners[name] } : undefined),
    create: async (data) => {
      runners[data.name] = { id: Object.keys(runners).length + 1, ...data };
      return runners[data.name].id;
    },
    update: async (data, id) => {
      updated.push({ id, ...data });
      const name = Object.keys(runners).find((n) => runners[n].id === id);
      Object.assign(runners[name], data);
      return true;
    },
  },
}));
vi.mock("../src/models/runnerJoinToken.model.js", () => ({
  default: { use: async (token) => (token === "afj_good" ? { id: 1, name: "dmz" } : null) },
}));
// the credentials, by name ; what was created and updated
let credentials;
const credCreated = [];
const credUpdated = [];
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    findByName: async (name) => (credentials[name] ? { ...credentials[name] } : undefined),
    create: async (data) => {
      credCreated.push(data);
      credentials[data.name] = { id: credCreated.length + 100, ...data };
      return credentials[data.name].id;
    },
    update: async (data, id) => {
      credUpdated.push({ id, ...data });
      const name = Object.keys(credentials).find((n) => credentials[n].id === id);
      Object.assign(credentials[name], data);
      return true;
    },
  },
}));
vi.mock("../src/models/job.model.js", () => ({ default: { registerOutputSecrets: async () => {}, lastOrder: async () => 0 } }));

const { default: mysql } = await import("../src/models/db.model.js");
mysql.do = async (sql) => (sql.startsWith("SELECT") ? [] : { affectedRows: 1 });
mysql.tryDo = async () => ({ affectedRows: 0 });

const hub = await import("../src/runners/rteHub.js");
const { getHttpsAgent } = await import("../src/runners/common.js");
const { parseCertBundle, certFingerprint, CLOSE } = await import("../src/rte/socket/protocol.js");
const { certToSend } = await import("../src/rte/socket/rte-socket.js");
// the logger the hub writes to (aliased to the mock, vitest.config.js)
const { default: logger } = await import("./__mocks__/logger.js");

// ─── certificates, made for the test ──────────────────────────────────────────

let dir;
// two self-signed certificates for a name nobody dials (rte.example), and their keys
let certA;
let keyA;
let certB;

/**
 * A self-signed certificate and its key for rte.example, made with openssl.
 *
 * Returns:
 *   object: { cert, key } (PEM).
 */
function makeCert() {
  // valid from a day ago (tests/helpers/certificates.mjs) : never "not yet valid" on a clock
  // stepped back
  const { cert, key } = makeCertificate({ cn: "rte.example", san: "DNS:rte.example" });
  return { cert, key };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-rte-tls-"));
  ({ cert: certA, key: keyA } = makeCert());
  ({ cert: certB } = makeCert());
}, CERTIFICATE_TIMEOUT_MS);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  runners = {};
  credentials = {};
  updated.length = 0;
  credCreated.length = 0;
  credUpdated.length = 0;
});

// the digest the hub records of a bundle it stores (rte_cert_sha256) : SHA-256 of the bundle as
// parseCertBundle writes it
const digest = (pem) => createHash("sha256").update(parseCertBundle(pem).pem).digest("hex");

const headers = (extra = {}) => ({ authorization: "Bearer rte-token-0123456789", "x-af-rte-name": "dmz-in", "x-af-rte-id": "rte-in-8443", ...extra });

// ─── the certificate itself ───────────────────────────────────────────────────

describe("an RTE's certificate", () => {
  test("read as certificates only, with a short fingerprint as the token's", () => {
    const { pem, certs } = parseCertBundle(`some text before\n${certA}\ntrailing`);
    assert.equal(certs.length, 1);
    assert.ok(!pem.includes("some text"), "nothing but the certificates kept");
    assert.match(certFingerprint(certA), /^[0-9a-f]{4}-[0-9a-f]{4}$/);
    assert.notEqual(certFingerprint(certA), certFingerprint(certB));
    assert.equal(certFingerprint("not a certificate"), null);
    assert.throws(() => parseCertBundle("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"), /cannot be read/);
    assert.throws(() => parseCertBundle("x".repeat(40 * 1024)), /larger/);
  });

  test("the fingerprint's formula : SHA-256 of the DER, the first 8 hex digits as xxxx-xxxx (the installer prints the same)", () => {
    // the sample certificate shipped in the image : openssl x509 -outform DER | sha256sum
    const sample = fs.readFileSync(path.resolve(import.meta.dirname, "../templates/seed/cert.pem.template"), "utf8");
    assert.equal(certFingerprint(sample), "b10e-d0d7");
  });

  test("the RTE listens on every interface unless LISTEN_HOST names one", async () => {
    const { listenHost } = await import("../src/rte/socket/protocol.js");
    assert.equal(listenHost({}), undefined);
    assert.equal(listenHost({ LISTEN_HOST: " " }), undefined);
    assert.equal(listenHost({ LISTEN_HOST: "127.0.0.1" }), "127.0.0.1");
  });

  test("sent by the RTE only when it serves HTTPS and the app dials an https RTE_URL", () => {
    const tls = { https: true, httpsCert: Buffer.from(certA) };
    assert.equal(certToSend({ RTE_URL: "https://rte.dmz:8443" }, tls), certA);
    assert.equal(certToSend({ RTE_URL: "http://rte.dmz:8000" }, tls), null, "a plain address");
    assert.equal(certToSend({ RTE_URL: "https://rte.dmz:8443" }, { https: false, httpsCert: null }), null, "TLS ended by a proxy in front of it");
    assert.equal(certToSend({}, tls), null);
  });

  test("a certificate file the app would refuse is not sent, said once, and the RTE still registers", async () => {
    // the RTE's side writes to the real logger (the alias covers ../lib/logger.js only)
    const { default: rteLogger } = await import("../src/lib/logger.js");
    const warn = vi.spyOn(rteLogger, "warning").mockImplementation(() => {});
    try {
      const env = { RTE_URL: "https://rte.dmz:8443" };
      assert.equal(certToSend(env, { https: true, httpsCert: Buffer.from("x".repeat(40 * 1024)) }), null, "too large");
      assert.equal(certToSend(env, { https: true, httpsCert: Buffer.from(certA.repeat(50)) }), null, "too many");
      const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("HTTPS_CERT is not sent"));
      assert.equal(said.length, 1);
      // only certificates go out : text around them stays behind
      assert.equal(certToSend(env, { https: true, httpsCert: `junk\n${certA}` }), parseCertBundle(certA).pem);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── what the app stores ──────────────────────────────────────────────────────

describe("an inbound RTE registering with its certificate", () => {
  test("asking to join : the certificate in its credential, pinned, its fingerprint in pending_info", async () => {
    const res = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certA, ip: "10.0.0.9" });
    assert.equal(res.pending, true);
    assert.equal(credCreated[0].ca_bundle, parseCertBundle(certA).pem);
    assert.equal(credCreated[0].ignore_certs, 0);
    assert.equal(credCreated[0].url, "https://rte.dmz:8443");
    const info = JSON.parse(runners["dmz-in"].pending_info);
    assert.equal(info.cert_fingerprint, certFingerprint(certA));
    assert.match(info.fingerprint, /^[0-9a-f]{4}-[0-9a-f]{4}$/, "the token's, as before");
  });

  test("with a join token : the certificate in its credential, pinned", async () => {
    const res = await hub.authenticate(headers({ "x-af-rte-join": "afj_good" }), { mode: "inbound", url: "https://rte.dmz:8443", cert: certA });
    assert.ok(res.runner);
    assert.equal(credCreated[0].ca_bundle, parseCertBundle(certA).pem);
    assert.equal(credCreated[0].ignore_certs, 0);
  });

  test("its own token and a renewed certificate : pinned to the new one ; the same one : nothing written", async () => {
    // stored by the hub before : the column holds the digest of the bundle it stored
    credentials["dmz-in-rte"] = { id: 7, name: "dmz-in-rte", credential_type: "rte", password: "rte-token-0123456789", url: "https://rte.dmz:8443", ca_bundle: parseCertBundle(certA).pem, rte_cert_sha256: digest(certA) };
    // findByName reads the address, the token and the bundle from the credential
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", credential: "dmz-in-rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: parseCertBundle(certA).pem };
    await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certA });
    assert.equal(credUpdated.length + updated.length, 0, "the same certificate : nothing written");
    const res = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
    assert.equal(credentials["dmz-in-rte"].ca_bundle, parseCertBundle(certB).pem);
    assert.equal(credentials["dmz-in-rte"].ignore_certs, 0);
    assert.equal(credentials["dmz-in-rte"].rte_cert_sha256, digest(certB), "the digest of the bundle stored");
    assert.equal(credentials["dmz-in-rte"].description, undefined, "the description left alone");
    assert.equal(updated.length, 0, "the runner itself unchanged : its mode and address are the same");
    assert.equal(res.runner.ca_bundle, parseCertBundle(certB).pem);
    // renewed again : the column names the bundle stored, so the RTE may replace it
    runners["dmz-in"].ca_bundle = credentials["dmz-in-rte"].ca_bundle;
    await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certA });
    assert.equal(credentials["dmz-in-rte"].ca_bundle, parseCertBundle(certA).pem);
    assert.equal(credentials["dmz-in-rte"].rte_cert_sha256, digest(certA));
  });

  test("a new credential an RTE joins with records the digest of its certificate", async () => {
    await hub.authenticate(headers({ "x-af-rte-join": "afj_good" }), { mode: "inbound", url: "https://rte.dmz:8443", cert: certA });
    assert.equal(credCreated[0].rte_cert_sha256, digest(certA));
  });

  test("a ca_bundle an admin set by hand is never replaced by the RTE's certificate", async () => {
    // an admin's own bundle : no digest recorded
    credentials["dmz-in-rte"] = { id: 7, name: "dmz-in-rte", credential_type: "rte", password: "rte-token-0123456789", url: "https://rte.dmz:8443", ca_bundle: certA, rte_cert_sha256: null };
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", credential: "dmz-in-rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: certA };
    const warn = vi.spyOn(logger, "warning");
    try {
      const res = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
      assert.ok(res.runner);
      assert.equal(credentials["dmz-in-rte"].ca_bundle, certA, "the admin's bundle stays");
      assert.equal(credUpdated.length + updated.length, 0);
      assert.equal(res.runner.ca_bundle, certA);
      assert.ok(warn.mock.calls.some((c) => /set by hand/.test(String(c[0]))));
    } finally {
      warn.mockRestore();
    }
  });

  test("a bundle an RTE stored, then changed by an admin, is the admin's", async () => {
    // the column names certB (an RTE stored it) ; the bundle is certA since
    credentials["dmz-in-rte"] = { id: 7, name: "dmz-in-rte", credential_type: "rte", password: "rte-token-0123456789", url: "https://rte.dmz:8443", ca_bundle: certA, rte_cert_sha256: digest(certB) };
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", credential: "dmz-in-rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: certA };
    await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
    assert.equal(credentials["dmz-in-rte"].ca_bundle, certA);
  });

  test("an empty ca_bundle takes the RTE's certificate", async () => {
    credentials["dmz-in-rte"] = { id: 7, name: "dmz-in-rte", credential_type: "rte", password: "rte-token-0123456789", url: "https://rte.dmz:8443", ca_bundle: null, description: "hand made" };
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", credential: "dmz-in-rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: null };
    await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
    assert.equal(credentials["dmz-in-rte"].ca_bundle, parseCertBundle(certB).pem);
    assert.equal(credentials["dmz-in-rte"].rte_cert_sha256, digest(certB));
    assert.equal(credentials["dmz-in-rte"].description, "hand made");
  });

  test("a runner keeping its own bundle (no credential) : the digest on the runner row", async () => {
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: parseCertBundle(certA).pem, rte_cert_sha256: digest(certA) };
    await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
    assert.equal(runners["dmz-in"].ca_bundle, parseCertBundle(certB).pem);
    assert.equal(runners["dmz-in"].rte_cert_sha256, digest(certB));
    // set by hand on the runner : kept
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: certA, rte_cert_sha256: null };
    updated.length = 0;
    await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
    assert.equal(runners["dmz-in"].ca_bundle, certA);
    assert.equal(updated.length, 0);
  });

  test("a hand-made runner whose credential the seed manages : the repin is skipped, not a 500", async () => {
    credentials["dmz-in-rte"] = { id: 7, name: "dmz-in-rte", credential_type: "rte", password: "rte-token-0123456789", url: "https://rte.dmz:8443", ca_bundle: certA, managed: 1 };
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", credential: "dmz-in-rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", ca_bundle: certA };
    const warn = vi.spyOn(logger, "warning");
    try {
      const res = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certB });
      assert.ok(res.runner, "let in");
      assert.equal(credUpdated.length + updated.length, 0);
      assert.ok(warn.mock.calls.some((c) => /managed by the config seed/.test(String(c[0]))));
    } finally {
      warn.mockRestore();
    }
    // a new address there : said, not thrown
    const moved = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.other:8443", cert: certA });
    assert.equal(moved.status, 409);
  });

  test("a runner managed by the seed keeps the bundle the seed sets", async () => {
    runners["dmz-in"] = { id: 1, name: "dmz-in", type: "rte", token: "rte-token-0123456789", rte_mode: "inbound", uri: "https://rte.dmz:8443", managed: 1 };
    const res = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: certA });
    assert.ok(res.runner);
    assert.equal(updated.length + credUpdated.length, 0);
  });

  test("a certificate with a plain address, from an outbound RTE, or not a certificate : refused", async () => {
    assert.equal((await hub.authenticate(headers(), { mode: "inbound", url: "http://rte.dmz:8000", cert: certA })).status, 400);
    assert.equal((await hub.authenticate(headers(), { cert: certA })).status, 400);
    const bad = await hub.authenticate(headers(), { mode: "inbound", url: "https://rte.dmz:8443", cert: "hello" });
    assert.equal(bad.status, 400);
    assert.match(bad.error, /not one/);
    assert.equal(credCreated.length, 0);
  });
});

// ─── how the app dials ────────────────────────────────────────────────────────

/**
 * An https server on 127.0.0.1 with a certificate, answering 200 (and, with ws, taking sockets).
 *
 * Args:
 *   cert (string), key (string): its certificate and key.
 *   onUpgrade (function|null): (req, socket, head) for the upgrades.
 *
 * Returns:
 *   Promise<{ server, port }>
 */
async function tlsServer(cert, key, onUpgrade = null) {
  const server = https.createServer({ cert, key }, (req, res) => res.end("ok"));
  if (onUpgrade) server.on("upgrade", onUpgrade);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

/**
 * A GET through an agent.
 *
 * Returns:
 *   Promise<string>: the body ; rejects on a TLS error.
 */
function get(port, agent) {
  return new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

describe("the app dialing a pinned RTE", () => {
  test("its own certificate is trusted whatever name it was made for ; another one never", async () => {
    const { server, port } = await tlsServer(certA, keyA);
    try {
      assert.equal(await get(port, getHttpsAgent({ ca_bundle: certA }, { pin: true })), "ok", "pinned : dialed by its IP address");
      await assert.rejects(get(port, getHttpsAgent({ ca_bundle: certB }, { pin: true })), "another certificate pinned");
      await assert.rejects(get(port, getHttpsAgent({ ca_bundle: certA })), /altnames|hostname|IP/i, "not pinned : the name is checked as always");
      await assert.rejects(get(port, getHttpsAgent({}, { pin: true })), "nothing pinned : the system's authorities");
    } finally {
      server.close();
    }
  });

  test("the pin adds to the usual authorities : a chain to them still passes, its name checked", async () => {
    // a private authority stands in for a public one (a proxy re-encrypting in front of the RTE) :
    // its leaf, made for 127.0.0.1, chains to it ; certA stays the pinned certificate
    const authority = makeCertificate({ cn: "test-ca", isCa: true });
    const leaf = makeCertificate({ cn: "proxy", san: "IP:127.0.0.1", ca: authority });
    const ca = authority.cert;
    const { server, port } = await tlsServer(leaf.cert, leaf.key);
    try {
      assert.equal(await get(port, getHttpsAgent({ ca_bundle: `${certA}\n${ca}` }, { pin: true })), "ok", "a chain and the right name");
      await assert.rejects(get(port, getHttpsAgent({ ca_bundle: certA }, { pin: true })), "no chain to a trusted authority, not pinned");
    } finally {
      server.close();
    }
    // the system's authorities are kept beside the bundle
    const tls = await import("tls");
    const agent = getHttpsAgent({ ca_bundle: certA }, { pin: true });
    assert.ok(agent.options.ca.includes(tls.rootCertificates[0]), "the public roots stay trusted");
    assert.ok(agent.options.ca.includes(certA), "and the bundle");
    // an authority and a leaf made with openssl in the test : longer than the usual 5 seconds on a
    // loaded machine
  }, CERTIFICATE_TIMEOUT_MS);

  test("the socket to an inbound runner is dialed pinned to its credential's certificate", async () => {
    const { WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ noServer: true });
    let auth = null;
    const { server, port } = await tlsServer(certA, keyA, (req, socket, head) => {
      auth = req.headers.authorization;
      wss.handleUpgrade(req, socket, head, () => {});
    });
    const { nodeId } = await import("../src/lib/role.js");
    runners["in-tls"] = { id: 9, name: "in-tls", type: "rte", rte_mode: "inbound", token: "rte-token-0123456789", uri: `https://127.0.0.1:${port}`, ca_bundle: certA, ignore_certs: 0 };
    const doBefore = mysql.do;
    mysql.do = async (sql, params) => {
      if (sql.startsWith("SELECT name FROM AnsibleForms.`runners`")) return [{ name: "in-tls" }];
      if (sql.startsWith("SELECT node_id FROM")) return [{ node_id: nodeId }];
      return doBefore(sql, params);
    };
    try {
      await hub.dialInbound();
      for (let i = 0; i < 100 && !hub.sessions.has("in-tls"); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(hub.sessions.has("in-tls"), "the socket opened over TLS, pinned");
      assert.equal(auth, "Bearer rte-token-0123456789");
    } finally {
      hub.sessions.get("in-tls")?.session.close(CLOSE.GOING_AWAY, "test over");
      mysql.do = doBefore;
      wss.close();
      server.close();
    }
  });

  test("a plain http address on another host is said once per runner ; this host's never", () => {
    const warn = vi.spyOn(logger, "warning");
    try {
      assert.equal(hub.isLoopback("localhost"), true);
      assert.equal(hub.isLoopback("127.0.0.5"), true);
      assert.equal(hub.isLoopback("[::1]"), true);
      assert.equal(hub.isLoopback("10.0.0.5"), false);
      assert.equal(hub.isLoopback("rte.dmz"), false);
      hub.warnPlain("plain-1", "http://rte.dmz:8000");
      hub.warnPlain("plain-1", "http://rte.dmz:8000");
      hub.warnPlain("plain-2", "http://127.0.0.1:8000");
      hub.warnPlain("plain-3", "https://rte.dmz:8443");
      const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("plain http"));
      assert.equal(said.length, 1);
      assert.match(said[0], /plain-1/);
      assert.ok(!said[0].includes("rte-token"), "never the token");
    } finally {
      warn.mockRestore();
    }
  });
});
