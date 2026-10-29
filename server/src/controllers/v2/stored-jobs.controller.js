"use strict";
import CrudModel from "../../models/crud.model.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import i18n from "../../lib/i18n.js";
import { publicError } from "./publicError.js";
import Form from "../../models/form.model.js";
import { ownerOf, seesShared, storedJobFor, visibilityRefusal } from "../../lib/storedJobScope.js";

// The columns a caller may write. Everything else in the body is dropped :
//  - id : the row key. On create a chosen id is inserted as is, and on update it moves the
//    row. Either way a caller can push the AUTO_INCREMENT counter to the top of the INT range
//    (id 2147483647), after which every new stored job of every user fails as a duplicate key.
//  - username : the owner, always taken from the logged in user.
//  - created_at : set by the database, a caller must not backdate or postdate it.
// expires_at stays : the Store dialog lets the user pick when the stored job expires.
// visibility stays : private or shared, checked by assertVisibility before it is written.
const WRITABLE = ['name', 'description', 'form_name', 'form_data', 'expires_at', 'visibility'];
function pickWritable(body) {
  const data = {};
  for (const key of WRITABLE) {
    if (body && body[key] !== undefined) data[key] = body[key];
  }
  return data;
}

/**
 * The error a write of a stored job answers with : a name the user already gave another stored
 * job (the database's unique key, ER_DUP_ENTRY) is a 409 that says so, where it was a 500 with
 * the database's own message (the key's name and the value) ; any other as publicError tells it.
 *
 * Args:
 *   req (object): the request (its language, and the name it sent).
 *   err (any): the error.
 *
 * Returns:
 *   any: the error to hand to Errors.ReturnError.
 */
function writeError(req, err) {
  if (err?.code === 'ER_DUP_ENTRY') {
    return new Errors.ConflictError(i18n.t(req, 'resources.storedJobNameInUse', { name: String(req.body?.name ?? '') }));
  }
  return publicError(req, err);
}

/**
 * The form of a stored job as this user may open it ; undefined when they may not (or it is gone).
 *
 * Args:
 *   req (object): the request (its user's roles).
 *   formName (string): the form.
 *
 * Returns:
 *   Promise<object|undefined>: the form.
 */
async function formFor(req, formName) {
  if (!formName) return undefined;
  const formConfig = await Form.load(req.user.user.roles, formName);
  return formConfig?.forms?.[0];
}

/**
 * Refuses a visibility this user may not give the stored job (storedJobScope.visibilityRefusal) :
 * a value other than private or shared is a 400, sharing without allowStoredJobsShare or on a
 * form that turns it off a 403. Nothing to check when the write leaves the visibility alone.
 *
 * Args:
 *   req (object): the request.
 *   data (object): the columns written.
 *   formName (string): the stored job's form, after the write.
 */
async function assertVisibility(req, data, formName) {
  if (data.visibility === undefined) return;
  const formObj = data.visibility === 'shared' ? await formFor(req, formName) : undefined;
  const refusal = visibilityRefusal(req.user.user, data.visibility, formObj);
  if (refusal === 'invalid') throw new Errors.BadRequestError(i18n.t(req, 'resources.storedJobVisibilityInvalid'));
  if (refusal === 'noPermission') throw new Errors.AccessDeniedError(i18n.t(req, 'resources.storedJobShareDenied'));
  if (refusal === 'formDisabled') throw new Errors.AccessDeniedError(i18n.t(req, 'resources.storedJobShareFormDisabled', { form: String(formName) }));
}

const stored_jobsController = {
  async find(req, res) {
    try {
      const username = `${req.user.user.type}/${req.user.user.username}`;
      
      if (req.query.name) {
        // Find by name (with username filter for security)
        const all = await CrudModel.findAll('stored_jobs');
        const item = all.find(s => s.username === username && s.name === req.query.name);
        return res.json(RestResult.single(item));
      } else if (req.query.form_name) {
        // The form page's Load button : the caller's own of this form, and the ones other users
        // shared, when the caller may see shared ones (storedJobScope.seesShared)
        const all = await CrudModel.findAll('stored_jobs');
        const ofForm = all.filter(s => s.form_name === req.query.form_name);
        const formObj = ofForm.some(s => s.username !== username) ? await formFor(req, req.query.form_name) : undefined;
        // another user's shared one without its password values (storedJobScope.storedJobFor)
        const filtered = ofForm
          .filter(s => s.username === username || seesShared(req.user.user, s, formObj))
          .map(s => storedJobFor(req.user.user, s, formObj));
        return res.json(RestResult.list(filtered));
      } else {
        // The stored jobs page. Scoped exactly like findById, update and delete below :
        // a settings user (admin) manages everyone's, any other user only sees their own.
        // allowStoredJobs is on for every user by default, so returning every row here
        // let any user read the stored field values of all other users - values the
        // per-id read already refuses them.
        const isAdmin = req.user.user.options?.showSettings;
        const all = await CrudModel.findAll('stored_jobs');
        const visible = isAdmin ? all : all.filter(s => s.username === username);
        return res.json(RestResult.list(visible));
      }
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async create(req, res) {
    try {
      // Add username from authenticated user (format: type/username)
      const data = {
        ...pickWritable(req.body),
        username: ownerOf(req.user.user)
      };
      await assertVisibility(req, data, data.form_name);
      const id = await CrudModel.create('stored_jobs', data);
      return res.status(201).json(RestResult.single(i18n.t(req, 'resources.storedJobAdded'), { id }));
    } catch (err) {
      // a name already taken : 409 (writeError)
      Errors.ReturnError(res, writeError(req, err));
    }
  },

  async findById(req, res) {
    try {
      const username = `${req.user.user.type}/${req.user.user.username}`;
      const isAdmin = req.user.user.options?.showSettings;
      const item = await CrudModel.findById('stored_jobs', req.params.id);
      
      // Verify user owns this item (or is admin), or it is shared with them (opened in its form
      // with ?storedJob=<id>, from the Load list)
      const formObj = (isAdmin || item.username === username) ? undefined : await formFor(req, item.form_name);
      if (!isAdmin && item.username !== username && !seesShared(req.user.user, item, formObj)) {
        throw new Errors.AccessDeniedError(i18n.t(req, 'resources.storedJobNoAccess'));
      }
      // a shared one without its password values (storedJobScope.storedJobFor)
      return res.json(RestResult.single(storedJobFor(req.user.user, item, formObj)));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async update(req, res) {
    try {
      const username = `${req.user.user.type}/${req.user.user.username}`;
      const isAdmin = req.user.user.options?.showSettings;
      
      // Verify user owns this item (or is admin)
      const existing = await CrudModel.findById('stored_jobs', req.params.id);
      if (!isAdmin && existing.username !== username) {
        throw new Errors.AccessDeniedError(i18n.t(req, 'resources.storedJobNoAccess'));
      }
      
      // Don't allow changing the id, the owner or the creation time
      const data = pickWritable(req.body);
      await assertVisibility(req, data, data.form_name ?? existing.form_name);
      
      // a body with nothing writable left (only an id, say) changes nothing ; sent on it
      // would be an UPDATE without columns, a syntax error
      if (Object.keys(data).length) {
        await CrudModel.update('stored_jobs', data, req.params.id);
      }
      return res.json(RestResult.single(i18n.t(req, 'resources.storedJobUpdated')));
    } catch (err) {
      // a name already taken : 409 (writeError)
      Errors.ReturnError(res, writeError(req, err));
    }
  },

  async delete(req, res) {
    try {
      const username = `${req.user.user.type}/${req.user.user.username}`;
      const isAdmin = req.user.user.options?.showSettings;
      
      // Verify user owns this item (or is admin)
      const existing = await CrudModel.findById('stored_jobs', req.params.id);
      if (!isAdmin && existing.username !== username) {
        throw new Errors.AccessDeniedError(i18n.t(req, 'resources.storedJobNoAccess'));
      }
      
      await CrudModel.delete('stored_jobs', req.params.id);
      return res.json(RestResult.single(i18n.t(req, 'resources.storedJobDeleted')));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  }
};

export default stored_jobsController;
