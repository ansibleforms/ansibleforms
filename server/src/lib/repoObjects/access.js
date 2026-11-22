'use strict';
// The saves of Settings > Access (users, groups, directory users) as their repositories follow
// them (lib/repoObjects/groups.js, users.js). A group's entry lists its members, so a change of a
// user's groups made in the app - a group added or removed, a user made in a group or deleted - is
// a change of the entries of those groups : each group it touched, as it was before, is written
// back once the save is done (RepoObjects.appUpdated). A directory user is a user of the users
// type, found by d and its row's id.
import mysql from "../../models/db.model.js";
import logger from "../logger.js";

/**
 * The groups as the groups type reads them (their members included), before a save changes them.
 *
 * Args:
 *   ids (any[]): the group ids (numbers or texts ; empty ones left out).
 *
 * Returns:
 *   Promise<object[]>: the groups found, each once.
 */
export async function groupsBefore(ids) {
  const { descriptorOf } = await import("./descriptors.js");
  const desc = await descriptorOf("groups");
  const out = [];
  for (const id of [...new Set((ids || []).map((i) => Number(i)).filter((i) => Number.isFinite(i) && i > 0))]) {
    const row = await desc.store.byId(id).catch(() => null);
    if (row) out.push(row);
  }
  return out;
}

/**
 * The groups of a local user, by id : its first group and its others.
 *
 * Args:
 *   userId (number|string): the user.
 *
 * Returns:
 *   Promise<number[]>: the group ids ; none when it is not there.
 */
export async function groupIdsOfUser(userId) {
  const users = (await mysql.do("SELECT * FROM AnsibleForms.`users` WHERE id = ?", [userId])) || [];
  if (!users[0]) return [];
  const others = (await mysql.do("SELECT user_id, group_id FROM AnsibleForms.`user_groups`", [])) || [];
  return [users[0].group_id, ...others.filter((l) => String(l.user_id) === String(userId)).map((l) => l.group_id)];
}

/**
 * Writes back the entries of the groups a save changed the members of : each one of a repository,
 * as it was before (groupsBefore), rewritten where its members changed.
 *
 * Args:
 *   befores (object[]): the groups before the save.
 *
 * Returns:
 *   Promise<void>
 */
export async function membersSaved(befores) {
  const RepoObjects = (await import("./index.js")).default;
  for (const before of befores || []) {
    if (!before?.repository) continue;
    await RepoObjects.appUpdated("groups", before, before.id);
  }
}

/**
 * A user of the users type as it is before a save : a local user by its id, or a directory user
 * by its type and username (its row's id then, d and the id).
 *
 * Args:
 *   which (object): { id } for a local user, or { type, username } for a directory user.
 *
 * Returns:
 *   Promise<object|null>: the user as the type reads it ({ id, repository, repo_file, ... }), null
 *     when there is none.
 */
export async function userBefore(which) {
  const { descriptorOf } = await import("./descriptors.js");
  const desc = await descriptorOf("users");
  if (which?.id !== undefined) return desc.store.byId(which.id).catch(() => null);
  const rows = (await mysql.do("SELECT * FROM AnsibleForms.`directory_users`", [])) || [];
  const row = rows.find((r) => r.type === which?.type && String(r.username).toLowerCase() === String(which?.username).toLowerCase());
  return row ? desc.store.byId(`d${row.id}`).catch(() => null) : null;
}

/**
 * Writes back a user a save changed : its entry rewritten when it has one, else written as a new
 * entry when the app now holds something of it (a directory user blocked, a local user made).
 *
 * Args:
 *   before (object|null): the user before the save (userBefore) ; none : a new one.
 *   after (object|null): the user after it (userBefore) ; none : it is gone.
 *
 * Returns:
 *   Promise<void>
 */
export async function userSaved(before, after) {
  const RepoObjects = (await import("./index.js")).default;
  try {
    if (before?.repository && !after) await RepoObjects.appDeleted("users", before);
    else if (before?.repository) await RepoObjects.appUpdated("users", before, after.id);
    // a new local user ; a directory user the app now holds something of (blocked, a description),
    // made or seen at a sign-in before
    else if (after && (after.type ? after.blocked || after.description : !before)) await RepoObjects.appCreated("users", after.id);
  } catch (e) {
    logger.error(`The users repository could not follow the save of '${(after || before)?.name}': ${e.message || e}`);
    throw e;
  }
}

export default { groupsBefore, groupIdsOfUser, membersSaved, userBefore, userSaved };
