"use strict";
import SyslogServer from "../../models/syslogServer.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import Helpers from "../../lib/common.js";
import i18n from "../../lib/i18n.js";
import { sendTestLine } from "../../lib/logger.js";
import RepoObjects from "../../lib/repoObjects/index.js";

const find = async (req, res) => {
  try {
    if (req.query.name) return res.json(RestResult.single(await SyslogServer.findByName(req.query.name)));
    return res.json(RestResult.list(await SyslogServer.findAll()));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const create = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    const id = await SyslogServer.create(req.body);
    // the syslog repository, when there is one : written to it as a new file (lib/repoObjects)
    await RepoObjects.appCreated("syslog", id);
    return res.status(201).json(RestResult.single({ message: i18n.t(req, "success.created", { resource: "Syslog server" }), id }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const findById = async (req, res) => {
  try {
    const server = await SyslogServer.findById(req.params.id);
    if (!server) throw new Errors.NotFoundError(`No syslog server with id ${req.params.id}`);
    return res.json(RestResult.single(server));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const update = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    const before = await SyslogServer.findById(req.params.id).catch(() => null);
    await SyslogServer.update(req.body, req.params.id);
    // one of the syslog repository : its changed fields written to its file
    if (before?.repository) await RepoObjects.appUpdated("syslog", before, req.params.id);
    return res.json(RestResult.single({ message: i18n.t(req, "success.updated", { resource: "Syslog server" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const deleteServer = async (req, res) => {
  try {
    const before = await SyslogServer.findById(req.params.id).catch(() => null);
    await SyslogServer.delete(req.params.id);
    // one of the syslog repository : its file goes too, for the repository's Push
    if (before?.repository) await RepoObjects.appDeleted("syslog", before);
    return res.json(RestResult.single({ message: i18n.t(req, "success.deleted", { resource: "Syslog server" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// Send test message : one line through the saved server, enabled or not, naming who sent it
const test = async (req, res) => {
  try {
    const server = await SyslogServer.findById(req.params.id);
    if (!server) throw new Errors.NotFoundError(`No syslog server with id ${req.params.id}`);
    const who = req.user?.user?.username || "someone";
    await sendTestLine(server, `AnsibleForms test message from ${who}: the syslog server '${server.name}' receives it`);
    const where = server.protocol?.startsWith("unix") ? server.path : `${server.host}:${server.port || 514}`;
    return res.json(RestResult.single({ message: i18n.t(req, "resources.syslogSent", { where }) }));
  } catch (err) {
    if (err instanceof Errors.NotFoundError) return Errors.ReturnError(res, err);
    return res.status(500).json(RestResult.error(i18n.t(req, "resources.syslogCheckFailed"), Helpers.getError(err)));
  }
};

export default { find, create, findById, update, delete: deleteServer, test };
