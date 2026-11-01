'use strict';
// The Users type of the repository-backed objects (lib/repoObjects/engine.js) : the users of
// Settings > Access > Users, the entries of the controller_users: lists of a repository's files,
// in the config seed's format. One list holds both kinds of users, told apart by their type :
//   local     (the default, type not written) the app's own users (the users table) : its
//             username, email, what it is, its password as an ${ENV} reference (hashed when read ;
//             none : set in the app, the user signs in only once one is) and whether its sign-in
//             is blocked. Its groups are its groups' entries (lib/repoObjects/groups.js) : a new
//             one is put in the groups whose entries list it, the first of them by name its first
//             group ; one no group lists is refused until a group does.
//   ldap, entraid, oidc
//             a user of a directory (the directory_users table) : only what the app owns of it -
//             what it is and whether its sign-in is blocked. Its email, name, groups and roles
//             come from its directory at each sign-in. Its entry makes its row before it ever signs
//             in (a leaver blocked before it does) ; its entry removed, its row goes, made again
//             (unblocked) at its next sign-in.
//
// A user is found by its type and its username : a local jdoe and an LDAP jdoe are two users,
// named jdoe and ldap/jdoe here (nameOf). The built-in admin user is never read from nor written
// to git : the way back in.
import bcrypt from "bcrypt";
import mysql from "../../models/db.model.js";
import CrudModel from "../../models/crud.model.js";
import Group from "../../models/group.model.js";
import User from "../../models/user.model.js";
import { ENTRA_TYPE } from "../directoryTypes.js";
import { seedType, FROM_REPO } from "./seedType.js";
import { linkStore } from "./engine.js";
import { userItem } from "../seed-schema.js";
import { BUILT_IN_ADMIN, declaredGroupsOf } from "./groups.js";

// ===========================================================================
// HELPERS
// ===========================================================================

// a directory user's type as a file says it and as the table stores it : Entra ID is still
// azuread in the table (lib/directoryTypes.js), entraid in a file, as the roles editor writes it
const STORED_TYPE = { ldap: "ldap", entraid: ENTRA_TYPE, oidc: "oidc" };
const FILE_TYPE = Object.fromEntries(Object.entries(STORED_TYPE).map(([file, stored]) => [stored, file]));

// a directory user's row is found by this prefix and its id : the two tables' ids never meet
const DIRECTORY_ID = "d";

// the fields a directory user's entry may give : the rest is its directory's
const DIRECTORY_FIELDS = ["username", "type", "description", "blocked"];

/**
 * A user's type as a file says it : none for a local user.
 *
 * Args:
 *   type (any): the type given (local, ldap, entraid, oidc), or none.
 *
 * Returns:
 *   string|undefined: ldap, entraid or oidc ; undefined for a local user.
 */
const fileTypeOf = (type) => (!type || type === "local" ? undefined : type);

/**
 * A user's name among the users : its username for a local user, its type and username for one
 * of a directory (ldap/jdoe), as the roles name them.
 *
 * Args:
 *   get (function): (field) => the value of a field of the user (its entry, or the object).
 *
 * Returns:
 *   string|undefined: the name ; undefined when it gives no username.
 */
export function nameOf(get) {
  const username = get("username");
  if (username === undefined || username === null || String(username).trim() === "") return undefined;
  const type = fileTypeOf(get("type"));
  return type ? `${type}/${String(username).trim()}` : String(username).trim();
}

/**
 * A user as it is compared and written : its type as a file says it (none for a local one), its
 * name (nameOf), blocked a yes or no.
 *
 * Args:
 *   o (object): the user (an entry's object or a row).
 *
 * Returns:
 *   object: the user.
 */
function canonical(o) {
  if (!o || typeof o !== "object") return o;
  const out = { ...o };
  const type = fileTypeOf(out.type);
  if (type) out.type = type;
  else delete out.type;
  if (out.blocked !== undefined && out.blocked !== null) out.blocked = !!Number(out.blocked === true ? 1 : out.blocked === false ? 0 : out.blocked);
  const name = nameOf((field) => out[field]);
  if (name !== undefined) out.name = name;
  return out;
}

/**
 * Whether an id is a directory user's (DIRECTORY_ID and its row's id), and that row's id.
 *
 * Args:
 *   id (number|string): the user's id among the users.
 *
 * Returns:
 *   number|null: the directory_users row's id ; null for a local user.
 */
function directoryIdOf(id) {
  const m = /^d(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : null;
}

// ===========================================================================
// THE ROWS
// ===========================================================================

/**
 * A local user as the type reads it.
 *
 * Args:
 *   row (object): its users row.
 *
 * Returns:
 *   object: the user.
 */
const localUser = (row) =>
  canonical({
    id: row.id,
    username: row.username,
    email: row.email,
    description: row.description,
    password: row.password,
    blocked: row.blocked,
    repository: row.repository,
    repo_file: row.repo_file,
  });

/**
 * A directory user as the type reads it : what the app owns of it.
 *
 * Args:
 *   row (object): its directory_users row.
 *
 * Returns:
 *   object: the user.
 */
const directoryUser = (row) =>
  canonical({
    id: `${DIRECTORY_ID}${row.id}`,
    type: FILE_TYPE[row.type] || row.type,
    username: row.username,
    description: row.description,
    blocked: row.blocked,
    repository: row.repository,
    repo_file: row.repo_file,
  });

/**
 * Every user the type knows : the local ones (the built-in admin left out) and those of a
 * directory.
 *
 * Returns:
 *   Promise<object[]>: the users.
 */
async function userRows() {
  const local = (await mysql.do("SELECT * FROM AnsibleForms.`users`", [])) || [];
  const directory = (await mysql.do("SELECT * FROM AnsibleForms.`directory_users`", [])) || [];
  return [...local.filter((u) => String(u.username).toLowerCase() !== BUILT_IN_ADMIN).map(localUser), ...directory.map(directoryUser)];
}

/**
 * One user the type knows (userRows).
 *
 * Args:
 *   id (number|string): its id among the users (a local user's, or d and a directory user's).
 *
 * Returns:
 *   Promise<object|null>: the user, null when there is none (or it is the built-in admin).
 */
async function userRow(id) {
  const dir = directoryIdOf(id);
  if (dir !== null) {
    const rows = await mysql.do("SELECT * FROM AnsibleForms.`directory_users` WHERE id = ?", [dir]);
    return rows?.[0] ? directoryUser(rows[0]) : null;
  }
  const rows = await mysql.do("SELECT * FROM AnsibleForms.`users` WHERE id = ?", [id]);
  const row = rows?.[0];
  return row && String(row.username).toLowerCase() !== BUILT_IN_ADMIN ? localUser(row) : null;
}

// ===========================================================================
// THE MODEL : WRITING A USER
// ===========================================================================

/**
 * The groups a new local user is put in : those whose entries list it, the first of them by name
 * its first group (users.group_id).
 *
 * Args:
 *   username (string): the username.
 *
 * Returns:
 *   Promise<number[]>: the group ids, the first group first.
 *
 * Raises:
 *   Error: no group lists it (a user has at least one group).
 */
async function groupIdsOf(username) {
  const ids = [];
  for (const name of await declaredGroupsOf(username)) {
    const group = await Group.findByName(name).catch(() => null);
    if (group?.id) ids.push(group.id);
  }
  if (!ids.length) throw new Error(`no group lists '${username}' in its users: name it in a group's entry (controller_groups:), a user has at least one group`);
  return ids;
}

// what the engine writes a user through : the users table for a local user, directory_users
// for one of a directory
const UserOfEither = {
  async create(data) {
    const type = STORED_TYPE[data.type];
    if (type) {
      const values = { description: data.description || null, blocked: data.blocked ? 1 : 0 };
      // seen at a sign-in already : its row takes what the entry says (its directory's fields kept)
      const all = (await mysql.do("SELECT * FROM AnsibleForms.`directory_users`", [])) || [];
      const seen = all.find((r) => r.type === type && String(r.username).toLowerCase() === String(data.username).toLowerCase());
      if (seen) {
        await mysql.do("UPDATE AnsibleForms.`directory_users` SET ? WHERE id = ?", [values, seen.id]);
        return `${DIRECTORY_ID}${seen.id}`;
      }
      // never seen : its row made before its first sign-in (first_seen stays empty until then)
      const res = await mysql.do("INSERT INTO AnsibleForms.`directory_users` SET ?", [{ type, username: String(data.username).slice(0, 250), ...values }]);
      return `${DIRECTORY_ID}${res.insertId}`;
    }
    const [first, ...others] = await groupIdsOf(data.username);
    // no password given : one nobody knows, until an admin sets one (it must be changed at the
    // first sign-in then, as the default admin's)
    const password = data.password || (await import("crypto")).randomBytes(32).toString("hex");
    const id = await User.create({ username: data.username, email: data.email || "", description: data.description || "", password, group_id: first }, FROM_REPO);
    for (const gid of others) await User.addGroup(id, gid);
    if (data.blocked) await User.setBlocked(id, true);
    return id;
  },
  async update(data, id) {
    const dir = directoryIdOf(id);
    if (dir !== null) {
      const values = {};
      if (data.description !== undefined) values.description = data.description || null;
      if (data.blocked !== undefined && data.blocked !== null) values.blocked = data.blocked ? 1 : 0;
      if (data.username !== undefined) values.username = String(data.username).slice(0, 250);
      if (Object.keys(values).length) await mysql.do("UPDATE AnsibleForms.`directory_users` SET ? WHERE id = ?", [values, dir]);
      return;
    }
    const { blocked, type: _type, name: _name, ...rest } = data;
    // a password the entry does not give : the database's stays (an empty one keeps it)
    if (!rest.password) delete rest.password;
    if (Object.keys(rest).length) await User.update(rest, id, FROM_REPO);
    if (blocked !== undefined && blocked !== null) await User.setBlocked(id, !!blocked);
  },
  async delete(id) {
    const dir = directoryIdOf(id);
    // its entry removed : its row goes, blocked or not - made again at its next sign-in
    if (dir !== null) return mysql.do("DELETE FROM AnsibleForms.`directory_users` WHERE id = ?", [dir]);
    return User.delete(id);
  },
};

// the links of the users to their repository, in either table
const localLinks = linkStore("AnsibleForms.`users`");
const directoryLinks = linkStore("AnsibleForms.`directory_users`");
const links = {
  link: (id, repository, file) => {
    const dir = directoryIdOf(id);
    return dir !== null ? directoryLinks.link(dir, repository, file) : localLinks.link(id, repository, file);
  },
  unlink: async (repository) => (await localLinks.unlink(repository)) + (await directoryLinks.unlink(repository)),
  rename: async (from, to) => (await localLinks.rename(from, to)) + (await directoryLinks.rename(from, to)),
  countLinked: async (repository) => (await localLinks.countLinked(repository)) + (await directoryLinks.countLinked(repository)),
};

// ===========================================================================
// THE TYPE
// ===========================================================================

const base = seedType({
  key: "users",
  section: userItem,
  model: "users",
  Model: UserOfEither,
  title: "Users",
  noun: "user",
  // a local user's password : an ${ENV} reference only, never written back (its hash stays in
  // the database)
  secrets: ["password"],
  read: { all: userRows, byId: userRow },
  // found by its type and its username (a local jdoe and an LDAP jdoe are two users)
  nameField: nameOf,
  canonical,
  // a local user's email : what tells it apart besides its name, so a username changed in its
  // file keeps the user (its jobs, its sign-ins) ; a directory user's type
  identity: ["type", "email"],
  // the password is compared with its hash (changed below), never as a text
  notCompared: ["password"],
  defaults: { description: "" },
  // what a user's entry may not give
  validate: (o) => {
    const errors = [];
    if (String(o.username).toLowerCase() === BUILT_IN_ADMIN && !o.type) errors.push("the built-in admin user is never read from a repository: it stays as the app has it");
    if (o.type) {
      const extra = Object.keys(o).filter((k) => o[k] !== undefined && !DIRECTORY_FIELDS.includes(k) && k !== "name");
      if (extra.length) errors.push(`${extra.join(", ")}: a ${o.type} user's come from its directory - only its description and blocked are given here`);
    }
    return errors;
  },
});

export default {
  ...base,
  store: {
    ...base.store,
    ...links,
    // the names a file may name : every user, as the type names them
    names: async () => (await userRows()).map((u) => u.name).filter(Boolean),
    // changed : the other fields as the seed compares, the password with its hash
    changed: (row, obj) => {
      if (base.store.changed(row, obj)) return true;
      if (!obj.password || obj.type) return false;
      try {
        return !bcrypt.compareSync(String(obj.password), String(row.password || ""));
      } catch {
        return true;
      }
    },
    insert: async (obj, name, file) => {
      const id = await UserOfEither.create({ ...obj });
      if (name) await links.link(id, name, file);
      CrudModel.changed("users");
      return id;
    },
    // the app's own, as a repository would take them : every local user ; a directory user only
    // when the app holds something of it (blocked, a description) - one merely seen at a sign-in
    // is a record of its directory, never written to git
    appRows: async () =>
      ((await userRows()) || [])
        .filter((u) => !u.repository && (!u.type || u.blocked || (u.description && String(u.description).trim())))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    adopt: async (row, obj, name, file) => {
      await UserOfEither.update({ ...obj }, row.id);
      await links.link(row.id, name, file);
    },
  },
};
