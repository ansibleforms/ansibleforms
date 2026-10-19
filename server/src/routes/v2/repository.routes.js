import express from 'express';
const router = express.Router();
import repositoryController from '../../controllers/v2/repository.controller.js';
// Retrieve all repositorys
router.get('/', repositoryController.find);
// Create a new repository
router.post('/', repositoryController.create);
// Retrieve a single repository with id
router.get('/:name', repositoryController.findByName);
// what making it the schedules repository, or no longer, would do (changes nothing)
router.get('/:name/schedules-preview', repositoryController.schedulesPreview);
// Update a repository with id
router.put('/:name', repositoryController.update);
// Delete a repository with id
router.delete('/:name', repositoryController.delete);
// Clone a repository by name
router.post('/:name/clone/', repositoryController.clone);
// reset a repository by name
router.post('/:name/reset/', repositoryController.reset);
// Pull a repository by name
router.post('/:name/pull/', repositoryController.pull);
// Commit & push a forms repository by name
router.post('/:name/sync/', repositoryController.sync);

export default router