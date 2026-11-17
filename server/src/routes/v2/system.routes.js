import express from 'express';
const router = express.Router();
import systemTaskController from '../../controllers/v2/systemTask.controller.js';

// The mount already applies authobj + checkSettingsMiddleware (see app.js) : the app's own
// maintenance tasks are the admin settings' business, as the Status page they sit beside. A task
// is the app's own : only when it runs is changed, as a setting (its cron's variable, written as
// Settings > System > General writes, refused while ALLOW_ENV_EDIT=0).
router.get('/tasks', systemTaskController.list);
router.get('/tasks/:key', systemTaskController.get);
router.put('/tasks/:key/schedule', systemTaskController.saveSchedule);

export default router;
