"use strict";
// The disclaimer : what a signed-in user reads and accepts (or declines, and is signed out), and
// Settings > Access > Disclaimer - its text, on or off, and who accepted which version.
import Disclaimer from "../../models/disclaimer.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import logger from "../../lib/logger.js";
// the disclaimer repository follows every change of the versions (lib/repoObjects)
import RepoObjects from "../../lib/repoObjects/index.js";

// ─── every signed-in user ────────────────────────────────────────────────────

// the disclaimer to show, and whether this user still has to accept it
const current = async (req, res) => {
  try {
    const d = await Disclaimer.current();
    const required = await Disclaimer.isRequired(req.user?.user);
    return res.json(RestResult.single({ ...d, required }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// accepted : recorded with who, which version, when, from where
const accept = async (req, res) => {
  try {
    await Disclaimer.accept(req.user?.user, req.body?.version, req.ip, req.get("user-agent"));
    return res.json(RestResult.single({ message: i18n.t(req, "auth.disclaimerAccepted") }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// declined : nothing is recorded but the audit log's entry ; the client signs the user out
const decline = async (req, res) => {
  logger.notice(`${req.user?.user?.username} (${req.user?.user?.type}) declined the disclaimer`);
  return res.json(RestResult.single(null));
};

// ─── Settings > Access > Disclaimer ──────────────────────────────────────────

const settings = async (req, res) => {
  try {
    return res.json(RestResult.single(await Disclaimer.forSettings()));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const saveSettings = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    await RepoObjects.following("disclaimer", () => Disclaimer.save(req.body, req.user?.user?.username));
    return res.json(RestResult.single(await Disclaimer.forSettings()));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const versions = async (req, res) => {
  try {
    return res.json(RestResult.list(await Disclaimer.versions()));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const version = async (req, res) => {
  try {
    return res.json(RestResult.single(await Disclaimer.version(req.params.id)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a disclaimer added : a new version, not enabled
const createVersion = async (req, res) => {
  try {
    const version = await RepoObjects.following("disclaimer", () => Disclaimer.createVersion(req.body, req.user?.user?.username));
    return res.json(RestResult.single({ id: version, version }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a version's words changed : a correction, or (askAgain) everyone accepting it again
const updateVersion = async (req, res) => {
  try {
    await RepoObjects.following("disclaimer", () => Disclaimer.updateVersion(req.params.id, req.body));
    return res.json(RestResult.single(await Disclaimer.version(req.params.id)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a version enabled (the one users accept) or disabled (the disclaimer off) { enabled }
const enableVersion = async (req, res) => {
  try {
    await RepoObjects.following("disclaimer", () =>
      Disclaimer.enableVersion(req.params.id, req.body?.enabled !== false && req.body?.enabled !== 0, req.user?.user?.username),
    );
    return res.json(RestResult.single(await Disclaimer.version(req.params.id)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a version deleted, with who accepted it
const deleteVersion = async (req, res) => {
  try {
    await RepoObjects.following("disclaimer", () => Disclaimer.deleteVersion(req.params.id));
    return res.json(RestResult.single({ message: i18n.t(req, "success.deleted", { resource: "Disclaimer version" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// a version restored : enabled again, the one users accept (Disclaimer.restoreVersion, as Enable)
const restoreVersion = async (req, res) => {
  try {
    const version = await RepoObjects.following("disclaimer", () => Disclaimer.restoreVersion(req.params.id, req.user?.user?.username));
    return res.json(RestResult.single({ version }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// Ask again : the acceptances ticked no longer count, their users accept again { ids }
const askAgain = async (req, res) => {
  try {
    const count = await Disclaimer.askAgain(req.body?.ids, req.user?.user?.username);
    return res.json(RestResult.single({ count }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const acceptances = async (req, res) => {
  try {
    return res.json(RestResult.list(await Disclaimer.acceptances(req.query.version)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const acceptance = async (req, res) => {
  try {
    return res.json(RestResult.single(await Disclaimer.acceptance(req.params.id)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

export default { current, accept, decline, settings, saveSettings, versions, version, acceptances, acceptance, askAgain, deleteVersion, restoreVersion, createVersion, updateVersion, enableVersion };
