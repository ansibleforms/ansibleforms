'use strict';
// Settings > Access > LDAP : the directories, each with its own servers, users and groups. The
// default one is also /api/v2/ldap (ldap.controller.js), as before there were several : that
// controller hands its requests to these handlers, for the default directory.
import Ldap from '../../models/ldap.model.js';
import RestResultv2 from '../../models/restResult.model.v2.js';
import Errors from '../../lib/errors.js';
import logger from "../../lib/logger.js";
import i18n from '../../lib/i18n.js';
import { publicError } from './publicError.js';
import { withEnds } from '../../models/listOrder.js';
import { SECRET_MASK, isMasked } from '../../lib/secretMask.js';
import RepoObjects from '../../lib/repoObjects/index.js';

// a directory's connection : its credential's when the credential holds one (Ldap.withConnection)
const CONNECTION_KEYS = ['server', 'port', 'enable_tls', 'ignore_certs', 'cert', 'ca_bundle'];

// what decides where a check connects to, and how : the stored bind password is only ever
// sent there
const LDAP_TARGET_TEXT = ['server', 'port', 'cert', 'ca_bundle'];
const LDAP_TARGET_FLAGS = ['enable_tls', 'ignore_certs'];

/**
 * Whether a check is for the stored LDAP server : every connection field as stored. A port
 * sent as text or a number, and a flag as true or 1, count as the same value.
 *
 * Args:
 *   sent (object): the configuration of the check.
 *   stored (object): the stored configuration.
 *
 * Returns:
 *   boolean: true when the check connects where the stored configuration does.
 */
export function sameLdapTarget(sent, stored) {
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const flag = (v) => v === true || Number(v) === 1;
  return LDAP_TARGET_TEXT.every((f) => text(sent?.[f]) === text(stored?.[f]))
    && LDAP_TARGET_FLAGS.every((f) => flag(sent?.[f]) === flag(stored?.[f]));
}

/**
 * A directory as the API shows it : its bind password masked.
 *
 * Args:
 *   directory (object): the directory, its password decrypted.
 *
 * Returns:
 *   object: the directory to send.
 */
function shown(directory) {
  return directory ? { ...directory, bind_user_pw: directory.bind_user_pw ? SECRET_MASK : '' } : directory;
}

/**
 * Refuses a request that carried no data.
 *
 * Args:
 *   req (object): the request.
 *
 * Raises:
 *   Errors.BadRequestError: its body is empty.
 */
function assertBody(req) {
  if (!req.body || (req.body.constructor === Object && Object.keys(req.body).length === 0)) {
    throw new Errors.BadRequestError(i18n.t(req, 'errors.noDataSent'));
  }
}

/**
 * A directory by the id of the request, as stored.
 *
 * Args:
 *   req (object): the request (params.id).
 *
 * Returns:
 *   Promise<object>: the directory, its bind password decrypted.
 *
 * Raises:
 *   Errors.NotFoundError: there is no such directory.
 */
async function existingOf(req) {
  const directory = await Ldap.findById(req.params.id);
  if (!directory) throw new Errors.NotFoundError(i18n.t(req, 'resources.ldapNotFound'));
  return directory;
}

const findAll = async function (req, res) {
  try {
    // in the lookup order, the first and the last said (the list's Move up and Move down)
    // each with the connection it uses : its credential's servers and TLS (the API's server, port,
    // enable_tls... as before), else its own
    const all = await Promise.all((await Ldap.findAll()).map((d) => Ldap.withConnection(d)));
    res.status(200).json(RestResultv2.list(withEnds(all.map(shown))));
  } catch (err) {
    logger.error("Error finding the LDAP directories: ", err);
    Errors.ReturnError(res, publicError(req, err));
  }
};

const findById = async function (req, res) {
  try {
    res.status(200).json(RestResultv2.single(shown(await Ldap.withConnection(await existingOf(req)))));
  } catch (err) {
    logger.error("Error finding the LDAP directory: ", err);
    Errors.ReturnError(res, publicError(req, err));
  }
};

const create = async function (req, res) {
  try {
    assertBody(req);
    const id = await RepoObjects.holding('ldap', async () => {
      const id = await Ldap.create({ ...new Ldap(req.body), managed: 0 });
      // the LDAP repository, when there is one : written to it as a new file, without its password
      await RepoObjects.appCreated('ldap', id);
      return id;
    });
    res.status(201).json(RestResultv2.single({ id, message: i18n.t(req, 'resources.ldapCreated') }));
  } catch (err) {
    logger.error("Error adding an LDAP directory: ", err);
    Errors.ReturnError(res, publicError(req, err));
  }
};

const update = async function (req, res) {
  try {
    assertBody(req);
    const existing = await existingOf(req);
    // a directory of the config seed is read only here : the seed re-applies on every start, so
    // a save would be silently reverted
    if (existing.managed) throw new Errors.AccessDeniedError(i18n.t(req, 'resources.seedManagedLdap'));
    // what was sent over what is stored : a field not sent is kept (the converting constructor
    // would otherwise empty it, or switch a flag off) ; the masked password, the stored one
    const sent = { ...existing, ...req.body };
    if (isMasked(sent.bind_user_pw)) sent.bind_user_pw = existing.bind_user_pw;
    const record = { ...new Ldap(sent) };
    delete record.id;
    delete record.testuser;
    delete record.testpassword;
    delete record.managed;
    // its connection shown is its credential's : never written back over its own
    if (await Ldap.connectionOf(record.credential).catch(() => null)) {
      for (const key of CONNECTION_KEYS) record[key] = existing[key] ?? null;
    }
    await RepoObjects.holding([], async () => {
      await Ldap.updateById(existing.id, record);
      // one of the LDAP repository : its changed fields written to its file
      if (existing.repository) await RepoObjects.appUpdated('ldap', existing, existing.id);
    }, existing);
    res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'resources.ldapUpdated') }));
  } catch (err) {
    logger.error("Error updating the LDAP directory: ", err);
    Errors.ReturnError(res, publicError(req, err));
  }
};

const remove = async function (req, res) {
  try {
    const before = await Ldap.findById(req.params.id).catch(() => null);
    await RepoObjects.holding([], async () => {
      await Ldap.deleteById(req.params.id);
      // one of the LDAP repository : its file goes too, for the repository's Push
      if (before?.repository) await RepoObjects.appDeleted('ldap', before);
    }, before);
    res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'resources.ldapDeleted') }));
  } catch (err) {
    logger.error("Error deleting the LDAP directory: ", err);
    Errors.ReturnError(res, publicError(req, err));
  }
};

// one place up or down in the lookup order : { direction: 'up' | 'down' }
const move = async function (req, res) {
  try {
    // every place numbered again : the LDAP repository's files follow
    const moved = await RepoObjects.following('ldap', () => Ldap.move(req.params.id, req.body?.direction));
    res.status(200).json(RestResultv2.single({ moved }));
  } catch (err) {
    logger.error("Error moving the LDAP directory: ", err);
    Errors.ReturnError(res, publicError(req, err));
  }
};

const check = async function (req, res) {
  try {
    assertBody(req);
    const existing = await existingOf(req);
    // the page's fields as they are (saved or not) ; the stored bind password only for the stored
    // servers, never handed to others
    const sent = { ...existing, ...req.body };
    // a credential the directory does not use yet : an ldap one only, as a save would require -
    // a runner's token or a database login is never handed to an LDAP server
    if (sent.credential && sent.credential !== existing.credential) await Ldap.checkCredential(sent.credential);
    // its credential's servers and account (shown on its page) : its own are left as they are,
    // the test reads the credential's (Ldap.authenticateOn)
    if (await Ldap.connectionOf(sent.credential).catch(() => null)) {
      for (const key of CONNECTION_KEYS) sent[key] = existing[key] ?? null;
      sent.bind_user_pw = existing.bind_user_pw;
    } else {
      // the bind password : what the request sent ; the stored one only when it sent the mask or
      // none, and for the stored servers. Merged in with the rest, a request that left it out
      // took the stored password along to any server it named.
      const given = req.body.bind_user_pw;
      if (given === undefined || given === null || isMasked(given)) {
        if (sameLdapTarget(sent, existing)) {
          sent.bind_user_pw = existing.bind_user_pw;
        } else if (isMasked(given)) {
          return res.status(400).json(RestResultv2.error(i18n.t(req, 'resources.ldapCheckFailed'), i18n.t(req, 'resources.storedPasswordOtherServer')));
        } else {
          sent.bind_user_pw = '';
        }
      }
    }
    res.status(200).json(RestResultv2.single(await Ldap.check(new Ldap(sent))));
  } catch (err) {
    logger.error("Error checking the LDAP directory: ", err);
    // a request refused (no data, no such directory, a credential of another kind) says why ;
    // the directory's own answer is the check's result, under what failed
    if (err instanceof Errors.ApiError) return Errors.ReturnError(res, err);
    res.status(500).json(RestResultv2.error(i18n.t(req, 'resources.ldapCheckFailed'), publicError(req, err).message || err.toString()));
  }
};

export default { findAll, findById, create, update, remove, move, check };
