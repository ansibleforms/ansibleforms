'use strict';
// The designer's Playbooks and Vars files sections (models/projectFiles.model.js) : reading is
// open to every designer user, a change (save, new file, delete, push) only to the one holding
// the designer lock - as a change of the forms. Without designAllPlaybooks or designAllWorkflows,
// the playbooks or the workflow files a user does not see are never listed nor read, a request
// aimed at one is refused saying nothing of it, and so is a workflow file naming one in its nodes
// (lib/designerForms.js).
import RestResult from '../../models/restResult.model.v2.js';
import ProjectFiles from '../../models/projectFiles.model.js';
import Lock from '../../models/lock.model.js';
import { listWorkflows, sharedWorkflowNames } from '../../models/workflowRun.js';
import Errors from '../../lib/errors.js';
import i18n from '../../lib/i18n.js';
import { fileVisibility, designerListing, assertFileShown, assertWorkflowFileShown, designerGitOutput } from '../../lib/designerForms.js';

/**
 * Answers 423 (and returns false) unless the caller holds the designer lock.
 *
 * Args:
 *   req (object): the request.
 *   res (object): the response.
 *
 * Returns:
 *   boolean: true when the caller may change the files.
 */
async function holdsLock(req, res) {
  const lock = await Lock.status(req.user.user);
  if (lock.match) return true;
  res.status(423).json(
    RestResult.error(
      i18n.t(req, 'config.designerLocked'),
      lock.free ? 'Start the designer first' : i18n.t(req, 'config.designerLockedBy', { username: lock.lock.username }),
    ),
  );
  return false;
}

const projectFilesController = {
  // the designer's workflows by name, each with its file : what a workflow form may run
  async workflowNames(req, res) {
    try {
      res.json(RestResult.list(await listWorkflows(await fileVisibility('workflows', req.user?.user))));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async list(req, res) {
    try {
      res.json(RestResult.single(await designerListing(req.params.kind, await ProjectFiles.list(req.params.kind), req.user?.user)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async read(req, res) {
    try {
      await assertFileShown(req.params.kind, req.query.path, req.user?.user, 'read');
      res.json(RestResult.single(await ProjectFiles.read(req.params.kind, req.query.path)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async save(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      await assertFileShown(req.params.kind, req.body?.path, req.user?.user, 'save');
      // a workflow whose nodes run a playbook or a workflow hidden from the user : refused
      if (req.params.kind === 'workflows') await assertWorkflowFileShown(req.body?.content, req.user?.user);
      const saved = await ProjectFiles.write(req.params.kind, req.body?.path, req.body?.content);
      // a workflow named as one in another file : a form running it by name would stop
      if (req.params.kind === 'workflows') saved.sharedNames = await sharedWorkflowNames(req.body?.content).catch(() => []);
      res.json(RestResult.single(saved));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async create(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      await assertFileShown(req.params.kind, req.body?.path, req.user?.user, 'create');
      if (req.params.kind === 'workflows') await assertWorkflowFileShown(req.body?.content ?? '', req.user?.user);
      res.status(201).json(RestResult.single(await ProjectFiles.write(req.params.kind, req.body?.path, req.body?.content ?? '', true)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async remove(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      await assertFileShown(req.params.kind, req.query.path, req.user?.user, 'delete');
      res.json(RestResult.single(await ProjectFiles.remove(req.params.kind, req.query.path)));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
  async push(req, res) {
    try {
      if (!(await holdsLock(req, res))) return;
      const pushed = await ProjectFiles.push(req.params.kind, req.user.user.username);
      // without the lines naming files, to a user some are hidden from
      res.json(RestResult.single({ ...pushed, output: designerGitOutput(pushed.output, req.user.user) }));
    } catch (err) {
      Errors.ReturnError(res, err);
    }
  },
};

export default projectFilesController;
