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
import logger from "../logger.js";
import Errors from "../errors.js";
import mysql from "../../models/db.model.js";
import CrudModel from "../../models/crud.model.js";
import Repo from "../../models/repo.model.js";
import Repository from "../../models/repository.model.js";
import { filesIn, fileIn, fileNameFor, parseMapFile, parseListFile, appendListEntries, updateListEntry, removeListEntry } from "./yamlFile.js";
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
const cloned = (name) => !!name && Repo.isValidName(name) && fs.existsSync(Repo.folderOf(name));

/**
 * Runs a write in a repository's working tree under its write claim (no pull, sync or clone on
 * it meanwhile).
 *
 * Args:
 *   repository (string): the repository.
 *   write (function): the write.
 *
 * Returns:
 *   Promise<any>: what the write returns.
 */
export async function withWriteClaim(repository, write) {
  const prior = await Repository.claimForWrite(repository);
  try {
    return await write();
  } finally {
    if (prior !== undefined) await Repository.releaseWrite(repository, prior).catch((e) => logger.error(`Failed to release write-lock on '${repository}': ${e.message}`));
  }
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
  const abs = path.join(Repo.folderOf(repository), desc.listFile);
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
  fs.mkdirSync(folder, { recursive: true });
  const file = fileNameFor(name, (f) => fs.existsSync(path.join(folder, f)), desc.noun);
  fs.writeFileSync(path.join(folder, file), text, "utf8");
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
  // a type kept as a list in one file : its entries, each as a file of its own would be
  const files = desc.listFile ? readListFile(desc, name) : filesIn(repoDir, desc.folder).map((file) => {
    let text;
    try {
      text = fs.readFileSync(path.join(repoDir, file), "utf8");
    } catch (e) {
      return { file, errors: [`cannot be read: ${e.code || e.message}`], object: null, absent: false };
    }
    return { file, ...desc.parse(text, ctx) };
  });
  if (files === null) return null;
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
  const abs = path.join(Repo.folderOf(name), desc.listFile);
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
 * Reads a type's files of a repository into its table : a new file makes an object, a changed one
 * changes it, a removed one (or one saying state: absent) removes it - unless something uses it
 * (descriptor.usersOf) or it can never be deleted (descriptor.undeletable), then it is kept and
 * the refusal said. A file renamed (its object's name given by a new file) moves its object to it.
 * A refused file - not valid, a name another object has - changes nothing : an object it made before stays as it was, a new one is
 * not made. A file that names an object not there yet waits, the same way. Where the file gives
 * no secret, the database's stays.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   opts (object): { context (the descriptor's context, read when not given) }.
 *
 * Returns:
 *   Promise<object>: { created, updated, deleted, unchanged (counts), matched: [name], refused:
 *     [{ file, reasons }], waiting: [{ file, reasons }], ignored: [{ file, keys }], secretsKept:
 *     [name], skipped: [{ file, name, reason }] (files the type does not import : descriptor.notImported),
 *     notes }.
 */
export async function syncRepository(desc, name, opts = {}) {
  // a type kept in one file : its own mode
  if (desc.file) return syncSingle(desc, name);
  const summary = newSummary();
  const ctx = opts.context !== undefined ? opts.context : await desc.context?.();
  // step 1 : the files, read and checked on their own, and what they name
  const files = await readFiles(desc, name, ctx);
  // a type kept as a list in one file, the repository without that file : the app keeps its objects
  if (files === null) {
    summary.notes.push(`No ${desc.listFile} in the repository: the app keeps ${holdingOf(desc)} as it has them`);
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
  // step 3 : the names, in file order : the first file to name an object has it ; a file that has
  // no object yet and names one of the app takes it over
  for (const f of files) {
    if (!f.object) continue;
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
  for (const [file, row] of own) {
    if (!files.some((f) => f.file === file)) gone.set(nameKey(row.name), file);
  }
  for (const f of files) {
    if (!f.object || own.has(f.file) || f.adopt) continue;
    const from = gone.get(nameKey(f.object.name));
    if (from === undefined) continue;
    gone.delete(nameKey(f.object.name));
    const row = own.get(from);
    await desc.store.link(row.id, name, f.repoFile ?? f.file);
    own.delete(from);
    own.set(f.file, { ...row, repo_file: f.repoFile ?? f.file });
    logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${row.name}' follows its file, renamed in git: ${name}/${from} is now ${name}/${f.file}`);
  }
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
    await desc.store.remove(row);
    const skipped = files.find((f) => f.file === file && f.skipped);
    logger.notice(`Removed ${desc.noun} '${row.name}': ${skipped ? `its file ${name}/${file} says it is ${skipped.skipped.reason}` : `its file ${name}/${file} is gone`}`);
    summary.deleted++;
  }
  for (const f of files) {
    if (!f.object) {
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
      if (f.adopt) {
        // git's version replaces the app's definition ; what runs it stays
        await desc.store.adopt(f.adopt, f.object, name, f.repoFile ?? f.file);
        summary.matched.push(f.object.name);
        logger.notice(`${desc.noun.charAt(0).toUpperCase()}${desc.noun.slice(1)} '${f.object.name}' of the app now follows ${name}/${f.file}: git's version replaced it`);
      } else if (row) {
        if (!desc.store.changed(row, f.object)) {
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
      // meanwhile : said, the others go on
      summary.refused.push({ file: f.file, reasons: [`not saved: ${e.message || e}`] });
      logger.warning(`Could not save the ${desc.noun} of ${name}/${f.file}: ${e.message || e}`);
    }
  }
  if (summary.created || summary.updated || summary.deleted || summary.matched.length) CrudModel.changed(desc.model);
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
 *     secretsKept, notes }.
 */
function newSummary() {
  return { created: 0, updated: 0, deleted: 0, unchanged: 0, matched: [], refused: [], waiting: [], ignored: [], secretsKept: [], skipped: [], notes: [] };
}

export function summaryText(desc, summary) {
  const waiting = summary.waiting || [];
  const lines = [
    `${titleOf(desc)}: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.unchanged} unchanged, ${summary.refused.length} refused${waiting.length ? `, ${waiting.length} waiting` : ""}`,
  ];
  if (summary.matched.length) lines.push(`Replaced by the file of the same name: ${summary.matched.join(", ")}`);
  for (const r of summary.refused) lines.push(`Refused ${r.file}: ${r.reasons.join("; ")}`);
  for (const w of waiting) lines.push(`Waiting ${w.file}: ${w.reasons.join("; ")} (read again when it is pulled)`);
  for (const i of summary.ignored) lines.push(`${i.file}: kept in the file, not used by AnsibleForms: ${i.keys.join(", ")}`);
  if (summary.secretsKept?.length) lines.push(`Not in git, their secrets kept from the database: ${summary.secretsKept.join(", ")}`);
  // the files not imported, by why : an information, not a refusal
  const skipped = summary.skipped || [];
  for (const reason of [...new Set(skipped.map((k) => k.reason))]) {
    lines.push(`Not imported, ${reason}: ${skipped.filter((k) => k.reason === reason).map((k) => `${k.name} (${k.file})`).join(", ")}`);
  }
  lines.push(...(summary.notes || []));
  return "\n" + lines.join("\n");
}

/**
 * Syncs one type of a repository, its lines for the pull output ; a failure is said there too,
 * never thrown.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<string>: the lines.
 */
export async function syncText(desc, name) {
  try {
    return summaryText(desc, await syncRepository(desc, name));
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
 * Syncs every object type of a repository after git changed its working tree (a pull, a clone,
 * a reset), in APPLY_ORDER, then reads again the types that name them in other repositories :
 * what it did, for its pull output. A failure is said there too, never thrown : the git operation
 * itself worked.
 *
 * Args:
 *   name (string): the repository.
 *   repo (object): its row (its use_for_* flags).
 *
 * Returns:
 *   Promise<string>: the lines for the pull output.
 */
export async function afterGit(name, repo) {
  const keys = objectTypesOf(repo);
  let out = "";
  for (const key of keys) out += await syncText(await descriptorOf(key), name);
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
 *
 * Returns:
 *   Promise<object[]>: { row, ... } to write, or { row, reason }.
 */
async function candidates(desc, name = null) {
  return Promise.all((await desc.store.appRows()).map((row) => desc.candidateOf(row, name)));
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
  const fileNames = new Set();
  let files = 0;
  let skipped = 0;
  if (cloned(name)) {
    const ctx = await desc.previewContext?.();
    // a list file's entries, or each file of the folder
    const parsedFiles = desc.listFile
      ? readListFile(desc, name) || []
      : filesIn(Repo.folderOf(name), desc.folder).map((file) => {
          try {
            return desc.parse(fs.readFileSync(path.join(Repo.folderOf(name), file), "utf8"), ctx);
          } catch {
            return {};
          }
        });
    for (const parsed of parsedFiles) {
      try {
        // one the type does not import (an announcement already ended) : counted apart
        if (parsed.object && desc.notImported?.(parsed.object, name)) skipped++;
        else if (parsed.object) {
          files++;
          fileNames.add(nameKey(parsed.object.name));
        }
      } catch {
        // an unreadable file is refused by the sync, said then
      }
    }
  }
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
    await Repository.clone(name);
    return "cloned";
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
 */
export async function activate(desc, name, { pull = true } = {}) {
  const report = { repository: name, pull: "", created: 0, matched: [], written: [], withoutSecret: [], kept: [], refused: [], waiting: [] };
  // step 1 : the latest files (a pull of the repository reads them in itself)
  if (pull) report.pull = await pullFor(desc, name, `to take ${holdingOf(desc)}`);
  if (!fs.existsSync(Repo.folderOf(name))) {
    report.pull = report.pull || "not cloned";
    logger.warning(`Repository '${name}' is not cloned yet: ${holdingOf(desc)} will be read from it once it is`);
    return report;
  }
  // a type kept in one file : its own mode
  if (desc.file) return activateSingle(desc, name, report);
  // step 2 : its files read in (again : the pull may not have run), git wins on a name
  const summary = await syncRepository(desc, name);
  report.created = summary.created;
  report.matched = summary.matched;
  report.refused = summary.refused;
  report.waiting = summary.waiting;
  report.skipped = summary.skipped;
  // step 3 : the app's other objects, each a new file
  const list = await candidates(desc, name);
  await withWriteClaim(name, async () => {
    // a type kept as a list in one file : every candidate an entry of it, added at its end
    if (desc.listFile) {
      for (const c of list.filter((x) => x.reason)) report.kept.push(keptOf(desc, c));
      const written = list.filter((x) => !x.reason);
      if (!written.length) return;
      const abs = path.join(Repo.folderOf(name), desc.listFile);
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
        report.kept.push({ ...keptOf(desc, c), reason: `not written: ${e.message || e}` });
      }
    }
  });
  if (desc.reportExtra) Object.assign(report, await desc.reportExtra(name));
  if (report.written.length || report.matched.length) CrudModel.changed(desc.model);
  logger.notice(
    `Repository '${name}' now holds ${holdingOf(desc)}: ${report.created} read from its files, ${report.matched.length} replaced by a file of the same name, ${report.written.length} written to it (waiting for Push${report.withoutSecret.length ? `, ${report.withoutSecret.length} without their secrets, kept in the database` : ""}), ${report.kept.length} kept in the app${report.kept.length ? ` (${report.kept.map((k) => `${k.name}: ${k.reason}`).join("; ")})` : ""}`,
  );
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
      await syncRepository(desc, name);
    } catch (e) {
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
    if (await desc.store.rename(from, to)) CrudModel.changed(desc.model);
  }
}

/**
 * Follows a repository made, or no longer, a type's repository : made one, it takes the app's
 * objects (activate) ; no longer one, its objects are unlinked and stay in the app (deactivate) ;
 * several types at once in APPLY_ORDER, the repository pulled once. What it did is put in
 * opts.report, by type, for the answer. A failure is logged, never thrown : the repository
 * itself was saved.
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
      report[key] = { error: e.message || String(e) };
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
 *   Promise<object|null>: { repository, file, withoutSecret }, null when it stays in the app.
 */
export async function appCreated(desc, id) {
  const repository = await activeRepository(desc);
  if (!repository || !cloned(repository)) return null;
  const row = await desc.store.byId(id);
  if (!row || desc.store.classify(row, repository) !== "adoptable") return null;
  const c = await desc.candidateOf(row);
  if (c.reason) return null;
  return withWriteClaim(repository, async () => {
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
  // a type kept as a list in one file : its entry edited, field by field (added when it is gone)
  if (desc.listFile) {
    return withWriteClaim(before.repository, async () => {
      const abs = path.join(Repo.folderOf(before.repository), desc.listFile);
      const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      const whole = (await desc.candidateOf({ ...row, repository: null })).object;
      const next = updateListEntry(text, desc.listKey, before.name, desc.entryEdits(row, before), desc.keyOrder, whole);
      if (next === text) return false;
      fs.writeFileSync(abs, next, "utf8");
      logger.info(`Saved ${desc.noun} '${row.name}' into ${before.repository}/${desc.listFile}`);
      return true;
    });
  }
  return withWriteClaim(before.repository, async () => {
    const abs = fileOf(desc, before.repository, before.repo_file);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    const next = text === null ? desc.newFileText(await desc.candidateOf({ ...row, repository: null })) : desc.fileEdits(text, row, before);
    if (next === text) return false;
    fs.writeFileSync(abs, next, "utf8");
    logger.info(`Saved ${desc.noun} '${row.name}' into ${before.repository}/${before.repo_file}`);
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
      const abs = path.join(Repo.folderOf(before.repository), desc.listFile);
      if (fs.existsSync(abs)) fs.writeFileSync(abs, removeListEntry(fs.readFileSync(abs, "utf8"), desc.listKey, before.name), "utf8");
      logger.info(`Removed ${desc.noun} '${before.name}' from ${before.repository}/${desc.listFile}`);
      return true;
    }
    fs.rmSync(fileOf(desc, before.repository, before.repo_file), { force: true });
    logger.info(`Deleted the file ${before.repository}/${before.repo_file} of ${desc.noun} '${before.name}'`);
    return true;
  });
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
 */
const singleFileOf = (desc, name) => path.join(Repo.folderOf(name), desc.file);

/**
 * Writes a single-file type's YAML and the files beside it : a file whose content is the same is
 * left as it is, a file beside it the object no longer names removed.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   name (string): the repository.
 *   out (object): { text (null : the YAML left as it is), extraFiles: [{ name, buffer }] }.
 *   gone (string[]): the files beside it the object named before.
 *
 * Returns:
 *   boolean: whether anything was written.
 */
function writeSingle(desc, name, out, gone = []) {
  const dir = path.dirname(singleFileOf(desc, name));
  let written = false;
  const abs = singleFileOf(desc, name);
  if (out.text !== null && out.text !== undefined && (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== out.text)) {
    fs.writeFileSync(abs, out.text, "utf8");
    written = true;
  }
  const kept = new Set();
  for (const extra of out.extraFiles || []) {
    const file = fileIn(dir, ".", extra.name, /./);
    kept.add(path.basename(file));
    if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), extra.buffer) === 0) continue;
    fs.writeFileSync(file, extra.buffer);
    written = true;
  }
  for (const old of gone) {
    if (kept.has(old)) continue;
    fs.rmSync(fileIn(dir, ".", old, /./), { force: true });
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
  summary.notes.push(...desc.notesOf(checked.object, current));
  const secrets = desc.secretsOf ? desc.secretsOf(current) : desc.secrets || [];
  if (secrets.some((s) => !given(raw[s]) && given(current?.[s]))) summary.secretsKept.push(desc.title);
  if (!desc.changed(checked.object, current)) {
    summary.unchanged = 1;
    return summary;
  }
  try {
    summary.notes.push(...((await desc.apply(checked.object, current)) || []));
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
  const exists = cloned(name) && fs.existsSync(singleFileOf(desc, name));
  const current = await desc.current();
  const { withoutSecret } = desc.fileOf(current);
  const active = (await activeRepository(desc)) || null;
  return {
    repository: name || null,
    active,
    written: exists ? [] : [desc.title],
    withoutSecret: !exists && withoutSecret ? [desc.title] : [],
    // what stays in the app (the branding fields the config seed manages)
    kept: desc.kept(current),
    clashes: exists ? [desc.title] : [],
    files: exists ? 1 : 0,
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
  report.kept = desc.kept(await desc.current());
  if (fs.existsSync(singleFileOf(desc, name))) {
    const summary = await syncSingle(desc, name);
    report.refused = summary.refused;
    report.waiting = summary.waiting;
    if (!summary.refused.length && !summary.waiting.length) report.matched = [desc.title];
  } else {
    const out = desc.fileOf(await desc.current());
    await withWriteClaim(name, async () => writeSingle(desc, name, out));
    report.written = [desc.title];
    if (out.withoutSecret) report.withoutSecret = [desc.title];
  }
  logger.notice(`Repository '${name}' now holds ${holdingOf(desc)} (${report.written.length ? `written to ${desc.file}, waiting for Push` : `read from ${desc.file}`})`);
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
  return withWriteClaim(repository, async () => {
    const abs = singleFileOf(desc, repository);
    const out = fs.existsSync(abs) ? desc.fileEdits(fs.readFileSync(abs, "utf8"), after, before) : desc.fileOf(after);
    // the files beside it the edit no longer names : those the type says (only the images it
    // changed), else every one the object named before that it does not write again
    const gone = out.gone ?? desc.fileOf(before).extraFiles.map((f) => f.name);
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
 * a folder type's objects made or changed by name. Nothing is linked to a repository.
 *
 * Args:
 *   desc (object): the type's descriptor.
 *   declared (object|object[]): the section's object (a single-file type), or its items.
 *   opts (object): { dir (the seed file's folder : what the section names beside it) }.
 *
 * Returns:
 *   Promise<object>: { created: [name], updated: [name], unchanged (count) }.
 *
 * Raises:
 *   Error: an item refused, named with why.
 */
export async function applyDeclared(desc, declared, opts = {}) {
  const out = { created: [], updated: [], unchanged: 0 };
  if (desc.file) {
    const checked = await desc.check(declared, { resolved: true, dir: opts.dir });
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
    const checked = desc.check(item, { resolved: true });
    if (checked.errors.length) throw new Error(`${desc.noun} '${item?.name ?? ""}': ${checked.errors.join("; ")}`);
    // one the type does not import (an announcement already ended) : left out, as a pull leaves it
    if (desc.notImported?.(checked.object)) continue;
    const row = ((await desc.store.rows()) || []).find((r) => nameKey(r.name) === nameKey(checked.object.name));
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
  withWriteClaim,
  fileOf,
  writeNewFile,
  repositories,
  activeRepository,
  assertUsageAllowed,
  syncRepository,
  summaryText,
  syncText,
  afterGit,
  syncAllOf,
  syncAll,
  preview,
  activate,
  unlinkRepository,
  deactivate,
  renameRepository,
  afterUsageChange,
  appCreated,
  appUpdated,
  appDeleted,
  applyDeclared,
  linkStore,
  classifyRow,
};
