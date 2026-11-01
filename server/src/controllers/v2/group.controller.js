'use strict';
import Group from '../../models/group.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import Errors from '../../lib/errors.js';
import { assertMayTouchAdmin } from '../../lib/adminGrants.js';
import { withGroupRoleCounts, configRoles } from '../../lib/roleCounts.js';
import DirectoryUser from '../../models/directoryUser.model.js';
import { directoryGroupRows } from '../../lib/directoryViews.js';
import RepoObjects from '../../lib/repoObjects/index.js';
import { groupsBefore } from '../../lib/repoObjects/access.js';

// a change only an admin may make (lib/adminGrants.js) : 403, with the reason ; a change its
// repository cannot follow now (busy, a file that cannot be read : lib/repoObjects) : 409
function refused(res, err) {
  if (err instanceof Errors.ConflictError) {
    res.status(409).json(RestResult.error(err.message));
    return true;
  }
  if (!(err instanceof Errors.AccessDeniedError)) return false;
  res.status(403).json(RestResult.error(err.message));
  return true;
}

const find = async function(req, res) {
  try {
    if(req.query.name){
      const group = await Group.findByName(req.query.name);
      if(group){
        res.json(RestResult.single(group));
      }else{
        res.status(404).json(RestResult.error(i18n.t(req, 'resources.groupNotFound')));
      }
    }else{
      const groups = await Group.findAll();
      // and how many roles name each, for the list's Roles column (lib/roleCounts.js)
      const local = (await withGroupRoleCounts(groups)).map((g) => ({ ...g, source: 'local' }));
      // ?directory=1 (the Groups list) : the LDAP and SSO groups beside them, seen at a sign-in
      // or named by a role (lib/directoryViews.js)
      const directory = req.query.directory
        ? directoryGroupRows(await DirectoryUser.findAll(), await configRoles())
        : [];
      res.json(RestResult.list([...local, ...directory]));
    }
  } catch(err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindGroup'), err.toString()));
  }
};

const create = async function(req, res) {
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
      try {
        await assertMayTouchAdmin(req, { groupName: req.body.name });
        // the groups repository, when there is one : written to it as a new entry
        const group = await RepoObjects.holding("groups", async () => {
          const id = await Group.create(req.body);
          await RepoObjects.appCreated("groups", id);
          return id;
        });
        res.json(RestResult.single(group));
      } catch(err) {
      if (refused(res, err)) return;
        res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedCreateGroup'), err.toString()));
      }
    }
};

const findById = async function(req, res) {
  try {
    const group = await Group.findById(req.params.id);
    if(group){
      res.json(RestResult.single(group));
    }else{
      res.status(404).json(RestResult.error(i18n.t(req, 'resources.groupNotFound')));
    }
  } catch(err) {
    res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindGroup'), err.toString()));
  }
};

const update = async function(req, res) {
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
      try {
        // a group that grants admin is changed by an admin only, and no group is renamed into one
        await assertMayTouchAdmin(req, { groupId: req.params.id, groupName: req.body.name });
        // one of the groups repository : its changed fields written to its entry
        const [before] = await groupsBefore([req.params.id]);
        await RepoObjects.holding([], async () => {
          await Group.update(req.body, req.params.id);
          if (before?.repository) await RepoObjects.appUpdated("groups", before, req.params.id);
        }, before || null);
        res.json(RestResult.single(null));
      } catch(err) {
      if (refused(res, err)) return;
        res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateGroup'), err.toString()));
      }
    }
};

const deleteGroup = async function(req, res) {
  try{
    await assertMayTouchAdmin(req, { groupId: req.params.id });
    // one of the groups repository : its entry goes too, for the repository's Push
    const [before] = await groupsBefore([req.params.id]);
    await RepoObjects.holding([], async () => {
      await Group.delete(req.params.id);
      if (before?.repository) await RepoObjects.appDeleted("groups", before);
    }, before || null);
    res.json(RestResult.single(null));
  }catch(err){
      if (refused(res, err)) return;
    if(err.message === "Group still has users"){
      res.status(400).json(RestResult.error(i18n.t(req, 'resources.groupHasUsers')));
    }else{
      res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedDeleteGroup'), err.toString()));
    }
  }
};

export default {
  find,
  create,
  findById,
  update,
  delete: deleteGroup
};