'use strict';
import { forgetAppDefaults } from "../../routes/v2/app.routes.js";
import { publish } from "../../lib/liveEvents.js";
import Settings from '../../models/settings.model.js';
import Form from '../../models/form.model.js';
import Lock from '../../models/lock.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import Helpers from '../../lib/common.js';
import i18n from '../../lib/i18n.js';
import { isMasked } from '../../lib/secretMask.js';
import yaml from 'yaml';
import appConfig from '../../../config/app.config.js';
import { auditConfigChange, configHash as auditConfigHash } from '../../lib/configAudit.js';
import { readableSettingsFields, writableSettingsFields } from '../../lib/settingsSections.js';
import { assertAdminRoleUnchanged, assertKeepsOwnAdmin } from '../../lib/adminGrants.js';
import Errors from '../../lib/errors.js';
import logger from '../../lib/logger.js';


// Config edits are exclusive with an active designer session : the designer
// snapshots the config at lock time and rewrites it on save, so any config
// mutation from here (save/import/export) would silently fight it. When the
// lock is held, send a 423 and return true so the caller stops.
const refuseWhileDesignerLocked = async function(req, res) {
  if (!(await Lock.isHeld())) {
    return false;
  }
  let holder = '';
  try {
    const status = await Lock.status(req?.user?.user || {});
    holder = status?.lock?.username ? ` (${status.lock.username})` : '';
  } catch(e) {
    // holder details unavailable (designer disabled for this user) : stay generic
  }
  res.status(423).json(RestResult.error(i18n.t(req, 'resources.configLockedByDesigner', { username: holder })));
  return true;
};

// Fingerprint of a config text, used for optimistic concurrency on the config
// editor : getConfig hands out the hash of what it served and saveConfig refuses
// when the active config no longer matches it.
// re-exported from configAudit so the concurrency check and the hash recorded in the
// audit trail can never drift apart : two separate sha256 helpers that MUST agree is
// a latent bug waiting for someone to "improve" one of them
const configHash = auditConfigHash;

const find = async function(req, res) {
    try {
      const settings = await Settings.find();
      // Expose the env-derived config mode so the client (settings page + designer)
      // knows whether the active config lives in the database.
      if (settings) {
        settings.enableConfigInDatabase = appConfig.enableConfigInDatabase;
      }
      // a part of the settings on its own (lib/settingsSections.js) : only its fields
      const readable = readableSettingsFields(req);
      if (settings && readable) {
        for (const key of Object.keys(settings)) {
          if (!readable.has(key) && key !== 'enableConfigInDatabase') delete settings[key];
        }
      }
      res.json(RestResult.single(settings));
    } catch(err) {
      res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindSettings'), Helpers.getError(err)));
    }
};

/**
 * POST /api/v2/settings/mailcheck : sends a test mail with the mail server values of the body.
 *
 * Since 7.6 the settings row holds no mail settings (the mail goes through the mail channels of
 * Connections > Notifications, whose own check tests a stored channel), so there is no stored
 * password either : the masked password is refused, the password has to be typed.
 *
 * Args:
 *   req (object): the request ; its body mail_server, mail_port, mail_secure, mail_username,
 *     mail_password, mail_from, to, and optionally subject and body.
 *   res (object): the response.
 *
 * Returns:
 *   Promise<void>: answers the message id, 400 for a masked password, 500 when sending fails.
 */
const mailcheck = async function(req, res) {
  try {
    // step 1 : the masked password stood for the stored one, there is none any more
    if (isMasked(req.body.mail_password)) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.mailCheckFailed'), i18n.t(req, 'resources.storedPasswordOtherServer')));
    }
    // step 2 : the server values as they were sent, nothing else from the body
    const config = {
      mail_server: req.body.mail_server,
      mail_port: req.body.mail_port,
      mail_secure: req.body.mail_secure ? 1 : 0,
      mail_username: req.body.mail_username,
      mail_password: req.body.mail_password,
      mail_from: req.body.mail_from,
    };
    // step 3 : the settings page sends no subject or body : the test mail is in the admin's language
    const subject = req.body.subject || i18n.t(req, 'email.test.subject');
    const body = req.body.body || i18n.t(req, 'email.test.body');
    const messageid = await Settings.mailcheck(config, req.body.to, subject, body);
    res.json(RestResult.single({ message: i18n.t(req, 'resources.mailSent', { id: messageid }) }));
  } catch(err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.mailCheckFailed'), Helpers.getError(err)));
  }
};

// The only settings field the declarative config seed writes (see lib/seed.js
// applySettings and the settingsSection in lib/seed-schema.js). Everything else on the
// settings row - config_yaml, the logo, the theme, the language, config_source - is not
// seed material and must stay saveable on a seeded instance. The seed's mail_* keys of
// before 7.6 write a mail channel and its smtp credential now, which are managed records
// of their own.
const SEED_OWNED_SETTINGS = ['url'];

/**
 * Which seed-owned fields this request would actually CHANGE. Comparing values rather
 * than merely looking for the key means the mail page can still save a theme change,
 * and a form that round-trips every field it loaded is not refused for fields it left
 * untouched. Returns [] when nothing seed-owned is being altered.
 */
export function seedManagedSettingChanges(body, stored) {
  return SEED_OWNED_SETTINGS.filter((field) => {
    const wanted = body[field];
    if (wanted === undefined) return false;
    return String(stored[field] ?? '') !== String(wanted ?? '');
  });
}

const update = async function(req, res) {
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
        try {
          // a part of the settings on its own (lib/settingsSections.js) : only its fields change
          const writable = writableSettingsFields(req);
          const outside = writable ? Object.keys(req.body).filter((key) => !writable.has(key)) : [];
          if (outside.length) {
            return res.status(403).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'),
              `${i18n.t(req, 'errors.noSettingsAccess')} (${outside.join(', ')})`));
          }
          const existingSettings = await Settings.find();
          // The seed owns the url. It does NOT own the theme, the
          // language or config_source, which travel through this same endpoint - so the
          // refusal has to be scoped to the FIELDS, not to the call. Refusing the whole
          // endpoint meant declaring `url` in a seed froze the theme picker, which
          // contradicts what the seed schema says it leaves alone.
          if (existingSettings?.managed) {
            const blocked = seedManagedSettingChanges(req.body, existingSettings);
            if (blocked.length) {
              return res.status(403).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'),
                `${i18n.t(req, 'resources.seedManagedSettings')} (${blocked.join(', ')})`));
            }
          }
          const record = new Settings(req.body);
          // Guard against an effectively-empty record (no recognized fields),
          // which would produce invalid `UPDATE t set ?` SQL.
          if (Object.keys(record).length === 0) {
            return res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
          }
          await Settings.update(record);
          // the theme, the name, the label, the announcement : shown at once, in every open tab
          // (the 'appearance' live event : the header re-reads /api/v2/app/config)
          forgetAppDefaults();
          publish("appearance");
          res.json(RestResult.single(null));
        } catch(err) {
          res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), Helpers.getError(err)));
        }
    }
};

const importConfig = async function(req, res) {
    try {
      // rewrites the DB config from config.yaml : same designer-lock guard as saveConfig
      if (await refuseWhileDesignerLocked(req, res)) return;
      // who is an admin is the admin's : the model hands the roles of the file to this check
      // before it writes, and a non-admin whose file changes the admin role is refused
      // and an admin whose file would take admin away from them is refused too
      const message = await Settings.importConfig({
        assertRoles: async (roles) => {
          await assertAdminRoleUnchanged(req, roles);
          await assertKeepsOwnAdmin(req, roles);
        },
      });
      res.json(RestResult.single({ message }));
    } catch(err) {
      if (err instanceof Errors.ConflictError) {
        return res.status(409).json(RestResult.error(i18n.t(req, 'resources.failedImportConfig'), err.message));
      }
      if (err instanceof Errors.AccessDeniedError) {
        return res.status(403).json(RestResult.error(i18n.t(req, 'resources.failedImportConfig'), err.message));
      }
      res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedImportConfig'), Helpers.getError(err)));
    }
};

const exportConfig = async function(req, res) {
    try {
      // overwrites config.yaml on disk : same designer-lock guard as saveConfig
      if (await refuseWhileDesignerLocked(req, res)) return;
      const message = await Settings.exportConfig();
      res.json(RestResult.single({ message }));
    } catch(err) {
      // the model tags a refusal the admin can act on (wrong config source, nothing
      // to export) with a 4xx status ; anything untagged is a real server fault.
      res.status(err.statusCode || 500).json(RestResult.error(i18n.t(req, 'resources.failedExportConfig'), Helpers.getError(err)));
    }
};

const getConfig = async function(req, res) {
    try {
      const yaml = await Settings.getActiveConfig();
      // baseHash lets the client detect a concurrent change on save (see saveConfig)
      // config_yaml, and forms_yaml as before 7.6 (deprecated, removed in 8) for the clients
      // that still read it
      res.json(RestResult.single({ config_yaml: yaml, forms_yaml: yaml, baseHash: configHash(yaml) }));
    } catch(err) {
      res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindSettings'), Helpers.getError(err)));
    }
};

/**
 * The config content a PUT /settings/config sends : config_yaml, else forms_yaml, its name
 * before 7.6 (deprecated, removed in 8 : a warning in the log when a client still sends it).
 *
 * Args:
 *   body (object): the request body.
 *
 * Returns:
 *   string|null: the config text, or null when neither is sent.
 */
export function configYamlOf(body) {
  if (body?.config_yaml != null) return body.config_yaml;
  if (body?.forms_yaml != null) {
    logger.warning("PUT /api/v2/settings/config with forms_yaml is deprecated since 7.6 and removed in 8: send config_yaml");
    return body.forms_yaml;
  }
  return null;
}

const saveConfig = async function(req, res) {
    const configYaml = configYamlOf(req.body);
    if (configYaml == null) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }
    // Config editing is exclusive with an active designer session : refuse while held.
    if (await refuseWhileDesignerLocked(req, res)) return;
    // Validate before persisting: bad config breaks every Form.load
    let parsed;
    try {
      parsed = yaml.parse(configYaml);
    } catch(err) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), Helpers.getError(err)));
    }
    try {
      Form.validateConfig({
        categories: parsed?.categories || [],
        roles: parsed?.roles || [],
        constants: parsed?.constants || {}
      });
      // a save must keep the admin and default roles (the load does not check it, so an
      // install that lost one still starts)
      Form.assertRequiredRoles({ roles: parsed?.roles });
    } catch(err) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), Helpers.getError(err)));
    }
    try {
      // Settings > Roles saves through here : a user with settings access edits the other
      // roles, but only an admin changes who the admin role makes an admin
      await assertAdminRoleUnchanged(req, parsed?.roles || []);
      // and an admin never saves roles that take admin away from them
      await assertKeepsOwnAdmin(req, parsed?.roles || []);
    } catch(err) {
      if (err instanceof Errors.AccessDeniedError) {
        return res.status(403).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), err.message));
      }
      if (err instanceof Errors.ConflictError) {
        return res.status(409).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), err.message));
      }
      return res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), Helpers.getError(err)));
    }
    try {
      // Optimistic concurrency : the client sends back the baseHash getConfig gave
      // it. When the active config changed in the meantime (another admin saving,
      // an import, a designer save) refuse instead of silently clobbering it.
      // baseHash is optional : callers that don't send one keep last-write-wins.
      // read the previous config before overwriting it : the audit delta needs both
      // sides, and this is the only point that has them
      const previous = await Settings.getActiveConfig().catch(() => '');
      if (req.body.baseHash) {
        if (configHash(previous) !== req.body.baseHash) {
          return res.status(409).json(RestResult.error(i18n.t(req, 'resources.configChangedElsewhere')));
        }
      }
      await Settings.saveActiveConfig(configYaml);
      // after the write succeeded, and never awaited : a slow audit must not delay
      // the response, and a failing one must not turn a good save into a 500
      auditConfigChange({
        user: req.user?.user,
        ip: req.ip,
        oldYaml: previous,
        newYaml: configYaml,
        // already parsed above for validateConfig : reusing it avoids a second parse of
        // the same document, which on a large config is measured in seconds
        parsedAfter: parsed || {},
        source: 'active',
      });
      res.json(RestResult.single(null));
    } catch(err) {
      res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSettings'), Helpers.getError(err)));
    }
};


export default {
    find,
    mailcheck,
    update,
    importConfig,
    exportConfig,
    getConfig,
    saveConfig
};
