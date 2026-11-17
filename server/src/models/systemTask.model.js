'use strict';
// The app's own maintenance tasks as Jobs > System shows them (GET /api/v2/system/tasks) : each
// task of lib/systemTasks.js with when it runs, its last run and its next one, and the setting it
// applies ; one task with its recent runs too.
//
// Read from the declarations and the database only, never from the scheduler : the tasks run on
// the worker, and the page may be served by any app node. The next run is worked out from the
// task's cron in the scheduler's timezone, as the schedules' (models/schedule.model.js) : the cron
// in force, its schedule setting's when an admin changed it (lib/systemTasks.js taskCron), which
// every node applies when it is saved.
import { Cron } from 'croner';
import mysql from './db.model.js';
import appConfig from '../../config/app.config.js';
import logConfig from '../../config/log.config.js';
import { SYSTEM_TASKS, systemTask, taskCron } from '../lib/systemTasks.js';
import { readManaged, isOverridden } from '../lib/envSettings.js';

// the runs one task's page lists, its latest first
export const RECENT_RUNS = 100;

// where each tab of Settings > System > General is, in words, for a reader of the API
const TAB_NAMES = { retention: 'Retention', configuration: 'Configuration' };

/**
 * A run as the API answers it.
 *
 * Args:
 *   row (object): a row of system_task_runs.
 *
 * Returns:
 *   object: { id, started_at, ended_at, duration_ms, outcome, result, node }.
 */
function runOf(row) {
  const started = row.started_at ? new Date(row.started_at) : null;
  const ended = row.ended_at ? new Date(row.ended_at) : null;
  return {
    id: row.id,
    started_at: started ? started.toISOString() : null,
    ended_at: ended ? ended.toISOString() : null,
    duration_ms: started && ended ? Math.max(0, ended - started) : null,
    outcome: row.outcome,
    result: row.result ?? '',
    node: row.node ?? null,
  };
}

/**
 * The cron a task runs on now : its schedule setting's, or its default ; null for a task timed by
 * an interval.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *
 * Returns:
 *   string|null: its cron.
 */
export function cronOf(task) {
  return task.cron ? taskCron(task.key) : null;
}

/**
 * Whether an admin may change when a task runs (PUT /api/v2/system/tasks/:key/schedule) : a task
 * with a schedule setting (the nightly ones), the settings file writable (ALLOW_ENV_EDIT), and its
 * variable not set in the process's own environment, which the file cannot override.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   managed (Map): the variables of the settings file (envSettings readManaged).
 *
 * Returns:
 *   boolean: true when its schedule may be changed.
 */
export function scheduleEditable(task, managed) {
  if (!task.schedule) return false;
  return !!appConfig.allowEnvEdit && !isOverridden(task.schedule.env, managed);
}

/**
 * Whether a task runs here and now : the config seed reload only with a seed and seconds above 0,
 * every other task always.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *
 * Returns:
 *   boolean: true when it runs.
 */
function isEnabled(task) {
  if (task.key === 'configSeedReload') return !!appConfig.configSeedPath && Number(appConfig.configSeedReloadSeconds) > 0;
  return true;
}

/**
 * When a task runs next : its cron's next occurrence, or for a task timed by seconds its last
 * run and the seconds after it ; null when it is off, or not known (never ran).
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   lastRun (object|null): its last run, as runOf gives it.
 *
 * Returns:
 *   string|null: an ISO date, or null.
 */
export function nextRunOf(task, lastRun) {
  if (!isEnabled(task)) return null;
  try {
    if (task.cron) {
      const cron = new Cron(cronOf(task), { paused: true, timezone: logConfig.tz });
      const next = cron.nextRun();
      cron.stop();
      return next ? next.toISOString() : null;
    }
    const seconds = Number(appConfig[task.intervalSetting]) || 0;
    if (!lastRun?.started_at || seconds <= 0) return null;
    // the next tick after the interval : at least a second from now (a missed one runs then)
    const next = Math.max(new Date(lastRun.started_at).getTime() + seconds * 1000, Date.now() + 1000);
    return new Date(next).toISOString();
  } catch {
    return null;
  }
}

/**
 * Its next runs, as a schedule's preview shows them (three) : its cron's next occurrences, or for a
 * task timed by seconds the next one and the intervals after it ; none when it is off or not known.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   lastRun (object|null): its last run, as runOf gives it.
 *   count (number): how many.
 *
 * Returns:
 *   string[]: ISO dates.
 */
export function nextRunsOf(task, lastRun, count = 3) {
  if (!isEnabled(task)) return [];
  try {
    if (task.cron) {
      const cron = new Cron(cronOf(task), { paused: true, timezone: logConfig.tz });
      const runs = cron.nextRuns(count);
      cron.stop();
      return runs.map((d) => d.toISOString());
    }
    const first = nextRunOf(task, lastRun);
    const seconds = Number(appConfig[task.intervalSetting]) || 0;
    if (!first || seconds <= 0) return [];
    return Array.from({ length: count }, (_, i) => new Date(new Date(first).getTime() + i * seconds * 1000).toISOString());
  } catch {
    return [];
  }
}

/**
 * The setting a task applies : its variable, its value now, and whether it is changed in the app
 * (Settings > System > General, at its tab) or only in the environment (ALLOW_ENV_EDIT=0, or the
 * variable set in the process's own environment, which the settings file cannot override).
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   managed (Map): the variables of the settings file (envSettings readManaged).
 *
 * Returns:
 *   object|null: { env, value, editable, link, where }, or null for a task without a setting ;
 *     link and where are null when it is set by the environment only.
 */
export function settingOf(task, managed) {
  const setting = task.setting;
  if (!setting) return null;
  const editable = !!appConfig.allowEnvEdit && !isOverridden(setting.env, managed);
  return {
    env: setting.env,
    value: appConfig[setting.config] ?? null,
    editable,
    link: editable ? `/settings/general/${setting.tab}` : null,
    where: editable ? `Settings > System > General > ${TAB_NAMES[setting.tab] || setting.tab}` : null,
  };
}

/**
 * A task as the API answers it.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   lastRow (object|undefined): its latest row of system_task_runs.
 *   managed (Map): the variables of the settings file.
 *
 * Returns:
 *   object: { key, name, description, cron, default_cron, schedule_env, editable_schedule,
 *     interval_seconds, enabled, last_run, next_run, next_runs, timezone, setting }.
 */
function describe(task, lastRow, managed) {
  const lastRun = lastRow ? runOf(lastRow) : null;
  return {
    key: task.key,
    name: task.name,
    description: task.description,
    // the cron in force : its schedule setting's, or its default
    cron: cronOf(task),
    // its own cron, the one in force while its setting is not set
    default_cron: task.cron,
    // the variable of its cron, for a task whose schedule an admin changes (null : the app's own)
    schedule_env: task.schedule?.env || null,
    // whether it may be changed here : not when the environment sets it (ALLOW_ENV_EDIT=0, or the
    // variable set in the process's own environment)
    editable_schedule: scheduleEditable(task, managed),
    interval_seconds: task.intervalSetting ? Number(appConfig[task.intervalSetting]) || 0 : null,
    enabled: isEnabled(task),
    last_run: lastRun,
    next_run: nextRunOf(task, lastRun),
    // its next runs, the Schedule tab's preview
    next_runs: nextRunsOf(task, lastRun),
    // the zone its cron runs in (the scheduler's), the preview's
    timezone: logConfig.tz || null,
    setting: settingOf(task, managed),
  };
}

/**
 * The variables of the settings file ; none when it cannot be read (a fresh install has none).
 *
 * Returns:
 *   Promise<Map>: the variables.
 */
async function managedVariables() {
  try {
    return await readManaged();
  } catch {
    return new Map();
  }
}

const SystemTask = {};

/**
 * The variables of the settings file, for a caller that checks a task's schedule
 * (scheduleEditable) ; none when it cannot be read.
 *
 * Returns:
 *   Promise<Map>: the variables.
 */
SystemTask.managed = managedVariables;

/**
 * Whether the settings file may be written from the app (ALLOW_ENV_EDIT) : a task's schedule is
 * saved there.
 *
 * Returns:
 *   boolean: true when it may.
 */
SystemTask.envEditAllowed = () => !!appConfig.allowEnvEdit;

/**
 * Every maintenance task, in the scheduler's order, with its last run.
 *
 * Returns:
 *   Promise<object[]>: the tasks, as describe answers them.
 */
SystemTask.list = async function () {
  // step 1 : each task's latest row, in one query (the latest started, the highest id on a tie)
  const rows = await mysql.do(
    'SELECT r.* FROM AnsibleForms.`system_task_runs` r WHERE r.id = (' +
      'SELECT r2.id FROM AnsibleForms.`system_task_runs` r2 WHERE r2.task_key = r.task_key ' +
      'ORDER BY r2.started_at DESC, r2.id DESC LIMIT 1)',
    undefined,
    true,
  );
  const latest = new Map((rows || []).map((row) => [row.task_key, row]));
  // step 2 : each task described
  const managed = await managedVariables();
  return SYSTEM_TASKS.map((task) => describe(task, latest.get(task.key), managed));
};

/**
 * One maintenance task, with its recent runs, the latest first.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   Promise<object|null>: the task, as describe answers it, with runs ; null for a key no task
 *     has.
 */
SystemTask.get = async function (key) {
  const task = systemTask(key);
  if (!task) return null;
  const rows = await mysql.do(
    'SELECT * FROM AnsibleForms.`system_task_runs` WHERE task_key = ? ORDER BY started_at DESC, id DESC LIMIT ?',
    [task.key, RECENT_RUNS],
    true,
  );
  const managed = await managedVariables();
  return { ...describe(task, rows?.[0], managed), runs: (rows || []).map(runOf) };
};

export default SystemTask;
