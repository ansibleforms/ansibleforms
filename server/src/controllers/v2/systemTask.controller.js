import SystemTask, { scheduleEditable } from '../../models/systemTask.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import Audit from '../../models/audit.model.js';
import i18n from '../../lib/i18n.js';
import helpers from '../../lib/common.js';
import logger from '../../lib/logger.js';
import { systemTask, hubLoop, taskCron, taskEnabled, scheduleCronProblem } from '../../lib/systemTasks.js';
import { runNow, busyTasks } from '../../lib/systemTaskRun.js';
import { ENV_EDIT_DISABLED_REASON } from '../../lib/envSettings.js';
import { saveEnvValues, EnvSaveError } from '../../lib/envSave.js';

// GET /api/v2/system/tasks : the app's own maintenance tasks (Jobs > System), each with when it
// runs, its last run and its next one, and the setting it applies. A task is the app's own : only
// when it runs is changed here (PUT /tasks/:key/schedule).
const list = async function (req, res) {
  try {
    const tasks = await SystemTask.list();
    res.json(RestResult.list(tasks));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'errors.databaseError'), helpers.getError(err)));
  }
};

/**
 * One task as GET answers it, with whether a run of it is going now (running : the page's Run now
 * waits meanwhile) ; a runner hub loop is never run from here.
 *
 * Args:
 *   key (string): the task's key.
 *
 * Returns:
 *   Promise<object|null>: the task, or null for a key no task has.
 */
async function taskWithState(key) {
  const task = await SystemTask.get(key);
  if (!task) return null;
  const running = systemTask(key) ? (await busyTasks()).has(key) : false;
  return { ...task, running };
}

// GET /api/v2/system/tasks/:key : one task, the same, with its recent runs and whether it runs
// now ; 404 for a key no task has
const get = async function (req, res) {
  try {
    const task = await taskWithState(req.params.key);
    if (!task) {
      res.status(404).json(RestResult.error(i18n.t(req, 'resources.systemTaskNotFound')));
      return;
    }
    res.json(RestResult.single(task));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'errors.databaseError'), helpers.getError(err)));
  }
};

/**
 * Answers a refused schedule : its status, the failure's title and why.
 *
 * Args:
 *   req (object): the request (the user's language).
 *   res (object): the response.
 *   status (number): 400, 403, 404 or 409.
 *   detail (string): why, in English as the settings' own refusals.
 */
function refuse(req, res, status, detail) {
  res.status(status).json(RestResult.error(i18n.t(req, 'resources.systemTaskScheduleFailed'), detail));
}

// PUT /api/v2/system/tasks/:key/schedule { cron } : when a task runs. Saved as the
// settings page saves its variables (lib/envSave.js : the settings file, the other nodes told,
// applied at once), its setting re-registering the task on its new cron on the node that runs the
// tasks. 404 for a key no task has, 403 for a runner hub loop (it runs as often as the runners
// need it, no cron) or a task whose variable the environment sets
// (ALLOW_ENV_EDIT=0, or set in the process's own environment), 400 for a cron that is not 5
// fields croner runs. Saved, it wins over a deprecated variable its cron came from (the config
// seed reload's CONFIG_SEED_RELOAD_SECONDS). Answers the task as GET does.
const saveSchedule = async function (req, res) {
  try {
    // step 1 : the task ; a runner hub loop has no cron to change
    const task = systemTask(req.params.key);
    if (!task && hubLoop(req.params.key)) {
      refuse(req, res, 403, "The runner hub's loops run as often as the runners need them, they have no schedule");
      return;
    }
    if (!task) {
      res.status(404).json(RestResult.error(i18n.t(req, 'resources.systemTaskNotFound')));
      return;
    }
    // step 2 : the cron, 5 fields croner runs
    const cron = String(req.body?.cron ?? '').trim();
    const problem = scheduleCronProblem(cron);
    if (problem) {
      refuse(req, res, 400, `The cron ${problem}`);
      return;
    }
    // step 3 : the settings file ours to write, the variable not the environment's
    const env = task.schedule.env;
    if (!SystemTask.envEditAllowed()) {
      refuse(req, res, 403, ENV_EDIT_DISABLED_REASON);
      return;
    }
    if (!scheduleEditable(task, await SystemTask.managed())) {
      refuse(req, res, 403, `${env} is set in the environment and cannot be changed from here`);
      return;
    }
    // step 4 : saved as the settings page saves (its own audit names the variable), then the
    // change itself audited, the crons are not secrets
    const before = taskCron(task.key);
    await saveEnvValues({ [env]: cron }, { user: req.user?.user, ip: req.ip });
    Audit.log({
      user: req.user?.user,
      ip: req.ip,
      action: 'system.task.schedule',
      outcome: 'success',
      targetType: 'system_task',
      target: task.key,
      detail: { env, from: before, to: cron },
    });
    logger.notice(`The system task ${task.key} runs on ${cron} now (was ${before})`);
    res.json(RestResult.single(await SystemTask.get(task.key)));
  } catch (err) {
    if (err instanceof EnvSaveError) {
      // set in the environment meanwhile (409 there) : not editable here, as step 3 answers
      refuse(req, res, err.status === 409 ? 403 : err.status, err.message);
      return;
    }
    logger.error(helpers.getError(err));
    refuse(req, res, err.status || 500, helpers.getError(err));
  }
};

// what each refusal of Run now answers : its status and why, in English as the other refusals
const RUN_REFUSED = {
  busy: [409, 'A run of this task is going, wait for it to end'],
  off: [400, 'This task is off and does not run'],
  noWorker: [503, 'No node runs the system tasks now: no process holds the worker lock'],
};

// POST /api/v2/system/tasks/:key/run : runs a task once now, recorded as a scheduled run is (its
// outcome and result on its Runs tab), on the node that runs the tasks wherever the request came
// in (lib/systemTaskRun.js). Answers the task as GET does once the run ended (200), or at once
// while it still runs (202) : the nightly backup, which may outlast a request, and a run handed to
// another node that did not end within the wait. 404 for a key no task has, 403 for a runner hub
// loop (the engine's own timers, never run from here), 400 for a task that is off (the config seed
// reload without CONFIG_SEED_PATH), 409 while a run of it is going, 503 when no node runs the
// tasks. Audited (system.task.run), with where it ran and how it went.
const run = async function (req, res) {
  const fail = (status, detail) =>
    res.status(status).json(RestResult.error(i18n.t(req, 'resources.systemTaskRunFailed'), detail));
  try {
    // step 1 : the task ; a runner hub loop is not one to run
    const task = systemTask(req.params.key);
    if (!task && hubLoop(req.params.key)) {
      fail(403, "The runner hub's loops run on their own timers, they cannot be run from here");
      return;
    }
    if (!task) {
      res.status(404).json(RestResult.error(i18n.t(req, 'resources.systemTaskNotFound')));
      return;
    }
    if (!taskEnabled(task.key)) {
      fail(...RUN_REFUSED.off);
      return;
    }
    // step 2 : run, here or on the node that runs the tasks
    const ran = await runNow(task.key);
    if (RUN_REFUSED[ran.status]) {
      fail(...RUN_REFUSED[ran.status]);
      return;
    }
    // step 3 : the task as it is now, its run audited (how it went, when it ended)
    const answer = await taskWithState(task.key);
    const done = ran.status === 'done';
    Audit.log({
      user: req.user?.user,
      ip: req.ip,
      action: 'system.task.run',
      outcome: 'success',
      targetType: 'system_task',
      target: task.key,
      detail: done
        ? { node: ran.node, run: answer?.last_run?.outcome || null, result: answer?.last_run?.result || null }
        : { node: ran.node, run: 'started' },
    });
    logger.notice(`The system task ${task.key} was run now by ${req.user?.user?.username || 'a user'} (${ran.status})`);
    res.status(done ? 200 : 202).json(RestResult.single(done ? answer : { ...answer, running: true }));
  } catch (err) {
    logger.error(helpers.getError(err));
    fail(err.status || 500, helpers.getError(err));
  }
};

export default { list, get, saveSchedule, run };
