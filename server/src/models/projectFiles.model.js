'use strict';
// The designer's Playbooks, Vars files and Inventories sections : the files of the playbooks
// folder, of the vars files folder and of the inventories - the playbooks repository's
// (use_for_playbooks), the vars folder of the forms repository, the inventories repositories'
// (use_for_inventories) - or the local folder (ANSIBLE_PATH, VARS_FILES_PATH, INVENTORY_PATH).
// Listed, read, written and deleted here ; a repository's are then pushed to its remote (Push,
// as the forms' Save to repo).
//
// A kind has one root ; the inventories have the local folder (one folder per inventory) and
// a root per inventories repository, each an inventory of its own : its paths start with its name
// (production/inventory.yaml), as a local inventory's start with its folder's.
//
// A form file (Form.formsFileTest : a forms folder's, every yaml file of a forms repository serving
// its forms from its root) is never written nor deleted here : the designer's forms write it,
// checked.
import fs from "fs";
import path from "path";
import logger from "../lib/logger.js";
import Errors from "../lib/errors.js";
import appConfig from "../../config/app.config.js";
import ansibleConfig from "../../config/ansible.config.js";
import Repository from "./repository.model.js";
import Repo from "./repo.model.js";
import { configRepoFromPath } from "../lib/forms-git.js";
import { FILE_KINDS, MAX_FILE_BYTES, MAX_LISTED_FILES, safeRelativePath, isInside, isTextBuffer } from "../lib/projectFiles.js";
import Form from "./form.model.js";

const ProjectFiles = {};

// what a push of each kind says in its commit
const PUSH_LABEL = { playbooks: "Playbooks", vars: "Vars files", inventories: "Inventories", workflows: "Workflows" };

/**
 * The folders of a kind of files and the repository each belongs to.
 *
 * Args:
 *   kind (string): 'playbooks', 'vars' or 'inventories'.
 *
 * Returns:
 *   object[]: { prefix (the name a path starts with : '' for a folder whose paths are its own,
 *     an inventories repository's name), root (absolute folder), repository (its name, or null
 *     for a local folder) }.
 *
 * Raises:
 *   BadRequestError: the kind is not one of FILE_KINDS.
 */
ProjectFiles.roots = async function (kind) {
  if (!FILE_KINDS.includes(kind)) throw new Errors.BadRequestError(`Unknown kind of files '${kind}'`);
  if (kind === "inventories") {
    // the local folder, then each repository that is an inventory
    return (await Repository.getInventoryRoots()).map((r) => ({ prefix: r.repository || "", root: path.resolve(r.root), repository: r.repository }));
  }
  if (kind === "workflows") {
    // the local folder, then each repository used for workflows, under its name
    return (await Repository.getWorkflowsRoots()).map((r) => ({ prefix: r.repository || "", root: path.resolve(r.root), repository: r.repository }));
  }
  const root = path.resolve(kind === "playbooks" ? (await Repository.getAnsiblePath()) || ansibleConfig.path : await Repository.getVarsFilesPath());
  return [{ prefix: "", root, repository: configRepoFromPath(root, path.resolve(appConfig.repoPath)) }];
};

/**
 * The root a path of a kind is in, and the path inside it : a repository's when its first part
 * names one, else the folder whose paths are its own.
 *
 * Args:
 *   kind (string): the kind.
 *   rel (string): the path, as the explorer shows it.
 *
 * Returns:
 *   object: { root, repository, prefix, inner (the path inside the root) }.
 *
 * Raises:
 *   BadRequestError: the path names no root of the kind.
 */
async function rootOf(kind, rel) {
  return rootIn(await ProjectFiles.roots(kind), rel);
}

/**
 * The root a path is in, among a kind's roots already read (rootOf's rule).
 *
 * Args:
 *   roots (object[]): the kind's roots (ProjectFiles.roots).
 *   rel (string): the path, as the explorer shows it.
 *
 * Returns:
 *   object: { root, repository, prefix, inner }.
 *
 * Raises:
 *   BadRequestError: the path names no root of the kind.
 */
function rootIn(roots, rel) {
  const parts = String(rel ?? "").replace(/^\/+/, "").split("/");
  const repo = roots.find((r) => r.prefix && r.prefix === parts[0]);
  if (repo) return { ...repo, inner: parts.slice(1).join("/") };
  const own = roots.find((r) => !r.prefix);
  if (!own) throw new Errors.BadRequestError(`'${rel}' is in none of the folders`);
  return { ...own, inner: rel };
}

/**
 * The absolute path of a file of a kind, refused when it would leave its folder (a '..' or a
 * link pointing out of it).
 *
 * Args:
 *   root (string): the kind's folder.
 *   rel (string): the file's path, relative to it.
 *
 * Returns:
 *   object: { rel (normalized), abs (absolute) }.
 *
 * Raises:
 *   BadRequestError: the path is not valid, or leads out of the folder.
 */
async function resolveIn(root, rel) {
  let safe;
  try {
    safe = safeRelativePath(rel);
  } catch (e) {
    throw new Errors.BadRequestError(e.message);
  }
  const abs = path.resolve(root, safe);
  if (!isInside(root, abs)) throw new Errors.BadRequestError(`'${rel}' is not a valid file path`);
  // the deepest part that exists, as the disk resolves it (links followed), stays inside too
  const realRoot = await fs.promises.realpath(root).catch(() => root);
  let probe = abs;
  while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe);
  if (probe !== root) {
    const real = await fs.promises.realpath(probe);
    if (real !== realRoot && !isInside(realRoot, real)) throw new Errors.BadRequestError(`'${rel}' is not a valid file path`);
  }
  return { rel: safe, abs };
}

/**
 * The absolute paths of files of a kind, as the explorer shows them : what the designer's
 * visibility of the playbooks and the workflows compares (lib/designerForms.js).
 *
 * Args:
 *   kind (string): the kind.
 *   rels (string[]): the paths.
 *
 * Returns:
 *   Promise<Map<string, string>>: each path's absolute one (a path naming no root left out).
 */
ProjectFiles.absolutes = async function (kind, rels) {
  const roots = await ProjectFiles.roots(kind);
  const out = new Map();
  for (const rel of rels || []) {
    try {
      const { root, inner } = rootIn(roots, rel);
      out.set(rel, path.resolve(root, String(inner).replace(/^\/+/, "")));
    } catch {
      // a path of no folder : nothing to compare
    }
  }
  return out;
};

/**
 * A file of a kind as a read, a save or a delete resolves it : its absolute path, and its path as
 * those name it in what they answer. A request refused for a file hidden from the user answers in
 * the same words (lib/designerForms.js).
 *
 * Args:
 *   kind (string): the kind.
 *   rel (string): the file's path, as the explorer shows it.
 *
 * Returns:
 *   Promise<object>: { abs, name }.
 *
 * Raises:
 *   BadRequestError: the path names no root of the kind, is not valid, or leads out of it.
 */
ProjectFiles.locate = async function (kind, rel) {
  const { root, prefix, inner } = await rootOf(kind, rel);
  const file = await resolveIn(root, inner);
  return { abs: file.abs, name: shown(prefix, file.rel) };
};

/**
 * Refuses a write of a form file (Form.formsFileTest) : the designer's forms write them, checked
 * (their names, their roles, their validation, the forms hidden from a designer) ; here none of it
 * would apply.
 *
 * Args:
 *   abs (string): the path.
 *   name (string): the path as the request names it.
 *
 * Raises:
 *   Errors.AccessDeniedError: it is a form file.
 */
async function assertNotFormsFile(abs, name) {
  if ((await Form.formsFileTest())(abs)) {
    throw new Errors.AccessDeniedError(`'${name}' is a form file: it is written by the designer's forms, where it is checked`);
  }
}

/** A path as the explorer shows it : its root's prefix first, when the kind has several. */
const shown = (prefix, rel) => (prefix ? `${prefix}/${rel}` : rel);

/**
 * The files of a kind : every file below its folders (hidden ones and links left out), with
 * whether its repositories have changes not pushed yet.
 *
 * Args:
 *   kind (string): 'playbooks', 'vars' or 'inventories'.
 *
 * Returns:
 *   object: { repository (the repositories' names, comma separated, or null), repositories
 *     ([{ name, prefix, dirty }]), exists (a folder is there), truncated (more than
 *     MAX_LISTED_FILES), dirty (a repository has changes to push), roots (the prefixes, '' for
 *     one root), files: [{ path, size, modified }] }.
 */
ProjectFiles.list = async function (kind) {
  const roots = await ProjectFiles.roots(kind);
  const files = [];
  let truncated = false;
  // breadth first, one folder at a time, at most 12 deep
  // a local inventory's folder named as an inventories repository is hidden by it
  const repoNames = new Set(roots.map((r) => r.prefix).filter(Boolean));
  const walk = async (dir, rel, depth, prefix) => {
    if (depth > 12 || truncated) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      logger.warning(`Cannot list ${dir}: ${e.message}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!prefix && depth === 0 && repoNames.has(entry.name)) {
        logger.warning(`The folder ${entry.name} of ${dir} is hidden by the inventories repository of that name`);
        continue;
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1, prefix);
      } else if (entry.isFile()) {
        if (files.length >= MAX_LISTED_FILES) {
          truncated = true;
          return;
        }
        const stat = await fs.promises.stat(childAbs);
        files.push({ path: shown(prefix, childRel), size: stat.size, modified: stat.mtime });
      }
    }
  };
  let exists = false;
  const repositories = [];
  for (const r of roots) {
    const here = fs.existsSync(r.root);
    exists = exists || here;
    if (here) await walk(r.root, "", 0, r.prefix);
    if (r.repository) {
      let dirty = false;
      if (here) {
        try {
          dirty = await Repo.hasChanges(r.repository);
        } catch (e) {
          logger.warning(`Cannot tell whether '${r.repository}' has changes: ${e.message}`);
        }
      }
      repositories.push({ name: r.repository, prefix: r.prefix, dirty });
    }
  }
  return {
    repository: repositories.length ? repositories.map((r) => r.name).join(", ") : null,
    repositories,
    roots: roots.map((r) => r.prefix),
    exists,
    truncated,
    dirty: repositories.some((r) => r.dirty),
    files,
  };
};

/**
 * A file's content.
 *
 * Args:
 *   kind (string): 'playbooks', 'vars' or 'inventories'.
 *   rel (string): the file's path, as the explorer shows it.
 *
 * Returns:
 *   object: { path, content }.
 *
 * Raises:
 *   NotFoundError: there is no such file.
 *   BadRequestError: the path is not valid, the file is too big or not text.
 */
ProjectFiles.read = async function (kind, rel) {
  const { root, prefix, inner } = await rootOf(kind, rel);
  const file = await resolveIn(root, inner);
  const stat = await fs.promises.stat(file.abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Errors.NotFoundError(`File '${shown(prefix, file.rel)}' not found`);
  if (stat.size > MAX_FILE_BYTES) throw new Errors.BadRequestError(`File '${shown(prefix, file.rel)}' is too big to edit here`);
  const buffer = await fs.promises.readFile(file.abs);
  if (!isTextBuffer(buffer)) throw new Errors.BadRequestError(`File '${shown(prefix, file.rel)}' is not a text file`);
  return { path: shown(prefix, file.rel), content: buffer.toString("utf8") };
};

/**
 * Runs a write in a kind's folder : in a repository, while holding its claim (no pull, sync or
 * clone runs on the same working tree meanwhile).
 */
async function withWriteClaim(repository, write) {
  const prior = repository ? await Repository.claimForWrite(repository) : undefined;
  try {
    return await write();
  } finally {
    if (repository && prior !== undefined) await Repository.releaseWrite(repository, prior);
  }
}

/**
 * Writes a file (a new one, or over the one there), its folders made as needed.
 *
 * Args:
 *   kind (string): 'playbooks', 'vars' or 'inventories'.
 *   rel (string): the file's path, as the explorer shows it.
 *   content (string): its text.
 *   onlyNew (boolean): refuse when the file is there already (a new file, not a save).
 *
 * Returns:
 *   object: { path, repository }.
 *
 * Raises:
 *   BadRequestError: the path or the content is not valid.
 *   ConflictError: onlyNew and the file exists.
 *   AccessDeniedError: it is a form file (Form.formsFileTest).
 */
ProjectFiles.write = async function (kind, rel, content, onlyNew = false) {
  if (typeof content !== "string") throw new Errors.BadRequestError("The content must be text");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Errors.BadRequestError("The content is too big to save here");
  const { root, repository, prefix, inner } = await rootOf(kind, rel);
  const file = await resolveIn(root, inner);
  const name = shown(prefix, file.rel);
  await assertNotFormsFile(file.abs, name);
  return withWriteClaim(repository, async () => {
    if (fs.existsSync(file.abs)) {
      if (onlyNew) throw new Errors.ConflictError(`File '${name}' exists already`);
      if (!(await fs.promises.stat(file.abs)).isFile()) throw new Errors.BadRequestError(`'${name}' is not a file`);
    }
    await fs.promises.mkdir(path.dirname(file.abs), { recursive: true });
    await fs.promises.writeFile(file.abs, content, "utf8");
    logger.notice(`Saved ${kind} file ${name}${repository ? ` in repository '${repository}'` : ""}`);
    return { path: name, repository };
  });
};

/**
 * Deletes a file, and the folders it leaves empty.
 *
 * Args:
 *   kind (string): 'playbooks', 'vars' or 'inventories'.
 *   rel (string): the file's path, as the explorer shows it.
 *
 * Returns:
 *   object: { path, repository }.
 *
 * Raises:
 *   NotFoundError: there is no such file.
 *   AccessDeniedError: it is a form file (Form.formsFileTest).
 */
ProjectFiles.remove = async function (kind, rel) {
  const { root, repository, prefix, inner } = await rootOf(kind, rel);
  const file = await resolveIn(root, inner);
  const name = shown(prefix, file.rel);
  await assertNotFormsFile(file.abs, name);
  return withWriteClaim(repository, async () => {
    const stat = await fs.promises.lstat(file.abs).catch(() => null);
    if (!stat || !stat.isFile()) throw new Errors.NotFoundError(`File '${name}' not found`);
    await fs.promises.unlink(file.abs);
    let dir = path.dirname(file.abs);
    while (dir !== root && isInside(root, dir) && (await fs.promises.readdir(dir)).length === 0) {
      await fs.promises.rmdir(dir);
      dir = path.dirname(dir);
    }
    logger.notice(`Deleted ${kind} file ${name}${repository ? ` in repository '${repository}'` : ""}`);
    return { path: name, repository };
  });
};

/**
 * Commits and pushes the changes of a kind's repositories (each of them, the inventories of
 * several).
 *
 * Args:
 *   kind (string): 'playbooks', 'vars' or 'inventories'.
 *   username (string): who pushes (in the commit message).
 *
 * Returns:
 *   object: { repository (the names, comma separated), output }.
 *
 * Raises:
 *   BadRequestError: the kind's files are in a local folder, not a repository.
 */
ProjectFiles.push = async function (kind, username) {
  const names = [...new Set((await ProjectFiles.roots(kind)).map((r) => r.repository).filter(Boolean))];
  if (!names.length) throw new Errors.BadRequestError("These files are in a local folder: there is no repository to push to");
  const outputs = [];
  for (const name of names) {
    outputs.push(await Repository.sync(name, username, `${PUSH_LABEL[kind]} sync by ${username || "AnsibleForms"}`));
  }
  return { repository: names.join(", "), output: outputs.join("\n") };
};

export default ProjectFiles;
