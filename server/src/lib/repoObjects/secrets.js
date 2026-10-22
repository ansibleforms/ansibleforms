'use strict';
// The secret rule of the repository-backed objects (lib/repoObjects/engine.js) : a secret is never
// plain in git. A file gives a secret field as ${ENV} references only, resolved from the process
// environment as the config seed resolves them (lib/seed-schema.js interpolateEnv) ; a file holding
// a plain secret is refused. Only the secret fields are resolved : anywhere else a ${NAME} is plain
// text, or whoever can push to the repository could read any variable of the server (its token
// secret, its database password) through a field the app shows ; nor does a secret field name one
// of the server's own variables (lib/envSettings.js isServerOwnVariable), which the object would
// send where the file says. An app object is written to git without its secrets, which stay in
// the database.
import { interpolateEnv } from "../seed-schema.js";
import { isServerOwnVariable } from "../envSettings.js";

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
 * Checks a file's object against the secret rule, then resolves the ${ENV} references of its
 * secret fields - only those : the others keep a ${NAME} as plain text (the seed, a local file of
 * the administrator, resolves every field itself) ; a reference to one of the server's own
 * variables (isServerOwnVariable) is refused.
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
  // the server's own variables : never read into an object
  const own = [...new Set(secretFields.flatMap((f) => (typeof obj[f] === "string" ? [...obj[f].matchAll(ENV_REF)].map((m) => m[0].slice(2, -1)) : [])).filter(isServerOwnVariable))];
  if (own.length) {
    return {
      errors: [`it references ${own.sort().join(", ")}, the server's own: a repository's object never reads them`],
      object: null,
    };
  }
  try {
    const secrets = Object.fromEntries(secretFields.filter((f) => given(obj[f])).map((f) => [f, obj[f]]));
    return { errors: [], object: { ...obj, ...interpolateEnv(secrets, env) } };
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

// a user and a secret, or any user of an http address : a secret in a repository's uri
const SECRET_IN_URI = /^https?:\/\/[^/@\s]+@|:\/\/[^/@:\s]+:[^/@\s]+@/i;

/**
 * Whether a repository's address carries a user or a token (https://bot:token@host/...) : never
 * written to git, nor read from it.
 *
 * Args:
 *   uri (any): the address.
 *
 * Returns:
 *   boolean: true when it does.
 */
export const uriCarriesSecret = (uri) => SECRET_IN_URI.test(String(uri || ""));
