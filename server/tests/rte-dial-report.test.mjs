// Why a socket between the app and an RTE could not be opened (server/src/rte/socket/dialReport.js) :
// the cause in plain words with a hint, the address without its credentials, never the token,
// and the log said once per cause, again at most every few minutes while it lasts, and once
// when the socket opens again.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import http from "http";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import { makeCertificate, CERTIFICATE_TIMEOUT_MS } from "./helpers/certificates.mjs";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";

const { DialReport, DIAL_REPEAT_MS, describeDialFailure, failureLine, safeUrl, scrub, ago } = await import("../src/rte/socket/dialReport.js");

const TOKEN = "rte-token-0123456789";
const APP = "wss://forms.example.com/af/api/v2/rte/socket";

/**
 * Dials an address once and gives what went wrong : the socket's first error, or the status
 * and body of a refusal.
 *
 * Args:
 *   url (string): the address.
 *   options (object): the socket's options.
 *
 * Returns:
 *   Promise<object>: { error } or { status, body }.
 */
function dialOnce(url, options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000, ...options });
    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        resolve({ status: res.statusCode, body });
        ws.terminate();
      });
    });
    ws.on("error", (error) => resolve({ error }));
    ws.on("open", () => {
      resolve({ opened: true });
      ws.close();
    });
  });
}

describe("what a failed dial says", () => {
  test("the address shown has no user, password or query", () => {
    assert.equal(safeUrl("wss://user:secret@forms.example.com/af/api/v2/rte/socket?token=abc#x"), "wss://forms.example.com/af/api/v2/rte/socket");
    assert.equal(safeUrl("not an address"), "?");
    assert.equal(scrub(`proxy http://joe:pw@proxy:3128 said ${TOKEN}`, [TOKEN]), "proxy http://***@proxy:3128 said ***");
  });

  test("a refusal of the handshake : its status, the app's reason and a hint", () => {
    const r401 = describeDialFailure({ status: 401, body: JSON.stringify({ error: "the token of RTE 'x' is not the one stored for its runner: check its RTE_TOKEN" }) }, { url: APP });
    assert.equal(r401.cause, "http-401");
    assert.match(r401.text, /HTTP 401: the token of RTE 'x'/);
    assert.match(r401.text, /RTE_TOKEN/);
    const r404 = describeDialFailure({ status: 404, body: "<html><body><h1>Not Found</h1></body></html>" }, { url: APP });
    assert.match(r404.text, /HTTP 404: Not Found/);
    assert.match(r404.text, /APP_URL/);
    assert.match(r404.text, /BASE_URL/);
    assert.match(describeDialFailure({ status: 407 }, { url: APP, proxy: true }).text, /HTTPS_PROXY/);
    assert.match(describeDialFailure({ status: 409, body: "{\"error\":\"runner 'x' waits for approval\"}" }, { url: APP }).text, /waits for approval/);
    assert.match(describeDialFailure({ status: 502 }, { url: APP }).text, /proxy or load balancer/);
    // the app dialing an inbound RTE : the hints are its own
    assert.match(describeDialFailure({ status: 401 }, { side: "rte", url: "wss://rte:8443/rte/v1/socket" }).text, /runner's credential/);
    assert.match(describeDialFailure({ status: 404 }, { side: "rte", url: "wss://rte:8443/rte/v1/socket" }).text, /RTE_URL/);
  });

  test("a certificate, a name, the network : each its cause and hint", () => {
    const self = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const out = describeDialFailure({ error: self }, { url: APP });
    assert.equal(out.cause, "tls-DEPTH_ZERO_SELF_SIGNED_CERT");
    assert.match(out.text, /not trusted/);
    assert.match(out.text, /NODE_EXTRA_CA_CERTS/);
    assert.match(out.text, /APP_TLS_VERIFY=0/);
    assert.match(describeDialFailure({ error: self }, { side: "rte", url: "wss://rte:8443/" }).text, /registered with/);
    const name = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    assert.match(describeDialFailure({ error: name }, { url: APP }).text, /not for forms\.example\.com.*APP_URL/);
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND forms.example.com"), { code: "ENOTFOUND", hostname: "forms.example.com" });
    assert.match(describeDialFailure({ error: dns }, { url: APP }).text, /forms\.example\.com does not resolve.*APP_URL/);
    assert.match(describeDialFailure({ error: dns }, { url: APP, proxy: true }).text, /through the proxy/);
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED", address: "10.0.0.5", port: 443 });
    assert.match(describeDialFailure({ error: refused }, { url: APP }).text, /nothing listens at 10\.0\.0\.5:443/);
    assert.match(describeDialFailure({ error: new Error("Opening handshake has timed out") }, { url: APP }).text, /no answer from forms\.example\.com/);
    assert.equal(describeDialFailure({ code: 1006 }, { url: APP }).cause, "close-1006");
  });

  test("never the token, wherever it shows up", () => {
    const leak = Object.assign(new Error(`odd failure with Bearer ${TOKEN}`), { code: "EODD" });
    assert.ok(!describeDialFailure({ error: leak }, { url: APP, secrets: [TOKEN] }).text.includes(TOKEN));
    assert.ok(!describeDialFailure({ status: 401, body: `{"error":"bad ${TOKEN}"}` }, { url: APP, secrets: [TOKEN] }).text.includes(TOKEN));
  });

  test("the real failures of a socket : nothing listening, a self-signed certificate, a 404", async () => {
    // a port nothing listens on : one taken, then freed
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const freePort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const refused = describeDialFailure(await dialOnce(`ws://127.0.0.1:${freePort}/api/v2/rte/socket`), { url: `ws://127.0.0.1:${freePort}/api/v2/rte/socket` });
    assert.equal(refused.cause, "net-ECONNREFUSED");

    // a self-signed certificate, checked
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-dial-"));
    try {
      // valid from a day ago (tests/helpers/certificates.mjs) : refused for being self-signed only
      const { cert, key } = makeCertificate({ cn: "app.example", san: "DNS:app.example" });
      const tlsServer = https.createServer({ key, cert });
      await new Promise((r) => tlsServer.listen(0, "127.0.0.1", r));
      try {
        const url = `wss://127.0.0.1:${tlsServer.address().port}/api/v2/rte/socket`;
        const why = describeDialFailure(await dialOnce(url, { rejectUnauthorized: true }), { url });
        assert.match(why.cause, /^tls-/);
        assert.match(why.text, /NODE_EXTRA_CA_CERTS|APP_TLS_VERIFY/);
      } finally {
        tlsServer.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // a server without the socket : 404
    const plain = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise((r) => plain.listen(0, "127.0.0.1", r));
    try {
      const url = `ws://127.0.0.1:${plain.address().port}/wrong/api/v2/rte/socket`;
      const why = describeDialFailure(await dialOnce(url), { url });
      assert.equal(why.cause, "http-404");
      assert.match(why.text, /HTTP 404: not found/);
    } finally {
      plain.close();
    }
    // a certificate made with openssl in the test : longer than the usual 5 seconds on a loaded
    // machine
  }, CERTIFICATE_TIMEOUT_MS);
});

describe("how often the log says it", () => {
  test("the first failure, every change of cause, the same cause at most every few minutes", () => {
    let now = 1_000_000;
    const report = new DialReport({ now: () => now });
    assert.equal(DIAL_REPEAT_MS, 5 * 60 * 1000);
    assert.equal(report.failed("dns").log, true, "the first failure");
    now += 1000;
    assert.equal(report.failed("dns").log, false, "the same cause a second later");
    now += 30000;
    assert.equal(report.failed("dns").log, false);
    now += 1000;
    assert.equal(report.failed("tls").log, true, "a change of cause : at once");
    now += 1000;
    assert.equal(report.failed("tls").log, false);
    now += DIAL_REPEAT_MS;
    const again = report.failed("tls");
    assert.equal(again.log, true, "still there after five minutes : said again");
    assert.equal(again.repeated, true);
    assert.equal(again.failures, 6);
  });

  test("the socket opening after failures is said once ; without failures not at all", () => {
    let now = 0;
    const report = new DialReport({ now: () => now });
    assert.equal(report.connected(), null, "never failed : nothing to say");
    report.failed("dns");
    now += 60000;
    report.failed("dns");
    assert.deepEqual(report.connected(), { failures: 2, since: 0 });
    assert.equal(report.connected(), null, "said once");
    assert.equal(report.failed("dns").log, true, "a failure after it is a first failure again");
  });

  test("the line says the cause, and on a repeat how long it lasts", () => {
    let now = 0;
    const report = new DialReport({ now: () => now });
    const why = { cause: "dns", text: "the name x does not resolve" };
    assert.equal(failureLine(report, why, "RTE 'r1': cannot reach the app at wss://x/"), "RTE 'r1': cannot reach the app at wss://x/: the name x does not resolve");
    now += 1000;
    assert.equal(failureLine(report, why, "p"), null);
    now = DIAL_REPEAT_MS + 1000;
    assert.match(failureLine(report, why, "p"), /still, 3 failed dials in 5 minutes/);
    assert.equal(ago(42000), "42 seconds");
    assert.equal(ago(3 * 3600 * 1000), "3 hours");
  });
});
