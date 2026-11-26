// What the runners that follow a job on another system share (awx, semaphore, rundeck, jenkins) : the http
// client, the tolerance for that system not answering for a while, and ending a job when
// contact is lost. Each runner keeps its own wording. The RTE's two sides (rte.js, which
// launches and follows, and rteHub.js, which holds the sockets) share the ends of a job that
// did not run : failed, aborted while it waited, waiting for a free slot.
import axios from "axios";
import https from "https";
import tls from "tls";
import { X509Certificate } from "crypto";
import { stripTrailingSlashes } from "../lib/url.js";
// a cycle (job.model imports the orchestrator, which reaches the runners) ; Job is only used
// when a job runs, long after both modules have loaded
import Job from "../models/job.model.js";
import mysql from "../models/db.model.js";

export function delay(t, v) {
  return new Promise((resolve) => setTimeout(resolve, t, v));
}

/**
 * The SHA-256 fingerprints of the certificates in a PEM bundle, as Node writes them
 * (AB:CD:...), the ones that cannot be read left out.
 *
 * Args:
 *   bundle (string): the PEM text.
 *
 * Returns:
 *   Set<string>
 */
function pemFingerprints(bundle) {
  const out = new Set();
  for (const block of String(bundle || "").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) {
    try {
      out.add(new X509Certificate(block).fingerprint256);
    } catch {
      // not a certificate : it pins nothing
    }
  }
  return out;
}

/**
 * The certificate checked or not, against a private authority's certificates when given : the
 * agent of a runner's http calls, and of the socket the app dials to an inbound RTE.
 *
 * Pinned (opts.pin, the socket to an inbound RTE) : a server whose own certificate is one of the
 * ca_bundle's is trusted whatever name the app dials it by - the certificate was sent by the RTE
 * when it registered, and an admin approved it, so it is the RTE's whatever its subject says
 * (a self-signed certificate made for the RTE's container name, dialed by its IP address). Any
 * other certificate is checked as always : a chain to the bundle or to the usual authorities
 * (Node's roots, the system's), and the name.
 *
 * Args:
 *   runner (object): the runner row (ignore_certs, ca_bundle).
 *   opts (object): { pin : true to trust the bundle's own certificates by fingerprint }.
 *
 * Returns:
 *   https.Agent
 */
export function getHttpsAgent(runner, opts = {}) {
  const options = {
    rejectUnauthorized: !runner?.ignore_certs,
    ca: runner?.ca_bundle || undefined,
  };
  if (opts.pin && runner?.ca_bundle && !runner?.ignore_certs) {
    const pinned = pemFingerprints(runner.ca_bundle);
    if (pinned.size) {
      // the pin trusts the bundle's certificates ON TOP of the usual authorities, it does not
      // replace them : an inbound RTE behind a proxy that re-encrypts with a certificate of a
      // public (or NODE_EXTRA_CA_CERTS) authority still passes the normal chain check, with its
      // name checked. A `ca` option alone would make the bundle the only trust.
      options.ca = [...defaultAuthorities(), runner.ca_bundle];
      // a leaf of the bundle that is not self-signed is a trust anchor of its own (no chain
      // to its authority needed) ; its name is not checked, its fingerprint is
      options.allowPartialTrustChain = true;
      options.checkServerIdentity = (host, cert) => (pinned.has(cert?.fingerprint256) ? undefined : tls.checkServerIdentity(host, cert));
    }
  }
  return new https.Agent(options);
}

/**
 * The authorities Node trusts when no `ca` is given : its bundled roots, plus the system's and
 * NODE_EXTRA_CA_CERTS where this Node can list them (tls.getCACertificates, Node 22.15 and later).
 *
 * Returns:
 *   string[]: the certificates, as PEM.
 */
function defaultAuthorities() {
  if (typeof tls.getCACertificates === "function") {
    try {
      return tls.getCACertificates("default");
    } catch {
      // an older signature : the bundled roots below
    }
  }
  return [...tls.rootCertificates];
}

// every call : a connection that hangs must fail and reach the retries, not wait for ever
export const REMOTE_TIMEOUT_MS = 60000;

/**
 * An axios client for a runner's server : its uri as the base, its certificate settings, the
 * timeout every call gets.
 *
 * Args:
 *   runner (object): the runner row (uri, ignore_certs, ca_bundle).
 *   headers (object): the authorization headers.
 *
 * Returns:
 *   AxiosInstance
 */
export function clientFor(runner, headers) {
  return axios.create({
    baseURL: stripTrailingSlashes(String(runner?.uri || "")),
    headers,
    httpsAgent: getHttpsAgent(runner),
    timeout: REMOTE_TIMEOUT_MS,
  });
}

// polls in a row that may fail before the job is given up
const MAX_RETRIES = 10;

/**
 * How long the remote system may fail to answer before a followed job is given up :
 * AWX_LOST_MINUTES (5) of failures in a row, with a backoff between the tries (1, 2, 4 ... 30
 * seconds). A network blip, a restart or a busy server is no reason to end a job that is
 * running there.
 *
 * Returns:
 *   {failed: function, ok: function}: failed() counts a failure and answers { giveUp, waitMs } ;
 *     ok() starts the count again.
 */
export function contactTolerance(lostMinutes = Math.max(0, parseFloat(process.env.AWX_LOST_MINUTES ?? 5) || 0), now = Date.now) {
  let since = null;
  let failures = 0;
  return {
    failed() {
      failures++;
      if (since === null) since = now();
      const giveUp = failures >= MAX_RETRIES && now() - since >= lostMinutes * 60 * 1000;
      return { giveUp, waitMs: Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)), failures };
    },
    ok() {
      since = null;
      failures = 0;
    },
  };
}

// an error thrown after the job was ended : who catches it must not end it again
export function jobEnded(err) {
  err.jobEnded = true;
  return err;
}

/**
 * The remote system stopped answering while a job was followed : end ours, rather than leave
 * it 'running' until the daily sweep. The job over there may well go on.
 *
 * Returns:
 *   string: the line the job ended with.
 */
export async function lostContact(jobid, counter, line) {
  await Job.resetAbortRequested(jobid).catch(() => {});
  await Job.endJobStatus(jobid, counter, "stderr", "failed", line);
  return line;
}

// ─── the RTE's jobs (runners/rte.js and runners/rteHub.js) ────────────────────

/**
 * A job's status, as stored.
 *
 * Args:
 *   jobId (number): the job.
 *
 * Returns:
 *   Promise<string|undefined>: running, success, failed ... ; undefined when it does not exist.
 */
export async function jobStatus(jobId) {
  const rows = await mysql.do("SELECT status FROM AnsibleForms.`jobs` WHERE id=?", [jobId], true);
  return rows?.[0]?.status;
}

/**
 * Fails a job handed to an RTE that cannot run (refused, lost, or waited too long) - only a job
 * still running : the RTE may have ended it already (a short playbook that finished while the
 * app waited for an answer), and its end, a success too, stands.
 *
 * Args:
 *   jobId (number): the job.
 *   message (string): why, the job's last line.
 *
 * Returns:
 *   Promise<boolean>: true when it had ended in success already, false otherwise.
 */
export async function failRteJob(jobId, message) {
  // step 1 : ended already : left as it is
  const status = await jobStatus(jobId).catch(() => "running");
  if (status !== "running") return status === "success";
  // step 2 : failed, saying why
  await Job.endJobStatus(jobId, (await Job.lastOrder(jobId)) + 1, "stderr", "failed", `[ERROR]: ${message}`);
  // step 3 : an abort asked meanwhile is answered by this end : a later abort must not be refused
  await Job.resetAbortRequested(jobId).catch(() => {});
  return false;
}

/**
 * Ends a job the operator aborted while it waited for the RTE (busy, or not connected) : it
 * never ran, so nothing on the RTE has to stop.
 *
 * Args:
 *   jobId (number): the job.
 *
 * Returns:
 *   Promise<void>
 */
export async function abortWhileWaiting(jobId) {
  await Job.endJobStatus(jobId, (await Job.lastOrder(jobId)) + 1, "stderr", "aborted", "Playbook was aborted by the operator while it waited for the runner");
  await Job.resetAbortRequested(jobId).catch(() => {});
}

/**
 * Says in a job's output that it waits for a free slot on its RTE (once : the caller keeps
 * track).
 *
 * Args:
 *   jobId (number): the job.
 *   name (string): the RTE's runner.
 *   why (string): what the RTE said (busy, RTE_MAX_JOBS reached ...).
 *
 * Returns:
 *   Promise<void>
 */
export async function sayWaitingForSlot(jobId, name, why) {
  await Job.printJobOutput(`ok: [Waiting for a free slot on runner ${name}: ${why || "busy"}]`, "stdout", jobId, (await Job.lastOrder(jobId)) + 1);
}
