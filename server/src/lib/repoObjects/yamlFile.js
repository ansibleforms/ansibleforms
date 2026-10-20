'use strict';
// The YAML files of the repository-backed objects (lib/repoObjects/engine.js) : one object per
// file, read as a map, and written back with only the fields the app changed - the keys it does
// not know, their comments and their order kept as the file has them, a new key put at its place
// in the type's key order. Pure, no database : the schedule files (lib/scheduleFiles.js) and every
// other object type write through these.
import fs from "fs";
import path from "path";
import YAML from "yaml";

// ===========================================================================
// CONSTANTS
// ===========================================================================

// an object's file : yaml
export const YAML_FILE = /\.(yaml|yml)$/i;

// ===========================================================================
// THE FILE : WRITTEN
// ===========================================================================

/**
 * The plain key of a map's pair.
 *
 * Args:
 *   pair (Pair): the pair.
 *
 * Returns:
 *   any: its key.
 */
const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);

/**
 * Sets a key of a map, a key that is not there yet put at its place in a key order among the keys
 * there ; whatever else the map holds (and its comments) left as it is.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   map (YAMLMap): the map.
 *   key (string): the key.
 *   value (any): the value.
 *   keyOrder (string[]): the order a new key is put in (none : at the end).
 */
export function setKey(doc, map, key, value, keyOrder = []) {
  if (map.has(key)) {
    const pair = map.items.find((p) => keyOf(p) === key);
    const node = doc.createNode(value);
    // the comment before the old value stays with the key
    if (pair?.value?.commentBefore) node.commentBefore = pair.value.commentBefore;
    if (pair?.value?.comment) node.comment = pair.value.comment;
    pair.value = node;
    return;
  }
  const pair = doc.createPair(key, value);
  const rank = keyOrder.indexOf(key);
  let at = map.items.length;
  if (rank >= 0) {
    // after the last key ranked before it, else before the first ranked after it
    let lastBefore = -1;
    let firstAfter = -1;
    map.items.forEach((p, i) => {
      const r = keyOrder.indexOf(keyOf(p));
      if (r < 0) return;
      if (r < rank) lastBefore = i;
      else if (r > rank && firstAfter < 0) firstAfter = i;
    });
    if (lastBefore >= 0) at = lastBefore + 1;
    else if (firstAfter >= 0) at = firstAfter;
  }
  map.items.splice(at, 0, pair);
}

/**
 * Whether two plain values are the same (a changed field only is written, so a file the app
 * saves with nothing changed stays byte for byte).
 *
 * Args:
 *   a (any): one.
 *   b (any): the other.
 *
 * Returns:
 *   boolean: true when they are.
 */
export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Writes the fields an app edit changed into a map file : each key of `edits` set (a new one at
 * its place in the key order), a key whose edit is undefined removed ; the rest of the file - the
 * keys the app does not know, its comments, its order - kept.
 *
 * Args:
 *   text (string): the file's text.
 *   edits (object): { key: value } ; undefined removes the key.
 *   keyOrder (string[]): the type's key order.
 *
 * Returns:
 *   string: the file's new text.
 *
 * Raises:
 *   Error: the file is not valid YAML, or not a map.
 */
export function updateMapFile(text, edits, keyOrder = []) {
  const doc = YAML.parseDocument(String(text ?? ""));
  if (doc.errors.length) throw new Error(`not valid YAML: ${doc.errors[0].message}`);
  if (!YAML.isMap(doc.contents)) throw new Error("the file is not a YAML dictionary");
  const map = doc.contents;
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) map.delete(key);
    else setKey(doc, map, key, value, keyOrder);
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * A new map file : its keys in the type's key order, the others after them as given.
 *
 * Args:
 *   obj (object): the fields.
 *   keyOrder (string[]): the type's key order.
 *
 * Returns:
 *   string: the file's text.
 */
export function newMapFile(obj, keyOrder = []) {
  const rank = (k) => (keyOrder.includes(k) ? keyOrder.indexOf(k) : keyOrder.length);
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => rank(a) - rank(b)));
  return YAML.stringify(sorted, { lineWidth: 0 });
}

/**
 * Reads a map file as a plain object.
 *
 * Args:
 *   text (string): the file's text.
 *
 * Returns:
 *   object: { errors (string[]), object (the map, null when refused) }.
 */
export function parseMapFile(text) {
  const doc = YAML.parseDocument(String(text ?? ""), { prettyErrors: false });
  if (doc.errors.length) return { errors: [`not valid YAML: ${doc.errors[0].message}`], object: null };
  if (!YAML.isMap(doc.contents)) return { errors: ["the file is not a YAML dictionary"], object: null };
  return { errors: [], object: doc.contents.toJS(doc) || {} };
}

// ===========================================================================
// THE FILES OF A FOLDER
// ===========================================================================

/**
 * The file name a new object gets in its folder : its name in lower case, letters and digits
 * apart by dashes, a number added when a file has it already.
 *
 * Args:
 *   name (string): the object's name.
 *   taken (function): (fileName) => true when a file has that name.
 *   fallback (string): the name of an object whose name has no letter nor digit.
 *
 * Returns:
 *   string: the file name (nightly-log-rotation.yaml).
 */
export function fileNameFor(name, taken = () => false, fallback = "object") {
  const slug =
    String(name || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || fallback;
  let file = `${slug}.yaml`;
  for (let n = 2; taken(file); n++) file = `${slug}-${n}.yaml`;
  return file;
}

/**
 * The object files of a folder of a repository : the yaml files right in it, sorted ; a link that
 * leads outside the repository, a folder or anything else is left out.
 *
 * Args:
 *   repoDir (string): the repository's working tree.
 *   folder (string): the folder, relative to it (credentials).
 *   pattern (RegExp): the file names taken (YAML_FILE when not given).
 *
 * Returns:
 *   string[]: the files, relative to the repository (credentials/git.yaml).
 */
export function filesIn(repoDir, folder, pattern = YAML_FILE) {
  const dir = path.join(repoDir, folder);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    try {
      // a link is followed only when it stays in the repository
      const real = fs.realpathSync(abs);
      if (!real.startsWith(fs.realpathSync(repoDir) + path.sep)) continue;
      if (!fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    files.push(`${folder}/${entry.name}`);
  }
  return files.sort();
}

/**
 * The absolute path of an object's file, checked to be right in its folder of the repository.
 *
 * Args:
 *   repoDir (string): the repository's working tree.
 *   folder (string): the type's folder (credentials).
 *   repoFile (string): the file, relative to the repository (credentials/git.yaml).
 *   pattern (RegExp): the file names taken (YAML_FILE when not given).
 *
 * Returns:
 *   string: the path.
 *
 * Raises:
 *   Error: a file outside the folder.
 */
export function fileIn(repoDir, folder, repoFile, pattern = YAML_FILE) {
  const abs = path.resolve(repoDir, String(repoFile || ""));
  if (path.dirname(abs) !== path.join(repoDir, folder) || !pattern.test(abs)) {
    throw new Error(`'${repoFile}' is not a file of the ${folder} folder`);
  }
  return abs;
}
