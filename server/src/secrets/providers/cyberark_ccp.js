// CyberArk Central Credential Provider (CCP) : the REST interface of the CyberArk Application
// Access Manager. The application authenticates by its AppID, which the vault admin restricts
// to client certificates, allowed machines (IP/hostname) and/or OS users.
//
//   GET {url}/AIMWebService/api/Accounts?AppID=<app_id>&Safe=..&Object=..
//   200 { Content, UserName, Address, Database, PolicyID, Safe, Folder, Name, ... }
//   4xx { ErrorCode: "APPAP004E", ErrorMsg: "Password object matching query [..] was not found" }
//
// The reference names the account, as ;-separated pairs :
//   Safe=Linux;Object=root-srv01
//   Safe=DB;UserName=forms;Address=db01.example.com
//   Query=Safe=Linux;Folder=Root;Object=root-srv01   (the rest is passed as CCP's Query)
import axios from "axios";
import { agentsFor, baseUrl } from "./http.js";
import SecretStore from "../../models/secretStore.model.js";
import CrudModel from "../../models/crud.model.js";
import { stripTrailingSlashes } from "../../lib/url.js";

const PATH = "/AIMWebService/api/Accounts";

// What a reference may set. AppID is the store's, never the reference's : a form author
// must not be able to borrow another application's identity.
const ALLOWED = ["Safe", "Folder", "Object", "UserName", "Address", "Database", "PolicyID", "Reason", "Query", "QueryFormat", "ConnectionTimeout", "FailRequestOnPasswordChange"];
const CANONICAL = Object.fromEntries(ALLOWED.map((k) => [k.toLowerCase(), k]));

/** the reference as CCP query parameters, AppID and Reason added */
export function buildQuery(store, ref) {
  const params = {};
  const raw = String(ref || "").trim();
  if (!raw) throw new Error("CyberArk reference is empty - use e.g. Safe=<safe>;Object=<account>");
  if (/^query=/i.test(raw)) {
    // everything after Query= is CCP's own query syntax, ; included
    params.Query = raw.slice(raw.indexOf("=") + 1);
  } else {
    for (const pair of raw.split(";")) {
      if (!pair.trim()) continue;
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`CyberArk reference: '${pair.trim()}' is not key=value`);
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key.toLowerCase() === "appid") continue;
      const canonical = CANONICAL[key.toLowerCase()];
      if (!canonical) throw new Error(`CyberArk reference: '${key}' is not supported - use ${ALLOWED.join(", ")}`);
      params[canonical] = value;
    }
  }
  if (params.Query && !params.QueryFormat) params.QueryFormat = "Exact";
  const extra = SecretStore.extraOf(store);
  if (!params.Reason && extra.reason) params.Reason = String(extra.reason);
  if (!store.app_id) throw new Error(`Secret store '${store.name}' has no AppID`);
  return { AppID: store.app_id, ...params };
}

function queryString(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

function timeoutOf(store, fallback) {
  const t = parseInt(SecretStore.extraOf(store).timeout_ms, 10);
  return Number.isFinite(t) && t > 0 ? t : fallback;
}

// "APPAP004E : Password object matching query [...] was not found" - never the request,
// which can name the safe and account but holds nothing secret either
function describeError(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  if (data && typeof data === "object" && (data.ErrorCode || data.ErrorMsg)) {
    return { status, code: data.ErrorCode || "", text: `${data.ErrorCode || "error"}: ${data.ErrorMsg || ""}`.trim() };
  }
  return { status, code: "", text: e?.message || String(e) };
}

async function request(store, params, timeoutMs) {
  return axios.get(`${baseUrl(store)}${PATH}?${queryString(params)}`, {
    ...agentsFor(store),
    timeout: timeoutMs,
    headers: { Accept: "application/json" },
  });
}

/** the account, under the names the registry maps : username, password, address, port, database */
async function read(store, ref) {
  const params = buildQuery(store, ref);
  let res;
  try {
    res = await request(store, params, timeoutOf(store, 10000));
  } catch (e) {
    const err = describeError(e);
    throw new Error(`CyberArk CCP read failed (HTTP ${err.status || "?"}): ${err.text}`, { cause: e });
  }
  const account = res?.data;
  if (!account || typeof account !== "object" || account.Content === undefined) {
    throw new Error("CyberArk CCP answered without a password (no Content in the response)");
  }
  const { Content, UserName, Address, Port, Database, ...rest } = account;
  return {
    ...rest,
    username: UserName ?? "",
    password: Content,
    ...(Address ? { address: Address } : {}),
    ...(Port ? { port: Port } : {}),
    ...(Database ? { database: Database } : {}),
  };
}

// Without extra.check_ref : ask for nothing in particular. A provider that knows the AppID
// answers with an APPAP error about the missing query ; one that refuses the application
// (wrong AppID, certificate or machine) answers 403. With extra.check_ref : a real read,
// reporting who and where, never the password.
async function check(store, { timeoutMs } = {}) {
  const timeout = timeoutMs || timeoutOf(store, 10000);
  const extra = SecretStore.extraOf(store);
  const base = { addr: store.url, appId: store.app_id || null, clientCertificate: !!store.client_cert };
  if (extra.check_ref) {
    const account = await read({ ...store, extra: JSON.stringify({ ...extra, timeout_ms: timeout }) }, extra.check_ref);
    return { ...base, checkRef: extra.check_ref, userName: account.username, address: account.address || null };
  }
  if (!store.app_id) throw new Error(`Secret store '${store.name}' has no AppID`);
  try {
    await request(store, { AppID: store.app_id }, timeout);
    return { ...base, note: "CCP answered" };
  } catch (e) {
    const err = describeError(e);
    if (err.status === 403 || err.status === 401) {
      throw new Error(`CyberArk CCP refused AppID '${store.app_id}' (HTTP ${err.status}): ${err.text} - check the AppID and its allowed machines or certificate`, { cause: e });
    }
    if (err.status && /^APPAP/i.test(err.code)) {
      return { ...base, note: `CCP reachable and AppID accepted (${err.text}) - set extra.check_ref to test a real account` };
    }
    throw new Error(`Could not reach CyberArk CCP at ${store.url}: ${err.text}`, { cause: e });
  }
}

// ===========================================================================
// WRITING : through the PVWA's REST API (the CCP only reads)
// ===========================================================================
// A credential's user and password, typed in the app, become an account of a safe :
//
//   POST {pvwa}/PasswordVault/API/auth/<method>/Logon    { username, password }  -> a token
//   GET  {pvwa}/PasswordVault/API/Accounts?search=<Object>&filter=safeName eq <Safe>
//   POST {pvwa}/PasswordVault/API/Accounts                 a new account
//   PATCH {pvwa}/PasswordVault/API/Accounts/<id>           its user name, when it changed
//   POST {pvwa}/PasswordVault/API/Accounts/<id>/Password/Update   its password, in the Vault only
//   POST {pvwa}/PasswordVault/API/Auth/Logoff
//
// The reference says where : Safe=<safe>;Object=<account name>, with an Address= when the
// account's platform needs one. The store's write prefix lists the safes it may write to.

// the logon methods of the PVWA's API, by the store's pvwa_auth
const LOGON_METHODS = { cyberark: "CyberArk", ldap: "LDAP", radius: "RADIUS", windows: "Windows" };

/**
 * The PVWA's base address : its URL, without a trailing /PasswordVault (the API's paths add it).
 *
 * Args:
 *   store (object): the secret store (pvwa_url).
 *
 * Returns:
 *   string: the address.
 *
 * Raises:
 *   Error: the store has no PVWA address.
 */
export function pvwaBase(store) {
  const url = stripTrailingSlashes(String(store?.pvwa_url || "").trim()).replace(/\/PasswordVault$/i, "");
  if (!url) throw new Error(`Secret store '${store?.name}' has no PVWA address: set it in its Options to write to it`);
  return url;
}

/**
 * Where a write goes, from its reference : the safe and the account's name (Object), with its
 * address when given.
 *
 * Args:
 *   ref (string): the reference (Safe=Linux;Object=srv01-root;Address=srv01).
 *
 * Returns:
 *   object: { safe, object, address }.
 *
 * Raises:
 *   Error: the reference names no safe or no object.
 */
export function writeTarget(ref) {
  const pairs = {};
  for (const pair of String(ref || "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    pairs[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
  }
  if (!pairs.safe || !pairs.object) throw new Error("A CyberArk account is written by its safe and its name: Safe=<safe>;Object=<account name>");
  return { safe: pairs.safe, object: pairs.object, address: pairs.address || "" };
}

/**
 * Whether a reference is in a safe the store may write to : one of its write prefix's safes
 * (comma separated, case does not count).
 *
 * Args:
 *   store (object): the secret store (write_prefix).
 *   ref (string): the reference.
 *
 * Returns:
 *   boolean: true when its safe is one of them.
 */
export function withinWritePrefix(store, ref) {
  const safes = String(store?.write_prefix || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let target;
  try {
    target = writeTarget(ref);
  } catch {
    return false;
  }
  return safes.includes(target.safe.toLowerCase());
}

/**
 * What the PVWA answered, without the request : its error code and message.
 *
 * Args:
 *   e (Error): the request's error.
 *
 * Returns:
 *   string: the status and the PVWA's message.
 */
function pvwaError(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const text = data && typeof data === "object" ? `${data.ErrorCode || ""} ${data.ErrorMessage || data.Details || ""}`.trim() : "";
  return `HTTP ${status || "?"}${text ? `: ${text}` : `: ${e?.message || e}`}`;
}

/**
 * Runs requests to the PVWA as the store's API user : a logon, the work, and the logoff whatever
 * happened.
 *
 * Args:
 *   store (object): the secret store (pvwa_url, pvwa_credential, pvwa_auth, its TLS).
 *   work (function): async (call) => any ; call(method, path, data) runs an API request.
 *
 * Returns:
 *   Promise<any>: what the work returns.
 *
 * Raises:
 *   Error: no API user, the logon refused, or the work's error.
 */
async function withPvwa(store, work) {
  const base = pvwaBase(store);
  if (!store.pvwa_credential) throw new Error(`Secret store '${store.name}' has no PVWA credential: set the API user it writes as in its Options`);
  const cred = await CrudModel.findByName("credential", store.pvwa_credential);
  if (!cred) throw new Error(`Secret store '${store.name}' writes as the credential '${store.pvwa_credential}', which is not found`);
  if (cred.secret_store) throw new Error(`Secret store '${store.name}' writes as the credential '${store.pvwa_credential}', which reads from a secret store itself`);
  const method = LOGON_METHODS[String(store.pvwa_auth || "cyberark").toLowerCase()] || "CyberArk";
  const http = { ...agentsFor(store), timeout: timeoutOf(store, 15000), headers: { Accept: "application/json" } };
  let token;
  try {
    const res = await axios.post(`${base}/PasswordVault/API/auth/${method}/Logon`, { username: cred.user, password: cred.password, concurrentSession: true }, http);
    token = typeof res?.data === "string" ? res.data : res?.data?.token;
  } catch (e) {
    throw new Error(`CyberArk PVWA refused the logon of '${cred.user}' (${method}, ${pvwaError(e)})`, { cause: e });
  }
  if (!token) throw new Error("CyberArk PVWA answered the logon without a token");
  const headers = { ...http.headers, Authorization: token };
  const call = (verb, path, data) => axios({ method: verb, url: `${base}/PasswordVault/API/${path}`, data, ...http, headers });
  try {
    return await work(call);
  } finally {
    await call("post", "Auth/Logoff").catch(() => {});
  }
}

/**
 * The account a reference names, as the PVWA lists it : the one of that name in that safe.
 *
 * Args:
 *   call (function): the PVWA request (withPvwa).
 *   target (object): { safe, object }.
 *
 * Returns:
 *   Promise<object|null>: the account ({ id, name, userName, ... }), null when there is none.
 */
async function findAccount(call, target) {
  let res;
  try {
    res = await call("get", `Accounts?search=${encodeURIComponent(target.object)}&filter=${encodeURIComponent(`safeName eq ${target.safe}`)}`);
  } catch (e) {
    throw new Error(`CyberArk PVWA could not list the accounts of safe ${target.safe} (${pvwaError(e)})`, { cause: e });
  }
  const list = Array.isArray(res?.data?.value) ? res.data.value : [];
  return list.find((a) => String(a?.name || "").toLowerCase() === target.object.toLowerCase() && String(a?.safeName || target.safe).toLowerCase() === target.safe.toLowerCase()) || null;
}

/**
 * Whether the account a reference names is in its safe already.
 *
 * Args:
 *   store (object): the secret store.
 *   ref (string): the reference.
 *
 * Returns:
 *   Promise<boolean>: true when the safe has an account of that name.
 */
async function exists(store, ref) {
  const target = writeTarget(ref);
  return withPvwa(store, async (call) => !!(await findAccount(call, target)));
}

/**
 * Writes a credential's user and password as an account of a safe : a new account on the store's
 * platform, or the one there given the user name and, in the Vault only, the new password.
 *
 * Args:
 *   store (object): the secret store.
 *   ref (string): the reference (Safe=..;Object=..[;Address=..]).
 *   payload (object): { username, password }.
 *
 * Returns:
 *   Promise<void>
 *
 * Raises:
 *   Error: a new account without a platform, or the PVWA refused (its code and message, never the
 *     password).
 */
async function write(store, ref, payload) {
  const target = writeTarget(ref);
  await withPvwa(store, async (call) => {
    const account = await findAccount(call, target);
    if (!account) {
      if (!store.platform_id) throw new Error(`Secret store '${store.name}' has no platform for new accounts: set its platform ID in its Options`);
      try {
        await call("post", "Accounts", {
          name: target.object,
          safeName: target.safe,
          platformId: store.platform_id,
          address: target.address || undefined,
          userName: payload.username || undefined,
          secretType: "password",
          secret: payload.password,
        });
      } catch (e) {
        throw new Error(`CyberArk PVWA refused the new account ${target.object} in safe ${target.safe} (${pvwaError(e)})`, { cause: e });
      }
      return;
    }
    try {
      if (payload.username && payload.username !== account.userName) {
        await call("patch", `Accounts/${encodeURIComponent(account.id)}`, [{ op: "replace", path: "/userName", value: payload.username }]);
      }
      await call("post", `Accounts/${encodeURIComponent(account.id)}/Password/Update`, { ChangeEntireGroup: false, NewCredentials: payload.password });
    } catch (e) {
      throw new Error(`CyberArk PVWA refused the change of account ${target.object} in safe ${target.safe} (${pvwaError(e)})`, { cause: e });
    }
  });
}

export default { type: "cyberark_ccp", read, check, exists, write, withinWritePrefix };
