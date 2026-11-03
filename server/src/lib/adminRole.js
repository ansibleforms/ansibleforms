'use strict';
// Which roles make their users admins. The role named `admin` always does - the way in of every
// configuration since the first, and the one the closed roles keep. Since 7.6 any other role does
// too when its options say `admin: true` (Settings > Roles : the Admin toggle, with the access and
// integrations options), so a team's own naming (platformAdmins, infra_admins) grants admin
// without a role called admin. The default role never does : it is every user's.
//
// A user of such a role carries the `admin` role among its roles from its sign-in on
// (models/user.model.js getRolesAndOptions), so every check of the admin role - the API's, the
// jobs', the client's - holds for it as it holds for the admin role's own users.
import { isEveryoneRole } from "./defaultRole.js";

// the role every admin carries, whichever role made it one
export const ADMIN_ROLE = "admin";

/**
 * Whether a role makes its users admins : the role named admin, or one whose options say
 * `admin: true` (never the default role, every user's).
 *
 * Args:
 *   role (object): a role of the configuration ({ name, groups, users, options }).
 *
 * Returns:
 *   boolean: true when its users are admins.
 */
export function grantsAdmin(role) {
  if (!role || typeof role !== "object") return false;
  const name = typeof role.name === "string" ? role.name.trim() : "";
  if (name === ADMIN_ROLE) return true;
  return role.options?.admin === true && !isEveryoneRole(name);
}

/**
 * The roles of a configuration that make their users admins (grantsAdmin).
 *
 * Args:
 *   roles (object[]): the roles of a configuration.
 *
 * Returns:
 *   object[]: those roles, in their order.
 */
export const adminRoles = (roles) => (Array.isArray(roles) ? roles : []).filter(grantsAdmin);

export default { ADMIN_ROLE, grantsAdmin, adminRoles };
