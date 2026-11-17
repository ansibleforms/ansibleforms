import SystemTask, { scheduleEditable } from '../../models/systemTask.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import Audit from '../../models/audit.model.js';
import i18n from '../../lib/i18n.js';
import helpers from '../../lib/common.js';
import logger from '../../lib/logger.js';
import { systemTask, taskCron, scheduleCronProblem } from '../../lib/systemTasks.js';
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

// GET /api/v2/system/tasks/:key : one task, the same, with its recent runs ; 404 for a key no task
// has
const get = async function (req, res) {
  try {
    const task = await SystemTask.get(req.params.key);
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
// tasks. 404 for a key no task has, 403 for a task whose variable the environment sets
// (ALLOW_ENV_EDIT=0, or set in the process's own environment), 400 for a cron that is not 5
// fields croner runs. Saved, it wins over a deprecated variable its cron came from (the config
// seed reload's CONFIG_SEED_RELOAD_SECONDS). Answers the task as GET does.
const saveSchedule = async function (req, res) {
  try {
    // step 1 : the task
    const task = systemTask(req.params.key);
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

export default { list, get, saveSchedule };
