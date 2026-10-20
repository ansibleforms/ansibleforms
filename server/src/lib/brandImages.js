'use strict';
// The branding's images : the logo (Settings > Appearance > Logo) and the website icon (Icon), each
// kept as a data url in the settings row. One set of rules for an upload from the app
// (controllers/v2/logo.controller.js, favicon.controller.js) and for an image file a branding
// repository or the config seed names (lib/repoObjects/branding.js) : its size within the limit,
// its type sniffed from its bytes, never taken from a name or a declared content type.
import Settings from "../models/settings.model.js";
import { sniffImageMime } from "./imagetype.js";
import { DEFAULT_LOGO } from "./defaultlogo.js";
import { assertBrandingFree } from "./brandingManaged.js";

// the image types a file of the repository is written as, by the type sniffed
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };

// each image : its limit, how it is read and written (refused when the config seed manages it, its
// own write apart : opts.fromSeed), and what its default is
export const BRAND_IMAGES = {
  // a logo is small ; capped well below anything that would bloat the settings table
  logo: {
    maxBytes: 900 * 1024,
    get: async () => {
      const logo = await Settings.getLogo();
      return logo && logo !== DEFAULT_LOGO ? logo : null;
    },
    set: async (dataUrl, opts = {}) => {
      await assertBrandingFree(["logo"], opts);
      await Settings.setLogo(dataUrl || DEFAULT_LOGO);
    },
  },
  // the browser tab's icon : the bundled one when none
  icon: {
    maxBytes: 256 * 1024,
    get: async () => (await Settings.getFavicon()) || null,
    set: async (dataUrl, opts = {}) => {
      await assertBrandingFree(["icon"], opts);
      await Settings.setFavicon(dataUrl || null);
    },
  },
};

/**
 * An image's bytes as the data url it is kept as, checked : within its limit, of a type sniffed
 * from its bytes.
 *
 * Args:
 *   kind (string): 'logo' or 'icon'.
 *   buffer (Buffer): the image.
 *
 * Returns:
 *   string: the data url.
 *
 * Raises:
 *   Error: empty, too large, or not an image the app takes.
 */
export function imageDataUrl(kind, buffer) {
  const { maxBytes } = BRAND_IMAGES[kind];
  if (!buffer || !buffer.length) throw new Error(`The ${kind} file is empty`);
  if (buffer.length > maxBytes) throw new Error(`The ${kind} is larger than ${Math.round(maxBytes / 1024)} KB`);
  const mime = sniffImageMime(buffer);
  if (!mime) throw new Error(`The ${kind} is not an image the app takes`);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * A data url as an image file : its bytes and the name it is written as (logo.png).
 *
 * Args:
 *   kind (string): 'logo' or 'icon'.
 *   dataUrl (string): the image.
 *
 * Returns:
 *   object|null: { name, buffer }, null for none (or one that is no base64 data url).
 */
export function imageFile(kind, dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ""));
  if (!m) return null;
  return { name: `${kind}.${EXTENSIONS[m[1]] || "img"}`, buffer: Buffer.from(m[2], "base64") };
}
