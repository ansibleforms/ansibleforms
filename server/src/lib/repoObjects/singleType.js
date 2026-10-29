'use strict';
// The descriptor of an object type the app has ONE object of : the chat assistant's settings
// (chat_assistant:), the System > General settings (general:), the logo (logo: and its image). A
// file of its repository holds it as one map under its key, in the config seed's format, checked,
// its secrets ${ENV} references only (lib/repoObjects/fields.js) ; one file at most gives it. The
// engine's single mode (lib/repoObjects/engine.js) reads it in, writes the app's values when the
// repository is made the type's, and writes an app edit into it, field by field.
//
// A type says what is its own : its schema, how the app's object is read (current), how a file's
// object is applied (apply : the same rules as the app's own save), and, for a type with files
// beside its YAML (the logo's image), how they are read and written.
import { differs } from "../seedCompare.js";
import { fieldSet } from "./fields.js";
import { typeOf } from "./types.js";

/**
 * The descriptor of an object type the app has one of.
 *
 * Args:
 *   spec (object):
 *     key (string): the type (chat_assistant), its key in a file.
 *     section (string|object): the schema of its map (lib/seed-schema.js).
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
 *       appearance fields the config seed manages), said before the type is turned on.
 *     heldBySeed (function): (current) => whether the config seed manages the whole object (the
 *       chat assistant's settings) : it stays with the seed, as a seed-managed object of a list
 *       type does - never written to the repository's file, its file never applied (said).
 *     notesOf (function): (declared, current) => lines for the pull output about a file, whether it
 *       changes anything or not (the fields of it the config seed keeps).
 *     fromFile (function): async (object, { dir, root, fromSeed }) => the object as the app reads
 *       it, the files its YAML names read, relative to its file's folder (dir) and inside root (the
 *       repository ; the seed file's folder) - the logo's image ; as it is when not given.
 *     extraFiles (function): (current) => [{ name, buffer }] - the files beside the YAML the app's
 *       object writes (the logo's image), its YAML naming them.
 *     editFiles (function): (declared, after, before) => { base, names, extraFiles, gone } - an app
 *       edit's files beside the YAML, from its map as the file has it : the files written (those
 *       the edit changed, own when the YAML names them), the ones it no longer names (removed), and the
 *       fields of the YAML compared as the file names them (base, over the object before the edit)
 *       and as the edit names them (names, over the object after it) ; extraFiles(after), all of
 *       them, when not given.
 *     toFile (function): (current) => the object as its YAML gives it, before fields.js takes its
 *       seed fields (the logo's image name) ; as it is when not given.
 *     besides (string[]): the fields of its YAML naming a file beside it (the logo's image) :
 *       those files are the type's, as its YAML is (lib/repoObjects/ownedPaths.js).
 *     fields (object): its own fields when they are no schema's (lib/repoObjects/fields.js
 *       mapFieldSet : the settings by their environment names).
 *     secretsOf (function): (current) => its secret fields when they depend on what it holds (the
 *       settings' are known by their names).
 *
 * Returns:
 *   object: the descriptor (lib/repoObjects/engine.js, its single mode).
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
    // one map under its key, in one file at most
    single: true,
    title: spec.title,
    noun: spec.noun,
    secrets: spec.secrets || [],
    secretsOf: spec.secretsOf,
    references: spec.references || [],
    besides: spec.besides || [],
    keyOrder: fields.keys,

    /**
     * Checks an object a file (or the seed) gives, then reads what it names beside it.
     *
     * Args:
     *   raw (object): the object.
     *   opts (object): { dir (the folder its file is in), root (the folder what it names must be
     *     in : the repository, the seed file's folder ; dir when not given), resolved (the seed's own
     *     : its references resolved already), fromSeed (the config seed's declaration) }.
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
     * The app's object as its map : its fields (its secrets left out) and the files beside it.
     *
     * Args:
     *   current (object): the app's object.
     *
     * Returns:
     *   object: { object (the map), withoutSecret, extraFiles: [{ name, buffer }] }.
     */
    fileOf(current) {
      const { object, withoutSecret } = fields.toFile(toYaml(current));
      return { object, withoutSecret, extraFiles: spec.extraFiles ? spec.extraFiles(current) : [] };
    },

    /**
     * An app edit as the edits of its map : only the fields it changed, and the files beside it
     * that changed.
     *
     * Args:
     *   declared (object): its map as the file has it now.
     *   after (object): the app's object as saved.
     *   before (object): the app's object before the edit.
     *
     * Returns:
     *   object: { edits ({ field: value }, undefined removing it), keyOrder, extraFiles: [{ name,
     *     buffer }], gone (string[] : the files beside it no longer named, when the type says them ;
     *     undefined : none) }.
     */
    fileEdits(declared, after, before) {
      // the files beside it as the file names them now (the logo's image) : only the ones the edit
      // changed written, and its YAML naming them where it names another file
      const files = spec.editFiles ? spec.editFiles(declared || {}, after, before || {}) : null;
      const next = files ? { ...toYaml(after), ...files.names } : toYaml(after);
      const prev = files ? { ...toYaml(before || {}), ...files.base } : toYaml(before || {});
      return {
        edits: fields.editsOf(next, prev),
        keyOrder: fields.keyOrderOf(next, prev),
        extraFiles: files ? files.extraFiles : spec.extraFiles ? spec.extraFiles(after) : [],
        gone: files ? files.gone : undefined,
      };
    },

    // a type the app has one of has no rows to link : its repository holds it, its flag says so
    store: { unlink: async () => 0, rename: async () => 0, countLinked: async () => 0 },
  };
}
