'use strict';
// The controller's names in the environment : the AnsibleForms server that serves the web
// interface and the API and hands jobs to its runners, as the installer and the definitions call
// it. Before 7.8 its variables were named after "the app" : APP_URL and APP_TLS_VERIFY on an RTE,
// AF_ROLE=app for the web process. The old names still work, deprecated, removed in 8.0.0 : the new
// one wins when both are set, and each old one still set is said once at start.
//
//   CONTROLLER_URL         (was APP_URL)         the controller's address an RTE dials
//   CONTROLLER_TLS_VERIFY  (was APP_TLS_VERIFY)  whether an RTE checks the controller's certificate
//   AF_ROLE=controller     (was AF_ROLE=app)     the web interface and the API only

// each new name and the old one it replaces
export const CONTROLLER_ENV_ALIASES = Object.freeze({
  CONTROLLER_URL: "APP_URL",
  CONTROLLER_TLS_VERIFY: "APP_TLS_VERIFY",
});

/**
 * A controller variable's value : its new name's, else its old name's.
 *
 * Args:
 *   name (string): the new name (CONTROLLER_URL).
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   string|undefined: the value ; undefined when neither name is set.
 */
export function controllerEnv(name, env = process.env) {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  const old = CONTROLLER_ENV_ALIASES[name];
  return old && env[old] !== undefined && env[old] !== "" ? env[old] : undefined;
}

/**
 * The controller's address an RTE dials (CONTROLLER_URL, APP_URL before 7.8).
 *
 * Args:
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   string|undefined: the address ; undefined when it is not set.
 */
export const controllerUrl = (env = process.env) => controllerEnv("CONTROLLER_URL", env);

/**
 * Whether an RTE checks the controller's certificate (CONTROLLER_TLS_VERIFY, APP_TLS_VERIFY before
 * 7.8) : yes unless it is 0.
 *
 * Args:
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   boolean: true when the certificate is checked.
 */
export const controllerTlsVerify = (env = process.env) => String(controllerEnv("CONTROLLER_TLS_VERIFY", env) ?? "1") !== "0";

/**
 * The warnings for the old names still set, logged once at start : the variables named after the
 * app, and AF_ROLE=app.
 *
 * Args:
 *   env (object): the environment, process.env by default.
 *
 * Returns:
 *   string[]: one per old name set ; it says when the new name is set too, and wins.
 */
export function controllerEnvWarnings(env = process.env) {
  const warnings = [];
  for (const [name, old] of Object.entries(CONTROLLER_ENV_ALIASES)) {
    if (env[old] === undefined || env[old] === "") continue;
    const both = env[name] ? ` : ${name} is set too and wins, ${old} is ignored` : "";
    warnings.push(`${old} is deprecated, use ${name} (removed in 8.0)${both}`);
  }
  if (String(env.AF_ROLE || "").trim().toLowerCase() === "app") warnings.push("AF_ROLE=app is deprecated, use AF_ROLE=controller (removed in 8.0)");
  return warnings;
}

export default { CONTROLLER_ENV_ALIASES, controllerEnv, controllerUrl, controllerTlsVerify, controllerEnvWarnings };
