import express from 'express';
const router = express.Router();
import runnerController from '../../controllers/v2/runner.controller.js';

router.get('/', runnerController.find);
router.get('/types', runnerController.types);
// the images a new AnsibleForms runner can run : published, and the runtime environments built
router.get('/images', runnerController.images);
// how many RTEs wait for approval (the header bell)
router.get('/pending', runnerController.pendingCount);
// the join tokens RTEs add themselves with (Connections > Runners > Add runner)
router.get('/jointoken', runnerController.findJoinTokens);
router.post('/jointoken', runnerController.createJoinToken);
router.post('/jointoken/:id/revoke', runnerController.revokeJoinToken);
router.delete('/jointoken/:id', runnerController.deleteJoinToken);
router.post('/', runnerController.create);
router.get('/:id', runnerController.findById);
router.put('/:id', runnerController.update);
router.delete('/:id', runnerController.delete);
// read-only connection test
router.post('/:id/check', runnerController.check);
// an RTE that asked to join : approved, or rejected (removed)
router.post('/:id/approve', runnerController.approve);
router.post('/:id/reject', runnerController.reject);

export default router
