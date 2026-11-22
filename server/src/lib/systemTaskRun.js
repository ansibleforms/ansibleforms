'use strict';
// Run now (POST /api/v2/system/tasks/:key/run) : a system task (lib/systemTasks.js) run once, at
// once, recorded as a scheduled run is (one row of system_task_runs, its outcome and result).
//
// The tasks run on one node only : the one whose scheduler started them (the worker lock,
// services/cron.service.js systemTasksStarted), where each is a croner job. A request may reach
// any node, so :
//   - on that node, the task's croner job is triggered : its run is the scheduled one's (the
//     worker lock confirmed, then the recorded run), and croner counts it busy meanwhile, so a
//     tick that falls during it is skipped (protect) and a second Run now is refused ;
//   - on another node, the request is handed to it as the app hands everything to the worker :
//     a change notice (lib/epochs.js, runNotice), which the worker reacts to (init/cluster.js)
//     within a few seconds. Its run is then waited for in the table, its new row, a while at most.
// Nothing ever runs a task's work outside its croner job on the worker : two nodes never run a
// task at once, and a run is never started on top of another.
//
// Its row says who launched it (launched_by). On the node that runs the tasks, the run takes it as
// it starts (services/cron.service.js runSystemTaskNow). A change notice carries nothing but its
// name, so a run handed to the worker is recorded without it, and the node that handed it writes
// it on the run's row once that row is there (stampLauncher) : the first row of the task after the
// notice, the one the request already waits for (a timed tick during the run is skipped).
//
// The nightly backup is not waited for (LONG_TASKS) : a backup of a large database takes
// minutes, longer than a proxy keeps a request open. It is answered at once (202), the page
// follows it.
import logger from './logger.js';
import mysql from '../models/db.model.js';
import { bump } from './epochs.js';
import { confirmWorkerLock } from './workerLock.js';
import { listNodes, heartbeat } from './nodes.js';
import { SYSTEM_TASKS } from './systemTasks.js';
import cronService from '../services/cron.service.js';

// ─── settings ────────────────────────────────────────────────────────────────

// the tasks answered once started, not once ended : they may outlast a request
export const LONG_TASKS = new Set(['nightlyBackup']);
// how long a node waits for the run it handed to the worker, then answers that it started
export const FORWARD_WAIT_MS = 20000;
// how often it looks for the run's row meanwhile
export const FORWARD_POLL_MS = 500;
// a run handed to the worker that was not waited for (a backup, or one longer than the wait) : how
// long its row is looked for after, to write who launched it, and how often
export const FOLLOW_MS = 2 * 60 * 60 * 1000;
export const FOLLOW_POLL_MS = 10000;

// the tasks this node handed to the worker and still waits for : a second Run now is refused
const forwarding = new Set();
// the follows going (followRun), bumped to end them all (tests)
let followGeneration = 0;

/**
 * The name of the change notice that asks the worker to run a task now (lib/epochs.js).
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   string: the notice's name (systemtask-run:jobCleanup).
 */
export function runNotice(key) {
  return `systemtask-run:${key}`;
}

/**
 * Whether this process runs the system tasks now : its scheduler started them, and it still
 * holds the worker lock (asked of the database, as every scheduled run asks).
 *
 * Returns:
 *   Promise<boolean>: true when the tasks run here.
 */
export async function runsHere() {
  if (!cronService.systemTasksStarted) return false;
  return confirmWorkerLock().catch(() => false);
}

/**
 * The tasks whose run is going on now : this node's croner jobs when the tasks run here, else
 * what the worker last said of them with its heartbeat (lib/nodes.js, every few seconds), and the
 * ones this node handed to it and waits for.
 *
 * Returns:
 *   Promise<Set<string>>: the keys of the tasks running.
 */
export async function busyTasks() {
  const busy = new Set(forwarding);
  // step 1 : here, the scheduler knows
  if (await runsHere()) {
    for (const task of SYSTEM_TASKS) if (cronService.systemTaskBusy(task.key)) busy.add(task.key);
    return busy;
  }
  // step 2 : elsewhere, the worker's last word
  const worker = await liveWorker();
  for (const task of worker?.info?.scheduler?.tasks || []) if (task.busy) busy.add(task.name);
  return busy;
}

/**
 * The live worker's row in `nodes`, or null when no process holds the worker lock.
 *
 * Returns:
 *   Promise<object|null>: the node, as lib/nodes.js listNodes answers it.
 */
async function liveWorker() {
  const nodes = await listNodes().catch(() => []);
  return nodes.find((n) => n.isWorker && n.alive) || null;
}

/**
 * The id of a task's latest row of system_task_runs, 0 for none.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   Promise<number>: the id.
 */
async function latestRunId(key) {
  const rows = await mysql.do('SELECT MAX(id) AS id FROM AnsibleForms.`system_task_runs` WHERE task_key = ?', [key], true);
  return Number(rows?.[0]?.id) || 0;
}

/**
 * Waits for a task's new row (one after `after`), a while at most.
 *
 * Args:
 *   key (string): the task's key.
 *   after (number): the id of its latest row before the run.
 *   waitMs (number): the most to wait (FORWARD_WAIT_MS by default).
 *   pollMs (number): how often to look (FORWARD_POLL_MS by default).
 *   unref (boolean): whether its timers keep the process up (false : a follow in the background).
 *
 * Returns:
 *   Promise<number>: the new row's id once the run was recorded, 0 when the wait is over first.
 */
async function waitForRun(key, after, waitMs = FORWARD_WAIT_MS, pollMs = FORWARD_POLL_MS, unref = false) {
  const generation = followGeneration;
  const until = Date.now() + waitMs;
  while (Date.now() < until && generation === followGeneration) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      if (unref) timer.unref?.();
    });
    const latest = await latestRunId(key);
    if (latest > after) return latest;
  }
  return 0;
}

/**
 * Writes who launched a run on its row, handed to the worker and recorded there without it (a
 * change notice carries nothing). A row that already names someone is left as it is. Never
 * throws : a launcher that cannot be written is logged, the run itself is recorded.
 *
 * Args:
 *   id (number): the run's row.
 *   launchedBy (string|null): who launched it (lib/systemTasks.js launcherName) ; null writes nothing.
 *
 * Returns:
 *   Promise<void>: once written.
 */
export async function stampLauncher(id, launchedBy) {
  if (!id || !launchedBy) return;
  try {
    await mysql.do(
      'UPDATE AnsibleForms.`system_task_runs` SET launched_by = ? WHERE id = ? AND launched_by IS NULL',
      [launchedBy, id],
      true,
    );
  } catch (err) {
    logger.warning(`Could not write who launched the system task run ${id}: ${err.message || err}`);
  }
}

/**
 * Follows a run handed to the worker that the request does not wait for (a backup, or one that
 * outlasted the wait), in the background : its row is looked for FOLLOW_MS at most, then who
 * launched it written on it. Never throws, never keeps the process up.
 *
 * Args:
 *   key (string): the task's key.
 *   after (number): the id of its latest row before the run.
 *   launchedBy (string|null): who launched it ; null follows nothing.
 */
function followRun(key, after, launchedBy) {
  if (!launchedBy) return;
  waitForRun(key, after, FOLLOW_MS, FOLLOW_POLL_MS, true)
    .then((id) => stampLauncher(id, launchedBy))
    .catch(() => {});
}

/**
 * Runs a task now (it is known and on : the caller checked), here when the tasks run here, else
 * on the worker through its change notice.
 *
 * Args:
 *   key (string): the task's key.
 *   launchedBy (string|null): who launched it (lib/systemTasks.js launcherName), written on its
 *     row ; null for none.
 *
 * Returns:
 *   Promise<object>: { status, node } :
 *     status: 'done' (the run ended, recorded), 'started' (still running : a long task, or one
 *       the worker had not ended within the wait), 'busy' (a run of it is going, none started),
 *       'off' (the scheduler has no job for it) or 'noWorker' (no process runs the tasks) ;
 *     node: where it runs ('this node' or the worker's name).
 */
export async function runNow(key, launchedBy = null) {
  // step 1 : the tasks run here, its croner job triggered, the run taking who launched it
  if (await runsHere()) {
    const started = cronService.runSystemTaskNow(key, launchedBy);
    if (started.status !== 'started') return { status: started.status, node: 'this node' };
    if (LONG_TASKS.has(key)) return { status: 'started', node: 'this node' };
    await started.done;
    return { status: 'done', node: 'this node' };
  }
  // step 2 : elsewhere, the worker asked through its change notice ; a run going refused first
  if ((await busyTasks()).has(key)) return { status: 'busy', node: null };
  const worker = await liveWorker();
  if (!worker) return { status: 'noWorker', node: null };
  forwarding.add(key);
  try {
    const after = await latestRunId(key);
    await bump(runNotice(key));
    logger.info(`Asked the worker ${worker.id} to run the system task ${key} now`);
    // step 3 : its row, who launched it written on it once there (followed after the answer when
    // it is not waited for)
    if (LONG_TASKS.has(key)) {
      followRun(key, after, launchedBy);
      return { status: 'started', node: worker.id };
    }
    const id = await waitForRun(key, after);
    if (!id) {
      followRun(key, after, launchedBy);
      return { status: 'started', node: worker.id };
    }
    await stampLauncher(id, launchedBy);
    return { status: 'done', node: worker.id };
  } finally {
    forwarding.delete(key);
  }
}

/**
 * The worker's side of a Run now asked on another node (its change notice, init/cluster.js) :
 * the task's croner job triggered, not awaited (the notices wait for nothing that lasts), and
 * the heartbeat written at its start and end, so the other nodes see it running.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   string: what happened, as runSystemTaskNow says it (started, busy, off).
 */
export function runNoticed(key) {
  const started = cronService.runSystemTaskNow(key);
  if (started.status === 'busy') {
    logger.info(`Run now of the system task ${key} asked on another node : a run of it is going, none started`);
  }
  if (started.status === 'started') {
    logger.info(`Running the system task ${key} now, as asked on another node`);
    heartbeat().catch(() => {});
    started.done.finally(() => heartbeat().catch(() => {}));
  }
  return started.status;
}

// tests only : nothing handed to the worker, no run followed
export function resetRunsForTests() {
  forwarding.clear();
  followGeneration++;
}

export default { LONG_TASKS, runNotice, runsHere, busyTasks, runNow, runNoticed, stampLauncher };
