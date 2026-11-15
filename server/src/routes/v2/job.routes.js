import express from 'express';
const router = express.Router();
import jobControllerv2 from '../../controllers/v2/job.controller.js';
import uploadController from '../../controllers/v2/upload.controller.js';

// get approvals count
router.get('/approvals', jobControllerv2.findApprovals);
// upload file
router.post('/upload',uploadController.upload)
// get a job
router.get('/:id', jobControllerv2.getJob);
// a workflow job's node : its variables and its artifacts
router.get('/:id/node/:nodeId', jobControllerv2.getWorkflowNode);
// a playbook job's structured events (its grid, timeline and recap)
router.get('/:id/events', jobControllerv2.getJobEvents);
// one event with its whole result : a host's line of the output clicked
router.get('/:id/events/:order', jobControllerv2.getJobEvent);
// get raw form data for a job
router.get('/:id/rawformdata', jobControllerv2.getRawFormData);
// download a job
router.get('/:id/download', jobControllerv2.download);
// delete a job
router.delete('/:id', jobControllerv2.deleteJob);
// launch job
router.post('/', jobControllerv2.launch);
// abort a job
router.post('/:id/abort/', jobControllerv2.abortJob);
// what a relaunch can be besides a full one (the failed hosts of an ended job)
router.get('/:id/relaunch-options', jobControllerv2.getRelaunchOptions);
// relaunch a job
router.post('/:id/relaunch/', jobControllerv2.relaunchJob);
// approve a job
router.post('/:id/approve/', jobControllerv2.approveJob);
// approve a job
router.post('/:id/reject/', jobControllerv2.rejectJob);
// get all jobs
router.get('/', jobControllerv2.findAllJobs);


export default router
