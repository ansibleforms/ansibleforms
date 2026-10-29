'use strict';
// The groups of a signed-in user, kept out of its tokens (#1036).
//
// The access and refresh tokens used to carry every group of the user. An Entra ID user is in
// each group twice (its object id and its name), so a user in about 120 groups had a token of
// some 15 KB, sent on every request in the Authorization header : with the other headers it
// passed Node's 16 KB limit and every api call was refused with 431, before it reached the app.
// The roles and options the groups resolve to stay in the token ; the groups themselves are
// where the sign-in left them :
//
//   local                   the users and user_groups tables (live, as the admin set them)
//   ldap, azuread, oidc     the user's record in directory_users, written at each sign-in
//                           (lib/signInGate.js, models/directoryUser.model.js)
//
// The jwt strategy (auth/auth_jwt.js) puts them back on req.user.user, so every reader (the
// job's ansibleforms_user, a planned job's owner, __user__ in a form, the profile) sees the
// user as before. A token issued before this change still carries its groups, and keeps them.
//
// An api token has no refresh to resolve its roles again (controllers/v2/token.controller.js) :
// the jwt strategy resolves them here on each request (rolesOf), from the groups as they are
// now, cached with them.
import { DIRECTORY_TYPES } from './directoryTypes.js';
import logger from './logger.js';
import helpers from './common.js';

// The models are loaded when first needed, not with this module : the jwt strategy imports it,
// and the database configuration must not be required to load the strategy (the routes that
// only check a token, their tests).
const models = async () => ({
  User: (await import('../models/user.model.js')).default,
  DirectoryUser: (await import('../models/directoryUser.model.js')).default,
});

// ─── cache ────────────────────────────────────────────────────────────────────
// Every authenticated request asks for the groups ; a short cache keeps that from becoming a
// query per request. A sign-in on this instance forgets the entry (forgetGroups), another
// instance sees the new groups within the TTL. The roles and options an api token's user
// resolves to (rolesOf) are kept on the same entry, and go with it : a change of the groups or
// of the roles in the config reaches an api token within the TTL, sooner than a session's
// access token sees it (its refresh, ACCESS_TOKEN_EXPIRATION).
const TTL_MS = 30 * 1000;
const MAX_ENTRIES = 1000;
const cache = new Map(); // "<type>/<username>" -> { stored, at, resolved? }

/**
 * The cache key of a user.
 *
 * Args:
 *   type (string): local, ldap, azuread or oidc.
 *   username (string): the username.
 *
 * Returns:
 *   string: "<type>/<username>", the username lowercased (the tables compare it so).
 */
function keyOf(type, username) {
  return `${type}/${String(username).toLowerCase()}`;
}

/**
 * Forgets the cached groups of a user : its next request reads them again. Called at sign-in,
 * when the groups were just written.
 *
 * Args:
 *   type (string): local, ldap, azuread or oidc.
 *   username (string): the username.
 */
export function forgetGroups(type, username) {
  if (!type || !username) return;
  cache.delete(keyOf(type, username));
}

/**
 * Empties the cache (tests).
 */
export function clearGroupsCache() {
  cache.clear();
}

// ─── lookup ───────────────────────────────────────────────────────────────────

/**
 * The groups stored for a user, as the sign-in named them (local/..., ldap/..., azuread/...,
 * oidc/...).
 *
 * Args:
 *   user (object): the user, { type, username }.
 *
 * Returns:
 *   Promise<string[]|null>: the groups ; null when nothing is stored for the user (a directory
 *     user without a record, a local user that is gone, a type without groups).
 *
 * Raises:
 *   Error: the database could not be read.
 */
export async function storedGroups(user) {
  if (!user?.username) return null;
  if (user.type !== 'local' && !DIRECTORY_TYPES.includes(user.type)) return null;
  const { User, DirectoryUser } = await models();
  if (user.type === 'local') {
    const csv = await User.groupNames(user.username);
    if (csv === null) return null;
    // a user in no group (it cannot be, but a row may say so) : none, not "local/"
    if (!csv) return [];
    return User.getGroups({ type: 'local' }, csv);
  }
  if (DIRECTORY_TYPES.includes(user.type)) {
    const record = await DirectoryUser.find(user.type, user.username);
    return record ? record.groups : null;
  }
  return null;
}

/**
 * The cache entry of a user : its stored groups (storedGroups), read again when the entry is
 * older than the TTL or not wanted.
 *
 * Args:
 *   user (object): the user, { type, username }.
 *   cached (boolean): false to read the groups again whatever the cache holds.
 *
 * Returns:
 *   Promise<object>: { stored (string[]|null, as storedGroups), at, resolved? (rolesOf) }.
 *
 * Raises:
 *   Error: the database could not be read.
 */
async function entryOf(user, cached = true) {
  const key = keyOf(user.type, user.username);
  if (cached) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
  }
  const entry = { stored: await storedGroups(user), at: Date.now() };
  // bounded : the oldest entry goes first (a Map keeps the order of insertion)
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry;
}

/**
 * The groups of a user : the ones its token carries (a token issued before #1036), else the
 * stored ones (storedGroups), else none. A lookup that fails gives none, logged : groups only
 * ever add, so none is the safe answer.
 *
 * Args:
 *   user (object): the user, { type, username, groups? }.
 *   options (object): { cached } - false to skip the cache (the token refresh).
 *
 * Returns:
 *   Promise<string[]>: the groups.
 */
export async function groupsOf(user, { cached = true } = {}) {
  if (Array.isArray(user?.groups)) return user.groups;
  if (!user?.username || !user?.type) return [];
  try {
    return (await entryOf(user, cached)).stored || [];
  } catch (err) {
    logger.error(`The groups of ${user.type}/${user.username} could not be read: ${helpers.getError(err)}`);
    return [];
  }
}

/**
 * The roles and options of a user as they are now, for an api token : it lives for days (or for
 * ever) and has no refresh, so the ones it was signed with are not trusted. Resolved as the
 * token refresh does (User.getRolesAndOptions) : from the stored groups, else the ones an older
 * token carries ; cached with the groups (one entry, one TTL), so a request then costs no query.
 * A lookup of the groups that fails resolves from none, logged and not cached : groups only ever
 * add, so none is the safe answer.
 *
 * Args:
 *   user (object): the user of a token, { type, username, groups? }.
 *
 * Returns:
 *   Promise<object>: { roles (string[]), options (object) }, copies the caller may change.
 */
export async function rolesOf(user) {
  const body = tokenUser(user);
  // step 1 : the cache entry, with the stored groups
  let entry = null;
  if (body.username && body.type) {
    try {
      entry = await entryOf(body);
    } catch (err) {
      logger.error(`The groups of ${body.type}/${body.username} could not be read: ${helpers.getError(err)}`);
    }
  }
  // step 2 : resolved already within the TTL
  if (!entry?.resolved) {
    // step 3 : from the stored groups, else the ones an older token carries (as the refresh)
    const groups = entry?.stored ?? (Array.isArray(user?.groups) ? user.groups : []);
    const { User } = await models();
    const ro = await User.getRolesAndOptions(groups, body);
    const resolved = { roles: ro.roles || [], options: ro.options || {} };
    if (!entry) return resolved;
    entry.resolved = resolved;
  }
  return { roles: [...entry.resolved.roles], options: { ...entry.resolved.options } };
}

/**
 * The user with its groups : the user of a token, made whole again for the readers of
 * req.user.user.
 *
 * Args:
 *   user (object): the user of a token.
 *
 * Returns:
 *   Promise<object>: the same user when it carries its groups already, else a copy with them.
 */
export async function withGroups(user) {
  if (!user || Array.isArray(user.groups)) return user;
  return { ...user, groups: await groupsOf(user) };
}

/**
 * The user as a token carries it : without its groups.
 *
 * Args:
 *   user (object): the user.
 *
 * Returns:
 *   object: a copy without `groups`.
 */
export function tokenUser(user) {
  const { groups: _groups, ...rest } = user || {}; // eslint-disable-line no-unused-vars
  return rest;
}
