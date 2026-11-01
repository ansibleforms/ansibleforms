import express from 'express';
const router = express.Router();
import databaseController from '../../controllers/v2/database.controller.js';

// Connections > Databases : the databases forms query (a field's dbConfig names one)
router.get('/', databaseController.find);
router.post('/', databaseController.create);
router.get('/:id', databaseController.findById);
router.put('/:id', databaseController.update);
router.delete('/:id', databaseController.delete);
// Test connection : its credential's
router.post('/:id/check', databaseController.check);

export default router
