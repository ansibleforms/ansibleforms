'use strict';
// The base configuration's keys a repository may hold, one usage type each (lib/repoObjects/types.js)
// : the roles (use_for_roles, Access), the categories and the constants (use_for_categories,
// use_for_constants, Designer), one repository at most each. Each key is read on its own from its
// type's repository : from its own file (roles.yaml, categories.yaml, constants.yaml) when there is
// one, else from config.yaml (deprecated since 7.4.0, no longer read in 8.0.0 : said in the server
// log once per load, in the repository's pull output and on its page), and written back to the file
// it was read from - config.yaml stays config.yaml until it is moved - or a new one of its own.
//
// A key no repository holds comes from where the base configuration comes from (the database copy,
// the CONFIG_PATH file : models/form.model.js getBaseConfig, models/settings.model.js) : the keys of
// the repositories are laid over it.
import fs from "fs";
import path from "path";
import YAML from "yaml";
import logger from "./logger.js";
import mysql from "../models/db.model.js";
import Repo from "../models/repo.model.js";
import { updateMapFile, newMapFile } from "./repoObjects/yamlFile.js";

// ===========================================================================
// THE KEYS
// ===========================================================================

// each key : its usage type, its flag, its own file
export const CONFIG_KEYS = [
  { key: "roles", flag: "use_for_roles", file: "roles.yaml" },
  { key: "categories", flag: "use_for_categories", file: "categories.yaml" },
  { key: "constants", flag: "use_for_constants", file: "constants.yaml" },
];

// the one file the three keys were in before (use_for_config) : still read, deprecated
export const LEGACY_FILE = "config.yaml";

/**
 * Where each key held by a repository is : its repository, the file it is read from (its own, else
 * config.yaml), whether that file is config.yaml (deprecated), whether it exists yet (a repository
 * with neither file gets its own on the first write). A key no repository holds, or whose
 * repository is not cloned, is not listed : the base configuration gives it.
 *
 * Returns:
 *   Promise<object[]>: [{ key, flag, file, repository, path, deprecated, exists }].
 */
export async function keySources() {
  const rows = await mysql.do(`SELECT name, ${CONFIG_KEYS.map((k) => k.flag).join(", ")} FROM AnsibleForms.\`repositories\` ORDER BY name`);
  const out = [];
  for (const k of CONFIG_KEYS) {
    const repo = (rows || []).find((r) => Number(r[k.flag]) && Repo.isValidName(r.name));
    if (!repo) continue;
    const dir = Repo.folderOf(repo.name);
    if (!fs.existsSync(dir)) continue;
    const own = path.join(dir, k.file);
    const legacy = path.join(dir, LEGACY_FILE);
    if (fs.existsSync(own)) out.push({ ...k, repository: repo.name, path: own, deprecated: false, exists: true });
    else if (fs.existsSync(legacy)) out.push({ ...k, repository: repo.name, path: legacy, deprecated: true, exists: true });
    else out.push({ ...k, repository: repo.name, path: own, deprecated: false, exists: false });
  }
  return out;
}

/**
 * The deprecation notice of a key read from config.yaml.
 *
 * Args:
 *   source (object): the key's source (keySources).
 *
 * Returns:
 *   string: the notice.
 */
export const deprecationNotice = (source) =>
  `${source.key} read from ${LEGACY_FILE}: deprecated, move them to ${source.file} (${LEGACY_FILE} is no longer read in 8.0.0)`;

/**
 * The keys of a repository read from config.yaml, for its pull output and its page.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<object[]>: [{ key, file, notice }] ; none when it reads none from config.yaml.
 */
export async function repositoryDeprecations(name) {
  return (await keySources()).filter((s) => s.repository === name && s.deprecated).map((s) => ({ key: s.key, file: s.file, notice: deprecationNotice(s) }));
}

/**
 * The lines a repository's pull output says of its keys read from config.yaml.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<string>: the lines, starting with a newline ; '' for none.
 */
export async function deprecationLines(name) {
  try {
    return (await repositoryDeprecations(name)).map((d) => `\nDeprecated: ${d.notice}`).join("");
  } catch (e) {
    logger.debug(`Could not read the configuration keys of repository '${name}': ${e.message}`);
    return "";
  }
}

// ===========================================================================
// READ : THE KEYS LAID OVER THE BASE CONFIGURATION
// ===========================================================================

/**
 * The base configuration with the keys of the repositories laid over it.
 *
 * Args:
 *   baseText (string): the base configuration's text (the database copy, the CONFIG_PATH file).
 *   sources (object[]): the keys' sources (keySources).
 *   render (function): (file) => its text (the file read, or rendered with ytt).
 *
 * Returns:
 *   string: the configuration's text (the base as it is when no key comes from a repository).
 *
 * Raises:
 *   Error: a file that is not valid YAML, named.
 */
export function composeConfig(baseText, sources, render) {
  if (!sources.length) return baseText;
  const doc = (baseText && String(baseText).trim() ? YAML.parse(baseText) : {}) || {};
  for (const s of sources) {
    if (!s.exists) continue;
    let parsed;
    try {
      parsed = YAML.parse(render(s.path)) || {};
    } catch (e) {
      throw new Error(`${s.repository}/${path.basename(s.path)} is not valid YAML: ${e.message}`, { cause: e });
    }
    if (parsed[s.key] !== undefined) doc[s.key] = parsed[s.key];
  }
  return YAML.stringify(doc);
}

// ===========================================================================
// WRITE : EACH KEY BACK TO ITS FILE
// ===========================================================================

/**
 * Writes the keys a repository holds back to the file each was read from (config.yaml stays
 * config.yaml : only its key changes, the rest of the file kept) or to a new file of its own.
 *
 * Args:
 *   doc (object): the configuration (categories, roles, constants ...).
 *   sources (object[]): the keys' sources (keySources).
 *   opts (object): { claim (true : each repository's write claim taken here ; false : the caller
 *     holds them, as a designer save does) }.
 *
 * Returns:
 *   Promise<object>: { rest (the configuration without the keys written : the base's), repositories
 *     (the names written to) }.
 */
export async function writeConfigKeys(doc, sources, opts = {}) {
  const rest = { ...doc };
  const byRepo = new Map();
  for (const s of sources) {
    if (doc[s.key] === undefined) continue;
    delete rest[s.key];
    if (!byRepo.has(s.repository)) byRepo.set(s.repository, []);
    byRepo.get(s.repository).push(s);
  }
  const { default: Repository } = opts.claim ? await import("../models/repository.model.js") : { default: null };
  for (const [repository, list] of byRepo) {
    const prior = opts.claim ? await Repository.claimForWrite(repository) : undefined;
    try {
      for (const s of list) {
        const text = fs.existsSync(s.path) ? fs.readFileSync(s.path, "utf8") : "";
        const next = text.trim() ? updateMapFile(text, { [s.key]: doc[s.key] }) : newMapFile({ [s.key]: doc[s.key] });
        if (next !== text) fs.writeFileSync(s.path, next, "utf8");
        logger.info(`Saved the ${s.key} into ${repository}/${path.basename(s.path)}`);
      }
    } finally {
      if (opts.claim && prior !== undefined) await Repository.releaseWrite(repository, prior).catch((e) => logger.error(`Failed to release write-lock on '${repository}': ${e.message}`));
    }
  }
  return { rest, repositories: [...byRepo.keys()] };
}

/**
 * The base configuration with the keys a save gives that no repository holds : the base's other
 * keys, and the ones the repositories hold, kept as they are.
 *
 * Args:
 *   baseText (string): the base configuration's text.
 *   rest (object): the keys to write (writeConfigKeys' rest).
 *
 * Returns:
 *   string: the base configuration's new text.
 */
export function mergeIntoBase(baseText, rest) {
  let doc;
  try {
    doc = (baseText && String(baseText).trim() ? YAML.parse(baseText) : {}) || {};
  } catch {
    doc = {};
  }
  return YAML.stringify({ ...doc, ...rest });
}
