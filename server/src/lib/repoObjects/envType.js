'use strict';
// The environment types of the repository-backed objects (lib/repoObjects/engine.js, its
// single-file mode) : what a page that saves environment variables saves, in one file of a
// repository, keyed by the variables' names - System > General's (general.yaml) and Connections >
// MCP's (mcp.yaml). One way for both, written once : the variables a page owns (lib/envSave.js
// ownsVariable : never one variable for two pages, never a refused one, nor one set in the real
// environment), a secret one (its name ends in _PASSWORD, _SECRET, _TOKEN or _SECRET_PREVIOUS)
// an ${ENV} reference only, as the page masks it. A pull applies the file as the page's Save does
// (lib/envSave.js saveEnvValues) : every value checked first, the managed file written, the nodes
// told, each applied at once or said to need a restart, the change audited.
//
// A type the config seed holds per field (the MCP settings, its mcp section) : a variable the
// seed declares stays the seed's (lib/repoObjects/seedHold.js), the repository holds the others.
import EnvSettings from "../envSettings.js";
import { ENV_OWNERS, envDocs, ownsVariable, saveEnvValues } from "../envSave.js";
import { mapFieldSet } from "./fields.js";
import { seedHold } from "./seedHold.js";
import { singleType } from "./singleType.js";

// a secret by its name, as the page masks it
const isSecret = (name) => EnvSettings.SECRET_ENV_NAME.test(name);

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
 *     key, file, title, noun (string): as lib/repoObjects/singleType.js reads them ; key is also
 *       the page's owner in lib/envSave.js ENV_OWNERS.
 *     page (string): the page, as a refusal names it (Settings > System > General).
 *     all (boolean): its file holds every variable the page owns, the saved value or the
 *       documented default (a few switches) ; otherwise only the saved ones (many settings).
 *     seedHeld (boolean): the config seed holds its variables per field (lib/brandingManaged.js).
 *
 * Returns:
 *   object: the descriptor.
 */
export function envType(spec) {
  const owns = (name, docs) => ownsVariable(spec.key, name, docs);
  // the config seed's hold on the page's variables ; none for a type it does not hold
  const hold = seedHold((name) => !!spec.seedHeld && ENV_OWNERS[spec.key](String(name)));
  const seeded = (current, opts = {}) => (opts.fromSeed ? [] : hold.seededOf(current));

  /**
   * The variables of a file checked as the page's Save checks them, before anything is applied.
   *
   * Args:
   *   declared (object): { NAME: value }.
   *
   * Returns:
   *   Promise<object>: the same values.
   *
   * Raises:
   *   Error: every variable refused, with why.
   */
  async function checkVariables(declared) {
    const docs = await envDocs();
    const managed = await EnvSettings.readManaged();
    const problems = [];
    for (const [name, value] of Object.entries(declared)) {
      if (!docs.has(name)) problems.push(`${name} is not a known environment variable`);
      else if (!owns(name, docs)) problems.push(`${name} is not one ${spec.page} changes`);
      else if (EnvSettings.isOverridden(name, managed)) problems.push(`${name} is set in the environment and cannot be changed from here`);
      else {
        const problem = EnvSettings.validate(name, value, docs.get(name));
        if (problem) problems.push(problem);
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
    file: spec.file,
    title: spec.title,
    noun: spec.noun,
    fields: mapFieldSet({ isSecret }),
    secretsOf: (current) => Object.keys(current || {}).filter(isSecret),
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
      } else for (const [name, value] of managed) if (owns(name, docs)) out[name] = value;
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
    fromFile: (declared) => checkVariables(declared),
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

export default { envType };
