'use strict';
// The descriptors of the object types (lib/repoObjects/types.js) : each loaded when
// first needed - a descriptor reads its model, and the models read the engine back.

// the loader of each object type's descriptor
const LOADERS = {
  schedules: () => import("./schedules.js"),
  credentials: () => import("./credentials.js"),
  repositories: () => import("./repositories.js"),
  runners: () => import("./runners.js"),
  secret_stores: () => import("./secretStores.js"),
  databases: () => import("./databases.js"),
  groups: () => import("./groups.js"),
  users: () => import("./users.js"),
  notifications: () => import("./notifications.js"),
  sso: () => import("./sso.js"),
  ldap: () => import("./ldap.js"),
  syslog: () => import("./syslog.js"),
  labels: () => import("./labels.js"),
  chat_assistant: () => import("./chatAssistant.js"),
  general: () => import("./general.js"),
  mcp: () => import("./mcp.js"),
  ssh: () => import("./ssh.js"),
  defaults: () => import("./defaults.js"),
  logo: () => import("./logo.js"),
  icon: () => import("./icon.js"),
  name: () => import("./name.js"),
  links: () => import("./links.js"),
  announcements: () => import("./announcements.js"),
  disclaimer: () => import("./disclaimer.js"),
};

// the object types : every type kept as objects (types.js objects)
export const BUILT_OBJECT_TYPES = Object.keys(LOADERS);

// the descriptors loaded, by type
const loaded = new Map();

/**
 * The descriptor of an object type.
 *
 * Args:
 *   key (string): the type (credentials).
 *
 * Returns:
 *   Promise<object>: its descriptor.
 *
 * Raises:
 *   Error: a type that is no object type (forms, config ...).
 */
export async function descriptorOf(key) {
  if (!LOADERS[key]) throw new Error(`The ${key} usage holds no objects`);
  if (!loaded.has(key)) loaded.set(key, (await LOADERS[key]()).default);
  return loaded.get(key);
}
