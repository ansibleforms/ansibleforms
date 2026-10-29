'use strict';
// The engine of the repository-backed objects : the schedules, the credentials, the runners ...
// (lib/repoObjects/types.js, the object types), each kept in a repository used for it, one
// repository at most per type.
//
// Where a repository keeps them is its files' content (lib/repoObjects/repoFiles.js) : any YAML
// file, any name, any folder, at any depth, whose top-level key is a type's key holds that type -
// a list of objects (credentials: [...]), or one map for a type the app has one of (defaults:).
// A file may hold several types, a type may be spread over many files. An object is its name
// within its type, never its file : each object row keeps the file its entry is in now
// (repository, repo_file), moving an entry to another file only changes that.
//
// Every type is a descriptor (lib/repoObjects/<type>.js : its table, how an entry reads, what it
// names, its secret fields) ; what they share is here, written once :
//   git to app   after each pull (or clone, reset), at the worker's start and when a
//                repository is made one, its entries are read into the table (syncRepository),
//                the repository read once and each type handed its entries : a new name makes an
//                object, a changed entry changes it, a name gone removes its object - unless
//                something uses it, said and refused. An entry that is not valid is refused alone,
//                said in the pull output and the server log, the others still sync. One that names
//                an object that is not there yet WAITS, said in the pull output, and is read again
//                when the type it names is next pulled. Two entries of a name are both refused,
//                naming both places. A name changed in its file, the only one gone from that file
//                and the only one new in it, is a rename : the object keeps its secrets, its id and
//                what uses it.
//   app to git   an object of a repository edited, created or deleted in the app writes or
//                removes its entry in the repository's working tree, under its write claim ; only
//                the changed fields are written (the file's comments, its other keys and entries
//                kept), and the change goes to git with the repository's Push. A new object goes to
//                the first file holding its type's key, else to <key>.yaml at the root.
//   activation   made the type's repository, it is pulled and its entries read in - an entry named
//                as an object of the app takes that object over, git's version wins - and the
//                app's other objects are written to it ; what cannot go stays in the app
//                (preview first, changing nothing : the question asked before it is saved).
//   deactivation no longer used for it, or deleted : pulled once more, read in, and its objects
//                unlinked - they stay in the app as they are, the files in git untouched.
//   secrets      never plain in git : an entry gives them as ${ENV} references (resolved as the
//                config seed resolves them), a plain one is refused ; an app object is written
//                without its secrets, which stay in the database (lib/repoObjects/secrets.js).
//
// What runs (a schedule's state, a runner's socket ...) stays in the database, never in a file.
import fs from "fs";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import logger from "../logger.js";
import Errors from "../errors.js";
import mysql from "../../models/db.model.js";
import CrudModel from "../../models/crud.model.js";
import Repo from "../../models/repo.model.js";
import Repository from "../../models/repository.model.js";
import { fileBeside, fileInRepository, appendListEntries, editListEntry, removeListEntry, editMapEntry, applyEdits, hasListEntry, sortedByOrder } from "./yamlFile.js";
import { scanRepository } from "./repoFiles.js";
import { given } from "./secrets.js";
import { canonicalJson } from "../seedCompare.js";
import { APPLY_ORDER, ONE_ONLY_FLAGS, typeOf, typeOfFlag, flagOn, objectTypesOf } from "./types.js";
import { descriptorOf, BUILT_OBJECT_TYPES } from "./descriptors.js";

// ===========================================================================
// HELPERS
// ===========================================================================

/**
 * A name as the tables compare names : case does not count.
 *
 * Args:
 *   name (string): the name.
 *
 * Returns:
 *   string: the key.
 */
export const nameKey = (name) => String(name || "").trim().toLowerCase();

/**
 * The name an entry declares, read or not : its object's, else the one its text gives (an entry
 * refused, or waiting for what it names) - under the field the type names its objects by
 * (descriptor.nameField : a disclaimer version's is its number), every type alike.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   f (object): the entry as read ({ object, raw, entry }).
 *
 * Returns:
 *   string|null: the name, null when it gives none.
 */
const declaredName = (desc, f) => {
  const asMap = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  const field = desc.nameField || "name";
  const n = f?.object?.name ?? asMap(f?.raw)?.[field] ?? asMap(f?.entry)?.[field];
  return n === undefined || n === null || String(n).trim() === "" ? null : String(n);
};

/**
 * A type's title, for the pull output and the log (Schedules, Credentials).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   string: the title.
 */
const titleOf = (desc) => desc.title || desc.key;

/**
 * How the log and the pull output name what a type holds, one way per mode : a type the app has
 * one of by its label, as a name (General, Defaults, MCP, Chat assistant, Links), a list type by
 * its objects (the credentials). The sentences built on it never make a verb agree with
 * it, so they read the same for both.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   string: what the type holds, as a sentence names it (General, the credentials).
 */
const holdingOf = (desc) => (desc.single ? titleOf(desc) : `the ${titleOf(desc).toLowerCase()}`);

/**
 * Whether a repository's working tree is there.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   boolean: true when it is cloned.
 */
export const cloned = (name) => !!name && Repo.isValidName(name) && fs.existsSync(Repo.folderOf(name));

// how long a write waits for a repository a pull, a push or another write holds, and how often it
// asks again ; then it is refused, nothing saved
export const CLAIM_WAIT = { totalMs: 20000, everyMs: 250 };

// the write claims this flow of the app holds, by repository : a write inside another on the same
// repository (an object saved, then its file written) runs under the claim already taken
const held = new AsyncLocalStorage();

/**
 * Takes a repository's write claim, waiting a while when a pull, a push or another write holds it.
 *
 * Args:
 *   repository (string): the repository.
 *
 * Returns:
 *   Promise<string|null|undefined>: the status to give back on release (claimForWrite's).
 *
 * Raises:
 *   Errors.ConflictError: still busy once the wait is over.
 */
async function claimWaiting(repository) {
  const until = Date.now() + CLAIM_WAIT.totalMs;
  for (;;) {
    try {
      return await Repository.claimForWrite(repository);
    } catch (e) {
      if (Date.now() >= until) {
        throw new Errors.ConflictError(`Repository '${repository}' is busy (a pull or a push is running): nothing was saved, try again in a moment. (${e.message || e})`);
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_WAIT.everyMs));
    }
  }
}

/**
 * Runs a write in a repository's working tree under its write claim (no pull, sync or clone on
 * it meanwhile) ; a repository busy is waited for a while (CLAIM_WAIT), then the write is refused
 * - never dropped. Inside another write on the same repository it runs under that one's claim.
 *
 * Args:
 *   repository (string): the repository.
 *   write (function): the write.
 *
 * Returns:
 *   Promise<any>: what the write returns.
 *
 * Raises:
 *   Errors.ConflictError: the repository is still busy once the wait is over.
 */
export async function withWriteClaim(repository, write) {
  if (held.getStore()?.has(repository)) return write();
  const prior = await claimWaiting(repository);
  try {
    return await asHolding(repository, write);
  } finally {
    if (prior !== undefined) await Repository.releaseWrite(repository, prior).catch((e) => logger.error(`Failed to release write-lock on '${repository}': ${e.message}`));
  }
}

/**
 * Runs a step under a repository's write claim its caller holds already (a clone, a reset, a
 * delete claim it themselves) : the writes inside it (withWriteClaim) run under that claim, never
 * waiting for it.
 *
 * Args:
 *   repository (string): the repository whose claim the caller holds.
 *   run (function): the step.
 *
 * Returns:
 *   Promise<any>: what the step returns.
 */
export function asHolding(repository, run) {
  return held.run(new Set([...(held.getStore() || []), repository]), run);
}

// ===========================================================================
// THE FILES OF A REPOSITORY
// ===========================================================================

/**
 * A repository's files as the types read them (lib/repoObjects/repoFiles.js) : read once, then
 * handed to each type.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   object: the scan (scanRepository's) ; an empty one when it is not cloned.
 */
export const scanOf = (name) => scanRepository(Repo.folderOf(name));

/**
 * A repository's files read whole (scanOf) : a folder of it that cannot be read (no access, a file
 * where a folder was) is never taken for an empty one - its sync would delete every object its
 * files hold.
 *
 * Args:
 *   scan (object): the scan.
 *
 * Returns:
 *   object: the same scan.
 *
 * Raises:
 *   Error: a folder of it cannot be read, named with why.
 */
function wholeScan(scan) {
  if (scan.blocked?.length) throw new Error(scan.blocked.map((b) => `the folder ${b.file} cannot be read: ${b.reason}`).join("; "));
  return scan;
}

/**
 * The absolute path of a file of a repository an object is linked to, checked to be a YAML file
 * inside it that stays in it once its links are followed.
 *
 * Args:
 *   repository (string): the repository.
 *   repoFile (string): the file, relative to the repository (credentials.yaml, team/app.yml).
 *
 * Returns:
 *   string: the path.
 *
 * Raises:
 *   Error: a file outside the repository, a hidden one, or no YAML file.
 */
export function fileOf(repository, repoFile) {
  try {
    return fileInRepository(Repo.folderOf(repository), repoFile);
  } catch {
    throw new Error(`'${repoFile}' is not a YAML file of repository '${repository}'`);
  }
}

/**
 * The file a new object of a type is written to : the first file (by path) that holds the type's
 * key already, with the shape the type keeps there (a list, or a map for a type the app has one
 * of) - else <key>.yaml at the repository's root, made ; a file of that name that is there and does
 * not hold the key (a form, a playbook) is never written to : <key>-2.yaml, <key>-3.yaml ... then.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   scan (object): the repository's files (scanOf) ; read when not given.
 *
 * Returns:
 *   string: the file, relative to the repository.
 */
export function targetFileOf(desc, name, scan = scanOf(name)) {
  const fits = (v) => v === null || v === undefined || (desc.single ? typeof v === "object" && !Array.isArray(v) : Array.isArray(v));
  const holding = scan.holding(desc.key).find((f) => fits(f.value));
  if (holding) return holding.file;
  const dir = Repo.folderOf(name);
  let file = `${desc.key}.yaml`;
  for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${desc.key}-${n}.yaml`;
  return file;
}

/**
 * Refuses a write of a type's objects to a repository while a file of it whose lines seem to give
 * the type's key cannot be read (not valid YAML) : what it holds is not known - a new entry or map
 * written elsewhere would give the type twice once that file is fixed (a name two entries give, a
 * map two files give), refused on every pull after.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   scan (object): the repository's files (scanOf) ; read when not given.
 *
 * Raises:
 *   Errors.ConflictError: such a file, named with why it cannot be read.
 */
export function assertTypeReadable(desc, name, scan = scanOf(name)) {
  const unread = scan.hinted(desc.key);
  if (!unread.length) return;
  const files = unread.map((u) => `${u.file} (${u.errors.join("; ")})`).join(", ");
  throw new Errors.ConflictError(`Repository '${name}' cannot be written for ${holdingOf(desc)}: ${files} seems to give ${desc.key}: but cannot be read - fix it in git and pull, then save again`);
}

/**
 * Writes a file of a repository, its folders made as needed ; removed when its text is empty.
 *
 * Args:
 *   repository (string): the repository.
 *   repoFile (string): the file, relative to the repository.
 *   text (string): its text ; '' removes it.
 */
function writeRepoFile(repository, repoFile, text) {
  const abs = fileOf(repository, repoFile);
  if (text === "") {
    fs.rmSync(abs, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/**
 * A file of a repository's text, '' when it is not there.
 *
 * Args:
 *   repository (string): the repository.
 *   repoFile (string): the file, relative to the repository.
 *
 * Returns:
 *   string: its text.
 */
function readRepoFile(repository, repoFile) {
  const abs = fileOf(repository, repoFile);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
}

/**
 * Adds entries of a type to a file of a repository, at the end of its key's list (the key made at
 * the file's end when it has none, the file made when it is not there).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   repoFile (string): the file, relative to the repository.
 *   entries (object[]): the entries.
 */
export function writeEntries(desc, repository, repoFile, entries) {
  const text = readRepoFile(repository, repoFile);
  const next = appendListEntries(text, desc.key, entries, desc.keyOrder || [], desc.nameField || "name");
  if (next !== text) writeRepoFile(repository, repoFile, next);
}

/**
 * The file an object's entry is in now : the file it is linked to while that file still holds an
 * entry of its name under its type's key, else the first file of the repository that does (a pull
 * moved it meanwhile).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   name (string): the object's name.
 *   hint (string|null): the file it is linked to.
 *
 * Returns:
 *   string|null: the file, relative to the repository ; null when no file holds it.
 */
export function entryFileOf(desc, repository, name, hint = null) {
  const field = desc.nameField || "name";
  try {
    if (hint && hasListEntry(readRepoFile(repository, hint), desc.key, name, field)) return hint;
  } catch {
    // its file outside the repository : looked for among the others
  }
  const found = scanOf(repository)
    .holding(desc.key)
    .find((f) => Array.isArray(f.value) && f.value.some((e) => e && typeof e === "object" && nameKey(e[field]) === nameKey(name)));
  return found?.file || null;
}

/**
 * Edits an object's entry where it is now (entryFileOf) : mutate changes its map, the rest of the
 * file kept ; an entry no file holds any more written whole into the file it is linked to.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   name (string): the object's name before the edit.
 *   hint (string): the file it is linked to.
 *   mutate (function): (doc, map) => changes the entry.
 *   whole (object|null): the entry whole, written when no file holds it ; none : nothing written.
 *
 * Returns:
 *   string|null: the file written, relative to the repository ; null when nothing changed.
 */
export function editEntry(desc, repository, name, hint, mutate, whole = null) {
  const file = entryFileOf(desc, repository, name, hint) || hint;
  const text = readRepoFile(repository, file);
  const next = editListEntry(text, desc.key, name, mutate, { nameField: desc.nameField || "name", whole, keyOrder: desc.keyOrder || [] });
  if (next === text) return null;
  writeRepoFile(repository, file, next);
  return file;
}

/**
 * Removes an object's entry where it is now (entryFileOf) : its type's key goes when its list is
 * left empty, the file when it holds nothing more.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   name (string): the object's name.
 *   hint (string|null): the file it is linked to.
 *
 * Returns:
 *   string|null: the file it was removed from ; null when no file holds it.
 */
export function removeEntry(desc, repository, name, hint = null) {
  const file = entryFileOf(desc, repository, name, hint);
  if (!file) return null;
  const text = readRepoFile(repository, file);
  const out = removeListEntry(text, desc.key, name, desc.nameField || "name");
  if (out.text === text && !out.empty) return null;
  writeRepoFile(repository, file, out.empty ? "" : out.text);
  return file;
}

// ===========================================================================
// THE REPOSITORIES OF A TYPE
// ===========================================================================

/**
 * The repositories used for a type.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   Promise<string[]>: their names, sorted.
 */
export async function repositories(desc) {
  const rows = await mysql.do(`SELECT name FROM AnsibleForms.\`repositories\` WHERE ${desc.flag} ORDER BY name`);
  return (rows || []).map((r) => r.name).filter((n) => Repo.isValidName(n));
}

/**
 * The repository of a type, if there is one (there is one at most).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   Promise<string|null>: its name.
 */
export async function activeRepository(desc) {
  return (await repositories(desc))[0] || null;
}

/**
 * Refuses a second repository for a type one repository holds (the schedules, the credentials
 * ...) : its objects are written back to one.
 *
 * Args:
 *   data (object): the repository as it will be saved (its use_for_* flags, those sent).
 *   name (string): the repository.
 *   before (object|null): the repository as it was (null for a new one).
 *
 * Raises:
 *   Errors.BadRequestError: another repository is used for it, named.
 */
export async function assertUsageAllowed(data, name, before = null) {
  for (const flag of ONE_ONLY_FLAGS) {
    if (!flagOn(data?.[flag]) || flagOn(before?.[flag])) continue;
    const rows = await mysql.do(`SELECT name FROM AnsibleForms.\`repositories\` WHERE ${flag} AND name <> ?`, [name]);
    if (rows?.length) {
      const label = typeOfFlag(flag).label;
      throw new Errors.BadRequestError(`Repository '${rows[0].name}' is already used for ${label}: only one repository can hold the ${label}.`);
    }
  }
}

// ===========================================================================
// GIT TO APP
// ===========================================================================

/**
 * The names a type's objects have, to find what a file names (its references).
 *
 * Args:
 *   key (string): the type (credentials).
 *
 * Returns:
 *   Promise<Set<string>>: their names, as nameKey keys them.
 */
async function namesOf(key) {
  const desc = await descriptorOf(key);
  return new Set((await desc.store.names()).map(nameKey));
}

/**
 * Where an entry is, as the pull output and the log say it : its file and its name
 * (credentials.yaml#git), or its place in its list when it gives no name (credentials.yaml#3).
 *
 * Args:
 *   file (string): the file, relative to the repository.
 *   name (string|null): the name it declares.
 *   index (number): its place in its list, from 0.
 *
 * Returns:
 *   string: the place.
 */
const placeOf = (file, name, index) => `${file}#${name ?? index + 1}`;

/**
 * A type's entries in a repository's files (the scan of a pull), each checked on its own
 * (descriptor.parseEntry), then what each names : one that names an object not there yet waits.
 * What keeps the objects linked to a file whatever its entries say is said too : a file that cannot
 * be read (its lines seeming to give the type's key : refused, said), a link that leads outside
 * the repository, a file whose key holds no list.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   ctx (any): the descriptor's context (descriptor.context), for its parse.
 *   scan (object): the repository's files (scanOf).
 *
 * Returns:
 *   Promise<object>: { entries: [{ place, repoFile, index, entry, errors, waiting, absent, object,
 *     raw, ignored, skipped }], held (Set : the files whose objects are kept as they are), refused
 *     ([{ file, reasons }] : the files refused whole), any (whether a file may give the key at all :
 *     one that does, read or not, or a link never read) }.
 */
async function readEntries(desc, name, ctx, scan) {
  const entries = [];
  const refused = [];
  // the files whose linked objects stay as they are, whatever the entries : not read, or not a list
  const held = new Set([...scan.unreadable.map((u) => u.file), ...scan.refused.map((r) => r.file)]);
  for (const u of scan.hinted(desc.key)) refused.push({ file: u.file, reasons: u.errors });
  const holding = scan.holding(desc.key);
  for (const { file, value } of holding) {
    // the key with nothing after it : no entry
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) {
      held.add(file);
      refused.push({ file, reasons: [`'${desc.key}' must be a list of ${desc.noun} entries`] });
      continue;
    }
    value.forEach((item, index) => {
      const named = item && typeof item === "object" && !Array.isArray(item) ? item[desc.nameField || "name"] : undefined;
      const place = placeOf(file, named === undefined || named === null || String(named).trim() === "" ? null : String(named), index);
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        entries.push({ place, repoFile: file, index, entry: item, errors: ["an entry must be a dictionary"], object: null, absent: false });
        return;
      }
      // an entry its reading throws on : refused alone, the others still read
      try {
        entries.push({ place, repoFile: file, index, entry: item, ...desc.parseEntry(item, ctx) });
      } catch (e) {
        entries.push({ place, repoFile: file, index, entry: item, errors: [`cannot be read: ${e.message || e}`], object: null, absent: false });
      }
    });
  }
  // an entry the type does not import (an announcement already ended : descriptor.notImported) :
  // not refused, said on a line of its own ; its object, if the app has it, goes
  for (const f of entries) {
    const reason = f.object && desc.notImported ? desc.notImported(f.object, name) : null;
    if (reason) {
      f.skipped = { name: f.object.name, reason };
      f.object = null;
    }
  }
  // the references : by name, to an object of the type named, that must be there
  const cache = new Map();
  for (const f of entries) {
    if (!f.object) continue;
    const waiting = await waitingOf(desc, f.object, cache);
    if (waiting.length) {
      f.waiting = waiting;
      f.raw = f.raw ?? f.object;
      f.object = null;
    }
  }
  // whether a file may give the key : one that does, read or not, or a link never read
  return { entries, held, refused, any: holding.length > 0 || refused.length > 0 || scan.refused.length > 0 };
}


/**
 * What an object names that is not there yet (its references, by name) : it waits for them.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   object (object): the object a file gives.
 *   cache (Map): the names of the types read already, by type (one read per sync).
 *
 * Returns:
 *   Promise<string[]>: why it waits, one line per missing object ; none when all are there.
 */
async function waitingOf(desc, object, cache = new Map()) {
  const out = [];
  for (const ref of desc.references || []) {
    const value = object?.[ref.field];
    if (!given(value)) continue;
    if (!cache.has(ref.type)) cache.set(ref.type, await namesOf(ref.type));
    if (cache.get(ref.type).has(nameKey(value))) continue;
    out.push(`waits for the ${typeOf(ref.type)?.label.replace(/s$/, "") || ref.type} '${value}' (${ref.field}), not there yet`);
  }
  return out;
}

/**
 * What an object of a repository declares in its own entry as the working copy has it now, read or
 * not : its raw keys, before any check - the entry of its name in the file it is linked to, else in
 * any file of its repository.
 *
 * Args:
 *   desc (object): the object's type's descriptor.
 *   row (object): the object (its repository, repo_file and name).
 *
 * Returns:
 *   object|null: the keys its entry gives ; null when no file holds it.
 */
function declaredOf(desc, row) {
  try {
    const field = desc.nameField || "name";
    const holding = scanOf(row.repository).holding(desc.key);
    const ordered = [...holding.filter((f) => f.file === row.repo_file), ...holding.filter((f) => f.file !== row.repo_file)];
    for (const f of ordered) {
      const entry = (Array.isArray(f.value) ? f.value : []).find((e) => e && typeof e === "object" && nameKey(e[field]) === nameKey(row.name));
      if (entry) return entry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether an entry is the same object as the one gone from its file, by what tells the type's
 * objects apart besides their name (descriptor.identity : a credential's type, host and user) :
 * each field the same in both, a value given in neither the same too. A type that names no such
 * field : always.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   row (object): the object gone from the file.
 *   object (object): the new entry's object.
 *
 * Returns:
 *   boolean: true when none of those fields changed.
 */
function sameIdentity(desc, row, object) {
  const valueOf = (v) => (given(v) ? String(v).trim() : "");
  return (desc.identity || []).every((field) => valueOf(row?.[field]) === valueOf(object?.[field]));
}

/**
 * Whether every object that uses an object by its name follows its rename : each one is an object
 * of a repository, of a type that names this one (descriptor.references), whose own entry - as the
 * working copy has it now : the same commit - names it by its new name. The rename is then taken,
 * and each user follows when its entry is read in : at once in the same repository (the types read
 * in their order), else when the types that name it are read again (retryDependents). One that is
 * no repository object, a type the app has one of, or an entry that still names the old name : not.
 *
 * Args:
 *   desc (object): the renamed object's type's descriptor.
 *   row (object): the object, by its name now.
 *   to (string): its new name.
 *   users (string[]): what uses it (descriptor.usersOf), one per record that names it.
 *
 * Returns:
 *   Promise<boolean>: whether every user follows it.
 */
async function followsRename(desc, row, to, users) {
  let following = 0;
  for (const key of dependentsOf([desc.key])) {
    const other = await descriptorOf(key);
    if (other.single) continue;
    const fields = (other.references || []).filter((r) => r.type === desc.key).map((r) => r.field);
    for (const user of (await other.store.rows()) || []) {
      for (const field of fields) {
        if (nameKey(user[field]) !== nameKey(row.name)) continue;
        if (!user.repository || !user.repo_file || nameKey(declaredOf(other, user)?.[field]) !== nameKey(to)) return false;
        following++;
      }
    }
  }
  // as many as use it : none left that is not a repository object following it
  return following === users.length;
}

/**
 * Reads a type's entries of a repository into its table, an object found by its name within its
 * type, never by its file : a new name makes an object, a changed entry changes it, an entry moved
 * to another file links its object to that file, a name gone (or an entry saying state: absent)
 * removes its object - unless something uses it (descriptor.usersOf) or it can never be deleted
 * (descriptor.undeletable), then it is kept and the refusal said.
 *
 * Renames : a name changed in git is a delete and a new object, except when, in one pull, exactly
 * one object of the type linked to a file is gone from it and exactly one new name of the type
 * appeared in that same file, what tells it apart besides its name unchanged (descriptor.identity :
 * a credential's type, host and user) : that is its rename - the object keeps its secrets kept in
 * the database, its state, its id and what uses it (a rename refused while something uses it,
 * unless each user follows it in the same commit : followsRename ; never for a type whose objects
 * keep their name : descriptor.renameRefused). A rename is said in the pull output.
 *
 * A refused entry - not valid, a name two entries give, a name another object has - changes
 * nothing : an object of its name stays as it was, a new one is not made ; an entry that names an
 * object not there yet waits, the same way. The objects linked to a file that cannot be read (or a
 * link leading outside the repository, or a key that holds no list) stay as they are, as do those
 * of a file whose refused entries may be them (an entry refused without a name, or with a name no
 * object has) ; while a file whose lines seem to give the type's key cannot be read, no object whose
 * entry is gone is deleted (it may have moved into that file), each one kept said. Where an entry gives no secret, the database's stays ; a field it no longer declares
 * takes the value a new object gets (descriptor.store.removed).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { context (the descriptor's context, read when not given), scan (the
 *     repository's files, read once by the pull for every type : scanOf ; read when not given),
 *     reset (true : the working tree was just cloned where there was none - a reset, or a tree that
 *     was gone : an entry the app wrote may never have been pushed - an object whose name no entry
 *     gives is unlinked and kept in the app, never deleted) }.
 *
 * Returns:
 *   Promise<object>: { created, updated, deleted, unchanged (counts), matched: [name], refused:
 *     [{ file, reasons }], waiting: [{ file, reasons }], ignored: [{ file, keys }], secretsKept:
 *     [name], skipped: [{ file, name, reason }] (entries the type does not import :
 *     descriptor.notImported), notes, unread, unlinked: [name] (the objects a reset unlinked, their
 *     entries not in the repository as cloned again) } ; each file an entry's place
 *     (credentials.yaml#git).
 */
export async function syncRepository(desc, name, opts = {}) {
  // a type the app has one of : its own mode
  if (desc.single) return syncSingle(desc, name, opts);
  const summary = newSummary();
  const ctx = opts.context !== undefined ? opts.context : await desc.context?.();
  const scan = wholeScan(opts.scan || scanOf(name));
  // step 1 : the entries, read and checked on their own, and what they name
  const { entries, held, refused, any } = await readEntries(desc, name, ctx, scan);
  summary.refused.push(...refused);
  // no file of the repository gives the type's key at all, for a type whose objects are never
  // deleted for that (the repositories : each would lose its working copy) : kept in the app, unlinked
  if (!any && desc.noKeyUnlinks) {
    const unlinked = await desc.store.unlink(name);
    if (unlinked) CrudModel.changed(desc.model);
    summary.notes.push(`No file of the repository gives ${desc.key}: - the app keeps ${holdingOf(desc)} as it has them${unlinked ? `, ${unlinked} no longer linked to it` : ""}`);
    return summary;
  }
  // step 2 : the objects there are : this repository's by name, the names of the others
  const rows = await desc.store.rows();
  const own = new Map();
  const taken = new Map(); // name key -> where it is taken
  // the app's own objects : an entry of that name takes it over, git's version wins
  const adoptable = new Map();
  for (const row of rows || []) {
    const kind = desc.store.classify(row, name);
    if (kind === "own") own.set(nameKey(row.name), row);
    else if (kind === "adoptable") adoptable.set(nameKey(row.name), row);
    else taken.set(nameKey(row.name), kind);
  }
  // step 3 : a name two entries give (in one file or two) : each refused, naming the others - the
  // object of that name, if any, stays as it was
  const byName = new Map();
  for (const f of entries) {
    const n = !f.absent ? declaredName(desc, f) : null;
    if (n !== null) byName.set(nameKey(n), [...(byName.get(nameKey(n)) || []), f]);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    for (const f of list) {
      const others = list.filter((o) => o !== f).map((o) => `${o.repoFile} (entry ${o.index + 1})`);
      f.errors = [`the name '${declaredName(desc, f)}' is given twice: here (${f.repoFile}, entry ${f.index + 1}) and in ${others.join(", ")} - one entry per ${desc.noun}`];
      f.object = null;
      f.waiting = undefined;
      f.duplicate = true;
    }
  }
  // step 4 : each entry read in finds its object by its name
  const matched = new Set();
  for (const f of entries) {
    const row = f.object && own.get(nameKey(f.object.name));
    if (!row || matched.has(row.id)) continue;
    f.row = row;
    matched.add(row.id);
  }
  // step 5 : the objects kept as they are : their file not read (whole), their entry refused or
  // waiting, or their file holding a refused entry that may be them (no name, or a name no object
  // of the repository has : a rename that is refused)
  const kept = new Set();
  const keep = (row, why) => {
    kept.add(row.id);
    taken.set(nameKey(row.name), why);
  };
  const unmatchedRefused = new Set();
  for (const f of entries) {
    if (f.object || f.absent || f.skipped) continue;
    const n = declaredName(desc, f);
    const row = n !== null ? own.get(nameKey(n)) : null;
    if (row && !matched.has(row.id)) keep(row, `${f.place} (${f.waiting ? "waiting" : "refused"}, kept as it was)`);
    else if (!row) unmatchedRefused.add(f.repoFile);
  }
  // a file that cannot be read whose lines seem to give the type's key : any object whose entry is
  // gone may have moved into it - kept, said, until it can be read
  const unread = scan.hinted(desc.key).map((u) => u.file);
  const keptForUnread = [];
  for (const row of own.values()) {
    if (matched.has(row.id) || kept.has(row.id)) continue;
    if (held.has(row.repo_file)) keep(row, `${row.repo_file} (not read, kept as it was)`);
    else if (unmatchedRefused.has(row.repo_file)) keep(row, `${row.repo_file} (an entry of it refused, kept as it was)`);
    else if (unread.length) {
      keep(row, `${row.repo_file} (its entry gone, kept as it was while ${unread.join(", ")} cannot be read)`);
      keptForUnread.push(row.name);
    }
  }
  if (keptForUnread.length) {
    summary.notes.push(`Kept, their entries gone while ${unread.join(", ")} cannot be read (they may be there): ${keptForUnread.join(", ")}`);
  }
  // step 6 : a rename in a file : the one object of the type gone from a file, the one new name in
  // that same file, what tells it apart besides its name unchanged (sameIdentity)
  const goneIn = new Map();
  for (const row of own.values()) {
    if (matched.has(row.id) || kept.has(row.id)) continue;
    goneIn.set(row.repo_file, [...(goneIn.get(row.repo_file) || []), row]);
  }
  const newIn = new Map();
  for (const f of entries) {
    if (!f.object || f.row) continue;
    const key = nameKey(f.object.name);
    if (own.has(key) || adoptable.has(key) || taken.has(key)) continue;
    newIn.set(f.repoFile, [...(newIn.get(f.repoFile) || []), f]);
  }
  for (const [file, gone] of goneIn) {
    const fresh = newIn.get(file) || [];
    if (gone.length !== 1 || fresh.length !== 1) continue;
    const [row] = gone;
    const [f] = fresh;
    // another object (its type, its host ... changed too) : the one gone deleted, a new one made
    if (!sameIdentity(desc, row, f.object)) continue;
    // a type whose objects keep their name (a disclaimer version its number) : refused, kept
    if (desc.renameRefused) {
      f.errors = [`it renames '${row.name}' to '${f.object.name}', but ${desc.renameRefused}`];
    } else {
      const users = desc.usersOf ? await desc.usersOf(row) : [];
      // nothing uses it, or every user follows it in the same commit (followsRename) : taken
      if (!users.length || (await followsRename(desc, row, f.object.name, users))) {
        f.row = row;
        f.renamed = row.name;
        matched.add(row.id);
        logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${row.name}' is renamed '${f.object.name}' in ${name}/${file}`);
        continue;
      }
      f.errors = [
        `it renames '${row.name}' to '${f.object.name}', but ${users.join(", ")} still uses '${row.name}': kept as it was until nothing uses it - name '${f.object.name}' in the entries of what uses it in the same commit, or change what uses it in the app first`,
      ];
    }
    f.object = null;
    keep(row, `${f.place} (refused, kept as it was)`);
  }
  // step 7 : the new names : one another object has is refused ; one of the app's own objects is
  // taken over by its entry
  for (const f of entries) {
    if (!f.object || f.row) continue;
    const key = nameKey(f.object.name);
    if (!taken.has(key) && adoptable.has(key)) {
      f.adopt = adoptable.get(key);
      adoptable.delete(key);
      continue;
    }
    if (taken.has(key)) {
      f.errors = [`the name '${f.object.name}' is the name of another ${desc.noun}: ${taken.get(key)}`];
      f.object = null;
      continue;
    }
    taken.set(key, `${name}/${f.place}`);
  }
  // step 8 : a flag one object at most has (the default runner of a type, the active mail channel
  // ...) that several entries give : each write would take it off the others, the next pull giving
  // it back, for ever - applied from none of them, each object keeping what it has, said
  oneOnlyClashes(desc, entries, summary, name);
  // step 9 : the objects whose entry is gone (or absent) go first - not one something uses - then
  // the changed, then the new
  let relinked = 0;
  for (const row of own.values()) {
    if (matched.has(row.id) || kept.has(row.id)) continue;
    const where = `${row.repo_file}#${row.name}`;
    // one that can never be deleted (the main LDAP directory) : kept, said
    const never = desc.undeletable ? await desc.undeletable(row) : null;
    if (never) {
      summary.refused.push({ file: where, reasons: [`its entry is gone, but ${never}: kept, and still linked to it`] });
      logger.warning(`Kept ${desc.noun} '${row.name}' of ${name}/${row.repo_file}: its entry is gone, but ${never}`);
      continue;
    }
    const users = desc.usersOf ? await desc.usersOf(row) : [];
    if (users.length) {
      summary.refused.push({ file: where, reasons: [`its entry is gone, but ${users.join(", ")} still uses '${row.name}': kept until nothing uses it`] });
      logger.warning(`Kept ${desc.noun} '${row.name}' of ${name}/${row.repo_file}: its entry is gone, but ${users.join(", ")} still uses it`);
      continue;
    }
    // what its repository says of it still : an entry saying state: absent, or one not imported
    const said = entries.find((f) => (f.absent || f.skipped) && nameKey(declaredName(desc, f) ?? f.skipped?.name) === nameKey(row.name));
    try {
      // cloned again (a reset, a tree that was gone) : an entry not in the repository may never
      // have been pushed (written by the app) - its object stays in the app, unlinked, never
      // deleted with the secrets it keeps
      if (opts.reset && !said) {
        await desc.store.link(row.id, null, null);
        relinked++;
        summary.unlinked.push(row.name);
        summary.notes.push(`${where}: not in the repository as cloned again (never pushed?): '${row.name}' kept in the app, no longer linked to it`);
        logger.notice(`Kept ${desc.noun} '${row.name}' in the app, unlinked: its entry in ${name}/${row.repo_file} is not in the repository as cloned again`);
        continue;
      }
      await desc.store.remove(row);
    } catch (e) {
      // not removed (its model refused, the database busy) : kept, said, the others go on
      summary.refused.push({ file: where, reasons: [`its entry is gone, but '${row.name}' could not be removed: ${e.message || e}`] });
      logger.warning(`Could not remove ${desc.noun} '${row.name}' of ${name}/${row.repo_file}: ${e.message || e}`);
      continue;
    }
    logger.notice(`Removed ${desc.noun} '${row.name}': ${said?.skipped ? `its entry in ${name}/${said.repoFile} says it is ${said.skipped.reason}` : `its entry in ${name}/${row.repo_file} is gone`}`);
    summary.deleted++;
  }
  for (const f of entries) {
    if (!f.object) {
      // the name a refused or waiting entry declares : no object of the app is written beside it
      // under that name (activateList) - it follows that entry once it is read in
      if (!f.skipped && !f.absent && declaredName(desc, f)) summary.unread.push({ name: declaredName(desc, f), file: f.place });
      if (f.skipped) {
        summary.skipped.push({ file: f.place, ...f.skipped });
      } else if (f.waiting) {
        summary.waiting.push({ file: f.place, reasons: f.waiting });
        logger.warning(`Waiting ${desc.noun} entry ${name}/${f.place}: ${f.waiting.join("; ")}`);
      } else if (f.errors?.length) {
        summary.refused.push({ file: f.place, reasons: f.errors });
        logger.warning(`Refused ${desc.noun} entry ${name}/${f.place}: ${f.errors.join("; ")}`);
      }
      continue;
    }
    if (f.ignored?.length) summary.ignored.push({ file: f.place, keys: f.ignored });
    // what the entry may not set taken out, each said (a usage another repository holds)
    if (desc.adjust) {
      const adjusted = await desc.adjust(f.object, name);
      f.object = adjusted.object;
      summary.notes.push(...adjusted.notes.map((n) => `${f.place}: ${n}`));
    }
    const row = f.row;
    // a secret the entry does not give : the database's stays, said in the pull output
    const before = f.adopt || row;
    if (before && (desc.secrets || []).some((s) => !given(f.raw?.[s]) && given(before[s]))) summary.secretsKept.push(f.object.name);
    try {
      // a field the entry no longer declares : out of the app too (the value a new object gets)
      const removed = before && desc.store.removed ? await desc.store.removed(before, f.object) : {};
      if (Object.keys(removed).length) f.object = { ...f.object, ...removed };
      if (f.adopt) {
        // git's version replaces the app's definition ; what runs it stays
        await desc.store.adopt(f.adopt, f.object, name, f.repoFile);
        summary.matched.push(f.object.name);
        logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${f.object.name}' of the app now follows ${name}/${f.place}: git's version replaced it`);
        continue;
      }
      if (row) {
        // moved to another file : linked to it, nothing else
        if (row.repo_file !== f.repoFile) {
          await desc.store.link(row.id, name, f.repoFile);
          relinked++;
          logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${f.object.name}' follows its entry, moved in git: ${name}/${row.repo_file} is now ${name}/${f.repoFile}`);
        }
        if (!Object.keys(removed).length && !f.renamed && !desc.store.changed(row, f.object)) {
          summary.unchanged++;
          continue;
        }
        await desc.store.update(row, f.object);
        summary.updated++;
        if (f.renamed) summary.notes.push(`Renamed ${f.renamed} to ${f.object.name}${desc.secrets?.length ? " (its secrets kept)" : ""}`);
      } else {
        await desc.store.insert(f.object, name, f.repoFile);
        summary.created++;
      }
    } catch (e) {
      // two entries swapping their names in one pull, a value the model refuses, or an object made
      // meanwhile : said, the others go on ; its name not read in, as a refused entry's (an
      // activation keeps the app's object of that name, never a second entry beside it)
      summary.unread.push({ name: f.object.name, file: f.place });
      summary.refused.push({ file: f.place, reasons: [`not saved: ${e.message || e}`] });
      logger.warning(`Could not save the ${desc.noun} of ${name}/${f.place}: ${e.message || e}`);
    }
  }
  if (summary.created || summary.updated || summary.deleted || summary.matched.length || relinked) CrudModel.changed(desc.model);
  logger.info(
    `${titleOf(desc)} of repository '${name}': ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.refused.length} refused${summary.waiting.length ? `, ${summary.waiting.length} waiting` : ""}`,
  );
  return summary;
}

/**
 * The flags one object at most has (descriptor.oneOnly : the default runner of a type, the active
 * mail channel, the provider of a type used for sign-in, the disclaimer version in force) that
 * several entries of a pull give, as the config seed refuses them (lib/seed-schema.js
 * assertSingletonFlags) : applied from none of them, each object keeping the value it has (a new
 * one without it), the one holding it now keeping it even when its entry takes it off in the same
 * pull (never none left with it), the rest of each entry applied - the pull changes nothing of that
 * flag until one entry only gives it, and the next pull is the same. Said in the pull output, with
 * the one that keeps it.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   entries (object[]): the entries read (readEntries), their objects changed in place ; each with
 *     its object (row) or the app's it takes over (adopt).
 *   summary (object): the sync's summary, its notes added to.
 *   name (string): the repository.
 *
 * Returns:
 *   void
 */
function oneOnlyClashes(desc, entries, summary, name) {
  const on = (v) => v === true || (v !== false && v !== null && v !== undefined && !!Number(v));
  for (const rule of desc.oneOnly || []) {
    const groups = new Map();
    for (const f of entries) {
      if (!f.object || !on(f.object[rule.field]) || (rule.when && !rule.when(f.object))) continue;
      const scope = rule.by ? String(f.object[rule.by] ?? "") : "";
      groups.set(scope, [...(groups.get(scope) || []), f]);
    }
    for (const [scope, list] of groups) {
      if (list.length < 2) continue;
      for (const f of list) {
        const before = f.adopt || f.row;
        f.object = { ...f.object, [rule.field]: before ? on(before[rule.field]) : false };
      }
      // the one holding it now whose entry takes it off in the same pull : it keeps it too - the
      // flag changes not at all until one entry only gives it, never left on none of them
      const keeps = entries.filter((f) => {
        if (!f.object || list.includes(f) || on(f.object[rule.field]) || (rule.when && !rule.when(f.object))) return false;
        if (rule.by && String(f.object[rule.by] ?? "") !== scope) return false;
        const before = f.adopt || f.row;
        return !!before && on(before[rule.field]);
      });
      for (const f of keeps) f.object = { ...f.object, [rule.field]: true };
      const what = `${rule.label}${rule.by ? ` (${rule.by} ${scope})` : ""}`;
      const kept = keeps.length ? `${keeps.map((f) => f.place).join(", ")} keeps it until then` : `the ${desc.noun} holding it now, if any, keeps it until then`;
      const line = `${rule.field} not applied: ${list.map((f) => f.place).join(", ")} each say it, one ${desc.noun} at most is ${what} - say it in one entry only (${kept})`;
      summary.notes.push(line);
      logger.warning(`${titleOf(desc)} of repository '${name}': ${line}`);
    }
  }
}

/**
 * An empty sync summary.
 *
 * Returns:
 *   object: { created, updated, deleted, unchanged, matched, refused, waiting, ignored,
 *     secretsKept, notes, unread (the names refused or waiting entries declare : [{ name, file }]),
 *     unlinked (the objects a reset unlinked : [name]) }.
 */
function newSummary() {
  return { created: 0, updated: 0, deleted: 0, unchanged: 0, matched: [], refused: [], waiting: [], ignored: [], secretsKept: [], skipped: [], notes: [], unread: [], unlinked: [] };
}

/**
 * What a sync did, as lines for the repository's pull output : the counts, each refused or waiting
 * entry with why, the fields an entry gives that the app keeps but does not use, and the objects
 * whose secrets stay the database's.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   summary (object): syncRepository's result.
 *
 * Returns:
 *   string: the lines, starting with a newline.
 */
export function summaryText(desc, summary) {
  const waiting = summary.waiting || [];
  const lines = [
    `${titleOf(desc)}: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.unchanged} unchanged, ${summary.refused.length} refused${waiting.length ? `, ${waiting.length} waiting` : ""}`,
  ];
  if (summary.matched.length) lines.push(`Replaced by the file of the same name: ${summary.matched.join(", ")}`);
  lines.push(...detailLines(summary));
  return "\n" + lines.join("\n");
}

/**
 * What a sync or an activation says besides its counts, a line each : the refused and the waiting
 * files with why, the fields a file gives that the app keeps but does not use, the objects whose
 * secrets stay the database's, the files not imported, and the notes (a usage an entry may not
 * set, an object kept in the app).
 *
 * Args:
 *   summary (object): { refused, waiting, ignored, secretsKept, skipped, notes } (syncRepository's,
 *     or activate's report).
 *
 * Returns:
 *   string[]: the lines.
 */
function detailLines(summary) {
  const lines = [
    ...(summary.refused || []).map((r) => `Refused ${r.file}: ${r.reasons.join("; ")}`),
    ...(summary.waiting || []).map((w) => `Waiting ${w.file}: ${w.reasons.join("; ")} (read again when it is pulled)`),
    ...(summary.ignored || []).map((i) => `${i.file}: kept in the file, not used by AnsibleForms: ${i.keys.join(", ")}`),
  ];
  if (summary.secretsKept?.length) lines.push(`Not in git, their secrets kept from the database: ${summary.secretsKept.join(", ")}`);
  // the files not imported, by why : an information, not a refusal
  const skipped = summary.skipped || [];
  for (const reason of [...new Set(skipped.map((k) => k.reason))]) {
    lines.push(`Not imported, ${reason}: ${skipped.filter((k) => k.reason === reason).map((k) => `${k.name} (${k.file})`).join(", ")}`);
  }
  lines.push(...(summary.notes || []));
  return lines;
}

/**
 * What an activation says besides its counts (detailLines), without the lines the pull before it
 * said already in the same pull output (report.saidByPull : that pull's own read of the same
 * files, taken by the activation) : each refusal, note or waiting file said once.
 *
 * Args:
 *   report (object): activate's report.
 *
 * Returns:
 *   string[]: the lines.
 */
function activationDetailLines(report) {
  const said = new Set(report.saidByPull || []);
  return detailLines(report).filter((line) => !said.has(line));
}

// what the last pull (or clone) of a repository read in of each type it holds, by type and
// repository : an activation that follows it says what that pull took (git winning on a name), its
// own read finding nothing left to take. Taken by the activation, dropped when the type is let go.
// Kept in this node's memory only : each one stamped with the working tree it read (treeStamp,
// on the volume every node shares), and taken only while the tree is still that one - a pull of
// another node since, or a deactivation there, leaves a summary that no longer says the truth.
const synced = new Map();

/**
 * The commit a working tree is on, read from its .git folder (no git process) : its HEAD, the
 * branch it names resolved from its ref file or packed-refs.
 *
 * Args:
 *   dir (string): the working tree.
 *
 * Returns:
 *   string: the commit (or what HEAD says), '' when it cannot be read.
 */
function headOf(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    const ref = head.match(/^ref:\s*(\S+)$/)?.[1];
    if (!ref) return head;
    const loose = path.join(dir, ".git", ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
    const packed = fs.existsSync(path.join(dir, ".git", "packed-refs")) ? fs.readFileSync(path.join(dir, ".git", "packed-refs"), "utf8") : "";
    return packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.split(" ")[0] || head;
  } catch {
    return "";
  }
}

/**
 * What a repository's working tree holds now, as one text : its commit and each of its YAML files
 * with its size and time (the scan's stamp). Two reads of the tree give the same stamp only when no
 * pull (of any node : the volume is shared) changed it between them.
 *
 * Args:
 *   name (string): the repository.
 *   scan (object): its files as read (scanOf) ; read when not given.
 *
 * Returns:
 *   string|null: the stamp, null when the tree cannot be read (never the same as another).
 */
function treeStamp(name, scan = null) {
  try {
    const dir = Repo.folderOf(name);
    return [headOf(dir), (scan || scanOf(name)).stamp].join("\n");
  } catch {
    return null;
  }
}

/**
 * The key of a type of a repository in what was read in (synced).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   string: the key.
 */
const syncedKey = (desc, name) => `${desc.key}\u0000${name}`;

/**
 * What the last pull of a repository read in of a type, taken : said once, by the activation that
 * follows it - while the working tree is still the one that pull read (treeStamp) ; changed since
 * (another node pulled, the files moved on), it is no longer what the activation found.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   object|null: syncRepository's summary, null when none was kept.
 */
function takeSynced(desc, name) {
  const kept = synced.get(syncedKey(desc, name)) || null;
  synced.delete(syncedKey(desc, name));
  if (!kept) return null;
  const now = treeStamp(name);
  return now !== null && now === kept.stamp ? kept.summary : null;
}

/**
 * Syncs one type of a repository, its lines for the pull output ; a failure is said there too,
 * never thrown.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): syncRepository's ({ reset, scan }).
 *
 * Returns:
 *   Promise<string>: the lines.
 */
export async function syncText(desc, name, opts = {}) {
  try {
    const summary = await syncRepository(desc, name, opts);
    synced.set(syncedKey(desc, name), { summary, stamp: treeStamp(name) });
    return summaryText(desc, summary);
  } catch (e) {
    logger.error(`Could not synchronize ${holdingOf(desc)} of repository '${name}': ${e.message || e}`);
    return `\n${titleOf(desc)} not synchronized: ${e.message || e}`;
  }
}

/**
 * The object types that name one of the types given : read again once those are pulled (their
 * waiting files may find what they name now), in APPLY_ORDER.
 *
 * Args:
 *   keys (string[]): the types just synced.
 *
 * Returns:
 *   string[]: the types that name one of them.
 */
function dependentsOf(keys) {
  return APPLY_ORDER.filter((key) => typeOf(key)?.objects && (typeOf(key).references || []).some((r) => keys.includes(r)));
}

/**
 * Reads again the types that name the ones just synced, in their own repositories (another
 * repository : under its claim ; one busy is read on its own next pull). Their waiting files
 * find what they name now.
 *
 * Args:
 *   keys (string[]): the types just synced.
 *   except (string): the repository just synced (its own types were read in order already).
 *
 * Returns:
 *   Promise<string>: the lines for the pull output.
 */
async function retryDependents(keys, except) {
  let out = "";
  for (const key of dependentsOf(keys)) {
    const desc = await descriptorOf(key);
    for (const repo of await repositories(desc)) {
      if (repo === except || !cloned(repo)) continue;
      let prior;
      try {
        prior = await Repository.claimForWrite(repo);
      } catch (e) {
        out += `\n${titleOf(desc)} of repository '${repo}' not read again now (${e.message}): its next pull reads them`;
        continue;
      }
      try {
        out += `\n${titleOf(desc)} of repository '${repo}', read again:${(await syncText(desc, repo)).replace(/^\n[^:]+:/, "")}`;
      } finally {
        await Repository.releaseWrite(repo, prior).catch((e) => logger.error(`Failed to release write-lock on '${repo}': ${e.message}`));
      }
    }
  }
  return out;
}

/**
 * A repository's usages as saved now, read again once git is done : a usage turned off while a
 * long pull ran had its objects let go meanwhile (deactivate), and the row the pull read at its
 * start would take them back, linked to a repository that no longer holds them.
 *
 * Args:
 *   name (string): the repository.
 *   repo (object): its row as read before git ran (kept when it cannot be read again).
 *
 * Returns:
 *   Promise<object>: its row now.
 */
async function usagesNow(name, repo) {
  try {
    return (await mysql.do("SELECT * FROM AnsibleForms.`repositories` WHERE name = ?", [name]))?.[0] || repo;
  } catch (e) {
    logger.warning(`The usages of repository '${name}' could not be read again, those read before its pull are used: ${e.message || e}`);
    return repo;
  }
}

// ===========================================================================
// THE CLONES OF NEW REPOSITORIES
// ===========================================================================

// how long a pull waits for the repositories it made to be cloned, before the types read after
// them : a clone that takes longer (or hangs) never holds the pull, its types are read again once
// it is done
export const CLONE_WAIT = { totalMs: 60000 };

// the clones of new repositories running in the background (models/repository.model.js create),
// by repository : the clone and the activation of its usages
const clones = new Map();

/**
 * Records the background clone of a repository just made, until it is done.
 *
 * Args:
 *   name (string): the repository.
 *   done (Promise): its clone and the activation of its usages.
 */
export function trackClone(name, done) {
  clones.set(name, done);
  const forget = () => {
    if (clones.get(name) === done) clones.delete(name);
  };
  done.then(forget, forget);
}

/**
 * Waits for the background clones running (CLONE_WAIT at most), then the types given are read :
 * the repositories its repositories: entries made are there for them. A clone still running is said,
 * and the types read again in their repositories once it is done.
 *
 * Args:
 *   keys (string[]): the types read after the repositories.
 *
 * Returns:
 *   Promise<string>: the lines for the pull output ; none when every clone is done.
 */
async function afterClones(keys) {
  if (!clones.size) return "";
  const running = [...clones.entries()];
  const settled = new Set();
  const all = Promise.all(running.map(([n, done]) => done.then(() => settled.add(n), () => settled.add(n))));
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(resolve, CLONE_WAIT.totalMs)));
  await Promise.race([all, timeout]);
  clearTimeout(timer);
  const late = running.map(([n]) => n).filter((n) => !settled.has(n));
  if (!late.length) return "";
  // read again once they are cloned, each type in its repositories under their claims
  all
    .then(async () => {
      for (const key of keys) await syncAllOf(await descriptorOf(key));
    })
    .catch((e) => logger.error(`The objects read after repositories ${late.join(", ")} were cloned could not be read again: ${e.message || e}`));
  return `\nRepositories ${late.map((n) => `'${n}'`).join(", ")} still cloning after ${Math.round(CLONE_WAIT.totalMs / 1000)} s: what names their content is read again once they are cloned`;
}

/**
 * Syncs every object type of a repository after git changed its working tree (a pull, a clone,
 * a reset), in APPLY_ORDER, then reads again the types that name them in other repositories :
 * what it did, for its pull output. The repository's files are read once, each type handed its
 * entries ; a link of it leading outside is said once. Its first clone takes the app's objects of
 * each type instead (activation : a repository not cloned when its usage was turned on takes them
 * once it is). A failure is said there too, never thrown : the git operation itself worked.
 *
 * Args:
 *   name (string): the repository.
 *   repo (object): its row (its use_for_* flags).
 *   opts (object): { activate (true : its first clone, its claim held by the caller), reset
 *     (true : cloned where there was no working tree, a reset too : syncRepository's) }.
 *
 * Returns:
 *   Promise<string>: the lines for the pull output.
 */
export async function afterGit(name, repo, opts = {}) {
  const now = await usagesNow(name, repo);
  const keys = objectTypesOf(now);
  let out = "";
  if (!keys.length) return out;
  // the repository's files, read once for every type it holds
  let scan = scanOf(name);
  for (const r of scan.refused) out += `\nRefused ${r.file}: ${r.reason}`;
  out += notHeldHint(scan, now);
  for (const [i, key] of keys.entries()) {
    const desc = await descriptorOf(key);
    out += opts.activate ? await activatedText(desc, name, { reset: opts.reset }) : await syncText(desc, name, { reset: opts.reset, scan });
    // an activation writes the app's objects to the files : read again for the next types
    if (opts.activate) scan = scanOf(name);
    // the repositories its repositories: entries just made : cloned before the types read after
    // them (a schedule naming a form of one of them)
    if (key === "repositories" && i < keys.length - 1) out += await afterClones(keys.slice(i + 1));
  }
  try {
    out += await retryDependents(keys, name);
  } catch (e) {
    logger.error(`The objects that name those of repository '${name}' could not be read again: ${e.message || e}`);
  }
  return out;
}

/**
 * The keys of types a repository does not hold that its files give, said once in its pull output
 * as a hint : they are not read (a file may hold anything else, a form, a vars file).
 *
 * Args:
 *   scan (object): the repository's files (scanOf).
 *   repo (object): its row (its use_for_* flags).
 *
 * Returns:
 *   string: the line, starting with a newline ; '' when every key its files give is one it holds.
 */
function notHeldHint(scan, repo) {
  const notHeld = new Map();
  for (const f of scan.files) {
    for (const key of f.keys) {
      if (flagOn(repo?.[typeOf(key)?.flag])) continue;
      // config.yaml of before : the base configuration a forms repository may serve, never a hint
      if (typeOf(key)?.config && f.file === "config.yaml") continue;
      notHeld.set(key, [...(notHeld.get(key) || []), f.file]);
    }
  }
  if (!notHeld.size) return "";
  const what = [...notHeld].map(([key, files]) => `${key}: (${files.join(", ")})`).join(", ");
  return `\nNot read, the repository is not used for them: ${what} - turn the usage on to read them`;
}

/**
 * Syncs every repository of a type that is cloned, each under its write claim ; one busy (a pull
 * is running, it syncs itself) or failing does not stop the others.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   Promise<void>
 */
export async function syncAllOf(desc) {
  let names;
  try {
    names = await repositories(desc);
  } catch (e) {
    logger.error(`Could not read the repositories holding ${holdingOf(desc)}: ${e.message || e}`);
    return;
  }
  const context = names.length ? await desc.context?.() : undefined;
  for (const name of names) {
    if (!fs.existsSync(Repo.folderOf(name))) continue;
    let prior;
    try {
      prior = await Repository.claimForWrite(name);
    } catch (e) {
      logger.debug(`${titleOf(desc)} of '${name}' not synchronized now: ${e.message}`);
      continue;
    }
    try {
      await syncRepository(desc, name, { context });
    } catch (e) {
      logger.error(`Could not synchronize ${holdingOf(desc)} of repository '${name}': ${e.message || e}`);
    } finally {
      await Repository.releaseWrite(name, prior).catch((e) => logger.error(`Failed to release write-lock on '${name}': ${e.message}`));
    }
  }
}

/**
 * Syncs every object type's repositories at the worker's start, in APPLY_ORDER : what changed in
 * git while no worker ran is what the app starts with.
 *
 * Returns:
 *   Promise<void>
 */
export async function syncAll() {
  for (const key of APPLY_ORDER) {
    if (!BUILT_OBJECT_TYPES.includes(key)) continue;
    await syncAllOf(await descriptorOf(key));
  }
}

// ===========================================================================
// ACTIVATION AND DEACTIVATION
// ===========================================================================

/**
 * The app's objects a type's repository would take : every object kept in the app only (no
 * repository), each ready to be written (descriptor.candidateOf : its file's fields) or with why
 * it stays in the app.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string|null): the repository that would take them (the repositories' holder stays in
 *     the app, before its flag is saved too : the question asked first).
 *   stay (Map<string, string>): the objects that stay in the app whatever they are, as nameKey
 *     keys their names, to why (stayReasons : a file of the repository has the name but is not read
 *     in, or the object was unlinked by the fresh clone just read).
 *
 * Returns:
 *   Promise<object[]>: { row, ... } to write, or { row, reason }.
 */
async function candidates(desc, name = null, stay = new Map()) {
  const taken = await takenNames(desc);
  return Promise.all(
    (await desc.store.appRows()).map(async (row) => {
      const c = await desc.candidateOf(row, name, taken);
      const reason = !c.reason && stay.get(nameKey(c.row.name));
      return reason ? { row: c.row, reason } : c;
    }),
  );
}

/**
 * The app's objects an activation leaves in the app whatever they are, by name, with why :
 *   - a name an entry of the repository declares that is not read in (refused, waiting) : a second
 *     entry of its name would refuse both on every pull ; the object follows that entry once it is
 *     read in
 *   - an object the fresh clone just read unlinked (its entry not in the repository as cloned
 *     again : deleted in git, or never pushed) : written back, an entry deleted in git would come
 *     back with the next Push ; only what was never in the repository moves
 *
 * Args:
 *   name (string): the repository.
 *   summaries (object[]): the syncs read before the activation (syncRepository's : unread,
 *     unlinked).
 *
 * Returns:
 *   Map<string, string>: why each stays, by nameKey.
 */
function stayReasons(name, summaries) {
  const stay = new Map();
  for (const s of summaries) {
    for (const u of s.unread || []) stay.set(nameKey(u.name), `${name}/${u.file} has its name but is not read in (refused or waiting): it follows that entry once it is`);
    for (const n of s.unlinked || []) {
      stay.set(nameKey(n), `its entry is not in the repository as cloned again (deleted in git, or never pushed): kept in the app, not written back`);
    }
  }
  return stay;
}

/**
 * The names a type's objects have, as nameKey keys them : what a name given to an object of the app
 * without one (an announcement) must not be (descriptor.candidateOf).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   Promise<Set<string>|null>: the names ; null for a type that does not list them.
 */
async function takenNames(desc) {
  return desc.store.names ? new Set((await desc.store.names()).map(nameKey)) : null;
}

/**
 * What a candidate that stays in the app says : its name and why, the code of why when it has one
 * (the client says it in its language), and what the type adds.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   c (object): the candidate.
 *
 * Returns:
 *   object: { name, reason, ... }.
 */
const keptOf = (desc, c) => ({ name: c.row.name, ...(desc.keptExtra ? desc.keptExtra(c) : {}), reason: c.reason, ...(c.code ? { code: c.code } : {}) });

/**
 * A type's entries in a repository's working copy as they are now, each parsed, changing nothing :
 * how many give an object, how many the type does not import, the names they declare - read in or
 * not (a refused or waiting entry's too : an object of the app of that name is never written beside
 * it) - the files refused for what they are (a link leading outside, a file that cannot be read
 * seeming to give the key, a key that holds no list), and the file a new object would go to.
 *
 * Args:
 *   desc (object): the type's descriptor (a list type).
 *   name (string|null): the repository ; nothing read when it is not cloned.
 *
 * Returns:
 *   Promise<object>: { files (the entries giving an object), skipped (counts), names (Set of
 *     nameKey), refused: [{ file, reasons }], file (where a new object goes ; null when not cloned) }.
 */
async function filesNow(desc, name) {
  const names = new Set();
  let files = 0;
  let skipped = 0;
  const refused = [];
  if (!cloned(name)) return { files, skipped, names, refused, file: null };
  const ctx = await desc.previewContext?.();
  const scan = scanOf(name);
  refused.push(...scan.refused.map((r) => ({ file: r.file, reasons: [r.reason] })));
  refused.push(...scan.blocked.map((b) => ({ file: b.file, reasons: [`the folder cannot be read: ${b.reason}`] })));
  for (const u of scan.hinted(desc.key)) refused.push({ file: u.file, reasons: u.errors });
  for (const { file, value } of scan.holding(desc.key)) {
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) {
      refused.push({ file, reasons: [`'${desc.key}' must be a list of ${desc.noun} entries`] });
      continue;
    }
    for (const item of value) {
      let parsed = { entry: item };
      try {
        if (item && typeof item === "object" && !Array.isArray(item)) parsed = { entry: item, ...desc.parseEntry(item, ctx) };
      } catch {
        // an entry that cannot be read is refused by the sync, said then
      }
      // one the type does not import (an announcement already ended) : counted apart
      if (parsed.object && desc.notImported?.(parsed.object, name)) skipped++;
      else if (parsed.object) {
        files++;
        names.add(nameKey(parsed.object.name));
      } else if (!parsed.absent && declaredName(desc, parsed)) {
        // an entry refused declaring a name : the app's object of that name is not written beside it
        names.add(nameKey(declaredName(desc, parsed)));
      }
    }
  }
  return { files, skipped, names, refused, file: targetFileOf(desc, name, scan) };
}

/**
 * What making a repository a type's repository would do, changing nothing : the app's objects it
 * would take (written as entries of the file it says, those whose secret stays in the database
 * said), those that stay in the app and why, the entries whose name an app's object has (git's
 * version would win), and what it holds now.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string|null): the repository (its working copy read when it is cloned), null for one
 *     not made yet.
 *
 * Returns:
 *   Promise<object>: { repository, active, written: [name], withoutSecret: [name], kept: [{ name,
 *     reason }], clashes: [name], files (the entries there are), file (the file the app's objects
 *     go to), linked, ...what the type adds (descriptor.previewExtra) }.
 */
export async function preview(desc, name) {
  if (desc.single) return previewSingle(desc, name);
  const list = await candidates(desc, name);
  // the entries there are now, by name (a pull before the activation may bring more)
  const { files, skipped, names: fileNames, refused, file } = await filesNow(desc, name);
  const clashes = list.filter((c) => fileNames.has(nameKey(c.row.name))).map((c) => c.row.name);
  const clash = new Set(clashes);
  const written = list.filter((c) => !c.reason && !clash.has(c.row.name));
  return {
    repository: name || null,
    active: (await activeRepository(desc)) || null,
    written: written.map((c) => c.row.name),
    withoutSecret: written.filter((c) => c.withoutSecret).map((c) => c.row.name),
    kept: list.filter((c) => c.reason).map((c) => keptOf(desc, c)),
    clashes,
    files,
    skipped,
    file: file || `${desc.key}.yaml`,
    ...(refused.length ? { refused } : {}),
    linked: name ? await desc.store.countLinked(name) : 0,
    ...(desc.previewExtra ? await desc.previewExtra(name, list) : {}),
  };
}

/**
 * Pulls a repository (clones it when it is not yet) before its objects are read in ; a pull that
 * fails is said and the working copy used as it is.
 *
 * Args:
 *   desc (object): the type's descriptor (for the log).
 *   name (string): the repository.
 *   why (string): what the pull is for, for the log.
 *
 * Returns:
 *   Promise<string>: 'pulled', 'cloned', or why not.
 */
async function pullFor(desc, name, why) {
  try {
    if (fs.existsSync(Repo.folderOf(name))) {
      await Repository.pull(name);
      return "pulled";
    }
    // the activation that follows takes the app's objects itself, saying what it did ; a clone
    // that failed is recorded on the repository, never thrown : no working tree is "not cloned"
    await Repository.clone(name, false, { activate: false });
    return fs.existsSync(Repo.folderOf(name)) ? "cloned" : "not cloned";
  } catch (e) {
    logger.warning(`Repository '${name}' could not be pulled ${why}, its working copy is used as it is: ${e.message || e}`);
    return `not pulled: ${e.message || e}`;
  }
}

/**
 * Makes a repository a type's repository, once its flag is saved : pulls it (clones it when it is
 * not yet), reads its entries in (an entry named as an app's object takes it over, git wins), then
 * writes every other object of the app to it as a new entry of the first file holding the type's
 * key (else <key>.yaml) - without its secrets, which stay in the database - for its Push. What
 * cannot go stays in the app.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { pull (false : the caller pulled or cloned it just now) }.
 *
 * Returns:
 *   Promise<object>: { repository, pull, created, matched: [name], written: [name],
 *     withoutSecret: [name], kept: [{ name, reason }], refused, waiting, saidByPull (the lines the
 *     pull before it said already : activationDetailLines), ...what the type adds }.
 *
 * Raises:
 *   Errors.ConflictError: the repository still busy once the wait is over : nothing read in nor
 *     written (afterUsageChange says it in its report).
 */
export async function activate(desc, name, { pull = true } = {}) {
  const report = newReport(name);
  // step 1 : the latest files (a pull of the repository reads them in itself)
  if (pull) report.pull = await pullFor(desc, name, `to take ${holdingOf(desc)}`);
  if (!fs.existsSync(Repo.folderOf(name))) {
    // its first clone takes them (afterGit), said so
    report.pull = report.pull || "not cloned";
    report.notCloned = true;
    logger.warning(`Repository '${name}' is not cloned yet: ${holdingOf(desc)} will be read from it once it is`);
    return report;
  }
  // the reads and the writes under the repository's write claim : no pull, push nor app write on
  // it meanwhile ; one busy is waited for a while, then the activation fails, said (its report's
  // error), never dropped
  return withWriteClaim(name, () => (desc.single ? activateSingle(desc, name, report) : activateList(desc, name, report)));
}

/**
 * An empty activation report.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   object: { repository, pull, created, matched, written, withoutSecret, kept, refused, waiting }.
 */
function newReport(name) {
  return { repository: name, pull: "", created: 0, matched: [], written: [], withoutSecret: [], kept: [], refused: [], waiting: [] };
}

/**
 * Makes a repository just cloned for the first time a type's repository (its claim held by the
 * clone) : what activate does once pulled, as lines for its pull output. A failure is said there,
 * never thrown.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): activateList's ({ reset }).
 *
 * Returns:
 *   Promise<string>: the lines.
 */
async function activatedText(desc, name, opts = {}) {
  try {
    const report = await asHolding(name, () => (desc.single ? activateSingle : activateList)(desc, name, newReport(name), opts));
    return ["", `Now holds ${activationText(desc, report)}`, ...activationDetailLines(report)].join("\n");
  } catch (e) {
    logger.error(`Repository '${name}' could not take ${holdingOf(desc)}: ${e.message || e}`);
    return `\n${titleOf(desc)} could not follow the usage: ${e.message || e}`;
  }
}

/**
 * Makes a repository a list type's (pulled already, its write claim held) : its entries read in,
 * git winning on a name, then the app's other objects written to it.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   report (object): the report so far (activate's), filled in.
 *   opts (object): { reset (true : cloned where there was no working tree - an object of it whose
 *     entry is not there is unlinked, never deleted : syncRepository's) }.
 *
 * Returns:
 *   Promise<object>: the report.
 */
async function activateList(desc, name, report, opts = {}) {
  // step 2 : its entries read in (again : the pull may not have run), git wins on a name ; what the
  // pull before it read in is said with it - that read found nothing left to take
  const summary = await syncRepository(desc, name, { reset: opts.reset });
  const pulled = takeSynced(desc, name) || newSummary();
  // what that pull said in its output already : not said again after it (activationDetailLines)
  report.saidByPull = detailLines(pulled);
  const both = (field) => [...new Set([...(pulled[field] || []), ...(summary[field] || [])])];
  report.created = pulled.created + summary.created;
  report.deleted = pulled.deleted + summary.deleted;
  report.matched = both("matched");
  report.secretsKept = both("secretsKept");
  report.notes = both("notes");
  report.refused = summary.refused;
  report.waiting = summary.waiting;
  report.skipped = summary.skipped;
  report.ignored = summary.ignored;
  // step 3 : the app's other objects, each a new entry of the first file holding the type's key
  // (else <key>.yaml) - none beside an entry of its name not read in, none the fresh clone unlinked
  // (the pull before it, or the read above) ; written at once
  const list = await candidates(desc, name, stayReasons(name, [pulled, summary]));
  for (const c of list.filter((x) => x.reason)) report.kept.push(keptOf(desc, c));
  const written = list.filter((x) => !x.reason);
  if (written.length) {
    const file = targetFileOf(desc, name);
    report.file = file;
    try {
      // a file of the type that cannot be read : each kept in the app, not written beside it
      assertTypeReadable(desc, name);
      writeEntries(desc, name, file, written.map((c) => desc.entryOf(c)));
      for (const c of written) {
        await desc.linkCandidate(c, name, file);
        report.written.push(c.row.name);
        if (c.withoutSecret) report.withoutSecret.push(c.row.name);
      }
    } catch (e) {
      for (const c of written.filter((x) => !report.written.includes(x.row.name))) {
        report.kept.push({ ...keptOf(desc, c), reason: `not written: ${e.message || e}`, code: "notWritten", error: e.message || String(e) });
      }
    }
  }
  if (desc.reportExtra) Object.assign(report, await desc.reportExtra(name));
  if (report.written.length || report.matched.length) CrudModel.changed(desc.model);
  logger.notice(`Repository '${name}' now holds ${activationText(desc, report)}`);
  return report;
}

/**
 * Unlinks a repository's objects of a type (it is no longer used for it, or it is deleted) : they
 * stay in the app with everything they have ; only where they came from is cleared. The files in
 * git are not touched.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<number>: how many were unlinked.
 */
export async function unlinkRepository(desc, name) {
  const unlinked = await desc.store.unlink(name);
  if (unlinked) {
    CrudModel.changed(desc.model);
    logger.notice(`Unlinked the ${unlinked} ${desc.noun}(s) of repository '${name}': they stay in the app`);
  }
  return unlinked;
}

/**
 * Lets a repository go as a type's repository (its flag taken off, or it is deleted) : pulls it
 * once more and reads its files in, so the objects match the latest files (a pull that fails is
 * said, the working copy read as it is), then unlinks them : they stay in the app. The files in
 * git are not touched.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { pull (false : the caller pulled it just now) }.
 *
 * Returns:
 *   Promise<object>: { repository, pull ('pulled' or why not), unlinked }.
 */
export async function deactivate(desc, name, { pull = true } = {}) {
  const report = { repository: name, pull: "", unlinked: 0 };
  // what its pulls read in is no activation's to say any more
  synced.delete(syncedKey(desc, name));
  if (cloned(name)) {
    if (pull) {
      try {
        await Repository.pull(name);
        report.pull = "pulled";
      } catch (e) {
        report.pull = `not pulled: ${e.message || e}`;
        logger.warning(`Repository '${name}' could not be pulled before it lets go of ${holdingOf(desc)}, its working copy is read as it is: ${e.message || e}`);
      }
    }
    try {
      // under its write claim : no pull, push nor app write on it meanwhile
      await withWriteClaim(name, () => syncRepository(desc, name));
    } catch (e) {
      report.error = `not read in: ${e.message || e}`;
      logger.error(`Could not read in ${holdingOf(desc)} of repository '${name}' before it lets go of them: ${e.message || e}`);
    }
  } else {
    report.pull = "not cloned";
  }
  // a type the app has one of has nothing to unlink but itself : the app keeps its values
  report.unlinked = desc.single ? 1 : await unlinkRepository(desc, name);
  return report;
}

/**
 * Follows a repository's new name : the objects of every type say they come from it.
 *
 * Args:
 *   from (string): the old name.
 *   to (string): the new name.
 *
 * Returns:
 *   Promise<void>
 */
export async function renameRepository(from, to) {
  for (const key of BUILT_OBJECT_TYPES) {
    const desc = await descriptorOf(key);
    synced.delete(syncedKey(desc, from));
    if (await desc.store.rename(from, to)) CrudModel.changed(desc.model);
  }
}

/**
 * What an activation did, as the log and the pull output say it after "now holds" : a type the app
 * has one of, written to its file or read from it ; another, how many objects were read, replaced,
 * written (to which file) and kept in the app (and why).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   report (object): what activate answered.
 *
 * Returns:
 *   string: the text (General (written to general.yaml, waiting for Push) ; the credentials: 2 read
 *     from its files ...).
 */
function activationText(desc, report) {
  if (desc.single) return `${holdingOf(desc)} (${report.written.length ? `written to ${report.file}, waiting for Push` : report.file ? `read from ${report.file}` : "no file gives it"})`;
  const kept = report.kept || [];
  const withoutSecret = report.withoutSecret || [];
  return `${holdingOf(desc)}: ${report.created} read from its files, ${report.matched.length} replaced by an entry of the same name, ${report.deleted ? `${report.deleted} removed (their entries gone), ` : ""}${report.written.length} written to ${report.file || "it"} (waiting for Push${withoutSecret.length ? `, ${withoutSecret.length} without their secrets, kept in the database` : ""}), ${kept.length} kept in the app${kept.length ? ` (${kept.map((k) => `${k.name}: ${k.reason}`).join("; ")})` : ""}`;
}

/**
 * What turning a repository's usages on or off did (afterUsageChange's report), as lines for its
 * pull output : a new repository takes the app's objects once its first clone is done, in the
 * background, so its page says there what was taken, what stayed in the app and what failed.
 *
 * Args:
 *   report (object): the report, by type ({ <type>: { activated | deactivated | error } }).
 *
 * Returns:
 *   Promise<string>: the lines, each starting with a newline ; '' when the report is empty.
 */
export async function usageReportText(report) {
  let out = "";
  for (const key of APPLY_ORDER) {
    const r = report?.[key];
    if (!r) continue;
    const desc = await descriptorOf(key);
    if (r.error) out += `\n${titleOf(desc)} could not follow the usage: ${r.error}`;
    else if (r.activated?.notCloned || r.activated?.pull === "not cloned") out += `\nNot cloned: ${holdingOf(desc)} will be taken once it is`;
    else if (r.activated) out += ["", `Now holds ${activationText(desc, r.activated)}`, ...activationDetailLines(r.activated)].join("\n");
    else if (r.deactivated) {
      out += `\nNo longer holds ${holdingOf(desc)}: ${r.deactivated.unlinked} unlinked, kept in the app`;
      // its latest files not read in first (still busy) : the objects stay as the last pull left them
      if (r.deactivated.error) out += ` (${r.deactivated.error}: they stay as the last pull left them)`;
    }
  }
  return out;
}

/**
 * Turns a usage just saved off again : its activation could not run (the repository busy), and a
 * flag left on with nothing handed over would never be tried again - saving the repository again
 * changes no flag, and its pulls only read git in. Off, the usage and what the repository holds
 * stay one ; saving it again turns it on and hands the objects over.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   e (Error): why the activation did not run.
 *
 * Returns:
 *   Promise<object>: the type's report : { error (what happened), turnedOff (whether the flag is
 *     off again : what its own pull linked before the wait unlinked again, kept in the app) }.
 */
async function undoActivation(desc, name, e) {
  const why = `Repository '${name}' is busy (a pull or a push is running)`;
  try {
    await mysql.do("UPDATE AnsibleForms.`repositories` SET ? WHERE name = ?", [{ [desc.flag]: 0 }, name]);
    logger.warning(`${why}: the usage for ${holdingOf(desc)} is turned off again, nothing was handed over (${e.message || e})`);
    // what the activation's own pull read in before the wait (its flag was on) : unlinked again,
    // kept in the app - never linked to a repository that does not hold the type ; what that pull
    // read is no activation's to say any more
    synced.delete(syncedKey(desc, name));
    const unlinked = desc.single ? 0 : await unlinkRepository(desc, name);
    const what = unlinked ? `nothing was handed over (the ${unlinked} ${desc.noun}(s) its pull read in stay in the app, no longer linked to it)` : "nothing was read in nor written";
    return { error: `${why}: the usage was not turned on, ${what} - save it again in a moment`, turnedOff: true };
  } catch (e2) {
    logger.error(`${why}, and its usage for ${holdingOf(desc)} could not be turned off again: ${e2.message || e2}`);
    return { error: `${why}: the usage is saved but nothing was handed over - turn it off, save, and turn it on again (${e2.message || e2})`, turnedOff: false };
  }
}

/**
 * Follows a repository made, or no longer, a type's repository : made one, it takes the app's
 * objects (activate) ; no longer one, its objects are unlinked and stay in the app (deactivate) ;
 * several types at once in APPLY_ORDER, the repository pulled once. What it did is put in
 * opts.report, by type, for the answer. A failure is logged, never thrown : the repository
 * itself was saved. An activation the repository is too busy for is undone (undoActivation) :
 * its flag turned off again, said in the report.
 *
 * Args:
 *   before (object|null): the repository as it was (null for a new one).
 *   name (string): its name now.
 *   now (object): its flags now.
 *   opts (object): { report (an object the result is written to, by type), pull (false : it was
 *     cloned just now) }.
 *
 * Returns:
 *   Promise<object>: what it did, by type ({} when no flag changed).
 */
export async function afterUsageChange(before, name, now, opts = {}) {
  const report = {};
  let pull = opts.pull !== false;
  let pulled = "";
  for (const key of APPLY_ORDER) {
    if (!BUILT_OBJECT_TYPES.includes(key)) continue;
    const flag = typeOf(key).flag;
    const isOn = !!Number(now?.[flag] ?? 0);
    const wasOn = !!Number(before?.[flag] ?? 0);
    if (isOn === wasOn) continue;
    try {
      const desc = await descriptorOf(key);
      report[key] = isOn ? { activated: await activate(desc, name, { pull }) } : { deactivated: await deactivate(desc, name, { pull }) };
      // one pull : the next types read the same working copy, and say how it went
      const r = report[key].activated || report[key].deactivated;
      if (pull) {
        pulled = r.pull;
        pull = false;
      } else if (pulled && !r.pull) r.pull = pulled;
    } catch (e) {
      logger.error(`The ${key} of repository '${name}' could not follow its usage: ${e.message || e}`);
      // the repository busy all the wait : nothing read in nor written, the flag turned off again
      if (isOn && e instanceof Errors.ConflictError) report[key] = await undoActivation(await descriptorOf(key), name, e);
      else report[key] = { error: e.message || String(e) };
    }
  }
  if (opts.report) Object.assign(opts.report, report);
  return report;
}

// ===========================================================================
// APP TO GIT
// ===========================================================================

/**
 * A new object made in the app : written to its type's repository as a new entry - at the end of
 * the first file holding the type's key, else of <key>.yaml at its root - and linked to it, for its
 * Push ; without its secrets, which stay in the database. Nothing when the type has no repository
 * (or it is not cloned), or the object stays in the app (descriptor.candidateOf).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   id (number): the new object.
 *
 * Returns:
 *   Promise<object|null>: { repository, file, withoutSecret }, null when it stays in the app (an
 *     entry of the repository declares its name : it follows that entry once it is read in).
 */
export async function appCreated(desc, id) {
  const repository = await activeRepository(desc);
  if (!repository || !cloned(repository)) return null;
  const row = await desc.store.byId(id);
  if (!row || desc.store.classify(row, repository) !== "adoptable") return null;
  const c = await desc.candidateOf(row, null, await takenNames(desc));
  if (c.reason) return null;
  return withWriteClaim(repository, async () => {
    // an entry of the repository declaring its name, read in or not (refused, waiting, not pulled
    // yet) : kept in the app, never written beside it - two entries of that name would both be
    // refused on every pull ; it follows that entry once it is read in - nor while a file that may
    // declare it cannot be read
    assertTypeReadable(desc, repository);
    const now = await filesNow(desc, repository);
    if (now.names.has(nameKey(row.name))) {
      logger.warning(`Kept ${desc.noun} '${row.name}' in the app, not written to ${repository}: an entry of the repository has its name - it follows that entry once it is read in`);
      return null;
    }
    const file = now.file;
    writeEntries(desc, repository, file, [desc.entryOf(c)]);
    await desc.linkCandidate(c, repository, file);
    CrudModel.changed(desc.model);
    logger.info(`Wrote ${desc.noun} '${row.name}' to ${repository}/${file}${c.withoutSecret ? ", without its secret (kept in the database)" : ""}`);
    return { repository, file, withoutSecret: !!c.withoutSecret };
  });
}

/**
 * An object of a repository edited in the app : only the fields the edit changed written into its
 * entry, where it is now (descriptor.entryEdits : the object before and after it), the rest of it -
 * the keys the app does not use, its ${ENV} references, its comments, the file's other keys and
 * entries - kept ; an entry no file holds any more written again, whole, in the file it is linked
 * to. Its secrets are never written.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   before (object): the object as it was (its repository and file).
 *   id (number): the object.
 *
 * Returns:
 *   Promise<boolean>: whether its file was written.
 */
export async function appUpdated(desc, before, id) {
  // a type the app has one of : its own mode, before being the app's object before the edit
  if (desc.single) return appUpdatedSingle(desc, before);
  if (!before?.repository || !before.repo_file) return false;
  const row = await desc.store.byId(id);
  if (!row) return false;
  // where it is linked now, read after the save (under the claim) : a pull that held the claim
  // before it may have moved its entry or unlinked it - its old file is never written back
  const at = "repo_file" in row ? row : before;
  if (!at.repository || !at.repo_file) return false;
  return withWriteClaim(at.repository, async () => {
    const edits = desc.entryEdits(row, before);
    const whole = desc.entryOf(await desc.candidateOf({ ...row, repository: null }));
    const file = editEntry(desc, at.repository, before.name, at.repo_file, (doc, map) => applyEdits(doc, map, edits, desc.keyOrder || []), whole);
    if (!file) return false;
    // found in another file than the one it was linked to : linked to it
    if (file !== at.repo_file) await desc.store.link(row.id, at.repository, file);
    logger.info(`Saved ${desc.noun} '${row.name}' into ${at.repository}/${file}`);
    return true;
  });
}

/**
 * An object of a repository deleted in the app : its entry goes too, where it is now (its type's
 * key with it when its list is left empty, the file when it holds nothing more), for the
 * repository's Push.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   before (object): the object as it was (its repository and file).
 *
 * Returns:
 *   Promise<boolean>: whether an entry was removed.
 */
export async function appDeleted(desc, before) {
  if (!before?.repository || !before.repo_file) return false;
  return withWriteClaim(before.repository, async () => {
    // its file now : a pull that held the claim before the delete may have moved it
    const file = removeEntry(desc, before.repository, before.name, before.repo_file);
    if (!file) return false;
    logger.info(`Removed ${desc.noun} '${before.name}' from ${before.repository}/${file}`);
    return true;
  });
}

// ===========================================================================
// THE TYPES THE APP HAS ONE OF
// ===========================================================================
// The chat assistant's settings, the System > General settings, the Appearance pages' : the app has
// one object of each, its repository one map of it under its key in one of its files (chat_assistant:,
// general:, defaults: ...), and the files that map names (the logo's, the icon's image), relative
// to its file. The same rules as the list types : a pull applies it (git wins), turning the type on
// writes the app's values when no file gives it (to <key>.yaml, made) and applies it when one does,
// an app edit writes only the changed fields, the secrets are ${ENV} references only, turning it
// off reads it once more and the app keeps its values. Two files giving it are refused, naming both
// ; no file giving it changes nothing in the app.

/**
 * Where a type the app has one of is in a repository's files : the file that gives its key, and
 * what keeps it from being read (two files giving it, a file seeming to give it that cannot be
 * read, a key that holds no map).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   scan (object): the repository's files (scanOf).
 *
 * Returns:
 *   object: { file (the file giving it, the first of several ; null for none), value (its map ; {}
 *     for a key with nothing after it), refused ([{ file, reasons }] : why it is not read) }.
 */
function singleOf(desc, scan) {
  const holding = scan.holding(desc.key);
  const refused = scan.hinted(desc.key).map((u) => ({ file: u.file, reasons: u.errors }));
  if (holding.length > 1) {
    const files = holding.map((f) => f.file);
    refused.push({ file: files.join(", "), reasons: [`${desc.key}: is given by ${files.length} files (${files.join(", ")}): one file at most gives it`] });
  }
  const first = holding[0] || null;
  let value = first ? first.value : null;
  if (first && (value === null || value === undefined)) value = {};
  if (first && (typeof value !== "object" || Array.isArray(value))) refused.push({ file: first.file, reasons: [`'${desc.key}' must be a dictionary`] });
  return { file: first?.file || null, value, refused };
}

/**
 * Writes a type the app has one of into a file of its repository, and the files its map names : a
 * file whose content is the same is left as it is, a file it no longer names removed. A file it
 * names is written where its map names it (own) ; any other file already there with other bytes is
 * not the type's (a README's image, a logo of something else) : refused before anything is
 * written, never overwritten.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   file (string): the file, relative to the repository (made when it is not there, its key added
 *     when it has none).
 *   out (object): { object (its whole map : written when the file does not give it) | edits (the
 *     fields to change in it) and keyOrder ; none : the map left as it is, extraFiles: [{ name,
 *     buffer, own }] (relative to the file) }.
 *   gone (string[]): the files its map named before and no longer does (relative to the file).
 *
 * Returns:
 *   boolean: whether anything was written.
 *
 * Raises:
 *   Error: a file it names to write that is there already, with other bytes, and not the type's ;
 *     or a path outside the repository.
 */
function writeSingle(desc, name, file, out, gone = []) {
  const repoDir = Repo.folderOf(name);
  const abs = fileOf(name, file);
  const dir = path.dirname(abs);
  const extras = (out.extraFiles || []).map((extra) => ({ ...extra, abs: fileBeside(dir, extra.name, repoDir) }));
  // step 1 : nothing written when one of them would overwrite a file that is not the type's
  for (const extra of extras) {
    if (extra.own || !fs.existsSync(extra.abs) || Buffer.compare(fs.readFileSync(extra.abs), extra.buffer) === 0) continue;
    throw new Error(`'${extra.name}' is in repository '${name}' already and is not the one ${file} names: rename or remove it, or name the image under ${desc.key}: in ${file}`);
  }
  // step 2 : the YAML, then the files it names
  let written = false;
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  let next = text;
  if (out.object) next = editMapEntry(text, desc.key, (doc, map) => applyEdits(doc, map, sortedByOrder(out.object, desc.keyOrder || []), desc.keyOrder || []));
  else if (out.edits && Object.keys(out.edits).length) next = editMapEntry(text, desc.key, (doc, map) => applyEdits(doc, map, out.edits, out.keyOrder || desc.keyOrder || []));
  if (next !== text) {
    writeRepoFile(name, file, next);
    written = true;
  }
  const kept = new Set();
  for (const extra of extras) {
    kept.add(extra.abs);
    if (fs.existsSync(extra.abs) && Buffer.compare(fs.readFileSync(extra.abs), extra.buffer) === 0) continue;
    fs.mkdirSync(path.dirname(extra.abs), { recursive: true });
    fs.writeFileSync(extra.abs, extra.buffer);
    written = true;
  }
  // step 3 : the files it named before
  for (const old of gone) {
    const named = fileBeside(dir, old, repoDir);
    if (kept.has(named) || !fs.existsSync(named)) continue;
    fs.rmSync(named, { force: true });
    written = true;
  }
  return written;
}

/**
 * Reads a type the app has one of into the app : checked, what it names there, then applied as the
 * app's own save applies it - only when it changes something. No file giving it : nothing changes ;
 * two files giving it : refused, nothing applied.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { scan (the repository's files, read once by the pull : scanOf ; read when not
 *     given) }.
 *
 * Returns:
 *   Promise<object>: the summary, as syncRepository's ; its notes what the apply said.
 */
async function syncSingle(desc, name, opts = {}) {
  const summary = newSummary();
  const { file, value, refused } = singleOf(desc, wholeScan(opts.scan || scanOf(name)));
  if (refused.length) {
    summary.refused.push(...refused);
    for (const r of refused) logger.warning(`Refused ${desc.noun} of ${name}/${r.file}: ${r.reasons.join("; ")}`);
    return summary;
  }
  if (!file) {
    summary.notes.push(`No file of the repository gives ${desc.key}: - the app keeps ${holdingOf(desc)} as it is`);
    return summary;
  }
  const raw = value;
  const abs = fileOf(name, file);
  const checked = await desc.check(raw, { dir: path.dirname(abs), root: Repo.folderOf(name) });
  if (checked.errors.length) {
    summary.refused.push({ file, reasons: checked.errors });
    logger.warning(`Refused ${desc.noun} of ${name}/${file}: ${checked.errors.join("; ")}`);
    return summary;
  }
  const waiting = await waitingOf(desc, checked.object);
  if (waiting.length) {
    summary.waiting.push({ file, reasons: waiting });
    return summary;
  }
  const current = await desc.current();
  // the config seed's whole object (the chat assistant's settings) : not applied, said
  if (desc.heldBySeed(current)) {
    summary.notes.push(`Kept by the config seed, not applied: ${desc.key}: of ${file}`);
    summary.unchanged = 1;
    return summary;
  }
  summary.notes.push(...desc.notesOf(checked.object, current));
  // a secret the file does not give that the app still holds (after the apply : one it let go is
  // not kept), said in the pull output
  const keptSecrets = (now) => {
    const secrets = desc.secretsOf ? desc.secretsOf(now) : desc.secrets || [];
    if (secrets.some((s) => !given(raw[s]) && given(now?.[s]))) summary.secretsKept.push(desc.title);
  };
  if (!desc.changed(checked.object, current)) {
    keptSecrets(current);
    summary.unchanged = 1;
    return summary;
  }
  try {
    summary.notes.push(...((await desc.apply(checked.object, current)) || []));
    keptSecrets(await desc.current());
    summary.updated = 1;
    CrudModel.changed(desc.model);
    logger.notice(`Applied ${desc.key}: of ${name}/${file}: the app follows git for ${holdingOf(desc)} from now on`);
  } catch (e) {
    summary.refused.push({ file, reasons: [`not saved: ${e.message || e}`] });
    logger.warning(`Could not apply ${desc.key}: of ${name}/${file}: ${e.message || e}`);
  }
  return summary;
}

/**
 * What making a repository the repository of a type the app has one of would do, changing nothing :
 * the app's values written to it when no file gives it (said when its secrets stay in the
 * database), else its file applied, git winning.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string|null): the repository.
 *
 * Returns:
 *   Promise<object>: as preview's ; file the file giving it, or the one it would be written to.
 */
async function previewSingle(desc, name) {
  // a file seeming to give it that cannot be read, two files giving it, a link leading outside :
  // said refused, as its sync refuses it ; nothing written over it
  let file = null;
  let refused = [];
  let target = `${desc.key}.yaml`;
  if (cloned(name)) {
    const scan = scanOf(name);
    ({ file, refused } = singleOf(desc, scan));
    refused = [
      ...scan.refused.map((r) => ({ file: r.file, reasons: [r.reason] })),
      ...scan.blocked.map((b) => ({ file: b.file, reasons: [`the folder cannot be read: ${b.reason}`] })),
      ...refused,
    ];
    target = file || targetFileOf(desc, name, scan);
  }
  const exists = !!file;
  const current = await desc.current();
  const { withoutSecret } = desc.fileOf(current);
  const active = (await activeRepository(desc)) || null;
  // written when no file gives it, unless the config seed holds the whole object
  const writes = !exists && !refused.length && !desc.heldBySeed(current);
  return {
    repository: name || null,
    active,
    written: writes ? [desc.title] : [],
    withoutSecret: writes && withoutSecret ? [desc.title] : [],
    // what stays in the app (the appearance fields the config seed manages)
    kept: desc.kept(current),
    clashes: exists ? [desc.title] : [],
    files: exists ? 1 : 0,
    file: target,
    ...(refused.length ? { refused } : {}),
    linked: name && active === name ? 1 : 0,
  };
}

/**
 * Makes a repository the repository of a type the app has one of (pulled already) : its file
 * applied when one gives it, git winning, else the app's values written to it, for its Push.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   report (object): the report so far (activate's), filled in.
 *
 * Returns:
 *   Promise<object>: the report.
 */
async function activateSingle(desc, name, report) {
  // what the pull before it read in : its file applied then, said by the read below as well - its
  // lines in that pull's output already, not said again after it (activationDetailLines)
  const pulled = takeSynced(desc, name);
  report.saidByPull = pulled ? detailLines(pulled) : [];
  const current = await desc.current();
  report.kept = desc.kept(current);
  if (desc.heldBySeed(current)) {
    // the config seed's whole object : it stays with the seed, nothing written nor applied
    logger.notice(`Repository '${name}' now holds ${holdingOf(desc)}, kept by the config seed while it declares them: nothing written to it`);
    return report;
  }
  const scan = scanOf(name);
  const there = singleOf(desc, scan);
  if (there.file || there.refused.length) {
    const summary = await syncSingle(desc, name, { scan });
    report.file = there.file;
    report.refused = summary.refused;
    report.waiting = summary.waiting;
    report.notes = summary.notes;
    if (!summary.refused.length && !summary.waiting.length) report.matched = [desc.title];
  } else {
    const file = targetFileOf(desc, name, scan);
    const out = desc.fileOf(await desc.current());
    await withWriteClaim(name, async () => writeSingle(desc, name, file, out));
    report.file = file;
    report.written = [desc.title];
    if (out.withoutSecret) report.withoutSecret = [desc.title];
  }
  logger.notice(`Repository '${name}' now holds ${activationText(desc, report)}`);
  return report;
}

/**
 * A type the app has one of, edited in the app : only the fields the edit changed written into its
 * map, and the files it names that changed ; written whole (to <key>.yaml, made) when no file gives
 * it. Nothing when the type has no repository.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   before (object|null): the app's object before the edit (RepoObjects.snapshot) ; null : the
 *     type had no repository then.
 *
 * Returns:
 *   Promise<boolean>: whether its file was written.
 */
async function appUpdatedSingle(desc, before) {
  if (!before) return false;
  const repository = await activeRepository(desc);
  if (!repository || !cloned(repository)) return false;
  const after = await desc.current();
  // the config seed's whole object : never written to the repository
  if (desc.heldBySeed(after)) return false;
  // a save that left this type's object as it was (one endpoint saving several pages' fields : the
  // Defaults page's save is not the Name page's) : its file is not touched, not even written again
  // when it is gone - a page's save writes its own key only
  if (canonicalJson(after) === canonicalJson(before)) return false;
  return withWriteClaim(repository, async () => {
    const scan = scanOf(repository);
    // a file seeming to give it that cannot be read : never a second file giving it beside that one
    assertTypeReadable(desc, repository, scan);
    const { file, value } = singleOf(desc, scan);
    const declared = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    // the files its map no longer names : those the type says (only the images the map named and
    // the edit changed) ; none when no file gives it - a file it does not name is never the type's
    // to remove
    const out = file && declared ? desc.fileEdits(declared, after, before) : desc.fileOf(after);
    const target = file || targetFileOf(desc, repository, scan);
    const written = writeSingle(desc, repository, target, out, out.gone ?? []);
    if (written) logger.info(`Saved ${holdingOf(desc)} into ${repository}/${target}`);
    return written;
  });
}

/**
 * Where a type the app has one of is kept : the repository holding it and the file that gives it
 * (the first of several), else the file it would be written to.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   Promise<object|null>: { repository, repo_file }, null when no repository holds it.
 */
export async function singleSourceOf(desc) {
  const repository = await activeRepository(desc);
  if (!repository) return null;
  if (!cloned(repository)) return { repository, repo_file: `${desc.key}.yaml` };
  const scan = scanOf(repository);
  return { repository, repo_file: singleOf(desc, scan).file || targetFileOf(desc, repository, scan) };
}

// ===========================================================================
// THE SEED : WHAT IT DECLARES OF A TYPE
// ===========================================================================

/**
 * Applies what the config seed declares of a type (the Appearance pages', the announcements, the
 * disclaimer : sections the seed reads through the same descriptors as a repository) : checked
 * as an entry is (its references resolved by the seed already), then a type the app has one of
 * applied, a list type's objects made or changed by name - never one a repository holds. Nothing is linked
 * to a repository.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   declared (object|object[]): the section's object (a type the app has one of), or its items.
 *   opts (object): { dir (the seed file's folder : what the section names beside it) }.
 *
 * Returns:
 *   Promise<object>: { created: [name], updated: [name], unchanged (count), kept: [name] (held by a
 *     repository, not applied) }.
 *
 * Raises:
 *   Error: an item refused, named with why.
 */
export async function applyDeclared(desc, declared, opts = {}) {
  const out = { created: [], updated: [], unchanged: 0, kept: [] };
  if (desc.single) {
    const checked = await desc.check(declared, { resolved: true, fromSeed: true, dir: opts.dir });
    if (checked.errors.length) throw new Error(`${desc.title}: ${checked.errors.join("; ")}`);
    const current = await desc.current();
    // the seed's own declaration : what it manages passes the seed's hold
    if (!desc.changed(checked.object, current, { fromSeed: true })) out.unchanged++;
    else {
      await desc.apply(checked.object, current, { fromSeed: true });
      out.updated.push(desc.key);
    }
    return out;
  }
  for (const item of declared || []) {
    const checked = desc.check(item, { resolved: true, fromSeed: true });
    if (checked.errors.length) throw new Error(`${desc.noun} '${item?.name ?? ""}': ${checked.errors.join("; ")}`);
    // one the type does not import (an announcement already ended) : left out, as a pull leaves it
    if (desc.notImported?.(checked.object)) continue;
    const row = ((await desc.store.rows()) || []).find((r) => nameKey(r.name) === nameKey(checked.object.name));
    // one a repository holds : git's, never the seed's too (each would undo the other, the seed at
    // every start, git at every pull) - left as it is, said
    if (row?.repository) {
      out.kept.push(checked.object.name);
      logger.warning(`The config seed declares the ${desc.noun} '${checked.object.name}', which repository '${row.repository}' holds (${row.repo_file}): not applied, the repository's version is kept`);
      continue;
    }
    if (!row) {
      await desc.store.insert(checked.object, null, null);
      out.created.push(checked.object.name);
    } else if (desc.store.changed(row, checked.object)) {
      await desc.store.update(row, checked.object);
      out.updated.push(checked.object.name);
    } else out.unchanged++;
  }
  if (out.created.length || out.updated.length) CrudModel.changed(desc.model);
  return out;
}

// ===========================================================================
// THE STORE OF A TABLE
// ===========================================================================

/**
 * What every object table does the same way to follow its repository (its repository and
 * repo_file columns) : link an object, unlink a repository's, follow a rename, count them.
 *
 * Args:
 *   table (string): the table (AnsibleForms.`credentials`).
 *   key (string): the column a row is found by ('id', a disclaimer's 'version').
 *
 * Returns:
 *   object: { link(id, repository, file), unlink(repository), rename(from, to),
 *     countLinked(repository) }.
 */
export function linkStore(table, key = "id") {
  return {
    link: (id, repository, file) => mysql.do(`UPDATE ${table} SET repository = ?, repo_file = ? WHERE ${key} = ?`, [repository, file, id]),
    unlink: async (repository) => (await mysql.do(`UPDATE ${table} SET repository = NULL, repo_file = NULL WHERE repository = ?`, [repository]))?.affectedRows || 0,
    rename: async (from, to) => (await mysql.do(`UPDATE ${table} SET repository = ? WHERE repository = ?`, [to, from]))?.affectedRows || 0,
    countLinked: async (repository) => Number((await mysql.do(`SELECT COUNT(*) AS n FROM ${table} WHERE repository = ?`, [repository]))?.[0]?.n || 0),
  };
}

// the columns of each table, read once : what a row gets when a value is not given
const columnsByTable = new Map();

// the column types whose default is a number (a yes or no field is a tinyint) : information_schema
// gives every default as a text, and a text "0" is a yes to whatever reads it as one
const NUMERIC_TYPES = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit)$/i;

/**
 * The columns of a table as a new row gets them when a value is not given : the default of each,
 * a number for a column of numbers (a yes or no field's 0 or 1), and whether it may be empty
 * (information_schema, read once per table).
 *
 * Args:
 *   table (string): the table (AnsibleForms.`credentials`).
 *
 * Returns:
 *   Promise<Map<string, object>>: { value (its default ; null : none), nullable } by column.
 */
export async function columnDefaults(table) {
  const bare = String(table).replace(/`/g, "").split(".").pop();
  if (!columnsByTable.has(bare)) {
    const rows = await mysql.do(
      "SELECT COLUMN_NAME AS name, COLUMN_DEFAULT AS value, IS_NULLABLE AS nullable, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'AnsibleForms' AND TABLE_NAME = ?",
      [bare],
    );
    const columns = new Map();
    for (const r of rows || []) {
      // MariaDB quotes a text default ('outbound') and says NULL for none ; MySQL gives it as it is
      let value = r.value === undefined || r.value === "NULL" ? null : r.value;
      if (typeof value === "string" && /^'.*'$/s.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
      // an expression (current_timestamp(), now()) : no value a file could give
      else if (typeof value === "string" && /^(current_timestamp|now|uuid)\b|\)$/i.test(value)) value = null;
      // a number column's default as the number it is (a bit's b'1' too)
      if (value !== null && NUMERIC_TYPES.test(String(r.type || ""))) {
        const n = Number(String(value).replace(/^b'([01]+)'$/i, (m, bits) => String(parseInt(bits, 2))));
        value = Number.isFinite(n) ? n : null;
      }
      columns.set(r.name, { value, nullable: String(r.nullable).toUpperCase() === "YES" });
    }
    columnsByTable.set(bare, columns);
  }
  return columnsByTable.get(bare);
}

/**
 * How a row of a table is placed for a repository's sync : its own (linked to it), the app's
 * (no repository, a file of its name takes it over), or taken (the reason).
 *
 * Args:
 *   row (object): the row.
 *   name (string): the repository synced.
 *   reasonInApp (string|null): why an app's row cannot be taken over (managed by the config
 *     seed ...), null when it can.
 *
 * Returns:
 *   string: 'own', 'adoptable', or where it is taken.
 */
export function classifyRow(row, name, reasonInApp = null) {
  if (row.repository === name && row.repo_file) return "own";
  if (row.repository) return `repository '${row.repository}' (${row.repo_file})`;
  if (reasonInApp) return reasonInApp;
  return "adoptable";
}

export default {
  nameKey,
  cloned,
  withWriteClaim,
  asHolding,
  scanOf,
  fileOf,
  targetFileOf,
  assertTypeReadable,
  writeEntries,
  entryFileOf,
  editEntry,
  removeEntry,
  singleSourceOf,
  repositories,
  activeRepository,
  assertUsageAllowed,
  syncRepository,
  summaryText,
  syncText,
  afterGit,
  trackClone,
  syncAllOf,
  syncAll,
  preview,
  activate,
  unlinkRepository,
  deactivate,
  renameRepository,
  afterUsageChange,
  usageReportText,
  appCreated,
  appUpdated,
  appDeleted,
  applyDeclared,
  linkStore,
  classifyRow,
};
