import RestResult from "../models/restResult.model.v2.js";
import i18n from "./i18n.js";
import appConfig from "../../config/app.config.js";
import logger from "./logger.js";
import { scopeFromRoles, runWithScope } from "./resourceScope.js";

var Middleware = function(){

}

// Build a route guard for a single permission.
//
// The status code matters more than it looks : the client has ONE global axios
// interceptor for 401 (App.vue), which means "your token is no good" - it clears
// the token storage and bounces you to the login page. A permission failure is
// not that. The user IS authenticated, they simply may not have this endpoint,
// and a page that calls it opportunistically (the designer probing settings, an
// admin table loading its lookups) must be able to catch the error and carry on.
// Answering 401 there logged the user straight out instead, and in a non-english
// locale - where the message no longer matched the interceptor's english test -
// it fell through to the refresh branch, refreshed successfully (the token was
// always valid), retried, got 401 again, and looped.
//
// So : 403 when we know who you are and you may not do this, 401 only when we
// could not establish who you are at all (req.user missing or malformed, which
// authobj should already have rejected - this is the defensive path).
function permissionGuard(hasPermission, detailKey){
  return (req, res, next) => {
    try {
      if (!hasPermission(req.user.user)) {
        res.status(403).json(RestResult.error(i18n.t(req, 'errors.noAccess'), i18n.t(req, detailKey)));
      } else {
        next();
      }
    } catch (e) {
      res.status(401).json(RestResult.error(i18n.t(req, 'errors.noAccess'), i18n.t(req, detailKey)));
    }
  }
}

// a middleware in the routes to check if use is administrator
Middleware.checkAdminMiddleware = permissionGuard(u => u.roles.includes("admin"), 'errors.notAdmin')

Middleware.checkSettingsMiddleware = permissionGuard(u => u.options.showSettings, 'errors.noSettingsAccess')

// the designer : switched on for the instance (SHOW_DESIGNER, read at every request so a change
// applies at once, without signing in again) and the user's own showDesigner option
Middleware.checkDesignerMiddleware = permissionGuard(u => appConfig.showDesigner && u.options.showDesigner, 'errors.noDesignerAccess')

// the designer's files : each kind written (saved, new, removed, pushed) only with its own role
// option ; read by every designer (a form or a workflow picks one)
// a Map, not an object : the kind comes from the url, and an object would also answer for
// 'constructor' or 'toString' with a function that is not a guard
const FILE_DESIGN_GUARDS = new Map([
  ['playbooks', permissionGuard(u => u.options.allowPlaybookDesign, 'errors.noPlaybookDesignAccess')],
  ['workflows', permissionGuard(u => u.options.allowWorkflowDesign, 'errors.noWorkflowDesignAccess')],
  ['inventories', permissionGuard(u => u.options.allowInventoryDesign, 'errors.noInventoryDesignAccess')],
  ['vars', permissionGuard(u => u.options.allowVarsFileDesign, 'errors.noVarsFileDesignAccess')],
])
Middleware.checkFileDesignMiddleware = (req, res, next) => {
  const guard = FILE_DESIGN_GUARDS.get(req.params?.kind)
  return typeof guard === 'function' ? guard(req, res, next) : next()
}

// the designer's forms config (categories, constants, forms) : saved, restored, pulled or pushed only
// with allowFormDesign ; read by every designer
Middleware.checkFormDesignMiddleware = permissionGuard(u => u.options.allowFormDesign, 'errors.noFormDesignAccess')
Middleware.checkLogsMiddleware = permissionGuard(u => u.options.showLogs, 'errors.noLogsAccess')
// a part of the settings on its own (lib/settingsSections.js) : with every setting, or that part
Middleware.checkAppearanceMiddleware = permissionGuard(u => u.options.showSettings || u.options.showAppearanceSettings, 'errors.noSettingsAccess')
Middleware.checkConnectionsMiddleware = permissionGuard(u => u.options.showSettings || u.options.showConnectionsSettings, 'errors.noSettingsAccess')
// the endpoints every part writes through (the settings row, the environment variables) : any
// part ; their handlers then check each field (lib/settingsSections.js)
Middleware.checkAnySettingsMiddleware = permissionGuard(u => u.options.showSettings || u.options.showAppearanceSettings || u.options.showConnectionsSettings, 'errors.noSettingsAccess')
// the audit log : with the settings, or on its own (showAuditLog : a compliance role reads it
// without the rights to change anything)
Middleware.checkAuditMiddleware = permissionGuard(u => u.options.showSettings || u.options.showAuditLog, 'errors.noAuditAccess')

Middleware.checkBackupMiddleware = permissionGuard(u => u.options.allowBackupOps, 'errors.noDatabaseAccess')

Middleware.checkScheduledJobsMiddleware = permissionGuard(u => u.options.allowScheduledJobs, 'errors.noScheduleAccess')

// The /api/v2/schedule mount. "Run later (one-time)" on a form is offered to
// allowPlannedJobs (on for everyone by default), and it creates a one-time schedule -
// but the whole mount used to sit behind allowScheduledJobs (admin-only by default), so
// every non-admin who pressed it got "You do not have permission to manage scheduled jobs".
//
// allowScheduledJobs stays what it was : the admin-level right to see and change ALL
// schedules. allowPlannedJobs on its own opens exactly ONE door, POST / (create), and the
// controller then narrows that to a one-time run of a form the user may run, which runs
// as that user rather than as admin (Schedule.plan). Listing, reading, editing, deleting
// and launching stay refused, so a planner never sees anybody else's schedules.
Middleware.checkScheduleOrPlannedJobsMiddleware = (req, res, next) => {
  try {
    const user = req.user.user;
    if (user.options.allowScheduledJobs) return next();
    if (user.options.allowPlannedJobs && req.method === 'POST' && req.path === '/') return next();
    res.status(403).json(RestResult.error(i18n.t(req, 'errors.noAccess'), i18n.t(req, 'errors.noScheduleAccess')));
  } catch (e) {
    // same 401-vs-403 rule as permissionGuard : 401 only when we cannot tell who you are
    res.status(401).json(RestResult.error(i18n.t(req, 'errors.noAccess'), i18n.t(req, 'errors.noScheduleAccess')));
  }
}

Middleware.checkStoredJobsMiddleware = permissionGuard(u => u.options.allowStoredJobs, 'errors.noStoredJobsAccess')
Middleware.checkChatMiddleware = permissionGuard(u => u.options.allowChat !== false, 'errors.noChatAccess')
// the MCP server : its own role option (allowMcp, the allowChat of the role when it names none)
Middleware.checkMcpMiddleware = permissionGuard(u => u.options.allowMcp !== false, 'errors.noMcpAccess')

// The schedules page is gated on allowScheduledJobs rather than showSettings, but
// its form dropdown reads config/formnames - a list that is deliberately NOT role
// filtered (unlike config/formlist), so it has to stay behind a permission.
// Either administrative right is enough to see it.
Middleware.checkSettingsOrScheduledJobsMiddleware = permissionGuard(
  u => u.options.showSettings || u.options.allowScheduledJobs, 'errors.noSettingsAccess')

// the form names a stored job, a schedule or the settings pick from : a user who may store jobs
// gets those of their own forms (config.controller formNames), the others every form
Middleware.checkFormNamesMiddleware = permissionGuard(
  u => u.options.showSettings || u.options.allowScheduledJobs || u.options.allowStoredJobs, 'errors.noSettingsAccess')

// A user who signed in with the public default password (config/app.config.js
// DEFAULT_ADMIN_PASSWORD) may do one thing : change it, on /api/v2/profile. Everything else
// answers 403 with code password_change_required, which the client turns into the
// change-password page. Mounted right after the token check, on every authenticated route.
Middleware.passwordChangeGate = (req, res, next) => {
  if (!req?.user?.user?.mustChangePassword) return next();
  if (req.baseUrl === '/api/v2/profile' || String(req.originalUrl || '').startsWith('/api/v2/profile')) return next();
  return res.status(403).json({ ...RestResult.error(i18n.t(req, 'auth.passwordChangeRequired')), code: 'password_change_required' });
}

// The disclaimer (Settings > Access > Disclaimer) : switched on, a user who has not accepted its
// current version may read it and accept it (/api/v2/disclaimer), read their profile and follow
// the live events ; everything else answers 403 with code disclaimer_required, which the client
// turns into the disclaimer's dialog. An api token (a script, no one to click) passes. Mounted
// after the password change gate, on every authenticated route.
const DISCLAIMER_OPEN = ['/api/v2/disclaimer', '/api/v2/profile', '/api/v2/events'];
Middleware.disclaimerGate = async (req, res, next) => {
  const user = req?.user?.user;
  if (!user || req.user.api) return next();
  if (DISCLAIMER_OPEN.includes(req.baseUrl)) return next();
  try {
    // loaded here : the guards above must not pull the database layer in with them
    const { default: Disclaimer } = await import("../models/disclaimer.model.js");
    if (!(await Disclaimer.isRequired(user))) return next();
  } catch (e) {
    // a database before its patch (no table yet) : no disclaimer to wait for
    logger.debug(`Could not read the disclaimer: ${e.message || e}`);
    return next();
  }
  return res.status(403).json({ ...RestResult.error(i18n.t(req, 'auth.disclaimerRequired')), code: 'disclaimer_required' });
}

// The scope of the signed-in user (lib/resourceScope.js) for the rest of the request : what
// their roles allow of the credentials, the secret stores and the runners. Resolving a
// credential - a form query, fnCredentials, a launch - checks it. The roles of the
// configuration as it is now, so a changed role applies at once.
Middleware.resourceScope = async (req, res, next) => {
  let scope = null;
  try {
    const user = req?.user?.user;
    if (user && !(user.roles || []).includes('admin')) {
      // loaded here : the guards above must not pull the database layer in with them
      const { default: Form } = await import("../models/form.model.js");
      scope = scopeFromRoles(user, (await Form.load(null, null, null, true))?.roles || []);
    }
  } catch (e) {
    logger.error(`Could not read the roles' resource scope: ${e.message || e}`);
    return res.status(500).json(RestResult.error(i18n.t(req, 'errors.noAccess'), 'The roles could not be read'));
  }
  return runWithScope(scope, next);
}

export default Middleware
