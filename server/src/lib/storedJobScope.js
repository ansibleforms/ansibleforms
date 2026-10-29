// Who sees a stored job (#1269), for the stored jobs routes and the MCP server alike.
//
// A stored job is its owner's : the username column is always the creator, sharing never moves
// it. Its visibility says who else may load it : private (the owner only) or shared. Another
// user sees a shared one with the allowStoredJobsViewAll role option, for a form they may open
// that does not turn sharing off (allowStoredJobSharing: false). Sharing one needs
// allowStoredJobsShare. A settings user (showSettings) manages everyone's, as before.

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
