'use strict';
// The Settings type of the repository-backed objects (lib/repoObjects/engine.js, its single-file
// mode) : the System > General settings in a repository's settings.yaml, keyed by their
// environment variable names - the variables that page itself changes, never one another page or
// the deployment owns (lib/envSettings.js OWNED_ELSEWHERE), a refused one, nor one set in the real
// environment. A secret one (its name ends in _PASSWORD, _SECRET, _TOKEN or _SECRET_PREVIOUS) is an
// ${ENV} reference only. A pull applies the file as the page's Save does (lib/envSave.js) : every
// value checked first, the managed file written, the nodes told, each applied at once or said to
// need a restart, the change audited. What the app writes to it : the variables saved from the page.
import EnvSettings from "../envSettings.js";
import { envDocs, onSettingsPage, saveEnvValues } from "../envSave.js";
import { mapFieldSet } from "./fields.js";
import { singleType } from "./singleType.js";

// a secret by its name, as the page masks it
const isSecret = (name) => EnvSettings.SECRET_ENV_NAME.test(name);

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
    else if (!onSettingsPage(name, docs)) problems.push(`${name} is not one Settings > System > General changes`);
    else if (EnvSettings.isOverridden(name, managed)) problems.push(`${name} is set in the environment and cannot be changed from here`);
    else {
      const problem = EnvSettings.validate(name, value, docs.get(name));
      if (problem) problems.push(problem);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return declared;
}

export default singleType({
  key: "settings",
  file: "settings.yaml",
  title: "Settings",
  noun: "settings",
  fields: mapFieldSet({ isSecret }),
  secretsOf: (current) => Object.keys(current || {}).filter(isSecret),
  // the variables saved from the page (the managed file), those the page edits
  current: async () => {
    const docs = await envDocs();
    const managed = await EnvSettings.readManaged();
    return Object.fromEntries([...managed].filter(([name]) => onSettingsPage(name, docs)));
  },
  fromFile: (declared) => checkVariables(declared),
  changed: (declared, current) => Object.keys(declared).some((name) => String(declared[name]) !== String(current?.[name] ?? "")),
  apply: async (declared, current) => {
    const updates = Object.fromEntries(Object.entries(declared).filter(([name, value]) => String(value) !== String(current?.[name] ?? "")));
    const { restartRequired } = await saveEnvValues(updates, { user: "repository" });
    return restartRequired.length ? [`Saved ; applied at the next restart: ${restartRequired.join(", ")}`] : [];
  },
});
