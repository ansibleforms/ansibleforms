'use strict';
// The usage types of a repository : what the app reads from it, one flag each (use_for_<type>),
// grouped in five categories as its Usage step shows them. The one list the server knows them
// by : the repository model, its controller, the config seed's schema and the engine of the
// repository-backed objects (lib/repoObjects/engine.js) all read it.
//
// A type is one of two kinds :
//   a content type  (forms, playbooks, workflows, inventories, roles, categories, constants) :
//                   files the app reads as they are ; several repositories may hold forms,
//                   workflows and inventories, the app uses the first one of playbooks (its Usage
//                   step greys the box on the others, the server only warns), and one repository
//                   at most holds the roles, the categories and the constants, each read from the
//                   file of the repository that gives its top-level key (lib/configKeys.js)
//   an object type  (schedules, credentials, runners, secret stores, SSO ...) : objects kept in
//                   step with a table both ways by the engine (lib/repoObjects/engine.js), one
//                   repository at most, refused by the API and the seed
//
// Where a repository keeps them is its files' content, never their names nor their folders
// (lib/repoObjects/repoFiles.js) : any YAML file of the repository, at any depth, whose top-level
// key is a type's file key - controller_ and the type's key (controller_credentials:,
// controller_defaults:, controller_roles: ...) - holds that type : a list of objects for most, one
// map for a type the app has one of (single). A plain key (credentials:, roles:) is no type's : an
// Ansible file may give it (a Galaxy requirements file's roles:, a vars file's labels:).

import Errors from "../errors.js";

// ===========================================================================
// THE TYPES
// ===========================================================================

// the categories, in the order the Usage step shows them
export const CATEGORIES = ["designer", "jobs", "system", "appearance", "access", "connections"];

// every usage type, in its category's order :
//   key        the type (its translation key on the client)
//   flag       its column of the repositories table
//   category   its heading
//   objects    kept in step with the app by the engine, read from the files that give its key
//   single     the app has one object of it (a map under its key, in one file at most) : the
//              others are lists of objects, found by their name
//   config     a key of the base configuration (lib/configKeys.js), read from the file giving it
//   map        a configuration key whose value is one map (the constants) : the others a list
//   oneOnly    one repository at most (the server refuses a second)
//   label      how the server's messages name it
//   references the object types its objects name (a runner its credential) : read again when
//              those are pulled, an object waiting for what it names finds it then
//   options    the role options that open its page, when not its category's (CATEGORY_OPTIONS)
export const USAGE_TYPES = [
  { key: "categories", config: true, flag: "use_for_categories", category: "designer", oneOnly: true, label: "categories" },
  { key: "constants", config: true, map: true, flag: "use_for_constants", category: "designer", oneOnly: true, label: "constants" },
  { key: "forms", flag: "use_for_forms", category: "designer", label: "forms" },
  { key: "inventories", flag: "use_for_inventories", category: "designer", label: "inventories" },
  { key: "playbooks", flag: "use_for_playbooks", category: "designer", label: "playbooks" },
  { key: "workflows", flag: "use_for_workflows", category: "designer", label: "workflows" },
  { key: "schedules", flag: "use_for_schedules", category: "jobs", objects: true, oneOnly: true, label: "schedules" },
  { key: "general", single: true, flag: "use_for_general", category: "system", objects: true, oneOnly: true, label: "general settings" },
  // the Appearance pages, one key each, in the menu's order
  { key: "defaults", single: true, flag: "use_for_defaults", category: "appearance", objects: true, oneOnly: true, label: "defaults" },
  { key: "logo", single: true, flag: "use_for_logo", category: "appearance", objects: true, oneOnly: true, label: "logo" },
  { key: "icon", single: true, flag: "use_for_icon", category: "appearance", objects: true, oneOnly: true, label: "icon" },
  { key: "name", single: true, flag: "use_for_name", category: "appearance", objects: true, oneOnly: true, label: "name" },
  { key: "links", single: true, flag: "use_for_links", category: "appearance", objects: true, oneOnly: true, label: "links" },
  { key: "labels", flag: "use_for_labels", category: "appearance", objects: true, oneOnly: true, label: "labels" },
  { key: "announcements", flag: "use_for_announcements", category: "appearance", objects: true, oneOnly: true, label: "announcements" },
  { key: "disclaimer", flag: "use_for_disclaimer", category: "access", objects: true, oneOnly: true, label: "disclaimer" },
  { key: "roles", config: true, flag: "use_for_roles", category: "access", oneOnly: true, label: "roles" },
  { key: "ldap", references: ["credentials"], flag: "use_for_ldap", category: "access", objects: true, oneOnly: true, label: "LDAP directories" },
  { key: "sso", references: ["credentials"], flag: "use_for_sso", category: "access", objects: true, oneOnly: true, label: "SSO providers" },
  { key: "repositories", references: ["credentials"], flag: "use_for_repositories", category: "connections", objects: true, oneOnly: true, label: "repositories" },
  { key: "credentials", flag: "use_for_credentials", category: "connections", objects: true, oneOnly: true, label: "credentials" },
  { key: "secret_stores", references: ["credentials"], flag: "use_for_secret_stores", category: "connections", objects: true, oneOnly: true, label: "secret stores" },
  // the databases forms query, each naming its credential of type database
  { key: "databases", references: ["credentials"], flag: "use_for_databases", category: "connections", objects: true, oneOnly: true, label: "databases" },
  { key: "runners", references: ["credentials"], flag: "use_for_runners", category: "connections", objects: true, oneOnly: true, label: "runners" },
  { key: "notifications", references: ["credentials"], flag: "use_for_notifications", category: "connections", objects: true, oneOnly: true, label: "notifications" },
  { key: "chat_assistant", single: true, references: ["credentials"], flag: "use_for_chat_assistant", category: "connections", objects: true, oneOnly: true, label: "chat assistant" },
  { key: "mcp", single: true, flag: "use_for_mcp", category: "connections", objects: true, oneOnly: true, label: "MCP settings" },
  // its page is the admin settings' (a server added receives every log line and audit entry)
  { key: "syslog", flag: "use_for_syslog", category: "connections", objects: true, oneOnly: true, label: "syslog servers", options: ["showSettings"] },
];

// the role options that open the pages of each category's types (lib/middleware.js), any one of
// them ; a type whose page another option opens names its own (options)
const CATEGORY_OPTIONS = {
  jobs: ["allowScheduledJobs"],
  system: ["showSettings"],
  appearance: ["showSettings", "showAppearanceSettings"],
  access: ["showSettings"],
  connections: ["showSettings", "showConnectionsSettings"],
};

// the types a repository's YAML files hold by a top-level key (lib/repoObjects/repoFiles.js) : each
// object type and each configuration key, by its type's key
export const CONTENT_KEYS = USAGE_TYPES.filter((t) => t.objects || t.config).map((t) => t.key);

// the prefix of every top-level key a type is given by in a repository's files
export const KEY_PREFIX = "controller_";

/**
 * The top-level key a repository's files give a type by : the prefix and the type's key.
 *
 * Args:
 *   key (string): the type (credentials).
 *
 * Returns:
 *   string: its file key (controller_credentials).
 */
export const fileKeyOf = (key) => `${KEY_PREFIX}${key}`;

// the top-level keys a repository's YAML files hold the types by, in CONTENT_KEYS' order
export const FILE_KEYS = CONTENT_KEYS.map(fileKeyOf);

/**
 * Whether a value under a type's key has the type's shape : one map for a type the app has one of
 * (and the constants), else a list of maps (an entry each) ; nothing under the key (none yet) fits
 * either. Any other value (a vars file's list of names : controller_labels: with - web and - frontend) is no
 * type's.
 *
 * Args:
 *   key (string): the type (labels).
 *   value (any): the value under its key.
 *
 * Returns:
 *   boolean: true when it fits.
 */
export function fitsType(key, value) {
  if (value === null || value === undefined) return true;
  const isMap = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const type = typeOf(key);
  if (type?.single || type?.map) return isMap(value);
  return Array.isArray(value) && value.every(isMap);
}

/**
 * The type a top-level key of a repository's file gives.
 *
 * Args:
 *   fileKey (any): the key (controller_credentials).
 *
 * Returns:
 *   string|null: the type (credentials) ; null when it gives none (a plain credentials: among them).
 */
export function typeKeyOf(fileKey) {
  if (typeof fileKey !== "string" || !fileKey.startsWith(KEY_PREFIX)) return null;
  const key = fileKey.slice(KEY_PREFIX.length);
  return CONTENT_KEYS.includes(key) ? key : null;
}

// every usage flag, as the repositories table, its API and the config seed know them
export const USAGE_FLAGS = USAGE_TYPES.map((t) => t.flag);

// the flags one repository at most may have
export const ONE_ONLY_FLAGS = USAGE_TYPES.filter((t) => t.oneOnly).map((t) => t.flag);

// The order the object types are read in, at the worker's start and in one pull : the
// credentials and the secret stores first, then what signs in or connects with them, then the
// independent ones - so an object finds what it names. One that does not is said and waits
// (engine.js).
export const APPLY_ORDER = [
  "credentials",
  // the repositories after the credentials they sign in with, before every other type : one made
  // from its repositories: entries may hold any of them
  "repositories",
  "secret_stores",
  // the databases after the credentials they connect with
  "databases",
  "runners",
  "sso",
  "ldap",
  "notifications",
  "syslog",
  "chat_assistant",
  "schedules",
  "disclaimer",
  "defaults",
  "logo",
  "icon",
  "name",
  "links",
  "labels",
  "announcements",
  "general",
  "mcp",
];

// ===========================================================================
// HELPERS
// ===========================================================================

/**
 * A usage type by its key.
 *
 * Args:
 *   key (string): the type (credentials).
 *
 * Returns:
 *   object|undefined: the type.
 */
export function typeOf(key) {
  return USAGE_TYPES.find((t) => t.key === key);
}

/**
 * A usage type by its flag.
 *
 * Args:
 *   flag (string): the flag (use_for_credentials).
 *
 * Returns:
 *   object|undefined: the type.
 */
export function typeOfFlag(flag) {
  return USAGE_TYPES.find((t) => t.flag === flag);
}

// a usage flag sent as text : the words it may be (any case, spaces around)
const FLAG_WORDS = { 1: true, true: true, 0: false, false: false };

/**
 * A usage flag as on or off, whatever it is sent as : true, 1, '1' or 'true' is on ; false, 0,
 * '0', 'false' (and none) is off ; anything else is neither. The one reading of a flag : the
 * table stores any truthy value as on (CrudModel.getFieldValues), so a value read here as off
 * but stored as on ('yes', 2) passed the admin rule and the one-repository rule while it turned
 * the usage on.
 *
 * Args:
 *   v (any): the flag.
 *
 * Returns:
 *   boolean|undefined: true when on, false when off, undefined when it is neither.
 */
export function flagValue(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === null || v === undefined) return false;
  if (typeof v === "string") return FLAG_WORDS[v.trim().toLowerCase()];
  return undefined;
}

/**
 * Whether a usage flag is on (flagValue).
 *
 * Args:
 *   v (any): the flag.
 *
 * Returns:
 *   boolean: true when it is on.
 */
export function flagOn(v) {
  return flagValue(v) === true;
}

/**
 * A repository's usage flags as the table stores them (1 or 0), before anything reads them : the
 * admin rule, the one-repository rule and the write all see the same value. A flag not sent, or
 * sent empty (left as it is by an update), is not touched.
 *
 * Args:
 *   data (object): the repository written (changed in place).
 *
 * Returns:
 *   object: the same data.
 *
 * Raises:
 *   Errors.BadRequestError: a flag that is neither on nor off.
 */
export function normalizeUsageFlags(data) {
  for (const flag of USAGE_FLAGS) {
    const v = data?.[flag];
    if (v === undefined || v === null || v === "") continue;
    const on = flagValue(v);
    if (on === undefined) throw new Errors.BadRequestError(`${flag} must be true or false: '${v}' is neither`);
    data[flag] = on ? 1 : 0;
  }
  return data;
}

/**
 * Whether a user may read what a type's page shows : an admin, or one of the role options that
 * open that page (CATEGORY_OPTIONS, a type's own options). What a repository's usage would take of
 * a type names its objects, so it is read with that page's right.
 *
 * Args:
 *   key (string): the type.
 *   user (object): the signed-in user ({ roles, options }).
 *
 * Returns:
 *   boolean: true when they may.
 */
export function mayReadType(key, user) {
  const type = typeOf(key);
  if (!type) return false;
  if ((user?.roles || []).includes("admin")) return true;
  return (type.options || CATEGORY_OPTIONS[type.category] || []).some((option) => !!user?.options?.[option]);
}

/**
 * The object types a repository is used for, in APPLY_ORDER.
 *
 * Args:
 *   repo (object): the repository's row (its use_for_* flags).
 *
 * Returns:
 *   string[]: the type keys (credentials, runners ...).
 */
export function objectTypesOf(repo) {
  return APPLY_ORDER.filter((key) => {
    const type = typeOf(key);
    return type?.objects && !!Number(repo?.[type.flag] ?? 0);
  });
}

export default { CATEGORIES, USAGE_TYPES, CONTENT_KEYS, KEY_PREFIX, FILE_KEYS, fileKeyOf, typeKeyOf, fitsType, USAGE_FLAGS, ONE_ONLY_FLAGS, APPLY_ORDER, typeOf, typeOfFlag, flagValue, flagOn, normalizeUsageFlags, mayReadType, objectTypesOf };
