'use strict';
// The environment types of the repository-backed objects (lib/repoObjects/engine.js, its single
// mode) : what a page that saves environment variables saves, under its key in a repository's
// file, keyed by the variables' names in lower case (job_retention_days for JOB_RETENTION_DAYS) -
// System > General's (general:) and Connections > MCP's (mcp:). One way for both, written once : the variables a page owns (lib/envSave.js
// ownsVariable : never one variable for two pages, never a refused one, nor one set in the real
// environment), a secret one (its name ends in _PASSWORD, _SECRET, _TOKEN or _SECRET_PREVIOUS)
// an ${ENV} reference only, as the page masks it. A pull applies the file as the page's Save does
// (lib/envSave.js saveEnvValues) : every value checked first, the managed file written, the nodes
// told, each applied at once or said to need a restart, the change audited.
//
// A type the config seed holds per field (the MCP settings, its mcp section) : a variable the
// seed declares stays the seed's (lib/repoObjects/seedHold.js), the repository holds the others.
import EnvSettings from "../envSettings.js";
import { ENV_OWNERS, envDocs, ownsVariable, repositoryRefusal, saveEnvValues } from "../envSave.js";
import { mapFieldSet } from "./fields.js";
import { seedHold } from "./seedHold.js";
import { singleType } from "./singleType.js";

// a secret by its name (or its key in a file), as the page masks it
const isSecret = (name) => EnvSettings.SECRET_ENV_NAME.test(String(name).toUpperCase());

/**
 * The key a file gives a variable by : its name in lower case, as every other key of a file.
 *
 * Args:
 *   name (string): the variable (JOB_RETENTION_DAYS).
 *
 * Returns:
 *   string: its key (job_retention_days).
 */
export const keyOfVariable = (name) => String(name).toLowerCase();

/**
 * An object with each of its keys translated, its values as they are.
 *
 * Args:
 *   obj (object|null): the object.
 *   to (function): the translation of a key.
 *
 * Returns:
 *   object: the object translated (an empty one for none).
 */
const renamed = (obj, to) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [to(k), v]));

/**
 * The fields of an environment type : its map's keys the variables' names in lower case, the app's
 * object keyed by the names themselves. A key that is not in lower case (JOB_RETENTION_DAYS) is
 * refused, naming the key to write instead.
 *
 * Returns:
 *   object: a field set (lib/repoObjects/fields.js mapFieldSet), translating the keys.
 */
function variableFieldSet() {
  const base = mapFieldSet({ isSecret });
  const toKeys = (obj) => renamed(obj, keyOfVariable);
  const toNames = (obj) => renamed(obj, (k) => String(k).toUpperCase());
  function check(raw, opts = {}) {
    const upper = Object.keys(raw || {}).filter((k) => k !== keyOfVariable(k));
    if (upper.length) return { errors: [`keys are in lower case: ${upper.map((k) => `${keyOfVariable(k)}, not ${k}`).join("; ")}`], object: null };
    const checked = base.check(raw, opts);
    return checked.errors.length ? checked : { errors: [], object: toNames(checked.object) };
  }
  return {
    keys: base.keys,
    check,
    read: (raw) => ({ ...check(raw), absent: false, raw }),
    toFile: (map) => base.toFile(toKeys(map)),
    editsOf: (after, before) => base.editsOf(toKeys(after), toKeys(before)),
    keyOrderOf: (after, before) => base.keyOrderOf(toKeys(after), toKeys(before)),
  };
}

/**
 * A variable's value as its file gives it : in the YAML type of the variable's documented type
 * (help.yaml) - a number as a number, a yes or no as true or false - and any other value, or one
 * that is not of its type, as text (a text that looks like a number stays quoted). The app keeps
 * them as text ; a file may give either, both are read the same (mapFieldSet.check).
 *
 * Args:
 *   value (string): the value, as the app keeps it.
 *   type (string|undefined): its documented type (number, boolean, string).
 *
 * Returns:
 *   number|boolean|string: the value to write.
 */
export function typedValue(value, type) {
  const text = String(value ?? "");
  if (type === "number" && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return Number(text);
  if (type === "boolean" && /^(1|true|yes|on)$/i.test(text)) return true;
  if (type === "boolean" && /^(0|false|no|off)$/i.test(text)) return false;
  return text;
}

/**
 * The descriptor of an environment type.
 *
 * Args:
 *   spec (object):
 *     key, title, noun (string): as lib/repoObjects/singleType.js reads them ; key is also
 *       the page's owner in lib/envSave.js ENV_OWNERS.
 *     page (string): the page, as a refusal names it (Settings > System > General).
 *     all (boolean): its file holds every variable the page owns, the saved value or the
 *       documented default (a few switches) ; otherwise only the saved ones (many settings).
 *     seedHeld (boolean): the config seed holds its variables per field (lib/seedManaged.js).
 *
 * Returns:
 *   object: the descriptor.
 */
export function envType(spec) {
  // the page's variables a repository's file may hold : never one REPOSITORY_REFUSED names (a
  // command the server runs, the database, a path ...), refused when a file sets it, never written
  const owns = (name, docs) => ownsVariable(spec.key, name, docs) && !repositoryRefusal(name);
  // the config seed's hold on the page's variables ; none for a type it does not hold
  const hold = seedHold((name) => !!spec.seedHeld && ENV_OWNERS[spec.key](String(name)), keyOfVariable);
  const seeded = (current, opts = {}) => (opts.fromSeed ? [] : hold.seededOf(current));

  /**
   * The variables of a file checked as the page's Save checks them, before anything is applied.
   *
   * Args:
   *   declared (object): { NAME: value } (the names, its keys translated).
   *   opts (object): { fromSeed (true : the config seed's declaration - a variable set in the
   *     environment is said when it is applied, not refused) }.
   *
   * Returns:
   *   Promise<object>: the same values.
   *
   * Raises:
   *   Error: every variable refused, with why.
   */
  async function checkVariables(declared, opts = {}) {
    const docs = await envDocs();
    const managed = await EnvSettings.readManaged();
    const problems = [];
    for (const [name, value] of Object.entries(declared)) {
      // said by its key, as the file has it
      const key = keyOfVariable(name);
      if (!docs.has(name)) problems.push(`${key} is not a known environment variable`);
      else if (!ownsVariable(spec.key, name, docs)) problems.push(`${key} is not one ${spec.page} changes`);
      else if (repositoryRefusal(name)) problems.push(`${key} is not one a repository may set: ${repositoryRefusal(name)} (change it on ${spec.page})`);
      // the seed's : the environment's value kept, said when it is applied (lib/envSave.js)
      else if (EnvSettings.isOverridden(name, managed)) {
        if (!opts.fromSeed) problems.push(`${key} is set in the environment and cannot be changed from here`);
      }
      else {
        const problem = EnvSettings.validate(name, value, docs.get(name));
        if (problem) problems.push(problem.split(name).join(key));
      }
    }
    if (problems.length) throw new Error(problems.join("; "));
    return declared;
  }

  /**
   * The variables a declaration changes : those whose value is not the app's - the ones the
   * config seed manages left out, unless the seed itself applies them.
   *
   * Args:
   *   declared (object): the declaration (a file's, the seed's).
   *   current (object): the app's values (current).
   *   opts (object): { fromSeed (true : the seed's own declaration) }.
   *
   * Returns:
   *   string[]: the variables.
   */
  function changedNames(declared, current, opts = {}) {
    const held = seeded(current, opts);
    return Object.keys(declared).filter((name) => !held.includes(name) && String(declared[name]) !== String(current?.[name] ?? ""));
  }

  return singleType({
    key: spec.key,
    title: spec.title,
    noun: spec.noun,
    fields: variableFieldSet(),
    secretsOf: (current) => Object.keys(current || {}).filter(isSecret),
    // a variable's key in the file : its name in lower case
    keyOf: keyOfVariable,
    // the variables the page edits : those saved from it (the managed file), or every one with
    // its documented default ; never one set in the real environment
    current: async () => {
      const docs = await envDocs();
      const managed = await EnvSettings.readManaged();
      const out = {};
      if (spec.all) {
        for (const name of [...docs.keys()].filter((n) => owns(n, docs)).sort()) {
          if (EnvSettings.isOverridden(name, managed)) continue;
          out[name] = managed.has(name) ? managed.get(name) : String(docs.get(name).default ?? "");
        }
      } else {
        for (const [name, value] of managed) {
          if (owns(name, docs) && !EnvSettings.isOverridden(name, managed)) out[name] = value;
        }
      }
      if (spec.seedHeld) out._seedManaged = await hold.managed();
      // each variable's documented type, for its file (typedValue)
      Object.defineProperty(out, "_types", { value: Object.fromEntries(Object.keys(out).map((name) => [name, docs.get(name)?.type])) });
      return out;
    },
    // the variables the seed manages stay in the app (a seed-managed object stays with the seed)
    kept: hold.kept,
    // each value in its variable's type (typedValue)
    toFile: (current) => {
      const out = hold.without(current, current);
      for (const name of Object.keys(out)) out[name] = typedValue(out[name], current?._types?.[name]);
      return out;
    },
    fromFile: (declared, opts) => checkVariables(declared, opts),
    changed: (declared, current, opts = {}) => changedNames(declared, current, opts).length > 0,
    apply: async (declared, current, opts = {}) => {
      const updates = Object.fromEntries(changedNames(declared, current, opts).map((name) => [name, declared[name]]));
      const { restartRequired } = await saveEnvValues(updates, { user: opts.fromSeed ? "config seed" : "repository" }, opts);
      return restartRequired.length ? [`Saved ; applied at the next restart: ${restartRequired.join(", ")}`] : [];
    },
    // a repository's file declaring a variable the seed manages : not applied, said
    notesOf: hold.notesOf,
  });
}

export default { envType, keyOfVariable };
