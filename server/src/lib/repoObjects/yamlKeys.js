'use strict';
// The keys of a map a file gives that are named otherwise than the field they set : the Defaults
// page's forms view is default_forms_view in a file (as its siblings default_theme,
// default_timezone ...) and forms_view in the settings row, the API and the page. A file is read
// by its keys and turned into the fields once (lib/repoObjects/singleType.js check), written back
// by its keys from the fields (fileOf, fileEdits), and what is said about it (a field the config
// seed keeps, a refusal) names the key the file has. Every other key is its field's own name.

/**
 * The translation between a map's keys and the fields they set.
 *
 * Args:
 *   map (object|undefined): { key in a file: field } ; none : every key its field's name.
 *
 * Returns:
 *   object: {
 *     fieldOf ((key) => the field a key sets),
 *     keyOf ((field) => the key a file names it by),
 *     toFields ((obj) => a file's map with the fields as keys),
 *     toKeys ((obj) => the fields as a file names them),
 *   }
 */
export function yamlKeys(map = {}) {
  const byField = Object.fromEntries(Object.entries(map).map(([key, field]) => [field, key]));
  const fieldOf = (key) => (Object.hasOwn(map, key) ? map[key] : key);
  const keyOf = (field) => (Object.hasOwn(byField, field) ? byField[field] : field);

  /**
   * An object with each of its keys translated, its values as they are.
   *
   * Args:
   *   obj (object|null): the object.
   *   to (function): the translation of a key.
   *
   * Returns:
   *   object|null: the object translated (its own enumerable keys) ; as it is when the map
   *     renames nothing.
   */
  const rename = (obj, to) => {
    if (!obj || typeof obj !== "object" || !Object.keys(map).length) return obj;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [to(k), v]));
  };

  return {
    fieldOf,
    keyOf,
    toFields: (obj) => rename(obj, fieldOf),
    toKeys: (obj) => rename(obj, keyOf),
  };
}

export default { yamlKeys };
