'use strict';
/******************************************************************/
/*                                                                */
/*  The RTE images : the definitions a builder builds an RTE      */
/*  from, kept in the repositories used for them (use_for_rte),   */
/*  entries of a runner_rte: list in any of their YAML files      */
/*  (lib/repoObjects/types.js), any name, any folder. Read from   */
/*  the files as they are, never copied into the database ; a     */
/*  save writes the entry back where it was (its comments and     */
/*  the rest of the file kept), a new one to rte.yaml in a folder */
/*  of its name, and Push commits and pushes. An image's          */
/*  name is unique across the repositories : two of a name are    */
/*  both said, neither built.                                     */
/*                                                                */
/******************************************************************/
import fs from "fs";
import path from "path";
import mysql from "../models/db.model.js";
import Repo from "../models/repo.model.js";
import Repository from "../models/repository.model.js";
import Errors from "./errors.js";
import logger from "./logger.js";
import { scanRepository, forgetScans } from "./repoObjects/repoFiles.js";
import { fileKeyOf } from "./repoObjects/types.js";
import { editListEntry, appendListEntries, removeListEntry, applyEdits, fileInRepository } from "./repoObjects/yamlFile.js";
import { withWriteClaim } from "./repoObjects/engine.js";
import { pythonOf, newestAnsibleCore, ansibleCoreMisfit, PYTHONS, DEFAULT_PYTHON } from "./rteDockerfile.js";

// the key its files give it by, and the file a new one goes to
export const RTE_KEY = fileKeyOf("rte");
export const NEW_FILE = "rte.yaml";

/**
 * The file a new image goes to : rte.yaml of a folder of its name, the folder that holds the image
 * in its repository (its name is a valid folder name, NAME).
 *
 * Args:
 *   name (string): the image's name.
 *
 * Returns:
 *   string: its file's path in the repository.
 */
export const folderFileOf = (name) => `${name}/${NEW_FILE}`;

// the order an entry's keys are written in
export const KEY_ORDER = ["name", "description", "arch", "python", "ansible_core", "ansible_collections", "python_packages", "os_packages", "registry", "sbom", "sign"];


// ===========================================================================
// A DEFINITION
// ===========================================================================

// the architectures an image is built for : one, or all (one multi-architecture image, as the
// published RTE images) ; the builder needs QEMU on its host for the one it is not
export const ARCHES = ["all", "amd64", "arm64"];
export const DEFAULT_ARCH = "all";
// an image's name : a registry repository's last part, lower case
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
// an OS package : a debian package name, never more (it goes on a RUN line)
const OS_PACKAGE = /^[a-z0-9][a-z0-9.+-]*$/;
// a collection : namespace.name
const COLLECTION = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
// a version : no spaces nor quotes (ansible-core goes on a RUN line, quoted)
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/;
// a registry repository : lower case path parts
const REPOSITORY = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
// a tag : a registry tag
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * A definition checked and in its canonical shape : what is saved, shown and built.
 *
 * Args:
 *   input (object): the definition as given (a file's entry, an API body).
 *
 * Returns:
 *   object: the definition.
 *
 * Raises:
 *   BadRequestError: a field is missing or not valid ; ansible-core does not run on its python.
 */
export function normalizeImage(input) {
  const bad = (m) => {
    throw new Errors.BadRequestError(m);
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) bad("A runtime environment is a map of its fields");
  const name = String(input.name ?? "").trim();
  if (!NAME.test(name)) bad(`'${name}' is no valid image name: lower case letters, digits, dots, dashes and underscores`);
  const image = { name };
  if (input.description) image.description = String(input.description).trim();
  // what it is built for : both architectures when none is said
  const arch = String(input.arch ?? DEFAULT_ARCH).trim() || DEFAULT_ARCH;
  if (!ARCHES.includes(arch)) bad(`arch must be one of ${ARCHES.join(", ")}`);
  image.arch = arch;
  // its python (the newest when none is given) ; its ansible-core, the newest that runs on it when
  // none is given : every image is built from rte-base with both (lib/rteDockerfile.js)
  const python = String(input.python ?? DEFAULT_PYTHON).trim();
  if (!PYTHONS.includes(python)) bad(`python must be one of ${PYTHONS.join(", ")}`);
  image.python = python;
  const ansibleCore = String(input.ansible_core ?? "").trim() || newestAnsibleCore(python);
  if (ansibleCore) {
    if (!VERSION.test(ansibleCore)) bad(`'${ansibleCore}' is no valid ansible-core version`);
    image.ansible_core = ansibleCore;
    const misfit = ansibleCoreMisfit(ansibleCore, pythonOf(image));
    if (misfit) bad(misfit);
  }
  const list = (key) => {
    const v = input[key];
    if (v === undefined || v === null || v === "") return [];
    if (!Array.isArray(v)) bad(`${key} must be a list`);
    return v;
  };
  const collections = list("ansible_collections").map((c) => {
    const entry = typeof c === "string" ? { name: c } : c && typeof c === "object" ? { ...c } : bad("a collection is a name or a map with its name");
    entry.name = String(entry.name ?? "").trim();
    if (!COLLECTION.test(entry.name)) bad(`'${entry.name}' is no collection name (namespace.name)`);
    const out = { name: entry.name };
    if (entry.version !== undefined && entry.version !== null && String(entry.version).trim()) out.version = String(entry.version).trim();
    if (entry.source) out.source = String(entry.source).trim();
    return out;
  });
  if (collections.length) image.ansible_collections = collections;
  const packages = list("python_packages").map((p) => String(p ?? "").trim()).filter(Boolean);
  for (const p of packages) if (/[\r\n]/.test(p) || p.startsWith("-")) bad(`'${p}' is no python package requirement`);
  if (packages.length) image.python_packages = packages;
  const os = list("os_packages").map((p) => String(p ?? "").trim()).filter(Boolean);
  for (const p of os) if (!OS_PACKAGE.test(p)) bad(`'${p}' is no OS package name`);
  if (os.length) image.os_packages = os;
  // the registry it is pushed to : its credential (a registry credential's name, which holds its
  // address and its login), the image's path in it and its tag (app : the app's release) ; a name:
  // or a repository: of before read as them, a tag: beside the registry too
  const reg = input.registry ?? {};
  if (typeof reg !== "object" || Array.isArray(reg)) bad("registry is a map: its credential, the image's path in it and its tag");
  const registry = {};
  const credential = String(reg.credential ?? reg.name ?? "").trim();
  if (credential) registry.credential = credential;
  const p = String(reg.path ?? reg.repository ?? "").trim();
  if (p) {
    if (!REPOSITORY.test(p)) bad(`'${p}' is no registry path (lower case, parts separated by /)`);
    registry.path = p;
  }
  const tag = String(reg.tag ?? input.tag ?? "app").trim() || "app";
  if (tag !== "app" && !TAG.test(tag)) bad(`'${tag}' is no valid tag`);
  registry.tag = tag;
  image.registry = registry;
  image.sbom = input.sbom === undefined ? true : !!input.sbom && input.sbom !== "false";
  // signed : with the credential named (a signing key credential's name) ; a key: or a name: of
  // before read as it
  if (input.sign !== undefined && input.sign !== null && input.sign !== false) {
    if (typeof input.sign !== "object" || Array.isArray(input.sign)) bad("sign is a map: the credential it signs with");
    const credential = String(input.sign.credential ?? input.sign.key ?? input.sign.name ?? "").trim();
    if (credential) image.sign = { credential };
  }
  return image;
}

// ===========================================================================
// READING THEM
// ===========================================================================

/**
 * The repositories used for RTE images, by name.
 *
 * Returns:
 *   Promise<string[]>: their names.
 */
export async function rteRepositories() {
  const rows = await mysql.do("SELECT name FROM AnsibleForms.`repositories` WHERE use_for_rte ORDER BY name");
  return rows.map((r) => r.name).filter((n) => Repo.isValidName(n));
}

/**
 * Every RTE image of every repository used for them, each with where it is ; an entry that is not
 * valid is listed with its error, two of a name with theirs.
 *
 * Returns:
 *   Promise<object[]>: { name, repository, file, image (normalized ; the raw entry when not valid),
 *   error }, by name.
 */
export async function listImages() {
  const found = [];
  for (const repository of await rteRepositories()) {
    const scan = scanRepository(Repo.folderOf(repository));
    for (const { file, value } of scan.holding("rte")) {
      for (const entry of value || []) {
        let image = entry;
        let error = "";
        try {
          image = normalizeImage(entry);
        } catch (e) {
          error = e.message;
        }
        found.push({ name: String(entry?.name ?? ""), repository, file, image, error });
      }
    }
  }
  const count = new Map();
  for (const f of found) count.set(f.name, (count.get(f.name) || 0) + 1);
  for (const f of found) {
    if (count.get(f.name) > 1 && !f.error) {
      const where = found.filter((o) => o.name === f.name).map((o) => `${o.repository}/${o.file}`);
      f.error = `the name is given ${where.length} times (${where.join(", ")}): rename all but one`;
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.repository.localeCompare(b.repository));
}

/**
 * One image.
 *
 * Args:
 *   name (string): its name.
 *
 * Returns:
 *   Promise<object>: as listImages gives it.
 *
 * Raises:
 *   NotFoundError: no repository gives it.
 */
export async function getImage(name) {
  const found = (await listImages()).filter((f) => f.name === name);
  if (!found.length) throw new Errors.NotFoundError(`There is no runtime environment named '${name}'`);
  return found[0];
}

// ===========================================================================
// WRITING THEM
// ===========================================================================

/**
 * A file of a repository, read ('' for a new one).
 *
 * Args:
 *   repository (string): the repository.
 *   file (string): its path in it.
 *
 * Returns:
 *   object: { abs, text }.
 */
function fileOf(repository, file) {
  const abs = fileInRepository(Repo.folderOf(repository), file);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  return { abs, text };
}

/**
 * Saves an image : over its entry where its old name is (a rename included, its folder renamed with
 * it when the folder is its own), else as rte.yaml of a new folder of its name in the repository
 * given (the only one, when there is one).
 *
 * Args:
 *   input (object): the definition.
 *   opts (object): { original (its name before, for an existing one), repository (where a new one
 *     goes) }.
 *
 * Returns:
 *   Promise<object>: { name, repository, file }.
 *
 * Raises:
 *   BadRequestError: the definition is not valid, no repository is used for RTE images, or which one
 *     a new image goes to is not said.
 *   ConflictError: another image has its name.
 *   NotFoundError: the original is not there any more.
 */
export async function saveImage(input, opts = {}) {
  const image = normalizeImage(input);
  const all = await listImages();
  const original = opts.original ? all.find((f) => f.name === opts.original) : null;
  if (opts.original && !original) throw new Errors.NotFoundError(`There is no runtime environment named '${opts.original}'`);
  if (all.some((f) => f.name === image.name && f !== original)) throw new Errors.ConflictError(`A runtime environment named '${image.name}' exists already`);
  let repository = original?.repository;
  let file = original?.file;
  if (!repository) {
    const repos = await rteRepositories();
    if (!repos.length) throw new Errors.BadRequestError("No repository is used for runtime environments: turn the usage on for one first");
    repository = opts.repository || (repos.length === 1 ? repos[0] : "");
    if (!repos.includes(repository)) throw new Errors.BadRequestError(`Say which repository the runtime environment goes to: ${repos.join(", ")}`);
    // a folder of its own, named after it : the image's folder in the repository
    file = folderFileOf(image.name);
  }
  await withWriteClaim(repository, async () => {
    const { abs, text } = fileOf(repository, file);
    let next;
    if (original) {
      next = editListEntry(text, RTE_KEY, original.name, (doc, map) => {
        // every field set from the definition, one it no longer gives removed
        // the keys of before (base:, collections:, tag:) go : the python says the base now, the
        // collections are ansible_collections:, the tag is the registry's
        const edits = { base: undefined, collections: undefined, tag: undefined, ...Object.fromEntries(KEY_ORDER.map((k) => [k, image[k]])) };
        applyEdits(doc, map, edits, KEY_ORDER);
      });
    } else {
      next = appendListEntries(text, RTE_KEY, [image], KEY_ORDER);
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, next, "utf8");
    // renamed, in a folder of its own (its old name, holding only it) : the folder takes the new
    // name, unless one of that name is there already
    if (original && original.name !== image.name && file === folderFileOf(original.name)) {
      const alone = all.filter((f) => f.repository === repository && f.file === file).length === 1;
      // its name is a plain folder name (NAME : no slash, no leading dot), so it stays in the repository
      const target = path.join(path.dirname(path.dirname(abs)), image.name);
      if (alone && !fs.existsSync(target)) {
        await fs.promises.rename(path.dirname(abs), target);
        file = folderFileOf(image.name);
      }
    }
  });
  forgetScans();
  logger.notice(`Saved runtime environment '${image.name}' in ${repository}/${file}`);
  return { name: image.name, repository, file };
}

/**
 * Removes an image's entry from its file (the file too, when nothing is left in it).
 *
 * Args:
 *   name (string): its name.
 *
 * Returns:
 *   Promise<object>: { name, repository, file }.
 *
 * Raises:
 *   NotFoundError: no repository gives it.
 */
export async function removeImage(name) {
  const { repository, file } = await getImage(name);
  await withWriteClaim(repository, async () => {
    const { abs, text } = fileOf(repository, file);
    const out = removeListEntry(text, RTE_KEY, name);
    if (out.empty) {
      await fs.promises.unlink(abs);
      // its own folder goes with it, when nothing else is left in it
      const dir = path.dirname(abs);
      if (file.includes("/") && !(await fs.promises.readdir(dir)).length) await fs.promises.rmdir(dir);
    } else await fs.promises.writeFile(abs, out.text, "utf8");
  });
  forgetScans();
  logger.notice(`Removed runtime environment '${name}' from ${repository}/${file}`);
  return { name, repository, file };
}

/**
 * Commits and pushes the RTE images' repositories.
 *
 * Args:
 *   username (string): who pushes (in the commit message).
 *
 * Returns:
 *   Promise<object>: { repository (the names, comma separated), output }.
 *
 * Raises:
 *   BadRequestError: no repository is used for RTE images.
 */
export async function pushImages(username) {
  const names = await rteRepositories();
  if (!names.length) throw new Errors.BadRequestError("No repository is used for runtime environments");
  const outputs = [];
  for (const name of names) outputs.push(await Repository.sync(name, username, `Runtime environments sync by ${username || "AnsibleForms"}`));
  return { repository: names.join(", "), output: outputs.join("\n") };
}

/**
 * A definition as one text whatever the order of its keys : two definitions that build the same
 * image read the same.
 *
 * Args:
 *   value (any): the definition, or a part of it.
 *
 * Returns:
 *   string: its canonical JSON.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Whether a runtime environment needs a build : it never built well, its definition changed since
 * its last good build (both read the same way, keys of before included), or that build was for
 * another release of the app while it is tagged app.
 *
 * Args:
 *   found (object): the runtime environment ({ name, image, error }), as listImages gives it.
 *   builds (object[]): the builds, newest first (rteBuilds.listBuilds).
 *   appVersion (string): the app's release.
 *
 * Returns:
 *   boolean: true when it should be built again.
 */
export function needsBuild(found, builds, appVersion) {
  if (found?.error) return false;
  const last = (builds || []).find((b) => b.image === found.name && b.status === "success");
  if (!last?.definition) return true;
  let then;
  try {
    then = normalizeImage(last.definition);
  } catch {
    return true;
  }
  if (canonical(then) !== canonical(found.image)) return true;
  return (found.image?.registry?.tag || "app") === "app" && !!last.appVersion && last.appVersion !== appVersion;
}

export default { needsBuild, normalizeImage, listImages, getImage, saveImage, removeImage, pushImages, rteRepositories };
