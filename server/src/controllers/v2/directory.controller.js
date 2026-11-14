'use strict';
// The LDAP and SSO users and groups of Settings > Users and Groups : one user's record (who it
// is, what the directory gave it at its last sign-in), blocking or allowing its sign-in, ending
// its sessions, forgetting it ; one group's members seen at sign-in. Settings only (app.js) ;
// every change is in the audit log by the middleware, its target type/name (lib/auditMiddleware.js).
import DirectoryUser, { DIRECTORY_TYPES } from '../../models/directoryUser.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import { publicError } from './publicError.js';
import helpers from '../../lib/common.js';
import mysql from '../../models/db.model.js';
import { revokeUser } from '../../lib/tokenRevocation.js';
import { revocationHorizonSeconds } from '../../lib/tokenLifetime.js';
import { configRoles } from '../../lib/roleCounts.js';
import { directoryUserRows, directoryGroupRows, effectiveRolesOfDirectoryUser } from '../../lib/directoryViews.js';
import { isAdminRequest } from '../../lib/adminGrants.js';
import Errors from '../../lib/errors.js';

/**
 * Refuses to a user who is not an admin a change of a directory user who is one : blocking its
 * sign-in, ending its sessions, forgetting it, revoking its api tokens. The same rule as for a
 * local admin account (lib/adminGrants.js assertMayTouchAdmin) : a user with settings access but
 * not the admin role could otherwise lock every admin out. A directory user is an admin when a
 * role that makes admins (the admin role, or a role with admin: true : lib/adminRole.js) names it
 * or one of the groups it was seen in, or when it had the admin role at its last sign-in.
 *
 * Args:
 *   req (object): the request (the signed-in user).
 *   id (object): the directory user, { type, name }.
 *
 * Returns:
 *   Promise<void>: settles when the change is allowed.
 *
 * Raises:
 *   Errors.AccessDeniedError: the request is not an admin's and the user maps to the admin role.
 */
export async function assertMayTouchDirectoryAdmin(req, id) {
  if (isAdminRequest(req)) return;
  const [seen, roles] = await Promise.all([DirectoryUser.findAll(), configRoles()]);
  const record = seen.find((u) => u.type === id.type && String(u.username).toLowerCase() === String(id.name).toLowerCase());
  // its roles as its sign-in would give them : a role with admin: true counts as the admin role
  const mapped = effectiveRolesOfDirectoryUser(roles, id.type, record?.username || id.name, record?.groups || []);
  if (mapped.includes('admin') || (record?.roles || []).includes('admin')) {
    throw new Errors.AccessDeniedError(i18n.t(req, 'resources.cantTouchDirectoryAdmin'));
  }
}

/**
 * Answers a refusal of assertMayTouchDirectoryAdmin with 403, any other failure with 500.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 *   err (Error): the failure.
 */
function failed(req, res, err) {
  if (err instanceof Errors.AccessDeniedError) return res.status(403).json(RestResult.error(err.message));
  res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedDirectoryUser'), helpers.getError(publicError(req, err))));
}

/**
 * The type and name of the request, checked : a directory type and a name.
 *
 * Args:
 *   req (object): the request, its params type and name.
 *   res (object): the response : 400 sent for a type of no directory.
 *
 * Returns:
 *   object|null: { type, name }, or null once answered.
 */
function identity(req, res) {
  const type = String(req.params.type || '');
  const name = String(req.params.name || '');
  if (!DIRECTORY_TYPES.includes(type) || !name) {
    res.status(400).json(RestResult.error(i18n.t(req, 'resources.directoryTypeUnknown')));
    return null;
  }
  return { type, name };
}

/**
 * Ends every session of a directory user : its tokens issued before now refused (an api token
 * too), its refresh tokens gone.
 *
 * Args:
 *   id (object): { type, name }.
 */
async function endSessions(id) {
  await revokeUser(id.name, id.type, revocationHorizonSeconds());
  await mysql.do('DELETE FROM AnsibleForms.`tokens` WHERE username = ? AND username_type = ?', [id.name, id.type]);
}

// one user : its row of the list (seen, or named by a role), and its record
const findUser = async function (req, res) {
  const id = identity(req, res);
  if (!id) return;
  try {
    const [seen, roles] = await Promise.all([DirectoryUser.findAll(), configRoles()]);
    const row = directoryUserRows(seen, roles).find(
      (r) => r.source === id.type && r.username.toLowerCase() === id.name.toLowerCase(),
    );
    if (!row) return res.status(404).json(RestResult.error(i18n.t(req, 'resources.userNotFound')));
    const record = seen.find((u) => u.type === id.type && u.username.toLowerCase() === id.name.toLowerCase());
    res.json(RestResult.single({ ...row, groups: record?.groups || [], roles_at_login: record?.roles || [] }));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedDirectoryUser'), helpers.getError(publicError(req, err))));
  }
};

// block or allow its sign-in : blocked, its sessions end at once
const setBlocked = async function (req, res) {
  const id = identity(req, res);
  if (!id) return;
  try {
    // an admin directory user is the admin role's own to change
    await assertMayTouchDirectoryAdmin(req, id);
    const blocked = !!req.body?.blocked;
    // never the user asking : it would lock itself out
    const me = req.user?.user;
    if (blocked && me?.type === id.type && String(me.username).toLowerCase() === id.name.toLowerCase()) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.cantBlockYourself')));
    }
    await DirectoryUser.setBlocked(id.type, id.name, blocked);
    if (blocked) await endSessions(id);
    res.json(RestResult.single({ blocked }));
  } catch (err) {
    failed(req, res, err);
  }
};

// end its sessions : it signs in again (unless blocked)
const endUserSessions = async function (req, res) {
  const id = identity(req, res);
  if (!id) return;
  try {
    // an admin directory user is the admin role's own to change
    await assertMayTouchDirectoryAdmin(req, id);
    await endSessions(id);
    res.json(RestResult.single({ ended: true }));
  } catch (err) {
    failed(req, res, err);
  }
};

// forget its record : back at its next sign-in ; a blocked user is kept (forgetting would let it in)
const forgetUser = async function (req, res) {
  const id = identity(req, res);
  if (!id) return;
  try {
    // an admin directory user is the admin role's own to change
    await assertMayTouchDirectoryAdmin(req, id);
    const forgotten = await DirectoryUser.forget(id.type, id.name);
    if (!forgotten) return res.status(409).json(RestResult.error(i18n.t(req, 'resources.directoryUserKept')));
    res.json(RestResult.single({ forgotten }));
  } catch (err) {
    failed(req, res, err);
  }
};

// one group : seen at a sign-in or named by a role, its members seen
const findGroup = async function (req, res) {
  const id = identity(req, res);
  if (!id) return;
  try {
    const [seen, roles] = await Promise.all([DirectoryUser.findAll(), configRoles()]);
    const row = directoryGroupRows(seen, roles).find((g) => g.id === `${id.type}/${id.name}`);
    if (!row) return res.status(404).json(RestResult.error(i18n.t(req, 'resources.groupNotFound')));
    res.json(RestResult.single(row));
  } catch (err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindGroup'), helpers.getError(publicError(req, err))));
  }
};

export default { findUser, setBlocked, endUserSessions, forgetUser, findGroup };
