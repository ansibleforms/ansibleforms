'use strict';
// The descriptors of the object types built so far (lib/repoObjects/types.js) : each loaded when
// first needed - a descriptor reads its model, and the models read the engine back.

// the loader of each built object type's descriptor
const LOADERS = {
  schedules: () => import("./schedules.js"),
  credentials: () => import("./credentials.js"),
  runners: () => import("./runners.js"),
};

// the object types built so far : the others are coming in a later version
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
 *   Error: a type not built yet.
 */
export async function descriptorOf(key) {
  if (!LOADERS[key]) throw new Error(`The ${key} usage comes in a later version`);
  if (!loaded.has(key)) loaded.set(key, (await LOADERS[key]()).default);
  return loaded.get(key);
}
