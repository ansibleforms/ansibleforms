// What this process runs (AF_ROLE), and the name it goes by among the other processes on
// the same database.
//
//   all (unset) : the controller's web interface, its API and the worker in one process, the way
//                 AnsibleForms always ran
//   controller  : the web interface and the API only - run as many as you like behind a load
//                 balancer ; app, its name before 7.8, still works (deprecated, removed in 8.0.0)
//   worker      : the background work only - schema, seed, schedules, backups, repository
//                 syncs, cleanups. One holds the worker lock (lib/workerLock.js), others wait.
//   rte         : a runtime environment that runs playbooks (src/rte/server.js)
import os from "os";

export const ROLES = ["all", "controller", "worker", "rte"];

// the role names of before, still read : app is the controller (lib/controllerEnv.js says it)
const OLD_ROLES = { app: "controller" };

/**
 * The role AF_ROLE gives, as given : app stays app (the name its node goes by, nodeId).
 *
 * Args:
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   string: the role as written, lower case ; all when it is not set.
 */
const givenRole = (env = process.env) => String(env.AF_ROLE || "").trim().toLowerCase() || "all";

/**
 * The role this process runs : AF_ROLE, app read as controller.
 *
 * Args:
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   string: all, controller, worker or rte (or the value given, when it is none of them).
 */
export function currentRole(env = process.env) {
  const given = givenRole(env);
  return OLD_ROLES[given] || given;
}

const role = currentRole();

export const ROLE = role;
// serves the web interface and the API
export const runsWeb = role === "all" || role === "controller";
// may run the background work, once it holds the worker lock
export const runsWorker = role === "all" || role === "worker";

// The name on this process's row in `nodes`, on the jobs it follows (jobs.tracker) and, for an
// RTE, on the jobs it runs (jobs.host) : <role>-<hostname>-<port>. Unique without a setting -
// two processes on one machine listen on different ports - and the same after a restart, so a
// restarted container finds its own jobs again. A new pod gets a new name, and the worker ends
// the jobs of a node that stopped answering.
// A node started with AF_ROLE=app keeps its app- name : renamed, it would not find its own jobs
// after the upgrade that brought the controller name.
export const nodeId = `${role === "all" ? "af" : givenRole()}-${os.hostname()}-${process.env.PORT || 8000}`;

// a node whose heartbeat (lib/nodes.js, every 10 s) is older than this is gone : the worker ends
// its jobs, and a worker lock it still holds is taken from it (lib/workerLock.js)
export const NODE_DEAD_SECONDS = 120;

// How long this process has run, in whole seconds, rounded down : "a claim older than this" -
// measured with the database's clock on both sides - was taken before this process started.
export function uptimeSeconds() {
  return Math.floor(process.uptime());
}
