"use strict";
// Settings > Appearance > Announcements : the list, a new one (the wizard), a change, a delete.
// Each change shows at once in every open tab (the 'appearance' live event).
import Announcement from "../../models/announcement.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import { publish } from "../../lib/liveEvents.js";
import { forgetAppDefaults } from "../../routes/v2/app.routes.js";
import RepoObjects from "../../lib/repoObjects/index.js";

/**
 * The header re-reads the config : on this node now, on the others through the live event.
 */
function announce() {
  forgetAppDefaults();
  publish("appearance");
}

const find = async (req, res) => {
  try {
    return res.json(RestResult.list(await Announcement.findAll()));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const findById = async (req, res) => {
  try {
    return res.json(RestResult.single(await Announcement.findById(req.params.id)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const create = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    // the announcements repository follows (lib/repoObjects : a new file)
    const id = await RepoObjects.following("announcements", () => Announcement.create(req.body, req.user?.user?.username));
    announce();
    return res.status(201).json(RestResult.single({ message: i18n.t(req, "success.created", { resource: "Announcement" }), id }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const update = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    // the announcements repository follows (its changed fields written to its file)
    await RepoObjects.following("announcements", () => Announcement.update(req.params.id, req.body));
    announce();
    return res.json(RestResult.single({ message: i18n.t(req, "success.updated", { resource: "Announcement" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const remove = async (req, res) => {
  try {
    // the announcements repository follows (its file removed)
    await RepoObjects.following("announcements", () => Announcement.delete(req.params.id));
    announce();
    return res.json(RestResult.single({ message: i18n.t(req, "success.deleted", { resource: "Announcement" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

export default { find, findById, create, update, delete: remove };
