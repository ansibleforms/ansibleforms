/******************************************************************/
/*                                                                */
/*  The RTE socket's protocol (contract 3) : one WebSocket per    */
/*  RTE, opened by the RTE (outbound) or by the controller (inbound),    */
/*  the same messages both ways whoever dialed. JSON text frames, */
/*  { t: <type>, ... }.                                           */
/*                                                                */
/*  RTE -> app                                                    */
/*    hello    who it is : id, version, contract, ansible,        */
/*             capacity, the jobs it runs and the ones it still   */
/*             has items for                                      */
/*    health   every 20 s : the jobs it runs, its free slots      */
/*    claimed  it took a job ; refused : it did not (busy, ...)   */
/*    item     one numbered item of a job : output, events, log,  */
/*             started, exited, end, abandon ; kept on its disk   */
/*             until the controller acks it, resent after a reconnect    */
/*    fetch    the files of a job it has not cached (a hash)      */
/*                                                                */
/*  app -> RTE                                                    */
/*    welcome  the hello accepted                                 */
/*    run      a job : what it used to read in the database, its  */
/*             secrets sealed for it, and its files' hashes       */
/*    cancel   stop a job                                         */
/*    ack      the items of a job stored, up to a number          */
/*    file     a chunk of the files asked for (base64)            */
/*                                                                */
/******************************************************************/

import { createHash, X509Certificate } from "crypto";

// the contract of a socket-mode RTE ; a database-mode RTE speaks rte/contract.js's
export const SOCKET_CONTRACT = 3;

/**
 * A token's fingerprint : the first 8 hexadecimal digits of its SHA-256, as abcd-ef12. The RTE
 * logs it, the installer prints it and the Runners page shows it on a runner waiting for
 * approval, so an admin can tell it is the RTE they started without seeing the token.
 *
 * Args:
 *   token (string): the RTE's token.
 *
 * Returns:
 *   string: the fingerprint.
 */
export function fingerprint(token) {
  const hex = createHash("sha256").update(String(token || "")).digest("hex");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

// ─── an inbound RTE's certificate (HTTPS=1, an https RTE_URL) ─────────────────
// It sends its certificate (HTTPS_CERT, PEM) in its registration call, field `cert` ; the controller
// keeps it as the ca_bundle of the runner's credential (ignore_certs off) and dials it pinned to
// that certificate (runners/common.js getHttpsAgent, pin).

// the largest certificate file taken (a leaf and its chain fit well under it)
export const CERT_MAX_BYTES = 32 * 1024;
// the certificates in one file, at most
const CERT_MAX_BLOCKS = 8;

/**
 * Reads a PEM file of certificates (a leaf, maybe its chain) : every block parsed, nothing else
 * kept, so what is stored is certificates only.
 *
 * Args:
 *   pem (string|Buffer): the file's text.
 *
 * Returns:
 *   object: { pem : the certificates, as PEM, one after the other ; certs : X509Certificate[] }.
 *
 * Raises:
 *   Error: too large, no certificate in it, too many, or one that cannot be read.
 */
export function parseCertBundle(pem) {
  const text = Buffer.isBuffer(pem) ? pem.toString("utf8") : String(pem ?? "");
  if (Buffer.byteLength(text) > CERT_MAX_BYTES) throw new Error(`the certificate is larger than ${CERT_MAX_BYTES / 1024} KB`);
  // the certificate blocks, each from its BEGIN line to the END after it (read by position : a
  // pattern with a lazy body backtracks badly on a text of many BEGIN lines)
  const BEGIN = "-----BEGIN CERTIFICATE-----";
  const END = "-----END CERTIFICATE-----";
  const blocks = [];
  for (let at = text.indexOf(BEGIN); at !== -1; at = text.indexOf(BEGIN, at)) {
    const end = text.indexOf(END, at + BEGIN.length);
    if (end === -1) break;
    blocks.push(text.slice(at, end + END.length));
    at = end + END.length;
  }
  if (!blocks.length) throw new Error("no PEM certificate (-----BEGIN CERTIFICATE-----) in it");
  if (blocks.length > CERT_MAX_BLOCKS) throw new Error(`more than ${CERT_MAX_BLOCKS} certificates in it`);
  const certs = blocks.map((b, i) => {
    try {
      return new X509Certificate(b);
    } catch (e) {
      throw new Error(`certificate ${i + 1} cannot be read: ${e.message}`, { cause: e });
    }
  });
  return { pem: certs.map((c) => c.toString().trim()).join("\n") + "\n", certs };
}

/**
 * A certificate's fingerprint, as a token's : the first 8 hexadecimal digits of the SHA-256 of
 * its first certificate (the leaf), as abcd-ef12. The RTE logs it at its start, and the Runners
 * page can show it on a runner waiting for approval (pending_info.cert_fingerprint), so an admin
 * can tell it is the certificate of the RTE they started.
 *
 * Args:
 *   pem (string|Buffer): the certificate (its file).
 *
 * Returns:
 *   string|null: the fingerprint, null when it is not a certificate.
 */
export function certFingerprint(pem) {
  try {
    const hex = parseCertBundle(pem).certs[0].fingerprint256.replace(/:/g, "").toLowerCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
  } catch {
    return null;
  }
}

/**
 * The address an RTE listens on (LISTEN_HOST) : every interface when it is not set, as before ;
 * 127.0.0.1 keeps a native outbound RTE's probes and metrics on its own host. Read each time an
 * RTE starts (rte/server.js, rte/socket/rte-socket.js).
 *
 * Args:
 *   env (object): the environment (process.env ; the tests set it).
 *
 * Returns:
 *   string|undefined: the host, undefined for every interface.
 */
export function listenHost(env = process.env) {
  return String(env.LISTEN_HOST || "").trim() || undefined;
}

// where the controller takes an RTE's socket (under BASE_URL), and where an inbound RTE takes the controller's
export const APP_SOCKET_PATH = "/api/v2/rte/socket";
export const RTE_SOCKET_PATH = "/rte/v1/socket";

// the modes an RTE runs in (RTE_MODE)
export const MODES = ["outbound", "inbound", "database"];
// the modes that talk over this socket (a runner's rte_mode) ; database is the deprecated one
export const SOCKET_MODES = ["outbound", "inbound"];

// ─── the controller's side : how long a job waits for an RTE ─────────────────────────
// (runners/rte.js and runners/rteHub.js both follow these ; kept here, where nothing is imported)

/**
 * How long a job waits for a free RTE (RTE_QUEUE_MINUTES, 60 by default, 0 : for ever), read
 * each time so a change applies without a restart.
 *
 * Returns:
 *   number: the minutes.
 */
export const queueMinutes = () => Math.max(0, parseInt(process.env.RTE_QUEUE_MINUTES ?? 60, 10) || 0);
// how often a job an RTE refused as busy is offered again
export const RETRY_MS = 10000;

// why a socket was closed : the reason goes with it, for the log on the other side
export const CLOSE = {
  // the token, the name or the join token was refused
  UNAUTHORIZED: 4401,
  // the RTE's id (its hello) is another node's, or the RTE of another runner uses it
  ID_TAKEN: 4403,
  // the other side speaks another contract
  CONTRACT: 4409,
  // a newer socket of the same RTE took over (it reconnected, to this node or another)
  REPLACED: 4000,
  // this node no longer holds the RTE's lease
  LEASE_LOST: 4001,
  // a message that could not be read
  PROTOCOL: 4002,
  // the process stops
  GOING_AWAY: 1001,
};

// the closes and the refusals of the handshake (HTTP status) that dialing again soon will not
// change : the runner was rejected or removed, the token or the join token refused, a runner of
// that name approved already (409). An outbound RTE waits REFUSED_REDIAL_MS before it dials
// again, not its usual 1 to 30 seconds : an admin has to act first. An id taken (ID_TAKEN) is
// not one of them : it frees itself once the node that had it stops answering
export const REFUSED_CLOSES = [CLOSE.UNAUTHORIZED];
export const REFUSED_STATUSES = [401, 403, 409];
export const REFUSED_REDIAL_MS = 10 * 60 * 1000;
// another contract (CONTRACT) : the controller or the RTE is being upgraded, and the other side
// usually follows within minutes. A short wait, not REFUSED_REDIAL_MS : a rolling upgrade must
// not leave an RTE offline for ten minutes after its app came back
export const CONTRACT_REDIAL_MS = 60 * 1000;

// a ping every 20 s keeps proxies from closing an idle socket ; nothing heard for 60 s : gone
export const PING_MS = 20000;
export const DEAD_MS = 60000;
// a job's items in flight, not acked yet, at most : beyond it the RTE waits for acks
export const WINDOW = 64;
// the size of a file chunk, before base64
export const CHUNK_BYTES = 256 * 1024;
// a message's size at most (a batch of output is 64 KB, a file chunk 256 KB, both in base64/JSON)
export const MAX_PAYLOAD = 8 * 1024 * 1024;

/**
 * Writes a message as a frame.
 *
 * Args:
 *   msg (object): the message, with its type in t.
 *
 * Returns:
 *   string: the frame's text.
 */
export function encode(msg) {
  return JSON.stringify(msg);
}

/**
 * Reads a frame.
 *
 * Args:
 *   data (string|Buffer): the frame.
 *
 * Returns:
 *   object|null: the message, null when it is not one (no type).
 */
export function decode(data) {
  try {
    const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    return msg && typeof msg === "object" && typeof msg.t === "string" ? msg : null;
  } catch {
    return null;
  }
}

/**
 * The address an outbound RTE dials : the controller's address as people know it (CONTROLLER_URL,
 * https://forms.example.com, with its BASE_URL if any) as a WebSocket address to its socket.
 *
 * Args:
 *   appUrl (string): the controller's address (http or https ; ws and wss are taken as they are).
 *
 * Returns:
 *   string: the socket's address (wss://forms.example.com/api/v2/rte/socket).
 *
 * Raises:
 *   Error: not an address.
 */
export function socketUrl(appUrl) {
  const url = new URL(String(appUrl || "").trim());
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error(`CONTROLLER_URL must be an http or https address, not ${appUrl}`);
  const base = url.pathname.replace(/\/+$/, "");
  // the socket's own path given already : kept
  url.pathname = base.endsWith(APP_SOCKET_PATH) ? base : base + APP_SOCKET_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The address the controller dials for an inbound RTE : its runner's address (RTE_URL, as today) as a
 * WebSocket address to its socket.
 *
 * Args:
 *   uri (string): the runner's address (http://rte:8000).
 *
 * Returns:
 *   string: the socket's address (ws://rte:8000/rte/v1/socket).
 */
export function inboundUrl(uri) {
  const url = new URL(String(uri || "").trim());
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.pathname = url.pathname.replace(/\/+$/, "") + RTE_SOCKET_PATH;
  return url.toString();
}

export default { SOCKET_CONTRACT, APP_SOCKET_PATH, RTE_SOCKET_PATH, MODES, SOCKET_MODES, queueMinutes, RETRY_MS, CLOSE, PING_MS, DEAD_MS, WINDOW, CHUNK_BYTES, MAX_PAYLOAD, encode, decode, socketUrl, inboundUrl };
