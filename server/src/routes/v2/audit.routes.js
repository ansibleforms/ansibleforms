import express from 'express';
const router = express.Router();
import auditController from '../../controllers/v2/audit.controller.js';

// The mount applies authobj + checkSettingsMiddleware (see app.js). Reusing
// showSettings rather than adding a 17th role option : the trail names users,
// targets and ip addresses, which is settings-level information, and the role
// option list is the most bug-prone code in this repo (see CLAUDE.md).
//
// GET only, on purpose. An append-only trail with an edit or delete endpoint would
// not be evidence of anything.
router.get('/', auditController.findAll);
// every entry the filters select, as a CSV file (the same filters and order as the page)
router.get('/download', auditController.download);
router.get('/facets', auditController.facets);

export default router;
