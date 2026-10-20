'use strict';
// The Branding type of the repository-backed objects (lib/repoObjects/engine.js, its single-file
// mode) : Settings > Appearance in a repository's branding.yaml - the app's name, the header's
// links and the Designer's, the defaults (theme, colour, forms view, time zone, date format,
// language) - and the logo and the website icon as image files beside it (logo.png, icon.svg),
// named by their path in it, read and written as binary, checked as an upload is
// (lib/brandImages.js). A pull applies it as the Appearance pages save : the settings row's fields
// (lib/appearance.js), the language and the Designer's link as environment settings
// (lib/envSave.js), the images. The config seed's branding section is read the same way, its images
// relative to the seed file.
import fs from "fs";
import path from "path";
import Settings, { validHeaderLinks } from "../../models/settings.model.js";
import appConfig from "../../../config/app.config.js";
import { brandingSection } from "../seed-schema.js";
import { saveSettingsFields } from "../appearance.js";
import { saveEnvValues } from "../envSave.js";
import { BRAND_IMAGES, imageDataUrl, imageFile } from "../brandImages.js";
import { same } from "./yamlFile.js";
import { singleType } from "./singleType.js";

// the fields of the settings row, and the two environment settings, it holds
const ROW_FIELDS = ["app_name", "header_links", "default_theme", "default_theme_color", "forms_view", "default_timezone", "default_date_format"];
const ENV_FIELDS = { default_language: "DEFAULT_LANGUAGE", show_designer: "SHOW_DESIGNER" };
const IMAGES = Object.keys(BRAND_IMAGES);

/**
 * A field's value as two are compared : a list as its JSON, a yes or no as true or false, no
 * value as ''.
 *
 * Args:
 *   v (any): the value.
 *
 * Returns:
 *   any: the value compared.
 */
const comparable = (v) => (Array.isArray(v) ? JSON.stringify(v) : typeof v === "boolean" ? v : v === null || v === undefined ? "" : String(v));

/**
 * An image file a branding names, read as binary : inside the folder it is named from.
 *
 * Args:
 *   dir (string): the folder (the repository's root, the seed file's folder).
 *   name (string): its path, relative to it.
 *
 * Returns:
 *   Buffer: its bytes.
 *
 * Raises:
 *   Error: a path that leads outside the folder, or a file that cannot be read.
 */
function readImage(dir, name) {
  const base = path.resolve(dir || ".");
  const abs = path.resolve(base, String(name));
  if (!abs.startsWith(base + path.sep)) throw new Error(`'${name}' is not a file beside the branding`);
  try {
    return fs.readFileSync(abs);
  } catch (e) {
    throw new Error(`'${name}' cannot be read: ${e.code || e.message}`, { cause: e });
  }
}

export default singleType({
  key: "branding",
  file: "branding.yaml",
  section: brandingSection,
  title: "Branding",
  noun: "branding",
  // the Designer's link hidden is what a file says : shown is the default
  keepFalse: ["show_designer"],
  // as the Appearance pages show it : the images as data urls, none for the bundled ones
  current: async () => {
    const row = await Settings.find();
    const out = Object.fromEntries(ROW_FIELDS.map((k) => [k, row[k] ?? null]));
    out.header_links = validHeaderLinks(row.header_links || "[]");
    if (!out.header_links.length) out.header_links = null;
    out.default_language = process.env.DEFAULT_LANGUAGE || null;
    out.show_designer = !!appConfig.showDesigner;
    for (const kind of IMAGES) out[kind] = await BRAND_IMAGES[kind].get();
    return out;
  },
  // its YAML names its images by the file they are written as
  toFile: (current) => ({ ...current, ...Object.fromEntries(IMAGES.map((k) => [k, imageFile(k, current[k])?.name])) }),
  extraFiles: (current) => IMAGES.map((k) => imageFile(k, current[k])).filter(Boolean),
  // the images it names read and checked ; its links as the model keeps them
  fromFile: async (declared, { dir } = {}) => {
    const out = { ...declared };
    for (const kind of IMAGES) {
      if (declared[kind] === undefined) continue;
      out[kind] = declared[kind] ? imageDataUrl(kind, readImage(dir, declared[kind])) : null;
    }
    if (declared.header_links !== undefined) out.header_links = validHeaderLinks(declared.header_links);
    return out;
  },
  changed: (declared, current) => Object.keys(declared).some((k) => !same(comparable(declared[k]), comparable(current?.[k]))),
  apply: async (declared, current) => {
    const changed = Object.keys(declared).filter((k) => !same(comparable(declared[k]), comparable(current?.[k])));
    // the settings row's fields, as the pages save them
    const fields = Object.fromEntries(changed.filter((k) => ROW_FIELDS.includes(k)).map((k) => [k, declared[k]]));
    if (Object.keys(fields).length) await saveSettingsFields(fields);
    // the language and the Designer's link : environment settings, as their pages save them
    const env = Object.fromEntries(changed.filter((k) => ENV_FIELDS[k]).map((k) => [ENV_FIELDS[k], k === "show_designer" ? (declared[k] ? "1" : "0") : declared[k] ?? ""]));
    const notes = [];
    if (Object.keys(env).length) {
      const { restartRequired } = await saveEnvValues(env, { user: "repository" });
      if (restartRequired.length) notes.push(`Saved ; applied at the next restart: ${restartRequired.join(", ")}`);
    }
    // the images : the one named, or the bundled one
    for (const kind of IMAGES) if (changed.includes(kind)) await BRAND_IMAGES[kind].set(declared[kind]);
    return notes;
  },
});
