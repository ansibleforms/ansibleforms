import express from 'express';
const router = express.Router();
import configController from '../../controllers/v2/config.controller.js';
import middleware from '../../lib/middleware.js';

// designer routes only (admin !!)
router.post('/', middleware.checkDesignerMiddleware, middleware.checkFormDesignMiddleware, configController.save);
router.post('/check', middleware.checkDesignerMiddleware, configController.validate);
router.post('/restore/:backupName', middleware.checkDesignerMiddleware, middleware.checkFormDesignMiddleware, configController.restore);
router.get('/backups', middleware.checkDesignerMiddleware, configController.backups);
router.get('/env', middleware.checkAnySettingsMiddleware, configController.env);
// writes persistent/.env ; refuses anything already set in the real environment
router.put('/env', middleware.checkAnySettingsMiddleware, configController.saveEnv);
// read-only connection test for the Vault page
router.post('/vault/check', middleware.checkConnectionsMiddleware, configController.vaultCheck);
router.get('/vault/mounts', middleware.checkConnectionsMiddleware, configController.vaultMounts);
// config mode (database vs file) - designer accessible so designers without settings access can learn the mode
router.get('/mode', middleware.checkDesignerMiddleware, configController.configMode);
// is the stored config a ytt template ? designer accessible for the same reason as /mode :
// a designer without settings access must still be stopped from saving over a template
router.get('/templated', middleware.checkDesignerMiddleware, configController.configTemplated);

// get the config (no admin)
router.get('/', middleware.checkDesignerMiddleware, configController.findAll);
// get list, just the icons and names (no admin)
router.get('/formlist', configController.findList);
// every form, its roles and its runners : the settings pages' Forms tabs
router.get('/formslinked', middleware.checkAnySettingsMiddleware, configController.formsLinked);
// the credentials each form names, for a credential's Used by tab (lib/formLinks.js formCredentials) :
// with the connections access the credentials themselves need (/api/v2/credential)
router.get('/formscredentials', middleware.checkConnectionsMiddleware, configController.formsCredentials);
// the credentials each of the designer's workflows names (models/workflowRun.js workflowCredentials)
router.get('/workflowscredentials', middleware.checkConnectionsMiddleware, configController.workflowsCredentials);
// flat list of form names (for dropdowns : datasources and schedules)
router.get('/formnames', middleware.checkFormNamesMiddleware, configController.formNames);
// get one config (no admin)
router.get('/form', configController.findOne);
// 
export default router
