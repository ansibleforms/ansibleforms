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
