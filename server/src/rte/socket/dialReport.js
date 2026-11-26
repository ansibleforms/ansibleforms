/******************************************************************/
/*                                                                */
/*  Why a socket between the controller and an RTE could not be opened,  */
/*  in plain words, and how often the log says it. An outbound    */
/*  RTE dials the controller (rte/socket/rte-socket.js), the controller dials   */
/*  an inbound RTE (runners/rteHub.js) : a name that does not     */
/*  resolve, nothing listening, a certificate not trusted, a      */
/*  proxy or the other side refusing the handshake each get a     */
/*  warning with a hint, at the default log level.                */
/*                                                                */
/*  Without flooding : the first failure and every change of      */
/*  cause are said at once, the same cause again at most once     */
/*  every DIAL_REPEAT_MS while it lasts, and the socket opening   */
/*  after failures is said once.                                  */
/*                                                                */
/******************************************************************/

// the same cause, still there, is said again at most this often
export const DIAL_REPEAT_MS = 5 * 60 * 1000;

// the codes Node gives a certificate it does not trust (no chain to a known authority)
const UNTRUSTED_CODES = [
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
];
// the codes of a certificate out of its dates
const EXPIRED_CODES = ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"];

/**
 * An address as the log may show it : no user and password, no query (a token could be in
 * either), no fragment.
 *
 * Args:
 *   url (string): the address.
 *
 * Returns:
 *   string: the address without its credentials, or "?" when it is not one.
 */
export function safeUrl(url) {
  try {
    const u = new URL(String(url || ""));
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "?";
  }
}

/**
 * A text as the log may show it : the credentials of an address in it (a proxy's
 * user:password@) and the given secrets replaced with ***.
 *
 * Args:
 *   text (string): the text (an error's message, the body of a refusal).
 *   secrets (string[]): the values never to show (RTE_TOKEN, a join token).
 *
 * Returns:
 *   string: the text, scrubbed.
 */
export function scrub(text, secrets = []) {
  let out = String(text ?? "").replace(/\/\/[^/\s@]+@/g, "//***@");
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join("***");
  }
  return out;
}

/**
 * What the other side said when it refused the handshake : the error of its JSON body, else
 * the body's first line, cut at 200 characters.
 *
 * Args:
 *   body (string): the body of the refusal.
 *
 * Returns:
 *   string: the reason, "" when there is none.
 */
function refusalText(body) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === "string") return parsed.error.slice(0, 200);
    if (parsed && typeof parsed.message === "string") return parsed.message.slice(0, 200);
  } catch {
    // not JSON : its text below
  }
  // an HTML page of a proxy : its text without the tags
  return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Why a dial failed, in plain words : the cause (a short key, the same for the same failure,
 * so its repeats can be told apart from a change) and the text the log shows, with a hint
 * for the common ones.
 *
 * Args:
 *   failure (object): { error : the socket's error (with its code), or status : the HTTP
 *     status the handshake was refused with and body : its body ; neither : it closed before
 *     it opened, with code : the close code }.
 *   opts (object): { side : "app" when an RTE dials the controller (outbound), "rte" when the controller
 *     dials an inbound RTE ; url : the address dialed ; proxy : true when it went through
 *     HTTPS_PROXY ; secrets : the values never to show }.
 *
 * Returns:
 *   object: { cause : string, text : string }.
 */
export function describeDialFailure(failure = {}, { side = "app", url = "", proxy = false, secrets = [] } = {}) {
  const outbound = side === "app";
  let host = "?";
  try {
    host = new URL(url).host;
  } catch {
    // an address that is not one : "?"
  }
  const say = (cause, text) => ({ cause, text: scrub(text, secrets) });

  // ─── the other side (or a proxy before it) answered, but not with a socket ───
  if (failure.status) {
    const status = Number(failure.status);
    const why = refusalText(failure.body);
    const said = `HTTP ${status}${why ? `: ${why}` : ""}`;
    if (status === 401) {
      return say(`http-${status}`, outbound
        ? `the controller refused this runner's token (${said}): check RTE_TOKEN against its runner's token, or RTE_JOIN_TOKEN for a first join`
        : `the runner refused the controller's token (${said}): its RTE_TOKEN is not the token of its runner's credential`);
    }
    if (status === 403) {
      return say(`http-${status}`, outbound
        ? `the controller refused this runner (${said}): its runner may be rejected or removed under Connections > Runners`
        : `the runner refused the socket (${said})`);
    }
    if (status === 404) {
      return say(`http-${status}`, outbound
        ? `no runner socket at this address (${said}): CONTROLLER_URL must be the controller's address as people open it, with its BASE_URL path if any, and a proxy in front must pass it on`
        : `no runner socket at this address (${said}): the runner's address (RTE_URL) must be the runner itself, and a proxy in front must pass /rte/v1/socket on`);
    }
    if (status === 407) {
      return say(`http-${status}`, `the proxy wants credentials (${said}): give them in HTTPS_PROXY (http://user:password@proxy:port)`);
    }
    if (status === 409) {
      return say(`http-${status}`, outbound
        ? `the controller refused this runner (${said}): a runner of that name (RTE_NAME) exists already or waits for approval`
        : `the runner refused the socket (${said})`);
    }
    if (status === 400 || status === 426) {
      return say(`http-${status}`, `the socket was not let through (${said}): a proxy or load balancer in front must pass WebSocket upgrades`);
    }
    if (status === 502 || status === 503 || status === 504) {
      return say(`http-${status}`, `a proxy or load balancer answered instead (${said}): it cannot reach the ${outbound ? "app" : "runner"} behind it, or does not pass WebSocket upgrades`);
    }
    return say(`http-${status}`, `the ${outbound ? "app" : "runner"} refused the socket (${said})`);
  }

  const err = failure.error;
  if (!err) return say(`close-${failure.code ?? "?"}`, `the socket closed before it opened (${failure.code ?? "?"})`);
  const code = String(err.code || "");
  const message = String(err.message || err);
  const via = proxy ? " (through the proxy, HTTPS_PROXY)" : "";

  // ─── the certificate ───
  if (UNTRUSTED_CODES.includes(code)) {
    return say(`tls-${code}`, outbound
      ? `the controller's certificate is not trusted (${code}: ${message}): name its CA with NODE_EXTRA_CA_CERTS (a PEM file), or set CONTROLLER_TLS_VERIFY=0 inside one trusted network`
      : `the runner's certificate is not trusted (${code}: ${message}): it is not the one the runner registered with (restart the runner so it registers again), or put its CA in the runner's credential`);
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return say(`tls-${code}`, outbound
      ? `the controller's certificate is not for ${host} (${message}): CONTROLLER_URL must use a name the certificate holds, or set CONTROLLER_TLS_VERIFY=0 inside one trusted network`
      : `the runner's certificate is not for ${host} (${message}): the runner's address (RTE_URL) must use a name the certificate holds`);
  }
  if (EXPIRED_CODES.includes(code)) {
    return say(`tls-${code}`, `the ${outbound ? "app" : "runner"}'s certificate is out of its dates (${code}: ${message}): renew it, and check the clocks`);
  }
  if (/^ERR_SSL_|^ERR_TLS_|^EPROTO$/.test(code) || /SSL routines|wrong version number/i.test(message)) {
    return say(`tls-${code || "other"}`, `the TLS handshake failed${via} (${code ? `${code}: ` : ""}${message}): an https address to a port that speaks plain http (or the other way round)?`);
  }

  // ─── the network ───
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return say(`dns-${code}`, `the name ${err.hostname || host} does not resolve${via} (${code}): check the ${outbound ? "CONTROLLER_URL" : "runner's address (RTE_URL)"} host and this container's DNS`);
  }
  if (code === "ECONNREFUSED") {
    return say(`net-${code}`, `nothing listens at ${err.address ? `${err.address}:${err.port}` : host}${via} (${code}): is the ${proxy ? "proxy" : outbound ? "app" : "runner"} running, on that port?`);
  }
  if (["EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EPIPE"].includes(code)) {
    return say(`net-${code}`, `the network did not get through to ${host}${via} (${code}: ${message}): a firewall, a route or a proxy in the way?`);
  }
  if (/handshake has timed out/i.test(message)) {
    return say("net-timeout", `no answer from ${host}${via} in time (${message}): a firewall dropping the traffic, or a proxy holding the upgrade?`);
  }
  return say(`other-${code || message.slice(0, 60)}`, `${code ? `${code}: ` : ""}${message}${via}`);
}

/**
 * How often the log says that a socket could not be opened : the first failure and every
 * change of cause at once, the same cause again at most once every repeatMs while it lasts,
 * and the socket opening after failures once. One per dialed address (an outbound RTE has one,
 * the controller one per inbound runner).
 */
export class DialReport {
  /**
   * Args:
   *   opts (object): { repeatMs : the least time between two logs of the same cause,
   *     DIAL_REPEAT_MS by default ; now : the clock, Date.now by default }.
   */
  constructor({ repeatMs = DIAL_REPEAT_MS, now = () => Date.now() } = {}) {
    this.repeatMs = repeatMs;
    this.now = now;
    // the cause of the failures in a row, null when the last dial opened
    this.cause = null;
    // the failures in a row (any cause), when the first of them came, and when the log last spoke
    this.failures = 0;
    this.since = 0;
    this.loggedAt = 0;
  }

  /**
   * A dial failed.
   *
   * Args:
   *   cause (string): its cause (describeDialFailure().cause).
   *
   * Returns:
   *   object: { log : true when the log says it now, repeated : true when it is the same cause
   *     as the failure before, failures : the failures in a row, since : when the first of them
   *     came (ms) }.
   */
  failed(cause) {
    const now = this.now();
    if (!this.failures) this.since = now;
    this.failures++;
    const changed = cause !== this.cause;
    const repeated = !changed;
    let log = false;
    if (changed || now - this.loggedAt >= this.repeatMs) {
      log = true;
      this.loggedAt = now;
    }
    this.cause = cause;
    return { log, repeated, failures: this.failures, since: this.since };
  }

  /**
   * A dial opened.
   *
   * Returns:
   *   object|null: { failures : the failures in a row before it, since : when the first came
   *     (ms) } when there were any (the log says it is back), null when there were none.
   */
  connected() {
    const back = this.failures ? { failures: this.failures, since: this.since } : null;
    this.cause = null;
    this.failures = 0;
    this.since = 0;
    this.loggedAt = 0;
    return back;
  }
}

/**
 * How long ago, in words : "42 seconds", "7 minutes", "3 hours".
 *
 * Args:
 *   ms (number): the time.
 *
 * Returns:
 *   string
 */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} seconds`;
  if (s < 7200) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

/**
 * The line the log shows for a failed dial, or null when it stays quiet (the same cause said
 * less than repeatMs ago).
 *
 * Args:
 *   report (DialReport): the dialed address's report.
 *   why (object): describeDialFailure()'s { cause, text }.
 *   prefix (string): who dials what ("RTE 'x': cannot reach the controller at wss://...").
 *
 * Returns:
 *   string|null
 */
export function failureLine(report, why, prefix) {
  const r = report.failed(why.cause);
  if (!r.log) return null;
  const still = r.repeated ? ` (still, ${r.failures} failed dials in ${ago(report.now() - r.since)})` : "";
  return `${prefix}: ${why.text}${still}`;
}

export default { DIAL_REPEAT_MS, safeUrl, scrub, describeDialFailure, DialReport, ago, failureLine };
