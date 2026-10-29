'use strict';
// The environment settings among the fields of a type that holds a page's settings (lib/repoObjects
// /appearanceType.js, chatAssistant.js) : a page that saves a settings row and, beside it, an
// environment variable or two - the Defaults page's language (DEFAULT_LANGUAGE), the Links page's
// Designer link (SHOW_DESIGNER), the Chat assistant page's switch (ENABLE_CHAT). Each is a field of
// its page's map, named as its variable in lower case (default_language, show_designer,
// enable_chat), read and saved as its page does (lib/envSave.js saveEnvValues : checked, written to
// the managed file, the nodes told, applied at once or said to need a restart, audited). One way
// for every type holding one, written once.
//
// A variable set in the real environment is not the app's to save : its field reads as none (never
// written to a repository's file), and a file giving it is never applied - said (the appearance
// pages) or refused (the chat assistant, as General refuses one).
import { saveEnvValues } from "../envSave.js";
import EnvSettings from "../envSettings.js";
import appConfig from "../../../config/app.config.js";

// the environment settings among the pages' fields, by field : their variable, how the app reads
// them now, and the value their page saves
export const ENV_FIELDS = {
  default_language: { name: "DEFAULT_LANGUAGE", read: () => process.env.DEFAULT_LANGUAGE || null, write: (v) => v ?? "" },
  show_designer: { name: "SHOW_DESIGNER", read: () => !!appConfig.showDesigner, write: (v) => (v ? "1" : "0") },
  // read as app.config reads it (off unless 1) : a save keeps process.env in step (applyLive)
  enable_chat: { name: "ENABLE_CHAT", read: () => String(process.env.ENABLE_CHAT ?? "0") === "1", write: (v) => (v ? "1" : "0") },
};

/**
 * The environment settings of a type's fields, read, checked and saved as their page does.
 *
 * Args:
 *   fields (string[]): its environment fields (keys of ENV_FIELDS : default_language ...).
 *
 * Returns:
 *   object: { fields, has, nameOf, overridden, read, refuseOverridden, updates, check, save }.
 */
export function envFieldSet(fields) {
  const has = (field) => fields.includes(field);
  const nameOf = (field) => ENV_FIELDS[field].name;

  /**
   * The fields whose variable is set in the real environment (that value wins : never the app's
   * to save, never a repository's).
   *
   * Returns:
   *   Promise<string[]>: the fields ; none when the type has no environment field.
   */
  async function overridden() {
    if (!fields.length) return [];
    const managed = await EnvSettings.readManaged();
    return fields.filter((field) => EnvSettings.isOverridden(nameOf(field), managed));
  }

  /**
   * The fields' values as the app has them now : none for one set in the real environment.
   *
   * Returns:
   *   Promise<object>: { values ({ field: value|null }), envSet (string[] : the fields set in the
   *     real environment) }.
   */
  async function read() {
    const envSet = await overridden();
    const values = Object.fromEntries(fields.map((field) => [field, envSet.includes(field) ? null : ENV_FIELDS[field].read()]));
    return { values, envSet };
  }

  /**
   * The variables a declaration's changed fields save, as their page saves them.
   *
   * Args:
   *   changed (string[]): the fields that change (others than environment ones left out).
   *   declared (object): the declaration.
   *
   * Returns:
   *   object: { NAME: value } ; none when no environment field changes.
   */
  function updates(changed, declared) {
    return Object.fromEntries(changed.filter(has).map((field) => [nameOf(field), ENV_FIELDS[field].write(declared[field])]));
  }

  /**
   * Refuses a declaration giving a field whose variable is set in the real environment, as
   * General refuses such a variable (lib/repoObjects/envType.js) : the environment's value wins,
   * the file is never applied.
   *
   * Args:
   *   declared (object): the declaration (a repository's file).
   *
   * Raises:
   *   Error: each such variable, said as the page's Save says it.
   */
  async function refuseOverridden(declared) {
    const given = (await overridden()).filter((field) => declared?.[field] !== undefined);
    if (given.length) throw new Error(given.map((field) => `${nameOf(field)} is set in the environment and cannot be changed from here`).join("; "));
  }

  /**
   * The variables checked as their page's Save checks them, nothing written : called before
   * anything else of the declaration is saved, so a file is refused whole, never applied by halves.
   *
   * Args:
   *   env (object): { NAME: value } (updates).
   *   opts (object): { fromSeed (the config seed's own declaration) }.
   *
   * Raises:
   *   EnvSaveError: a value refused, or the settings not editable (ALLOW_ENV_EDIT=0).
   */
  async function check(env, opts = {}) {
    if (Object.keys(env).length) await saveEnvValues(env, whoOf(opts), { ...opts, dryRun: true });
  }

  /**
   * The variables saved as their page saves them.
   *
   * Args:
   *   env (object): { NAME: value } (updates).
   *   opts (object): { fromSeed (the config seed's own declaration) }.
   *
   * Returns:
   *   Promise<string[]>: lines for the pull output (the ones applied at the next restart).
   */
  async function save(env, opts = {}) {
    if (!Object.keys(env).length) return [];
    const { restartRequired } = await saveEnvValues(env, whoOf(opts), opts);
    return restartRequired.length ? [`Saved ; applied at the next restart: ${restartRequired.join(", ")}`] : [];
  }

  return { fields, has, nameOf, overridden, read, refuseOverridden, updates, check, save };
}

/**
 * Who saves a declaration's variables, as the audit names them.
 *
 * Args:
 *   opts (object): { fromSeed }.
 *
 * Returns:
 *   object: { user }.
 */
function whoOf(opts = {}) {
  return { user: opts.fromSeed ? "config seed" : "repository" };
}

export default { ENV_FIELDS, envFieldSet };
