'use strict';
// Saving environment variables : what Settings > System > General's Save does, written once - for
// the page (controllers/v2/config.controller.js saveEnv), for the MCP page (the same route), and
// for a General or MCP repository's pull (lib/repoObjects/envType.js). Every value checked before
// anything is written (a known variable, not refused, not set in the real environment, valid for
// its documentation), then the managed file written, the other nodes told (the 'env' epoch), each
// variable applied at once when it can be or said to need a restart, and the change audited (the
// names only : the values include credentials).
import Help from "../models/help.model.js";
import Audit from "../models/audit.model.js";
import logger from "./logger.js";
import EnvSettings from "./envSettings.js";
import appConfig from "../../config/app.config.js";
import { bump } from "./epochs.js";
import { publish } from "./liveEvents.js";
import { BRANDING_ENV, MCP_ENV, assertBrandingFree } from "./brandingManaged.js";

// the mask the page shows a secret as : sent back, it means unchanged, never a value to store
export const ENV_MASK = "*** NOT REVEALED ***";

/**
 * A save refused : its HTTP status and why.
 */
export class EnvSaveError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "EnvSaveError";
    this.status = status;
  }
}

/**
 * The documented environment variables (help.yaml), by name.
 *
 * Returns:
 *   Promise<Map<string, object>>: each variable's documentation.
 */
export async function envDocs() {
  const help = await Help.get();
  const section = (help || []).find((x) => x.name === "Environment Variables");
  return new Map((section?.items || []).map((x) => [x.name, x]));
}

// the pages that save environment variables, each the variables it owns, by the repository type
// that keeps them : System > General (general) everything no other page nor the deployment owns
// (lib/envSettings.js OWNED_ELSEWHERE), Connections > MCP (mcp) the MCP server's settings - never
// one variable for two (OWNED_ELSEWHERE names the MCP ones)
export const ENV_OWNERS = {
  general: (name) => !EnvSettings.OWNED_ELSEWHERE.test(name),
  mcp: (name) => MCP_ENV.test(name),
};

// The variables a repository's file never sets, whatever page owns them : the page saves them (an
// admin's choice, typed in the app), a general.yaml would hand them to whoever may push to the
// repository. Each says why, as the pull output refuses it ; the app never writes them to the file.
export const REPOSITORY_REFUSED = [
  // a command line the server runs (git, the database dump and restore)
  { test: /_COMMAND$/, reason: "it is a command the server runs" },
  // where the app's own database is, and who it signs in as
  { test: /^DB_/, reason: "it says which database the app connects to" },
  // where the app reads its configuration, forms, playbooks and files from, and writes its logs,
  // backups and uploads to
  { test: /_PATH$/, reason: "it is a path the app reads or writes files at" },
  { test: /^ENABLE_CONFIG_IN_DATABASE$/, reason: "it says where the app reads its configuration from" },
  // ytt renders the configuration and the forms : its switch, the files its templates may reach
  // and the variables they read
  { test: /^(USE_YTT|YTT_[A-Z_]+)$/, reason: "it decides how the configuration templates are run" },
  // the expressions of the forms are code : how much of it runs
  { test: /^EXPRESSION_SANITIZER$/, reason: "it decides which code the forms' expressions may run" },
  // what the browser may load and run
  { test: /^CONTENT_SECURITY_POLICY$/, reason: "it decides what code the browser may load" },
  // the hosts the app's own calls may reach, and whether their certificates are checked
  { test: /^REST_(ALLOWED_HOSTS|DENIED_HOSTS|IGNORE_CERTS)$/, reason: "it decides which servers the app connects to" },
  // where a Microsoft sign-in is checked
  { test: /^(ENTRA|AZURE)_(AUTHORITY|GRAPH)_URI$/, reason: "it decides which server the sign-in trusts" },
  // which addresses the app trusts to name a client (its rate limits and lockouts)
  { test: /^TRUST_PROXY$/, reason: "it decides which proxies the app trusts" },
  // how the app listens, and with which certificate and key
  { test: /^(PORT|HTTPS|HTTPS_KEY|HTTPS_CERT)$/, reason: "it decides how the app listens for connections" },
];

/**
 * Why a repository's file may not set a variable (REPOSITORY_REFUSED), or null when it may.
 *
 * Args:
 *   name (string): the variable.
 *
 * Returns:
 *   string|null: the reason.
 */
export function repositoryRefusal(name) {
  return REPOSITORY_REFUSED.find((r) => r.test.test(String(name)))?.reason || null;
}

/**
 * Whether a page (by its repository type) shows and edits a variable : documented, not refused,
 * one it owns.
 *
 * Args:
 *   type (string): the page's repository type (general, mcp).
 *   name (string): the variable.
 *   docs (Map): the documented variables (envDocs).
 *
 * Returns:
 *   boolean: true when the page edits it.
 */
export function ownsVariable(type, name, docs) {
  return docs.has(name) && EnvSettings.classify(name) !== "refused" && !!ENV_OWNERS[type]?.(name);
}

/**
 * Whether Settings > System > General shows and edits a variable : documented, not refused, not
 * another page's nor the deployment's.
 *
 * Args:
 *   name (string): the variable.
 *   docs (Map): the documented variables (envDocs).
 *
 * Returns:
 *   boolean: true when the page edits it.
 */
export function onSettingsPage(name, docs) {
  return ownsVariable("general", name, docs);
}

/**
 * Saves environment variables as the settings page does.
 *
 * Args:
 *   updates (object): { NAME: value } ; an empty value clears it (back to its default).
 *   who (object): { user, ip } for the audit entry.
 *   opts (object): { fromSeed (true : the config seed's own write) }.
 *
 * Returns:
 *   Promise<object>: { changed: [name], restartRequired: [name] }.
 *
 * Raises:
 *   EnvSaveError: nothing given, the page writes nothing (ALLOW_ENV_EDIT=0), a value refused, or a
 *     branding or MCP setting the config seed manages changed (403).
 */
export async function saveEnvValues(updates, who = {}, opts = {}) {
  const names = Object.keys(updates || {});
  if (!names.length) throw new EnvSaveError(400, "No environment variables given");
  // 403 and not 401 : App.vue's axios interceptor treats any 401 as a dead session
  if (!appConfig.allowEnvEdit) throw new EnvSaveError(403, EnvSettings.ENV_EDIT_DISABLED_REASON);
  const docs = await envDocs();
  const managed = await EnvSettings.readManaged();
  // the branding's language and Designer's link, the MCP settings : the config seed's when its
  // branding or mcp section declares them (an MCP setting held by its variable)
  const seedFieldOf = (name) => BRANDING_ENV[name] || (MCP_ENV.test(name) ? name : null);
  const held = names.filter((name) => seedFieldOf(name) && String(updates[name] ?? "") !== String(process.env[name] ?? "")).map(seedFieldOf);
  try {
    await assertBrandingFree(held, opts);
  } catch (e) {
    throw new EnvSaveError(403, e.message);
  }

  // validate everything BEFORE writing anything : a partial write of a bad set would leave the
  // file describing a state nobody asked for
  for (const name of names) {
    if (!docs.has(name)) throw new EnvSaveError(400, `${name} is not a known environment variable`);
    if (EnvSettings.REFUSED[name]) throw new EnvSaveError(400, EnvSettings.REFUSED[name]);
    if (EnvSettings.isOverridden(name, managed)) throw new EnvSaveError(409, `${name} is set in the environment and cannot be changed from here`);
    // the client sends nothing for an unchanged secret, but never trust that : storing the mask
    // would replace a working credential with the literal placeholder
    if (String(updates[name] ?? "").trim() === ENV_MASK) throw new EnvSaveError(400, `${name} was not changed`);
    const problem = EnvSettings.validate(name, updates[name], docs.get(name));
    if (problem) throw new EnvSaveError(400, problem);
  }

  // PERSIST FIRST, then apply. applyLive mutates the running process - the log level, the paths,
  // the db pool size, the TLS context - and writeManaged can still fail after that (a read-only
  // persistent volume, ENOSPC). A write that fails now changes nothing at all.
  const valueOf = (name) => (updates[name] === null || updates[name] === undefined ? "" : String(updates[name]));
  for (const name of names) {
    if (valueOf(name) === "") managed.delete(name);
    else managed.set(name, valueOf(name));
  }
  await EnvSettings.writeManaged(managed);
  // the other nodes read the file again and apply what changed (init/cluster.js)
  bump("env");

  const restartRequired = [];
  for (const name of names) {
    // hand the documented default over : clearing a field means "back to the default", and
    // applyLive cannot know what that is ; an RTE's own variable : the app has nothing to apply,
    // and its restart would change nothing
    const live = EnvSettings.applyLive(name, valueOf(name), docs.get(name)?.default);
    if (EnvSettings.classify(name) !== "rte" && !live) restartRequired.push(name);
  }

  // the NAMES only : these values include credentials
  Audit.log({
    user: who.user,
    ip: who.ip,
    action: "settings.env.update",
    outcome: "success",
    targetType: "env",
    target: names.slice(0, 5).join(","),
    detail: { changed: names, restartRequired },
  });
  logger.notice(`Environment settings updated: ${names.join(", ")}`);
  // a variable the header shows (the Designer's link) : every open tab re-reads it at once
  publish("appearance");
  return { changed: names, restartRequired };
}

export default { ENV_MASK, ENV_OWNERS, REPOSITORY_REFUSED, repositoryRefusal, EnvSaveError, envDocs, ownsVariable, onSettingsPage, saveEnvValues };
