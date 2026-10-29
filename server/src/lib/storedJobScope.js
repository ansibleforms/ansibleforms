// Who sees a stored job (#1269), for the stored jobs routes and the MCP server alike.
//
// A stored job is its owner's : the username column is always the creator, sharing never moves
// it. Its visibility says who else may load it : private (the owner only) or shared. Another
// user sees a shared one with the allowStoredJobsViewAll role option, for a form they may open
// that does not turn sharing off (allowStoredJobSharing: false). Sharing one needs
// allowStoredJobsShare. A settings user (showSettings) manages everyone's, as before.
//
// What another user sees of it : the browser's Store leaves out the form's own password fields,
// but keeps those inside a list or yaml subform row. Whoever reads a stored job they did not
// store (a shared one, or any through MCP) gets its values without them (storedFormDataFor).

import { filterRawFormData, filterWizardRawFormData } from './formEngine/output.js';
import { normalizeFields } from './formEngine/resolve.js';

export const VISIBILITIES = ['private', 'shared'];

/**
 * The owner of the stored jobs a user writes, as the username column holds it.
 *
 * Args:
 *   user (object): the logged in user ({ type, username }).
 *
 * Returns:
 *   string: `<type>/<username>`.
 */
export function ownerOf(user) {
  return `${user?.type || 'local'}/${user?.username}`;
}

/**
 * Whether a form lets its stored jobs be shared : any form the user may open, unless it says
 * allowStoredJobSharing: false.
 *
 * Args:
 *   formObj (object|undefined): the form, as Form.load hands it to this user ; none when the
 *     user may not open it.
 *
 * Returns:
 *   boolean: true when sharing is on for it.
 */
export function sharingOn(formObj) {
  return !!formObj && formObj.allowStoredJobSharing !== false;
}

/**
 * Whether a user sees another user's stored job because it is shared with them.
 *
 * Args:
 *   user (object): the logged in user, with its options.
 *   row (object): the stored job.
 *   formObj (object|undefined): its form, as Form.load hands it to this user.
 *
 * Returns:
 *   boolean: true for a shared stored job of a form with sharing on, with allowStoredJobsViewAll.
 */
export function seesShared(user, row, formObj) {
  return row?.visibility === 'shared' && !!user?.options?.allowStoredJobsViewAll && sharingOn(formObj);
}

/**
 * Why a user may not give a stored job this visibility ; null when they may. Private is always
 * allowed, shared needs allowStoredJobsShare and a form with sharing on.
 *
 * Args:
 *   user (object): the logged in user, with its options.
 *   visibility (any): the visibility asked for.
 *   formObj (object|undefined): the stored job's form, as Form.load hands it to this user.
 *
 * Returns:
 *   string|null: 'invalid', 'noPermission' or 'formDisabled' ; null when allowed.
 */
export function visibilityRefusal(user, visibility, formObj) {
  if (!VISIBILITIES.includes(visibility)) return 'invalid';
  if (visibility === 'private') return null;
  if (!user?.options?.allowStoredJobsShare) return 'noPermission';
  if (!sharingOn(formObj)) return 'formDisabled';
  return null;
}

/**
 * The values of a stored job as someone other than its owner may see them : filtered by its
 * form as a job's raw form data is (formEngine/output.js filterRawFormData), so without the
 * values of password fields, in list and yaml subform rows too, and without what the form does
 * not have. A wizard's are its step drafts, each filtered by its step's subform. Without the
 * form (one that cannot be loaded, or stored from a subform) no list or object value is kept :
 * it could hold any secret.
 *
 * Args:
 *   formObj (object|undefined): the stored job's form, its subforms inlined.
 *   data (object): the stored values (form_data, parsed).
 *
 * Returns:
 *   object: the values to show.
 */
export function storedFormDataFor(formObj, data) {
  const values = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (!formObj) {
    return Object.fromEntries(Object.entries(values).filter(([, v]) => v === null || typeof v !== 'object'));
  }
  if (Array.isArray(formObj.wizard) && formObj.wizard.length > 0) {
    return values.__wizard__ === true ? filterWizardRawFormData(formObj, values.drafts, values.skipped) : {};
  }
  return filterRawFormData(normalizeFields(formObj.fields), values, formObj.subforms || []);
}

/**
 * A stored job as the stored jobs routes hand it to a user : as stored to its owner and to a
 * settings user (who manages and edits everyone's, so a save must not lose values), with its
 * form_data filtered (storedFormDataFor) to anyone else, the users it is shared with.
 *
 * Args:
 *   user (object): the logged in user, with its options.
 *   row (object): the stored job.
 *   formObj (object|undefined): its form, as Form.load hands it to this user.
 *
 * Returns:
 *   object: the stored job to answer with.
 */
export function storedJobFor(user, row, formObj) {
  if (!row || row.username === ownerOf(user) || user?.options?.showSettings) return row;
  let data;
  try {
    data = JSON.parse(row.form_data || '{}');
  } catch {
    data = {};
  }
  return { ...row, form_data: JSON.stringify(storedFormDataFor(formObj, data)) };
}
