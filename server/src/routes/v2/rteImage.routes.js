// The Designer's RTE images (controllers/v2/rteImage.controller.js)
import express from 'express';
const router = express.Router();
import rteImageController from '../../controllers/v2/rteImage.controller.js';
import Middleware from '../../lib/middleware.js';

router.get('/', rteImageController.list);
// the repositories a new image may go to
router.get('/repositories', rteImageController.repositories);
// the pythons and the ansible-core releases, and which run together
router.get('/versions', rteImageController.versions);
// what a definition not saved yet builds (the editor's Dockerfile tab)
router.post('/preview', rteImageController.preview);
router.post('/push', Middleware.checkRteDesignMiddleware, rteImageController.push);
// the builds (jobs of type build) and the builders that run them
router.get('/builds', rteImageController.builds);
router.get('/builders', rteImageController.builders);
router.post('/', Middleware.checkRteDesignMiddleware, rteImageController.create);
router.get('/:name', rteImageController.get);
router.put('/:name', Middleware.checkRteDesignMiddleware, rteImageController.update);
router.delete('/:name', Middleware.checkRteDesignMiddleware, rteImageController.remove);
router.post('/:name/build', Middleware.checkRteBuildMiddleware, rteImageController.build);

export default router;
