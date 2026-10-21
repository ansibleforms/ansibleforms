
'use strict';
import OAuth2 from '../../models/oauth2.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import Errors from '../../lib/errors.js';
import i18n from '../../lib/i18n.js';
import { SECRET_MASK } from '../../lib/secretMask.js';
import auth_entraid from '../../auth/auth_entraid.js';
import auth_oidc from '../../auth/auth_oidc.js';
import RepoObjects from '../../lib/repoObjects/index.js';

const oauth2Controller = {
  // List all OAuth2 providers or filter by name
  async find(req, res) {
    try {
      if (req.query.name) {
        const oauth2 = await OAuth2.findByName(req.query.name);
        // Mask client_secret before returning to API
        if (oauth2 && oauth2.client_secret) {
          oauth2.client_secret = SECRET_MASK;
        }
        return res.json(RestResult.single(oauth2));
      } else {
        const oauth2List = await OAuth2.findAll();
        // Mask client_secrets before returning to API
        oauth2List.forEach(o => {
          if (o.client_secret) o.client_secret = SECRET_MASK;
        });
        return res.json(RestResult.list(oauth2List));
      }
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },

  // Create new OAuth2 provider
  async create(req, res) {
    try {
      // the SSO repository follows (lib/repoObjects) : the new provider a new file, without its
      // secret, and the others' files where they changed - enabled, it turns the other providers of
      // its type off (and Skip the login page the others')
      const created = await RepoObjects.following('sso', () => OAuth2.create(req.body));
      await auth_entraid.initialize(); // we wait for Entra ID to be ready
      await auth_oidc.initialize(); // we wait for the oidc to be ready
      return res.status(201).json(RestResult.single(i18n.t(req, 'resources.oauth2Added'), created));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },

  // Find by ID
  async findById(req, res) {
    try {
      const oauth2 = await OAuth2.findById(req.params.id);
      oauth2.client_secret = SECRET_MASK; // mask the client_secret for API
      return res.json(RestResult.single(oauth2));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },

  // Update OAuth2 provider
  async update(req, res) {
    try {
      // the SSO repository follows : this provider's changed fields written to its file, and the
      // others' it turned off
      const updated = await RepoObjects.following('sso', () => OAuth2.update(req.body, req.params.id));
      await auth_entraid.initialize(); // we wait for Entra ID to be ready
      await auth_oidc.initialize(); // we wait for the oidc to be ready      
      return res.json(RestResult.single(updated));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },

  // Delete OAuth2 provider
  async delete(req, res) {
    try {
      const before = await OAuth2.findById(req.params.id).catch(() => null);
      const deleted = await RepoObjects.holding([], async () => {
        const deleted = await OAuth2.delete(req.params.id);
        // one of the SSO repository : its file goes too, for the repository's Push
        if (before?.repository) await RepoObjects.appDeleted('sso', before);
        return deleted;
      }, before);
      await auth_entraid.initialize(); // we wait for Entra ID to be ready
      await auth_oidc.initialize(); // we wait for the oidc to be ready
      return res.json(RestResult.single(deleted));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  }
};

export default oauth2Controller;
