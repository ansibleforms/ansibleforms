// The RTE (runtime environment) in database mode (RTE_MODE=database, or unset : deprecated in
// 7.3, removed in 8.0 - rte/start.js picks the mode). It runs playbooks for an AnsibleForms app
// and nothing else - no web interface, no scheduler, no seed. The socket modes are rte/socket.
//
// It shares the controller's database, so it reads the job and writes the output and the final
// status itself, with the only code that runs a playbook (ansible-core.js). The controller says
// "run job N" and hands it the job's secrets, resolved and sealed for this RTE
// (lib/sealedSecrets.js) : the RTE never reads the credentials table nor a secret store, and
// needs ENCRYPTION_SECRET only to register itself (its token is stored encrypted).
//
//   GET  /rte/v1/health             version, contract, ansible, id, running job ids
//   POST /rte/v1/jobs {jobId, sealed}  202 : accepted, runs in the background
//   GET  /rte/v1/jobs/:id           running | finished | unknown
//   POST /rte/v1/jobs/:id/cancel    stops it now (the abort flag in the database works too)
//
// Every call needs `Authorization: Bearer <RTE_TOKEN>`.
import express from "express";
import http from "http";
import https from "https";
import { execFile } from "child_process";
import logger from "../lib/logger.js";
import mysql from "../models/db.model.js";
import { publish } from "../lib/liveEvents.js";
import httpsConfig from "../../config/https.config.js";
import appConfig from "../../config/app.config.js";
import { runAnsibleJob, runnerIdentity, useJobIO } from "./ansible-core.js";
import dbJobIO from "./jobio-db.js";
import { abandonJobs } from "./abandon.js";
import { RTE_CONTRACT } from "./contract.js";
import { listenHost } from "./socket/protocol.js";
import { openJobSecrets } from "../lib/sealedSecrets.js";
import { safeEqual, bearerToken } from "../lib/safeEqual.js";
import { readinessHandlers } from "../lib/readiness.js";
import { requestContext } from "../lib/requestContext.js";
import { installFatalHandlers } from "../lib/fatal.js";
import { httpMetrics, metricsHandler, addScrapeGauge } from "../lib/metrics.js";
import { onShutdown, stopWithin, isStopping } from "../lib/shutdown.js";
import { appVersion as version } from "../lib/version.js";
import { startHeartbeat } from "../lib/nodes.js";
import { registerSelf } from "./register.js";
import { startSyslogServers } from "../lib/syslogServers.js";
import { httpServerOptions } from "../lib/httpServerOptions.js";


// the jobs this process is running ; a job is only ever run by the RTE that claimed it
const activeJobs = new Set();

// true from startRte until the database and its schema answered : the RTE listens meanwhile, but
// /ready says "starting" and a job is refused with a 503 busy, so the controller tries again later
let starting = false;

// how many playbooks run at once (RTE_MAX_JOBS, 0 : no limit), and how long a stop waits for
// the running ones (RTE_DRAIN_SECONDS)
const maxJobs = () => Math.max(0, parseInt(process.env.RTE_MAX_JOBS ?? 10, 10) || 0);
const drainSeconds = () => Math.max(0, parseInt(process.env.RTE_DRAIN_SECONDS ?? 25, 10) || 0);

/**
 * Waits for the running playbooks to end, for RTE_DRAIN_SECONDS at most : a stop (a rolling
 * update, a scale down) lets them finish instead of cutting them off. New jobs are refused
 * meanwhile (acceptJob answers 503), so the controller sends them to another RTE or waits.
 *
 * Returns:
 *   Promise<void>: settles when none runs, or the time is up.
 */
async function drainJobs() {
  const until = Date.now() + drainSeconds() * 1000;
  if (activeJobs.size) logger.notice(`RTE: stopping, waiting up to ${drainSeconds()} seconds for ${activeJobs.size} running job(s)`);
  while (activeJobs.size && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  if (activeJobs.size) logger.warning(`RTE: stopping with ${activeJobs.size} job(s) still running: they end as abandoned`);
}

function ansibleVersion() {
  return new Promise((resolve) => {
    execFile("ansible-playbook", ["--version"], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/)[0];
      resolve((/\[core\s+([^\]]+)\]/.exec(first) || [])[1] || first.trim());
    });
  });
}

function bearer(token) {
  return (req, res, next) => {
    if (safeEqual(bearerToken(req.headers.authorization), token)) return next();
    logger.warning(`RTE: refused a call without the right token from ${req.ip}`);
    return res.status(401).json({ error: "invalid token" });
  };
}

// a job this RTE was running when it stopped cannot finish any more ; only its own jobs
async function abandonOwnJobs() {
  const abandoned = await abandonJobs({ host: runnerIdentity() });
  if (abandoned) {
    logger.warning(`RTE: abandoned ${abandoned} job(s) left running by a previous start`);
    // the browsers see them stop
    publish("jobs");
  }
}

/**
 * Waits until the database answers and its schema is there, then abandons the jobs a previous
 * start of this RTE left running. On a fresh install the controller and the RTE start together (a helm
 * sidecar, compose without depends_on) : the controller is still creating the schema, the jobs table is
 * not there yet, and this tries again - with a backoff and a line that says why - instead of
 * failing the start. It gives up only when the process stops.
 *
 * Args:
 *   options (object): { firstDelayMs : the first wait, doubled after each failure up to
 *     maxDelayMs }.
 *
 * Returns:
 *   Promise<boolean>: true when done, false when the process began to stop meanwhile.
 */
export async function prepareDatabase({ firstDelayMs = 1000, maxDelayMs = 15000 } = {}) {
  let delay = firstDelayMs;
  let failed = false;
  for (;;) {
    if (isStopping()) return false;
    try {
      await mysql.do("SELECT 1");
    } catch (e) {
      logger.warning(`RTE: database not ready yet (${e.message || e}), trying again in ${delay / 1000} seconds`);
      failed = true;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
      continue;
    }
    try {
      // the first query on the jobs table : it fails while the controller has not created the schema
      await abandonOwnJobs();
      if (failed) logger.notice("RTE: the database and its schema are ready");
      return true;
    } catch (e) {
      logger.warning(`RTE: database schema not ready yet (${e.message || e}) - the controller creates it on its first start - trying again in ${delay / 1000} seconds`);
      failed = true;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

async function acceptJob(req, res) {
  const jobId = parseInt(req.body?.jobId, 10);
  if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ error: "jobId is required" });
  // the controller says which contract it speaks (rte/contract.js) ; a controller of another contract would
  // read and write the job differently, so the job is refused rather than run half right
  if (req.body?.contract !== undefined && req.body.contract !== RTE_CONTRACT) {
    return res.status(409).json({ error: `this RTE speaks contract ${RTE_CONTRACT}, the controller contract ${req.body.contract}: run the same contract on both` });
  }
  // starting, stopping, or full : not claimed, the controller tries again (runners/rte.js)
  if (starting) return res.status(503).json({ error: "this RTE is starting: its database is not ready yet", busy: true });
  if (isStopping()) return res.status(503).json({ error: "this RTE is stopping", busy: true });
  if (maxJobs() && activeJobs.size >= maxJobs() && !activeJobs.has(jobId)) {
    return res.status(503).json({ error: `this RTE runs ${activeJobs.size} jobs already (RTE_MAX_JOBS)`, busy: true });
  }
  const rows = await mysql.do("SELECT status, job_type FROM AnsibleForms.`jobs` WHERE id=?", [jobId]);
  if (!rows.length) return res.status(404).json({ error: `job ${jobId} does not exist` });
  if (rows[0].status !== "running") return res.status(409).json({ error: `job ${jobId} is ${rows[0].status}, not running` });
  // an RTE runs playbooks : never claim an AWX job or a multistep, whose tracker drives them
  if (rows[0].job_type !== "ansible") return res.status(409).json({ error: `job ${jobId} is a ${rows[0].job_type || "?"} job, not a playbook` });
  // the job's secrets, sealed by the controller for this RTE and this job : one that does not open
  // was not sealed with this RTE's token, and nothing is claimed
  let secrets;
  try {
    secrets = openJobSecrets(req.body?.sealed, process.env.RTE_TOKEN || "", jobId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // the claim : one runner per job, and a repeated call is harmless
  const me = runnerIdentity();
  const claim = await mysql.do(
    "UPDATE AnsibleForms.`jobs` SET host=? WHERE id=? AND status='running' AND job_type='ansible' AND (host IS NULL OR host=?)",
    [me, jobId, me]
  );
  if (!claim.affectedRows) return res.status(409).json({ error: `job ${jobId} is claimed by another runner` });
  if (activeJobs.has(jobId)) return res.status(202).json({ jobId, status: "running" });

  activeJobs.add(jobId);
  logger.notice(`RTE: running job ${jobId}`);
  runAnsibleJob({ jobId, secrets })
    .catch((err) => logger.error(`RTE: job ${jobId} failed: ${err.message || err}`))
    .finally(() => activeJobs.delete(jobId));
  return res.status(202).json({ jobId, status: "running" });
}

async function jobStatus(req, res) {
  const jobId = parseInt(req.params.id, 10);
  if (activeJobs.has(jobId)) return res.json({ jobId, status: "running" });
  const rows = await mysql.do("SELECT status FROM AnsibleForms.`jobs` WHERE id=?", [jobId]);
  if (!rows.length || rows[0].status === "running") return res.json({ jobId, status: "unknown" });
  return res.json({ jobId, status: "finished", jobStatus: rows[0].status });
}

async function cancelJob(req, res) {
  const jobId = parseInt(req.params.id, 10);
  if (!activeJobs.has(jobId)) return res.status(409).json({ error: `job ${jobId} is not running here` });
  // the flag first : the runner reports 'aborted' (not 'failed') when it sees it
  await mysql.do("UPDATE AnsibleForms.`jobs` SET abort_requested=1 WHERE id=? AND status='running'", [jobId]);
  const rows = await mysql.do("SELECT pid FROM AnsibleForms.`jobs` WHERE id=?", [jobId]);
  const pid = parseInt(rows[0]?.pid, 10);
  if (pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (e) {
      logger.debug(`RTE: could not signal job ${jobId}: ${e.message}`);
    }
  }
  return res.status(202).json({ jobId, status: "cancelling" });
}

// the handlers, for the tests
export { acceptJob, jobStatus, cancelJob, activeJobs, bearer, drainJobs };

/**
 * Starts the RTE : it listens first, then waits for the database and its schema
 * (prepareDatabase), then starts what needs them. Until then /live answers, /ready says
 * "starting" and a job gets a 503 busy : a probe sees a process that is starting, not a hung one,
 * and the controller waits for it. Anything that fails after the listen exits non-zero, so the
 * container restarts clean instead of staying up half started.
 *
 * Args:
 *   options (object): { firstDelayMs, maxDelayMs : the backoff of prepareDatabase }.
 *
 * Returns:
 *   Promise<void>: settles once the RTE is ready, or exiting.
 */
export async function startRte({ firstDelayMs, maxDelayMs } = {}) {
  const token = process.env.RTE_TOKEN || "";
  if (token.length < 16) {
    console.error("RTE: set RTE_TOKEN (at least 16 characters) ; refusing to start");
    process.exit(1);
  }
  // an uncaught exception exits to restart clean ; its running playbooks end as abandoned
  installFatalHandlers("RTE");
  // the jobs read and their output written in the database (rte/jobio-db.js)
  useJobIO(dbJobIO);

  // a job's secrets come sealed from the controller : the key only stores this RTE's token when it
  // registers itself (RTE_REGISTER). Without registration it needs no ENCRYPTION_SECRET at all.
  if (appConfig.encryptionSecretIsDefault && String(process.env.RTE_REGISTER ?? "").trim() !== "0") {
    logger.warning('[SECURITY] ENCRYPTION_SECRET is not set. This RTE registers itself and stores its token encrypted with the default key, which is public in the source code: set the same ENCRYPTION_SECRET as the controller, or RTE_REGISTER=0 and add the runner under Connections > Runners or in the config seed.');
  }
  // not ready until the database work below is done
  starting = true;
  onShutdown("database", () => mysql.end());
  // registered after the database : run before it closes, the running playbooks still write
  stopWithin((drainSeconds() + 8) * 1000);
  onShutdown("running jobs", drainJobs);

  const app = express();
  app.disable("x-powered-by");
  // the request's id in the response and the log lines (lib/requestContext.js)
  app.use(requestContext);
  app.use(httpMetrics);
  app.use(express.json({ limit: "100kb" }));
  const api = express.Router();
  api.use(bearer(token));
  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    logger.error(`RTE: ${req.method} ${req.path}: ${err.message || err}`);
    res.status(500).json({ error: err.message || String(err) });
  });
  api.get("/health", wrap(async (req, res) => res.json({
    id: runnerIdentity(),
    version,
    contract: RTE_CONTRACT,
    ansible: await ansibleVersion(),
    running: [...activeJobs],
    maxJobs: maxJobs(),
    stopping: isStopping(),
    starting,
  })));
  api.post("/jobs", wrap(acceptJob));
  api.get("/jobs/:id", wrap(jobStatus));
  api.post("/jobs/:id/cancel", wrap(cancelJob));
  app.use("/rte/v1", api);
  // liveness and readiness, without the token : for a load balancer or kubernetes (lib/readiness.js).
  // Live answers as soon as it listens. Ready is false while it starts (the database or its schema
  // not there yet) and while it stops (drain) : no new job is routed to it
  const probes = readinessHandlers(mysql);
  app.get("/live", probes.live);
  app.get("/ready", (req, res) => (starting ? res.status(503).json({ status: "not ready", reason: "starting" }) : probes.ready(req, res)));
  // Prometheus metrics, with METRICS_TOKEN only (lib/metrics.js)
  addScrapeGauge("af_rte_running_jobs", "The playbooks this RTE runs now", [], async (g) => g.set(activeJobs.size));
  addScrapeGauge("af_rte_max_jobs", "How many playbooks this RTE runs at once (RTE_MAX_JOBS, 0: no limit)", [], async (g) => g.set(maxJobs()));
  app.get("/metrics", metricsHandler());

  const port = appConfig.port;
  const server = httpsConfig.https
    ? https.createServer({ ...httpServerOptions(), key: httpsConfig.httpsKey, cert: httpsConfig.httpsCert }, app)
    : http.createServer(httpServerOptions(), app);
  // a port that is taken is fatal : an RTE that heartbeats but listens nowhere looks alive
  server.on("error", (err) => {
    console.error(`RTE: cannot listen on port ${port}: ${err.message}`);
    process.exit(1);
  });
  // a stop : no new jobs. A playbook still running ends with the container ; this RTE abandons
  // it when it comes back under the same name, the worker when it does not
  onShutdown("server", () => new Promise((resolve) => server.close(() => resolve())));
  // listening first : on a fresh install the controller may still be creating the schema, and an RTE
  // that waits for it without listening looks hung to its probes
  // every interface, unless LISTEN_HOST names one
  const host = listenHost();
  await new Promise((resolve) => server.listen(port, host, resolve));
  logger.notice(`RTE '${runnerIdentity()}' ${version} listening on ${httpsConfig.https ? "https" : "http"} ${host ? `${host}:` : "port "}${port}, waiting for the database`);

  try {
    // the database and its schema, then the jobs a previous start left running ; false : the
    // process stops meanwhile, and the shutdown does the rest
    if (!(await prepareDatabase({ firstDelayMs, maxDelayMs }))) return;
    // its log to the syslog servers of Connections > Syslog : an RTE follows no epochs, so it
    // reads them again every minute
    await startSyslogServers({ pollMs: 60000 });
    // its row in `nodes` : the Status page lists it, and when it stops answering the worker ends
    // the jobs it was running (Job.abandonDeadNodes) - a pod replaced under a new name included
    startHeartbeat();
    // and its row under Connections > Runners (rte/register.js), in the background : a database
    // being upgraded may not have the runners table yet
    const registering = registerSelf(process.env, { https: !!httpsConfig.https, port: appConfig.port });
    if (registering) onShutdown("registration", () => registering.stop());
    // the same check, hourly : nothing of ours should still say 'running' after a day - except
    // what this RTE is running right now, which ends by itself
    setInterval(() => {
      const running = [...activeJobs];
      mysql.do(
        "UPDATE AnsibleForms.`jobs` SET status='abandoned', abort_requested=0 WHERE status='running' AND host=? AND start < (NOW() - INTERVAL 1 DAY)" +
          (running.length ? " AND id NOT IN (?)" : ""),
        running.length ? [runnerIdentity(), running] : [runnerIdentity()]
      ).then((r) => {
        if (r?.changedRows) publish("jobs");
      }).catch((e) => logger.error(`RTE: hourly cleanup failed: ${e.message}`));
    }, 3600 * 1000).unref();
  } catch (err) {
    // a start that failed halfway : listening but never ready. Exit, the container restarts it
    logger.crit(`RTE: start failed, exiting to restart clean: ${err?.stack || err}`);
    process.exit(1);
    return;
  }
  starting = false;
  logger.notice(`RTE '${runnerIdentity()}' ready to run jobs`);
}
