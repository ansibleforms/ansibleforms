'use strict';
// The repository-backed objects, as the rest of the app uses them : the engine
// (lib/repoObjects/engine.js) by type key. A controller tells it what the app saved (appCreated,
// appUpdated, appDeleted) ; the repository model tells it what git and the usage flags changed.
// A file that cannot be written is said in the server log, never thrown : what the app saved is
// saved, and the repository's next pull or Push says the rest.
import logger from "../logger.js";
import Engine from "./engine.js";
import { descriptorOf, BUILT_OBJECT_TYPES } from "./descriptors.js";

/**
 * Runs an app-to-git step of a type, its failure logged.
 *
 * Args:
 *   key (string): the type (credentials).
 *   what (string): the step, for the log.
 *   step (function): (desc) => Promise.
 *
 * Returns:
 *   Promise<any>: what the step returns, null when it failed.
 */
async function appStep(key, what, step) {
  try {
    return await step(await descriptorOf(key));
  } catch (e) {
    logger.error(`The ${key} repository could not follow ${what}: ${e.message || e}`);
    return null;
  }
}

const RepoObjects = {
  ...Engine,
  BUILT_OBJECT_TYPES,
  descriptorOf,

  /**
   * A new object of a type made in the app : written to the type's repository, when there is one.
   *
   * Args:
   *   key (string): the type.
   *   id (number): the new object.
   *
   * Returns:
   *   Promise<object|null>: { repository, file, withoutSecret }, null when it stays in the app.
   */
  appCreated: (key, id) => appStep(key, "a new object", (desc) => Engine.appCreated(desc, id)),

  /**
   * An object of a type edited in the app : its file rewritten where its fields changed.
   *
   * Args:
   *   key (string): the type.
   *   before (object): the object as it was (its repository and file).
   *   id (number): the object.
   *
   * Returns:
   *   Promise<boolean|null>: whether its file was written.
   */
  appUpdated: (key, before, id) => appStep(key, "an edit", (desc) => Engine.appUpdated(desc, before, id)),

  /**
   * An object of a type deleted in the app : its file removed.
   *
   * Args:
   *   key (string): the type.
   *   before (object): the object as it was (its repository and file).
   *
   * Returns:
   *   Promise<boolean|null>: whether a file was removed.
   */
  appDeleted: (key, before) => appStep(key, "a delete", (desc) => Engine.appDeleted(desc, before)),

  /**
   * A single-file type's object as the app holds it now (the chat's, the settings', the
   * branding's), before an edit : what appUpdated compares the saved one with. Null when the type
   * has no repository (nothing to write then).
   *
   * Args:
   *   key (string): the type.
   *
   * Returns:
   *   Promise<object|null>: the object, or null.
   */
  async snapshot(key) {
    try {
      const desc = await descriptorOf(key);
      if (!desc.file || !(await Engine.activeRepository(desc))) return null;
      return await desc.current();
    } catch (e) {
      logger.error(`The ${key} could not be read before an edit: ${e.message || e}`);
      return null;
    }
  },

  /**
   * Several single-file types' objects before an edit (snapshot each).
   *
   * Args:
   *   keys (string[]): the types.
   *
   * Returns:
   *   Promise<object>: { <type>: object or null }.
   */
  async snapshots(keys) {
    const out = {};
    for (const key of keys) out[key] = await RepoObjects.snapshot(key);
    return out;
  },

  /**
   * Several single-file types edited in the app : each one's file written (appUpdated).
   *
   * Args:
   *   befores (object): { <type>: its object before the edit } (snapshots).
   *
   * Returns:
   *   Promise<void>
   */
  async appUpdatedAll(befores) {
    for (const [key, before] of Object.entries(befores || {})) {
      if (before) await RepoObjects.appUpdated(key, before);
    }
  },

  /**
   * A type's objects as they are now (its rows, as the engine reads them) : what appChangedRows
   * compares them with after a change that may touch several (a move, a version enabled).
   *
   * Args:
   *   key (string): the type.
   *
   * Returns:
   *   Promise<object[]>: the rows, none when they cannot be read.
   */
  async rowsOf(key) {
    try {
      return (await (await descriptorOf(key)).store.rows()) || [];
    } catch (e) {
      logger.error(`The ${key} could not be read before a change: ${e.message || e}`);
      return [];
    }
  },

  /**
   * A change in the app that may touch several objects of a type (a label or an LDAP directory
   * moved : every place numbered again ; a disclaimer version enabled, added or deleted) : each
   * new object written to the type's repository, each linked one's file rewritten where it
   * changed, each linked one gone removed.
   *
   * Args:
   *   key (string): the type.
   *   before (object[]): its objects before the change (rowsOf).
   *
   * Returns:
   *   Promise<void>
   */
  async appChangedRows(key, before) {
    const after = await RepoObjects.rowsOf(key);
    const was = new Map((before || []).map((r) => [String(r.id), r]));
    const now = new Set(after.map((r) => String(r.id)));
    for (const row of after) {
      const old = was.get(String(row.id));
      if (!old) await RepoObjects.appCreated(key, row.id);
      else if (old.repository) await RepoObjects.appUpdated(key, old, row.id);
    }
    for (const old of before || []) {
      if (!now.has(String(old.id)) && old.repository) await RepoObjects.appDeleted(key, old);
    }
  },

  /**
   * Runs a change in the app that may touch several objects of a type, the type's repository
   * following it (rowsOf before, appChangedRows after).
   *
   * Args:
   *   key (string): the type.
   *   change (function): async () => the change.
   *
   * Returns:
   *   Promise<any>: what the change returns.
   */
  async following(key, change) {
    const before = await RepoObjects.rowsOf(key);
    const out = await change();
    await RepoObjects.appChangedRows(key, before);
    return out;
  },

  /**
   * What turning a repository's usages on would do, changing nothing : each type's preview.
   *
   * Args:
   *   name (string|null): the repository.
   *   keys (string[]): the types.
   *
   * Returns:
   *   Promise<object>: { <type>: preview }.
   */
  async previewTypes(name, keys) {
    const out = {};
    for (const key of keys) {
      if (!BUILT_OBJECT_TYPES.includes(key)) continue;
      out[key] = await Engine.preview(await descriptorOf(key), name);
    }
    return out;
  },
};

export default RepoObjects;
