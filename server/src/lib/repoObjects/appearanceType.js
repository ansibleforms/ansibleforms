'use strict';
// The appearance types of the repository-backed objects (lib/repoObjects/engine.js, its single
// mode) : what Settings > Appearance's pages save, one key of a repository's files per page, each
// holding what its page saves and nothing else - the defaults (defaults: the theme, its colour, the
// forms view, the time zone, the date format, the language), the logo (logo:, the image a file it
// names), the website icon (icon:, the same), the name (name:) and the header's links (links: the
// links and the Designer's). One way for all, written once : a
// file applied as the pages save (the settings row's fields through lib/appearance.js, the
// environment settings through lib/envSave.js, the images through lib/brandImages.js), the images
// read and written as binary and checked as an upload is. The config seed's sections of the same
// names are read the same way, its images relative to the seed file.
//
// The seed and a repository never own the same field : a field the seed declares stays the seed's
// (lib/repoObjects/seedHold.js, shared with the MCP settings). The repository holds the others.
import fs from "fs";
import path from "path";
import Settings, { validHeaderLinks } from "../../models/settings.model.js";
import appConfig from "../../../config/app.config.js";
import { saveSettingsFields } from "../appearance.js";
import { saveEnvValues } from "../envSave.js";
import EnvSettings from "../envSettings.js";
import { BRAND_IMAGES, imageDataUrl, imageFile } from "../brandImages.js";
import { seedHold } from "./seedHold.js";
import { same, fileBeside } from "./yamlFile.js";
import { singleType } from "./singleType.js";

// the environment settings among the appearance fields, by field : their variable, and how the app
// reads them now
const ENV = {
  default_language: { name: "DEFAULT_LANGUAGE", read: () => process.env.DEFAULT_LANGUAGE || null, write: (v) => v ?? "" },
  show_designer: { name: "SHOW_DESIGNER", read: () => !!appConfig.showDesigner, write: (v) => (v ? "1" : "0") },
};

/**
 * A field's value as two are compared : a list as its JSON (an empty one as none), a yes or no as
 * true or false, no value as ''.
 *
 * Args:
 *   v (any): the value.
 *
 * Returns:
 *   any: the value compared.
 */
const comparable = (v) => (Array.isArray(v) ? (v.length ? JSON.stringify(v) : "") : typeof v === "boolean" ? v : v === null || v === undefined ? "" : String(v));

/**
 * An image file a file names, read as binary : relative to the file naming it, inside its
 * repository (or beside the seed file).
 *
 * Args:
 *   dir (string): the folder of the file naming it.
 *   name (string): its path, relative to that folder.
 *   root (string|null): the repository it must be in ; none : beside the file (the seed's).
 *
 * Returns:
 *   Buffer: its bytes.
 *
 * Raises:
 *   Error: a path that leads outside the root (a link too), or a file that cannot be read.
 */
function readImage(dir, name, root = null) {
  const abs = fileBeside(dir, name, root);
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
 * does not name is never the type's : one there already with other bytes is refused, never
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
    // the name the YAML gives it, the type's own file
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
 *     key, title, noun (string): as lib/repoObjects/singleType.js reads them.
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
    // the seed's fields, and those set in the real environment (that value wins : never applied)
    const held = opts.fromSeed ? [] : [...seededOf(current), ...(current?._envSet || [])];
    return Object.keys(declared).filter((k) => !held.includes(k) && !same(comparable(asStored(k, declared[k])), comparable(current?.[k])));
  }

  /**
   * A field's value as the app stores it (the settings row's : as its model converts it - a name
   * trimmed, an unknown forms view none) : a file's value compared with the stored one.
   *
   * Args:
   *   k (string): the field.
   *   v (any): the value declared.
   *
   * Returns:
   *   any: the value as stored.
   */
  function asStored(k, v) {
    return rowFields.includes(k) && k !== "header_links" ? new Settings({ [k]: v })[k] : v;
  }

  return singleType({
    key: spec.key,
    section: spec.section,
    title: spec.title,
    noun: spec.noun,
    keepFalse: spec.keepFalse || [],
    // its images are files beside its YAML, named in it
    besides: images,
    // as the Appearance pages show them : the images as data urls, none for the bundled ones
    current: async () => {
      const row = await Settings.find();
      const out = Object.fromEntries(rowFields.map((k) => [k, row[k] ?? null]));
      if (rowFields.includes("header_links")) {
        out.header_links = validHeaderLinks(row.header_links || "[]");
        if (!out.header_links.length) out.header_links = null;
      }
      // a variable set in the real environment is not the app's to save : none here, never written
      // to the repository (_envSet : not applied from it, said)
      const managed = envFields.length ? await EnvSettings.readManaged() : null;
      const envSet = envFields.filter((field) => EnvSettings.isOverridden(ENV[field].name, managed));
      for (const field of envFields) out[field] = envSet.includes(field) ? null : ENV[field].read();
      Object.defineProperty(out, "_envSet", { value: envSet });
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
    editFiles: (declared, after, before) => imageEdits(images, seededOf(after), declared || {}, after, before),
    // the images it names read and checked ; its links as the model keeps them
    fromFile: async (declared, { dir, root } = {}) => {
      const out = { ...declared };
      for (const kind of images) {
        if (declared[kind] === undefined) continue;
        out[kind] = declared[kind] ? imageDataUrl(kind, readImage(dir, declared[kind], root)) : null;
      }
      if (declared.header_links !== undefined) out.header_links = validHeaderLinks(declared.header_links);
      return out;
    },
    changed: (declared, current, opts = {}) => changedFields(declared, current, opts).length > 0,
    apply: async (declared, current, opts = {}) => {
      const changed = changedFields(declared, current, opts);
      // the settings row's fields, as the pages save them
      const row = Object.fromEntries(changed.filter((k) => rowFields.includes(k)).map((k) => [k, declared[k]]));
      // the environment settings, as their pages save them
      const env = Object.fromEntries(changed.filter((k) => envFields.includes(k)).map((k) => [ENV[k].name, ENV[k].write(declared[k])]));
      const notes = [];
      const who = { user: opts.fromSeed ? "config seed" : "repository" };
      // the environment settings checked before anything is saved : a file refused whole, never
      // applied by halves
      if (Object.keys(env).length) await saveEnvValues(env, who, { ...opts, dryRun: true });
      if (Object.keys(row).length) await saveSettingsFields(row, opts);
      if (Object.keys(env).length) {
        const { restartRequired } = await saveEnvValues(env, who, opts);
        if (restartRequired.length) notes.push(`Saved ; applied at the next restart: ${restartRequired.join(", ")}`);
      }
      // the images : the one named, or the bundled one
      for (const kind of images) if (changed.includes(kind)) await BRAND_IMAGES[kind].set(declared[kind], opts);
      return notes;
    },
    // a repository's file declaring a field the seed manages, or one set in the environment : not
    // applied, said
    notesOf: (declared, current) => {
      const envSet = Object.keys(declared).filter((k) => (current?._envSet || []).includes(k));
      return [...hold.notesOf(declared, current), ...(envSet.length ? [`Set in the environment, not applied: ${envSet.map((k) => ENV[k].name).join(", ")}`] : [])];
    },
  });
}
