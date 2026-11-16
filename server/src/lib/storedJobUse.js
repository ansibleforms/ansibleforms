'use strict';
// The stored job a job was launched from (#1437), for Job.launch.
//
// A launch names it when the form was opened with ?storedJob=<id> (or filled with Load) and
// when the MCP launch_job starts from a storedJob. The launch then records when the stored job
// was last used (stored_jobs.last_used_at), so that the stored jobs page can tell the ones in
// use from the ones abandoned.
//
// A Run later from such a form (or the MCP plan_job with a storedJob) keeps the stored job with
// the planned run (schedule.stored_job_id, checked here as the planner when it is planned), and
// its launch names it when the run fires : that is when it counts, checked again as the planner,
// so a stored job deleted or hidden since is skipped. A schedule names none, even one made from
// a stored job : it keeps its own copy of the values, edited apart from the stored job.
//
// The id comes from the caller, so it is checked before anything is written : the caller must
// see that stored job as the stored jobs API lets them (controllers/v2/stored-jobs.controller.js
// findById : the allowStoredJobs role option, then their own, a shared one, or any for a
// settings user), and it must hold values of the form launched. An id that fails any of these
// is dropped with a warning in the log : the launch itself goes on, as it would without one.
//
// The job keeps it too (jobs.stored_job_id), and its page names the stored job (storedJobOfJob),
// only to a viewer who sees that stored job by the same rules ; a stored job deleted since is
// named to no one. A planned run's job gets it as the run fires. A relaunch names the stored job
// of the job it relaunches : checked again as the relauncher, its new job inherits it and the
// stored job's last use is written, or, deleted or hidden since, it is skipped.

import CrudModel from '../models/crud.model.js';
import Form from '../models/form.model.js';
import mysql from '../models/db.model.js';
import logger from './logger.js';
import { ownerOf, seesShared } from './storedJobScope.js';

// ─── who sees a stored job ───────────────────────────────────────────────────

/**
 * Whether a user sees a stored job, as the stored jobs API's read of one decides it : a
 * settings user (showSettings) every one, any other user their own and the ones shared with
 * them (storedJobScope.seesShared).
 *
 * Args:
 *   user (object): the logged in user, with its options.
 *   row (object): the stored job.
 *   formObj (object|undefined): its form, as Form.load hands it to this user ; none when the
 *     user may not open it.
 *
 * Returns:
 *   boolean: true when the user sees it.
 */
export function seesStoredJob(user, row, formObj) {
  if (!row) return false;
  if (user?.options?.showSettings) return true;
  if (row.username === ownerOf(user)) return true;
  return seesShared(user, row, formObj);
}

// ─── the stored job of a launch ──────────────────────────────────────────────

/**
 * The stored job a launch came from, checked : its id when the user may use it for this
 * launch, null otherwise (none given, not a number, no allowStoredJobs, gone, of another form,
 * or one the user does not see). A refused id is logged, never thrown : the launch goes on.
 *
 * Args:
 *   user (object): the launching user, with its options.
 *   storedJobId (any): the id the launch named (the request body's storedJobId).
 *   form (string): the name of the form launched.
 *   formObj (object|undefined): that form, as Form.load hands it to this user.
 *
 * Returns:
 *   Promise<number|null>: the stored job's id, or null.
 */
export async function storedJobOfLaunch(user, storedJobId, form, formObj) {
  if (storedJobId === undefined || storedJobId === null || storedJobId === '') return null;
  const id = Number(storedJobId);
  const who = user?.username || 'unknown';
  if (!Number.isInteger(id) || id <= 0) {
    logger.warning(`Launch of form '${form}' by ${who}: '${String(storedJobId)}' is not a stored job id, ignored`);
    return null;
  }
  // the stored jobs API needs this role option for every route
  if (!user?.options?.allowStoredJobs) {
    logger.warning(`Launch of form '${form}' by ${who}: stored job ${id} ignored, the user may not use stored jobs`);
    return null;
  }
  let row;
  try {
    row = await CrudModel.findById('stored_jobs', id);
  } catch (err) {
    // deleted since the form was opened, or a database error
    const why = err?.name === 'NotFoundError' ? 'it does not exist' : `it cannot be read: ${err?.message || err}`;
    logger.warning(`Launch of form '${form}' by ${who}: stored job ${id} ignored, ${why}`);
    return null;
  }
  if (!row) {
    logger.warning(`Launch of form '${form}' by ${who}: stored job ${id} ignored, it does not exist`);
    return null;
  }
  // its values are another form's : this launch did not come from it
  if (row.form_name !== form) {
    logger.warning(`Launch of form '${form}' by ${who}: stored job ${id} ignored, it holds values of form '${row.form_name}'`);
    return null;
  }
  if (!seesStoredJob(user, row, formObj)) {
    logger.warning(`Launch of form '${form}' by ${who}: stored job ${id} ignored, the user does not see it`);
    return null;
  }
  return id;
}

/**
 * The stored job a job was launched from, as its page names it : { id, name } when the viewer
 * sees it (seesStoredJob, with the allowStoredJobs role option), null otherwise - none, deleted
 * since, or not the viewer's to see. Never throws : a stored job that cannot be read is none.
 *
 * Args:
 *   user (object): the viewer, with its roles and options.
 *   storedJobId (number|null): the job's stored_job_id.
 *
 * Returns:
 *   Promise<object|null>: { id, name }, or null.
 */
export async function storedJobOfJob(user, storedJobId) {
  if (!storedJobId || !user?.options?.allowStoredJobs) return null;
  try {
    const row = await CrudModel.findById('stored_jobs', storedJobId);
    if (!row) return null;
    // the form only matters for another user's shared one : as this viewer may open it
    const formObj =
      row.visibility === 'shared' && row.username !== ownerOf(user) && !user?.options?.showSettings
        ? (await Form.load(user?.roles, row.form_name))?.forms?.[0]
        : undefined;
    return seesStoredJob(user, row, formObj) ? { id: row.id, name: row.name } : null;
  } catch (err) {
    // deleted since the job ran : named to no one, and not worth a line in the log
    if (err?.name !== 'NotFoundError') logger.warning(`Could not read stored job ${storedJobId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Records that a job was launched from a stored job just now (stored_jobs.last_used_at). A
 * failure is logged and swallowed : the job runs whether or not the date is written.
 *
 * Args:
 *   id (number): the stored job, as storedJobOfLaunch returned it.
 *   jobId (number): the job launched from it, for the log.
 *
 * Returns:
 *   Promise<void>
 */
export async function markStoredJobUsed(id, jobId) {
  if (!id) return;
  try {
    await mysql.do('UPDATE AnsibleForms.stored_jobs SET last_used_at = NOW() WHERE id = ?', [id]);
    logger.debug(`Job ${jobId} was launched from stored job ${id}`);
  } catch (err) {
    logger.error(`Job ${jobId}: could not record the use of stored job ${id}: ${err?.message || err}`);
  }
}
