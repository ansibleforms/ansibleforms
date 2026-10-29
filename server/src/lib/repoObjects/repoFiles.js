'use strict';
// The files of a repository as the usage types read them : by their content, never by their names
// nor their folders. Any .yaml or .yml file of a repository's working tree, at any depth (its .git
// folder, and every hidden folder or file, left out), whose top-level key is a type's key
// (lib/repoObjects/types.js CONTENT_KEYS : credentials:, schedules:, defaults:, roles: ...) holds
// that type : a list of objects under it, or one map for a type the app has one of. A file may
// hold several types, a type may be spread over many files ; a file whose keys are no type's (a
// form, a playbook, an inventory, a vars file) is none of theirs, a form (a map with a `type`, as
// every form has) never is one, whatever other keys it has (its roles, its categories, its icon),
// and a key whose value is a text, a number or a yes or no (a vars file's name: web) is no type's.
//
// One walk reads them all (scanRepository) : the engine reads it once per pull and hands each type
// its entries (lib/repoObjects/engine.js), the designer's file explorers and the forms loader tell
// the files the types own by it (lib/repoObjects/ownedPaths.js), the configuration keys find their
// file by it (lib/configKeys.js). A file is parsed again only when its text changed, and only when
// its text may give a type's key at all.
//
// A link is followed only while it stays in the repository : one that leads outside (or nowhere)
// is never read, said refused ; a folder reached twice (a link back up the tree) is walked once.
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { CONTENT_KEYS } from "./types.js";
import { YAML_FILE } from "./yamlFile.js";

// ===========================================================================
// CONSTANTS
// ===========================================================================

// how deep a walk goes below the repository's root
const MAX_DEPTH = 24;

// the files parsed, by their absolute path, with the text they were parsed from : parsed again only
// when their text changed
const MAX_CACHED = 20000;
const parsed = new Map();

// a line of a file that may give a type's key : the key at the start of the line (quoted or not),
// then a colon - a file without one is no type's, never parsed here
const KEY_LINE = new RegExp(`^["']?(${CONTENT_KEYS.join("|")})["']?[ \\t]*:`, "gm");

// a file written as one flow map ({ credentials: [...] }) : parsed too
const FLOW_START = /^(?:\s*(?:#[^\n]*)?\n)*\s*(?:---\s*\n\s*)?\{/;

// ===========================================================================
// ONE FILE
// ===========================================================================

/**
 * The keys a text's lines may give a type by (KEY_LINE) : what a file that cannot be read is
 * taken to hold.
 *
 * Args:
 *   text (string): the text.
 *
 * Returns:
 *   string[]: the type keys, each once.
 */
function hintedKeys(text) {
  return [...new Set([...String(text ?? "").matchAll(KEY_LINE)].map((m) => m[1]))];
}

/**
 * What a YAML text holds of the types : the type keys it gives at its top level with a list or a
 * map under them (or nothing yet), and their values. A form (a map with a `type` key, as every form
 * has), a list (a playbook) or any other value holds none. A text that cannot be read (not valid YAML, keys given twice, too many aliases) holds none
 * either, the keys its lines seem to give said (hints).
 *
 * Args:
 *   text (string): the text.
 *
 * Returns:
 *   object: { keys (string[] : the type keys it holds, in its order), data ({ key: value } : their
 *     values), errors (string[] : why it cannot be read ; none when it can), hints (string[] : the
 *     type keys its lines seem to give, when it cannot be read) }.
 */
export function contentOf(text) {
  const none = { keys: [], data: {}, errors: [], hints: [] };
  const source = String(text ?? "");
  const hints = hintedKeys(source);
  if (!hints.length && !FLOW_START.test(source)) return none;
  const doc = YAML.parseDocument(source, { prettyErrors: false });
  if (doc.errors.length) return { ...none, errors: [`not valid YAML: ${doc.errors[0].message}`], hints };
  if (!YAML.isMap(doc.contents)) return none;
  // a form : its roles, categories and icon are its own
  if (doc.contents.has("type")) return none;
  // a type's key whose value is a text, a number or a yes or no (a vars file's name: web) : no
  // type's - a type is a list or a map under its key (nothing after it : none yet)
  const scalar = (node) => YAML.isScalar(node) && node.value !== null && node.value !== undefined;
  const keys = doc.contents.items
    .filter((pair) => !scalar(pair.value))
    .map((pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key))
    .filter((k) => CONTENT_KEYS.includes(k));
  if (!keys.length) return none;
  try {
    // its aliases expanded : too many (an alias bomb) is refused, never thrown
    const all = doc.toJS() || {};
    return { keys, data: Object.fromEntries(keys.map((k) => [k, all[k]])), errors: [], hints: [] };
  } catch (e) {
    return { ...none, errors: [`not valid YAML: ${e.message || e}`], hints };
  }
}

/**
 * A file's content (contentOf) : its text read, parsed again only when it is not the text last
 * parsed for that path (a text that may give no type's key is never parsed).
 *
 * Args:
 *   abs (string): the file.
 *
 * Returns:
 *   object: contentOf's, or { errors } when it cannot be read.
 */
function fileContent(abs) {
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { keys: [], data: {}, errors: [`cannot be read: ${e.code || e.message}`], hints: [] };
  }
  const hit = parsed.get(abs);
  if (hit && hit.text === text) return hit.content;
  const content = contentOf(text);
  // only what was parsed is kept : a text giving no key is told apart without parsing
  if (content.keys.length || content.errors.length) {
    if (parsed.size >= MAX_CACHED) parsed.delete(parsed.keys().next().value);
    parsed.set(abs, { text, content });
  } else parsed.delete(abs);
  return content;
}

// ===========================================================================
// THE WALK
// ===========================================================================

/**
 * The YAML files of a working tree, each with what it holds of the types : every .yaml and .yml
 * file at any depth, sorted by path ; .git and every hidden folder or file left out ; a link
 * followed while it stays in the tree, one that leads outside or nowhere said refused.
 *
 * Args:
 *   dir (string): the working tree.
 *
 * Returns:
 *   object: the scan : {
 *     dir,
 *     files: [{ file (relative, with forward slashes), keys, data, size, mtimeMs }] - those holding
 *       a type's key,
 *     unreadable: [{ file, errors, hints }] - those that cannot be read, the keys their lines seem
 *       to give,
 *     refused: [{ file, reason }] - the links never read,
 *     blocked: [{ file, reason }] - the folders that cannot be read (no access) : the scan is not
 *       whole, nothing it misses may be taken for gone,
 *     stamp (string : every YAML file with its size and time ; two scans give the same stamp only
 *       when none of them changed between them),
 *     holding(key) : the files holding a key, sorted ([{ file, value }]),
 *     hinted(key) : the unreadable files whose lines seem to give it,
 *   }
 *   A tree that is not there scans as empty.
 */
export function scanRepository(dir) {
  const files = [];
  const unreadable = [];
  const refused = [];
  const blocked = [];
  const stamp = [];
  let root;
  try {
    root = fs.realpathSync(dir);
  } catch {
    return scanOf(dir, files, unreadable, refused, stamp, blocked);
  }
  const visited = new Set([root]);
  const walk = (abs, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      // a folder that cannot be read (no access) : never taken for an empty one, whose sync would
      // delete every object its files hold
      blocked.push({ file: rel || ".", reason: e.code || e.message });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // .git, and every hidden folder or file
      if (entry.name.startsWith(".")) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let real = childAbs;
      if (entry.isSymbolicLink()) {
        const yaml = YAML_FILE.test(entry.name);
        try {
          real = fs.realpathSync(childAbs);
        } catch {
          if (yaml) refused.push({ file: childRel, reason: "a link that leads nowhere, or not readable: never read" });
          continue;
        }
        if (real !== root && !real.startsWith(root + path.sep)) {
          if (yaml) refused.push({ file: childRel, reason: "a link that leads outside the repository: never read" });
          continue;
        }
        const st = fs.statSync(real, { throwIfNoEntry: false });
        isDir = !!st?.isDirectory();
        isFile = !!st?.isFile();
      }
      if (isDir) {
        // a folder reached twice (a link back up the tree) : walked once
        if (depth >= MAX_DEPTH || visited.has(real)) continue;
        visited.add(real);
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!isFile || !YAML_FILE.test(entry.name)) continue;
      const st = fs.statSync(real, { throwIfNoEntry: false });
      if (!st) continue;
      stamp.push(`${childRel}:${st.size}:${st.mtimeMs}`);
      const content = fileContent(real);
      if (content.errors.length) unreadable.push({ file: childRel, errors: content.errors, hints: content.hints });
      else if (content.keys.length) files.push({ file: childRel, keys: content.keys, data: content.data, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, "", 0);
  return scanOf(dir, files, unreadable, refused, stamp, blocked);
}

/**
 * A scan's object, its lists sorted by path, with its lookups.
 *
 * Args:
 *   dir (string): the working tree.
 *   files, unreadable, refused (object[]): what the walk found.
 *   stamp (string[]): each YAML file with its size and time.
 *   blocked (object[]): the folders that cannot be read.
 *
 * Returns:
 *   object: the scan (scanRepository).
 */
function scanOf(dir, files, unreadable, refused, stamp, blocked = []) {
  const byPath = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  files.sort(byPath);
  unreadable.sort(byPath);
  refused.sort(byPath);
  return {
    dir,
    files,
    unreadable,
    refused,
    blocked,
    stamp: stamp.sort().join("\n"),
    // a copy of each value : a reader may change what it is handed
    holding: (key) => files.filter((f) => f.keys.includes(key)).map((f) => ({ file: f.file, value: structuredClone(f.data[key]) })),
    hinted: (key) => unreadable.filter((u) => u.hints.includes(key)),
  };
}

/**
 * Whether a file gives a type's key at its top level (contentOf) - or seems to, when it cannot be
 * read : no form, whatever repository it is in (the forms loader leaves it out).
 *
 * Args:
 *   abs (string): the file.
 *
 * Returns:
 *   boolean: true when it does.
 */
export function holdsTypeKeys(abs) {
  if (!YAML_FILE.test(String(abs))) return false;
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const content = fileContent(fs.realpathSync(abs));
  return content.keys.length > 0 || (content.errors.length > 0 && content.hints.length > 0);
}

/**
 * Forgets the files parsed.
 */
export function forgetScans() {
  parsed.clear();
}

export default { contentOf, scanRepository, holdsTypeKeys, forgetScans };
