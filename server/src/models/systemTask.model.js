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
import { SYSTEM_TASKS, HUB_LOOPS, systemTask, hubLoop, taskCron, taskEnabled, deprecatedSchedule, loopSeconds } from '../lib/systemTasks.js';
import { loopState } from '../lib/hubLoops.js';
import { readManaged, isOverridden } from '../lib/envSettings.js';

// The runner hub's loops (lib/systemTasks.js HUB_LOOPS) are listed after the tasks : no cron,
// their seconds instead (interval_seconds, a setting changed as a task's cron, within
// interval_min and interval_max), and what they did from the memory of the node that answers
// (lib/hubLoops.js loopState, its name in loop.node) ; their rows are their failures.

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
 * The cron a task runs on now : its schedule setting's, the deprecated variable's it replaces
 * (lib/systemTasks.js deprecatedSchedule), or its default.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *
 * Returns:
 *   string: its cron.
 */
export function cronOf(task) {
  return taskCron(task.key);
}

/**
 * Whether an admin may change when a task runs (PUT /api/v2/system/tasks/:key/schedule) : a task
 * with a schedule setting (every one, its cron ; a runner hub loop's, its seconds), the settings
 * file writable (ALLOW_ENV_EDIT), and its variable not set in the process's own environment, which
 * the file cannot override.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS, or a loop's of HUB_LOOPS.
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
 * When a task runs next : its cron's next occurrence ; null when it is off.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *
 * Returns:
 *   string|null: an ISO date, or null.
 */
export function nextRunOf(task) {
  return nextRunsOf(task, 1)[0] || null;
}

/**
 * Its next runs, as a schedule's preview shows them (three) : its cron's next occurrences ; none
 * when it is off.
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *   count (number): how many.
 *
 * Returns:
 *   string[]: ISO dates.
 */
export function nextRunsOf(task, count = 3) {
  if (!taskEnabled(task.key)) return [];
  try {
    const cron = new Cron(cronOf(task), { paused: true, timezone: logConfig.tz });
    const runs = cron.nextRuns(count);
    cron.stop();
    return runs.map((d) => d.toISOString());
  } catch {
    return [];
  }
}

/**
 * The deprecated variable a task's cron still comes from, as the API answers it : its name, its
 * value, and the cron it is read as (lib/systemTasks.js deprecatedSchedule).
 *
 * Args:
 *   task (object): the task's entry of SYSTEM_TASKS.
 *
 * Returns:
 *   object|null: { env, value, cron, off, exact }, or null when none is in force.
 */
export function scheduleDeprecatedOf(task) {
  const deprecated = deprecatedSchedule(task);
  if (!deprecated) return null;
  return { env: deprecated.env, value: deprecated.value, cron: deprecated.cron, off: deprecated.off, exact: deprecated.exact };
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
 *     schedule_deprecated, interval_seconds, default_interval_seconds, interval_min, interval_max,
 *     loop, enabled, last_run, next_run, next_runs, timezone, setting }.
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
    // the variable of its cron
    schedule_env: task.schedule?.env || null,
    // whether it may be changed here : not when the environment sets it (ALLOW_ENV_EDIT=0, or the
    // variable set in the process's own environment)
    editable_schedule: scheduleEditable(task, managed),
    // the deprecated variable its cron still comes from, while its own is not set (the config seed
    // reload's CONFIG_SEED_RELOAD_SECONDS) ; null for none
    schedule_deprecated: scheduleDeprecatedOf(task),
    // a runner hub loop's seconds, its default and bounds (describeLoop) ; null for a task timed
    // by its cron
    interval_seconds: null,
    default_interval_seconds: null,
    interval_min: null,
    interval_max: null,
    // a runner hub loop's state on the node that answers (describeLoop) ; null for a task
    loop: null,
    enabled: taskEnabled(task.key),
    last_run: lastRun,
    next_run: nextRunOf(task),
    // its next runs, the Schedule tab's preview
    next_runs: nextRunsOf(task),
    // the zone its cron runs in (the scheduler's), the preview's
    timezone: logConfig.tz || null,
    setting: settingOf(task, managed),
  };
}

/**
 * A runner hub loop as the API answers it : the fields of a task without a cron, its seconds
 * instead (its setting's, changed as a task's cron unless the environment sets it) ; its last run
 * what the node that answers keeps in memory (loopState), the node named, else its latest failed
 * row.
 *
 * Args:
 *   loop (object): the loop's entry of HUB_LOOPS.
 *   lastRow (object|undefined): its latest row of system_task_runs (a failure).
 *   managed (Map): the variables of the settings file.
 *
 * Returns:
 *   object: as describe, with interval_seconds, default_interval_seconds, interval_min,
 *     interval_max and loop ({ node, running, since, armed_at, runs, failures, last_run_at,
 *     last_outcome, last_success_at, last_error }).
 */
function describeLoop(loop, lastRow, managed) {
  const seconds = loopSeconds(loop.key);
  const state = loopState(loop.key);
  // its last run : this node's, in memory (a failure's message as its result) ; a node that runs
  // no hub has none, its latest failed row then
  let lastRun = lastRow ? runOf(lastRow) : null;
  if (state?.last_run_at) {
    const failed = state.last_outcome === 'failed';
    lastRun = {
      id: null,
      started_at: state.last_run_at,
      ended_at: failed ? state.last_error.at : state.last_success_at,
      duration_ms: null,
      outcome: state.last_outcome || 'success',
      result: failed ? state.last_error.message : '',
      node: state.node,
    };
  }
  // its next runs : its seconds after its last run on this node, or after its timer was armed
  // when that came later (its seconds changed : the new pace from then), or after the hub started
  // when it has not run yet (a loop of a minute's first tick), while the hub runs here (at least a
  // second from now, a missed tick runs then) ; none where no hub runs
  const next = [];
  const marks = [state?.last_run_at, state?.armed_at].filter(Boolean).map((d) => new Date(d).getTime());
  const from = marks.length ? Math.max(...marks) : state?.since ? new Date(state.since).getTime() : null;
  if (state?.running && from) {
    const first = Math.max(from + seconds * 1000, Date.now() + 1000);
    for (let i = 0; i < 3; i++) next.push(new Date(first + i * seconds * 1000).toISOString());
  }
  return {
    key: loop.key,
    name: loop.name,
    description: loop.description,
    cron: null,
    default_cron: null,
    // the variable of its seconds, and whether it may be changed here (as a task's cron)
    schedule_env: loop.schedule.env,
    editable_schedule: scheduleEditable(loop, managed),
    schedule_deprecated: null,
    // its seconds in force, its own, and the bounds a change keeps within
    interval_seconds: seconds,
    default_interval_seconds: loop.seconds,
    interval_min: loop.schedule.min,
    interval_max: loop.schedule.max,
    loop: state,
    enabled: !!state?.running,
    last_run: lastRun,
    next_run: next[0] || null,
    next_runs: next,
    timezone: logConfig.tz || null,
    setting: null,
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
 * Every maintenance task, in the scheduler's order, with its last run, then the runner hub's
 * loops.
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
  return [
    ...SYSTEM_TASKS.map((task) => describe(task, latest.get(task.key), managed)),
    ...HUB_LOOPS.map((loop) => describeLoop(loop, latest.get(loop.key), managed)),
  ];
};

/**
 * One maintenance task (or runner hub loop), with its recent runs, the latest first (a loop's :
 * its failures).
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
  const loop = task ? null : hubLoop(key);
  if (!task && !loop) return null;
  const rows = await mysql.do(
    'SELECT * FROM AnsibleForms.`system_task_runs` WHERE task_key = ? ORDER BY started_at DESC, id DESC LIMIT ?',
    [(task || loop).key, RECENT_RUNS],
    true,
  );
  const managed = await managedVariables();
  // a loop's rows are its failures, its Runs tab lists them
  if (loop) return { ...describeLoop(loop, rows?.[0], managed), runs: (rows || []).map(runOf) };
  return { ...describe(task, rows?.[0], managed), runs: (rows || []).map(runOf) };
};

export default SystemTask;
