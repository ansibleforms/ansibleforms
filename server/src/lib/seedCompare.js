'use strict';
// How a declared item compares with its stored row : the config seed's (lib/seed.js) and the
// repository-backed objects' (lib/repoObjects), which read the seed's format from git. Pure.

// JSON with object keys in a stable (sorted) order, recursively, so two structurally
// equal documents always produce the same string. Array order is meaningful and is kept.
// Exported for the test that pins the MySQL key-sorting behaviour this exists for.
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

// Whether any declared field differs from what is stored.
//
// Without this the seed would rewrite every row on every boot, because encryption
// uses a random IV : the same password produces different ciphertext each time, so
// "did it change?" cannot be answered by comparing what is about to be written. That
// would make the audit trail claim a change on every restart and make the applied
// counts meaningless. Comparison is loose (String()) because a port declared as 389
// comes back from MySQL as "389" in a varchar column.
// Exported for the tests of the JSON comparisons.
export function differs(declared, stored) {
  for (const [key, value] of Object.entries(declared)) {
    if (key === "managed") continue;
    const before = stored[key];
    if (typeof value === "boolean") {
      if ((before ? 1 : 0) !== (value ? 1 : 0)) return true;
      continue;
    }
    if (value === null || value === undefined) continue;
    // A JSON column (oauth2_providers.extra) is returned PARSED by mysql2, so String()
    // gives "[object Object]" and every comparison against the declared string differed
    // - rewriting the row on every boot, and with it re-running the "only one enabled
    // provider per type" side effect that disables a sibling somebody enabled by hand.
    //
    // Comparing must be CANONICAL, not just structural: MySQL sorts an object's keys when
    // it stores JSON (verified - '{"b":2,"a":1}' comes back as '{"a":1,"b":2}'), while
    // JSON.parse preserves the declared order. A plain JSON.stringify of each side
    // therefore still differs for any declared object whose keys are not already sorted.
    if (before !== null && typeof before === "object") {
      let parsed = value;
      if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch { parsed = value; }
      }
      if (canonicalJson(before) !== canonicalJson(parsed)) return true;
      continue;
    }
    // the other way round : an object declared for a TEXT column holding JSON
    // (secret_stores.extra), which String() would turn into "[object Object]"
    if (typeof value === "object") {
      let parsed;
      try { parsed = JSON.parse(before ?? "null"); } catch { parsed = before; }
      if (canonicalJson(parsed) !== canonicalJson(value)) return true;
      continue;
    }
    if (String(before ?? "") !== String(value)) return true;
  }
  return false;
}
