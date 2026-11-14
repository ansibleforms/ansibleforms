// HashiCorp Vault : KV v2 (default) and KV v1, token authentication.
import axios from "axios";
import { agentsFor, baseUrl } from "./http.js";
import { LEASE_SECONDS } from "../lease.js";
import { stripTrailingSlashes, stripLeadingSlashes } from "../../lib/url.js";
import Errors from "../../lib/errors.js";

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

// ===========================================================================
// ERRORS : what Vault answered, said plainly - with the path, never the secret
// ===========================================================================

/**
 * The error of a call to Vault that failed, as a user can act on it : Vault unreachable, the
 * store's token no longer valid, the token's policy refusing the path, no secret there, or what
 * Vault said.
 *
 * Args:
 *   e (Error): the axios error.
 *   store (object): the secret store (name, url).
 *   verb (string): what was done (read, write).
 *   apiPath (string): the API path called.
 *   needs (string): the capabilities that path needs (read ; read, create and update).
 *
 * Returns:
 *   Error: the error to throw, its cause the axios one.
 */
function vaultError(e, store, verb, apiPath, needs) {
  const status = e?.response?.status;
  const errors = e?.response?.data?.errors || [];
  const said = errors.join(", ").replace(/\s+/g, " ").trim();
  // no answer at all : the address, or the network
  if (!e?.response) return new Error(`Vault at ${store.url} could not be reached: ${e?.code || e?.message}`, { cause: e });
  // the token itself refused : revoked, expired or mistyped, whatever the path
  if (status === 403 && /invalid token|token.*expired/i.test(said)) {
    return new Error(`Vault refused the token of secret store '${store.name}': it is invalid, expired or revoked`, { cause: e });
  }
  if (status === 403) {
    return new Error(`Vault refused to ${verb} ${apiPath} (403): the store's token needs the ${needs} capabilities on that path`, { cause: e });
  }
  if (status === 404 && verb === "read") return new Error(`No secret at ${apiPath} in secret store '${store.name}'`, { cause: e });
  return new Error(`Vault ${verb} failed for ${apiPath} (HTTP ${status}): ${said || e.message}`, { cause: e });
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
    throw vaultError(e, store, "read", apiPath, "read");
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
    throw vaultError(e, store, "read", apiPath, "read");
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
 * with (secret/ansibleforms/db). Only a KV v2 store has a data/ (or metadata/) API segment after
 * its mount : on a KV v1 store a folder named data is a real folder, kept as written.
 *
 * Args:
 *   rawPath (string): the path (secret/foo, foo - the default mount's -, secret/data/foo).
 *   defaultMount (string): the store's default mount.
 *   bareIsMount (boolean): a path of one segment is a mount (a write prefix : secret, the whole
 *       mount), not a secret of the default mount.
 *   version (number): the store's KV version (1, or 2 the default) : only 2 drops data/ and
 *       metadata/.
 *
 * Returns:
 *   string: mount/path, without a slash at either end, and on KV v2 without data/ or metadata/.
 */
export function logicalPath(rawPath, defaultMount, bareIsMount = false, version = 2) {
  // 1. trim the path and its slashes : nothing left is no path
  let p = stripTrailingSlashes(stripLeadingSlashes(String(rawPath ?? "").trim()));
  if (!p) return "";
  // 2. a bare name is a secret of the default mount (unless it is a mount itself)
  if (!p.includes("/") && !bareIsMount) p = `${defaultMount || "secret"}/${p}`;
  // 3. KV v2 only : drop the API segment after the mount (KV v1 has none, data is a folder)
  const [mount, ...rest] = p.split("/");
  if (version === 2 && (rest[0] === "data" || rest[0] === "metadata")) rest.shift();
  return [mount, ...rest].join("/");
}

/**
 * Whether a path is one the store may be written at : its write prefix, or below it.
 *
 * Args:
 *   store (object): the secret store (write_prefix, default_mount, kv_version).
 *   ref (string): the path.
 *
 * Returns:
 *   boolean: true when the path is the prefix or below it ; false without a prefix.
 */
export function withinWritePrefix(store, ref) {
  // a prefix of one segment is a whole mount (secret), never secret/secret ; both sides are read
  // with the store's KV version, so a KV v1 folder named data stays a folder on each side
  const version = kvVersion(store || {});
  const prefix = logicalPath(store?.write_prefix, store?.default_mount, true, version);
  const path = logicalPath(ref, store?.default_mount, false, version);
  if (!prefix || !path) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Refuses a path that names a KV v2 secret's metadata endpoint (secret/metadata/foo) for a write :
 * the write prefix is compared without that segment (logicalPath), but the API path keeps it
 * (buildApiPath), so the check would ask the metadata (no secret there) and the write would post
 * to it, Vault answering 204 with no secret stored. On KV v1 a folder named metadata is a folder.
 *
 * Args:
 *   store (object): the secret store (kv_version, default_mount).
 *   ref (string): the path.
 *
 * Returns:
 *   void
 *
 * Raises:
 *   Errors.BadRequestError: the path names the metadata endpoint ; the message gives the secret's
 *     own path to use instead.
 */
export function assertWritablePath(store, ref) {
  // step 1 : only KV v2 has the metadata API segment after its mount
  if (kvVersion(store) !== 2) return;
  // step 2 : the path as the API is called with it, metadata/ right after the mount refused
  const [mount, segment] = buildApiPath(ref, 2, store.default_mount).split("/");
  if (segment !== "metadata") return;
  const own = logicalPath(ref, store.default_mount, false, 2);
  throw new Errors.BadRequestError(`Vault path ${stripLeadingSlashes(String(ref).trim())} names the metadata of a secret, not the secret: give the secret's path (${own || mount})`);
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
 *   Errors.BadRequestError: the path names a KV v2 secret's metadata (assertWritablePath).
 *   Error: Vault refused or could not be reached.
 */
async function exists(store, ref) {
  assertConfigured(store);
  assertSafeRef(ref);
  // the path checked is the one written : never the metadata endpoint
  assertWritablePath(store, ref);
  const apiPath = buildApiPath(ref, kvVersion(store), store.default_mount);
  try {
    const res = await axios.get(`${baseUrl(store)}/v1/${apiPath}`, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
    // KV v2 answers a deleted (or destroyed) latest version with its metadata and no data
    return kvVersion(store) === 2 ? !!res?.data?.data?.data : !!res?.data?.data;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404) return false;
    // checked before a write : what it needs is the write's
    throw vaultError(e, store, "read", apiPath, "read, create and update");
  }
}

/**
 * The key/value pairs a secret holds now, to be kept by a write : a KV write replaces the whole
 * secret (KV v2 makes its new version of the body alone), so the keys it does not name (host,
 * db_name, ...) would be lost.
 *
 * Args:
 *   store (object): the secret store, its token decrypted.
 *   apiPath (string): the secret's API path (secret/data/foo on KV v2).
 *   version (number): the store's KV version.
 *
 * Returns:
 *   Promise<object>: the pairs ; {} when no secret is there (404, or a deleted KV v2 version).
 *
 * Raises:
 *   Error: Vault refused the read (the token's policy) or could not be reached - said with the
 *     path, never with the secret.
 */
async function currentPairs(store, apiPath, version) {
  let res;
  try {
    res = await axios.get(`${baseUrl(store)}/v1/${apiPath}`, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
  } catch (e) {
    if (e?.response?.status === 404) return {};
    throw vaultError(e, store, "read", apiPath, "read, create and update");
  }
  // KV v2 wraps the pairs under data.data (null for a deleted version) ; KV v1 under data
  const pairs = version === 2 ? res?.data?.data?.data : res?.data?.data;
  return pairs && typeof pairs === "object" && !Array.isArray(pairs) ? pairs : {};
}

/**
 * The secret to write : the pairs there now, with the written ones replacing theirs. A secret
 * keeping its user under 'user' (read before 'username' as a credential) gets the new username
 * there too, so the old one is never read back instead.
 *
 * Args:
 *   current (object): the pairs there now ({} for a new secret).
 *   payload (object): the pairs written ({ username, password }).
 *
 * Returns:
 *   object: the merged pairs.
 */
export function mergePairs(current, payload) {
  // step 1 : every key kept, the written ones replaced
  const merged = { ...current, ...payload };
  // step 2 : the alias read before username follows it
  if (Object.prototype.hasOwnProperty.call(current, "user") && payload.username !== undefined && payload.user === undefined) {
    merged.user = payload.username;
  }
  return merged;
}

/**
 * Writes a secret's key/value pairs to its KV path : a new secret, or a new version of the one
 * there (KV v2 keeps the earlier versions, KV v1 replaces it). The keys of the secret there that
 * the payload does not name are kept : it is read first and written back merged. A dynamic
 * engine's path is never written : Vault makes those credentials itself.
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
 *   Errors.BadRequestError: the path names a KV v2 secret's metadata (assertWritablePath).
 *   Error: a dynamic engine's path, or Vault refused the read or the write (the token's policy) or could not
 *     be reached - said with the path, never with the secret.
 */
async function write(store, ref, payload) {
  assertConfigured(store);
  assertSafeRef(ref);
  // a secret's data is written, never its metadata (Vault would answer 204 and store nothing)
  assertWritablePath(store, ref);
  if (await isDynamicRef(store, ref)) throw new Error(`Vault path ${ref} is a dynamic secret engine's: Vault makes those credentials itself, nothing is written there`);
  const version = kvVersion(store);
  const apiPath = buildApiPath(ref, version, store.default_mount);
  // step 1 : the secret there now, so its other keys are written back (never logged)
  const pairs = mergePairs(await currentPairs(store, apiPath, version), payload);
  // step 2 : the whole secret written, under data on KV v2
  const body = version === 2 ? { data: pairs } : pairs;
  try {
    await axios.post(`${baseUrl(store)}/v1/${apiPath}`, body, { headers: headers(store), ...agentsFor(store), timeout: 10000 });
  } catch (e) {
    throw vaultError(e, store, "write", apiPath, "read, create and update");
  }
}

export default { type: "vault", read, check, mounts, exists, write, withinWritePrefix };
