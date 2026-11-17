import express from 'express';
const router = express.Router();
import systemTaskController from '../../controllers/v2/systemTask.controller.js';

// The mount already applies authobj + checkSettingsMiddleware (see app.js) : the app's own
// maintenance tasks are the admin settings' business, as the Status page they sit beside. Read
// only : a task is the app's own, nothing here changes it.
router.get('/tasks', systemTaskController.list);
router.get('/tasks/:key', systemTaskController.get);

export default router;
