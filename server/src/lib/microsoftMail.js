// Mail through Microsoft 365 with OAuth2 : a mail channel of Connections > Notifications that names
// a Microsoft Entra ID credential (models/notificationChannel.js toMailConfig) sends with an access
// token of that app registration instead of a user and a password, which Exchange Online no longer
// takes (SMTP AUTH basic authentication is turned off by default at the end of 2026).
//
//   graph   Microsoft Graph's sendMail (POST /v1.0/users/{sender}/sendMail), over HTTPS : the app
//           needs the Mail.Send application permission, admin consent, and is best restricted to
//           the sending mailbox (Exchange RBAC for Applications)
//   smtp    SMTP with XOAUTH2 to smtp.office365.com:587 (STARTTLS) : the app is registered in
//           Exchange (New-ServicePrincipal), has FullAccess on the mailbox, and the mailbox has
//           SMTP AUTH turned on
//
// The token is the client credentials grant of the credential's app registration : with its client
// secret, or with a certificate (a client assertion, a JWT signed RS256 with its private key). It is
// kept until shortly before it expires, per credential and per scope ; a secret, a certificate or a
// key changed in the credential gets a new one at once (they are part of the cache key, as a digest).
//
// The sovereign clouds : the token endpoint is ENTRA_AUTHORITY_URI, Graph ENTRA_GRAPH_URI (config/
// auth.config.js), both read at every send.
//
// Every failure is said in plain words (what to change, and where) and never carries the secret, the
// private key, the assertion or the token : the axios error, whose request holds them, is never
// handed on.
import crypto from "node:crypto";
import axios from "axios";
import nodemailer from "nodemailer";
import logger from "./logger.js";
import { entraEnv } from "../../config/auth.config.js";
import { stripTrailingSlashes } from "./url.js";

// ─── constants ────────────────────────────────────────────────────────────────

// how a mail channel with an Entra ID credential sends : the values of its send_through column
export const SEND_THROUGH = ["graph", "smtp"];
// Exchange Online's SMTP server, and its scope : the token SMTP AUTH takes
export const OFFICE365_SMTP = { server: "smtp.office365.com", port: 587, secure: 0 };
export const SMTP_SCOPE = "https://outlook.office365.com/.default";
// a token is used until this long before it expires (Entra ID gives one for about an hour)
export const TOKEN_MARGIN_MS = 5 * 60 * 1000;
// how long the token endpoint and Graph may take to answer
const TIMEOUT_MS = 15000;
// how long a client assertion is valid : Entra ID takes at most 10 minutes
const ASSERTION_LIFETIME_S = 600;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

// the tokens got : cache key -> { token, expiresAt } ; an entry past its use (within TOKEN_MARGIN_MS
// of its end) is dropped at the next ask (pruneTokenCache), so a rotated secret or certificate
// leaves nothing behind
const tokenCache = new Map();
// the token requests under way : cache key -> the promise of the token ; concurrent sends with no
// token kept wait for the same request instead of each asking Entra ID (which throttles)
const pendingTokens = new Map();

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * A buffer or a text as base64url, without padding (a JWT's parts).
 *
 * Args:
 *   value (Buffer|string): what to encode.
 *
 * Returns:
 *   string: its base64url form.
 */
function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * The address in a sender : "Name <a@b>" gives a@b, an address alone stays.
 *
 * Args:
 *   from (string): the channel's sender.
 *
 * Returns:
 *   string: the address, trimmed.
 */
export function senderAddress(from) {
  const text = String(from ?? "").trim();
  // the last "<" and the ">" after it, found by position : a regex over a sender full of "<" would
  // take quadratic time
  const open = text.lastIndexOf("<");
  const close = open < 0 ? -1 : text.indexOf(">", open + 1);
  return (close > open + 1 ? text.slice(open + 1, close) : text).trim();
}

/**
 * The token endpoint of a tenant : {authority}/{tenant}/oauth2/v2.0/token.
 *
 * Args:
 *   tenantId (string): the tenant ID (a GUID or a domain of the tenant).
 *
 * Returns:
 *   string: the endpoint, under ENTRA_AUTHORITY_URI.
 */
export function tokenEndpoint(tenantId) {
  const authority = stripTrailingSlashes(entraEnv("ENTRA_AUTHORITY_URI"));
  return `${authority}/${encodeURIComponent(String(tenantId ?? "").trim())}/oauth2/v2.0/token`;
}

/**
 * The scope of a send : Graph's (ENTRA_GRAPH_URI/.default) or Exchange Online's SMTP.
 *
 * Args:
 *   through (string): graph or smtp.
 *
 * Returns:
 *   string: the scope asked for.
 */
export function scopeFor(through) {
  return through === "smtp" ? SMTP_SCOPE : `${stripTrailingSlashes(entraEnv("ENTRA_GRAPH_URI"))}/.default`;
}

/**
 * Whether an Entra ID credential signs in with a certificate : it has one, and its private key.
 *
 * Args:
 *   entra (object): the credential's sign-in ({ client_cert, client_key }).
 *
 * Returns:
 *   boolean: true when the token is asked with a client assertion.
 */
export function usesCertificate(entra) {
  return !!(String(entra?.client_cert ?? "").trim() && String(entra?.client_key ?? "").trim());
}

/**
 * Forgets the tokens got and the requests under way (a test starts clean).
 */
export function clearTokenCache() {
  tokenCache.clear();
  pendingTokens.clear();
}

/**
 * Drops the tokens kept that can no longer be used : within TOKEN_MARGIN_MS of their end, or past
 * it. Run at every ask, so the cache holds at most the tokens still in use.
 *
 * Args:
 *   now (number): the time, in milliseconds (Date.now()).
 *
 * Returns:
 *   number: how many were dropped.
 */
export function pruneTokenCache(now = Date.now()) {
  let dropped = 0;
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt - TOKEN_MARGIN_MS <= now) {
      tokenCache.delete(key);
      dropped++;
    }
  }
  return dropped;
}

/**
 * How many tokens are kept (the tests see that expired ones are dropped).
 *
 * Returns:
 *   number: the entries of the token cache.
 */
export function tokenCacheSize() {
  return tokenCache.size;
}

// ─── certificate ──────────────────────────────────────────────────────────────

/**
 * Reads a credential's certificate and private key, and checks that they go together and that the
 * certificate has not expired. The messages never hold the key.
 *
 * Args:
 *   certPem (string): the certificate (PEM ; the first one of a chain is used).
 *   keyPem (string): its private key (PEM, not encrypted).
 *   name (string): the credential's name, for the messages.
 *   now (number): the time, in milliseconds (Date.now()).
 *
 * Returns:
 *   object: { cert : X509Certificate, key : KeyObject }.
 *
 * Raises:
 *   Error: the certificate or the key does not read, they do not go together, or the certificate
 *     has expired or is not valid yet.
 */
export function readCertificate(certPem, keyPem, name, now = Date.now()) {
  let cert;
  let key;
  try {
    cert = new crypto.X509Certificate(String(certPem).trim());
  } catch {
    throw new Error(`The certificate of the credential '${name}' does not read as a PEM certificate (-----BEGIN CERTIFICATE-----)`);
  }
  try {
    key = crypto.createPrivateKey(String(keyPem).trim());
  } catch {
    throw new Error(`The private key of the credential '${name}' does not read as a PEM private key without a passphrase (-----BEGIN PRIVATE KEY-----)`);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`The private key of the credential '${name}' is not an RSA key: Microsoft Entra ID signs in with an RSA certificate`);
  }
  if (!cert.checkPrivateKey(key)) {
    throw new Error(`The private key of the credential '${name}' does not belong to its certificate`);
  }
  if (Date.parse(cert.validTo) < now) {
    throw new Error(`The certificate of the credential '${name}' expired on ${cert.validTo}: upload a new one to the app registration and to the credential`);
  }
  if (Date.parse(cert.validFrom) > now) {
    throw new Error(`The certificate of the credential '${name}' is not valid before ${cert.validFrom}`);
  }
  return { cert, key };
}

/**
 * A client assertion : the JWT a certificate signs in with (RFC 7523), signed RS256 with the
 * certificate's private key. Its header names the certificate by its SHA-256 thumbprint
 * (x5t#S256), its claims are the token endpoint (aud), the client ID (iss and sub), a unique id
 * (jti) and its validity (nbf, exp).
 *
 * Args:
 *   options (object): {
 *     clientId (string): the app registration's client ID.
 *     tokenUrl (string): the token endpoint (the audience).
 *     certPem (string): the certificate (PEM).
 *     keyPem (string): its private key (PEM).
 *     name (string): the credential's name, for the messages.
 *     now (number): the time in milliseconds, Date.now() by default.
 *   }
 *
 * Returns:
 *   string: the signed JWT.
 *
 * Raises:
 *   Error: the certificate or the key cannot be used (readCertificate).
 */
export function clientAssertion({ clientId, tokenUrl, certPem, keyPem, name = "", now = Date.now() }) {
  // step 1 : the certificate and its key, checked
  const { cert, key } = readCertificate(certPem, keyPem, name, now);
  // step 2 : the header, the certificate named by the SHA-256 of its DER form
  const header = {
    alg: "RS256",
    typ: "JWT",
    "x5t#S256": base64url(crypto.createHash("sha256").update(cert.raw).digest()),
  };
  // step 3 : the claims
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    aud: tokenUrl,
    iss: clientId,
    sub: clientId,
    jti: crypto.randomUUID(),
    nbf: issuedAt,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_S,
  };
  // step 4 : signed with the private key (RSASSA-PKCS1-v1_5, SHA-256)
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), key);
  return `${signingInput}.${base64url(signature)}`;
}

// ─── errors ───────────────────────────────────────────────────────────────────

// what the token endpoint's AADSTS codes mean, in words that say what to change
const AADSTS_REASONS = {
  7000215: "its client secret is wrong: copy the secret's Value (not its ID) from the app registration",
  7000222: "its client secret has expired: make a new one in the app registration (Certificates & secrets)",
  700027: "its certificate is not one of the app registration's, or its signature is not accepted: upload the certificate to the app registration (Certificates & secrets)",
  700024: "its client assertion is not within its valid time: check the server's clock",
  7000274: "its certificate has expired or is not valid yet: upload a new one to the app registration and to the credential",
  700016: "its client ID is not an app registration of that tenant: check the client ID and the tenant ID",
  700017: "its certificate is not one of the app registration's: upload the certificate to the app registration (Certificates & secrets)",
  7000112: "its app registration is turned off in the tenant",
  90002: "its tenant ID is not found: check the tenant ID",
  900023: "its tenant ID is not valid: use the tenant's GUID or one of its domains",
  70011: "the scope it asked for is not valid",
  1002012: "the scope it asked for is not valid",
  500011: "the resource it asked a token for is not in the tenant",
  7000218: "it sent neither a client secret nor a certificate",
};

/**
 * Microsoft's own message without its trace : the first line of an error_description, with
 * Trace ID, Correlation ID and Timestamp left out.
 *
 * Args:
 *   text (string): Microsoft's error_description, or Graph's error message.
 *
 * Returns:
 *   string: the message, at most 300 characters.
 */
function microsoftMessage(text) {
  return String(text ?? "")
    .split(/\r?\n/)[0]
    .replace(/\s*Trace ID:.*$/i, "")
    .trim()
    .slice(0, 300);
}

/**
 * Why the token endpoint refused, in plain words.
 *
 * Args:
 *   err (Error): the axios error.
 *   name (string): the credential's name.
 *   certificate (boolean): whether it signed in with a certificate.
 *
 * Returns:
 *   Error: a new error, its message without any secret.
 */
export function tokenError(err, name, certificate) {
  const data = err?.response?.data || {};
  const status = err?.response?.status;
  const description = microsoftMessage(data.error_description);
  const codes = (Array.isArray(data.error_codes) ? data.error_codes : [])
    .concat([...String(data.error_description || "").matchAll(/AADSTS(\d+)/g)].map((m) => Number(m[1])));
  const known = codes.find((c) => AADSTS_REASONS[c]);
  const what = certificate ? "certificate" : "client secret";
  if (known) return new Error(`Microsoft Entra ID refused the credential '${name}': ${AADSTS_REASONS[known]} (AADSTS${known})`);
  if (data.error === "invalid_client") {
    return new Error(`Microsoft Entra ID refused the credential '${name}': its ${what} is not valid or has expired${description ? ` (${description})` : ""}`);
  }
  if (status) return new Error(`Microsoft Entra ID did not give the credential '${name}' a token (${status}${data.error ? ` ${data.error}` : ""})${description ? `: ${description}` : ""}`);
  return new Error(`Microsoft Entra ID could not be reached for the credential '${name}': ${err?.code || err?.message || "no answer"}`);
}

/**
 * Why Graph refused a sendMail, in plain words.
 *
 * Args:
 *   err (Error): the axios error.
 *   from (string): the sender mailbox.
 *   name (string): the credential's name.
 *
 * Returns:
 *   Error: a new error, its message without any secret.
 */
export function graphError(err, from, name) {
  const status = err?.response?.status;
  const body = err?.response?.data?.error || {};
  const code = String(body.code || "");
  const message = microsoftMessage(body.message);
  // the app restricted to other mailboxes : an application access policy, or Exchange RBAC for
  // Applications with a management scope that leaves this mailbox out
  if (status === 403 && /AccessPolicy|RAOP|management scope|ApplicationAccess/i.test(`${code} ${message}`)) {
    return new Error(`Microsoft Graph refused to send as ${from}: the app registration of the credential '${name}' is restricted to other mailboxes (an application access policy, or RBAC for Applications in Exchange): add ${from} to its scope`);
  }
  if (status === 403) {
    return new Error(`Microsoft Graph refused to send as ${from}: the app registration of the credential '${name}' needs the Mail.Send application permission (Microsoft Graph), with admin consent granted, or an Application Mail.Send role in Exchange whose scope holds ${from}`);
  }
  if (status === 404 || /ErrorInvalidUser|ResourceNotFound|MailboxNotEnabledForRESTAPI|ErrorNonExistentMailbox/i.test(code)) {
    return new Error(`Microsoft Graph found no mailbox ${from}: the sender address must be a mailbox of Exchange Online (a user or a shared mailbox) in the credential's tenant`);
  }
  if (status === 401) {
    return new Error(`Microsoft Graph did not accept the token of the credential '${name}'${message ? `: ${message}` : ""}`);
  }
  if (status === 400) {
    return new Error(`Microsoft Graph did not take the mail${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`);
  }
  if (status) return new Error(`Microsoft Graph answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`);
  return new Error(`Microsoft Graph could not be reached: ${err?.code || err?.message || "no answer"}`);
}

/**
 * Why Exchange Online's SMTP server refused, in plain words.
 *
 * Args:
 *   err (Error): nodemailer's error.
 *   from (string): the sender mailbox.
 *   name (string): the credential's name.
 *
 * Returns:
 *   Error: a new error, its message without any secret.
 */
export function smtpError(err, from, name) {
  const text = `${err?.response || ""} ${err?.message || ""}`;
  if (/SmtpClientAuthentication is disabled|5\.7\.139.*disabled/i.test(text)) {
    return new Error(`SMTP AUTH is turned off for ${from}: turn it on for that mailbox (Set-CASMailbox -Identity ${from} -SmtpClientAuthenticationDisabled $false), or send through Microsoft Graph`);
  }
  if (err?.code === "EAUTH" || /\b535\b|5\.7\.3\b|Authentication unsuccessful/i.test(text)) {
    return new Error(`Exchange Online refused the token of the credential '${name}' for ${from}: register the app in Exchange (New-ServicePrincipal) and give it FullAccess to the mailbox (Add-MailboxPermission), or send through Microsoft Graph`);
  }
  if (/5\.7\.60|SendAsDenied|not authorized to send/i.test(text)) {
    return new Error(`Exchange Online refused to send as ${from}: the app may send from the mailbox it signs in to only (the sender address is that mailbox)`);
  }
  const reason = String(err?.response || err?.message || err?.code || "no answer").split(/\r?\n/)[0].slice(0, 300);
  return new Error(`Exchange Online did not take the mail from ${from}: ${reason}`);
}

// ─── the token ────────────────────────────────────────────────────────────────

/**
 * An access token of an Entra ID credential's app registration (the client credentials grant) :
 * the one kept while it is valid for TOKEN_MARGIN_MS more, else a new one from the token endpoint.
 * Concurrent asks for the same token share one request ; a failed request is not kept, the next
 * ask tries again.
 *
 * Args:
 *   entra (object): the credential's sign-in : { name, tenant_id, client_id, client_secret,
 *     client_cert, client_key } ; a certificate and its key are used when it has both.
 *   scope (string): the scope asked for (scopeFor).
 *   options (object): { now : the time in milliseconds, Date.now() by default }.
 *
 * Returns:
 *   Promise<string>: the access token.
 *
 * Raises:
 *   Error: the credential lacks what it signs in with, or Entra ID refused (tokenError).
 */
export async function getAccessToken(entra, scope, { now = Date.now() } = {}) {
  const name = entra?.name || "";
  // step 1 : what it signs in with
  const tenant = String(entra?.tenant_id ?? "").trim();
  const clientId = String(entra?.client_id ?? "").trim();
  const certificate = usesCertificate(entra);
  if (!tenant) throw new Error(`The credential '${name}' has no tenant ID`);
  if (!clientId) throw new Error(`The credential '${name}' has no client ID (its user)`);
  if (!certificate && !entra?.client_secret) {
    throw new Error(`The credential '${name}' has neither a client secret nor a certificate with its private key`);
  }
  // step 2 : the token kept, while it has a while to go ; the secret or the certificate is part of
  // the key as a digest, so a changed one is never served an old token
  const tokenUrl = tokenEndpoint(tenant);
  const proof = certificate ? `${entra.client_cert}\n${entra.client_key}` : String(entra.client_secret);
  const cacheKey = crypto.createHash("sha256").update([name, tokenUrl, clientId, scope, proof].join("\u0000")).digest("hex");
  pruneTokenCache(now);
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached.token;
  // step 3 : a request already under way for this token : wait for it, never a second one
  const pending = pendingTokens.get(cacheKey);
  if (pending) return pending;
  // step 4 : a new one, shared with whoever asks while it is under way ; forgotten once it is
  // answered, kept in the cache only when it succeeded
  const request = requestToken({ entra, name, clientId, scope, tokenUrl, certificate, cacheKey, now });
  pendingTokens.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (pendingTokens.get(cacheKey) === request) pendingTokens.delete(cacheKey);
  }
}

/**
 * Asks the token endpoint for a new token (the client credentials grant, with the secret or a
 * client assertion) and keeps it until shortly before it expires. Only getAccessToken calls it,
 * once per cache key at a time.
 *
 * Args:
 *   request (object): { entra, name, clientId, scope, tokenUrl, certificate, cacheKey, now } :
 *     the credential's sign-in and what getAccessToken worked out from it.
 *
 * Returns:
 *   Promise<string>: the access token.
 *
 * Raises:
 *   Error: Entra ID refused, or gave no token (tokenError).
 */
async function requestToken({ entra, name, clientId, scope, tokenUrl, certificate, cacheKey, now }) {
  // step 1 : the form, with the secret or a client assertion
  const form = new URLSearchParams({ client_id: clientId, scope, grant_type: "client_credentials" });
  if (certificate) {
    form.set("client_assertion_type", ASSERTION_TYPE);
    form.set("client_assertion", clientAssertion({ clientId, tokenUrl, certPem: entra.client_cert, keyPem: entra.client_key, name, now }));
  } else {
    form.set("client_secret", String(entra.client_secret));
  }
  let res;
  try {
    res = await axios.post(tokenUrl, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      timeout: TIMEOUT_MS,
    });
  } catch (err) {
    throw tokenError(err, name, certificate);
  }
  const token = res?.data?.access_token;
  if (!token) throw new Error(`Microsoft Entra ID gave the credential '${name}' no access token`);
  // step 2 : kept until shortly before it expires
  const lifetime = Number(res.data.expires_in) > 0 ? Number(res.data.expires_in) : 3599;
  tokenCache.set(cacheKey, { token, expiresAt: now + lifetime * 1000 });
  logger.debug(`Got a Microsoft Entra ID token for the credential '${name}' (${certificate ? "certificate" : "client secret"})`);
  return token;
}

// ─── sending ──────────────────────────────────────────────────────────────────

/**
 * The addresses of a mail : a comma separated text or a list, empty ones left out.
 *
 * Args:
 *   to (string|string[]): the recipients.
 *
 * Returns:
 *   string[]: the addresses.
 */
function recipientsOf(to) {
  const list = Array.isArray(to) ? to : String(to ?? "").split(/[,;]/);
  return list.map((a) => String(a).trim()).filter(Boolean);
}

/**
 * Sends a mail through Microsoft Graph : POST {graph}/v1.0/users/{sender}/sendMail, answered 202.
 *
 * Args:
 *   config (object): the mail config (toMailConfig) : mail_from and entra.
 *   to (string|string[]): the recipients.
 *   subject (string): the subject.
 *   html (string): the body (HTML).
 *
 * Returns:
 *   Promise<string>: Graph's request id, or "accepted".
 *
 * Raises:
 *   Error: no token, or Graph refused (graphError).
 */
export async function sendThroughGraph(config, to, subject, html) {
  const from = senderAddress(config.mail_from);
  const name = config.entra?.name || "";
  if (!from) throw new Error("A mail channel sending through Microsoft Graph needs its sender address (the mailbox it sends as)");
  const token = await getAccessToken(config.entra, scopeFor("graph"));
  const url = `${stripTrailingSlashes(entraEnv("ENTRA_GRAPH_URI"))}/v1.0/users/${encodeURIComponent(from)}/sendMail`;
  const body = {
    message: {
      subject: String(subject ?? ""),
      body: { contentType: "HTML", content: String(html ?? "") },
      toRecipients: recipientsOf(to).map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: false,
  };
  let res;
  try {
    res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: TIMEOUT_MS,
    });
  } catch (err) {
    throw graphError(err, from, name);
  }
  if (res.status !== 202) throw new Error(`Microsoft Graph answered ${res.status} to sendMail instead of 202`);
  return res.headers?.["request-id"] || "accepted";
}

/**
 * Sends a mail with SMTP and OAuth2 (XOAUTH2) : always to smtp.office365.com:587 with STARTTLS,
 * signed in as the sender mailbox with the app's token. The token is Exchange Online's : it is
 * never handed to another server, whatever mail_server the config carries.
 *
 * Args:
 *   config (object): the mail config (toMailConfig) : mail_from and entra (its mail_server,
 *     mail_port and mail_secure are not used).
 *   to (string|string[]): the recipients.
 *   subject (string): the subject.
 *   html (string): the body (HTML).
 *
 * Returns:
 *   Promise<string>: the message id.
 *
 * Raises:
 *   Error: no token, or the SMTP server refused (smtpError).
 */
export async function sendThroughSmtp(config, to, subject, html) {
  const from = senderAddress(config.mail_from);
  const name = config.entra?.name || "";
  if (!from) throw new Error("A mail channel sending through SMTP with OAuth2 needs its sender address (the mailbox it signs in to)");
  const accessToken = await getAccessToken(config.entra, scopeFor("smtp"));
  // Exchange Online's server only : a server of the channel's own would get the token
  const secure = !!OFFICE365_SMTP.secure;
  const transporter = nodemailer.createTransport({
    host: OFFICE365_SMTP.server,
    port: OFFICE365_SMTP.port,
    secure,
    // port 587 : STARTTLS, never a login in clear
    requireTLS: !secure,
    auth: { type: "OAuth2", user: from, accessToken },
  });
  try {
    const info = await transporter.sendMail({ from: config.mail_from, to: recipientsOf(to).join(","), subject, html });
    return info?.messageId || "No messageId";
  } catch (err) {
    throw smtpError(err, from, name);
  }
}

/**
 * Sends a mail through Microsoft 365, the way the channel says (config.mail_provider).
 *
 * Args:
 *   config (object): the mail config (toMailConfig) ; mail_provider graph or smtp_oauth2.
 *   to (string|string[]): the recipients.
 *   subject (string): the subject.
 *   html (string): the body (HTML).
 *
 * Returns:
 *   Promise<string>: the message id, or Graph's request id.
 *
 * Raises:
 *   Error: it could not be sent (the reason, without secrets).
 */
export async function sendMicrosoftMail(config, to, subject, html) {
  return config.mail_provider === "smtp_oauth2" ? sendThroughSmtp(config, to, subject, html) : sendThroughGraph(config, to, subject, html);
}

export default { sendMicrosoftMail, getAccessToken, clientAssertion, clearTokenCache };
