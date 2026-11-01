'use strict';
// The Groups type of the repository-backed objects (lib/repoObjects/engine.js) : the local groups
// (Settings > Access > Groups), the entries of the controller_groups: lists of a repository's
// files, in the config seed's format : a group's name, what it is for, and the local users in it.
//
// A group holds its members : its entry lists the usernames of the local users in it, and the
// users' own entries (controller_users:) say nothing of their groups, so who is in a group is read
// and reviewed in one place. A user's first group (users.group_id) is never written : it is the
// first of its groups by name, kept as the app keeps it. A username no local user has yet is no
// refusal : its user is made by the users type (lib/repoObjects/users.js), which reads the groups
// listing it from these same entries (declaredMembers), and is put in each of them then.
//
// The built-in admin user is never read from nor written to git : its groups stay as the app has
// them, an entry listing it or leaving it out changes nothing. The admins group is never renamed
// nor deleted (models/group.model.js), whatever its file says.
import mysql from "../../models/db.model.js";
import CrudModel from "../../models/crud.model.js";
import Group from "../../models/group.model.js";
import User from "../../models/user.model.js";
import logger from "../logger.js";
import { seedType, FROM_REPO } from "./seedType.js";
import { groupItem } from "../seed-schema.js";

// ===========================================================================
// HELPERS
// ===========================================================================

// the user git never reads nor writes : the way back in
export const BUILT_IN_ADMIN = "admin";

/**
 * A list of usernames as compared and written : each once (case does not count), sorted, the
 * built-in admin left out.
 *
 * Args:
 *   names (any): the usernames (a list) ; anything else : none.
 *
 * Returns:
 *   string[]: the usernames.
 */
export function memberList(names) {
  const seen = new Set();
  const out = [];
  for (const n of Array.isArray(names) ? names : []) {
    const name = String(n ?? "").trim();
    const key = name.toLowerCase();
    if (!name || key === BUILT_IN_ADMIN || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * The local users of each group : those it is the first group of and those it is another group
 * of (user_groups), the built-in admin left out.
 *
 * Returns:
 *   Promise<Map<number, string[]>>: group id -> its usernames, sorted.
 */
async function membersByGroup() {
  const users = (await mysql.do("SELECT id, username, group_id FROM AnsibleForms.`users`", [])) || [];
  const others = (await mysql.do("SELECT user_id, group_id FROM AnsibleForms.`user_groups`", [])) || [];
  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  const out = new Map();
  const add = (gid, username) => {
    if (username === undefined) return;
    if (!out.has(gid)) out.set(gid, []);
    out.get(gid).push(username);
  };
  // its first group, then its others
  for (const u of users) add(u.group_id, u.username);
  for (const l of others) add(l.group_id, nameOf.get(l.user_id));
  for (const [gid, names] of out) out.set(gid, memberList(names));
  return out;
}

/**
 * The groups as the type compares and writes them : each row with its members (users).
 *
 * Returns:
 *   Promise<object[]>: the groups.
 */
async function groupRows() {
  const groups = (await CrudModel.findAll("groups")) || [];
  const members = await membersByGroup();
  return groups.map((g) => ({ ...g, users: members.get(g.id) || [] }));
}

/**
 * One group as the type compares and writes it (groupRows).
 *
 * Args:
 *   id (number): the group.
 *
 * Returns:
 *   Promise<object|null>: the group, null when there is none.
 */
async function groupRow(id) {
  const group = await CrudModel.findById("groups", id).catch(() => null);
  if (!group) return null;
  const members = await membersByGroup();
  return { ...group, users: members.get(group.id) || [] };
}

/**
 * Puts a group's members where its entry says : the local users it lists are put in it, the
 * others taken out of it. A username no local user has is left for the users type (its user
 * is put in the group when it is made) ; the built-in admin is never moved ; a user whose only
 * group this is stays in it (a user keeps at least one group), said in the server log.
 *
 * Args:
 *   groupId (number): the group.
 *   names (string[]): the usernames its entry lists.
 *
 * Returns:
 *   Promise<void>
 */
export async function setMembers(groupId, names) {
  const wanted = new Set(memberList(names).map((n) => n.toLowerCase()));
  const users = (await User.findAll()) || [];
  for (const user of users) {
    const key = String(user.username).toLowerCase();
    if (key === BUILT_IN_ADMIN) continue;
    const isIn = (user.group_ids || []).includes(groupId);
    if (wanted.has(key) && !isIn) {
      await User.addGroup(user.id, groupId);
    } else if (!wanted.has(key) && isIn) {
      try {
        await User.removeGroup(user.id, groupId);
      } catch (e) {
        // its only group : kept, never a user without one
        logger.warning(`User '${user.username}' stays in group ${groupId}, which its repository entry no longer lists: ${e.message || e}`);
      }
    }
  }
}

/**
 * The groups the entries of the groups repository list a username in, by their names : how the
 * users type knows the groups of a user it makes (its first group and the others). Read from the
 * files of the repository holding the groups, so a group whose entry lists a user that does not
 * exist yet still gives it its groups.
 *
 * Args:
 *   username (string): the username.
 *
 * Returns:
 *   Promise<string[]>: the group names, sorted ; none when no repository holds the groups.
 */
export async function declaredGroupsOf(username) {
  const Engine = await import("./engine.js");
  const { descriptorOf } = await import("./descriptors.js");
  const desc = await descriptorOf("groups");
  const repository = await Engine.activeRepository(desc);
  if (!repository || !Engine.cloned(repository)) return [];
  const key = String(username ?? "").trim().toLowerCase();
  const names = new Set();
  for (const file of Engine.scanOf(repository).holding("groups")) {
    for (const entry of Array.isArray(file.value) ? file.value : []) {
      if (!entry || typeof entry !== "object" || entry.state === "absent" || !entry.name) continue;
      if ((Array.isArray(entry.users) ? entry.users : []).some((u) => String(u ?? "").trim().toLowerCase() === key)) names.add(String(entry.name));
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ===========================================================================
// THE MODEL : A GROUP AND ITS MEMBERS
// ===========================================================================

// what the engine writes a group through : its row as the app saves it, then its members
const GroupWithMembers = {
  async create(data) {
    const { users, ...row } = data;
    const id = await Group.create(row, FROM_REPO);
    await setMembers(id, users);
    return id;
  },
  async update(data, id) {
    const { users, ...row } = data;
    if (Object.keys(row).length) await Group.update(row, id, FROM_REPO);
    if (users !== undefined) await setMembers(Number(id), users);
  },
  async delete(id) {
    // its members leave it first (each keeping its other groups) : one for whom it is the only
    // group keeps it, and the delete is refused then (models/group.model.js)
    await setMembers(Number(id), []);
    return Group.delete(id);
  },
};

// ===========================================================================
// THE TYPE
// ===========================================================================

export default seedType({
  key: "groups",
  section: groupItem,
  model: "groups",
  Model: GroupWithMembers,
  title: "Groups",
  noun: "group",
  secrets: [],
  read: { all: groupRows, byId: groupRow },
  // groups.description has no default in the table
  defaults: { description: "" },
  // its members as compared and written : once each, sorted, the built-in admin left out ; none
  // written as no users: key at all (an entry without one has no members)
  canonical: (o) => {
    if (!o || !Array.isArray(o.users)) return o;
    const { users, ...rest } = o;
    const members = memberList(users);
    return members.length ? { ...rest, users: members } : rest;
  },
  // the way back in keeps its group
  undeletable: (row) => (String(row.name).toLowerCase() === "admins" ? "the admins group is never deleted" : null),
});
