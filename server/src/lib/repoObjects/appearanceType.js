'use strict';
// The appearance types of the repository-backed objects (lib/repoObjects/engine.js, its
// single-file mode) : what Settings > Appearance's pages save, in one file of a repository - the
// branding (branding.yaml : the name, the defaults, the language, the logo and the icon, the images
// as files beside it) and the header's links (links.yaml : the links and the Designer's). One way
// for both, written once : a file applied as the pages save (the settings row's fields through
// lib/appearance.js, the environment settings through lib/envSave.js, the images through
// lib/brandImages.js), the images read and written as binary and checked as an upload is. The
// config seed's branding and links sections are read the same way, its images relative to the seed
// file.
//
// The seed and a repository never own the same field : a field the seed declares stays the seed's
// (lib/repoObjects/seedHold.js, shared with the MCP settings). The repository holds the others.
import fs from "fs";
import path from "path";
import Settings, { validHeaderLinks } from "../../models/settings.model.js";
import appConfig from "../../../config/app.config.js";
import { saveSettingsFields } from "../appearance.js";
import { saveEnvValues } from "../envSave.js";
import { BRAND_IMAGES, imageDataUrl, imageFile } from "../brandImages.js";
import { seedHold } from "./seedHold.js";
import { same, parseMapFile, fileBeside } from "./yamlFile.js";
import { singleType } from "./singleType.js";

// the environment settings among the appearance fields, by field : their variable, and how the app
// reads them now
const ENV = {
  default_language: { name: "DEFAULT_LANGUAGE", read: () => process.env.DEFAULT_LANGUAGE || null, write: (v) => v ?? "" },
  show_designer: { name: "SHOW_DESIGNER", read: () => !!appConfig.showDesigner, write: (v) => (v ? "1" : "0") },
};

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
 * An image file a file names, read as binary : inside the folder it is named from.
 *
 * Args:
 *   dir (string): the folder (the repository's root, the seed file's folder).
 *   name (string): its path, relative to it.
 *
 * Returns:
 *   Buffer: its bytes.
 *
 * Raises:
 *   Error: a path that leads outside the folder (a link too), or a file that cannot be read.
 */
function readImage(dir, name) {
  const abs = fileBeside(dir, name);
  try {
    return fs.readFileSync(abs);
  } catch (e) {
    throw new Error(`'${name}' cannot be read: ${e.code || e.message}`, { cause: e });
  }
}

/**
 * The images an app edit writes into a file that is there : the ones it changed only, each where the
 * YAML names it - its own file rewritten (images/logo.png stays images/logo.png), beside it with the
 * new type's extension when the type changed (images/logo.svg), and the YAML naming it so ; an image
 * the YAML does not name yet written as <kind>.<extension> at its side (imageFile). A file the YAML
 * does not name is never the branding's : one there already with other bytes is refused, never
 * overwritten (lib/repoObjects/engine.js writeSingle). An image the edit left as it is keeps its file
 * and its name : nothing is written for it, and nothing removed.
 *
 * Args:
 *   images (string[]): the type's images (logo, icon).
 *   seeded (string[]): the fields the config seed manages (never written).
 *   declared (object): the file's object as it is.
 *   after (object): the app's object as saved.
 *   before (object): the app's object before the edit.
 *
 * Returns:
 *   object: { base (the image fields as the file names them : what the edit is compared with),
 *     names (the image fields as the edit names them), extraFiles ([{ name, buffer, own }] : the
 *     images written, own when the YAML names that file), gone (string[] : the files the YAML
 *     named and no longer does) }.
 */
function imageEdits(images, seeded, declared, after, before) {
  const out = { base: {}, names: {}, extraFiles: [], gone: [] };
  for (const kind of images) {
    if (seeded.includes(kind) || same(comparable(after?.[kind]), comparable(before?.[kind]))) continue;
    // the name the YAML gives it, the branding's own file
    const named = typeof declared[kind] === "string" && declared[kind] ? declared[kind] : undefined;
    const file = imageFile(kind, after?.[kind]);
    let target;
    if (file) {
      // where the YAML names it, with the extension of the type it is now ; else <kind>.<ext>
      target = named ? path.posix.join(path.posix.dirname(named), `${path.posix.basename(named, path.posix.extname(named))}${path.posix.extname(file.name)}`) : file.name;
      out.extraFiles.push({ name: target, buffer: file.buffer, own: target === named });
    }
    out.base[kind] = named;
    out.names[kind] = target;
    // the file it named before, no longer the one named (another type, or no image)
    if (named && named !== target) out.gone.push(named);
  }
  return out;
}

/**
 * The descriptor of an appearance type.
 *
 * Args:
 *   spec (object):
 *     key, file, title, noun (string): as lib/repoObjects/singleType.js reads them.
 *     section (object): the schema of its file (lib/seed-schema.js).
 *     rowFields (string[]): its fields of the settings row (app_name, header_links ...).
 *     envFields (string[]): its environment settings, by field (default_language, show_designer).
 *     images (string[]): its images (logo, icon), files beside its YAML.
 *     keepFalse (string[]): its yes or no fields written when off.
 *
 * Returns:
 *   object: the descriptor.
 */
export function appearanceType(spec) {
  const { rowFields = [], envFields = [], images = [] } = spec;
  const fields = [...rowFields, ...envFields, ...images];
  // the config seed's hold on this type's fields
  const hold = seedHold((f) => fields.includes(f));
  const { seededOf } = hold;

  /**
   * The fields a declaration changes : those whose value is not the app's - the ones the config
   * seed manages left out, unless the seed itself applies them.
   *
   * Args:
   *   declared (object): the declaration (a file's, the seed's).
   *   current (object): the app's values (current).
   *   opts (object): { fromSeed (true : the seed's own declaration) }.
   *
   * Returns:
   *   string[]: the fields.
   */
  function changedFields(declared, current, opts = {}) {
    const seeded = opts.fromSeed ? [] : seededOf(current);
    return Object.keys(declared).filter((k) => !seeded.includes(k) && !same(comparable(declared[k]), comparable(current?.[k])));
  }

  return singleType({
    key: spec.key,
    file: spec.file,
    section: spec.section,
    title: spec.title,
    noun: spec.noun,
    keepFalse: spec.keepFalse || [],
    // as the Appearance pages show them : the images as data urls, none for the bundled ones
    current: async () => {
      const row = await Settings.find();
      const out = Object.fromEntries(rowFields.map((k) => [k, row[k] ?? null]));
      if (rowFields.includes("header_links")) {
        out.header_links = validHeaderLinks(row.header_links || "[]");
        if (!out.header_links.length) out.header_links = null;
      }
      for (const field of envFields) out[field] = ENV[field].read();
      for (const kind of images) out[kind] = await BRAND_IMAGES[kind].get();
      // the fields the config seed manages : the seed's, never the repository's
      out._seedManaged = await hold.managed();
      return out;
    },
    // the fields the seed manages stay in the app (a seed-managed object stays with the seed)
    kept: hold.kept,
    // its YAML names its images by the file they are written as ; the seed's fields left out
    toFile: (current) => hold.without({ ...current, ...Object.fromEntries(images.map((k) => [k, imageFile(k, current[k])?.name])) }, current),
    extraFiles: (current) => images.filter((k) => !seededOf(current).includes(k)).map((k) => imageFile(k, current[k])).filter(Boolean),
    // an app edit : only the images it changed written, each as <kind>.<extension> beside the YAML,
    // the YAML naming it so where it named another file (images/logo.png) ; an image left as it
    // is keeps its file and its name, wherever the file names it
    editFiles: (text, after, before) => imageEdits(images, seededOf(after), parseMapFile(text).object || {}, after, before),
    // the images it names read and checked ; its links as the model keeps them
    fromFile: async (declared, { dir } = {}) => {
      const out = { ...declared };
      for (const kind of images) {
        if (declared[kind] === undefined) continue;
        out[kind] = declared[kind] ? imageDataUrl(kind, readImage(dir, declared[kind])) : null;
      }
      if (declared.header_links !== undefined) out.header_links = validHeaderLinks(declared.header_links);
      return out;
    },
    changed: (declared, current, opts = {}) => changedFields(declared, current, opts).length > 0,
    apply: async (declared, current, opts = {}) => {
      const changed = changedFields(declared, current, opts);
      // the settings row's fields, as the pages save them
      const row = Object.fromEntries(changed.filter((k) => rowFields.includes(k)).map((k) => [k, declared[k]]));
      if (Object.keys(row).length) await saveSettingsFields(row, opts);
      // the environment settings, as their pages save them
      const env = Object.fromEntries(changed.filter((k) => envFields.includes(k)).map((k) => [ENV[k].name, ENV[k].write(declared[k])]));
      const notes = [];
      if (Object.keys(env).length) {
        const { restartRequired } = await saveEnvValues(env, { user: opts.fromSeed ? "config seed" : "repository" }, opts);
        if (restartRequired.length) notes.push(`Saved ; applied at the next restart: ${restartRequired.join(", ")}`);
      }
      // the images : the one named, or the bundled one
      for (const kind of images) if (changed.includes(kind)) await BRAND_IMAGES[kind].set(declared[kind], opts);
      return notes;
    },
    // a repository's file declaring a field the seed manages : not applied, said
    notesOf: hold.notesOf,
  });
}
