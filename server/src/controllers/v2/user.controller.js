'use strict';
import Audit from '../../models/audit.model.js';
import User from '../../models/user.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import Errors from '../../lib/errors.js';
import i18n from '../../lib/i18n.js';
import { SECRET_MASK } from '../../lib/secretMask.js';
import { assertMayTouchAdmin } from '../../lib/adminGrants.js';
import { unlockAccount, loginBlocked, loginFailed, loginSucceeded } from '../../lib/loginThrottle.js';
import Group from '../../models/group.model.js';
import { withUserRoleCounts } from '../../lib/roleCounts.js';
import { withUserJobCounts } from '../../lib/jobCounts.js';
import DirectoryUser from '../../models/directoryUser.model.js';
import { directoryUserRows } from '../../lib/directoryViews.js';
import { configRoles } from '../../lib/roleCounts.js';
import Token from '../../models/token.model.js';
import { revokeUser } from '../../lib/tokenRevocation.js';
import { revocationHorizonSeconds } from '../../lib/tokenLifetime.js';
import { passwordProblem } from '../../lib/passwordPolicy.js';
import RepoObjects from '../../lib/repoObjects/index.js';
import { groupsBefore, groupIdsOfUser, membersSaved, userBefore, userSaved } from '../../lib/repoObjects/access.js';

// a password the policy refuses (lib/passwordPolicy.js) : 400 with the reason
function refusePassword(req, res, password, username) {
  const problem = passwordProblem(password, username);
  if (!problem) return false;
  res.status(400).json(RestResult.error(i18n.t(req, `resources.${problem.key}`, problem.params || {})));
  return true;
}

/**
 * Ends every session of a local user : their tokens issued before now, and their refresh tokens.
 * After a password change or a delete, a stolen token is worth nothing.
 *
 * Args:
 *   username (string): the user.
 *
 * Returns:
 *   Promise<void>: settles once revoked.
 */
async function endSessions(username) {
  if (!username) return;
  await revokeUser(username, 'local', revocationHorizonSeconds());
  await Token.deleteAllForUser(username).catch(() => {});
}

// a change only an admin may make (lib/adminGrants.js) : 403, with the reason ; a change its
// repository cannot follow now, or that git would undo (lib/repoObjects) : 409
function refused(res, err) {
  if (err instanceof Errors.ConflictError) {
    res.status(409).json(RestResult.error(err.message));
    return true;
  }
  if (!(err instanceof Errors.AccessDeniedError)) return false;
  res.status(403).json(RestResult.error(err.message));
  return true;
}

const findAllOr1 = async function(req, res) {
  try {
    if(req.query.username){
      const user = await User.findByUsername(req.query.username);
      // Mask password before returning to API
      if (user && user.password) {
        user.password = SECRET_MASK;
      }
      res.json(RestResult.single(user));
    }else{
      const users = await User.findAll();
      // Mask passwords before returning to API
      users.forEach(u => {
        if (u.password) u.password = SECRET_MASK;
      });
      // and how many roles each has, for the list's Roles column (lib/roleCounts.js), and how
      // many stored jobs and planned jobs it keeps, for its optional columns (lib/jobCounts.js)
      const counted = (await withUserRoleCounts(users, await Group.findAll())).map((u) => ({ ...u, source: 'local' }));
      // ?directory=1 (the Users list) : the LDAP and SSO users beside them, those seen at
      // sign-in and those the roles name (lib/directoryViews.js) ; every other caller keeps
      // the local users only
      const directory = req.query.directory
        ? directoryUserRows(await DirectoryUser.findAll(), await configRoles())
        : [];
      res.json(RestResult.list(await withUserJobCounts([...counted, ...directory])));
    }
  } catch(err) {
    res.status(500).json(RestResult.error(err.toString()));
  }
};

const create = async function(req, res) {
    //handles null error
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
        try {
          // granting admin is an admin's : a user created in a group that grants it, or named
          // in the admin role
          await assertMayTouchAdmin(req, { username: req.body.username, groupIds: [req.body.group_id] });
          if (req.body.password && refusePassword(req, res, req.body.password, req.body.username)) return;
          // the users repository, when there is one : written to it as a new entry, and its group's
          // entry lists it (a group holds its members)
          const user = await RepoObjects.holding(["users", "groups"], async () => {
            const groups = await groupsBefore([req.body.group_id]);
            const id = await User.create(req.body);
            await userSaved(null, await userBefore({ id }));
            await membersSaved(groups);
            return id;
          });
          res.json(RestResult.single(user));
        } catch(err) {
      if (refused(res, err)) return;
          res.status(500).json(RestResult.error(err.toString()));
        }
    }
};

const findById = async function(req, res) {
    try {
      const user = await User.findById(req.params.id);
      // Mask password before returning to API
      if (user && user.password) {
        user.password = SECRET_MASK;
      }
      res.json(RestResult.single(user));
    } catch(err) {
      if (err instanceof Errors.NotFoundError) {
        res.status(404).json(RestResult.error(i18n.t(req, 'resources.userNotFound')));
      } else {
        res.status(500).json(RestResult.error(err.toString()));
      }
    }
};

const findByToken = async function(req, res) {
    try {
      const user = await User.findByUsername(req.user.user.username);
      if(user){
        res.json(RestResult.single(user.id));
      }else{
        res.status(404).json(RestResult.error(i18n.t(req, 'resources.userNotFound')));
      }
    } catch(err) {
      res.status(500).json(RestResult.error(err.toString()));
    }
};

const update = async function(req, res) {
    // don't tamper with username
    delete req.body.username
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
        try {
          // an admin account (its password, its groups) is changed by an admin only, and a
          // user is moved into a group that grants admin by an admin only
          await assertMayTouchAdmin(req, { userId: req.params.id, groupIds: req.body.group_id !== undefined ? [req.body.group_id] : [] });
          // a masked password is no new password (CrudModel.isSecretMask) : only a real one is checked
          if (req.body.password && !/^\*{8,}$/.test(String(req.body.password))) {
            const target = await User.findById(req.params.id).catch(() => null);
            if (refusePassword(req, res, req.body.password, target?.username)) return;
          }
          // one of the users repository : its changed fields written to its entry ; its first group
          // changed : the entries of the groups it leaves and joins
          const before = await userBefore({ id: req.params.id });
          const moved = req.body.group_id !== undefined ? [...(await groupIdsOfUser(req.params.id)), req.body.group_id] : [];
          await RepoObjects.holding(moved.length ? ["groups"] : [], async () => {
            const groups = await groupsBefore(moved);
            await User.update(req.body, req.params.id);
            await userSaved(before, await userBefore({ id: req.params.id }));
            await membersSaved(groups);
          }, before);
          // a password set by an admin also lifts a lockout (lib/loginThrottle.js), and ends
          // the user's sessions : whoever held a token of theirs is out
          if (req.body.password) {
            const target = await User.findById(req.params.id).catch(() => null);
            if (target?.username) {
              await unlockAccount(target.username);
              await endSessions(target.username);
            }
          }
          res.json(RestResult.single(null));
        } catch(err) {
      if (refused(res, err)) return;
          res.status(500).json(RestResult.error(err.toString()));
        }
    }
};

/**
 * Adds a group to a user (POST /api/v2/user/:id/groups, { group_id }).
 */
const addGroup = async function(req, res) {
  if (!req.body?.group_id) {
    return res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
  }
  try {
    await assertMayTouchAdmin(req, { userId: req.params.id, groupIds: [req.body.group_id] });
    // the group's entry lists it (a group holds its members)
    await RepoObjects.holding(["groups"], async () => {
      const groups = await groupsBefore([req.body.group_id]);
      await User.addGroup(req.params.id, req.body.group_id);
      await membersSaved(groups);
    });
    res.json(RestResult.single(null));
  } catch(err) {
      if (refused(res, err)) return;
    res.status(err instanceof Errors.NotFoundError ? 404 : 400).json(RestResult.error(err.message || err.toString()));
  }
};

/**
 * Blocks or allows a local user's sign-in (POST /api/v2/user/:id/block, body { blocked }) :
 * blocked, its sessions end at once and every sign-in is refused (lib/signInGate.js). Never the
 * admin user - the way back in - nor the user asking ; an admin account by an admin only.
 */
const setBlocked = async function(req, res) {
  try {
    await assertMayTouchAdmin(req, { userId: req.params.id });
    const target = await User.findById(req.params.id);
    const blocked = !!req.body?.blocked;
    if (blocked && target.username === 'admin') {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.cantBlockAdmin')));
    }
    const me = req.user?.user;
    if (blocked && me?.type === 'local' && me.username === target.username) {
      return res.status(400).json(RestResult.error(i18n.t(req, 'resources.cantBlockYourself')));
    }
    // one of the users repository : blocked written to its entry
    const before = await userBefore({ id: req.params.id });
    await RepoObjects.holding([], async () => {
      await User.setBlocked(req.params.id, blocked);
      await userSaved(before, await userBefore({ id: req.params.id }));
    }, before);
    if (blocked) await endSessions(target.username);
    res.json(RestResult.single({ blocked }));
  } catch(err) {
      if (refused(res, err)) return;
    res.status(err instanceof Errors.NotFoundError ? 404 : 400).json(RestResult.error(err.message || err.toString()));
  }
};

/**
 * Removes a group from a user (DELETE /api/v2/user/:id/groups/:groupId) ; a user keeps one.
 */
const removeGroup = async function(req, res) {
  try {
    await assertMayTouchAdmin(req, { userId: req.params.id });
    // the group's entry no longer lists it, nor the one it leaves its first group for
    await RepoObjects.holding(["groups"], async () => {
      const groups = await groupsBefore(await groupIdsOfUser(req.params.id));
      await User.removeGroup(req.params.id, req.params.groupId);
      await membersSaved(groups);
    });
    res.json(RestResult.single(null));
  } catch(err) {
      if (refused(res, err)) return;
    res.status(err instanceof Errors.NotFoundError ? 404 : 400).json(RestResult.error(err.message || err.toString()));
  }
};

const changePassword = async function(req, res) {
  if(req.user.user.type=="local" && req.user.user.id){
    // make sure then don't tamper with the group or username
    delete req.body.group_id
    delete req.body.username
    // ...nor with which ROW this writes to. `id` is a writable field in crud.config, so it
    // was not merely cosmetic to leave it in the body.
    delete req.body.id
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
        try {
          // Changing a password requires proving you know the current one. Without this a
          // stolen access token - which expires - could be turned into permanent ownership
          // of the account in one request. Only enforced when a password is actually being
          // set, so updating an email still works.
          if (req.body.password) {
            // the policy : long enough, not the username, not the public default
            if (refusePassword(req, res, req.body.password, req.user.user.username)) return;
            const current = req.body.currentPassword;
            if (!current) {
              return res.status(400).json(RestResult.error(i18n.t(req, 'resources.currentPasswordRequired')));
            }
            // a wrong current password counts as a failed login (lib/loginThrottle.js) : a session
            // cannot be used to guess it past the account lockout, and a locked account is
            // refused before the password is checked
            const blocked = await loginBlocked(req.user.user.username, req.ip).catch(() => ({ blocked: false }));
            if (blocked.blocked) {
              res.setHeader('Retry-After', String((blocked.minutes || 1) * 60));
              return res.status(429).json(RestResult.error(i18n.t(req, 'resources.currentPasswordWrong'), i18n.t(req, 'auth.tooManyFailures', { minutes: blocked.minutes || 1 })));
            }
            // User.authenticate RESOLVES with { isValid: false } for a wrong password - it
            // does not reject - so the result has to be inspected. A try/catch alone let
            // every wrong password through, which is worse than not checking at all.
            let check = null;
            try {
              check = await User.authenticate(req.user.user.username, current);
            } catch (e) {
              check = null;
            }
            if (!check?.isValid) {
              await loginFailed(req.user.user.username, req.ip);
              Audit.log({
                user: req.user?.user, ip: req.ip, action: 'user.password.update',
                outcome: 'denied', targetType: 'user', target: req.user.user.username,
                detail: { reason: 'current password did not match' },
              });
              return res.status(403).json(RestResult.error(i18n.t(req, 'resources.currentPasswordWrong')));
            }
          }
          if (req.body.password) await loginSucceeded(req.user.user.username);
          delete req.body.currentPassword
          await User.update(req.body,req.user.user.id);
          // a new password ends every session of the user, this one included : sign in again
          if (req.body.password) await endSessions(req.user.user.username);
          res.json(RestResult.single(null));
        } catch(err) {
          res.status(err instanceof Errors.BadRequestError ? 400 : 500).json(RestResult.error(err.message || err.toString()));
        }
    }
  }else{
    res.status(400).json(RestResult.error(i18n.t(req, 'resources.cantChangePasswordLdap')));
  }
};

const find = function(req, res) {
    res.json(RestResult.single(req.user.user));
};

const deleteUser = async function(req, res) {
    try {
      await assertMayTouchAdmin(req, { userId: req.params.id });
      const gone = await User.findById(req.params.id).catch(() => null);
      // one of the users repository : its entry goes, and its groups' entries no longer list it
      const before = await userBefore({ id: req.params.id });
      await RepoObjects.holding(["groups"], async () => {
        const groups = await groupsBefore(await groupIdsOfUser(req.params.id));
        await User.delete(req.params.id);
        await userSaved(before, null);
        await membersSaved(groups);
      }, before);
      if (gone?.username) await endSessions(gone.username);
      res.json(RestResult.single(null));
    } catch(err) {
      if (refused(res, err)) return;
      res.status(500).json(RestResult.error(err.toString()));
    }
};

export default {
  findAllOr1,
  create,
  findById,
  findByToken,
  update,
  changePassword,
  find,
  delete: deleteUser,
  addGroup,
  removeGroup,
  setBlocked
};