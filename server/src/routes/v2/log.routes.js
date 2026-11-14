import express from 'express';
import logController from '../../controllers/v2/log.controller.js';

const router = express.Router();

// the last lines of a day's log (today by default)
router.get('/', logController.get);
// the days that have a log file, the newest first
router.get('/dates', logController.dates);
// download a day's log file (today by default)
router.get('/download', logController.download);

export default router
