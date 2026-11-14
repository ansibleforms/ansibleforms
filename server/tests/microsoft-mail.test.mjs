// Mail through Microsoft 365 with OAuth2 (lib/microsoftMail.js) : a mail channel naming an entraid
// credential, against a fake token endpoint and a fake Microsoft Graph on a local port.
//   the token        client credentials with the secret, its scope (Graph or SMTP), kept until
//                    shortly before it expires, a new one for a changed secret
//   the certificate  a client assertion signed RS256, checked here with the certificate's public
//                    key ; a key of another certificate, an expired certificate refused
//   Graph            sendMail as the sender, the body and the recipients, 202
//   SMTP OAuth2      nodemailer with XOAUTH2 to smtp.office365.com:587 and STARTTLS
//   the errors       plain words, never the secret, the key, the assertion or the token
//   SMTP unchanged   a user and a password, or a relay, sent as before
//   the channel      an entraid credential taken, Graph by default, the sender required
//   the credential   its certificate and key checked on save ; SSO refuses a certificate only
import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { makeCertificate, CERTIFICATE_TIMEOUT_MS } from "./helpers/certificates.mjs";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── mocks ────────────────────────────────────────────────────────────────────

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

// the credentials' rows by name (the crud model's findByName), and the channels
let rows = {};
let channels = [];
vi.mock("../src/models/crud.model.js", () => ({
  default: class {
    static changed() {}
    static getCache() {
      return null;
    }
    static isSecretMask(v) {
      return typeof v === "string" && /^\*{8,}$/.test(v);
    }
    static async findByName(modelName, name) {
      if (modelName === "notificationchannel") return channels.find((c) => c.name === name) || null;
      return rows[name] ? { ...rows[name] } : null;
    }
    static async findById(modelName, id) {
      return channels.find((c) => String(c.id) === String(id)) || null;
    }
    static async findAll() {
      return channels;
    }
    static async create() {
      return 7;
    }
    static async update(modelName, data) {
      return data;
    }
  },
}));

// nodemailer : the transports asked for, and what their sendMail does
const transports = [];
let smtpFails = null;
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options) => {
      transports.push(options);
      return {
        sendMail: async (mail) => {
          if (smtpFails) throw smtpFails;
          return { messageId: `<${mail.to}@test>` };
        },
      };
    },
  },
}));

// ─── the fake token endpoint and Graph ────────────────────────────────────────

const tokenRequests = [];
const graphRequests = [];
// what each answers : a status and a body ; null is a token or a 202
let tokenAnswer = null;
let graphAnswer = null;
let issued = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (/\/oauth2\/v2\.0\/token$/.test(req.url)) {
      tokenRequests.push({ url: req.url, form: Object.fromEntries(new URLSearchParams(body)) });
      if (tokenAnswer) {
        res.statusCode = tokenAnswer.status;
        return res.end(JSON.stringify(tokenAnswer.body));
      }
      issued++;
      return res.end(JSON.stringify({ token_type: "Bearer", expires_in: 3599, access_token: `TOKEN-${issued}` }));
    }
    if (/^\/v1\.0\/users\/[^/]+\/sendMail$/.test(req.url)) {
      graphRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      if (graphAnswer) {
        res.statusCode = graphAnswer.status;
        return res.end(JSON.stringify(graphAnswer.body));
      }
      res.statusCode = 202;
      res.setHeader("request-id", "req-42");
      return res.end();
    }
    res.statusCode = 404;
    res.end("{}");
  });
});

let base;
let mail;
let NotificationChannel;
let Settings;
let Credential;
let OAuth2;
// a certificate and its key, and the key of another certificate
let certPem;
let keyPem;
let otherKeyPem;
let dir;

/**
 * A self-signed RSA certificate and its key (the client assertion is signed RS256), made with
 * openssl and valid from a day ago (tests/helpers/certificates.mjs).
 *
 * Returns:
 *   object: { cert, key } (PEM).
 */
function makeCert() {
  const { cert, key } = makeCertificate({ cn: "ansibleforms-mail", keyType: "rsa" });
  return { cert, key };
}

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // the sovereign cloud variables : read at every send
  process.env.ENTRA_AUTHORITY_URI = base;
  process.env.ENTRA_GRAPH_URI = base;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-m365-"));
  ({ cert: certPem, key: keyPem } = makeCert());
  ({ key: otherKeyPem } = makeCert());
  mail = await import("../src/lib/microsoftMail.js");
  NotificationChannel = (await import("../src/models/notificationChannel.model.js")).default;
  Settings = (await import("../src/models/settings.model.js")).default;
  Credential = (await import("../src/models/credential.model.v2.js")).default;
  OAuth2 = (await import("../src/models/oauth2.model.js")).default;
  // two RSA keys made with openssl and the app's modules loaded : longer than the usual 10 seconds
  // on a loaded machine
}, CERTIFICATE_TIMEOUT_MS);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ENTRA_AUTHORITY_URI;
  delete process.env.ENTRA_GRAPH_URI;
});

beforeEach(() => {
  rows = {};
  channels = [];
  tokenRequests.length = 0;
  graphRequests.length = 0;
  transports.length = 0;
  tokenAnswer = null;
  graphAnswer = null;
  smtpFails = null;
  mail.clearTokenCache();
  vi.restoreAllMocks();
});

const SECRET = "s3cr3t-VALUE~abc";
const entraSecret = { name: "m365", tenant_id: "contoso.onmicrosoft.com", client_id: "client-1", client_secret: SECRET };
const graphConfig = (entra = entraSecret) => ({ mail_provider: "graph", mail_from: "AnsibleForms <noreply@contoso.com>", entra });

/**
 * Whether an error message gives nothing away : no secret, key, assertion or token.
 *
 * Args:
 *   message (string): the message.
 */
function expectNoSecrets(message) {
  expect(message).not.toContain(SECRET);
  expect(message).not.toContain("TOKEN-");
  expect(message).not.toContain("PRIVATE KEY");
  expect(message).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
}

// ─── the token ────────────────────────────────────────────────────────────────

describe("the token", () => {
  test("client credentials with the secret, Graph's scope, at the tenant's token endpoint", async () => {
    const token = await mail.getAccessToken(entraSecret, mail.scopeFor("graph"));
    expect(token).toBe("TOKEN-" + issued);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].url).toBe("/contoso.onmicrosoft.com/oauth2/v2.0/token");
    expect(tokenRequests[0].form).toEqual({ client_id: "client-1", scope: `${base}/.default`, grant_type: "client_credentials", client_secret: SECRET });
  });

  test("SMTP asks Exchange Online's scope", async () => {
    await mail.getAccessToken(entraSecret, mail.scopeFor("smtp"));
    expect(tokenRequests[0].form.scope).toBe("https://outlook.office365.com/.default");
  });

  test("kept until shortly before it expires ; a changed secret or another scope gets a new one", async () => {
    const now = Date.now();
    const first = await mail.getAccessToken(entraSecret, mail.scopeFor("graph"), { now });
    expect(await mail.getAccessToken(entraSecret, mail.scopeFor("graph"), { now: now + 50 * 60 * 1000 })).toBe(first);
    expect(tokenRequests).toHaveLength(1);
    // within 5 minutes of its end : a new one
    const later = await mail.getAccessToken(entraSecret, mail.scopeFor("graph"), { now: now + 56 * 60 * 1000 });
    expect(later).not.toBe(first);
    expect(tokenRequests).toHaveLength(2);
    await mail.getAccessToken({ ...entraSecret, client_secret: "rotated" }, mail.scopeFor("graph"), { now });
    await mail.getAccessToken(entraSecret, mail.scopeFor("smtp"), { now });
    expect(tokenRequests).toHaveLength(4);
  });

  test("without a tenant, a client ID or a way to sign in : said, Entra ID never asked", async () => {
    await expect(mail.getAccessToken({ ...entraSecret, tenant_id: "" }, "s")).rejects.toThrow(/no tenant ID/);
    await expect(mail.getAccessToken({ ...entraSecret, client_id: "" }, "s")).rejects.toThrow(/no client ID/);
    await expect(mail.getAccessToken({ ...entraSecret, client_secret: "" }, "s")).rejects.toThrow(/neither a client secret nor a certificate/);
    expect(tokenRequests).toHaveLength(0);
  });
});

// ─── the certificate ──────────────────────────────────────────────────────────

describe("signing in with a certificate", () => {
  const entraCert = () => ({ name: "m365-cert", tenant_id: "tenant-guid", client_id: "client-2", client_cert: certPem, client_key: keyPem });

  test("a client assertion signed RS256, checked with the certificate's public key ; no secret sent", async () => {
    await mail.getAccessToken(entraCert(), mail.scopeFor("graph"));
    const form = tokenRequests[0].form;
    expect(form.client_secret).toBeUndefined();
    expect(form.client_assertion_type).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const [h, p, s] = form.client_assertion.split(".");
    const cert = new crypto.X509Certificate(certPem);
    // the signature, with the public key of the certificate
    expect(crypto.verify("sha256", Buffer.from(`${h}.${p}`), cert.publicKey, Buffer.from(s, "base64url"))).toBe(true);
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(header["x5t#S256"]).toBe(crypto.createHash("sha256").update(cert.raw).digest("base64url"));
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims.aud).toBe(`${base}/tenant-guid/oauth2/v2.0/token`);
    expect(claims.iss).toBe("client-2");
    expect(claims.sub).toBe("client-2");
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.exp - claims.nbf).toBe(600);
    expect(Math.abs(claims.nbf - Date.now() / 1000)).toBeLessThan(5);
  });

  test("a key of another certificate, an expired certificate, a key that does not read : refused before Entra ID", async () => {
    await expect(mail.getAccessToken({ ...entraCert(), client_key: otherKeyPem }, "s")).rejects.toThrow(/does not belong to its certificate/);
    await expect(mail.getAccessToken(entraCert(), "s", { now: Date.now() + 5 * 24 * 3600 * 1000 })).rejects.toThrow(/expired on/);
    const err = await mail.getAccessToken({ ...entraCert(), client_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, "s").catch((e) => e);
    expect(err.message).toMatch(/does not read as a PEM private key/);
    expect(err.message).not.toContain("nope");
    expect(tokenRequests).toHaveLength(0);
  });
});

// ─── Graph ────────────────────────────────────────────────────────────────────

describe("sending through Microsoft Graph", () => {
  test("sendMail as the sender : subject, HTML body, each recipient, not saved ; its request id", async () => {
    const id = await Settings.maildo(graphConfig(), "a@contoso.com, b@contoso.com", "Job 12", "<p>done</p>");
    expect(id).toBe("req-42");
    expect(graphRequests).toHaveLength(1);
    const r = graphRequests[0];
    expect(r.url).toBe("/v1.0/users/noreply%40contoso.com/sendMail");
    expect(r.auth).toMatch(/^Bearer TOKEN-\d+$/);
    expect(r.body).toEqual({
      message: {
        subject: "Job 12",
        body: { contentType: "HTML", content: "<p>done</p>" },
        toRecipients: [{ emailAddress: { address: "a@contoso.com" } }, { emailAddress: { address: "b@contoso.com" } }],
      },
      saveToSentItems: false,
    });
    // a second mail : the token kept
    await Settings.maildo(graphConfig(), "a@contoso.com", "again", "x");
    expect(tokenRequests).toHaveLength(1);
  });

  test("without a sender : said, nothing asked", async () => {
    await expect(Settings.maildo({ ...graphConfig(), mail_from: "" }, "a@contoso.com", "s", "b")).rejects.toThrow(/needs its sender address/);
    expect(tokenRequests).toHaveLength(0);
  });
});

// ─── SMTP with OAuth2 ─────────────────────────────────────────────────────────

describe("sending through SMTP with OAuth2", () => {
  test("XOAUTH2 to smtp.office365.com:587 with STARTTLS, signed in as the sender with Exchange's token", async () => {
    const config = { mail_provider: "smtp_oauth2", mail_server: "smtp.office365.com", mail_port: 587, mail_secure: 0, mail_from: "noreply@contoso.com", entra: entraSecret };
    expect(await Settings.maildo(config, "a@contoso.com", "s", "<p>b</p>")).toBe("<a@contoso.com@test>");
    expect(tokenRequests[0].form.scope).toBe("https://outlook.office365.com/.default");
    expect(transports[0]).toEqual({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { type: "OAuth2", user: "noreply@contoso.com", accessToken: "TOKEN-" + issued },
    });
    expect(graphRequests).toHaveLength(0);
  });
});

// ─── the errors ───────────────────────────────────────────────────────────────

describe("the errors, in plain words and without secrets", () => {
  const aadsts = (code, text) => ({
    status: 401,
    body: { error: "invalid_client", error_description: `AADSTS${code}: ${text}\r\nTrace ID: 1\r\nCorrelation ID: 2`, error_codes: [code] },
  });

  test("a wrong secret, an expired one, a certificate the app does not know", async () => {
    tokenAnswer = aadsts(7000215, "Invalid client secret provided.");
    let err = await Settings.maildo(graphConfig(), "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/client secret is wrong.*AADSTS7000215/);
    expectNoSecrets(err.message);
    tokenAnswer = aadsts(7000222, "The provided client secret keys are expired.");
    err = await Settings.maildo(graphConfig(), "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/client secret has expired/);
    expectNoSecrets(err.message);
    tokenAnswer = aadsts(700027, "Client assertion failed signature validation.");
    err = await Settings.maildo(graphConfig({ ...entraSecret, client_cert: certPem, client_key: keyPem }), "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/certificate is not one of the app registration's/);
    expectNoSecrets(err.message);
    expect(err.message).not.toContain("Trace ID");
    expect(err.cause).toBeUndefined();
  });

  test("Graph : no Mail.Send permission, the app restricted to other mailboxes, no such mailbox", async () => {
    graphAnswer = { status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } } };
    let err = await Settings.maildo(graphConfig(), "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/needs the Mail\.Send application permission.*admin consent/);
    expectNoSecrets(err.message);
    graphAnswer = { status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access to OData is disabled: [RAOP] : Blocked by tenant configured AppOnly AccessPolicy settings." } } };
    err = await Settings.maildo(graphConfig(), "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/restricted to other mailboxes/);
    graphAnswer = { status: 404, body: { error: { code: "ErrorInvalidUser", message: "The requested user 'noreply@contoso.com' is invalid." } } };
    err = await Settings.maildo(graphConfig(), "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/found no mailbox noreply@contoso\.com/);
    expectNoSecrets(err.message);
  });

  test("SMTP : SMTP AUTH turned off for the mailbox, the app not registered in Exchange", async () => {
    const config = { mail_provider: "smtp_oauth2", mail_from: "noreply@contoso.com", entra: entraSecret };
    smtpFails = Object.assign(new Error("Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox."), { code: "EAUTH" });
    let err = await Settings.maildo(config, "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/SMTP AUTH is turned off for noreply@contoso\.com/);
    expectNoSecrets(err.message);
    smtpFails = Object.assign(new Error("Invalid login: 535 5.7.3 Authentication unsuccessful"), { code: "EAUTH" });
    err = await Settings.maildo(config, "a@contoso.com", "s", "b").catch((e) => e);
    expect(err.message).toMatch(/New-ServicePrincipal.*Add-MailboxPermission/);
    expectNoSecrets(err.message);
  });
});

// ─── SMTP unchanged ───────────────────────────────────────────────────────────

describe("an SMTP server with a user and a password, or a relay : as before", () => {
  test("the login, its TLS as set, the certificate not checked", async () => {
    const config = { mail_server: "smtp.example.com", mail_port: 25, mail_secure: 0, mail_username: "u", mail_password: "p", mail_from: "af@example.com" };
    expect(await Settings.maildo(config, "a@example.com", "s", "b")).toBe("<a@example.com@test>");
    expect(transports[0]).toEqual({ host: "smtp.example.com", port: 25, secure: false, auth: { user: "u", pass: "p" }, tls: { rejectUnauthorized: false } });
    await Settings.maildo({ ...config, mail_username: "", mail_password: "" }, "a@example.com", "s", "b");
    expect(transports[1]).toEqual({ host: "smtp.example.com", port: 25, secure: false, tls: { rejectUnauthorized: false } });
    expect(tokenRequests).toHaveLength(0);
  });

  test("no server : nothing sent", async () => {
    expect(await Settings.maildo({ mail_server: "" }, "a@example.com", "s", "b")).toBe(false);
  });
});

// ─── the channel ──────────────────────────────────────────────────────────────

describe("a mail channel with an entraid credential", () => {
  beforeEach(() => {
    rows["m365"] = { name: "m365", credential_type: "entraid", tenant_id: "tenant-guid", client_cert: certPem, client_key: keyPem };
    rows["smtp-login"] = { name: "smtp-login", credential_type: "smtp", host: "smtp.example.com", port: 587, secure: 1 };
    rows["api-token"] = { name: "api-token", credential_type: "api" };
  });

  test("taken, through Graph by default ; SMTP when asked ; another way refused", async () => {
    const data = { name: "m", type: "mail", credential: "m365", from_address: "noreply@contoso.com" };
    await NotificationChannel.normalise(data);
    expect(data.send_through).toBe("graph");
    const smtp = { name: "m", type: "mail", credential: "m365", from_address: "noreply@contoso.com", send_through: "SMTP" };
    await NotificationChannel.normalise(smtp);
    expect(smtp.send_through).toBe("smtp");
    await expect(NotificationChannel.normalise({ name: "m", type: "mail", credential: "m365", from_address: "x@contoso.com", send_through: "pop3" })).rejects.toThrow(/sends through graph or smtp/);
  });

  test("its sender is the mailbox it sends as : required", async () => {
    await expect(NotificationChannel.normalise({ name: "m", type: "mail", credential: "m365" })).rejects.toThrow(/needs its sender address/);
  });

  test("an smtp credential keeps no way to send ; an api one is refused", async () => {
    const data = { name: "m", type: "mail", credential: "smtp-login", from_address: "af@example.com", send_through: "graph" };
    await NotificationChannel.normalise(data);
    expect(data.send_through).toBe(null);
    await expect(NotificationChannel.normalise({ name: "m", type: "mail", credential: "api-token" })).rejects.toThrow(/needs an smtp or an entraid credential/);
  });

  test("its mail config : the app registration (client ID and secret resolved, certificate and key), Graph or Exchange's SMTP", async () => {
    vi.spyOn(NotificationChannel, "resolveCredential").mockResolvedValue({ user: "client-9", password: "sec" });
    const graph = await NotificationChannel.toMailConfig({ name: "m", credential: "m365", from_address: "noreply@contoso.com", send_through: "graph" });
    expect(graph).toMatchObject({ mail_provider: "graph", mail_from: "noreply@contoso.com" });
    expect(graph.entra).toEqual({ name: "m365", tenant_id: "tenant-guid", client_id: "client-9", client_secret: "sec", client_cert: certPem, client_key: keyPem });
    const smtp = await NotificationChannel.toMailConfig({ name: "m", credential: "m365", from_address: "noreply@contoso.com", send_through: "smtp" });
    expect(smtp).toMatchObject({ mail_provider: "smtp_oauth2", mail_server: "smtp.office365.com", mail_port: 587, mail_secure: 0 });
  });

  test("an smtp credential's mail config : its server and login, as before", async () => {
    vi.spyOn(NotificationChannel, "resolveCredential").mockResolvedValue({ user: "u", password: "p" });
    const config = await NotificationChannel.toMailConfig({ name: "m", credential: "smtp-login", from_address: "af@example.com" });
    expect(config).toEqual({ mail_server: "smtp.example.com", mail_port: 587, mail_secure: 1, mail_username: "u", mail_password: "p", mail_from: "af@example.com" });
  });
});

// ─── the credential ───────────────────────────────────────────────────────────

describe("an entraid credential's certificate", () => {
  test("a certificate and its key taken ; a key of another one, a certificate without its key, text that does not read : refused", () => {
    expect(() => Credential.checkEntraCertificate({ client_cert: certPem, client_key: keyPem }, true)).not.toThrow();
    expect(() => Credential.checkEntraCertificate({ client_cert: certPem, client_key: otherKeyPem }, true)).toThrow(/does not belong to the certificate/);
    expect(() => Credential.checkEntraCertificate({ client_cert: certPem }, true)).toThrow(/needs the certificate's private key/);
    expect(() => Credential.checkEntraCertificate({ client_cert: "not a cert" }, false)).toThrow(/is a PEM certificate/);
    // an update that keeps the stored key : the certificate alone
    expect(() => Credential.checkEntraCertificate({ client_cert: certPem, client_key: "********" }, false)).not.toThrow();
    // a secret only : nothing to check
    expect(() => Credential.checkEntraCertificate({ client_cert: "", client_key: null }, true)).not.toThrow();
  });

  test("the SSO sign-in refuses a credential with a certificate and no secret", async () => {
    rows["cert-only"] = { name: "cert-only", credential_type: "entraid", tenant_id: "tenant-guid", client_cert: certPem, password: "" };
    await expect(OAuth2.assertCredential("cert-only", "azuread")).rejects.toThrow(/SSO sign-in needs a client secret/);
    rows["both"] = { ...rows["cert-only"], name: "both", password: "sec" };
    await expect(OAuth2.assertCredential("both", "azuread")).resolves.toBeUndefined();
  });
});

describe("the sender's address", () => {
  test("taken from Name <a@b>, an address alone as it is, at once on a sender full of '<'", () => {
    expect(mail.senderAddress("AnsibleForms <forms@example.com>")).toBe("forms@example.com");
    expect(mail.senderAddress(" forms@example.com ")).toBe("forms@example.com");
    expect(mail.senderAddress("broken <")).toBe("broken <");
    const started = Date.now();
    mail.senderAddress("<".repeat(200000) + "=");
    expect(Date.now() - started).toBeLessThan(200);
  });
});
