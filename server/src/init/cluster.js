// What makes several processes on one database behave as one AnsibleForms : every process
// (AF_ROLE unset, app or worker) writes its heartbeat (lib/nodes.js) and follows the change
// notices of the others (lib/epochs.js), dropping what it had cached about what changed.
import logger from "../lib/logger.js";
import { onEpoch, startEpochs } from "../lib/epochs.js";
import { startHeartbeat, setWorkerInfo } from "../lib/nodes.js";
import { runsWeb, runsWorker } from "../lib/role.js";
import { holdsWorkerLock } from "../lib/workerLock.js";
import EnvSettings from "../lib/envSettings.js";
import { reloadConfigSeed, getSeedState } from "../lib/seed.js";
import { clearSecretCache } from "../secrets/cache.js";
import { startSyslogServers, reloadSyslogServers } from "../lib/syslogServers.js";
import CrudModel from "../models/crud.model.js";
import Schema from "../models/schema.model.js";
import Help from "../models/help.model.js";
import cronService from "../services/cron.service.js";
import { rebuildLoginStrategies } from "../auth/loginStrategies.js";
import { SYSTEM_TASKS } from "../lib/systemTasks.js";
import { runNotice, runNoticed } from "../lib/systemTaskRun.js";

let started = false;
// the managed .env as this process last applied it
let appliedEnv = null;

/**
 * The managed .env was saved on another node (the settings page, a restore of it) : apply here
 * what it changed, the way the saving node did. Only names whose value in this process is
 * still the one the file had before - a variable set in the real environment of this
 * container wins, as it does at boot, and one this node saved itself is already in force.
 */
export async function applyChangedEnv() {
  const next = await EnvSettings.readManaged();
  const previous = appliedEnv || new Map();
  appliedEnv = next;
  const help = await Help.get().catch(() => []);
  const docs = new Map(((help.find((x) => x.name == "Environment Variables") || {}).items || []).map((x) => [x.name, x]));
  const restart = [];
  for (const name of new Set([...previous.keys(), ...next.keys()])) {
    const was = previous.get(name);
    const now = next.get(name);
    if (was === now || EnvSettings.REFUSED[name]) continue;
    if (process.env[name] === now) continue; // in force already
    if (process.env[name] !== was) continue; // set in this container's environment
    if (!EnvSettings.applyLive(name, now ?? "", docs.get(name)?.default)) restart.push(name);
  }
  if (restart.length) {
    logger.warning(`Environment settings changed on another node take effect here after a restart: ${restart.join(", ")}`);
  }
}

export async function startCluster() {
  if (started) return;
  started = true;
  appliedEnv = await EnvSettings.readManaged().catch(() => new Map());

  // a model changed : its cached rows go (CrudModel.changed bumps the model's name)
  onEpoch("*", (name) => CrudModel.flushLocal(name));
  onEpoch("secretstore", () => clearSecretCache());
  onEpoch("env", () => applyChangedEnv());
  // the syslog servers changed on another node : this process's logger follows
  onEpoch("syslogserver", () => reloadSyslogServers());
  // a database restore replaced every row
  onEpoch("restore", async () => {
    CrudModel.flushAllLocal();
    clearSecretCache();
    // the schema that came back can be an older release's (the backup taken before an upgrade) :
    // no process keeps its cached "schema is up to date", and the worker patches it again (a
    // restore on an app node waits for that, Schema.upgradeAfterRestore)
    Schema._cachedOk = null;
    if (runsWorker && holdsWorkerLock()) {
      await Schema.hasSchema().catch((err) => {
        logger.error(`The restored database could not be upgraded to this release: ${(err.result?.data?.failed || [err.message || err]).slice(0, 3).join("; ")}`);
      });
    }
    await reloadSyslogServers();
    if (runsWeb) await rebuildLoginStrategies();
    await cronService.resync();
  });
  if (runsWeb) {
    onEpoch("oauth2", () => rebuildLoginStrategies());
  }
  if (runsWorker) {
    // the cron registry follows the schedules and repositories, wherever they were edited
    onEpoch("schedule", () => cronService.resync());
    onEpoch("repositories", () => cronService.resync());
    // SIGHUP on an app node : the seed is the worker's to re-apply
    onEpoch("seed", () => {
      if (!holdsWorkerLock()) return;
      return reloadConfigSeed({ force: true, trigger: "SIGHUP" });
    });
    // Run now of a system task asked on another node (lib/systemTaskRun.js) : the node that runs
    // the tasks runs it, not awaited (a backup must not hold the other notices up)
    for (const task of SYSTEM_TASKS) {
      onEpoch(runNotice(task.key), () => {
        if (!holdsWorkerLock()) return;
        runNoticed(task.key);
      });
    }
    // what the Status page of any node shows about the scheduler and the seed
    setWorkerInfo(() => ({ scheduler: cronService.describe(), seed: getSeedState() }));
  }

  // the server log and the audit entries to the syslog servers of Connections > Syslog
  await startSyslogServers();
  startHeartbeat();
  startEpochs();
}
