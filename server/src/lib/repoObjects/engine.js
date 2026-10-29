'use strict';
// The engine of the repository-backed objects : the schedules, the credentials, the runners ...
// (lib/repoObjects/types.js, the object types), each kept in a repository used for it, one
// object per YAML file in the type's folder. One repository at most per type.
//
// Every type is a descriptor (lib/repoObjects/<type>.js : its folder, its table, how a file
// reads, what it names, its secret fields) ; what they share is here, written once :
//   git to app   after each pull (or clone, reset), at the worker's start and when a
//                repository is made one, its files are read into the table (syncRepository) :
//                new files make objects, changed ones change them, a removed file removes its
//                object - unless something uses it, said and refused. A file that is not valid
//                is refused alone, said in the pull output and the server log, the others still
//                sync. One that names an object that is not there yet WAITS, said in the pull
//                output, and is read again when the type it names is next pulled.
//   app to git   an object of a repository edited, created or deleted in the app writes or
//                removes its file in the repository's working tree, under its write claim ;
//                only the changed fields are written, and the change goes to git with the
//                repository's Push.
//   activation   made the type's repository, it is pulled and its files read in - a file named
//                as an object of the app takes that object over, git's version wins - and the
//                app's other objects are written to it ; what cannot go stays in the app
//                (preview first, changing nothing : the question asked before it is saved).
//   deactivation no longer used for it, or deleted : pulled once more, read in, and its objects
//                unlinked - they stay in the app as they are, the files in git untouched.
//   secrets      never plain in git : a file gives them as ${ENV} references (resolved as the
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
import { filesIn, fileIn, fileBeside, fileNameFor, parseMapFile, parseListFile, appendListEntries, updateListEntry, removeListEntry } from "./yamlFile.js";
import { given } from "./secrets.js";
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
 * The name a file (or an entry of a list file) declares, read or not : its object's, else the one
 * its text gives (a file refused, or waiting for what it names) - under the field the type names
 * its objects by (descriptor.nameField : a disclaimer version's is its number), every type alike.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   f (object): the file as read ({ object, raw }).
 *
 * Returns:
 *   string|null: the name, null when it gives none.
 */
const declaredName = (desc, f) => {
  const raw = f?.raw && typeof f.raw === "object" && !Array.isArray(f.raw) ? f.raw : null;
  const n = f?.object?.name ?? raw?.[desc.nameField || "name"];
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
 * How the log and the pull output name what a type holds, one way per mode : a type kept in one
 * file by its label, as a name (General, Branding, MCP, Chat assistant, Links), a folder or a list
 * type by its objects (the credentials). The sentences built on it never make a verb agree with
 * it, so they read the same for both.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *
 * Returns:
 *   string: what the type holds, as a sentence names it (General, the credentials).
 */
const holdingOf = (desc) => (desc.file ? titleOf(desc) : `the ${titleOf(desc).toLowerCase()}`);

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

/**
 * The absolute path of an object's file, checked to be right in its type's folder.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   repoFile (string): the file, relative to the repository (credentials/git.yaml).
 *
 * Returns:
 *   string: the path.
 *
 * Raises:
 *   Error: a file outside the folder.
 */
export function fileOf(desc, repository, repoFile) {
  try {
    return fileIn(Repo.folderOf(repository), desc.folder, repoFile);
  } catch {
    throw new Error(`'${repoFile}' is not a ${desc.noun} file of repository '${repository}'`);
  }
}

/**
 * The list file of a type kept as a list in one file (repositories.yaml), at the repository's
 * root : checked to stay in the repository once its links are followed.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *
 * Returns:
 *   string: its absolute path.
 *
 * Raises:
 *   Error: a link that leads outside the repository.
 */
export const listFileOf = (desc, repository) => fileIn(Repo.folderOf(repository), ".", desc.listFile, /./);

/**
 * Adds a new object's entry to its type's list file (the list mode : repositories.yaml).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   entry (object): the entry.
 *
 * Returns:
 *   string: the list file, relative to the repository (repositories.yaml).
 */
export function writeListEntry(desc, repository, entry) {
  const abs = listFileOf(desc, repository);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  fs.writeFileSync(abs, appendListEntries(text, desc.listKey, [entry], desc.keyOrder), "utf8");
  return desc.listFile;
}

/**
 * Writes a new object's file in its type's folder, named after it.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   name (string): the object's name.
 *   text (string): the file's text.
 *
 * Returns:
 *   string: the file, relative to the repository (credentials/git.yaml).
 */
export function writeNewFile(desc, repository, name, text) {
  const folder = path.join(Repo.folderOf(repository), desc.folder);
  const file = fileNameFor(name, (f) => fs.existsSync(path.join(folder, f)), desc.noun);
  // its folder a link that leads outside the repository : refused before anything is made
  const abs = fileOf(desc, repository, `${desc.folder}/${file}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  return `${desc.folder}/${file}`;
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
 * Reads a type's files of a repository, each checked on its own (descriptor.parse), then what each
 * names : one that names an object not there yet waits.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   ctx (any): the descriptor's context (descriptor.context), for its parse.
 *
 * Returns:
 *   Promise<object[]>: { file, errors, waiting, absent, object, raw, ignored } each.
 */
async function readFiles(desc, name, ctx) {
  const repoDir = Repo.folderOf(name);
  // a type kept as a list in one file : its entries, each as a file of its own would be ; a file
  // that is a link leading outside the repository, or a folder, refused (said, never read)
  const links = [];
  const files = desc.listFile ? readListFile(desc, name) : filesIn(repoDir, desc.folder, undefined, links).map((file) => {
    let text;
    try {
      text = fs.readFileSync(path.join(repoDir, file), "utf8");
    } catch (e) {
      return { file, errors: [`cannot be read: ${e.code || e.message}`], object: null, absent: false };
    }
    // a file its reading throws on (an alias bomb) : refused alone, the others still read
    try {
      return { file, ...desc.parse(text, ctx) };
    } catch (e) {
      return { file, errors: [`cannot be read: ${e.message || e}`], object: null, absent: false };
    }
  });
  if (files === null) return null;
  for (const l of links) files.push({ file: l.file, errors: [l.reason], object: null, absent: false });
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // a file the type does not import (an announcement already ended : descriptor.notImported) : not
  // refused, said on a line of its own ; its object, if the app has it, goes
  for (const f of files) {
    const reason = f.object && desc.notImported ? desc.notImported(f.object, name) : null;
    if (reason) {
      f.skipped = { name: f.object.name, reason };
      f.object = null;
    }
  }
  // the references : by name, to an object of the type named, that must be there
  const cache = new Map();
  for (const f of files) {
    if (!f.object) continue;
    const waiting = await waitingOf(desc, f.object, cache);
    if (waiting.length) {
      f.waiting = waiting;
      f.raw = f.raw ?? f.object;
      f.object = null;
    }
  }
  return files;
}

/**
 * The entries of a type kept as a list in one file (desc.listFile : repositories.yaml, its
 * desc.listKey list), each read and checked on its own as a file of its own would be : its "file"
 * the list file and its name (repositories.yaml#forms). A file that cannot be read as a list is one
 * refusal of the whole (whole : nothing of it changes the app).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   object[]|null: { file, repoFile, errors, absent, object, raw } each ; null when the repository
 *     has no such file (the app keeps its objects).
 */
function readListFile(desc, name) {
  const abs = listFileOf(desc, name);
  if (!fs.existsSync(abs)) return null;
  const { errors, items } = parseListFile(fs.readFileSync(abs, "utf8"), desc.listKey);
  if (errors.length) return [{ file: desc.listFile, errors, object: null, absent: false, whole: true }];
  return items.map((raw, i) => {
    const label = raw && typeof raw === "object" && raw.name !== undefined ? String(raw.name) : `#${i + 1}`;
    const file = `${desc.listFile}#${label}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { file, repoFile: desc.listFile, errors: ["an entry must be a dictionary"], object: null, absent: false };
    return { file, repoFile: desc.listFile, ...desc.check(raw), raw, absent: false };
  });
}

/**
 * Where an object of the app is linked to, as its type's files are known : its file, or its entry
 * of a list file (repositories.yaml#forms).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   row (object): the object.
 *
 * Returns:
 *   string: its file's key.
 */
const linkKeyOf = (desc, row) => (desc.listFile ? `${desc.listFile}#${row.name}` : row.repo_file);

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
 * What an object of a repository declares in its own file as the working copy has it now (an entry
 * of a list file, or its file), read or not : its raw keys, before any check.
 *
 * Args:
 *   desc (object): the object's type's descriptor.
 *   row (object): the object (its repository, repo_file and name).
 *
 * Returns:
 *   object|null: the keys its file gives ; null when its file is gone or cannot be read.
 */
function declaredOf(desc, row) {
  try {
    if (desc.listFile) return (readListFile(desc, row.repository) || []).find((f) => f.file === linkKeyOf(desc, row))?.raw || null;
    return desc.parse(fs.readFileSync(fileOf(desc, row.repository, row.repo_file), "utf8")).raw || null;
  } catch {
    return null;
  }
}

/**
 * Whether every object that uses an object by its name follows its rename : each one is an object
 * of a repository, of a type that names this one (descriptor.references), whose own file - as the
 * working copy has it now : the same commit - names it by its new name. The rename is then taken,
 * and each user follows when its file is read in : at once in the same repository (the types read
 * in their order), else when the types that name it are read again (retryDependents). One that is
 * no repository object, a single-file type's, or a file that still names the old name : not.
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
    if (other.file) continue;
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
 * Reads a type's files of a repository into its table : a new file makes an object, a changed one
 * changes it, a removed one (or one saying state: absent) removes it - unless something uses it
 * (descriptor.usersOf) or it can never be deleted (descriptor.undeletable), then it is kept and
 * the refusal said. A file renamed (its object's name given by a new file) moves its object to it.
 * A refused file - not valid, a name another object has - changes nothing : an object it made before stays as it was, a new one is
 * not made. A file that names an object not there yet waits, the same way. Where the file gives
 * no secret, the database's stays ; a field it no longer declares takes the value a new object gets
 * (descriptor.store.removed).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { context (the descriptor's context, read when not given), reset (true : the
 *     working tree was just cloned where there was none - a reset, or a tree that was gone : a
 *     file the app wrote may never have been pushed - an object whose file is not there is
 *     unlinked and kept in the app, never deleted) }.
 *
 * Returns:
 *   Promise<object>: { created, updated, deleted, unchanged (counts), matched: [name], refused:
 *     [{ file, reasons }], waiting: [{ file, reasons }], ignored: [{ file, keys }], secretsKept:
 *     [name], skipped: [{ file, name, reason }] (files the type does not import : descriptor.notImported),
 *     notes, unread, unlinked: [name] (the objects a reset unlinked, their files not in the
 *     repository as cloned again) }.
 */
export async function syncRepository(desc, name, opts = {}) {
  // a type kept in one file : its own mode
  if (desc.file) return syncSingle(desc, name);
  const summary = newSummary();
  const ctx = opts.context !== undefined ? opts.context : await desc.context?.();
  // step 1 : the files, read and checked on their own, and what they name
  const files = await readFiles(desc, name, ctx);
  // a type kept as a list in one file, the repository without that file : the app keeps its objects,
  // unlinked - left linked, the next entry the app writes would make a file of that one entry, and
  // the pull after its Push would delete every other one
  if (files === null) {
    const unlinked = await desc.store.unlink(name);
    if (unlinked) CrudModel.changed(desc.model);
    summary.notes.push(`No ${desc.listFile} in the repository: the app keeps ${holdingOf(desc)} as it has them${unlinked ? `, ${unlinked} no longer linked to it` : ""}`);
    return summary;
  }
  // step 2 : the objects there are : this repository's by file, the names of the others
  const rows = await desc.store.rows();
  const own = new Map();
  const taken = new Map(); // name key -> where it is taken
  // the app's own objects : a file of that name takes it over, git's version wins
  const adoptable = new Map();
  for (const row of rows || []) {
    const kind = desc.store.classify(row, name);
    if (kind === "own") own.set(linkKeyOf(desc, row), row);
    else if (kind === "adoptable") adoptable.set(nameKey(row.name), row);
    else taken.set(nameKey(row.name), kind);
  }
  // a refused or waiting file that is still there keeps its object, and that object its name ; a
  // list file refused whole keeps them all
  const kept = new Set(files.some((f) => f.whole) ? own.keys() : []);
  for (const f of files) {
    if (!f.object && !f.absent && !f.skipped && own.has(f.file)) {
      kept.add(f.file);
      taken.set(nameKey(own.get(f.file).name), `${f.file} (${f.waiting ? "waiting" : "refused"}, kept as it was)`);
    }
  }
  // a file that gives its object a new name where its type never renames one (descriptor.renameRefused :
  // a disclaimer version keeps its number), or while something uses it by its name (a credential a
  // runner names) : refused, the object kept as it was - renamed, what uses it would name nothing
  for (const f of desc.usersOf || desc.renameRefused ? files : []) {
    const row = f.object && own.get(f.file);
    if (!row || nameKey(row.name) === nameKey(f.object.name)) continue;
    if (desc.renameRefused) f.errors = [`it renames '${row.name}' to '${f.object.name}', but ${desc.renameRefused}`];
    else {
      const users = await desc.usersOf(row);
      // nothing uses it, or every user follows it in the same commit (followsRename) : taken
      if (!users.length || (await followsRename(desc, row, f.object.name, users))) continue;
      f.errors = [
        `it renames '${row.name}' to '${f.object.name}', but ${users.join(", ")} still uses '${row.name}': kept as it was until nothing uses it - name '${f.object.name}' in the files of what uses it in the same commit, or change what uses it in the app first`,
      ];
    }
    f.object = null;
    kept.add(f.file);
    taken.set(nameKey(row.name), `${f.file} (refused, kept as it was)`);
  }
  // step 3 : the names. A linked file that still names its own object keeps that name first : a
  // new file sorting before it and naming the same object is the one refused - never the linked
  // file, and never a raw duplicate from the database when the new object is inserted
  const reserved = new Set();
  for (const f of files) {
    const row = f.object && own.get(f.file);
    if (!row || nameKey(row.name) !== nameKey(f.object.name) || taken.has(nameKey(row.name))) continue;
    taken.set(nameKey(row.name), `${name}/${f.file}`);
    reserved.add(f.file);
  }
  // then the others, in file order : the first file to name an object has it ; a file that has
  // no object yet and names one of the app takes it over
  for (const f of files) {
    if (!f.object || reserved.has(f.file)) continue;
    const key = nameKey(f.object.name);
    if (!taken.has(key) && adoptable.has(key)) {
      if (own.has(f.file)) taken.set(key, `a ${desc.noun} of this app`);
      else {
        f.adopt = adoptable.get(key);
        adoptable.delete(key);
      }
    }
    if (taken.has(key)) {
      f.errors = [`the name '${f.object.name}' is the name of another ${desc.noun}: ${taken.get(key)}`];
      f.object = null;
      if (own.has(f.file)) kept.add(f.file);
      continue;
    }
    taken.set(key, `${name}/${f.file}`);
  }
  // step 4 : a file renamed in git (its old file gone, a new one giving the same name) : the
  // object follows it to its new file, and is changed as a changed file - never removed and made
  // again, which would lose its secrets kept in the database, its state, and refuse it for good
  // while something uses it
  const gone = new Map();
  let relinked = 0;
  for (const [file, row] of own) {
    if (!files.some((f) => f.file === file)) gone.set(nameKey(row.name), file);
  }
  for (const f of files) {
    if (!f.object || own.has(f.file) || f.adopt) continue;
    const from = gone.get(nameKey(f.object.name));
    if (from === undefined) continue;
    gone.delete(nameKey(f.object.name));
    const row = own.get(from);
    try {
      await desc.store.link(row.id, name, f.repoFile ?? f.file);
    } catch (e) {
      // not moved : the new file refused, the object kept on its old one, the others go on
      f.errors = [`not saved: ${e.message || e}`];
      f.object = null;
      kept.add(from);
      continue;
    }
    relinked++;
    own.delete(from);
    own.set(f.file, { ...row, repo_file: f.repoFile ?? f.file });
    logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${row.name}' follows its file, renamed in git: ${name}/${from} is now ${name}/${f.file}`);
  }
  // step 4b : a flag one object at most has (the default runner of a type, the active mail
  // channel ...) that several files give : each write would take it off the others, the next pull
  // giving it back, for ever - applied from none of them, each object keeping what it has, said
  oneOnlyClashes(desc, files, own, summary, name);
  // step 5 : the objects whose file is gone (or absent) go first - not one something uses -
  // then the changed, then the new
  const present = new Set([...files.filter((f) => f.object).map((f) => f.file), ...kept]);
  for (const [file, row] of own) {
    if (present.has(file)) continue;
    // one that can never be deleted (the main LDAP directory) : kept, said
    const never = desc.undeletable ? await desc.undeletable(row) : null;
    if (never) {
      summary.refused.push({ file, reasons: [`its file is gone, but ${never}: kept, and still linked to it`] });
      logger.warning(`Kept ${desc.noun} '${row.name}' of ${name}/${file}: its file is gone, but ${never}`);
      continue;
    }
    const users = desc.usersOf ? await desc.usersOf(row) : [];
    if (users.length) {
      summary.refused.push({ file, reasons: [`its file is gone, but ${users.join(", ")} still uses '${row.name}': kept until nothing uses it`] });
      logger.warning(`Kept ${desc.noun} '${row.name}' of ${name}/${file}: its file is gone, but ${users.join(", ")} still uses it`);
      continue;
    }
    try {
      // cloned again (a reset, a tree that was gone) : a file not in the repository may never have
      // been pushed (written by the app) -
      // its object stays in the app, unlinked, never deleted with the secrets it keeps
      if (opts.reset && !files.some((f) => f.file === file)) {
        await desc.store.link(row.id, null, null);
        relinked++;
        summary.unlinked.push(row.name);
        summary.notes.push(`${file}: not in the repository as cloned again (never pushed?): '${row.name}' kept in the app, no longer linked to it`);
        logger.notice(`Kept ${desc.noun} '${row.name}' in the app, unlinked: its file ${name}/${file} is not in the repository as cloned again`);
        continue;
      }
      await desc.store.remove(row);
    } catch (e) {
      // not removed (its model refused, the database busy) : kept, said, the others go on
      summary.refused.push({ file, reasons: [`its file is gone, but '${row.name}' could not be removed: ${e.message || e}`] });
      logger.warning(`Could not remove ${desc.noun} '${row.name}' of ${name}/${file}: ${e.message || e}`);
      continue;
    }
    const skipped = files.find((f) => f.file === file && f.skipped);
    logger.notice(`Removed ${desc.noun} '${row.name}': ${skipped ? `its file ${name}/${file} says it is ${skipped.skipped.reason}` : `its file ${name}/${file} is gone`}`);
    summary.deleted++;
  }
  for (const f of files) {
    if (!f.object) {
      // the name a refused or waiting file declares : no object of the app is written beside it
      // under that name (activateFolder) - its file follows once it is read in
      if (!f.skipped && !f.absent && declaredName(desc, f)) summary.unread.push({ name: declaredName(desc, f), file: f.file });
      if (f.skipped) {
        summary.skipped.push({ file: f.file, ...f.skipped });
      } else if (f.waiting) {
        summary.waiting.push({ file: f.file, reasons: f.waiting });
        logger.warning(`Waiting ${desc.noun} file ${name}/${f.file}: ${f.waiting.join("; ")}`);
      } else if (f.errors?.length) {
        summary.refused.push({ file: f.file, reasons: f.errors });
        logger.warning(`Refused ${desc.noun} file ${name}/${f.file}: ${f.errors.join("; ")}`);
      }
      continue;
    }
    if (f.ignored?.length) summary.ignored.push({ file: f.file, keys: f.ignored });
    // what the file may not set taken out, each said (a usage another repository holds)
    if (desc.adjust) {
      const adjusted = await desc.adjust(f.object, name);
      f.object = adjusted.object;
      summary.notes.push(...adjusted.notes.map((n) => `${f.file}: ${n}`));
    }
    const row = own.get(f.file);
    // a secret the file does not give : the database's stays, said in the pull output
    const before = f.adopt || row;
    if (before && (desc.secrets || []).some((s) => !given(f.raw?.[s]) && given(before[s]))) summary.secretsKept.push(f.object.name);
    try {
      // a field the file no longer declares : out of the app too (the value a new object gets)
      const removed = before && desc.store.removed ? await desc.store.removed(before, f.object) : {};
      if (Object.keys(removed).length) f.object = { ...f.object, ...removed };
      if (f.adopt) {
        // git's version replaces the app's definition ; what runs it stays
        await desc.store.adopt(f.adopt, f.object, name, f.repoFile ?? f.file);
        summary.matched.push(f.object.name);
        logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${f.object.name}' of the app now follows ${name}/${f.file}: git's version replaced it`);
      } else if (row) {
        if (!Object.keys(removed).length && !desc.store.changed(row, f.object)) {
          summary.unchanged++;
          continue;
        }
        await desc.store.update(row, f.object);
        summary.updated++;
      } else {
        await desc.store.insert(f.object, name, f.repoFile ?? f.file);
        summary.created++;
      }
    } catch (e) {
      // two files swapping their names in one pull, a value the model refuses, or an object made
      // meanwhile : said, the others go on ; its name not read in, as a refused file's (an
      // activation keeps the app's object of that name, never a second file beside it)
      summary.unread.push({ name: f.object.name, file: f.file });
      summary.refused.push({ file: f.file, reasons: [`not saved: ${e.message || e}`] });
      logger.warning(`Could not save the ${desc.noun} of ${name}/${f.file}: ${e.message || e}`);
    }
  }
  if (summary.created || summary.updated || summary.deleted || summary.matched.length || relinked) CrudModel.changed(desc.model);
  logger.info(
    `${titleOf(desc)} of repository '${name}': ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.refused.length} refused${summary.waiting.length ? `, ${summary.waiting.length} waiting` : ""}`,
  );
  return summary;
}

/**
 * What a sync did, as lines for the repository's pull output : the counts, each refused or waiting
 * file with why, the fields a file gives that the app keeps but does not use, and the objects
 * whose secrets stay the database's.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   summary (object): syncRepository's result.
 *
 * Returns:
 *   string: the lines, starting with a newline.
 */
/**
 * An empty sync summary.
 *
 * Returns:
 *   object: { created, updated, deleted, unchanged, matched, refused, waiting, ignored,
 *     secretsKept, notes, unread (the names refused or waiting files declare : [{ name, file }]),
 *     unlinked (the objects a reset unlinked : [name]) }.
 */
/**
 * The flags one object at most has (descriptor.oneOnly : the default runner of a type, the active
 * mail channel, the provider of a type used for sign-in, the disclaimer version in force) that
 * several files of a pull give, as the config seed refuses them (lib/seed-schema.js
 * assertSingletonFlags) : applied from none of them, each object keeping the value it has (a new
 * one without it), the one holding it now keeping it even when its file takes it off in the same
 * pull (never none left with it), the rest of each file applied - the pull changes nothing of that
 * flag until one file only gives it, and the next pull is the same. Said in the pull output, with
 * the one that keeps it.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   files (object[]): the files read (readFiles), their objects changed in place.
 *   own (Map): the repository's objects, by file.
 *   summary (object): the sync's summary, its notes added to.
 *   name (string): the repository.
 *
 * Returns:
 *   void
 */
function oneOnlyClashes(desc, files, own, summary, name) {
  const on = (v) => v === true || (v !== false && v !== null && v !== undefined && !!Number(v));
  for (const rule of desc.oneOnly || []) {
    const groups = new Map();
    for (const f of files) {
      if (!f.object || !on(f.object[rule.field]) || (rule.when && !rule.when(f.object))) continue;
      const scope = rule.by ? String(f.object[rule.by] ?? "") : "";
      groups.set(scope, [...(groups.get(scope) || []), f]);
    }
    for (const [scope, list] of groups) {
      if (list.length < 2) continue;
      for (const f of list) {
        const before = f.adopt || own.get(f.file);
        f.object = { ...f.object, [rule.field]: before ? on(before[rule.field]) : false };
      }
      // the one holding it now whose file takes it off in the same pull : it keeps it too - the
      // flag changes not at all until one file only gives it, never left on none of them
      const keeps = files.filter((f) => {
        if (!f.object || list.includes(f) || on(f.object[rule.field]) || (rule.when && !rule.when(f.object))) return false;
        if (rule.by && String(f.object[rule.by] ?? "") !== scope) return false;
        const before = f.adopt || own.get(f.file);
        return !!before && on(before[rule.field]);
      });
      for (const f of keeps) f.object = { ...f.object, [rule.field]: true };
      const what = `${rule.label}${rule.by ? ` (${rule.by} ${scope})` : ""}`;
      const kept = keeps.length ? `${keeps.map((f) => f.file).join(", ")} keeps it until then` : `the ${desc.noun} holding it now, if any, keeps it until then`;
      const line = `${rule.field} not applied: ${list.map((f) => f.file).join(", ")} each say it, one ${desc.noun} at most is ${what} - say it in one file only (${kept})`;
      summary.notes.push(line);
      logger.warning(`${titleOf(desc)} of repository '${name}': ${line}`);
    }
  }
}

function newSummary() {
  return { created: 0, updated: 0, deleted: 0, unchanged: 0, matched: [], refused: [], waiting: [], ignored: [], secretsKept: [], skipped: [], notes: [], unread: [], unlinked: [] };
}

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
 * What a repository's working tree holds of a type now, as one text : its commit and each of the
 * type's files with its size and time. Two reads of the tree give the same stamp only when no
 * pull (of any node : the volume is shared) changed it between them.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   string|null: the stamp, null when the tree cannot be read (never the same as another).
 */
function treeStamp(desc, name) {
  try {
    const dir = Repo.folderOf(name);
    const files = desc.file ? [desc.file] : desc.listFile ? [desc.listFile] : filesIn(dir, desc.folder);
    const parts = files.map((file) => {
      const st = fs.statSync(path.join(dir, file), { throwIfNoEntry: false });
      return st ? `${file}:${st.size}:${st.mtimeMs}` : `${file}:-`;
    });
    return [headOf(dir), ...parts].join("\n");
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
  const now = treeStamp(desc, name);
  return now !== null && now === kept.stamp ? kept.summary : null;
}

/**
 * Syncs one type of a repository, its lines for the pull output ; a failure is said there too,
 * never thrown.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): syncRepository's ({ reset }).
 *
 * Returns:
 *   Promise<string>: the lines.
 */
export async function syncText(desc, name, opts = {}) {
  try {
    const summary = await syncRepository(desc, name, opts);
    synced.set(syncedKey(desc, name), { summary, stamp: treeStamp(desc, name) });
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
 * the repositories a repositories.yaml made are there for them. A clone still running is said,
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
 * what it did, for its pull output. Its first clone takes the app's objects of each type
 * instead (activation : a repository not cloned when its usage was turned on takes them once it
 * is). A failure is said there too, never thrown : the git operation itself worked.
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
  const keys = objectTypesOf(await usagesNow(name, repo));
  let out = "";
  for (const [i, key] of keys.entries()) {
    const desc = await descriptorOf(key);
    out += opts.activate ? await activatedText(desc, name, { reset: opts.reset }) : await syncText(desc, name, { reset: opts.reset });
    // the repositories its repositories.yaml just made : cloned before the types read after them
    // (a schedule naming a form of one of them)
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
 *   - a name a file of the repository declares that is not read in (refused, waiting) : a second
 *     file of its name would be refused on every pull ; the object follows that file once it is
 *     read in
 *   - an object the fresh clone just read unlinked (its file not in the repository as cloned
 *     again : deleted in git, or never pushed) : written back, a file deleted in git would come
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
    for (const u of s.unread || []) stay.set(nameKey(u.name), `${name}/${u.file} has its name but is not read in (refused or waiting): it follows that file once it is`);
    for (const n of s.unlinked || []) {
      stay.set(nameKey(n), `its file is not in the repository as cloned again (deleted in git, or never pushed): kept in the app, not written back`);
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
 * A type's files in a repository's working copy as they are now, each parsed, changing nothing :
 * how many give an object, how many the type does not import, the names they declare - read in or
 * not (a refused or waiting file's too : an object of the app of that name is never written beside
 * it) - and the files refused for what they are (a link leading outside, a list file that cannot be
 * read).
 *
 * Args:
 *   desc (object): the type's descriptor (a folder or a list type).
 *   name (string|null): the repository ; nothing read when it is not cloned.
 *
 * Returns:
 *   Promise<object>: { files, skipped (counts), names (Set of nameKey), refused: [{ file, reasons }] }.
 */
async function filesNow(desc, name) {
  const fileNames = new Set();
  let files = 0;
  let skipped = 0;
  const refused = [];
  if (cloned(name)) {
    const ctx = await desc.previewContext?.();
    // a list file's entries, or each file of the folder ; a list file that cannot be read (a link
    // that leads outside the repository) is said refused, as its sync refuses it
    let parsedFiles = [];
    const links = [];
    try {
      parsedFiles = desc.listFile
        ? readListFile(desc, name) || []
        : filesIn(Repo.folderOf(name), desc.folder, undefined, links).map((file) => {
            try {
              return desc.parse(fs.readFileSync(path.join(Repo.folderOf(name), file), "utf8"), ctx);
            } catch {
              return {};
            }
          });
    } catch (e) {
      refused.push({ file: desc.listFile, reasons: [e.message || String(e)] });
    }
    // a file that is a link leading outside, or a folder : refused, as its sync refuses it
    refused.push(...links.map((l) => ({ file: l.file, reasons: [l.reason] })));
    for (const parsed of parsedFiles) {
      try {
        // one the type does not import (an announcement already ended) : counted apart
        if (parsed.object && desc.notImported?.(parsed.object, name)) skipped++;
        else if (parsed.object) {
          files++;
          fileNames.add(nameKey(parsed.object.name));
        } else if (declaredName(desc, parsed)) {
          // a file refused declaring a name : the app's object of that name is not written beside it
          fileNames.add(nameKey(declaredName(desc, parsed)));
        }
      } catch {
        // an unreadable file is refused by the sync, said then
      }
    }
  }
  return { files, skipped, names: fileNames, refused };
}

/**
 * What making a repository a type's repository would do, changing nothing : the app's objects it
 * would take (written as files, those whose secret stays in the database said), those that stay
 * in the app and why, the files whose name an app's object has (git's version would win), and
 * what it holds now.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string|null): the repository (its working copy read when it is cloned), null for one
 *     not made yet.
 *
 * Returns:
 *   Promise<object>: { repository, active, written: [name], withoutSecret: [name], kept: [{ name,
 *     reason }], clashes: [name], files, linked, ...what the type adds (descriptor.previewExtra) }.
 */
export async function preview(desc, name) {
  if (desc.file) return previewSingle(desc, name);
  const list = await candidates(desc, name);
  // the files there are now, by name (a pull before the activation may bring more)
  const { files, skipped, names: fileNames, refused } = await filesNow(desc, name);
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
 * not yet), reads its files in (a file named as an app's object takes it over, git wins), then
 * writes every other object of the app to it as a new file - without its secrets, which stay in
 * the database - for its Push. What cannot go stays in the app.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { pull (false : the caller pulled or cloned it just now) }.
 *
 * Returns:
 *   Promise<object>: { repository, pull, created, matched: [name], written: [name],
 *     withoutSecret: [name], kept: [{ name, reason }], refused, waiting, ...what the type adds }.
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
  return withWriteClaim(name, () => (desc.file ? activateSingle(desc, name, report) : activateFolder(desc, name, report)));
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
 *   opts (object): activateFolder's ({ reset }).
 *
 * Returns:
 *   Promise<string>: the lines.
 */
async function activatedText(desc, name, opts = {}) {
  try {
    const report = await asHolding(name, () => (desc.file ? activateSingle : activateFolder)(desc, name, newReport(name), opts));
    return ["", `Now holds ${activationText(desc, report)}`, ...detailLines(report)].join("\n");
  } catch (e) {
    logger.error(`Repository '${name}' could not take ${holdingOf(desc)}: ${e.message || e}`);
    return `\n${titleOf(desc)} could not follow the usage: ${e.message || e}`;
  }
}

/**
 * Makes a repository a folder or a list type's (pulled already, its write claim held) : its files
 * read in, git winning on a name, then the app's other objects written to it.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   report (object): the report so far (activate's), filled in.
 *   opts (object): { reset (true : cloned where there was no working tree - an object of it whose
 *     file is not there is unlinked, never deleted : syncRepository's) }.
 *
 * Returns:
 *   Promise<object>: the report.
 */
async function activateFolder(desc, name, report, opts = {}) {
  // step 2 : its files read in (again : the pull may not have run), git wins on a name ; what the
  // pull before it read in is said with it - that read found nothing left to take
  const summary = await syncRepository(desc, name, { reset: opts.reset });
  const pulled = takeSynced(desc, name) || newSummary();
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
  // step 3 : the app's other objects, each a new file - none beside a file of its name not read in,
  // none the fresh clone unlinked (the pull before it, or the read above)
  const list = await candidates(desc, name, stayReasons(name, [pulled, summary]));
  // written in one step (a list file at once, else a file each), its returns ending that step only
  await (async () => {
    // a type kept as a list in one file : every candidate an entry of it, added at its end
    if (desc.listFile) {
      for (const c of list.filter((x) => x.reason)) report.kept.push(keptOf(desc, c));
      const written = list.filter((x) => !x.reason);
      if (!written.length) return;
      const abs = listFileOf(desc, name);
      const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      fs.writeFileSync(abs, appendListEntries(text, desc.listKey, written.map((c) => c.object), desc.keyOrder), "utf8");
      for (const c of written) {
        await desc.linkCandidate(c, name, desc.listFile);
        report.written.push(c.row.name);
        if (c.withoutSecret) report.withoutSecret.push(c.row.name);
      }
      return;
    }
    for (const c of list) {
      if (c.reason) {
        report.kept.push(keptOf(desc, c));
        continue;
      }
      try {
        const file = writeNewFile(desc, name, c.row.name, desc.newFileText(c));
        await desc.linkCandidate(c, name, file);
        report.written.push(c.row.name);
        if (c.withoutSecret) report.withoutSecret.push(c.row.name);
      } catch (e) {
        report.kept.push({ ...keptOf(desc, c), reason: `not written: ${e.message || e}`, code: "notWritten", error: e.message || String(e) });
      }
    }
  })();
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
  // a type kept in one file has nothing to unlink but itself : the app keeps its values
  report.unlinked = desc.file ? 1 : await unlinkRepository(desc, name);
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
 * What an activation did, as the log and the pull output say it after "now holds" : a type kept in
 * one file, written to it or read from it ; another, how many objects were read, replaced, written
 * and kept in the app (and why).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   report (object): what activate answered.
 *
 * Returns:
 *   string: the text (General (written to general.yaml, waiting for Push)).
 */
function activationText(desc, report) {
  if (desc.file) return `${holdingOf(desc)} (${report.written.length ? `written to ${desc.file}, waiting for Push` : `read from ${desc.file}`})`;
  const kept = report.kept || [];
  const withoutSecret = report.withoutSecret || [];
  return `${holdingOf(desc)}: ${report.created} read from its files, ${report.matched.length} replaced by a file of the same name, ${report.deleted ? `${report.deleted} removed (their files gone), ` : ""}${report.written.length} written to it (waiting for Push${withoutSecret.length ? `, ${withoutSecret.length} without their secrets, kept in the database` : ""}), ${kept.length} kept in the app${kept.length ? ` (${kept.map((k) => `${k.name}: ${k.reason}`).join("; ")})` : ""}`;
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
    else if (r.activated) out += ["", `Now holds ${activationText(desc, r.activated)}`, ...detailLines(r.activated)].join("\n");
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
 *     off again) }.
 */
async function undoActivation(desc, name, e) {
  const why = `Repository '${name}' is busy (a pull or a push is running)`;
  try {
    await mysql.do("UPDATE AnsibleForms.`repositories` SET ? WHERE name = ?", [{ [desc.flag]: 0 }, name]);
    logger.warning(`${why}: the usage for ${holdingOf(desc)} is turned off again, nothing was handed over (${e.message || e})`);
    return { error: `${why}: the usage was not turned on, nothing was read in nor written - save it again in a moment`, turnedOff: true };
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
 * A new object made in the app : written to its type's repository as a new file and linked to it,
 * for its Push - without its secrets, which stay in the database. Nothing when the type has no
 * repository (or it is not cloned), or the object stays in the app (descriptor.candidateOf).
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   id (number): the new object.
 *
 * Returns:
 *   Promise<object|null>: { repository, file, withoutSecret }, null when it stays in the app (a
 *     file of the repository declares its name : it follows that file once it is read in).
 */
export async function appCreated(desc, id) {
  const repository = await activeRepository(desc);
  if (!repository || !cloned(repository)) return null;
  const row = await desc.store.byId(id);
  if (!row || desc.store.classify(row, repository) !== "adoptable") return null;
  const c = await desc.candidateOf(row, null, await takenNames(desc));
  if (c.reason) return null;
  return withWriteClaim(repository, async () => {
    // a file of the repository declaring its name, read in or not (refused, waiting, not pulled
    // yet) : kept in the app, never written beside it - a second file of that name would be refused
    // on every pull, and the first one too once it is fixed ; it follows that file once it is read in
    const declared = (await filesNow(desc, repository)).names;
    if (declared.has(nameKey(row.name))) {
      logger.warning(`Kept ${desc.noun} '${row.name}' in the app, not written to ${repository}: a file of the repository has its name - it follows that file once it is read in`);
      return null;
    }
    const file = desc.listFile ? writeListEntry(desc, repository, c.object) : writeNewFile(desc, repository, row.name, desc.newFileText(c));
    await desc.linkCandidate(c, repository, file);
    CrudModel.changed(desc.model);
    logger.info(`Wrote ${desc.noun} '${row.name}' to ${repository}/${file}${c.withoutSecret ? ", without its secret (kept in the database)" : ""}`);
    return { repository, file, withoutSecret: !!c.withoutSecret };
  });
}

/**
 * An object of a repository edited in the app : only the fields the edit changed written into its
 * file (descriptor.fileEdits : the object before and after it), the rest of it - the keys the app does not use, its ${ENV}
 * references, its comments - kept ; a file gone meanwhile written again, whole. Its secrets are
 * never written.
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
  // a type kept in one file : its own mode, before being the app's object before the edit
  if (desc.file) return appUpdatedSingle(desc, before);
  if (!before?.repository || !before.repo_file) return false;
  const row = await desc.store.byId(id);
  if (!row) return false;
  // where it is linked now, read after the save (under the claim) : a pull that held the claim
  // before it may have moved its file or unlinked it - its old file is never written back
  const at = "repo_file" in row ? row : before;
  if (!at.repository || !at.repo_file) return false;
  // a type kept as a list in one file : its entry edited, field by field (added when it is gone)
  if (desc.listFile) {
    return withWriteClaim(at.repository, async () => {
      const abs = listFileOf(desc, at.repository);
      const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      const whole = (await desc.candidateOf({ ...row, repository: null })).object;
      const next = updateListEntry(text, desc.listKey, before.name, desc.entryEdits(row, before), desc.keyOrder, whole);
      if (next === text) return false;
      fs.writeFileSync(abs, next, "utf8");
      logger.info(`Saved ${desc.noun} '${row.name}' into ${at.repository}/${desc.listFile}`);
      return true;
    });
  }
  return withWriteClaim(at.repository, async () => {
    const abs = fileOf(desc, at.repository, at.repo_file);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    const next = text === null ? desc.newFileText(await desc.candidateOf({ ...row, repository: null })) : desc.fileEdits(text, row, before);
    if (next === text) return false;
    fs.writeFileSync(abs, next, "utf8");
    logger.info(`Saved ${desc.noun} '${row.name}' into ${at.repository}/${at.repo_file}`);
    return true;
  });
}

/**
 * An object of a repository deleted in the app : its file goes too, for the repository's Push.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   before (object): the object as it was (its repository and file).
 *
 * Returns:
 *   Promise<boolean>: whether a file was removed.
 */
export async function appDeleted(desc, before) {
  if (!before?.repository || !before.repo_file) return false;
  return withWriteClaim(before.repository, async () => {
    // a type kept as a list in one file : its entry removed, the others kept
    if (desc.listFile) {
      const abs = listFileOf(desc, before.repository);
      if (fs.existsSync(abs)) fs.writeFileSync(abs, removeListEntry(fs.readFileSync(abs, "utf8"), desc.listKey, before.name), "utf8");
      logger.info(`Removed ${desc.noun} '${before.name}' from ${before.repository}/${desc.listFile}`);
      return true;
    }
    // its file now : a pull that held the claim before the delete may have moved it
    const file = fileNaming(desc, before.repository, before);
    if (!file) return false;
    fs.rmSync(fileOf(desc, before.repository, file), { force: true });
    logger.info(`Deleted the file ${before.repository}/${file} of ${desc.noun} '${before.name}'`);
    return true;
  });
}

/**
 * The file of an object read before a pull that may have moved it (renamed in git) : the file it
 * was linked to while that file still names it - or names nothing that can be read - else the file
 * of its folder that names it now.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   repository (string): the repository.
 *   before (object): the object as it was read (its name and repo_file).
 *
 * Returns:
 *   string|null: the file, relative to the repository ; null when no file names it.
 */
function fileNaming(desc, repository, before) {
  const dir = Repo.folderOf(repository);
  const nameIn = (file) => {
    try {
      const parsed = desc.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return (parsed.object || parsed.raw)?.name;
    } catch {
      return undefined;
    }
  };
  if (fs.existsSync(fileOf(desc, repository, before.repo_file))) {
    const named = nameIn(before.repo_file);
    if (named === undefined || nameKey(named) === nameKey(before.name)) return before.repo_file;
  }
  return filesIn(dir, desc.folder).find((file) => nameKey(nameIn(file)) === nameKey(before.name)) || null;
}

// ===========================================================================
// THE TYPES KEPT IN ONE FILE
// ===========================================================================
// The chat assistant's settings, the System > General settings, the branding : the app has one
// object of each, its repository one file of it (desc.file, at its root : chat-assistant.yaml), and the
// files the YAML names beside it (the branding's images). The same rules as the folder types :
// a pull applies the file (git wins), turning the type on writes the app's values to it when it
// has none (and applies it when it has one), an app edit writes only the changed fields, the
// secrets are ${ENV} references only, turning it off reads it once more and the app keeps its
// values. A file removed changes nothing in the app.

/**
 * The file of a single-file type in a repository.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   string: its absolute path.
 *
 * Raises:
 *   Error: a link that leads outside the repository.
 */
const singleFileOf = (desc, name) => fileIn(Repo.folderOf(name), ".", desc.file, /./);

/**
 * Writes a single-file type's YAML and the files beside it : a file whose content is the same is
 * left as it is, a file beside it the object no longer names removed. A file beside it is written
 * where the YAML names it (own) ; any other file already there with other bytes is not the type's
 * (a README's image, a logo of something else) : refused before anything is written, never
 * overwritten.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   out (object): { text (null : the YAML left as it is), extraFiles: [{ name, buffer, own }] }.
 *   gone (string[]): the files beside it the YAML named before and no longer does.
 *
 * Returns:
 *   boolean: whether anything was written.
 *
 * Raises:
 *   Error: a file beside it to write that is there already, with other bytes, and not the type's ;
 *     or a path outside the repository.
 */
function writeSingle(desc, name, out, gone = []) {
  const dir = path.dirname(singleFileOf(desc, name));
  const extras = (out.extraFiles || []).map((extra) => ({ ...extra, abs: fileBeside(dir, extra.name) }));
  // step 1 : nothing written when one of them would overwrite a file that is not the type's
  for (const extra of extras) {
    if (extra.own || !fs.existsSync(extra.abs) || Buffer.compare(fs.readFileSync(extra.abs), extra.buffer) === 0) continue;
    throw new Error(`'${extra.name}' is in repository '${name}' already and is not the one ${desc.file} names: rename or remove it, or name the image in ${desc.file}`);
  }
  // step 2 : the YAML, then the files beside it
  let written = false;
  const abs = singleFileOf(desc, name);
  if (out.text !== null && out.text !== undefined && (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== out.text)) {
    fs.writeFileSync(abs, out.text, "utf8");
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
    const file = fileBeside(dir, old);
    if (kept.has(file) || !fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    written = true;
  }
  return written;
}

/**
 * Reads a single-file type's file into the app : checked, what it names there, then applied as
 * the app's own save applies it - only when it changes something. No file : nothing changes.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<object>: the summary, as syncRepository's ; its notes what the apply said.
 */
async function syncSingle(desc, name) {
  const summary = newSummary();
  const abs = singleFileOf(desc, name);
  if (!fs.existsSync(abs)) {
    summary.notes.push(`No ${desc.file} in the repository: the app keeps ${holdingOf(desc)} as it is`);
    return summary;
  }
  const { errors, object: raw } = parseMapFile(fs.readFileSync(abs, "utf8"));
  const checked = errors.length ? { errors } : await desc.check(raw, { dir: path.dirname(abs) });
  if (checked.errors.length) {
    summary.refused.push({ file: desc.file, reasons: checked.errors });
    logger.warning(`Refused ${desc.noun} file ${name}/${desc.file}: ${checked.errors.join("; ")}`);
    return summary;
  }
  const waiting = await waitingOf(desc, checked.object);
  if (waiting.length) {
    summary.waiting.push({ file: desc.file, reasons: waiting });
    return summary;
  }
  const current = await desc.current();
  // the config seed's whole object (the chat assistant's settings) : not applied, said
  if (desc.heldBySeed(current)) {
    summary.notes.push(`Kept by the config seed, not applied: ${desc.file}`);
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
    logger.notice(`Applied ${name}/${desc.file}: the app follows git for ${holdingOf(desc)} from now on`);
  } catch (e) {
    summary.refused.push({ file: desc.file, reasons: [`not saved: ${e.message || e}`] });
    logger.warning(`Could not apply ${name}/${desc.file}: ${e.message || e}`);
  }
  return summary;
}

/**
 * What making a repository a single-file type's would do, changing nothing : the app's values
 * written to it when it has no file (said when its secrets stay in the database), else the file
 * applied, git winning.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string|null): the repository.
 *
 * Returns:
 *   Promise<object>: as preview's.
 */
async function previewSingle(desc, name) {
  // its file a link that leads outside the repository : said refused, as its sync refuses it ;
  // nothing written over it
  let exists = false;
  let refused = null;
  try {
    exists = cloned(name) && fs.existsSync(singleFileOf(desc, name));
  } catch (e) {
    refused = [{ file: desc.file, reasons: [e.message || String(e)] }];
  }
  const current = await desc.current();
  const { withoutSecret } = desc.fileOf(current);
  const active = (await activeRepository(desc)) || null;
  // written when the repository has no file, unless the config seed holds the whole object
  const writes = !exists && !refused && !desc.heldBySeed(current);
  return {
    repository: name || null,
    active,
    written: writes ? [desc.title] : [],
    withoutSecret: writes && withoutSecret ? [desc.title] : [],
    // what stays in the app (the branding fields the config seed manages)
    kept: desc.kept(current),
    clashes: exists ? [desc.title] : [],
    files: exists ? 1 : 0,
    ...(refused ? { refused } : {}),
    linked: name && active === name ? 1 : 0,
  };
}

/**
 * Makes a repository a single-file type's (pulled already) : its file applied when it has one, git
 * winning, else the app's values written to it, for its Push.
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
  // what the pull before it read in : its file applied then, said by the read below as well
  takeSynced(desc, name);
  const current = await desc.current();
  report.kept = desc.kept(current);
  if (desc.heldBySeed(current)) {
    // the config seed's whole object : it stays with the seed, nothing written nor applied
    logger.notice(`Repository '${name}' now holds ${holdingOf(desc)}, kept by the config seed while it declares them: nothing written to ${desc.file}`);
    return report;
  }
  if (fs.existsSync(singleFileOf(desc, name))) {
    const summary = await syncSingle(desc, name);
    report.refused = summary.refused;
    report.waiting = summary.waiting;
    report.notes = summary.notes;
    if (!summary.refused.length && !summary.waiting.length) report.matched = [desc.title];
  } else {
    const out = desc.fileOf(await desc.current());
    await withWriteClaim(name, async () => writeSingle(desc, name, out));
    report.written = [desc.title];
    if (out.withoutSecret) report.withoutSecret = [desc.title];
  }
  logger.notice(`Repository '${name}' now holds ${activationText(desc, report)}`);
  return report;
}

/**
 * A single-file type edited in the app : only the fields the edit changed written into its file,
 * and the files beside it that changed ; the file written whole when it is gone. Nothing when
 * the type has no repository.
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
  return withWriteClaim(repository, async () => {
    const abs = singleFileOf(desc, repository);
    const out = fs.existsSync(abs) ? desc.fileEdits(fs.readFileSync(abs, "utf8"), after, before) : desc.fileOf(after);
    // the files beside it the edit no longer names : those the type says (only the images the YAML
    // named and the edit changed) ; none when the YAML is gone - a file it does not name is never
    // the type's to remove
    const gone = out.gone ?? [];
    const written = writeSingle(desc, repository, out, gone);
    if (written) logger.info(`Saved ${holdingOf(desc)} into ${repository}/${desc.file}`);
    return written;
  });
}

// ===========================================================================
// THE SEED : WHAT IT DECLARES OF A TYPE
// ===========================================================================

/**
 * Applies what the config seed declares of a type (the branding, the announcements, the
 * disclaimer : sections the seed reads through the same descriptors as a repository) : checked
 * as a file is (its references resolved by the seed already), then a single-file type applied,
 * a folder type's objects made or changed by name - never one a repository holds. Nothing is linked
 * to a repository.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   declared (object|object[]): the section's object (a single-file type), or its items.
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
  if (desc.file) {
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
  fileOf,
  writeNewFile,
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
