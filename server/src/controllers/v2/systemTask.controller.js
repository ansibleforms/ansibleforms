import SystemTask from '../../models/systemTask.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import helpers from '../../lib/common.js';

// GET /api/v2/system/tasks : the app's own maintenance tasks (Jobs > System), each with when it
// runs, its last run and its next one, and the setting it applies. Read only : nothing here
// changes a task, they are the app's own.
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

export default { list, get };
