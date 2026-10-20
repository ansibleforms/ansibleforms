"use strict";
import SecretStore, { SECRET_MASK as MASK } from "../../models/secretStore.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import { checkStore, listMounts } from "../../secrets/providers/index.js";
import { isAdminRequest } from "../../lib/adminGrants.js";
import RepoObjects from "../../lib/repoObjects/index.js";

/**
 * Refuses a write of a secret store to anyone but an admin. A store logs in with a Vault token or
 * a CyberArk client key, which it sends to its address on every read and on Check : a user with
 * only connections access who could add a store, or change the address of one, would receive
 * that secret at a server of their own, and every secret the credentials read through it. The
 * same rule as a runner's (controllers/v2/runner.controller.js assertAdmin) ; Check and the
 * mounts of a saved store, which send its secret only where an admin pointed it, stay open.
 *
 * Args:
 *   req (object): the request.
 *
 * Returns:
 *   void
 *
 * Raises:
 *   Errors.AccessDeniedError: the user is not an admin.
 */
function assertAdmin(req) {
  if (!isAdminRequest(req)) {
    throw new Errors.AccessDeniedError(i18n.t(req, "resources.secretStoreAdminOnly"));
  }
}

// token and client_key are stored encrypted and CrudModel decrypts them on read, so
// nothing leaves here without masking them - onto a copy, never the cached record.
function maskSecrets(store) {
  if (!store) return store;
  const copy = { ...store };
  if (copy.token) copy.token = MASK;
  if (copy.client_key) copy.client_key = MASK;
  return copy;
}

const find = async (req, res) => {
  try {
    if (req.query.name) {
      return res.json(RestResult.single(maskSecrets(await SecretStore.findByName(req.query.name))));
    }
    const list = await SecretStore.findAll();
    return res.json(RestResult.list((list || []).map(maskSecrets)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const create = async (req, res) => {
  try {
    assertAdmin(req);
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, 'errors.requiredFields'));
    }
    const created = await SecretStore.create(req.body);
    // the secret stores repository, when there is one : written to it as a new file (lib/repoObjects)
    await RepoObjects.appCreated('secret_stores', created);
    return res.status(201).json(RestResult.single(i18n.t(req, 'resources.secretStoreAdded'), created));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const findById = async (req, res) => {
  try {
    const store = await SecretStore.findById(req.params.id);
    if (!store) throw new Errors.NotFoundError(i18n.t(req, 'resources.secretStoreNotFound'));
    return res.json(RestResult.single(maskSecrets(store)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const update = async (req, res) => {
  try {
    assertAdmin(req);
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, 'errors.requiredFields'));
    }
    const before = await SecretStore.findById(req.params.id).catch(() => null);
    const updated = await SecretStore.update(req.body, req.params.id);
    if (!updated) throw new Errors.NotFoundError(i18n.t(req, 'resources.secretStoreNotFound'));
    // one of the secret stores repository : its changed fields written to its file
    if (before?.repository) await RepoObjects.appUpdated('secret_stores', before, req.params.id);
    return res.json(RestResult.single(updated));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const deleteStore = async (req, res) => {
  try {
    assertAdmin(req);
    const before = await SecretStore.findById(req.params.id).catch(() => null);
    const deleted = await SecretStore.delete(req.params.id);
    if (!deleted) throw new Errors.NotFoundError(i18n.t(req, 'resources.secretStoreNotFound'));
    // one of the secret stores repository : its file goes too, for the repository's Push
    if (before?.repository) await RepoObjects.appDeleted('secret_stores', before);
    return res.json(RestResult.single(deleted));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// Read only : proves the store answers and accepts us, never returns a secret
const check = async (req, res) => {
  try {
    const store = await SecretStore.findById(req.params.id);
    if (!store) throw new Errors.NotFoundError(i18n.t(req, 'resources.secretStoreNotFound'));
    const details = await checkStore(store);
    return res.json(RestResult.single({ result: i18n.t(req, 'resources.secretStoreConnectionOk'), details }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// The KV mounts a Vault token can see. Quiet on failure : the page falls back to free text.
const mounts = async (req, res) => {
  try {
    const store = await SecretStore.findById(req.params.id);
    if (!store) throw new Errors.NotFoundError(i18n.t(req, 'resources.secretStoreNotFound'));
    return res.json(RestResult.list(await listMounts(store)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

export default { find, create, findById, update, delete: deleteStore, check, mounts };
