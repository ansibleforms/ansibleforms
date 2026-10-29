'use strict';
// The website icon (the browser tab) : Settings > Appearance > Icon. Kept like the logo, as a
// data url in the settings table ; none stored means the bundled favicon.svg.
import multer from 'multer';
import Settings from '../../models/settings.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import logger from '../../lib/logger.js';
import Helpers from '../../lib/common.js';
import i18n from '../../lib/i18n.js';
import { sniffImageMime } from '../../lib/imagetype.js';
import { BRAND_IMAGES } from '../../lib/brandImages.js';
import RepoObjects from '../../lib/repoObjects/index.js';

// an icon is tiny ; the cap keeps a photo from being stored as one (lib/brandImages.js)
const MAX_ICON_BYTES = BRAND_IMAGES.icon.maxBytes;

// kept in memory : validated and stored in the database as a data url, never written to disk
const uploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ICON_BYTES, files: 1 }
});

/**
 * The website icon : { favicon (a data url, or null), isDefault }.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 */
const get = async function (req, res) {
  try {
    const favicon = await Settings.getFavicon();
    res.json(RestResult.single({ favicon, isDefault: !favicon }));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindFavicon'), Helpers.getError(err)));
  }
};

/**
 * Stores an uploaded icon (field `favicon`) : PNG, ICO, SVG, GIF, WebP or JPEG, its type
 * checked by its bytes, not by what the browser declared.
 *
 * Args:
 *   req (object): the request, a multipart upload.
 *   res (object): the response.
 */
const update = function (req, res) {
  uploadMulter.single('favicon')(req, res, async function (err) {
    if (err) {
      logger.error(`Website icon upload error: ${err.toString()}`)
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.failedUpdateFavicon'), err.toString()));
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.failedUpdateFavicon'), i18n.t(req, 'resources.logoNoFile')));
    }
    const mime = sniffImageMime(req.file.buffer);
    if (!mime) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.failedUpdateFavicon'), i18n.t(req, 'resources.faviconInvalidImage')));
    }
    try {
      // the Icon repository's icon.yaml, before : its icon written beside it after
      await RepoObjects.holding('icon', async () => {
        const before = await RepoObjects.snapshot('icon');
        await BRAND_IMAGES.icon.set(`data:${mime};base64,${req.file.buffer.toString('base64')}`);
        await RepoObjects.appUpdated('icon', before);
      });
      logger.notice(`Website icon updated (${mime}, ${req.file.buffer.length} bytes)`)
      res.json(RestResult.single(null));
    } catch (e) {
      res.status(e.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateFavicon'), Helpers.getError(e)));
    }
  });
};

/**
 * Removes the stored icon : the bundled one shows again.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 */
const remove = async function (req, res) {
  try {
    await RepoObjects.holding('icon', async () => {
      const before = await RepoObjects.snapshot('icon');
      await BRAND_IMAGES.icon.set(null);
      await RepoObjects.appUpdated('icon', before);
    });
    logger.notice(`Website icon removed, the default one restored`)
    res.json(RestResult.single(null));
  } catch (err) {
    res.status(err.status || 500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateFavicon'), Helpers.getError(err)));
  }
};

export default { get, update, remove };
