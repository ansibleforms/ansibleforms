// HashiCorp Vault : KV v2 (default) and KV v1, token authentication.
import axios from "axios";
import { agentsFor, baseUrl } from "./http.js";
import { LEASE_SECONDS } from "../lease.js";
import { stripTrailingSlashes, stripLeadingSlashes } from "../../lib/url.js";

function headers(store) {
  const h = { "X-Vault-Token": store.token };
  if (store.namespace) h["X-Vault-Namespace"] = store.namespace;
  return h;
}

function kvVersion(store) {
  return parseInt(store.kv_version, 10) === 1 ? 1 : 2;
}

// Normalize a vault path. Accepts:
//   "secret/data/foo/bar"   -> used as-is
//   "secret/foo/bar"        -> KV v2 : /data/ inserted after the mount
//   "foo"                   -> prefixed with the store's default mount
export function buildApiPath(rawPath, version, defaultMount) {
  let p = stripLeadingSlashes(rawPath);
  if (!p) throw new Error("Vault path is empty");
  if (!p.includes("/")) p = `${defaultMount || "secret"}/${p}`;
  if (version === 2) {
    const [mount, ...rest] = p.split("/");
    if (rest[0] !== "data" && rest[0] !== "metadata") return `${mount}/data/${rest.join("/")}`;
  }
  return p;
}

function assertConfigured(store) {
  if (!store.url || !store.token) throw new Error(`Secret store '${store.name}' has no url or no token`);
}

// A dynamic secret engine (database, aws, ...) issues credentials at <mount>/creds/<role> :
// read as written, not as KV, and every read creates a NEW account in the target system.
// This is only the SHAPE of such a path : a KV secret can just as well be stored at
// 'team/creds/app', so whether the mount really is a dynamic engine is decided by
// isDynamicRef below.
export function isDynamicPath(ref) {
  return /^\/*[^/]+\/creds\/[^/]+/.test(String(ref || ""));
}

// ===========================================================================
// DYNAMIC MOUNT DETECTION
// ===========================================================================
// The Vault secret engines that issue credentials at <mount>/creds/<role>.
export const DYNAMIC_ENGINE_TYPES = new Set([
  "database", "aws", "azure", "gcp", "consul", "nomad", "rabbitmq", "mongodbatlas",
  "ldap", "openldap", "ad", "kubernetes", "terraform", "alicloud",
]);
// how long a mount's engine type is remembered, per store
const MOUNT_TYPE_TTL_MS = 5 * 60 * 1000;
const mountTypeCache = new Map();

/** forget every remembered mount type (the tests) */
export function clearMountTypeCache() {
  mountTypeCache.clear();
}

/**
 * The mounts the admin declared as dynamic engines in the store's `extra`
 * ({"dynamic_mounts": ["database", "aws-prod"]} or "database,aws-prod").
 *
 * Args:
 *   store (object): The secret store row.
 *
 * Returns:
 *   string[]|null: The mount names, or null when none are declared.
 */
function declaredDynamicMounts(store) {
  let extra = store?.extra;
  if (typeof extra === "string") {
    try { extra = JSON.parse(extra); } catch { extra = null; }
  }
  const raw = extra && typeof extra === "object" ? extra.dynamic_mounts : undefined;
  if (raw === undefined || raw === null || raw === "") return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((m) => stripTrailingSlashes(stripLeadingSlashes(String(m).trim()))).filter(Boolean);
}

/**
 * Asks Vault which engine serves a mount (sys/internal/ui/mounts/<mount>, the endpoint
 * Vault's own UI uses : it answers for any mount the token may use, no sudo needed).
 *
 * Args:
 *   store (object): The secret store row.
 *   mount (string): The mount name.
 *
 * Returns:
 *   Promise<string|null>: The engine type ('kv', 'database', ...), null when Vault
 *     does not say (no permission, an old Vault, unreachable).
 */
async function mountType(store, mount) {
  const key = `${store.url}|${store.namespace || ""}|${mount}`;
  const hit = mountTypeCache.get(key);
  if (hit && Date.now() - hit.at < MOUNT_TYPE_TTL_MS) return hit.type;
  let type;
  try {
    const res = await axios.get(`${baseUrl(store)}/v1/sys/internal/ui/mounts/${encodeURIComponent(mount)}`, { headers: headers(store), ...agentsFor(store), timeout: 5000 });
    type = String(res?.data?.data?.type || "").toLowerCase() || null;
  } catch {
    type = null;
  }
  // an unknown answer is remembered too, so the fallback does not ask on every read
  mountTypeCache.set(key, { type, at: Date.now() });
  return type;
}

/**
 * Whether a ref is read from a dynamic secret engine.
 *
 * Only a path shaped <mount>/creds/<role> can be, and then :
 * 1. when the store's extra declares dynamic_mounts, the mount must be one of them ;
 * 2. the store's default mount is its KV mount, never a dynamic engine ;
 * 3. otherwise Vault is asked which engine serves the mount : a known dynamic engine
 *    is dynamic, anything else (kv, generic, ...) is read as KV ;
 * 4. when Vault does not say, the path's shape decides, as before, so the existing
 *    dynamic setups keep working.
 * A KV secret stored at 'team/creds/app' was read as a dynamic credential : no /data/
 * inserted, so KV v2 answered 404.
 *
 * Args:
 *   store (object): The secret store row.
 *   ref (string): The path asked for.
 *
 * Returns:
 *   Promise<boolean>: true to read it as a dynamic credential.
 */
export async function isDynamicRef(store, ref) {
  if (!isDynamicPath(ref)) return false;
  const mount = stripLeadingSlashes(String(ref)).split("/")[0];
  // step 1 : the admin's own declaration wins
  const declared = declaredDynamicMounts(store);
  if (declared) return declared.includes(mount);
  // step 2 : the configured KV mount
  if (mount === (store.default_mount || "secret")) return false;
  // step 3 / 4 : the engine type, when Vault tells it
  const type = await mountType(store, mount);
  if (type === null) return true;
  return DYNAMIC_ENGINE_TYPES.has(type);
}

// A ref is a path below /v1/ and nothing else. The URL parser resolves dot segments, so
// `x/creds/y/../../../auth/token/lookup-self` used to reach the token's own endpoint and
// hand back the store's token ; `?` and `#` would rewrite the request the same way.
export function assertSafeRef(ref) {
  const text = String(ref ?? "");
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* malformed escapes : judged as written */ }
  for (const candidate of [text, decoded]) {
    if (/[?#\\]/.test(candidate) || candidate.split("/").some((seg) => seg === "." || seg === "..")) {
      throw new Error(`Vault path '${text}' is not allowed`);
    }
  }
}

/** the secret's key/value pairs */
async function read(store, ref) {
  assertConfigured(store);
  assertSafeRef(ref);
  if (await isDynamicRef(store, ref)) return readDynamic(store, stripLeadingSlashes(ref));
  const version = kvVersion(store);
  const apiPath = buildApiPath(ref, version, store.default_mount);
  let res;
  try {
    res = await axios.get(`${baseUrl(store)}/v1/${apiPath}`, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.errors?.join(", ") || e.message;
    throw new Error(`Vault read failed for ${apiPath} (HTTP ${status || "?"}): ${msg}`, { cause: e });
  }
  // KV v2 wraps payload under data.data ; KV v1 puts it directly under data.
  const payload = version === 2 ? res?.data?.data?.data : res?.data?.data;
  if (!payload || typeof payload !== "object") {
    throw new Error(`Vault response for ${apiPath} did not contain a usable secret payload`);
  }
  return payload;
}

// { data: { username, password }, lease_duration } : the credentials are valid for the
// lease, which the registry's cache honours - reading again would create another account
async function readDynamic(store, apiPath) {
  assertSafeRef(apiPath);
  let res;
  try {
    res = await axios.get(`${baseUrl(store)}/v1/${apiPath}`, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.errors?.join(", ") || e.message;
    throw new Error(`Vault read failed for ${apiPath} (HTTP ${status || "?"}): ${msg}`, { cause: e });
  }
  const payload = res?.data?.data;
  if (!payload || typeof payload !== "object") {
    throw new Error(`Vault response for ${apiPath} did not contain usable credentials`);
  }
  const lease = parseInt(res?.data?.lease_duration, 10);
  return { ...payload, ...(lease > 0 ? { [LEASE_SECONDS]: lease } : {}) };
}

// Verifies the address, the token and the namespace WITHOUT reading a secret :
// token/lookup-self needs no policy beyond the token's own, so a correctly configured
// Vault always answers it, whatever the KV mount looks like. Read only by definition.
async function check(store, { timeoutMs = 10000 } = {}) {
  assertConfigured(store);
  try {
    const res = await axios.get(`${baseUrl(store)}/v1/auth/token/lookup-self`, { headers: headers(store), ...agentsFor(store), timeout: timeoutMs });
    const d = res?.data?.data || {};
    // never the token itself, and never its accessor
    return {
      addr: store.url,
      namespace: store.namespace || null,
      kvVersion: kvVersion(store),
      defaultMount: store.default_mount || "secret",
      renewable: !!d.renewable,
      // seconds left, or null for a token that never expires
      ttl: typeof d.ttl === "number" ? d.ttl : null,
      policies: Array.isArray(d.policies) ? d.policies : [],
    };
  } catch (e) {
    const status = e?.response?.status;
    if (status === 403) throw new Error("Vault refused the token (403) - check the token and its policies", { cause: e });
    if (status === 404) throw new Error("Vault did not recognise the token endpoint (404) - check the url", { cause: e });
    throw new Error(`Could not reach Vault at ${store.url}: ${e.message}`, { cause: e });
  }
}

// The KV mounts this token can see, for the Default mount dropdown.
// sys/internal/ui/mounts is what Vault's own UI calls: it returns only what the token is
// allowed to see and needs no root policy, unlike sys/mounts which usually requires sudo.
// A short timeout because this runs on page load.
async function mounts(store) {
  assertConfigured(store);
  let res;
  try {
    res = await axios.get(`${baseUrl(store)}/v1/sys/internal/ui/mounts`, { headers: headers(store), ...agentsFor(store), timeout: 5000 });
  } catch (e) {
    throw new Error(`Could not list the Vault mounts: ${e.message}`, { cause: e });
  }
  const secret = res?.data?.data?.secret || {};
  return Object.entries(secret)
    // only kv : a database or pki mount cannot answer a credential read
    .filter(([, v]) => String(v?.type || "").toLowerCase() === "kv")
    .map(([mountPath, v]) => ({
      path: stripTrailingSlashes(mountPath),
      version: String(v?.options?.version || v?.version || "") || null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ===========================================================================
// WRITING : a credential's secret typed in the app, written to its KV path
// ===========================================================================

/**
 * A path as it is written below a mount, without KV v2's data/ : what a write prefix is compared
 * with (secret/ansibleforms/db, whatever the KV version).
 *
 * Args:
 *   rawPath (string): the path (secret/foo, foo - the default mount's -, secret/data/foo).
 *   defaultMount (string): the store's default mount.
 *   bareIsMount (boolean): a path of one segment is a mount (a write prefix : secret, the whole
 *       mount), not a secret of the default mount.
 *
 * Returns:
 *   string: mount/path, without data/ or metadata/ and without a slash at either end.
 */
export function logicalPath(rawPath, defaultMount, bareIsMount = false) {
  let p = stripTrailingSlashes(stripLeadingSlashes(String(rawPath ?? "").trim()));
  if (!p) return "";
  if (!p.includes("/") && !bareIsMount) p = `${defaultMount || "secret"}/${p}`;
  const [mount, ...rest] = p.split("/");
  if (rest[0] === "data" || rest[0] === "metadata") rest.shift();
  return [mount, ...rest].join("/");
}

/**
 * Whether a path is one the store may be written at : its write prefix, or below it.
 *
 * Args:
 *   store (object): the secret store (write_prefix, default_mount).
 *   ref (string): the path.
 *
 * Returns:
 *   boolean: true when the path is the prefix or below it ; false without a prefix.
 */
export function withinWritePrefix(store, ref) {
  // a prefix of one segment is a whole mount (secret), never secret/secret
  const prefix = logicalPath(store?.write_prefix, store?.default_mount, true);
  const path = logicalPath(ref, store?.default_mount);
  if (!prefix || !path) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Whether a secret is at a path already : what a write that may not overwrite asks first.
 *
 * Args:
 *   store (object): the secret store, its token decrypted.
 *   ref (string): the path.
 *
 * Returns:
 *   Promise<boolean>: true when Vault has a secret there ; false when it answers 404.
 *
 * Raises:
 *   Error: Vault refused or could not be reached.
 */
async function exists(store, ref) {
  assertConfigured(store);
  assertSafeRef(ref);
  const apiPath = buildApiPath(ref, kvVersion(store), store.default_mount);
  try {
    const res = await axios.get(`${baseUrl(store)}/v1/${apiPath}`, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
    // KV v2 answers a deleted (or destroyed) latest version with its metadata and no data
    return kvVersion(store) === 2 ? !!res?.data?.data?.data : !!res?.data?.data;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404) return false;
    const msg = e?.response?.data?.errors?.join(", ") || e.message;
    throw new Error(`Vault could not tell whether ${apiPath} has a secret (HTTP ${status || "?"}): ${msg}`, { cause: e });
  }
}

/**
 * Writes a secret's key/value pairs to its KV path : a new secret, or a new version of the one
 * there (KV v2 keeps the earlier versions, KV v1 replaces it). A dynamic engine's path is never
 * written : Vault makes those credentials itself.
 *
 * Args:
 *   store (object): the secret store, its token decrypted.
 *   ref (string): the path.
 *   payload (object): the pairs ({ username, password }).
 *
 * Returns:
 *   Promise<void>
 *
 * Raises:
 *   Error: a dynamic engine's path, or Vault refused the write (the token's policy) or could not
 *     be reached - said with the path, never with the secret.
 */
async function write(store, ref, payload) {
  assertConfigured(store);
  assertSafeRef(ref);
  if (await isDynamicRef(store, ref)) throw new Error(`Vault path ${ref} is a dynamic secret engine's: Vault makes those credentials itself, nothing is written there`);
  const version = kvVersion(store);
  const apiPath = buildApiPath(ref, version, store.default_mount);
  const body = version === 2 ? { data: payload } : payload;
  try {
    await axios.post(`${baseUrl(store)}/v1/${apiPath}`, body, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
  } catch (e) {
    const status = e?.response?.status;
    if (status === 403) throw new Error(`Vault refused the write to ${apiPath} (403): the store's token needs the create and update capabilities on that path`, { cause: e });
    const msg = e?.response?.data?.errors?.join(", ") || e.message;
    throw new Error(`Vault write failed for ${apiPath} (HTTP ${status || "?"}): ${msg}`, { cause: e });
  }
}

export default { type: "vault", read, check, mounts, exists, write, withinWritePrefix };
