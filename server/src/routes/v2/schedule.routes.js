import express from 'express';
const router = express.Router();
import scheduleController from '../../controllers/v2/schedule.controller.js';
// Retrieve all schedules
router.get('/', scheduleController.find);
// Create a new schedule
router.post('/', scheduleController.create);
// the schedules repositories a new schedule may live in
router.get('/repositories', scheduleController.repositories);
// a rrule checked, and its next runs (read only : a GET, never audited)
router.get('/rrule', scheduleController.previewRrule);
// Retrieve a single schedule with id
router.get('/:id', scheduleController.findById);
// Update a schedule with id
router.put('/:id', scheduleController.update);
// Delete a schedule with id
router.delete('/:id', scheduleController.delete);
// reset a schedule by name
router.post('/:id/launch/', scheduleController.launch);

export default router
