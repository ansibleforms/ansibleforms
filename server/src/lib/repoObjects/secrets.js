'use strict';
// The secret rule of the repository-backed objects (lib/repoObjects/engine.js) : a secret is never
// plain in git. A file gives a secret field as ${ENV} references only, resolved from the process
// environment as the config seed resolves them (lib/seed-schema.js interpolateEnv) ; a file holding
// a plain secret is refused. An app object is written to git without its secrets, which stay in
// the database.
import { interpolateEnv } from "../seed-schema.js";

// a ${VAR} reference, as the seed writes it
const ENV_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;

/**
 * Whether a value is given : not absent, null nor empty.
 *
 * Args:
 *   v (any): the value.
 *
 * Returns:
 *   boolean: true when it is.
 */
export const given = (v) => v !== undefined && v !== null && v !== "";

/**
 * Whether a secret field's value is made of ${ENV} references only (an empty one is no secret).
 *
 * Args:
 *   value (any): the value the file gives.
 *
 * Returns:
 *   boolean: true when it holds no plain text.
 */
export function onlyEnvRefs(value) {
  if (!given(value)) return true;
  if (typeof value !== "string") return false;
  return value.replace(ENV_REF, "").trim() === "";
}

/**
 * Checks a file's object against the secret rule, then resolves its ${ENV} references (every
 * field's, as the seed does).
 *
 * Args:
 *   obj (object): the object as the file gives it.
 *   secretFields (string[]): the type's secret fields.
 *   env (object): the environment (process.env when not given).
 *
 * Returns:
 *   object: { errors (string[]), object (resolved, null when refused) }.
 */
export function resolveSecrets(obj, secretFields = [], env = process.env) {
  const plain = secretFields.filter((f) => !onlyEnvRefs(obj[f]));
  if (plain.length) {
    return {
      errors: [`${plain.join(", ")} must be an \${ENV} reference: a secret is never written plain in git`],
      object: null,
    };
  }
  try {
    return { errors: [], object: interpolateEnv(obj, env) };
  } catch (e) {
    // the seed's own words : the variables that are not set
    return { errors: [String(e.message || e).replace(/^Seed file references/, "it references")], object: null };
  }
}

/**
 * An app object's fields as they are written to git : its secrets left out (they stay in the
 * database), and whether it had one.
 *
 * Args:
 *   obj (object): the fields.
 *   secretFields (string[]): the type's secret fields.
 *
 * Returns:
 *   object: { object (without its secrets), withoutSecret (boolean) }.
 */
export function withoutSecrets(obj, secretFields = []) {
  const out = { ...obj };
  let withoutSecret = false;
  for (const f of secretFields) {
    if (given(out[f])) withoutSecret = true;
    delete out[f];
  }
  return { object: out, withoutSecret };
}
