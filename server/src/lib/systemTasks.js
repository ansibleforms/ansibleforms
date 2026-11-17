'use strict';
// The app's own maintenance tasks (services/cron.service.js initializeSystemTasks), and the record
// of their runs (the system_task_runs table), as Jobs > System shows them.
//
// Each task is declared once here : its key, when it runs (its cron, or every so many seconds),
// what it does, and the setting it applies. The scheduler registers it with that cron, and the
// API (models/systemTask.model.js) describes it from the same entry, so the two cannot disagree.
//
// The nightly tasks' cron is an admin's to change (their schedule setting, JOB_CLEANUP_CRON and
// the like) : the declared cron is then only the default, and taskCron answers the one in force.
// The tasks of every minute and the seed reload keep theirs : the app needs them that often.
//
// Each run writes one row : when it started and ended, its outcome (success or failed), a short
// result (removed 120 jobs, or the error) and the node that ran it. A task that runs every minute
// (or more often) does not add a row for a run that changed nothing : it rewrites one row of its
// own instead (quiet_of), so its latest run stays known without a row a minute. The table keeps
// itself small : its rows older than RUNS_KEEP_DAYS go, and a task keeps RUNS_KEEP_PER_TASK rows
// at most.
import logger from './logger.js';
import mysql from '../models/db.model.js';
import { nodeId } from './role.js';
import { cronError } from './cronValidate.js';
import appConfig from '../../config/app.config.js';

// ─── the tasks ───────────────────────────────────────────────────────────────

// the retention settings' tab of Settings > System > General (pages/admin/settings.vue)
const RETENTION_TAB = 'retention';

/**
 * A nightly task's schedule setting : the environment variable of its cron (changed on the task's
 * own page, Jobs > System > the task > Schedule) and its appConfig key.
 *
 * Args:
 *   env (string): the variable (JOB_CLEANUP_CRON).
 *   config (string): its appConfig key (jobCleanupCron).
 *
 * Returns:
 *   object: { env, config }.
 */
const scheduleSetting = (env, config) => ({ env, config });

/**
 * The maintenance tasks, in the order the scheduler registers them.
 *
 *   key: the task's name in the scheduler and in the table
 *   cron: when it runs (the app's timezone, LOG_TZ) ; null for a task timed by an interval
 *   intervalSetting: the appConfig key of the seconds between its runs (the config seed reload)
 *   quiet: a frequent task : a run that changed nothing rewrites its quiet row instead of adding one
 *   name, description: what it is, in English, as the API answers it (the GUI says it in the user's
 *     language : client/src/locales, jobs.system.tasks)
 *   setting: the setting it applies - its environment variable (env), its appConfig key (config)
 *     and the tab of Settings > System > General it is changed on (tab) ; null for none
 *   schedule: the setting that changes its cron (scheduleSetting), the cron above then only its
 *     default ; null for a task whose timing is the app's own (every minute, every hour, the seed
 *     reload's seconds)
 */
export const SYSTEM_TASKS = [
  {
    key: 'abandonedJobs',
    cron: '0 * * * *',
    quiet: false,
    name: 'Abandoned jobs',
    description: 'Ends the jobs that ran a day without output and no runner took.',
    setting: null,
    schedule: null,
  },
  {
    key: 'deadNodes',
    cron: '* * * * *',
    quiet: true,
    name: 'Stopped nodes',
    description: 'Frees what nodes and runners that stopped answering held.',
    setting: null,
    schedule: null,
  },
  {
    key: 'scheduleEnds',
    cron: '* * * * *',
    quiet: true,
    name: 'Schedule ends',
    description: 'Turns off or removes the schedules that reached their end.',
    setting: null,
    schedule: null,
  },
  {
    key: 'tokenCleanup',
    cron: '0 3 * * *',
    quiet: false,
    name: 'Expired tokens',
    description: 'Removes expired sign-in tokens, revocations and API tokens.',
    setting: null,
    schedule: scheduleSetting('TOKEN_CLEANUP_CRON', 'tokenCleanupCron'),
  },
  {
    key: 'auditCleanup',
    cron: '30 3 * * *',
    quiet: false,
    name: 'Audit log cleanup',
    description: 'Removes audit log entries older than the audit retention.',
    setting: { env: 'AUDIT_RETENTION_DAYS', config: 'auditRetentionDays', tab: RETENTION_TAB },
    schedule: scheduleSetting('AUDIT_CLEANUP_CRON', 'auditCleanupCron'),
  },
  {
    key: 'jobCleanup',
    cron: '30 2 * * *',
    quiet: false,
    name: 'Job cleanup',
    description: 'Removes finished jobs older than the job retention.',
    setting: { env: 'JOB_RETENTION_DAYS', config: 'jobRetentionDays', tab: RETENTION_TAB },
    schedule: scheduleSetting('JOB_CLEANUP_CRON', 'jobCleanupCron'),
  },
  {
    key: 'nightlyBackup',
    cron: '0 0 * * *',
    quiet: false,
    name: 'Nightly backup',
    description: 'Backs up the database and removes the oldest nightly backups.',
    setting: { env: 'NIGHTLY_BACKUP_RETENTION', config: 'nightlyBackupRetention', tab: RETENTION_TAB },
    schedule: scheduleSetting('NIGHTLY_BACKUP_CRON', 'nightlyBackupCron'),
  },
  {
    key: 'storedJobsCleanup',
    cron: '0 4 * * *',
    quiet: false,
    name: 'Stored jobs cleanup',
    description: 'Removes expired or unused stored jobs, and forgets old nodes.',
    setting: { env: 'STORED_JOB_UNUSED_DAYS', config: 'storedJobUnusedDays', tab: RETENTION_TAB },
    schedule: scheduleSetting('STORED_JOB_CLEANUP_CRON', 'storedJobCleanupCron'),
  },
  {
    key: 'configSeedReload',
    cron: null,
    intervalSetting: 'configSeedReloadSeconds',
    quiet: true,
    name: 'Config seed reload',
    description: 'Applies the config seed again when its file changes.',
    setting: { env: 'CONFIG_SEED_RELOAD_SECONDS', config: 'configSeedReloadSeconds', tab: 'configuration' },
    schedule: null,
  },
];

// the tasks by their key
const TASKS = new Map(SYSTEM_TASKS.map((task) => [task.key, task]));

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

// the tasks whose cron an admin changes, by their setting's variable
export const SCHEDULE_SETTINGS = SYSTEM_TASKS.filter((task) => task.schedule).map((task) => ({
  key: task.key,
  env: task.schedule.env,
  config: task.schedule.config,
  default: task.cron,
}));

/**
 * Why a cron cannot be a nightly task's schedule, or null when it can : five fields (minute, hour,
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
 * The cron a task runs on : its schedule setting's when one is set and valid, else the declared
 * one. A value that is not a valid cron (written by hand in the environment, never through the
 * app, which checks it) is passed over for the declared one, and the scheduler logs it.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   string: its cron.
 *
 * Raises:
 *   Error: when no task has that key, or it is timed by an interval : a typo in the scheduler
 *     fails at its start rather than registering nothing.
 */
export function taskCron(key) {
  const task = systemTask(key);
  if (!task?.cron) throw new Error(`No system task with a cron is named ${key}`);
  const set = scheduleValue(task);
  return set && !scheduleCronProblem(set) ? set : task.cron;
}

/**
 * The cron a task's schedule setting holds, as it is set ('' : not set, the default applies).
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
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
    for (const task of SYSTEM_TASKS) {
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
 * Writes one run of a task. A quiet task's run that succeeded and changed nothing rewrites the
 * task's quiet row (quiet_of, unique) ; every other run is a row of its own. Never throws : a
 * run that cannot be written is logged, the task itself has run.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   run (object): { startedAt (Date), endedAt (Date), outcome (success, failed), result (string),
 *     changed (number : what the run changed, 0 for nothing) }.
 *
 * Returns:
 *   Promise<boolean>: whether the run was written.
 */
export async function recordRun(task, run) {
  const quiet = !!task.quiet && run.outcome === 'success' && !run.changed;
  const result = String(run.result ?? '').slice(0, RESULT_MAX);
  const params = [task.key, run.startedAt, run.endedAt, run.outcome, result, nodeId];
  try {
    if (quiet) {
      // step 1a : the task's one quiet row, written over
      await mysql.do(
        'INSERT INTO AnsibleForms.`system_task_runs` (task_key, started_at, ended_at, outcome, result, node, quiet_of) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE started_at = VALUES(started_at), ' +
          'ended_at = VALUES(ended_at), outcome = VALUES(outcome), result = VALUES(result), node = VALUES(node)',
        [...params, task.key],
        true,
      );
    } else {
      // step 1b : a row of its own
      await mysql.do(
        'INSERT INTO AnsibleForms.`system_task_runs` (task_key, started_at, ended_at, outcome, result, node) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        params,
        true,
      );
    }
  } catch (err) {
    logger.warning(`Could not record the run of the system task ${task.key}: ${err.message || err}`);
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
 *   changed: how much it changed (0 : nothing, a quiet task then rewrites its quiet row) ;
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

export default { SYSTEM_TASKS, SCHEDULE_SETTINGS, systemTask, taskCron, scheduleValue, scheduleCronProblem, counted, sentence, pruneRuns, recordRun, recorded };
