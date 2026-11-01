// An RTE (runtime environment) : the playbook runs in another container (AF_ROLE=rte).
// In database mode (deprecated) the RTE reads the job and writes the output and the final
// status to the database itself : this side resolves the job's secrets, hands them over sealed
// for that RTE with the job over HTTP (lib/sealedSecrets.js), and waits for it to end.
// In the socket modes (outbound, inbound) the controller node holding the RTE's socket sends it the job
// and writes what comes back (runners/rteHub.js) : this side launches and follows it the same way.
// The RTE's address, token and mode come from its row in the runners table.
import { RTE_CONTRACT } from "../rte/contract.js";
import { appVersion } from "../lib/version.js";
import axios from "axios";
import logger from "../lib/logger.js";
import mysql from "../models/db.model.js";
import Errors from "../lib/errors.js";
import { stripTrailingSlashes } from "../lib/url.js";
import Job from "../models/job.model.js";
import { safeParse } from "../lib/safejson.js";
import { NODE_DEAD_SECONDS } from "../lib/role.js";
import { SOCKET_CONTRACT, SOCKET_MODES, queueMinutes, RETRY_MS } from "../rte/socket/protocol.js";
import { getHttpsAgent, jobStatus, failRteJob, abortWhileWaiting, sayWaitingForSlot } from "./common.js";

// the hub (rteHub.js imports the runner model, which imports this : loaded when used)
const isSocket = (runner) => SOCKET_MODES.includes(runner?.rte_mode);
const hub = () => import("./rteHub.js");
import { resolveJobSecrets } from "../lib/jobSecrets.js";
import { sealJobSecrets } from "../lib/sealedSecrets.js";

const POLL_MS = 1000;
// how often the RTE itself is asked about the job, in polls
const ASK_RTE_EVERY = 30;

// is version a older than b (x.y.z, a prerelease suffix ignored) ? this app's version is shown
// next to the RTE's, which may be older (see rte/contract.js)
const older = (a, b) => {
  const parts = (v) => String(v || "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

function client(runner) {
  const url = stripTrailingSlashes(runner.uri || "");
  return {
    url,
    http: axios.create({
      baseURL: `${url}/rte/v1`,
      headers: { Authorization: `Bearer ${runner.token || ""}` },
      timeout: 10000,
      httpsAgent: getHttpsAgent(runner),
    }),
  };
}

// what the job output (or the connection test) says when the RTE does not take the call
function describe(err, url) {
  const status = err?.response?.status;
  if (status === 401) return `the RTE at ${url} refused the token: check its RTE_TOKEN and the token stored here`;
  if (status === 409) return `the RTE at ${url} did not take the job: ${err.response.data?.error || "conflict"}`;
  if (status) return `the RTE at ${url} answered ${status}: ${err.response.data?.error || err.message}`;
  return `the RTE at ${url} is unreachable: ${err.code || err.message}`;
}

// a job that cannot run : failed, unless it ended already (runners/common.js)
const failJob = failRteJob;

// did an RTE take the job ? its claim writes jobs.host
async function claimedBy(jobId) {
  const rows = await mysql.do("SELECT host FROM AnsibleForms.`jobs` WHERE id=?", [jobId], true);
  return rows?.[0]?.host || null;
}

/**
 * Whether the RTE that claimed a job is alive : it claimed it (jobs.host), and its heartbeat
 * in `nodes` is recent. Several replicas behind one address (a kubernetes service) answer the
 * status call in turn ; one that does not run the job says `unknown` while the replica that
 * does runs it fine.
 *
 * Args:
 *   jobId (number): the job.
 *
 * Returns:
 *   Promise<boolean>: true when a live RTE holds it.
 */
async function heldByLiveRte(jobId) {
  const rows = await mysql.do(
    "SELECT 1 AS alive FROM AnsibleForms.`jobs` j JOIN AnsibleForms.`nodes` n ON n.id = j.host " +
      "WHERE j.id=? AND n.last_seen > (NOW() - INTERVAL ? SECOND)",
    [jobId, NODE_DEAD_SECONDS],
    true
  );
  return rows?.length > 0;
}

const dbStatus = jobStatus;

/** waits until the job is no longer running ; true when it ended in success */
async function track(jobId, rte) {
  let polls = 0;
  let unknown = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const status = await dbStatus(jobId).catch(() => "running");
    if (status !== "running") return status === "success";
    if (++polls % ASK_RTE_EVERY) continue;
    try {
      const { data } = await rte.http.get(`/jobs/${jobId}`);
      // the RTE answers but does not run it, and the row still says running : it is lost -
      // unless another replica behind the same address claimed it and is alive
      unknown = data?.status === "unknown" ? unknown + 1 : 0;
      if (unknown >= 2) {
        if ((await dbStatus(jobId)) !== "running") continue;
        if (await heldByLiveRte(jobId).catch(() => true)) {
          unknown = 0;
          continue;
        }
        return failJob(jobId, `the RTE '${rte.name}' lost job ${jobId}`);
      }
    } catch (err) {
      // unreachable for a while : keep waiting, the RTE writes the end itself, and an RTE
      // that restarts abandons its own jobs, which ends this wait too
      logger.debug(`Job ${jobId}: RTE status check failed: ${err.message}`);
    }
  }
}

/**
 * The RTE's health, with its contract checked against ours. Its release may differ from the
 * app's : an RTE is updated when the contract changes, not with every app release.
 */
async function check(runner) {
  if (isSocket(runner)) return checkSocket(runner);
  const rte = client(runner);
  let data;
  try {
    ({ data } = await rte.http.get("/health"));
  } catch (err) {
    throw new Errors.BadRequestError(describe(err, rte.url));
  }
  const details = {
    id: data?.id, version: data?.version, contract: data?.contract, ansible: data?.ansible,
    running: data?.running?.length || 0, appVersion,
    // compatible, and older than this app : nothing to do, worth knowing
    olderRelease: older(data?.version, appVersion),
  };
  if (data?.contract !== RTE_CONTRACT) {
    const theirs = data?.contract === undefined ? "no contract (a preview build)" : `contract ${data.contract}`;
    const what = (data?.contract || 0) < RTE_CONTRACT ? "update the RTE" : "update this app";
    throw new Errors.BadRequestError(`the RTE at ${rte.url} (${data?.version}) speaks ${theirs}, this app (${appVersion}) needs contract ${RTE_CONTRACT}: ${what}`);
  }
  return details;
}

/**
 * A socket-mode RTE's state, as any controller node sees it : who holds its socket and what it said.
 *
 * Args:
 *   runner (object): the runner.
 *
 * Returns:
 *   Promise<object>: its details, as check() returns them.
 *
 * Raises:
 *   BadRequestError: no controller node holds its socket.
 */
async function checkSocket(runner) {
  const state = await (await hub()).socketState(runner.name);
  if (!state?.alive) {
    const how = runner.rte_mode === "outbound"
      ? "it has not dialed the controller: check its CONTROLLER_URL, its token and the network from the RTE to the controller"
      : `no controller node could dial it at ${runner.uri}: check its RTE_URL, its token and the network from the controller to the RTE`;
    throw new Errors.BadRequestError(`the RTE '${runner.name}' (${runner.rte_mode}) is not connected: ${how}`);
  }
  const info = state.info || {};
  if (info.contract !== undefined && info.contract !== SOCKET_CONTRACT) {
    throw new Errors.BadRequestError(`the RTE '${runner.name}' (${info.version}) speaks contract ${info.contract}, this app (${appVersion}) needs contract ${SOCKET_CONTRACT}`);
  }
  return {
    id: state.rte_id, version: info.version, contract: info.contract, ansible: info.ansible,
    running: (info.running || []).length, appVersion, olderRelease: older(info.version, appVersion),
    mode: runner.rte_mode, files: info.files, capacity: info.capacity, socketNode: state.node_id,
  };
}

/**
 * Follows a job handed to a socket-mode RTE : it ends when the holder of the socket writes its
 * end. A job no RTE claimed for RTE_QUEUE_MINUTES (none connected, or all busy) fails.
 *
 * Args:
 *   jobId (number): the job.
 *   runner (object): its runner.
 *
 * Returns:
 *   Promise<boolean>: true when it ended in success.
 */
async function trackSocket(jobId, runner) {
  const since = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const status = await dbStatus(jobId).catch(() => "running");
    if (status !== "running") return status === "success";
    if (!queueMinutes() || Date.now() - since < queueMinutes() * 60000 + 60000) continue;
    // never claimed : no connected RTE took it (the holder fails a busy one itself)
    if (!(await claimedBy(jobId).catch(() => "?"))) {
      return failJob(jobId, `no controller node holds a socket to RTE '${runner.name}' and it took no job for ${queueMinutes()} minutes (RTE_QUEUE_MINUTES): is it connected?`);
    }
  }
}

/**
 * Hands a job to the RTE. A full or stopping RTE (503) does not claim it : the job waits, with
 * one line saying so, and asks again every 10 seconds - for RTE_QUEUE_MINUTES at most, until
 * the RTE takes it, the job is aborted, or it ended otherwise.
 *
 * Args:
 *   rte (object): the client (client()).
 *   jobId (number): the job.
 *   sealed (object): its secrets, sealed for this RTE.
 *
 * Returns:
 *   Promise<void>: settles once the RTE took it.
 *
 * Raises:
 *   Error: the RTE refused it (other than busy), the wait ran out, or the job was aborted.
 */
async function handOver(rte, jobId, sealed) {
  const until = Date.now() + queueMinutes() * 60 * 1000;
  let said = false;
  for (;;) {
    try {
      await rte.http.post("/jobs", { jobId, contract: RTE_CONTRACT, sealed });
      return;
    } catch (err) {
      if (err?.response?.status !== 503) throw err;
      if (Date.now() >= until) {
        throw Object.assign(new Error(`the RTE '${rte.name}' stayed busy for ${queueMinutes()} minutes (RTE_QUEUE_MINUTES)`), { response: { status: 503, data: { error: "busy" } } });
      }
      if (!said) {
        said = true;
        await sayWaitingForSlot(jobId, rte.name, err.response.data?.error);
      }
      if (await Job.isAbortRequested(jobId).catch(() => false)) {
        await abortWhileWaiting(jobId);
        throw Object.assign(new Error("aborted while waiting"), { aborted: true, response: { status: 499 } });
      }
      if ((await dbStatus(jobId).catch(() => "running")) !== "running") throw Object.assign(new Error("ended while waiting"), { aborted: true, response: { status: 499 } });
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

export default {
  type: "rte",
  capabilities: { playbook: true, template: false },
  check,
  async launch(ctx) {
    const { jobId, runner } = ctx;
    if (isSocket(runner)) {
      await Job.printJobOutput(`ok: [Running on RTE ${runner.name} (${runner.rte_mode})]`, "stdout", jobId, (await Job.lastOrder(jobId)) + 1);
      // the node holding its socket sends it : this one at once, another within seconds
      (await hub()).kick(jobId, runner);
      return trackSocket(jobId, runner);
    }
    const rte = { ...client(runner), name: runner.name };
    // written before the hand-over, never after : from then on the RTE writes the output
    await Job.printJobOutput(`ok: [Running on RTE ${runner.name} (${rte.url})]`, "stdout", jobId, (await Job.lastOrder(jobId)) + 1);
    // the job's secrets, resolved here and sealed for this RTE and this job
    let sealed;
    try {
      const rows = await mysql.do("SELECT extravars, credentials FROM AnsibleForms.`jobs` WHERE id=?", [jobId]);
      const extravars = safeParse(rows?.[0]?.extravars, {}, `job.extravars id=${jobId}`);
      const creds = safeParse(rows?.[0]?.credentials, {}, `job.credentials id=${jobId}`);
      sealed = sealJobSecrets(await resolveJobSecrets(extravars, creds), runner.token, jobId);
    } catch (err) {
      return failJob(jobId, `could not prepare the job's credentials for the RTE: ${err.message}`);
    }
    try {
      await handOver(rte, jobId, sealed);
    } catch (err) {
      // the RTE refused it (4xx) : it is not running. No answer at all (a timeout, a reset
      // connection) may come after the RTE claimed and started it : then follow it, never
      // fail a job that is running
      // The RTE clears jobs.host when the playbook ends, so a job that ran and finished
      // within the wait looks unclaimed : its status says it ran (failJob leaves it alone)
      // aborted or ended while it waited for a slot : ended already
      if (err?.aborted) return false;
      if (err?.response || !(await claimedBy(jobId).catch(() => null))) {
        return failJob(jobId, err?.response?.status === 503 ? err.message : describe(err, rte.url));
      }
      logger.warning(`Job ${jobId}: no answer from the RTE at ${rte.url}, but it claimed the job: following it`);
    }
    return track(jobId, rte);
  },
  // the fast path ; the abort flag in the database reaches the RTE too, within seconds
  async cancel(ctx) {
    // a socket : the cancel goes from the node holding it (the abort flag reaches it otherwise)
    if (isSocket(ctx.runner)) {
      (await hub()).cancel(ctx.jobId, ctx.runner);
      return;
    }
    const rte = client(ctx.runner);
    try {
      await rte.http.post(`/jobs/${ctx.jobId}/cancel`);
    } catch (err) {
      logger.warning(`Job ${ctx.jobId}: the RTE did not take the cancel (${err.message}) ; the abort flag will stop it`);
    }
  },
};
