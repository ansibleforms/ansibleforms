'use strict';
// The descriptor of an object type kept in ONE file of its repository instead of a folder : the
// chat assistant's settings (chat-assistant.yaml), the System > General settings (general.yaml), the
// branding (branding.yaml and its images). The app has one such object ; the file holds it, in
// the config seed's format, checked, its secrets ${ENV} references only (lib/repoObjects/fields.js).
// The engine's single-file mode (lib/repoObjects/engine.js) reads it in, writes the app's values to
// it when the repository is made the type's, and writes an app edit into it, field by field.
//
// A type says what is its own : its file and schema, how the app's object is read (current), how a
// file's object is applied (apply : the same rules as the app's own save), and, for a type with
// files beside its YAML (the branding's images), how they are read and written.
import { differs } from "../seedCompare.js";
import { fieldSet } from "./fields.js";
import { typeOf } from "./types.js";

/**
 * The descriptor of a single-file object type.
 *
 * Args:
 *   spec (object):
 *     key (string): the type (chat).
 *     file (string): its file at the root of its repository (chat-assistant.yaml).
 *     section (string|object): the schema of its file (lib/seed-schema.js).
 *     title, noun (string): how the pull output names it.
 *     secrets, skip, keepFalse, canonical : as lib/repoObjects/fields.js reads them.
 *     references (object[]): what it names : [{ field, type }] ; it waits when one is missing.
 *     current (function): async () => the app's object now (decrypted), as the file gives it.
 *     apply (function): async (declared, current, opts) => applies a file's object as the app's
 *       save does (opts.fromSeed : the config seed's own declaration) ; returns lines for the pull
 *       output (a restart needed ...), or nothing.
 *     changed (function): (declared, current, opts) => whether applying it changes anything ; as
 *       the seed compares when not given.
 *     kept (function): (current) => [{ name, code, reason }] - the parts that stay in the app (the
 *       branding fields the config seed manages), said before the type is turned on.
 *     heldBySeed (function): (current) => whether the config seed manages the whole object (the
 *       chat assistant's settings) : it stays with the seed, as a seed-managed object of a folder
 *       type does - never written to the repository's file, its file never applied (said).
 *     notesOf (function): (declared, current) => lines for the pull output about a file, whether it
 *       changes anything or not (the fields of it the config seed keeps).
 *     fromFile (function): async (object, { dir, fromSeed }) => the object as the app reads it, the files
 *       beside the YAML read (the branding's images) ; as it is when not given.
 *     extraFiles (function): (current) => [{ name, buffer }] - the files beside the YAML the app's
 *       object writes (the branding's images), its YAML naming them.
 *     editFiles (function): (text, after, before) => { base, extraFiles, gone } - an app edit's
 *       files beside the YAML, from the file as it is : the files written (those the edit
 *       changed), the ones it no longer names (removed), and the fields of the YAML compared as
 *       the file names them (base, over the object before the edit) ; extraFiles(after), all of
 *       them, when not given.
 *     toFile (function): (current) => the object as its YAML gives it, before fields.js takes its
 *       seed fields (the branding's image names) ; as it is when not given.
 *     fields (object): its own fields when they are no schema's (lib/repoObjects/fields.js
 *       mapFieldSet : the settings by their environment names).
 *     secretsOf (function): (current) => its secret fields when they depend on what it holds (the
 *       settings' are known by their names).
 *
 * Returns:
 *   object: the descriptor (lib/repoObjects/engine.js, its single-file mode).
 */
export function singleType(spec) {
  // its fields : the seed's schema, or the type's own (a flat map : the settings)
  const fields = spec.fields || fieldSet(spec);
  const toYaml = spec.toFile || ((o) => o);
  const fromFile = spec.fromFile || (async (o) => o);

  return {
    key: spec.key,
    flag: typeOf(spec.key).flag,
    model: spec.key,
    file: spec.file,
    title: spec.title,
    noun: spec.noun,
    secrets: spec.secrets || [],
    secretsOf: spec.secretsOf,
    references: spec.references || [],
    keyOrder: fields.keys,

    /**
     * Checks an object a file (or the seed) gives, then reads what it names beside it.
     *
     * Args:
     *   raw (object): the object.
     *   opts (object): { dir (the folder its file is in), resolved (the seed's own : its
     *     references resolved already), fromSeed (the config seed's declaration) }.
     *
     * Returns:
     *   Promise<object>: { errors, object (as the app reads it, null when refused) }.
     */
    async check(raw, opts = {}) {
      const checked = fields.check(raw, opts);
      if (checked.errors.length) return checked;
      try {
        return { errors: [], object: await fromFile(checked.object, opts) };
      } catch (e) {
        return { errors: [e.message || String(e)], object: null };
      }
    },

    current: spec.current,
    apply: spec.apply,
    changed: spec.changed || ((declared, current) => differs(declared, current || {})),
    kept: spec.kept || (() => []),
    heldBySeed: spec.heldBySeed || (() => false),
    notesOf: spec.notesOf || (() => []),

    /**
     * The app's object as its file : its YAML (its secrets left out) and the files beside it.
     *
     * Args:
     *   current (object): the app's object.
     *
     * Returns:
     *   object: { text, withoutSecret, extraFiles: [{ name, buffer }] }.
     */
    fileOf(current) {
      const { object, withoutSecret } = fields.toFile(toYaml(current));
      return { text: fields.newText(object), withoutSecret, extraFiles: spec.extraFiles ? spec.extraFiles(current) : [] };
    },

    /**
     * An app edit written into its file : only the fields it changed, and the files beside it
     * that changed.
     *
     * Args:
     *   text (string): the file's text.
     *   after (object): the app's object as saved.
     *   before (object): the app's object before the edit.
     *
     * Returns:
     *   object: { text, extraFiles: [{ name, buffer }], gone (string[] : the files beside it no
     *     longer named, when the type says them ; undefined : those the object named before) }.
     */
    fileEdits(text, after, before) {
      // the files beside it as the file names them now (the branding's images) : only the ones
      // the edit changed written, and its YAML naming them where it names another file
      const files = spec.editFiles ? spec.editFiles(text, after, before || {}) : null;
      if (files) {
        return {
          text: fields.editText(text, toYaml(after), { ...toYaml(before || {}), ...files.base }),
          extraFiles: files.extraFiles,
          gone: files.gone,
        };
      }
      return {
        text: fields.editText(text, toYaml(after), toYaml(before || {})),
        extraFiles: spec.extraFiles ? spec.extraFiles(after) : [],
      };
    },

    // a type of one file has no rows to link : its repository holds it, its flag says so
    store: { unlink: async () => 0, rename: async () => 0, countLinked: async () => 0 },
  };
}
