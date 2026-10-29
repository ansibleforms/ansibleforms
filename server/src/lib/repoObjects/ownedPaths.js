'use strict';
// The paths of a repository its usage types own (lib/repoObjects/types.js) : the roles', the
// categories' and the constants' files (lib/configKeys.js, config.yaml included), and each object
// type's folder (credentials/, runners/ ...), its list file (repositories.yaml) or its single file
// (general.yaml, branding.yaml) with the files beside it that file names (the branding's images) ;
// and the file the whole base configuration may be served from, roles included, when no repository
// holds those keys (a forms repository's config.yaml, Repository.getConfigCandidates).
// The app reads them as configuration, objects and secrets : the designer's file explorers
// (models/projectFiles.model.js) never list, read, write nor delete them, even in a repository used
// for workflows, inventories, playbooks or vars files as well - writing roles.yaml there made a
// designer an admin ; nor does its forms save (models/form.model.js) write a form file onto one, in
// a repository serving its forms from its root, nor its forms load read one as forms. A path is checked against every repository whose
// working tree it is in, as the disk resolves it : a local folder holding the repositories' root, or
// a form file named '../other/roles.yaml', reaches another repository's files.
import fs from "fs";
import path from "path";
import mysql from "../../models/db.model.js";
import Repo from "../../models/repo.model.js";
import Repository from "../../models/repository.model.js";
import logger from "../logger.js";
import Errors from "../errors.js";
import { USAGE_TYPES } from "./types.js";
import { descriptorOf, BUILT_OBJECT_TYPES } from "./descriptors.js";
import { CONFIG_KEYS, LEGACY_FILE } from "../configKeys.js";
import { parseMapFile } from "./yamlFile.js";

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
 * What a repository's usage types own in it, by path relative to its working tree.
 *
 * Args:
 *   row (object): the repository's row (its name and its use_for_* flags).
 *   configFiles (object[]): the files the base configuration may be served from
 *     (Repository.getConfigCandidates : [{ repo, path }]).
 *
 * Returns:
 *   Promise<object[]>: [{ rel, folder (a whole folder), label (the type's, as the server names it) }].
 */
async function ownedOf(row, configFiles = []) {
  const dir = Repo.folderOf(row.name);
  const out = [];
  // the base configuration, roles included, served from this repository's file (no repository holds
  // the roles, the categories nor the constants : the 7.3 layout)
  for (const c of configFiles) {
    const rel = c.repo === row.name ? relativeTo(dir, path.resolve(c.path)) : null;
    if (rel) out.push({ rel, folder: false, label: "configuration" });
  }
  for (const type of USAGE_TYPES) {
    if (!Number(row[type.flag] ?? 0)) continue;
    // the roles, the categories, the constants : their own file, and config.yaml they may be read from
    const key = CONFIG_KEYS.find((k) => k.key === type.key);
    if (key) {
      out.push({ rel: key.file, folder: false, label: type.label }, { rel: LEGACY_FILE, folder: false, label: type.label });
      continue;
    }
    if (!type.objects || !BUILT_OBJECT_TYPES.includes(type.key)) continue;
    const desc = await descriptorOf(type.key);
    if (desc.file) {
      out.push({ rel: desc.file, folder: false, label: type.label });
      // the files its YAML names beside it
      const besides = desc.besides || [];
      if (besides.length) {
        let named = {};
        try {
          named = parseMapFile(fs.readFileSync(path.join(dir, desc.file), "utf8")).object || {};
        } catch {
          // no file yet : nothing named
        }
        for (const field of besides) {
          const rel = typeof named[field] === "string" ? relativeTo(dir, path.resolve(dir, named[field])) : null;
          if (rel) out.push({ rel, folder: false, label: type.label });
        }
      }
    } else if (desc.listFile) {
      out.push({ rel: desc.listFile, folder: false, label: type.label });
    } else if (desc.folder) {
      out.push({ rel: desc.folder, folder: true, label: type.label });
    }
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
    const owned = await ownedOf(row, configFiles);
    if (!owned.length) continue;
    const dir = Repo.folderOf(row.name);
    let realDir = dir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      // not cloned yet : as written
    }
    trees.push({ repository: row.name, dir, realDir, owned });
  }
  if (!trees.length) return () => null;
  const match = (tree, rel) => tree.owned.find((o) => rel !== null && (rel === o.rel || (o.folder && rel.startsWith(`${o.rel}/`))))?.label || null;
  return (abs) => {
    const real = realPathOf(abs);
    for (const tree of trees) {
      // as written ; else a link to one of them, or a new file made through a linked folder
      const label = match(tree, relativeTo(tree.dir, path.resolve(abs))) || match(tree, relativeTo(tree.realDir, real));
      if (label) return { repository: tree.repository, label };
    }
    return null;
  };
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

export default { realPathOf, ownerTest, findOwner, ownerOf, assertNotOwned };
