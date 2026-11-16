// The stored job a form's launch came from (#1437) : the form page fills its values from one
// (opened with ?storedJob=<id>, or Load in the form's Store menu), and the launch that follows
// names it, so the server records when the stored job was last used. Only a stored job of the
// whole form counts : one loaded into a subform's tab holds that subform's values, not the
// launch's. The server checks the id again (lib/storedJobUse.js) : a stored job the user may not
// see, or of another form, is ignored there.

/**
 * The stored job a load of values makes the launch's : its id for the whole form, none for a
 * subform's tab or a record without an id.
 *
 * Args:
 *   scope (string): what the values were loaded into ('form' or 'subform', the store context's).
 *   record (object|null): the stored job loaded.
 *
 * Returns:
 *   number|null: the stored job's id, or null.
 */
export function storedJobOfLoad(scope, record) {
  if (scope !== 'form') return null;
  const id = Number(record?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The body of a launch (POST /api/v2/job/) with the stored job it came from, when there is one.
 * The body given is left as it is.
 *
 * Args:
 *   postdata (object): the launch's body.
 *   storedJobId (number|null): the stored job the values came from (storedJobOfLoad).
 *
 * Returns:
 *   object: the body to send.
 */
export function withStoredJob(postdata, storedJobId) {
  return storedJobId ? { ...postdata, storedJobId } : postdata;
}

/**
 * The body of a Run later or a Schedule (POST /api/v2/schedule) with the stored job its values
 * came from, for a planned run (Run later) only : the server records the stored job's last use
 * when that run fires. A schedule names none : it keeps its own copy of the values, edited apart
 * from the stored job, so its runs are no uses of it. The body given is left as it is.
 *
 * Args:
 *   scheduleData (object): the schedule's body.
 *   storedJobId (number|null): the stored job the values came from (storedJobOfLoad).
 *   planned (boolean): true for Run later, false for a Schedule.
 *
 * Returns:
 *   object: the body to send.
 */
export function withPlannedStoredJob(scheduleData, storedJobId, planned) {
  return planned && storedJobId ? { ...scheduleData, stored_job_id: storedJobId } : scheduleData;
}
