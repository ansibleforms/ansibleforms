"use strict";
// Settings > Appearance > Labels : the list, a new one (the wizard), a change, a delete. Each
// change shows at once in every open tab (Label.applied).
import Label from "../../models/label.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import { withEnds } from "../../models/listOrder.js";
import RepoObjects from "../../lib/repoObjects/index.js";

const find = async (req, res) => {
  try {
    if (req.query.name) return res.json(RestResult.single(await Label.findByName(req.query.name)));
    // in their order, each saying whether it is first or last (its row's Move up, Move down)
    return res.json(RestResult.list(withEnds(await Label.findAll())));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const create = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    const id = await Label.create(req.body);
    // the labels repository, when there is one : written to it as a new file (lib/repoObjects)
    await RepoObjects.appCreated("labels", id);
    return res.status(201).json(RestResult.single({ message: i18n.t(req, "success.created", { resource: "Label" }), id }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const findById = async (req, res) => {
  try {
    const label = await Label.findById(req.params.id);
    if (!label) throw new Errors.NotFoundError(`No label with id ${req.params.id}`);
    return res.json(RestResult.single(label));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const update = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    const before = await Label.findById(req.params.id).catch(() => null);
    await Label.update(req.body, req.params.id);
    // one of the labels repository : its changed fields written to its file
    if (before?.repository) await RepoObjects.appUpdated("labels", before, req.params.id);
    return res.json(RestResult.single({ message: i18n.t(req, "success.updated", { resource: "Label" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const deleteLabel = async (req, res) => {
  try {
    const before = await Label.findById(req.params.id).catch(() => null);
    await Label.delete(req.params.id);
    // one of the labels repository : its file goes too, for the repository's Push
    if (before?.repository) await RepoObjects.appDeleted("labels", before);
    return res.json(RestResult.single({ message: i18n.t(req, "success.deleted", { resource: "Label" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// one place up or down in the header : { direction: 'up' | 'down' }
const move = async (req, res) => {
  try {
    // every place numbered again : the labels repository's files follow
    const moved = await RepoObjects.following("labels", () => Label.move(req.params.id, req.body?.direction));
    return res.json(RestResult.single({ moved }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

export default { find, create, findById, update, delete: deleteLabel, move };
