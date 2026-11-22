'use strict';
// The app's own maintenance tasks (services/cron.service.js initializeSystemTasks), and the record
// of their runs (the system_task_runs table), as Jobs > System shows them.
//
// Each task is declared once here : its key, when it runs by default (its cron), what it does,
// the setting it applies and the setting of its cron. The scheduler registers it with that cron, and the
// API (models/systemTask.model.js) describes it from the same entry, so the two cannot disagree.
//
// Every task's cron is an admin's to change (its schedule setting, JOB_CLEANUP_CRON and the like,
// on the task's Schedule tab) : the declared cron is then only the default, and taskCron answers
// the one in force. The config seed reload's was a number of seconds before 7.8.0
// (CONFIG_SEED_RELOAD_SECONDS) : still read, deprecated, as a cron (lib/seedReloadCron.js).
//
// The runner hub's own loops (runners/rteHub.js : dispatch, inbound dial, ended jobs prune) are
// listed beside them (HUB_LOOPS) : they run every few seconds on their own timers (lib/hubLoops.js),
// each as often as its setting of seconds says (RUNNER_DISPATCH_SECONDS and the like, on the
// loop's Schedule tab : a cron's smallest step, a minute, is too coarse for them). What they did
// is kept in memory on each node (lib/hubLoops.js) ; their rows are a summary of each hour per
// node, a Run now pass each, and their timed failures, one per distinct error a minute at most.
//
// Each run writes one row : when it started and ended, its outcome (success or failed), a short
// result (removed 120 jobs, or the error) and the node that ran it ; every run, the ones of every
// minute that changed nothing too, so the Runs tab shows each of them. The table keeps itself
// small : its rows older than RUNS_KEEP_DAYS go, and a task keeps RUNS_KEEP_PER_TASK rows at most
// (a task of every minute : its last 16 hours or so).
import logger from './logger.js';
import mysql from '../models/db.model.js';
import { nodeId } from './role.js';
import { cronError } from './cronValidate.js';
import appConfig from '../../config/app.config.js';
import { secondsToCron } from './seedReloadCron.js';

// ─── the tasks ───────────────────────────────────────────────────────────────

// the retention settings' tab of Settings > System > General (pages/admin/settings.vue)
const RETENTION_TAB = 'retention';

/**
 * A task's schedule setting : the environment variable of its cron (changed on the task's own
 * page, Jobs > System > the task > Schedule) and its appConfig key ; for the config seed reload,
 * the deprecated variable of before it too.
 *
 * Args:
 *   env (string): the variable (JOB_CLEANUP_CRON).
 *   config (string): its appConfig key (jobCleanupCron).
 *   deprecated (object|null): the variable it replaces, still read while it is not set :
 *     { env, config, toCron } (toCron : the old value as { cron, off, exact }) ; null for none.
 *
 * Returns:
 *   object: { env, config, deprecated }.
 */
const scheduleSetting = (env, config, deprecated = null) => ({ env, config, deprecated });

/**
 * The maintenance tasks, in the order the scheduler registers them.
 *
 *   key: the task's name in the scheduler and in the table
 *   cron: when it runs by default (the app's timezone, LOG_TZ)
 *   name, description: what it is, in English, as the API answers it (the GUI says it in the user's
 *     language : client/src/locales, jobs.system.tasks)
 *   setting: the setting it applies - its environment variable (env), its appConfig key (config)
 *     and the tab of Settings > System > General it is changed on (tab) ; null for none
 *   schedule: the setting that changes its cron (scheduleSetting), the cron above then only its
 *     default
 */
export const SYSTEM_TASKS = [
  {
    key: 'abandonedJobs',
    cron: '0 * * * *',
    name: 'Abandoned jobs',
    description: 'Ends the jobs that ran a day without output and no runner took.',
    setting: null,
    schedule: scheduleSetting('ABANDONED_JOBS_CRON', 'abandonedJobsCron'),
  },
  {
    key: 'deadNodes',
    cron: '* * * * *',
    name: 'Stopped nodes',
    description: 'Frees what nodes and runners that stopped answering held.',
    setting: null,
    schedule: scheduleSetting('DEAD_NODES_CRON', 'deadNodesCron'),
  },
  {
    key: 'scheduleEnds',
    cron: '* * * * *',
    name: 'Schedule ends',
    description: 'Turns off or removes the schedules that reached their end.',
    setting: null,
    schedule: scheduleSetting('SCHEDULE_ENDS_CRON', 'scheduleEndsCron'),
  },
  {
    key: 'scheduleResync',
    cron: '*/5 * * * *',
    name: 'Schedule resync',
    description: 'Registers the schedules and repository pulls changed on any node.',
    setting: null,
    schedule: scheduleSetting('SCHEDULE_RESYNC_CRON', 'scheduleResyncCron'),
  },
  {
    key: 'tokenCleanup',
    cron: '0 3 * * *',
    name: 'Expired tokens',
    description: 'Removes expired sign-in tokens, revocations and API tokens.',
    setting: null,
    schedule: scheduleSetting('TOKEN_CLEANUP_CRON', 'tokenCleanupCron'),
  },
  {
    key: 'auditCleanup',
    cron: '30 3 * * *',
    name: 'Audit log cleanup',
    description: 'Removes audit log entries older than the audit retention.',
    setting: { env: 'AUDIT_RETENTION_DAYS', config: 'auditRetentionDays', tab: RETENTION_TAB },
    schedule: scheduleSetting('AUDIT_CLEANUP_CRON', 'auditCleanupCron'),
  },
  {
    key: 'jobCleanup',
    cron: '30 2 * * *',
    name: 'Job cleanup',
    description: 'Removes finished jobs older than the job retention.',
    setting: { env: 'JOB_RETENTION_DAYS', config: 'jobRetentionDays', tab: RETENTION_TAB },
    schedule: scheduleSetting('JOB_CLEANUP_CRON', 'jobCleanupCron'),
  },
  {
    key: 'nightlyBackup',
    cron: '0 0 * * *',
    name: 'Nightly backup',
    description: 'Backs up the database and removes the oldest nightly backups.',
    setting: { env: 'NIGHTLY_BACKUP_RETENTION', config: 'nightlyBackupRetention', tab: RETENTION_TAB },
    schedule: scheduleSetting('NIGHTLY_BACKUP_CRON', 'nightlyBackupCron'),
  },
  {
    key: 'storedJobsCleanup',
    cron: '0 4 * * *',
    name: 'Stored jobs cleanup',
    description: 'Removes expired or unused stored jobs, and forgets old nodes.',
    setting: { env: 'STORED_JOB_UNUSED_DAYS', config: 'storedJobUnusedDays', tab: RETENTION_TAB },
    schedule: scheduleSetting('STORED_JOB_CLEANUP_CRON', 'storedJobCleanupCron'),
  },
  {
    key: 'configSeedReload',
    cron: '* * * * *',
    name: 'Config seed reload',
    description: 'Applies the config seed again when its file changes.',
    setting: null,
    // before 7.8.0 a number of seconds (CONFIG_SEED_RELOAD_SECONDS) : deprecated, removed in 8.0.0,
    // still read as a cron while CONFIG_SEED_RELOAD_CRON is not set
    schedule: scheduleSetting('CONFIG_SEED_RELOAD_CRON', 'configSeedReloadCron', {
      env: 'CONFIG_SEED_RELOAD_SECONDS',
      config: 'configSeedReloadSeconds',
      toCron: secondsToCron,
    }),
  },
];

// the tasks by their key
const TASKS = new Map(SYSTEM_TASKS.map((task) => [task.key, task]));

/**
 * A runner hub loop's schedule setting : the environment variable of its seconds (changed on the
 * loop's own page, Jobs > System > the loop > Schedule), its appConfig key, and the seconds it
 * takes, whole, from min to max.
 *
 * Args:
 *   env (string): the variable (RUNNER_DISPATCH_SECONDS).
 *   config (string): its appConfig key (runnerDispatchSeconds).
 *   min (number): the fewest seconds.
 *   max (number): the most seconds.
 *
 * Returns:
 *   object: { env, config, min, max }.
 */
const secondsSetting = (env, config, min, max) => ({ env, config, min, max });

/**
 * The runner hub's own loops (runners/rteHub.js), listed after the tasks : each runs every so many
 * seconds on its own timer (lib/hubLoops.js), on every controller node, its seconds a setting.
 *
 *   key: the loop's name in the table of runs (its failures) and in the API
 *   seconds: how often it runs by default
 *   name, description: what it is, in English, as the API answers it (the GUI says it in the
 *     user's language : client/src/locales, jobs.system.tasks)
 *   schedule: the setting of its seconds and their bounds (secondsSetting), the seconds above then
 *     only its default
 */
export const HUB_LOOPS = [
  {
    key: 'runnerDispatch',
    seconds: 2,
    name: 'Runner dispatch',
    description: 'Hands the waiting jobs and the cancels to their runners.',
    schedule: secondsSetting('RUNNER_DISPATCH_SECONDS', 'runnerDispatchSeconds', 1, 60),
  },
  {
    key: 'runnerDial',
    seconds: 10,
    name: 'Runner inbound dial',
    description: 'Dials the inbound runners this node may hold.',
    schedule: secondsSetting('RUNNER_DIAL_SECONDS', 'runnerDialSeconds', 2, 300),
  },
  {
    key: 'runnerPrune',
    seconds: 60,
    name: 'Runner ended jobs prune',
    description: 'Lets go what this node kept of jobs that ended elsewhere.',
    schedule: secondsSetting('RUNNER_PRUNE_SECONDS', 'runnerPruneSeconds', 10, 3600),
  },
];

// the loops by their key
const LOOPS = new Map(HUB_LOOPS.map((loop) => [loop.key, loop]));

/**
 * One of the runner hub's loops by its key.
 *
 * Args:
 *   key (string): the loop's key (runnerDispatch).
 *
 * Returns:
 *   object|null: its entry of HUB_LOOPS, or null for a key no loop has.
 */
export function hubLoop(key) {
  return LOOPS.get(String(key)) || null;
}

// every loop's setting of seconds, by its variable
export const LOOP_SETTINGS = HUB_LOOPS.map((loop) => ({
  key: loop.key,
  env: loop.schedule.env,
  config: loop.schedule.config,
  default: loop.seconds,
  min: loop.schedule.min,
  max: loop.schedule.max,
}));

/**
 * Why a value cannot be a loop's seconds, or null when it can : a whole number from the loop's
 * fewest seconds to its most.
 *
 * Args:
 *   loop (object): the loop's entry of HUB_LOOPS.
 *   value (number|string): the seconds.
 *
 * Returns:
 *   string|null: the problem, in English, or null.
 */
export function loopSecondsProblem(loop, value) {
  const { min, max } = loop.schedule;
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const n = /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return `must be a whole number of seconds from ${min} to ${max}`;
  return null;
}

/**
 * How often a loop runs : its setting's seconds when set and valid, else its default. A value
 * out of its bounds (written by hand in the environment, never through the app, which checks it)
 * is passed over for the default.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   number: its seconds.
 *
 * Raises:
 *   Error: when no loop has that key.
 */
export function loopSeconds(key) {
  const loop = hubLoop(key);
  if (!loop) throw new Error(`No runner hub loop is named ${key}`);
  const set = scheduleValue(loop);
  if (!set || loopSecondsProblem(loop, set)) return loop.seconds;
  return parseInt(set, 10);
}

/**
 * A maintenance task by its key.
 *
 * Args:
 *   key (string): the task's key (jobCleanup).
 *
 * Returns:
 *   object|null: its entry of SYSTEM_TASKS, or null for a key no task has.
 */
export function systemTask(key) {
  return TASKS.get(String(key)) || null;
}

// every task's cron setting, by its variable
export const SCHEDULE_SETTINGS = SYSTEM_TASKS.filter((task) => task.schedule).map((task) => ({
  key: task.key,
  env: task.schedule.env,
  config: task.schedule.config,
  default: task.cron,
}));

/**
 * Why a cron cannot be a task's schedule, or null when it can : five fields (minute, hour,
 * day of the month, month, day of the week ; croner's sixth, the seconds, is not offered), that
 * croner accepts and that occurs again (lib/cronValidate.js, the schedules' own check).
 *
 * Args:
 *   cron (string): the cron.
 *
 * Returns:
 *   string|null: the problem, in English, or null.
 */
export function scheduleCronProblem(cron) {
  const value = String(cron ?? '').trim();
  if (!value) return 'must be a cron expression';
  if (value.split(/\s+/).length !== 5) return 'must be a cron of 5 fields (minute hour day month weekday)';
  const problem = cronError(value);
  return problem ? `is not a cron that runs: ${problem}` : null;
}

/**
 * The cron a task runs on : its schedule setting's when one is set and valid, else the deprecated
 * variable's it replaces when that one is set (the config seed reload's seconds, as a cron that
 * may have 6 fields), else the declared one. A value that is not a valid cron (written by hand in
 * the environment, never through the app, which checks it) is passed over for the declared one,
 * and the scheduler logs it.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   string: its cron (the declared one for a deprecated value that turns the task off : it does
 *     not run, taskEnabled says so).
 *
 * Raises:
 *   Error: when no task has that key : a typo in the scheduler fails at its start rather than
 *     registering nothing.
 */
export function taskCron(key) {
  const task = systemTask(key);
  if (!task) throw new Error(`No system task is named ${key}`);
  const set = scheduleValue(task);
  if (set) return scheduleCronProblem(set) ? task.cron : set;
  const deprecated = deprecatedSchedule(task);
  return deprecated?.cron || task.cron;
}

/**
 * The deprecated variable a task's cron still comes from : set, and the schedule setting that
 * replaces it not set (which always wins). Only the config seed reload has one
 * (CONFIG_SEED_RELOAD_SECONDS, lib/seedReloadCron.js).
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *
 * Returns:
 *   object|null: { env, value, cron, off, exact }, or null when none is in force.
 */
export function deprecatedSchedule(task) {
  const deprecated = task?.schedule?.deprecated;
  if (!deprecated || scheduleValue(task)) return null;
  const value = String(appConfig[deprecated.config] ?? '').trim();
  if (!value) return null;
  return { env: deprecated.env, value, ...deprecated.toCron(value) };
}

/**
 * Whether a task runs here and now : the config seed reload only with a seed (CONFIG_SEED_PATH)
 * and not turned off by its deprecated seconds (0), every other task always.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   boolean: true when it runs.
 */
export function taskEnabled(key) {
  const task = systemTask(key);
  if (!task) return false;
  if (task.key === 'configSeedReload') return !!appConfig.configSeedPath && !deprecatedSchedule(task)?.off;
  return true;
}

/**
 * The value a task's schedule setting holds, as it is set ('' : not set, the default applies) : a
 * task's cron, or a runner hub loop's seconds.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS, or a loop's of HUB_LOOPS.
 *
 * Returns:
 *   string: the setting's value, trimmed ; '' for a task without one.
 */
export function scheduleValue(task) {
  if (!task?.schedule) return '';
  return String(appConfig[task.schedule.config] ?? '').trim();
}

// ─── the record of their runs ────────────────────────────────────────────────

// the rows kept : this many days, and this many per task at most (a task of every minute that
// changes something at every run would otherwise add 1440 rows a day)
export const RUNS_KEEP_DAYS = 30;
export const RUNS_KEEP_PER_TASK = 1000;
// the table is pruned at most this often, after a run is recorded
export const PRUNE_EVERY_MS = 60 * 60 * 1000;
// the longest result kept (the column's size)
const RESULT_MAX = 1000;

// when this process last pruned the table (0 : not yet, the first recorded run does)
let lastPrune = 0;

/**
 * A count with its noun, singular or plural : "1 job", "120 jobs".
 *
 * Args:
 *   n (number): the count.
 *   one (string): the noun for one.
 *   many (string): the noun for several (one + 's' when not given).
 *
 * Returns:
 *   string: the count and its noun.
 */
export function counted(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The parts of a result as one sentence : joined with commas, its first letter a capital.
 *
 * Args:
 *   parts (string[]): what the run did, each in a few words (removed 2 runners).
 *   empty (string): the sentence when there is no part (Nothing to free).
 *
 * Returns:
 *   string: the sentence.
 */
export function sentence(parts, empty) {
  const text = (parts || []).filter(Boolean).join(', ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : empty;
}

/**
 * Removes the old rows of the table : the ones older than RUNS_KEEP_DAYS, then each task's
 * beyond its latest RUNS_KEEP_PER_TASK. Never throws : a failure is logged, and the next prune
 * tries again.
 *
 * Returns:
 *   Promise<number>: the rows removed.
 */
export async function pruneRuns() {
  let removed = 0;
  try {
    // step 1 : the rows older than the days kept (started_at is UTC)
    const old = await mysql.do(
      'DELETE FROM AnsibleForms.`system_task_runs` WHERE started_at < UTC_TIMESTAMP() - INTERVAL ? DAY',
      [RUNS_KEEP_DAYS],
      true,
    );
    removed += old?.affectedRows || 0;
    // step 2 : each task's rows beyond the ones kept, its latest first (a derived table : MySQL
    // takes no LIMIT in an IN subquery)
    for (const task of [...SYSTEM_TASKS, ...HUB_LOOPS]) {
      const extra = await mysql.do(
        'DELETE FROM AnsibleForms.`system_task_runs` WHERE task_key = ? AND id NOT IN (' +
          'SELECT id FROM (SELECT id FROM AnsibleForms.`system_task_runs` WHERE task_key = ? ' +
          'ORDER BY started_at DESC, id DESC LIMIT ?) kept)',
        [task.key, task.key, RUNS_KEEP_PER_TASK],
        true,
      );
      removed += extra?.affectedRows || 0;
    }
    if (removed > 0) logger.debug(`Removed ${removed} old run(s) of the system tasks`);
  } catch (err) {
    logger.warning(`Could not prune the runs of the system tasks: ${err.message || err}`);
  }
  return removed;
}

/**
 * Writes one run of a task, a row of its own. Never throws : a run that cannot be written is
 * logged (unless quiet : its caller says it), the task itself has run.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS (or a loop's of HUB_LOOPS : its hourly
 *     summary, a Run now pass or a timed failure).
 *   run (object): { startedAt (Date), endedAt (Date), outcome (success, failed), result (string),
 *     changed (number : what the run changed, 0 for nothing) }.
 *   options (object): { onError (function|null) : a row that cannot be written is handed to it,
 *     (err) => ..., instead of logged here : the caller logs it (lib/hubLoops.js, once an hour) }.
 *
 * Returns:
 *   Promise<boolean>: whether the run was written.
 */
export async function recordRun(task, run, { onError = null } = {}) {
  const result = String(run.result ?? '').slice(0, RESULT_MAX);
  try {
    // step 1 : its row
    await mysql.do(
      'INSERT INTO AnsibleForms.`system_task_runs` (task_key, started_at, ended_at, outcome, result, node) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      [task.key, run.startedAt, run.endedAt, run.outcome, result, nodeId],
      true,
    );
  } catch (err) {
    if (onError) onError(err);
    else logger.warning(`Could not record the run of the system task ${task.key}: ${err.message || err}`);
    return false;
  }
  // step 2 : the table kept small, once an hour at most
  if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    await pruneRuns();
  }
  return true;
}

/**
 * A task's run, recorded : the run's own work, then one row (recordRun) with its outcome and
 * result. The work returns { result, changed, failed } :
 *   result: what it did, in a few words (Removed 120 jobs) ;
 *   changed: how much it changed (0 : nothing) ;
 *   failed: true when a part of it failed (its result then says what).
 * A work that throws is a failed run, with the error as its result ; the error is logged and
 * goes no further, as the tasks never threw into the scheduler.
 *
 * Args:
 *   key (string): the task's key.
 *   fn (function): the run's work, async.
 *
 * Returns:
 *   function: the recorded run, async, resolving to the run written ({ outcome, result, changed }).
 *
 * Raises:
 *   Error: when no task has that key (at the scheduler's start).
 */
export function recorded(key, fn) {
  const task = systemTask(key);
  if (!task) throw new Error(`No system task is named ${key}`);
  return async (...args) => {
    // step 1 : the work
    const startedAt = new Date();
    let run;
    try {
      const out = (await fn(...args)) || {};
      run = {
        outcome: out.failed ? 'failed' : 'success',
        result: out.result || '',
        changed: Number(out.changed) || 0,
      };
    } catch (err) {
      logger.error(`The system task ${key} failed:`, err);
      run = { outcome: 'failed', result: err?.message || String(err), changed: 0 };
    }
    // step 2 : its row
    await recordRun(task, { ...run, startedAt, endedAt: new Date() });
    return run;
  };
}

// tests only : the next recorded run prunes again
export function resetPruneForTests() {
  lastPrune = 0;
}

export default { SYSTEM_TASKS, HUB_LOOPS, SCHEDULE_SETTINGS, LOOP_SETTINGS, systemTask, hubLoop, loopSeconds, loopSecondsProblem, taskCron, deprecatedSchedule, taskEnabled, scheduleValue, scheduleCronProblem, counted, sentence, pruneRuns, recordRun, recorded };
