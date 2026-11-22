'use strict';
import KnownHosts from '../../models/knownhosts.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import Errors from '../../lib/errors.js';
import i18n from '../../lib/i18n.js';
import RepoObjects from '../../lib/repoObjects/index.js';

/**
 * Changes the known hosts as the page does, written after into the SSH repository's ssh: map
 * (its known_hosts), under its write claim.
 *
 * Args:
 *   change (function): async () => the change's result.
 *
 * Returns:
 *   Promise<any>: its result.
 */
async function withSshFile(change) {
  return RepoObjects.holding('ssh', async () => {
    const before = await RepoObjects.snapshot('ssh');
    const result = await change();
    await RepoObjects.appUpdated('ssh', before);
    return result;
  });
}

// Controller following v2 response conventions
const knownhostsController = {
  // Return the full list of known hosts
  async find(req, res) {
    try {
      const hosts = await KnownHosts.findAll();
      return res.json(RestResult.list(hosts));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },

  // Add a host key(s) to known_hosts
  async add(req, res) {
    try {
      const host = (req.body?.host || '').trim();
      if (!host) {
        return res.status(400).json(RestResult.error(i18n.t(req, 'resources.hostValueRequired')));
      }
      const result = await withSshFile(() => KnownHosts.add(host));
      return res.status(201).json(RestResult.single(result));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },

  // Remove a host from known_hosts
  async remove(req, res) {
    try {
      // support both ?name= and ?host= and allow passing full known_hosts line
      const raw = (req.query?.name || req.query?.host || '').trim();
      if (!raw) {
        return res.status(400).json(RestResult.error(i18n.t(req, 'resources.hostNameRequired')));
      }
      // if full line provided ("hostname keytype key"), extract first token
      const hostToken = raw.split(/\s+/)[0];
      const result = await withSshFile(() => KnownHosts.remove(hostToken));
      return res.json(RestResult.single(result));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  }
};

export default knownhostsController;
