'use strict';
// The config seed's hold on a single-file type's fields (lib/brandingManaged.js) : the seed and a
// repository never own the same field. A field the seed declares stays the seed's - read only in
// the app, never written to the repository's file, never applied from it (said in the pull
// output), listed as staying in the app when the repository is made the type's ; the repository
// holds the other fields. Written once for the types the seed holds per field : the branding, the
// links (lib/repoObjects/appearanceType.js) and the MCP settings (lib/repoObjects/envType.js).
import { seedManagedBranding } from "../brandingManaged.js";

/**
 * The seed's hold on a type's fields.
 *
 * Args:
 *   isField (function): (name) => whether a field is the type's.
 *
 * Returns:
 *   object: {
 *     managed (() => Promise<string[]> : the fields the seed manages, put in current as _seedManaged),
 *     seededOf ((current) => the type's fields the seed manages),
 *     without ((obj, current) => the object without them, nor _seedManaged),
 *     kept ((current) => them, as staying in the app),
 *     notesOf ((declared, current) => a file declaring one of them : not applied, said),
 *   }
 */
export function seedHold(isField) {
  const seededOf = (current) => (current?._seedManaged || []).filter(isField);
  return {
    managed: () => seedManagedBranding(),
    seededOf,
    without(obj, current) {
      const out = { ...obj };
      delete out._seedManaged;
      for (const field of seededOf(current)) delete out[field];
      return out;
    },
    kept: (current) => seededOf(current).map((field) => ({ name: field, code: "seed", reason: "managed by the config seed" })),
    notesOf: (declared, current) => {
      const seeded = Object.keys(declared).filter((k) => seededOf(current).includes(k));
      return seeded.length ? [`Kept by the config seed, not applied: ${seeded.join(", ")}`] : [];
    },
  };
}

export default { seedHold };
