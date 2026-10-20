'use strict';
import ChatSettings from '../../models/chatSettings.model.js';
import RestResultv2 from '../../models/restResult.model.v2.js';
import logger from "../../lib/logger.js";
import i18n from '../../lib/i18n.js';
import { SECRET_MASK, isMasked } from '../../lib/secretMask.js';
import { checkProvider } from '../../chat/providers/index.js';
import CredentialModel from '../../models/credential.model.v2.js';
import Errors from '../../lib/errors.js';
import { isAdminRequest } from '../../lib/adminGrants.js';
import { stripTrailingSlashes } from '../../lib/url.js';
import RepoObjects from '../../lib/repoObjects/index.js';

// the mask the key is shown as (lib/secretMask.js)
const MASK = SECRET_MASK;

/**
 * Whether settings send their key to the same place as the saved ones : the same provider, base
 * url and certificate check. A stored key (the row's own, or its credential's) only goes there,
 * as the settings page's mail check keeps the stored mail password for the stored server.
 *
 * Args:
 *   saved (object): the row as it is stored.
 *   wanted (object): the settings as they would be used.
 *
 * Returns:
 *   boolean: true when the key would go to the saved target.
 */
function sameTarget(saved, wanted) {
  const text = (v) => stripTrailingSlashes(v === null || v === undefined ? '' : String(v).trim());
  const flag = (v) => v === true || Number(v) === 1;
  return text(saved?.provider) === text(wanted?.provider)
    && text(saved?.base_url) === text(wanted?.base_url)
    && flag(saved?.ignore_certs) === flag(wanted?.ignore_certs);
}

/**
 * Refuses a credential only an admin may name (models/credential.model.v2.js isAdminGuarded : a
 * runner's, a connection's or a sign-in's) to anyone but an admin : the chat would send its secret
 * to a provider of their choosing.
 *
 * Args:
 *   req (object): the request.
 *   name (string): the credential named ; empty is none.
 *
 * Returns:
 *   Promise<void>: settles when the user may name it.
 *
 * Raises:
 *   Errors.AccessDeniedError: the user is not an admin and the credential is an admin's.
 */
async function assertMayName(req, name) {
  if (!name || isAdminRequest(req)) return;
  const cred = await CredentialModel.findRowByName(name);
  if (await CredentialModel.isAdminGuarded(cred)) {
    throw new Errors.AccessDeniedError(i18n.t(req, 'resources.credentialNotAllowed', { name }));
  }
}

const find = async function (req, res) {
  try {
    const row = await ChatSettings.find();
    // the api key never leaves the server
    if (row.api_key) row.api_key = MASK;
    res.status(200).json(RestResultv2.single(row));
  } catch (err) {
    logger.error("Error finding chat settings: ", err);
    res.status(500).json(RestResultv2.error(i18n.t(req, 'resources.failedFindChatSettings'), err.toString()));
  }
};

const update = async function (req, res) {
  if (!req.body || (req.body.constructor === Object && Object.keys(req.body).length === 0)) {
    return res.status(409).json(RestResultv2.error(i18n.t(req, 'errors.noDataSent')));
  }
  try {
    const existing = await ChatSettings.find();
    // from the declarative config seed : read only here, the seed re-applies it
    if (existing?.managed) {
      return res.status(403).json(RestResultv2.error(i18n.t(req, 'resources.failedUpdateChatSettings'), i18n.t(req, 'resources.seedManagedChatSettings')));
    }
    const body = { ...req.body };
    // moved to another provider, base url or certificate check by a user who is not an admin : the
    // stored key and the credential stay behind unless typed or chosen again (another credential
    // than the saved one is a choice ; the saved one sent back as it is, is not)
    if (!isAdminRequest(req) && !sameTarget(existing, { ...existing, ...body })) {
      if (body.api_key === undefined || isMasked(body.api_key)) body.api_key = '';
      if ((body.credential ?? existing.credential ?? '') === (existing.credential ?? '')) body.credential = '';
    }
    if (isMasked(body.api_key)) body.api_key = existing.api_key;
    try {
      await ChatSettings.assertCredentialUsable(body.credential);
      // the saved credential sent back as it is stays, whoever saved it
      if ((body.credential || '') !== (existing.credential || '')) await assertMayName(req, body.credential);
    } catch (err) {
      return res.status(err instanceof Errors.ApiError ? err.status : 400).json(RestResultv2.error(i18n.t(req, 'resources.failedUpdateChatSettings'), err.message));
    }
    let record;
    try {
      record = new ChatSettings(body);
    } catch (err) {
      // a setting that cannot be sent as it is (extra headers) : say which, do not store it
      return res.status(400).json(RestResultv2.error(i18n.t(req, 'resources.failedUpdateChatSettings'), err.message));
    }
    // the chat repository's chat.yaml, before : its changed fields written into it after
    const before = await RepoObjects.snapshot('chat');
    await ChatSettings.update(record);
    await RepoObjects.appUpdated('chat', before);
    res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'resources.chatSettingsUpdated') }));
  } catch (err) {
    logger.error("Error updating chat settings: ", err);
    res.status(500).json(RestResultv2.error(i18n.t(req, 'resources.failedUpdateChatSettings'), err.toString()));
  }
};

const check = async function (req, res) {
  try {
    const existing = await ChatSettings.find();
    let body = { ...existing, ...(req.body || {}) };
    // the credential on the page, saved or not : an api one, and one this user may name
    try {
      await ChatSettings.assertCredentialUsable(body.credential);
      await assertMayName(req, body.credential);
    } catch (err) {
      return res.status(err instanceof Errors.ApiError ? err.status : 400).json(RestResultv2.error(i18n.t(req, 'resources.chatCheckFailed'), err.message));
    }
    // a key typed on the page goes where the page says ; a stored one (the row's own, or the
    // credential's) only to the provider, base url and certificate check it was saved with
    // typed means sent in THIS request : body also holds the stored (decrypted) key from the
    // saved row, so an omitted api_key would otherwise count as typed and skip the check
    const given = req.body?.api_key;
    const ownKeyTyped = typeof given === 'string' && given !== '' && !isMasked(given);
    const sendsStoredKey = !!body.credential || !ownKeyTyped;
    if (sendsStoredKey && !sameTarget(existing, body)) {
      return res.status(400).json(RestResultv2.error(i18n.t(req, 'resources.chatCheckFailed'), i18n.t(req, 'resources.storedKeyOtherProvider')));
    }
    if (!ownKeyTyped) body.api_key = existing.api_key;
    // the key of the credential it names (the one on the page, saved or not)
    body = await ChatSettings.withCredential(body);
    const result = await checkProvider(body);
    res.status(200).json(RestResultv2.single(result));
  } catch (err) {
    // the provider's status and message, never the key
    logger.warning(`Chat provider check failed: ${err.message}`);
    res.status(502).json(RestResultv2.error(i18n.t(req, 'resources.chatCheckFailed'), err.message));
  }
};

export default { find, update, check };
