'use strict';
// The files of a repository its usage types own (lib/repoObjects/types.js), by their content
// (lib/repoObjects/repoFiles.js) : each YAML file giving at its top level the key of a type the
// repository holds (credentials:, defaults:, roles: ... - one that cannot be read, its lines seeming
// to give one, too), the files those name (the logo's, the icon's image, relative to the file
// naming it), the config.yaml of before at its root while it holds the roles, the categories or
// the constants (still read, deprecated), and each of these keys' own file at its root (roles.yaml :
// read for it when no other file gives it, there or not) ; and the file the whole base configuration may be served
// from, roles included, when no repository holds those keys (a forms repository's config.yaml,
// Repository.getConfigCandidates). The app reads them as configuration, objects and secrets : the
// designer's file explorers (models/projectFiles.model.js) never list, read, write nor delete them,
// even in a repository used for workflows, inventories, playbooks or vars files as well - writing
// roles: there made a designer an admin ; nor does its forms save (models/form.model.js) write a
// form file onto one, in a repository serving its forms from its root, nor its forms load read one
// as forms. A file a designer writes whose content would give such a key is refused the same way
// (assertContentNotOwned). A path is checked against every repository whose working tree it is in,
// as the disk resolves it : a local folder holding the repositories' root, or a form file named
// '../other/roles.yaml', reaches another repository's files.
import fs from "fs";
import path from "path";
import mysql from "../../models/db.model.js";
import Repo from "../../models/repo.model.js";
import Repository from "../../models/repository.model.js";
import logger from "../logger.js";
import Errors from "../errors.js";
import { USAGE_TYPES, typeOf, fileKeyOf } from "./types.js";
import { CONFIG_KEYS, LEGACY_FILE } from "../configKeys.js";
import { scanRepository, contentOf, holdsTypeKeys } from "./repoFiles.js";

// the types whose map names files of the repository, and the fields that name them : the logo's
// and the icon's image
const NAMING = { logo: ["logo"], icon: ["icon"] };

/**
 * A path relative to a folder, with forward slashes ; null when it is not inside it.
 *
 * Args:
 *   root (string): the folder.
 *   abs (string): the path.
 *
 * Returns:
 *   string|null: the relative path ('' for the folder itself).
 */
function relativeTo(root, abs) {
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * A path as the disk resolves it, links followed : the deepest part of it that exists resolved
 * (realpath), the rest added as written. A file not made yet is resolved through the folders it
 * would be made in, so a link to a folder (sub -> .) cannot hide where it lands.
 *
 * Args:
 *   abs (string): the path, absolute.
 *
 * Returns:
 *   string: the path resolved ; as written when nothing of it resolves.
 */
export function realPathOf(abs) {
  let probe = path.resolve(abs);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...rest);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(abs);
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * The type keys a repository holds (its use_for_* flags), each with its label.
 *
 * Args:
 *   row (object): the repository's row.
 *
 * Returns:
 *   Map<string, string>: label by type key.
 */
function heldKeys(row) {
  return new Map(USAGE_TYPES.filter((t) => (t.objects || t.config) && Number(row[t.flag] ?? 0)).map((t) => [t.key, t.label]));
}

/**
 * What a repository's usage types own in it, by path relative to its working tree : by the files'
 * content.
 *
 * Args:
 *   row (object): the repository's row (its name and its use_for_* flags).
 *   configFiles (object[]): the files the base configuration may be served from
 *     (Repository.getConfigCandidates : [{ repo, path }]).
 *
 * Returns:
 *   object[]: [{ rel, label (the type's, as the server names it) }].
 */
function ownedOf(row, configFiles = []) {
  const dir = Repo.folderOf(row.name);
  const out = [];
  // the base configuration, roles included, served from this repository's file (no repository holds
  // the roles, the categories nor the constants : the 7.3 layout)
  for (const c of configFiles) {
    const rel = c.repo === row.name ? relativeTo(dir, path.resolve(c.path)) : null;
    if (rel) out.push({ rel, label: "configuration" });
  }
  const held = heldKeys(row);
  if (!held.size) return out;
  // config.yaml of before : still read for the roles, the categories and the constants ; and each
  // key's own file at the root (roles.yaml), read for it when no other file gives it, there or not
  const legacy = [...held.keys()].find((k) => typeOf(k)?.config);
  if (legacy) out.push({ rel: LEGACY_FILE, label: held.get(legacy) });
  for (const k of CONFIG_KEYS) if (held.has(k.key)) out.push({ rel: k.file, label: held.get(k.key) });
  const scan = scanRepository(dir);
  for (const f of scan.files) {
    const keys = f.keys.filter((k) => held.has(k));
    if (!keys.length) continue;
    out.push({ rel: f.file, label: held.get(keys[0]) });
    // the files its maps name, relative to it
    for (const key of keys) {
      const value = f.data[key];
      for (const field of NAMING[key] || []) {
        const named = value && typeof value === "object" && !Array.isArray(value) ? value[field] : null;
        const rel = typeof named === "string" && named ? relativeTo(dir, path.resolve(dir, path.dirname(f.file), named)) : null;
        if (rel) out.push({ rel, label: held.get(key) });
      }
    }
  }
  // a file that cannot be read, its lines seeming to give a key it holds : still the type's
  for (const u of scan.unreadable) {
    const key = u.hints.find((k) => held.has(k));
    if (key) out.push({ rel: u.file, label: held.get(key) });
  }
  return out;
}

/**
 * Which repository's usage type owns a path, by the path as written and as the disk resolves it
 * (links followed), in every repository whose working tree holds it : a test made once, for a
 * listing as for one file.
 *
 * Returns:
 *   Promise<function>: (absolute path) => { repository, label (the owning type's) }, or null.
 */
async function ownersTest() {
  let rows = [];
  let configFiles = [];
  try {
    rows = await mysql.do("SELECT * FROM AnsibleForms.`repositories`");
    configFiles = await Repository.getConfigCandidates();
  } catch (e) {
    logger.warning(`Could not read the usages of the repositories: ${e.message}`);
  }
  const trees = [];
  for (const row of rows || []) {
    if (!Repo.isValidName(row.name)) continue;
    const owned = ownedOf(row, configFiles);
    const held = heldKeys(row);
    if (!owned.length && !held.size) continue;
    const dir = Repo.folderOf(row.name);
    let realDir = dir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      // not cloned yet : as written
    }
    trees.push({ repository: row.name, dir, realDir, owned, held });
  }
  if (!trees.length) return () => null;
  const match = (tree, rel) => tree.owned.find((o) => rel !== null && rel === o.rel)?.label || null;
  const test = (abs) => {
    const real = realPathOf(abs);
    for (const tree of trees) {
      // as written ; else a link to one of them, or a new file made through a linked folder
      const label = match(tree, relativeTo(tree.dir, path.resolve(abs))) || match(tree, relativeTo(tree.realDir, real));
      if (label) return { repository: tree.repository, label };
    }
    return null;
  };
  return test;
}

/**
 * Which usage type owns a path (ownersTest), as a test made once for many paths : checked against
 * every repository, whatever folder the caller lists (a local folder may hold the repositories').
 *
 * Returns:
 *   Promise<function>: (absolute path) => the owning type's label, or null.
 */
export async function ownerTest() {
  const test = await ownersTest();
  return (abs) => test(abs)?.label || null;
}

/**
 * What the forms loader leaves out, as a test made once for many paths : a file a usage type owns
 * (ownerTest), and any file giving a type's key at its top level, whatever repository it is in and
 * whatever usages that repository holds (lib/repoObjects/repoFiles.js holdsTypeKeys) - a form never
 * gives one (a form is a map with a type), so such a file is never read as forms.
 *
 * Returns:
 *   Promise<function>: (absolute path) => truthy when it is left out.
 */
export async function formsSkipTest() {
  const owned = await ownerTest();
  return (abs) => owned(abs) || holdsTypeKeys(abs);
}

/**
 * Which repository's usage type owns a path (ownersTest), for one path.
 *
 * Args:
 *   abs (string): the path.
 *
 * Returns:
 *   Promise<object|null>: { repository, label }, or null.
 */
export async function findOwner(abs) {
  return (await ownersTest())(abs);
}

/**
 * Which usage type owns a path (ownersTest), for one path.
 *
 * Args:
 *   repository (string|null): the repository the path is in (every repository is checked).
 *   abs (string): the path.
 *
 * Returns:
 *   Promise<string|null>: the owning type's label, or null.
 */
export async function ownerOf(repository, abs) {
  return (await findOwner(abs))?.label || null;
}

/**
 * Refuses a path a usage type of a repository owns.
 *
 * Args:
 *   repository (string|null): the repository the path is in (every repository is checked).
 *   abs (string): the path.
 *   name (string): the path as the request names it.
 *
 * Raises:
 *   Errors.AccessDeniedError: a usage type of a repository owns it, which one said.
 */
export async function assertNotOwned(repository, abs, name) {
  const owner = await findOwner(abs);
  if (owner) throw new Errors.AccessDeniedError(`'${name}' holds the ${owner.label} of repository '${owner.repository}': it is not read nor written in the designer`);
}

/**
 * Refuses a file a designer writes whose content gives at its top level the key of any usage
 * type (controller_credentials:, controller_roles: ... : lib/repoObjects/repoFiles.js), whether a
 * repository it lands in holds that type or not : written, it would be that type's - read in by the
 * next pull, or the day the type is turned on there - a designer never writes the app's objects,
 * its roles nor its secrets. A form (a map with a type) never gives one ; a text that cannot be read
 * is refused when its lines seem to give one ; a key whose value has not its type's shape is refused
 * too (fixed, it would be the type's).
 *
 * Args:
 *   abs (string): the path written.
 *   content (string): its text.
 *   name (string): the path as the request names it.
 *
 * Raises:
 *   Errors.AccessDeniedError: its content gives such a key, which one said.
 */
export async function assertContentNotOwned(abs, content, name) {
  if (!/\.(yaml|yml)$/i.test(String(abs))) return;
  const found = contentOf(content);
  const keys = found.errors.length ? found.hints : [...found.keys, ...(found.misfits || [])];
  if (!keys.length) return;
  throw new Errors.AccessDeniedError(`'${name}' gives ${fileKeyOf(keys[0])}:, a key of the ${typeOf(keys[0])?.label || keys[0]} the app keeps in a repository: it is not written in the designer`);
}

export default { realPathOf, ownerTest, formsSkipTest, findOwner, ownerOf, assertNotOwned, assertContentNotOwned };
