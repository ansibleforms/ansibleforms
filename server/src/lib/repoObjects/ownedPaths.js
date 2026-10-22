'use strict';
// The paths of a repository its usage types own (lib/repoObjects/types.js) : the roles', the
// categories' and the constants' files (lib/configKeys.js, config.yaml included), and each object
// type's folder (credentials/, runners/ ...), its list file (repositories.yaml) or its single file
// (general.yaml, branding.yaml) with the files beside it that file names (the branding's images).
// The app reads them as configuration, objects and secrets : the designer's file explorers
// (models/projectFiles.model.js) never list, read, write nor delete them, even in a repository used
// for workflows, inventories, playbooks or vars files as well - writing roles.yaml there made a
// designer an admin ; nor does its forms save (models/form.model.js) write a form file onto one, in
// a repository serving its forms from its root.
import fs from "fs";
import path from "path";
import mysql from "../../models/db.model.js";
import Repo from "../../models/repo.model.js";
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
 *
 * Returns:
 *   Promise<object[]>: [{ rel, folder (a whole folder), label (the type's, as the server names it) }].
 */
async function ownedOf(row) {
  const dir = Repo.folderOf(row.name);
  const out = [];
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
 * Which usage type of a repository owns a path, by the path as written and as the disk resolves it
 * (links followed) : a test made once per repository, for a listing as for one file.
 *
 * Args:
 *   repository (string|null): the repository ; none (a local folder) owns nothing.
 *
 * Returns:
 *   Promise<function>: (absolute path) => the owning type's label, or null.
 */
export async function ownerTest(repository) {
  if (!repository || !Repo.isValidName(repository)) return () => null;
  let rows = [];
  try {
    rows = await mysql.do("SELECT * FROM AnsibleForms.`repositories` WHERE name = ?", [repository]);
  } catch (e) {
    logger.warning(`Could not read the usages of repository '${repository}': ${e.message}`);
  }
  if (!rows?.length) return () => null;
  const owned = await ownedOf(rows[0]);
  if (!owned.length) return () => null;
  const dir = Repo.folderOf(repository);
  const realDir = (() => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  const match = (rel) => owned.find((o) => rel !== null && (rel === o.rel || (o.folder && rel.startsWith(`${o.rel}/`))))?.label || null;
  return (abs) => {
    const found = match(relativeTo(dir, abs));
    if (found) return found;
    // a link to one of them, or a new file made through a linked folder
    return match(relativeTo(realDir, realPathOf(abs)));
  };
}

/**
 * Which usage type of a repository owns a path (ownerTest), for one path.
 *
 * Args:
 *   repository (string|null): the repository the path is in.
 *   abs (string): the path.
 *
 * Returns:
 *   Promise<string|null>: the owning type's label, or null.
 */
export async function ownerOf(repository, abs) {
  return (await ownerTest(repository))(abs);
}

/**
 * Refuses a path a usage type of its repository owns.
 *
 * Args:
 *   repository (string|null): the repository the path is in.
 *   abs (string): the path.
 *   name (string): the path as the request names it.
 *
 * Raises:
 *   Errors.AccessDeniedError: a usage type of the repository owns it, which one said.
 */
export async function assertNotOwned(repository, abs, name) {
  const label = await ownerOf(repository, abs);
  if (label) throw new Errors.AccessDeniedError(`'${name}' holds the ${label} of repository '${repository}': it is not read nor written in the designer`);
}

export default { realPathOf, ownerTest, ownerOf, assertNotOwned };
