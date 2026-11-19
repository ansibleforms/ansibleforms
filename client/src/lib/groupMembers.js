/******************************************************************/
/*                                                                */
/*  The users and roles of a new group : once the New group       */
/*  wizard has created it, each user picked is added to it and    */
/*  it is given the roles picked, through the APIs its own page   */
/*  uses. One that fails leaves the group as it is : what failed  */
/*  is returned, for the page to say.                             */
/*                                                                */
/******************************************************************/

/**
 * Adds the users picked to a group just created, then gives it the roles picked.
 *
 * Args:
 *   options (object):
 *     groupId (number): the group created (its id, the create's answer).
 *     userIds (number[]): the users to add to it.
 *     roleNames (string[]): the roles to give it.
 *     addUser (Function): (userId, groupId) => Promise, adds one user to the group ; rejects
 *       when it fails (POST /api/v2/user/:id/groups).
 *     addRoles (Function): (roleNames) => Promise<boolean>, names the group in those roles of
 *       the forms config, in one save ; false when it was not saved.
 *
 * Returns:
 *   Promise<object>: { failedUsers, failedRoles }, the user ids and the role names not added.
 */
export async function addGroupMembers({ groupId, userIds = [], roleNames = [], addUser, addRoles }) {
  // ─── its users, one after the other ──────────────────────────────────────────
  const failedUsers = [];
  for (const userId of userIds) {
    try {
      await addUser(userId, groupId);
    } catch {
      failedUsers.push(userId);
    }
  }
  // ─── its roles, in one save of the forms config ──────────────────────────────
  let failedRoles = [];
  if (roleNames.length) {
    // refused (false) or failed (a throw) : none of them given
    const saved = await Promise.resolve()
      .then(() => addRoles(roleNames))
      .catch(() => false);
    if (!saved) failedRoles = [...roleNames];
  }
  return { failedUsers, failedRoles };
}
