// The RTE in a socket mode (RTE_MODE=outbound or inbound) : it talks only to the controller, over one
// WebSocket, and holds no database credentials. Outbound it dials the controller (CONTROLLER_URL) and keeps
// the socket, redialing when it drops ; inbound it listens and the controller dials it (RTE_URL, as the
// network of a database-mode RTE). Either way the same messages go both ways (protocol.js) :
// the controller sends "run job N" with everything the RTE used to read in the database, the RTE runs
// it (rte/ansible-core.js) and sends its output, events, log and end back as numbered items,
// kept on its disk until the controller acks them (spool.js).
//
// It imports no database module : rte/ansible-core.js reads and writes through the socket's
// job I/O below.
import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import WebSocket, { WebSocketServer } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import logger from "../../lib/logger.js";
import httpsConfig from "../../../config/https.config.js";
import appConfig from "../../../config/app.config.js";
import ansibleConfig from "../../../config/ansible.config.js";
import { nodeId } from "../../lib/role.js";
import { appVersion as version } from "../../lib/version.js";
import { openJobSecrets } from "../../lib/sealedSecrets.js";
import { collectSecrets, registerJobSecrets, maskOutput } from "../../lib/outputMask.js";
import { installFatalHandlers } from "../../lib/fatal.js";
import { safeEqual, bearerToken } from "../../lib/safeEqual.js";
import { requestContext } from "../../lib/requestContext.js";
import { httpMetrics, metricsHandler, addScrapeGauge } from "../../lib/metrics.js";
import { onShutdown, stopWithin, isStopping } from "../../lib/shutdown.js";
import { httpServerOptions } from "../../lib/httpServerOptions.js";
import Repo from "../../models/repo.model.js";
import { runAnsibleJob, useJobIO } from "../ansible-core.js";
import { Session } from "./session.js";
import { DialReport, describeDialFailure, failureLine, safeUrl, scrub, ago } from "./dialReport.js";
import { JobSpool } from "./spool.js";
import { FileCache } from "./files.js";
import { RTE_SETTINGS, parseSetting, settingsOfEnv, effectiveSettings, envSettingWarnings } from "./settings.js";
import {
  SOCKET_CONTRACT, RTE_SOCKET_PATH, CLOSE, WINDOW, MAX_PAYLOAD, REFUSED_CLOSES, REFUSED_STATUSES, REFUSED_REDIAL_MS,
  CONTRACT_REDIAL_MS,
  socketUrl, fingerprint, certFingerprint, listenHost, parseCertBundle,
} from "./protocol.js";
import { controllerUrl, controllerTlsVerify } from "../../lib/controllerEnv.js";

// ─── settings ─────────────────────────────────────────────────────────────────

// what the controller sent from the runner's page (a settings message) : it wins over the same variable
// set on this RTE, which is the fallback of an empty field
let fromRunner = {};
// the settings in effect : { maxJobs, cacheMb, files, drainSeconds } (rte/socket/settings.js)
const settings = () => effectiveSettings(settingsOfEnv(), fromRunner);
const maxJobs = () => settings().maxJobs;
const drainSeconds = () => settings().drainSeconds;
// the persistent folder (server/persistent, /app/dist/persistent in the image)
const PERSISTENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../persistent");
// where the items wait for the controller's ack, and where the job files the controller sent are kept
const spoolDir = () => process.env.RTE_SPOOL_PATH || path.join(PERSISTENT, "rte-spool");
const cacheDir = () => process.env.RTE_CACHE_PATH || path.join(PERSISTENT, "rte-files");
// transfer : the controller sends the job's files ; local : the RTE runs from its own folders (mounts)
const filesMode = () => settings().files;
// the name the RTE joins as (its runner under Connections > Runners) : RTE_NAME, else its node id
const rteName = () => String(process.env.RTE_NAME || "").trim() || nodeId;
// the certificate shipped in the image (config/https.config.js copies it when none is mounted) :
// its private key is public, pinning it proves nothing
const TEMPLATE_CERT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../templates/seed/cert.pem.template");

/**
 * The certificate an inbound RTE sends when it registers (field cert of the registration call),
 * so the controller dials it pinned to it : its HTTPS_CERT, when it serves HTTPS (HTTPS=1) and the
 * address the controller dials (RTE_URL) is https. Behind a proxy that ends TLS for it, the RTE runs
 * without HTTPS=1 and sends none : the controller checks the proxy's certificate as any other.
 *
 * Args:
 *   env (object): the environment (process.env ; the tests set it).
 *   tls (object): { https, httpsCert } (config/https.config.js ; the tests set it).
 *
 * A certificate file the controller would refuse (parseCertBundle : too large, too many certificates,
 * one that cannot be read) is not sent : the controller answers such a registration with a 400, which
 * the RTE takes as final, so the RTE never registered at all. Without it the RTE registers, a
 * warning says why nothing is pinned, and the controller checks the certificate as any other.
 *
 * Returns:
 *   string|null: the certificate (PEM, certificates only), null when none is sent.
 */
export function certToSend(env = process.env, tls = httpsConfig) {
  if (!tls?.https || !tls.httpsCert) return null;
  if (!/^https:\/\//i.test(String(env.RTE_URL || "").trim())) return null;
  const text = Buffer.isBuffer(tls.httpsCert) ? tls.httpsCert.toString("utf8") : String(tls.httpsCert);
  try {
    return parseCertBundle(text).pem;
  } catch (e) {
    // said once : certToSend runs on every registration attempt
    if (!certWarned) {
      certWarned = true;
      logger.warning(`Runner '${rteName()}': HTTPS_CERT is not sent to the controller (${e.message}): the controller does not pin it and checks this runner's certificate as any other`);
    }
    return null;
  }
}

// whether the certificate that cannot be sent was said already (certToSend)
let certWarned = false;

/**
 * Whether a certificate is the one shipped in the image (its private key is public).
 *
 * Args:
 *   pem (string): the certificate.
 *
 * Returns:
 *   boolean
 */
function isTemplateCert(pem) {
  try {
    return certFingerprint(pem) !== null && certFingerprint(pem) === certFingerprint(fs.readFileSync(TEMPLATE_CERT));
  } catch {
    return false;
  }
}

// ─── state ────────────────────────────────────────────────────────────────────

// jobId -> { spool, job, paths, files, dirs, folder, abort, pid, running }
const jobs = new Map();
// the socket to the controller, once welcomed
let session = null;
let welcomed = false;
let cache = null;
let mode = "outbound";
let ansible = null;
// the cancels of jobs this RTE does not run (yet) : jobId -> until when it is kept. The controller may
// ask to stop a job before its run message arrives (it claims the job in its database first) :
// the cancel is kept a minute and applied when the run comes, never dropped
const earlyCancels = new Map();
const EARLY_CANCEL_MS = 60000;
const EARLY_CANCEL_MAX = 1000;

/**
 * This RTE's capacity, in its hello and health : the controller sends no job to a full RTE.
 *
 * Returns:
 *   object: { maxJobs, running, free, cpus, memoryMb, freeMemoryMb, load }.
 */
function capacity() {
  const running = [...jobs.values()].filter((j) => j.running).length;
  const max = maxJobs();
  return {
    maxJobs: max,
    running,
    free: max ? Math.max(0, max - running) : null,
    cpus: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1048576),
    freeMemoryMb: Math.round(os.freemem() / 1048576),
    load: Math.round(os.loadavg()[0] * 100) / 100,
  };
}

/**
 * This RTE's settings, in its hello and health : the runner page shows them, and beside an empty
 * field the value a variable here gives it.
 *
 * Returns:
 *   object: { settings : those in effect, env : the values its variables set, by key }.
 */
function settingsReport() {
  return {
    settings: settings(),
    env: settingsOfEnv(),
  };
}

/**
 * Takes the settings the controller sends from the runner's page (settings) : the valid ones kept, the
 * cache size and the stop's wait applied at once, and the health sent so the page shows them.
 *
 * Args:
 *   msg (object): { settings : { maxJobs, cacheMb, files, drainSeconds }, an empty one the default }.
 */
function onSettings(msg) {
  const before = settings();
  const next = {};
  for (const s of RTE_SETTINGS) {
    const v = parseSetting(s, msg?.settings?.[s.key]);
    if (v !== undefined) next[s.key] = v;
  }
  fromRunner = next;
  const now = settings();
  cache?.setMaxBytes(now.cacheMb * 1048576);
  stopWithin((now.drainSeconds + 8) * 1000);
  const changed = RTE_SETTINGS.filter((s) => before[s.key] !== now[s.key]).map((s) => `${s.key} ${now[s.key]}`);
  if (changed.length) logger.notice(`Runner '${rteName()}': settings from its runner: ${changed.join(", ")}`);
  sendHealth();
}

/** the health to the controller : what it runs, its free slots and its settings */
function sendHealth() {
  if (welcomed) session?.send({ t: "health", capacity: capacity(), running: [...jobs.entries()].filter(([, e]) => e.running).map(([id]) => id), stopping: isStopping(), ...settingsReport() });
}

/**
 * The ansible-core version, for the hello.
 *
 * Returns:
 *   Promise<string|null>
 */
function ansibleVersion() {
  return new Promise((resolve) => {
    execFile("ansible-playbook", ["--version"], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/)[0];
      resolve((/\[core\s+([^\]]+)\]/.exec(first) || [])[1] || first.trim());
    });
  });
}

// ─── items to the controller ─────────────────────────────────────────────────────────

/**
 * Sends a job's items not sent yet, within the window of items not acked.
 *
 * Args:
 *   jobId (number): the job.
 */
function pump(jobId) {
  const entry = jobs.get(jobId);
  if (!entry || !session || !welcomed) return;
  const sp = entry.spool;
  while (sp.next <= sp.seq && sp.next - sp.acked <= WINDOW) {
    const item = sp.get(sp.next);
    sp.next++;
    if (item && !session.send({ t: "item", jobId, item })) {
      sp.rewind();
      return;
    }
  }
}

/**
 * Adds an item to a job's spool and sends it.
 *
 * Args:
 *   jobId (number): the job.
 *   item (object): { kind, ... }.
 */
function emit(jobId, item) {
  const entry = jobs.get(jobId);
  if (!entry) throw new Error(`job ${jobId} is not on this runner`);
  entry.spool.append(item);
  pump(jobId);
}

// ─── the job's I/O over the socket (rte/ansible-core.js) ──────────────────────

/**
 * Where a playbooks repository's playbooks are on this RTE (local files) : its playbooks
 * folder when it has one, else its root ; ANSIBLE_PATH without a repository.
 *
 * Args:
 *   repo (string|null): the repository used for playbooks, as the controller said.
 *
 * Returns:
 *   string: the folder.
 */
function localPlaybookRoot(repo) {
  if (!repo) return ansibleConfig.path;
  const folder = Repo.folderOf(repo);
  const sub = path.join(folder, "playbooks");
  return fs.existsSync(sub) ? sub : folder;
}

/**
 * A value with every text in it masked (the job's secrets replaced), its shape kept : an event
 * carries a host's whole result, where a secret may sit at any depth.
 *
 * Args:
 *   jobId (number): the job.
 *   value (any): the value (an event, a list of them, a text, a number).
 *
 * Returns:
 *   any: the value, masked.
 */
function maskDeep(jobId, value) {
  if (typeof value === "string") return maskOutput(jobId, value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(jobId, v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(jobId, v)]));
  }
  return value;
}

const socketJobIO = {
  mode: "socket",
  async load(jobId) {
    const entry = jobs.get(jobId);
    if (!entry) return null;
    return { form: entry.job?.form || "", extravars: entry.job?.extravars ?? {}, lastOrder: Number(entry.job?.lastOrder) || 0 };
  },
  // the controller masks what it stores ; this keeps the credentials' secrets out of the spool too
  async registerOutputSecrets(jobId, { credentials = {} } = {}) {
    registerJobSecrets(jobId, collectSecrets(credentials));
  },
  async playbookDirectory(jobId, playbookSubPath = "") {
    const entry = jobs.get(jobId);
    // a form naming its repository (playbookRoot) : that repository's root, sent or cloned here
    if (entry?.paths?.playbookRoot) {
      const repo = entry.paths.playbookRepo;
      const root = entry.dirs?.playbooks || (entry.dirs ? null : Repo.folderOf(repo));
      if (!root || !fs.existsSync(root)) throw new Error(`playbookRepository '${repo}' is not a repository used for playbooks`);
      return playbookSubPath ? path.join(root, playbookSubPath) : root;
    }
    const root = entry?.dirs?.playbooks || localPlaybookRoot(entry?.paths?.playbookRepo || null);
    return playbookSubPath ? path.join(root, playbookSubPath) : root;
  },
  async inventoryRoots(jobId) {
    const entry = jobs.get(jobId);
    if (entry?.dirs?.inventories) return entry.dirs.inventories;
    const repos = (entry?.paths?.inventoryRepos || []).filter((n) => Repo.isValidName(n));
    return [{ repository: null, root: appConfig.inventoryPath }, ...repos.map((n) => ({ repository: n, root: Repo.folderOf(n) }))];
  },
  async writeOutput(jobId, record) {
    emit(jobId, { kind: "output", record: { ...record, output: maskOutput(jobId, record.output) } });
  },
  // masked before the spool, as the output and the log : no secret on this RTE's disk
  async writeEvents(jobId, events) {
    emit(jobId, { kind: "events", events: maskDeep(jobId, events) });
  },
  async setJobLog(jobId, content) {
    emit(jobId, { kind: "log", content: maskOutput(jobId, content) });
  },
  async started(jobId, pid, host) {
    const entry = jobs.get(jobId);
    if (entry) entry.pid = pid;
    emit(jobId, { kind: "started", pid, host });
  },
  async exited(jobId) {
    const entry = jobs.get(jobId);
    if (entry) entry.pid = null;
    emit(jobId, { kind: "exited" });
  },
  async isAbortRequested(jobId) {
    return !!jobs.get(jobId)?.abort;
  },
  async resetAbortRequested(jobId) {
    const entry = jobs.get(jobId);
    if (entry) entry.abort = false;
  },
  async end(jobId, order, stream, status, message, artifacts = {}) {
    emit(jobId, { kind: "end", order, stream, status, message: maskOutput(jobId, message), artifacts });
  },
};

// ─── messages from the controller ────────────────────────────────────────────────────

/**
 * The files a job runs from, sent by the controller : fetched when not cached, unpacked in a private
 * folder of the job's own (entry.folder, removed when it ends), and their folders set on the job.
 *
 * Args:
 *   jobId (number): the job.
 *   entry (object): the job.
 *
 * Returns:
 *   Promise<void>
 */
async function ensureFiles(jobId, entry) {
  const files = entry.files || {};
  if (filesMode() !== "transfer" || (!files.playbooks && !files.inventories?.length)) return;
  const ask = (hash) => !!session?.send({ t: "fetch", hash });
  entry.folder = cache.jobFolder(jobId);
  const dirs = {};
  if (files.playbooks?.hash) dirs.playbooks = await cache.checkout(files.playbooks.hash, ask, path.join(entry.folder, "playbooks"));
  if (files.inventories?.length) {
    dirs.inventories = [];
    for (const [i, inv] of files.inventories.entries()) {
      const root = await cache.checkout(inv.hash, ask, path.join(entry.folder, `inventory-${i}`));
      dirs.inventories.push({ repository: inv.repository ?? null, root });
    }
  }
  entry.dirs = dirs;
}

/**
 * Takes a job from the controller (run) : refused when busy, stopping or of another contract, else
 * claimed and run in the background.
 *
 * Args:
 *   msg (object): { jobId, contract, sealed, job, paths, files }.
 */
async function onRun(msg) {
  const jobId = parseInt(msg.jobId, 10);
  const refuse = (error, busy = false) => session?.send({ t: "refused", jobId, error, busy });
  if (!Number.isInteger(jobId) || jobId <= 0) return refuse("jobId is required");
  if (msg.contract !== SOCKET_CONTRACT) return refuse(`this runner speaks contract ${SOCKET_CONTRACT}, the controller sent contract ${msg.contract}`);
  if (jobs.get(jobId)?.running) return session?.send({ t: "claimed", jobId });
  if (isStopping()) return refuse("this runner is stopping", true);
  const cap = capacity();
  if (cap.maxJobs && cap.running >= cap.maxJobs) return refuse(`this runner runs ${cap.running} jobs already (RTE_MAX_JOBS)`, true);
  let secrets;
  try {
    secrets = openJobSecrets(msg.sealed, process.env.RTE_TOKEN || "", jobId);
  } catch (err) {
    return refuse(err.message);
  }
  const entry = {
    spool: jobs.get(jobId)?.spool || new JobSpool(spoolDir(), jobId),
    job: msg.job || {},
    paths: msg.paths || {},
    files: msg.files || {},
    dirs: null,
    folder: null,
    abort: false,
    pid: null,
    running: true,
  };
  jobs.set(jobId, entry);
  // a cancel that came before this run : the job starts aborted (the run polls the flag)
  if (takeEarlyCancel(jobId)) {
    entry.abort = true;
    logger.notice(`Runner: job ${jobId} was cancelled before it arrived: stopping it at once`);
  }
  session?.send({ t: "claimed", jobId });
  logger.notice(`Runner: running job ${jobId}`);
  (async () => {
    try {
      await ensureFiles(jobId, entry);
    } catch (err) {
      await socketJobIO.end(jobId, (Number(entry.job?.lastOrder) || 0) + 1, "stderr", "failed", `[ERROR]: ${err.message}`);
      return;
    }
    await runAnsibleJob({ jobId, secrets });
  })()
    .catch((err) => logger.error(`Runner: job ${jobId} failed: ${err.message || err}`))
    .finally(() => {
      // what the job unpacked and wrote goes with it
      cache.release(entry.folder);
      entry.folder = null;
      entry.running = false;
    });
}

/**
 * Keeps the cancel of a job this RTE does not run yet, for EARLY_CANCEL_MS : its run message
 * may still be on its way. The ones expired go first, and at most EARLY_CANCEL_MAX are kept.
 *
 * Args:
 *   jobId (number): the job.
 *   now (number): the time, in ms (the tests set it).
 */
function rememberCancel(jobId, now = Date.now()) {
  // step 1 : the expired ones forgotten
  for (const [id, until] of earlyCancels) if (until <= now) earlyCancels.delete(id);
  // step 2 : full : the oldest goes (a Map keeps the order they came in)
  while (earlyCancels.size >= EARLY_CANCEL_MAX) earlyCancels.delete(earlyCancels.keys().next().value);
  earlyCancels.set(jobId, now + EARLY_CANCEL_MS);
}

/**
 * Takes the cancel kept for a job, if one came less than EARLY_CANCEL_MS ago.
 *
 * Args:
 *   jobId (number): the job.
 *   now (number): the time, in ms (the tests set it).
 *
 * Returns:
 *   boolean: true when the job was cancelled before it arrived.
 */
function takeEarlyCancel(jobId, now = Date.now()) {
  const until = earlyCancels.get(jobId);
  earlyCancels.delete(jobId);
  return !!until && until > now;
}

/**
 * Stops a job (cancel) : the flag first, so the run ends as aborted, then its process group. A
 * job this RTE does not know yet : the cancel is kept, and applied when its run comes.
 *
 * Args:
 *   msg (object): { jobId }.
 */
function onCancel(msg) {
  const jobId = parseInt(msg.jobId, 10);
  if (!Number.isInteger(jobId) || jobId <= 0) return;
  const entry = jobs.get(jobId);
  // not known yet (its run is on its way) : kept a while ; known and ended : nothing to stop
  if (!entry) {
    rememberCancel(jobId);
    return;
  }
  if (!entry.running) return;
  entry.abort = true;
  if (entry.pid > 0) {
    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch (e) {
      logger.debug(`Runner: could not signal job ${msg.jobId}: ${e.message}`);
    }
  }
}

/**
 * The controller stored a job's items (ack) : the spool goes once its end is stored.
 *
 * Args:
 *   msg (object): { jobId, seq }.
 */
function onAck(msg) {
  const jobId = parseInt(msg.jobId, 10);
  const entry = jobs.get(jobId);
  if (!entry) return;
  if (entry.spool.ack(Number(msg.seq) || 0) && !entry.running) {
    entry.spool.remove();
    jobs.delete(jobId);
    return;
  }
  pump(jobId);
}

/**
 * Takes a socket to the controller : says hello, and once welcomed sends what is not acked yet.
 *
 * Args:
 *   sess (Session): the socket.
 */
function attach(sess) {
  if (session && session !== sess) session.close(CLOSE.REPLACED, "a newer socket took over");
  session = sess;
  welcomed = false;
  sess.on("m:welcome", (msg) => {
    welcomed = true;
    sess.peer = msg;
    logger.notice(`Runner '${rteName()}': connected to the controller (node ${msg.node || "?"})`);
    if (msg.pending) logger.warning(`Runner '${rteName()}': waiting for an admin to approve it under Connections > Runners (fingerprint ${fingerprint(process.env.RTE_TOKEN || "")})`);
    for (const [jobId, entry] of jobs) {
      entry.spool.rewind();
      pump(jobId);
    }
  });
  sess.on("m:run", (msg) => onRun(msg).catch((e) => logger.error(`Runner: run: ${e.message}`)));
  sess.on("m:cancel", onCancel);
  sess.on("m:ack", onAck);
  sess.on("m:file", (msg) => cache.deliver(msg));
  sess.on("m:settings", onSettings);
  sess.on("close", (code, reason) => {
    if (session === sess) {
      session = null;
      welcomed = false;
      // no cache before startSocketRte() made it (a socket opened by the tests alone)
      cache?.failAll(new Error("the socket to the controller closed while the job's files came"));
    }
    logger.warning(`Runner '${rteName()}': socket to the controller closed (${code}${reason ? `: ${reason}` : ""})`);
  });
  sess.send({
    t: "hello",
    id: nodeId,
    name: rteName(),
    version,
    contract: SOCKET_CONTRACT,
    mode,
    ansible,
    files: filesMode(),
    url: process.env.RTE_URL || null,
    capacity: capacity(),
    running: [...jobs.entries()].filter(([, e]) => e.running).map(([id]) => id),
    spooled: [...jobs.keys()],
    ...settingsReport(),
  });
}

// ─── outbound : the RTE dials the controller ─────────────────────────────────────────

/**
 * What this RTE says of itself when it calls the controller : its token, its id and name, and for an
 * RTE the controller does not know yet (it then waits for approval) its host and version ; a join
 * token, when it has one, approves it at once.
 *
 * Args:
 *   token (string): RTE_TOKEN.
 *
 * Returns:
 *   object: the headers.
 */
function rteHeaders(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-AF-RTE-Id": nodeId,
    "X-AF-RTE-Name": rteName(),
    "X-AF-RTE-Host": os.hostname(),
    "X-AF-RTE-Version": version,
  };
  if (process.env.RTE_JOIN_TOKEN) headers["X-AF-RTE-Join"] = process.env.RTE_JOIN_TOKEN;
  return headers;
}

/**
 * How long an outbound RTE waits before it dials the controller again. A socket that dropped, or an
 * app that did not answer : a little longer each time (1 s up to 30 s, with some jitter so a
 * fleet does not dial at once). Refused (the runner rejected or removed, the token, the join
 * token refused, a runner of that name approved already) : REFUSED_REDIAL_MS, since dialing
 * again sooner would be refused the same way until an admin acts. Another contract : the controller
 * or this RTE is being upgraded, CONTRACT_REDIAL_MS (a minute), so it is back soon after the
 * other side follows.
 *
 * Args:
 *   close (object): { code : the socket's close code, status : the HTTP status the handshake
 *     was refused with (null when it was not), delay : the current backoff in ms, random :
 *     a number in [0, 1), Math.random by default }.
 *
 * Returns:
 *   object: { wait : ms before the next dial, delay : the backoff from then on, refused :
 *     true when the controller refused this RTE }.
 */
export function redialWait({ code, status, delay, random = Math.random() }) {
  if (REFUSED_CLOSES.includes(code) || REFUSED_STATUSES.includes(status)) {
    return { wait: REFUSED_REDIAL_MS, delay: 1000, refused: true };
  }
  // another contract : refused too, but only until one side is upgraded
  if (code === CLOSE.CONTRACT) return { wait: CONTRACT_REDIAL_MS, delay: 1000, refused: true };
  return { wait: delay + Math.floor(random * 1000), delay: Math.min(delay * 2, 30000), refused: false };
}

/**
 * Keeps a socket to the controller open : dials CONTROLLER_URL, and when it drops dials again, after
 * redialWait().
 *
 * Args:
 *   token (string): RTE_TOKEN.
 *
 * Returns:
 *   function: stops dialing and closes the socket (the tests ; the process stops through
 *     onShutdown).
 */
export function dialOut(token) {
  const url = socketUrl(controllerUrl());
  let delay = 1000;
  const headers = rteHeaders(token);
  if (process.env.RTE_URL) headers["X-AF-RTE-Url"] = process.env.RTE_URL;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const options = {
    headers,
    maxPayload: MAX_PAYLOAD,
    handshakeTimeout: 15000,
    // a self-signed app inside the same network (compose, a pod) : CONTROLLER_TLS_VERIFY=0 ; else
    // NODE_EXTRA_CA_CERTS names the CA
    rejectUnauthorized: controllerTlsVerify(),
  };
  if (proxy && !noProxy(new URL(url).hostname)) options.agent = new HttpsProxyAgent(proxy);
  // the address as the log shows it (no credentials), and how often it says a failed dial
  const shown = safeUrl(url);
  const report = new DialReport();
  const secrets = [token, process.env.RTE_JOIN_TOKEN];
  // stopped by the function returned, and the socket of the current dial
  let stopped = false;
  let current = null;
  const connect = () => {
    if (isStopping() || stopped) return;
    const ws = new WebSocket(url, options);
    current = ws;
    // the HTTP status the controller refused the handshake with, if it did
    let refusedStatus = null;
    // why the dial failed (an error, or the refusal and its body), and whether it opened at all
    let failure = null;
    let opened = false;
    ws.on("open", () => {
      opened = true;
      delay = 1000;
      // back after failures : said once, at the default level
      const back = report.connected();
      if (back) logger.notice(`Runner '${rteName()}': reached the controller at ${shown} again, after ${back.failures} failed dial(s) in ${ago(Date.now() - back.since)}`);
      attach(new Session(ws, "app"));
    });
    ws.on("unexpected-response", (req, res) => {
      refusedStatus = res.statusCode;
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        failure = { status: res.statusCode, body: body.slice(0, 2000) };
        // listening to this event takes the abort of the handshake over from ws : without it no
        // close comes, and this RTE never dials again
        ws.terminate();
      });
      res.on("error", () => ws.terminate());
    });
    ws.on("error", (err) => {
      // the first error is the cause ; what follows it (the abort after a refusal, a reset after
      // a TLS failure) is not
      if (!failure && !refusedStatus) failure = { error: err };
      logger.debug(`Runner: socket to ${shown}: ${scrub(err.message, secrets)}`);
    });
    ws.on("close", (code) => {
      if (isStopping() || stopped) return;
      const next = redialWait({ code, status: refusedStatus, delay });
      delay = next.delay;
      const again = next.wait >= 60000 ? `${Math.round(next.wait / 60000)} minute(s)` : `${Math.round(next.wait / 1000)} seconds`;
      if (!opened) {
        // the dial itself failed : why, at warning, the first time and on a change of cause,
        // then at most every few minutes while the same cause lasts
        const why = describeDialFailure(failure || { status: refusedStatus, code }, { side: "app", url, proxy: !!options.agent, secrets });
        const line = failureLine(report, why, `Runner '${rteName()}': cannot reach the controller at ${shown}`);
        if (line) logger.warning(`${line}: dialing again in ${again}${next.refused ? ", or restart it once an admin acted" : ""}`);
        else logger.debug(`Runner: dialing the controller again in ${again} (${why.text})`);
      } else if (next.refused && code === CLOSE.CONTRACT) logger.warning(`Runner '${rteName()}': the controller speaks another contract (an upgrade in progress?): dialing again in ${Math.round(next.wait / 1000)} seconds`);
      else if (next.refused) logger.warning(`Runner '${rteName()}': the controller refused this runner (${refusedStatus || code}): dialing again in ${Math.round(next.wait / 60000)} minutes, or restart it once an admin acted`);
      else logger.info(`Runner: dialing the controller again in ${Math.round(next.wait / 1000)} seconds`);
      setTimeout(connect, next.wait).unref?.();
    });
  };
  logger.notice(`Runner '${rteName()}': dialing the controller at ${shown}${options.agent ? " through the proxy" : ""}`);
  connect();
  return () => {
    stopped = true;
    current?.terminate();
  };
}

/**
 * Whether a host bypasses the proxy (NO_PROXY).
 *
 * Args:
 *   host (string): the controller's host name.
 *
 * Returns:
 *   boolean
 */
function noProxy(host) {
  const list = String(process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.some((p) => p === "*" || host === p || host.endsWith(p.startsWith(".") ? p : `.${p}`));
}

// ─── inbound : one registration call ──────────────────────────────────────────

/**
 * Registers an inbound RTE with the controller once (CONTROLLER_URL set) : its runner is added or updated with
 * its mode and its address (RTE_URL), with a join token the first time, so the controller dials it from
 * then on. Tried again with a backoff until the controller answers ; refused (a wrong token) it stops.
 *
 * Args:
 *   token (string): RTE_TOKEN.
 *
 * Returns:
 *   Promise<void>: settles once registered, or refused.
 */
async function registerInbound(token) {
  const base = new URL(controllerUrl());
  const url = `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/v2/rte/register`;
  const headers = rteHeaders(token);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  const httpsAgent = proxy && !noProxy(base.hostname)
    ? new HttpsProxyAgent(proxy)
    : new https.Agent({ rejectUnauthorized: controllerTlsVerify() });
  let delay = 2000;
  for (;;) {
    if (isStopping()) return;
    try {
      // its certificate goes with it (an https RTE_URL, HTTPS=1) : the controller dials it pinned to it
      const cert = certToSend();
      const body = { mode: "inbound", url: process.env.RTE_URL, ...(cert ? { cert } : {}) };
      const { data } = await axios.post(url, body, { headers, httpsAgent, proxy: false, timeout: 15000 });
      if (data.pending) logger.warning(`Runner '${rteName()}': asked to join as inbound runner '${data.runner}': the controller dials it once an admin approves it under Connections > Runners (fingerprint ${fingerprint(token)})`);
      else logger.notice(`Runner '${rteName()}': registered with the controller as inbound runner '${data.runner}' at ${data.uri}: the controller dials it from now on`);
      return;
    } catch (err) {
      const status = err?.response?.status;
      const why = err?.response?.data?.error || err.message;
      if (status && status < 500 && status !== 429) {
        logger.error(`Runner '${rteName()}': the controller refused the registration (${status}): ${why}`);
        return;
      }
      logger.warning(`Runner '${rteName()}': could not register with the controller yet (${why}), trying again in ${delay / 1000} seconds`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }
}

// ─── start ────────────────────────────────────────────────────────────────────

/**
 * Starts a socket-mode RTE : the spool and the files cache, the probes, then the socket -
 * dialed (outbound) or listened for (inbound).
 *
 * Args:
 *   rteMode (string): outbound or inbound.
 *
 * Returns:
 *   Promise<void>
 */
export async function startSocketRte(rteMode) {
  mode = rteMode;
  const token = process.env.RTE_TOKEN || "";
  if (token.length < 16) {
    console.error("runner: set RTE_TOKEN (at least 16 characters) ; refusing to start");
    process.exit(1);
  }
  if (mode === "outbound" && !controllerUrl()) {
    console.error("runner: RTE_MODE=outbound needs CONTROLLER_URL, the controller's address (https://forms.example.com) ; refusing to start");
    process.exit(1);
  }
  if (mode === "outbound") {
    try {
      socketUrl(controllerUrl());
    } catch (e) {
      console.error(`Runner: ${e.message} ; refusing to start`);
      process.exit(1);
    }
  }
  if (mode === "inbound" && controllerUrl() && !process.env.RTE_URL) {
    console.error("runner: RTE_MODE=inbound with CONTROLLER_URL registers with the controller, which then dials RTE_URL : set RTE_URL (http://this-host:8000) ; refusing to start");
    process.exit(1);
  }
  if (mode === "inbound" && !controllerUrl()) {
    logger.notice("runner: inbound without CONTROLLER_URL: its runner is added under Connections > Runners or in the config seed (type rte, mode inbound, a credential with its address and RTE_TOKEN)");
  }
  installFatalHandlers("runner");
  useJobIO(socketJobIO);
  fs.mkdirSync(spoolDir(), { recursive: true, mode: 0o700 });
  for (const line of envSettingWarnings()) logger.warning(`Runner: ${line}`);
  cache = new FileCache(cacheDir(), settings().cacheMb * 1048576, nodeId);
  ansible = await ansibleVersion();

  // the items an earlier start left : sent once connected ; a job that had not ended cannot go on
  for (const sp of JobSpool.loadAll(spoolDir())) {
    if (!sp.ended) sp.append({ kind: "abandon", message: "the runner restarted while the playbook ran" });
    jobs.set(sp.jobId, { spool: sp, job: {}, paths: {}, files: {}, dirs: null, abort: false, pid: null, running: false });
    logger.warning(`Runner: job ${sp.jobId} left by an earlier start: sending what the controller has not stored`);
  }

  stopWithin((drainSeconds() + 8) * 1000);
  onShutdown("running jobs", async () => {
    const until = Date.now() + drainSeconds() * 1000;
    const running = () => [...jobs.values()].filter((j) => j.running).length;
    if (running()) logger.notice(`Runner: stopping, waiting up to ${drainSeconds()} seconds for ${running()} running job(s)`);
    while (running() && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    // the last items go before the socket closes
    await new Promise((r) => setTimeout(r, 1000));
  });
  onShutdown("socket", () => session?.close(CLOSE.GOING_AWAY, "the runner stops"));

  // the probes and the metrics, as a database-mode RTE's ; ready : connected to the controller
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(httpMetrics);
  app.get("/live", (req, res) => res.json({ status: "live" }));
  app.get("/ready", (req, res) =>
    isStopping() ? res.status(503).json({ status: "not ready", reason: "stopping" })
      : mode === "outbound" && !welcomed ? res.status(503).json({ status: "not ready", reason: "not connected to the controller" })
        : res.json({ status: "ready" }));
  addScrapeGauge("af_rte_running_jobs", "The playbooks this runner runs now", [], async (g) => g.set(capacity().running));
  addScrapeGauge("af_rte_max_jobs", "How many playbooks this runner runs at once (RTE_MAX_JOBS, 0: no limit)", [], async (g) => g.set(maxJobs()));
  addScrapeGauge("af_rte_socket_connected", "Whether this runner's socket to the controller is open (1) or not (0)", [], async (g) => g.set(welcomed ? 1 : 0));
  app.get("/metrics", metricsHandler());

  const port = appConfig.port;
  const server = httpsConfig.https
    ? https.createServer({ ...httpServerOptions(), key: httpsConfig.httpsKey, cert: httpsConfig.httpsCert }, app)
    : http.createServer(httpServerOptions(), app);
  server.on("error", (err) => {
    console.error(`Runner: cannot listen on port ${port}: ${err.message}`);
    process.exit(1);
  });
  onShutdown("server", () => new Promise((resolve) => server.close(() => resolve())));

  if (mode === "inbound") {
    // the controller dials /rte/v1/socket with this RTE's token ; a newer socket replaces the older one
    // (the controller node holding the lease changed)
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname !== RTE_SOCKET_PATH) return socket.destroy();
      if (!safeEqual(bearerToken(req.headers.authorization), token)) {
        logger.warning(`Runner: refused a socket without the right token from ${req.socket.remoteAddress}`);
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(new Session(ws, `app ${req.headers["x-af-node"] || req.socket.remoteAddress}`)));
    });
  }

  // every interface, unless LISTEN_HOST names one (127.0.0.1 : a native outbound RTE)
  const host = listenHost();
  await new Promise((resolve) => server.listen(port, host, resolve));
  logger.notice(`Runner '${rteName()}' ${version} (${mode}, files ${filesMode()}) listening on ${httpsConfig.https ? "https" : "http"} ${host ? `${host}:` : "port "}${port}, token fingerprint ${fingerprint(token)}`);
  if (mode === "inbound" && httpsConfig.https && httpsConfig.httpsCert) {
    const pem = httpsConfig.httpsCert.toString("utf8");
    logger.notice(`Runner '${rteName()}': certificate fingerprint ${certFingerprint(pem) || "?"}${certToSend() ? " (sent to the controller when it registers: the controller dials it pinned to it)" : ""}`);
    if (isTemplateCert(pem)) logger.warning(`[SECURITY] runner '${rteName()}': HTTPS_CERT is the sample certificate shipped in the image, whose private key is public: mount a certificate of your own (HTTPS_CERT, HTTPS_KEY)`);
  } else if (mode === "inbound" && /^http:\/\//i.test(String(process.env.RTE_URL || ""))) {
    logger.warning(`Runner '${rteName()}': inbound over plain http: the controller sends RTE_TOKEN in clear. Set HTTPS=1 and an https RTE_URL so the controller pins this runner's certificate`);
  }
  if (mode === "outbound") dialOut(token);
  // inbound with the controller's address : one call so the controller knows this RTE and dials it
  else if (controllerUrl()) registerInbound(token).catch((e) => logger.error(`Runner: registration: ${e.message}`));

  // its health to the controller every 20 s : what it runs and its free slots ; and its jobs folder
  // said alive, so an RTE sharing the cache never takes it for one that is gone
  setInterval(() => {
    sendHealth();
    cache?.heartbeat();
  }, 20000).unref();
}

// for the tests
export { socketJobIO, jobs, capacity, onRun, onAck, onCancel, onSettings, settings, attach, maskDeep, earlyCancels, rememberCancel, takeEarlyCancel };
