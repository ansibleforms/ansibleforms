'use strict';
// The fields of a repository-backed object's file, in the config seed's format : what every
// seed-format type does the same way, the types kept in a folder (lib/repoObjects/seedType.js) and
// the types kept in one file (lib/repoObjects/singleType.js) alike -
//   check     a file's object checked : its secrets ${ENV} references only (resolved as the seed
//             resolves them), then the seed's schema of the item
//   toFile    an object of the app as its file gives it : the seed's fields that are set, its
//             secrets left out
//   editText  an app edit written into the file : only the fields it changed
import { itemValidator } from "../seed-schema.js";
import { parseMapFile, newMapFile, updateMapFile, same } from "./yamlFile.js";
import { resolveSecrets, withoutSecrets, given } from "./secrets.js";

/**
 * The fields of a type's file.
 *
 * Args:
 *   spec (object):
 *     section (string|object): its section of the seed, or its item's own schema.
 *     secrets (string[]): its secret fields, never plain in git.
 *     skip (string[]): the fields its files leave out.
 *     keepFalse (string[]): the yes or no fields written when off ; the others only when on.
 *     canonical (function): (object) => the object as it is compared and written (a moment as an
 *       ISO text, ...), the file's and the app's alike ; none : as it is.
 *
 * Returns:
 *   object: { keys, booleans, check, parse, toFile, newText, editText }.
 */
export function fieldSet(spec) {
  const { secrets = [], skip = [], keepFalse = [], canonical = (o) => o } = spec;
  const { validate, keys, schema } = itemValidator(spec.section);
  const booleans = new Set(keys.filter((k) => schema.properties[k].type === "boolean"));
  // the fields a file holds, in the seed's order
  const fileKeys = keys.filter((k) => !skip.includes(k));

  /**
   * An object as its file gives it : the seed's fields that are set, its secrets left out.
   *
   * Args:
   *   row (object): the object (decrypted).
   *
   * Returns:
   *   object: { object, withoutSecret }.
   */
  function toFile(row) {
    const source = canonical({ ...(row || {}) });
    const obj = {};
    for (const k of fileKeys) {
      const v = source[k];
      if (booleans.has(k)) {
        if (v === null || v === undefined) continue;
        const on = !!Number(v === true ? 1 : v === false ? 0 : v);
        if (on || keepFalse.includes(k)) obj[k] = on;
      } else if (given(v)) {
        obj[k] = v;
      }
    }
    return withoutSecrets(obj, secrets);
  }

  /**
   * Checks an object a file (or the seed) gives : its secrets ${ENV} references only, resolved -
   * unless they are resolved already (the seed's own) - then the schema of the item.
   *
   * Args:
   *   raw (object): the object.
   *   opts (object): { resolved (true : the seed resolved its references, the secret rule is the
   *     seed's) }.
   *
   * Returns:
   *   object: { errors, object (resolved, canonical, null when refused) }.
   */
  function check(raw, opts = {}) {
    const resolved = opts.resolved ? { errors: [], object: raw } : resolveSecrets(raw, secrets);
    if (resolved.errors.length) return { errors: resolved.errors, object: null };
    const invalid = validate(resolved.object);
    if (invalid.length) return { errors: invalid, object: null };
    return { errors: [], object: canonical(resolved.object) };
  }

  /**
   * Reads a file : one item, checked (check). A file saying state: absent holds no object.
   *
   * Args:
   *   text (string): the file's text.
   *
   * Returns:
   *   object: { errors, absent, object, raw (as the file gives it) }.
   */
  function parse(text) {
    const { errors, object: raw } = parseMapFile(text);
    if (errors.length) return { errors, absent: false, object: null };
    if (raw.state === "absent") return { errors: [], absent: true, object: null };
    return { ...check(raw), absent: false, raw };
  }

  /**
   * An app edit written into a file : each field the edit changed (the object before and after it,
   * as a file gives them) written, a field emptied removed ; the others - the file's ${ENV}
   * references, the fields it does not declare - left as they are, the secrets never written.
   *
   * Args:
   *   text (string): the file's text.
   *   after (object): the object as saved.
   *   before (object): the object before the edit.
   *
   * Returns:
   *   string: the file's new text (the same text when nothing changed).
   */
  function editText(text, after, before) {
    const edits = editsOf(after, before);
    const next = toFile(after).object;
    if (!Object.keys(edits).length) return text;
    // a file that is not a map any more : written again, whole
    if (!parseMapFile(text).object) return newText(next);
    return updateMapFile(text, edits, fileKeys);
  }

  /**
   * The edits an app edit makes to its file's fields : each field it changed (the object before
   * and after it, as a file gives them), a field emptied undefined (removed) ; the secrets never.
   *
   * Args:
   *   after (object): the object as saved.
   *   before (object): the object before the edit.
   *
   * Returns:
   *   object: { field: value } ; none when nothing changed.
   */
  function editsOf(after, before) {
    const next = toFile(after).object;
    const prev = toFile(before || {}).object;
    const edits = {};
    for (const k of fileKeys) {
      if (secrets.includes(k) || same(next[k], prev[k])) continue;
      // emptied in the app : no longer declared (a yes or no off is its default)
      edits[k] = next[k];
    }
    return edits;
  }

  // a new file : the seed's fields in the seed's order
  const newText = (obj) => newMapFile(obj, fileKeys);

  return { keys: fileKeys, booleans, check, parse, toFile, newText, editText, editsOf };
}

/**
 * The fields of a file that is a flat map of names to values, its names not known beforehand (the
 * System > General settings by their environment names, lib/repoObjects/general.js) : the same
 * rules as fieldSet's, a name's value a text, a number or a yes or no, its secrets known by their
 * names.
 *
 * Args:
 *   spec (object): { isSecret ((name) => whether its value is a secret) }.
 *
 * Returns:
 *   object: { keys, check, parse, toFile, newText, editText }, as fieldSet's.
 */
export function mapFieldSet(spec) {
  const isSecret = spec.isSecret || (() => false);
  const sorted = (obj) => Object.keys(obj).sort();
  const newText = (obj) => newMapFile(obj, sorted(obj));

  function toFile(map) {
    const obj = {};
    for (const k of sorted(map || {})) if (given(map[k])) obj[k] = map[k];
    return withoutSecrets(obj, Object.keys(obj).filter(isSecret));
  }

  function check(raw, opts = {}) {
    const bad = Object.keys(raw).filter((k) => raw[k] !== null && typeof raw[k] === "object");
    if (bad.length) return { errors: [`${bad.join(", ")} must be a text, a number or true / false`], object: null };
    const resolved = opts.resolved ? { errors: [], object: raw } : resolveSecrets(raw, Object.keys(raw).filter(isSecret));
    if (resolved.errors.length) return { errors: resolved.errors, object: null };
    const object = {};
    for (const [k, v] of Object.entries(resolved.object)) object[k] = v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
    return { errors: [], object };
  }

  function parse(text) {
    const { errors, object: raw } = parseMapFile(text);
    if (errors.length) return { errors, absent: false, object: null };
    return { ...check(raw), absent: false, raw };
  }

  function editText(text, after, before) {
    const next = toFile(after).object;
    const prev = toFile(before || {}).object;
    const edits = {};
    for (const k of new Set([...Object.keys(next), ...Object.keys(prev)])) {
      if (isSecret(k) || same(next[k], prev[k])) continue;
      edits[k] = next[k];
    }
    if (!Object.keys(edits).length) return text;
    if (!parseMapFile(text).object) return newText(next);
    return updateMapFile(text, edits, sorted({ ...prev, ...next }));
  }

  return { keys: [], check, parse, toFile, newText, editText };
}
