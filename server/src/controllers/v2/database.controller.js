"use strict";
// Connections > Databases : the databases forms query (models/database.model.js), and a test of
// the connection of one. A database holds no secret : its login is its credential's, which no
// answer here hands out.
import Database from "../../models/database.model.js";
import CredentialModel from "../../models/credential.model.v2.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import logger from "../../lib/logger.js";
import Form from "../../models/form.model.js";
import { formCredentials } from "../../lib/formLinks.js";
import { isAdminRequest } from "../../lib/adminGrants.js";
import { publicError } from "./publicError.js";
import { testDatabase } from "./credential.controller.js";

/**
 * Keeps a user who is not an admin from naming a credential only an admin may name
 * (models/credential.model.v2.js isAdminGuarded : one a runner signs in with, one that reads its
 * password from a secret store) : the forms that query the database would connect with it, and
 * Test connection send its secret to its server. The credential a database already names, sent
 * back, is not checked again ; an admin's write is left as it is.
 *
 * Args:
 *   req (object): the request.
 *   existing (object|null): the database as it is, null on a create.
 *
 * Returns:
 *   Promise<void>: settles when the write may go on.
 *
 * Raises:
 *   Errors.AccessDeniedError: the credential chosen is an admin's.
 */
async function guardCredential(req, existing) {
  if (isAdminRequest(req)) return;
  const chosen = req.body?.credential;
  if (!chosen || chosen === existing?.credential) return;
  const guarded = await CredentialModel.firstAdminGuarded([chosen]);
  if (guarded) throw new Errors.AccessDeniedError(i18n.t(req, "resources.credentialNotAllowed", { name: guarded }));
}

/**
 * The databases with how many forms name each in a field's dbConfig (used_by_count), by its name
 * or by its credential's, as its page's Used by tab lists them. A count that cannot be read (the
 * forms do not load) leaves them at 0.
 *
 * Args:
 *   list (object[]): the databases.
 *
 * Returns:
 *   Promise<object[]>: copies, each with used_by_count.
 */
async function withUsage(list) {
  let counts = new Map();
  try {
    const config = await Form.load(undefined, undefined, true);
    counts = Database.formCounts(list, formCredentials(config.forms));
  } catch (err) {
    logger.debug(`The forms are left out of the databases' Used by count: ${err?.message || err}`);
  }
  return list.map((d) => ({ ...d, used_by_count: counts.get(d.name) || 0 }));
}

const find = async (req, res) => {
  try {
    if (req.query.name) {
      return res.json(RestResult.single(await Database.findByName(req.query.name)));
    }
    return res.json(RestResult.list(await withUsage(await Database.findAll())));
  } catch (err) {
    Errors.ReturnError(res, publicError(req, err));
  }
};

const create = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    await guardCredential(req, null);
    const created = await Database.create(req.body);
    // { message, id }, as the other records answer a create
    return res.status(201).json(RestResult.single({ message: i18n.t(req, "resources.databaseAdded"), id: created }));
  } catch (err) {
    Errors.ReturnError(res, publicError(req, err));
  }
};

const findById = async (req, res) => {
  try {
    const database = await Database.findById(req.params.id);
    if (!database) throw new Errors.NotFoundError(i18n.t(req, "resources.databaseNotFound"));
    return res.json(RestResult.single(database));
  } catch (err) {
    Errors.ReturnError(res, publicError(req, err));
  }
};

const update = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    const before = await Database.findById(req.params.id).catch(() => null);
    if (!before) throw new Errors.NotFoundError(i18n.t(req, "resources.databaseNotFound"));
    await guardCredential(req, before);
    await Database.update(req.body, req.params.id);
    return res.json(RestResult.single({ message: i18n.t(req, "success.updated", { resource: "Database" }) }));
  } catch (err) {
    Errors.ReturnError(res, publicError(req, err));
  }
};

const deleteDatabase = async (req, res) => {
  try {
    const deleted = await Database.delete(req.params.id);
    if (!deleted) throw new Errors.NotFoundError(i18n.t(req, "resources.databaseNotFound"));
    return res.json(RestResult.single({ message: i18n.t(req, "success.deleted", { resource: "Database" }) }));
  } catch (err) {
    Errors.ReturnError(res, publicError(req, err));
  }
};

// Test connection : its credential's, as the credential's own test (controllers/v2/credential.controller.js)
const check = async (req, res) => {
  try {
    const database = await Database.findById(req.params.id);
    if (!database) throw new Errors.NotFoundError(i18n.t(req, "resources.databaseNotFound"));
    await testDatabase(req, database.credential, database.db_type);
    return res.json(RestResult.single({ message: i18n.t(req, "success.connectionOk", { resource: database.name }) }));
  } catch (err) {
    Errors.ReturnError(res, publicError(req, err));
  }
};

export default { find, create, findById, update, delete: deleteDatabase, check };
