/******************************************************************/
/*                                                                */
/*  Who becomes an admin, and who may make them one. The admin    */
/*  role names local groups and users (config.yaml) ; a user with */
/*  settings access but without the admin role could put any      */
/*  account - their own - into such a group, or reset the admin   */
/*  account's password, and so make themselves admin. Granting    */
/*  admin, and changing an account or a group that grants it, is  */
/*  the admin role's own.                                         */
/*                                                                */
/******************************************************************/
import mysql from "../models/db.model.js";
import Errors from "./errors.js";
import yaml from "yaml";
import { memberRef, memberRefs } from "./directoryTypes.js";
import { adminRoles, grantsAdmin } from "./adminRole.js";
import i18n from "./i18n.js";

// the options an admin saving the roles always keeps for themselves : without them they could
// not sign in, or not reach Settings > Roles to undo the save
const OWN_ACCESS_OPTIONS = Object.freeze(["allowLogin", "showSettings"]);

/**
 * The local groups and users the roles that make admins name : the admin role, and every role
 * with admin: true (lib/adminRole.js).
 *
 * Args:
 *   configRoles (object[]): the roles of the configuration (config.yaml).
 *
 * Returns:
 *   {groups: Set<string>, users: Set<string>}: their names, without the local/ prefix.
 */
export function adminGrantsFromRoles(configRoles = []) {
  const local = (list) => (list || []).filter((x) => typeof x === "string" && x.startsWith("local/")).map((x) => x.slice(6));
  const groups = new Set();
  const users = new Set();
  for (const role of adminRoles(configRoles)) {
    for (const g of local(role.groups)) groups.add(g);
    for (const u of local(role.users)) users.add(u);
  }
  return { groups, users };
}

/**
 * The local groups and users the admin role names, from the configuration as it is now.
 *
 * Returns:
 *   Promise<{groups: Set<string>, users: Set<string>}>: their names.
 */
export async function adminGrants() {
  const { default: Form } = await import("../models/form.model.js");
  const base = await Form.load(null, null, null, true);
  return adminGrantsFromRoles(base?.roles || []);
}

/**
 * Whether the request is an admin's.
 *
 * Args:
 *   req (object): the request.
 *
 * Returns:
 *   boolean: true when the signed-in user has the admin role.
 */
export function isAdminRequest(req) {
  return (req?.user?.user?.roles || []).includes("admin");
}

/**
 * The names of groups, by id.
 *
 * Args:
 *   ids (number[]): the group ids.
 *
 * Returns:
 *   Promise<string[]>: their names.
 */
async function groupNames(ids) {
  const wanted = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!wanted.length) return [];
  const rows = await mysql.do("SELECT name FROM AnsibleForms.`groups` WHERE id IN (?)", [wanted]);
  return (rows || []).map((r) => r.name);
}

/**
 * Whether a local user is an admin through the admin role : named in it, or in one of its groups.
 *
 * Args:
 *   userId (number): the user.
 *   grants (object): adminGrants().
 *
 * Returns:
 *   Promise<boolean>: true when the user is an admin.
 */
async function userIsAdmin(userId, grants) {
  const rows = await mysql.do("SELECT username, group_id FROM AnsibleForms.`users` WHERE id=?", [userId]);
  const user = rows?.[0];
  if (!user) return false;
  if (grants.users.has(user.username)) return true;
  const links = await mysql.do("SELECT group_id FROM AnsibleForms.`user_groups` WHERE user_id=?", [userId]);
  const names = await groupNames([user.group_id, ...(links || []).map((l) => l.group_id)]);
  return names.some((n) => grants.groups.has(n));
}

/**
 * Refuses to a non-admin a change that would grant admin, or touch an account or a group that
 * grants it.
 *
 * Args:
 *   req (object): the request (the signed-in user).
 *   change (object): what it changes :
 *     userId : an existing user it updates, deletes, or changes the groups of ;
 *     username : the name of a user it creates ;
 *     groupIds : groups it puts a user in ;
 *     groupId : an existing group it updates or deletes ;
 *     groupName : the name a group is created with or renamed to.
 *
 * Raises:
 *   Errors.AccessDeniedError: the request is not an admin's and the change touches admin.
 */
export async function assertMayTouchAdmin(req, { userId, username, groupIds, groupId, groupName } = {}) {
  if (isAdminRequest(req)) return;
  const grants = await adminGrants();
  const refuse = (what) => { throw new Errors.AccessDeniedError(`Only an admin can ${what}`); };
  if (username && grants.users.has(String(username))) refuse("create or change an admin account");
  if (userId !== undefined && userId !== null && (await userIsAdmin(userId, grants))) refuse("change, reset or delete an admin account");
  if (groupIds && (await groupNames(groupIds)).some((n) => grants.groups.has(n))) refuse("put a user in a group that grants admin");
  if (groupId !== undefined && groupId !== null && (await groupNames([groupId])).some((n) => grants.groups.has(n))) refuse("change or delete a group that grants admin");
  if (groupName && grants.groups.has(String(groupName))) refuse("create a group that grants admin");
}

/**
 * Who the roles make an admin : every group and user the roles that make admins list (the admin
 * role, and every role with admin: true : lib/adminRole.js), as a
 * sorted list without duplicates, so two configurations compare whatever their order or layout.
 * The names are compared as the sign-in matches them (memberRefs, user.model.js) : entraid/x is
 * azuread/x, anything else as written.
 *
 * Args:
 *   configRoles (object[]): the roles of a configuration (config.yaml).
 *
 * Returns:
 *   string: the canonical form of the admin role's members.
 */
function adminMembers(configRoles = []) {
  const members = new Set();
  // the admin role, and every role with admin: true : each makes its members admins
  for (const role of adminRoles(configRoles)) {
    // groups and users kept apart : the same name means another account in each
    for (const g of memberRefs(role.groups)) members.add(`group:${g}`);
    for (const u of memberRefs(role.users)) members.add(`user:${u}`);
  }
  return JSON.stringify([...members].sort());
}

/**
 * The options every admin member gets from a configuration's roles, as the sign-in gives them
 * (User.rolesAndOptionsFrom) : each group and user the roles that make admins name, seen as a
 * user of that group alone, or as that user alone. Every role naming the same group or user
 * counts, and so does the default role, whose options fill what none of their roles set : an
 * option is the and of all of them, so any of these roles can take it away from the admins.
 *
 * Args:
 *   configRoles (object[]): the roles of a configuration (config.yaml).
 *   members (string[]): the admin members to look at, as adminMembers lists them
 *     (group:<ref>, user:<ref>) ; by default the admin members of configRoles.
 *
 * Returns:
 *   Promise<Map<string, object>>: the options of each member, by member.
 */
async function adminMemberOptions(configRoles = [], members = JSON.parse(adminMembers(configRoles))) {
  // imported lazily, like Form in adminGrants() : the user model is not needed to load this one
  const { default: User } = await import("../models/user.model.js");
  const result = new Map();
  for (const member of members) {
    // step 1 : a group is a user of that group alone ; a user is that user, without groups (a
    // name nobody signs in with stands for the user of a group)
    const [kind, ...rest] = member.split(":");
    const ref = rest.join(":");
    const groups = kind === "group" ? [ref] : [];
    const fullUsername = kind === "user" ? ref : "\u0000";
    // step 2 : their roles and options, as a sign-in would give them ; allowLogin has no
    // default, the sign-in refuses only false (login.controller.js hasValidLoginOption)
    const { options } = User.rolesAndOptionsFrom(configRoles, groups, fullUsername);
    if (options.allowLogin === undefined) options.allowLogin = true;
    result.set(member, options);
  }
  return result;
}

/**
 * The first option an admin member had on and no longer has : what a change of the roles takes
 * away from the admins (the sign-in with allowLogin, the settings with showSettings, admin
 * itself, or any other). An option that was not on before is not taken away.
 *
 * Args:
 *   before (Map<string, object>): adminMemberOptions of the configuration as it is now.
 *   after (Map<string, object>): adminMemberOptions of the configuration about to be written,
 *     for the same members.
 *
 * Returns:
 *   {member: string, option: string}|null: the member and the option ; null when nothing is taken.
 */
function optionTakenFromAdmins(before, after) {
  for (const [member, was] of before) {
    const now = after.get(member) || {};
    for (const [option, value] of Object.entries(was)) {
      if (value === true && now[option] !== true) return { member, option };
    }
  }
  return null;
}

/**
 * Refuses to a non-admin a configuration that changes who the admin role makes an admin. A
 * user with settings access edits the other roles (Settings > Roles), but adding a group or
 * a user to the admin role - their own - would make them admin. Nor may they take an option
 * away from the admins : a role naming their group with allowLogin: false, or the admin role's
 * showSettings turned off, would lock every admin out (an option is the and of every role).
 *
 * Args:
 *   req (object): the request (the signed-in user).
 *   roles (object[]|null): the roles of the configuration about to be written ; null when they
 *     cannot be read (a ytt template, not plain YAML until ytt renders it).
 *
 * Raises:
 *   Errors.AccessDeniedError: the request is not an admin's and the admin role's groups or
 *     users differ from the active configuration's, or cannot be read, or an admin member
 *     would lose an option they have now.
 */
export async function assertAdminRoleUnchanged(req, roles) {
  if (isAdminRequest(req)) return;
  // a configuration whose roles cannot be read could grant anything
  if (roles === null || roles === undefined) {
    throw new Errors.AccessDeniedError("Only an admin can load a configuration whose roles cannot be read");
  }
  // imported lazily, like Form in adminGrants() : the settings model is not needed to load this one
  const { default: Settings } = await import("../models/settings.model.js");
  // Step 1 : the admin role as it is now ; an active configuration that does not parse names
  // nobody, so any admin member in the new one is a change
  let active;
  try {
    active = yaml.parse((await Settings.getActiveConfig().catch(() => "")) || "")?.roles || [];
  } catch {
    active = [];
  }
  // Step 2 : the same groups and users, or refused
  if (adminMembers(active) !== adminMembers(roles)) {
    throw new Errors.AccessDeniedError("Only an admin can change who is an admin");
  }
  // Step 3 : and the same options for them. The options of a user are the and of every role
  // naming them (user.model.js), so a role naming the admins' group with allowLogin: false, the
  // admin role's own showSettings turned off, or the default role's, would lock every admin
  // out : compared as each admin member would sign in, before and after the save
  const before = await adminMemberOptions(active);
  const after = await adminMemberOptions(roles, [...before.keys()]);
  const taken = optionTakenFromAdmins(before, after);
  if (taken) {
    const member = taken.member.replace(/^(group|user):/, "");
    throw new Errors.AccessDeniedError(i18n.t(req, "resources.adminOptionAdminOnly", { option: taken.option, member }));
  }
}

/**
 * Refuses a save of the roles that would take admin away from the admin saving them : none of the
 * roles that make admins (the admin role, a role with admin: true) would name them, or one of
 * their groups, any more. The roles page does not keep an admin from removing their own group,
 * and once saved nobody could put it back but another admin. Nor would it turn off their
 * sign-in (allowLogin) or their settings (showSettings), through any role naming them.
 *
 * Args:
 *   req (object): the request (the signed-in user, an admin ; a non-admin is assertAdminRoleUnchanged's).
 *   roles (object[]|null): the roles about to be written ; null when they cannot be read.
 *
 * Raises:
 *   Errors.ConflictError: the admin saving them would no longer be one, or could no longer
 *     sign in or open the settings.
 */
export async function assertKeepsOwnAdmin(req, roles) {
  if (!isAdminRequest(req) || !Array.isArray(roles)) return;
  const user = req?.user?.user;
  if (!user?.username || !user?.type) return;
  // step 1 : who they are, and their groups as the sign-in matched them
  const full = `${user.type}/${user.username}`;
  const { groupsOf } = await import("./userGroups.js");
  const groups = await groupsOf(user).catch(() => []);
  // step 2 : a role that makes admins still naming them or one of their groups
  const stays = roles.some((role) => grantsAdmin(role) && (memberRefs(role.users).includes(full) || memberRefs(role.groups).some((g) => groups.includes(g))));
  if (!stays) {
    throw new Errors.ConflictError(`This save would take admin away from you (${full}): keep yourself or one of your groups in the admin role, or in a role with Admin on`);
  }
  // step 3 : and their way back in : the sign-in and the settings, as their sign-in would give
  // them (an option is the and of every role naming them, so any of those roles turns it off)
  const { default: User } = await import("../models/user.model.js");
  const { options } = User.rolesAndOptionsFrom(roles, groups, memberRef(full));
  for (const option of OWN_ACCESS_OPTIONS) {
    // false only : allowLogin has no default, and the sign-in refuses only false ; an option
    // already off for them (a designer save with the roles as they are) is not this save's
    if (options[option] === false && user.options?.[option] !== false) {
      throw new Errors.ConflictError(i18n.t(req, "resources.adminKeepsOwnAccess", { option, user: full }));
    }
  }
}

export default { adminGrantsFromRoles, adminGrants, isAdminRequest, assertMayTouchAdmin, assertAdminRoleUnchanged, assertKeepsOwnAdmin };
