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
import Errors from "./errors.js";
import mysql from "../models/db.model.js";
import Repo from "../models/repo.model.js";
import _ from "lodash";
import { updateMapFile, newMapFile, editedText } from "./repoObjects/yamlFile.js";

// ===========================================================================
// THE KEYS
// ===========================================================================

// each key : its usage type, its flag, its own file
// ... and what its value is : a list (roles, categories) or a dictionary (constants)
// ... and, for the roles, what is served when its file is not read (broken, or its repository not
// cloned) and was never read on this node (closed) : the local admins' admin role only - never the base configuration's roles, which the
// repository's replaced and may grant more than they do (composeConfig). The default role every
// user has goes with it, without groups and without options (nothing more than the app's defaults) :
// the base schema (schema/base_schema.json) requires it, a set without it fails the validation of
// the whole configuration (every forms list and configuration load refused, the admins' included)
export const CLOSED_ROLES = Object.freeze([
  Object.freeze({ name: "admin", groups: Object.freeze(["local/admins"]) }),
  Object.freeze({ name: "default", groups: Object.freeze([]) }),
]);
export const CONFIG_KEYS = [
  { key: "roles", flag: "use_for_roles", file: "roles.yaml", list: true, closed: CLOSED_ROLES },
  { key: "categories", flag: "use_for_categories", file: "categories.yaml", list: true },
  { key: "constants", flag: "use_for_constants", file: "constants.yaml", list: false },
];

// the one file the three keys were in before (use_for_config) : still read, deprecated
export const LEGACY_FILE = "config.yaml";

// a ytt template : a line starting (after spaces) with #@, the test the settings pages, the
// designer and the health page use
const YTT_DIRECTIVE = /^\s*#@/m;

/**
 * Whether a configuration's text is a ytt template.
 *
 * Args:
 *   text (string): the text.
 *
 * Returns:
 *   boolean: true when a line of it is a ytt directive.
 */
export const isTemplate = (text) => YTT_DIRECTIVE.test(String(text ?? ""));

/**
 * Where each key held by a repository is : its repository, the file it is read from (its own, else
 * config.yaml), whether that file is config.yaml (deprecated), whether it exists yet (a repository
 * with neither file gets its own on the first write). A key no repository holds is not listed : the
 * base configuration gives it. A key whose repository is not cloned (a clone that failed, or is
 * under way) is listed as missing : not read (its value last read on this node is served meanwhile,
 * else the base's, the roles closed : composeConfig), and a save of it refused (assertKeysWritable),
 * never written to the base in its place.
 *
 * Returns:
 *   Promise<object[]>: [{ key, flag, file, repository, path, deprecated, exists, missing }].
 */
export async function keySources() {
  const rows = await mysql.do(`SELECT name, ${CONFIG_KEYS.map((k) => k.flag).join(", ")} FROM AnsibleForms.\`repositories\` ORDER BY name`);
  const out = [];
  for (const k of CONFIG_KEYS) {
    const repo = (rows || []).find((r) => Number(r[k.flag]) && Repo.isValidName(r.name));
    if (!repo) continue;
    const dir = Repo.folderOf(repo.name);
    if (!fs.existsSync(dir)) {
      out.push({ ...k, repository: repo.name, path: path.join(dir, k.file), deprecated: false, exists: false, missing: true });
      continue;
    }
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
 * The lines a repository's pull output says of its keys read from config.yaml, and of its key files
 * that are not read (repositoryKeyProblems).
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<string>: the lines, starting with a newline ; '' for none.
 */
export async function deprecationLines(name) {
  try {
    const problems = (await repositoryKeyProblems(name)).map((p) => `\nNot read: ${p.file}: ${p.reason} - the ${p.key} last read from it (else ${meanwhile(p.key)}) are used until it is fixed`);
    return (await repositoryDeprecations(name)).map((d) => `\nDeprecated: ${d.notice}`).join("") + problems.join("");
  } catch (e) {
    logger.debug(`Could not read the configuration keys of repository '${name}': ${e.message}`);
    return "";
  }
}

// ===========================================================================
// ONE KEY OF A FILE, AS IT IS WRITTEN
// ===========================================================================

// the plain key of a map's pair
const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);

/**
 * A YAML document's text, parsed as a map : an empty text (or one of comments only) is an empty
 * map.
 *
 * Args:
 *   text (string): the text.
 *
 * Returns:
 *   YAML.Document: the document, its contents a map.
 *
 * Raises:
 *   Error: not valid YAML, or not a map.
 */
function mapDocument(text) {
  const doc = YAML.parseDocument(String(text ?? ""));
  if (doc.errors.length) throw new Error(`not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode({});
  if (!YAML.isMap(doc.contents)) throw new Error("not a YAML dictionary");
  return doc;
}

/**
 * A text with one key as another text has it, as written there : its value with its comments, the
 * comment above it ; the rest of the text kept line for line (yamlFile.js editedText). The
 * configuration shown is the base with each repository's key as its file writes it, and a key
 * saved from that text is written to its file with the comments it was given.
 *
 * The text written always reads as the text with that key's value : a value naming an anchor
 * outside it (constants: &admins ... roles: groups: *admins), or an anchor of the text that goes
 * with its old value, is laid as the value it reads as instead (its comments lost) ; the whole
 * text so read, its keys in their order, when its own aliases still name the value it loses.
 *
 * Args:
 *   text (string): the text to change.
 *   key (string): the key.
 *   from (YAML.Document): the document that gives it (mapDocument).
 *
 * Returns:
 *   string: the text, as it is when `from` has no such key.
 *
 * Raises:
 *   Error: the text is not valid YAML, or not a map.
 */
function withKeyOf(text, key, from) {
  const pair = from.contents.items.find((p) => keyOf(p) === key);
  if (!pair) return text;
  const original = String(text ?? "");
  // what the text must read as : its keys, that one's value the one `from` reads as
  const wanted = { ...(mapDocument(original).toJS() || {}), [key]: (from.toJS() || {})[key] };
  const laid = (valueOf) => {
    const doc = mapDocument(original);
    const value = valueOf(doc);
    const there = doc.contents.items.find((p) => keyOf(p) === key);
    if (there) {
      there.value = value;
      // the comment above the key : the one of the text it comes from, when it has one
      if (YAML.isNode(pair.key) && pair.key.commentBefore) {
        if (!YAML.isNode(there.key)) there.key = doc.createNode(there.key);
        there.key.commentBefore = pair.key.commentBefore;
      }
    } else {
      doc.contents.items.push(doc.createPair(YAML.isNode(pair.key) ? pair.key.clone() : key, value));
    }
    return original.trim() ? editedText(doc, original) : doc.toString({ lineWidth: 0 });
  };
  const readsAsWanted = (out) => {
    const doc = YAML.parseDocument(out);
    return !doc.errors.length && _.isEqual(doc.toJS(), wanted);
  };
  // its node as written, then the value it reads as
  const values = [() => (YAML.isNode(pair.value) ? pair.value.clone() : pair.value), (doc) => doc.createNode(wanted[key])];
  for (const valueOf of values) {
    try {
      const out = laid(valueOf);
      if (readsAsWanted(out)) return out;
    } catch {
      // an alias left without its anchor : the next way
    }
  }
  return YAML.stringify(wanted, { lineWidth: 0 });
}

/**
 * Whether a key's value is the one served now : such a key is not written (a file is never
 * rewritten for nothing, a ytt template never turned into its expansion), nor refused.
 *
 * Args:
 *   doc (object): the configuration saved.
 *   key (string): the key.
 *   served (object|undefined): the configuration served now ; none : every key is a change.
 *
 * Returns:
 *   boolean: true when it is unchanged.
 */
const unchanged = (doc, key, served) => served !== undefined && served !== null && _.isEqual(doc?.[key], served?.[key]);

/**
 * A key as a text writes it : the comment above it, the key and its value with their comments ;
 * what tells a key left as it was served in the editor from one whose comments were changed.
 *
 * Args:
 *   doc (YAML.Document): the text's document (mapDocument).
 *   text (string): the text.
 *   key (string): the key.
 *
 * Returns:
 *   string|null: its text ; null when the text has no such key, or its place is not known.
 */
function keyText(doc, text, key) {
  const pair = doc.contents.items.find((p) => keyOf(p) === key);
  if (!pair || !YAML.isNode(pair.key) || !pair.key.range) return null;
  const end = YAML.isNode(pair.value) && pair.value.range ? pair.value.range[2] : pair.key.range[2];
  return `${pair.key.commentBefore ?? ""}\n${String(text).slice(pair.key.range[0], end)}`;
}

// ===========================================================================
// READ : THE KEYS LAID OVER THE BASE CONFIGURATION
// ===========================================================================

// the document of each key file last read whole, by its path and its key (a config.yaml of before
// gives several keys, each read and checked on its own) : a file broken in git afterwards keeps its
// keys as they were (composeConfig) ; and what was last said of a file that is not read
const lastRead = new Map();
const reported = new Map();
const readKey = (source) => `${source.path}\n${source.key}`;
// ... and the document each key was last read as from its repository, whichever of its files gave
// it : a key whose file is gone afterwards (deleted or renamed in git), or whose repository is no
// longer cloned (a reset re-cloning it, a clone failing), keeps it as it was (composeConfig)
const lastHeld = new Map();
const heldKey = (source) => `${source.repository}\n${source.key}`;

/**
 * Forgets every key file read on this node and what was said of them, as a node just started : for
 * the tests, each of which starts from repositories of its own.
 */
export function resetKeyReadsForTests() {
  lastRead.clear();
  lastHeld.clear();
  reported.clear();
}

/**
 * Why a key a repository holds is not there to read : its repository not cloned (a clone failed,
 * or one under way, a reset re-cloning it), or its file gone after it was read on this node
 * (deleted or renamed in git). A repository that never gave its file on
 * this node has none : its key is served from the base configuration until a save writes the file
 * (the base's value is the one in force when the flag is set ; a node cannot tell a file deleted
 * before it started from one never written).
 *
 * Args:
 *   source (object): the key's source (keySources).
 *
 * Returns:
 *   string|null: why, null when its file is there, or never was on this node.
 */
const absentProblem = (source) => {
  if (source.missing) return "its repository is not cloned";
  if (!source.exists && lastHeld.has(heldKey(source))) return "it is no longer in its repository";
  return null;
};

/**
 * What a key whose file is not read, and was never read on this node, is served as : the roles
 * closed (the local admins' admin role only), the others the base configuration's.
 *
 * Args:
 *   key (string): the key.
 *
 * Returns:
 *   string: said in the server log and the pull output.
 */
const meanwhile = (key) => (CONFIG_KEYS.find((k) => k.key === key)?.closed ? "only the admin role of local/admins" : "those of the base configuration");

/**
 * The base configuration with the keys of the repositories laid over it.
 *
 * Args:
 *   baseText (string): the base configuration's text (the database copy, the CONFIG_PATH file).
 *   sources (object[]): the keys' sources (keySources).
 *   render (function): (file) => its text (the file read, or rendered with ytt).
 *
 * Returns:
 *   string: the configuration's text : the base's, each key a repository holds as its file writes
 *     it (its comments, a ytt directive among them, kept), the base's other lines as they are ; the
 *     base as it is when no key comes from a repository. A key file that is not read (not valid
 *     YAML, not a dictionary, its key not a list or a dictionary as it should be), or that is not
 *     there to read (its repository not cloned, its file gone after it was read : absentProblem),
 *     gives its key as it was last read on this node (from that file, else from its repository),
 *     else the base's - the roles closed instead (the local admins' admin role only : a node
 *     started while the file is broken or the repository not cloned never grants the base's roles
 *     the repository replaced, which the base keeps since a save never takes a held key out of it)
 *     : said, never a failure of the whole configuration. The categories and the constants, which
 *     grant nothing, follow the same rule with the base's as their last resort.
 */
export function composeConfig(baseText, sources, render) {
  // the files there, and the keys whose file is not there to read although it should be (absentProblem)
  const laid = sources.filter((s) => s.exists || absentProblem(s));
  if (!laid.length) return baseText;
  let text = String(baseText ?? "");
  for (const s of laid) {
    let from;
    try {
      const absent = absentProblem(s);
      if (absent) throw new Error(absent);
      from = keyDocument(s, render(s.path));
      lastRead.set(readKey(s), from);
      lastHeld.set(heldKey(s), from);
      reported.delete(readKey(s));
    } catch (e) {
      // a file that cannot be read, or is not there to read : its key as it was last read (from
      // that file, else from its repository), else the base's (the roles closed) - never the whole
      // configuration lost with it (said once in the server log, in its pull output and on its page)
      from = (s.exists && lastRead.get(readKey(s))) || lastHeld.get(heldKey(s));
      const closed = CONFIG_KEYS.find((k) => k.key === s.key)?.closed;
      const line = `${s.repository}/${path.basename(s.path)} is not read: ${e.message} - ${from ? `the ${s.key} last read from it are` : `${meanwhile(s.key)} ${closed ? "is" : "are"}`} used until it is fixed`;
      if (reported.get(readKey(s)) !== line) logger.error(line);
      reported.set(readKey(s), line);
      if (!from && closed) from = mapDocument(YAML.stringify({ [s.key]: closed }));
      if (!from) continue;
    }
    text = withKeyOf(text, s.key, from);
  }
  return text;
}

/**
 * A key file's text as the document it gives, checked : valid YAML, a dictionary, every alias
 * resolvable, the key given by its own file (config.yaml of before may leave it out), and the key,
 * when it gives it, of its kind (a list of roles or categories, a dictionary of constants).
 *
 * Args:
 *   source (object): the key's source (keySources).
 *   text (string): the file's text (read, or rendered with ytt).
 *
 * Returns:
 *   YAML.Document: the document (mapDocument).
 *
 * Raises:
 *   Error: why it is not read.
 */
function keyDocument(source, text) {
  const doc = mapDocument(text);
  const value = (doc.toJS() || {})[source.key];
  // a key's own file without its key (a plain map, a typo in the key) : not read - taken as it is,
  // it would serve the base's value without a word ; config.yaml of before may give some keys only
  if (value === undefined && !source.deprecated) throw new Error(`it does not give its ${source.key} (a top-level '${source.key}:' key)`);
  const list = CONFIG_KEYS.find((k) => k.key === source.key)?.list;
  if (value === undefined || value === null || list === undefined) return doc;
  if (list && !Array.isArray(value)) throw new Error(`its ${source.key} must be a list`);
  if (!list && (typeof value !== "object" || Array.isArray(value))) throw new Error(`its ${source.key} must be a dictionary`);
  return doc;
}

/**
 * Why a key file of a repository is not read, as it is now in its working tree : the file as it is
 * written (a ytt template is not checked here, its expansion is when it is loaded).
 *
 * Args:
 *   source (object): the key's source (keySources).
 *
 * Returns:
 *   string|null: why, null when it is read (or not there).
 */
export function keyFileProblem(source) {
  if (!source.exists) return null;
  try {
    const text = fs.readFileSync(source.path, "utf8");
    if (isTemplate(text)) return null;
    keyDocument(source, text);
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}

/**
 * The key files of a repository that are not read (keyFileProblem), or not there to read although
 * its key is served as last read or closed (absentProblem), for its pull output and its page.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<object[]>: [{ key, file, reason }] ; none when each is read.
 */
export async function repositoryKeyProblems(name) {
  const out = [];
  for (const s of (await keySources()).filter((x) => x.repository === name)) {
    const reason = absentProblem(s) || keyFileProblem(s);
    if (reason) out.push({ key: s.key, file: path.basename(s.path), reason });
  }
  return out;
}

// ===========================================================================
// WRITE : EACH KEY BACK TO ITS FILE
// ===========================================================================

/**
 * Refuses a save that changes a key it cannot write : one whose repository has the flag but no
 * working copy (not cloned yet, or its clone failed) - written to the base configuration instead,
 * the save would be lost without a word once the repository is cloned and its file read again -
 * or one whose file is a ytt template (written, the template would become its expansion). A key
 * the save gives as it is served now is never refused : the designer sends every key with each
 * save of a form.
 *
 * Args:
 *   doc (object): the configuration saved (categories, roles, constants ...).
 *   sources (object[]): the keys' sources (keySources).
 *   served (object): the configuration served now ; none : every key the save gives is a change.
 *
 * Raises:
 *   Errors.ConflictError: a key the save changes cannot be written, named with why.
 */
export function assertKeysWritable(doc, sources, served) {
  const changed = (sources || []).filter((s) => doc?.[s.key] !== undefined && !unchanged(doc, s.key, served));
  const refused = [];
  for (const s of changed) {
    if (s.missing) refused.push(`The ${s.key} are held by repository '${s.repository}', which is not cloned: pull it (or fix its clone) before saving them`);
    else if (s.exists && isTemplate(fs.readFileSync(s.path, "utf8"))) refused.push(`The ${s.key} are in ${s.repository}/${path.basename(s.path)}, a ytt template: change them in git`);
    else if (keyFileProblem(s)) refused.push(`The ${s.key} are in ${s.repository}/${path.basename(s.path)}, which is not read (${keyFileProblem(s)}): fix it in git`);
  }
  if (refused.length) throw new Errors.ConflictError(refused.join("; "));
}

/**
 * A configuration without the keys the repositories hold : what goes to the base configuration.
 *
 * Args:
 *   doc (object): the configuration.
 *   sources (object[]): the keys' sources (keySources).
 *
 * Returns:
 *   object: a copy, without those keys.
 */
export const withoutHeldKeys = (doc, sources) => _.omit(doc, sources.map((s) => s.key));

/**
 * Writes the keys a repository holds back to the file each was read from (config.yaml stays
 * config.yaml : only its key changes, the rest of the file kept) or to a new file of its own. A key
 * as it is served now is not written.
 *
 * Args:
 *   doc (object): the configuration (categories, roles, constants ...).
 *   sources (object[]): the keys' sources (keySources).
 *   opts (object): { claim (true : each repository's write claim taken here ; false : the caller
 *     holds them, as a designer save does), served (the configuration served now : a key the same
 *     is not written ; none : every key given is), text (the text the configuration was saved as :
 *     each key written as it has it, its comments with it ; none : as YAML writes its value) }.
 *
 * Returns:
 *   Promise<object>: { rest (the configuration without the keys the repositories hold : the
 *     base's), repositories (the names written to) }.
 *
 * Raises:
 *   Errors.ConflictError: a key that cannot be written (assertKeysWritable).
 */
export async function writeConfigKeys(doc, sources, opts = {}) {
  assertKeysWritable(doc, sources, opts.served);
  const saved = opts.text !== undefined ? mapDocument(opts.text) : null;
  const byRepo = new Map();
  for (const s of sources) {
    if (doc[s.key] === undefined) continue;
    if (unchanged(doc, s.key, opts.served)) continue;
    if (!byRepo.has(s.repository)) byRepo.set(s.repository, []);
    byRepo.get(s.repository).push(s);
  }
  const { default: Repository } = opts.claim ? await import("../models/repository.model.js") : { default: null };
  for (const [repository, list] of byRepo) {
    const prior = opts.claim ? await Repository.claimForWrite(repository) : undefined;
    try {
      for (const s of list) {
        const text = fs.existsSync(s.path) ? fs.readFileSync(s.path, "utf8") : "";
        let next;
        if (saved) next = withKeyOf(text, s.key, saved);
        else next = text.trim() ? updateMapFile(text, { [s.key]: doc[s.key] }) : newMapFile({ [s.key]: doc[s.key] });
        if (next !== text) fs.writeFileSync(s.path, next, "utf8");
        logger.info(`Saved the ${s.key} into ${repository}/${path.basename(s.path)}`);
      }
    } finally {
      if (opts.claim && prior !== undefined) await Repository.releaseWrite(repository, prior).catch((e) => logger.error(`Failed to release write-lock on '${repository}': ${e.message}`));
    }
  }
  return { rest: withoutHeldKeys(doc, sources), repositories: [...byRepo.keys()] };
}

/**
 * The base configuration with the keys a save gives that no repository holds : the base's other
 * keys, its comments and the ones the repositories hold kept as they are. Saved from a text (the
 * configuration's editor, a backup restored), each key is written as that text has it, its comments
 * with it, and a key of the base the text no longer gives is taken out of it.
 *
 * Args:
 *   baseText (string): the base configuration's text.
 *   rest (object): the keys to write (writeConfigKeys' rest).
 *   served (object): the configuration served now : only a key that differs is written ; none :
 *     each one is.
 *   opts (object): { text (the text the configuration was saved as : each key written as it has
 *     it ; none : as YAML writes its value), servedText (the text served now, the one the editor
 *     showed : a key the text gives as it is there, value and text, is left as it is in the base ;
 *     none : each key is written as the text has it), held (string[] : the keys the repositories
 *     hold - a key served now that the save no longer gives, none of these, is taken out of the
 *     base ; none : no key taken out) }.
 *
 * Returns:
 *   string|null: the base configuration's new text ; null when no key changed (nothing to write).
 *
 * Raises:
 *   Errors.ConflictError: a key changed while the base configuration is a ytt template.
 */
export function mergeIntoBase(baseText, rest, served, opts = {}) {
  const base = String(baseText ?? "");
  // the keys taken out : served now, no longer given, none a repository holds
  const known = served !== undefined && served !== null && Array.isArray(opts.held);
  const removed = known ? Object.keys(served).filter((key) => rest[key] === undefined && !opts.held.includes(key)) : [];
  const gone = Object.fromEntries(removed.map((key) => [key, undefined]));
  let saved;
  try {
    saved = opts.text !== undefined && base.trim() && !isTemplate(base) ? mapDocument(opts.text) : null;
  } catch {
    // a text that is not a map of valid YAML : its values, as before
    saved = null;
  }
  if (saved) {
    // the text served (the configuration shown in the editor) : a key the save gives as it is
    // there, value and text, was not touched - its text in the base left as it is, never replaced
    // by the one shown (the values a key file's anchors read as, when its aliases could not be laid
    // as written, lose the base's comments and aliases)
    let shown = null;
    try {
      shown = opts.servedText !== undefined ? mapDocument(opts.servedText) : null;
    } catch {
      shown = null;
    }
    const untouched = (key) => shown !== null && unchanged(rest, key, served) && keyText(saved, opts.text, key) === keyText(shown, opts.servedText, key);
    // each key as the text has it : a text the same as the base's is not written
    let next = base;
    for (const key of Object.keys(rest)) if (!untouched(key)) next = withKeyOf(next, key, saved);
    if (removed.length) next = updateMapFile(next, gone);
    return next === base ? null : next;
  }
  const edits = { ...Object.fromEntries(Object.entries(rest).filter(([key]) => !unchanged(rest, key, served))), ...gone };
  if (served !== undefined && served !== null && !Object.keys(edits).length) return null;
  if (isTemplate(baseText)) {
    throw new Errors.ConflictError(`The base configuration is a ytt template: change ${Object.keys(edits).join(", ")} where it is kept`);
  }
  try {
    return base.trim() ? updateMapFile(baseText, edits) : newMapFile(edits);
  } catch {
    // a base that is not a map of valid YAML : the keys alone, as before
    return YAML.stringify(rest);
  }
}
