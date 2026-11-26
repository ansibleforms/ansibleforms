'use strict';
// The Designer's RTE images (lib/rteImages.js) : reading is open to every designer user, a change
// (save, new, delete, push) only to the one holding the designer lock, as a change of the forms.
// The Dockerfile preview builds nothing : it shows what a builder would be handed.
import RestResult from '../../models/restResult.model.v2.js';
import Lock from '../../models/lock.model.js';
import Errors from '../../lib/errors.js';
import i18n from '../../lib/i18n.js';
import { appVersion } from '../../lib/version.js';
import RteImages from '../../lib/rteImages.js';
import { buildContextOf, imageRefOf, versionsOf } from '../../lib/rteDockerfile.js';
import RteBuilds from '../../lib/rteBuilds.js';

/**
 * Answers 423 (and returns false) unless the caller holds the designer lock.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 *
 * Returns:
 *   boolean: true when the caller may change the images.
 */
async function holdsLock(req, res) {
  const lock = await Lock.status(req.user.user);
  if (lock.match) return true;
  res
    .status(423)
    .json(
      RestResult.error(
        i18n.t(req, 'config.designerLocked'),
        lock.free ? 'Start the designer first' : i18n.t(req, 'config.designerLockedBy', { username: lock.lock.username }),
      ),
    );
  return false;
}

/**
 * What a definition builds : its Dockerfile, the files it copies, and where it is pushed to (the
 * registry's address left out : it is its credential's, read at the build).
 *
 * Args:
 *   image (object): the definition (normalized).
 *
 * Returns:
 *   object: { dockerfile, files, ref }.
 */
function previewOf(image) {
  const files = buildContextOf(image, appVersion);
  const { Dockerfile: dockerfile, ...rest } = files;
  return { dockerfile, files: rest, ref: imageRefOf(image, '', appVersion) };
}

const rteImageController = {
  async list(req, res) {
    try {
      // each with whether it needs a build : changed since its last good build, or never built
      const [list, builds] = await Promise.all([RteImages.listImages(), RteBuilds.listBuilds().catch(() => [])]);
      res.json(RestResult.list(list.map((f) => ({ ...f, needsBuild: RteImages.needsBuild(f, builds, appVersion) }))));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  // the pythons and the ansible-core releases, and which run together (the editor's dropdowns)
  async versions(req, res) {
    res.json(RestResult.single(versionsOf()));
  },
  async repositories(req, res) {
    try {
      res.json(RestResult.list(await RteImages.rteRepositories()));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async get(req, res) {
    try {
      const found = await RteImages.getImage(req.params.name);
      res.json(RestResult.single({ ...found, ...(found.error ? {} : previewOf(found.image)) }));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  // a definition not saved yet (the editor's) : its Dockerfile, or why it is not valid
  async preview(req, res) {
    try {
      res.json(RestResult.single(previewOf(RteImages.normalizeImage(req.body?.image))));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async create(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      res.json(RestResult.single(await RteImages.saveImage(req.body?.image, { repository: req.body?.repository })));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async update(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      res.json(RestResult.single(await RteImages.saveImage(req.body?.image, { original: req.params.name })));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async remove(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      res.json(RestResult.single(await RteImages.removeImage(req.params.name)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  // a build of an image : a job handed to a builder (lib/rteBuilds.js)
  async build(req, res) {
    try {
      res.json(RestResult.single(await RteBuilds.startBuild(req.params.name, req.user?.user)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async builds(req, res) {
    try {
      res.json(RestResult.list(await RteBuilds.listBuilds(req.query.limit)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  // the builders, with whether each can take a build now
  async builders(req, res) {
    try {
      const list = await RteBuilds.builders();
      res.json(RestResult.list(list.map((b) => ({ id: b.runner.id, name: b.runner.name, description: b.runner.description, enabled: b.runner.enabled, pending: b.runner.pending, pending_info: b.runner.pending_info, online: b.online, running: b.running }))));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async push(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      res.json(RestResult.single(await RteImages.pushImages(req.user?.user?.username)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
};

export default rteImageController;
