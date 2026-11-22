'use strict';
// The roles a repository holds (controller_roles:, lib/configKeys.js), each read on its own : one
// role that is not valid, or whose name is given twice, is refused alone - its last version read on
// this node served meanwhile, else left out - and the others are served ; a broken role never
// takes the whole configuration down with it. The roles may be spread over several files of the
// repository, each listing some : they are served as one list, in the order of their files.
//
// The admin and the default role are always there : one a pull no longer gives (or gives broken)
// keeps the version last read, else the closed one (lib/configKeys.js CLOSED_ROLES) - a repository
// never locks its admins out, nor fails the base schema, which requires the default role.
//
// What a role names is checked as well (references) : a local group or user, a runner, a secret
// store that is not there. Such a role is served as it is - a group that is not there grants
// nothing, a runner allow-list naming one that is not there only allows less - and the name is said
// on the repository's page and in its pull output, so a typo does not go unnoticed.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv";
import _ from "lodash";
import mysql from "../models/db.model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// ONE ROLE, CHECKED
// ===========================================================================

// the base schema's role (schema/base_schema.json), compiled once : a role is checked as the base
// configuration checks each of its roles
const baseSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../schema/base_schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const checkOne = ajv.compile({ type: "object", properties: { roles: { type: "array", items: baseSchema.properties.roles.items } } });

// the roles every set has : the way in for the local admins, and every user's
export const REQUIRED_ROLES = ["admin", "default"];

/**
 * Why a role is not valid, as the base schema says it.
 *
 * Args:
 *   role (any): the role, as its file gives it.
 *
 * Returns:
 *   string|null: why ; null when it is valid.
 */
export function roleError(role) {
  if (!role || typeof role !== "object" || Array.isArray(role)) return "a role must be a dictionary";
  if (typeof role.name !== "string" || !role.name.trim()) return "a role must have a name";
  if (checkOne({ roles: [role] })) return null;
  const anyOf = (checkOne.errors || []).some((e) => e.keyword === "anyOf");
  // groups and users both missing : said once (anyOf), never as two missing properties beside it
  const said = (checkOne.errors || [])
    .filter((e) => e.keyword !== "if" && e.keyword !== "anyOf")
    .filter((e) => !(anyOf && e.keyword === "required" && ["groups", "users"].includes(e.params?.missingProperty)))
    .map((e) => `${e.instancePath.replace(/^\/roles\/0\/?/, "").replace(/\//g, ".") || "the role"} ${e.message}`)
    .slice(0, 3);
  if (anyOf) said.unshift("it names no groups and no users");
  return said.join("; ") || "not a valid role";
}

/**
 * The roles of a repository's files as they are served, each checked on its own.
 *
 * Args:
 *   files (object[]): [{ file (relative to the repository), roles (the list its key gives ; null :
 *     the file is not read - its roles as last read are served), problem (why it is not read) }],
 *     in their order.
 *   last (Map<string, object>): each role as last served on this node, by name : what a role
 *     refused now is served as meanwhile.
 *   closed (object[]): the roles served when a required one was never read (CLOSED_ROLES).
 *
 * Returns:
 *   object: { roles (the roles served), problems (string[] : each refused role, each name given
 *     twice, each required role kept, said for the page and the pull output), blocking (string[] :
 *     those of them a save of the roles is refused for - a role refused, a file not read : fixed in
 *     git first, never overwritten from the app), changed (true : the roles served are not the
 *     files' as written - a role left out, replaced or added) }.
 */
export function servedRoles(files, last, closed) {
  const problems = [];
  const blocking = [];
  // each role given, with where it is
  const given = [];
  for (const f of files || []) {
    if (!Array.isArray(f.roles)) {
      const line = `${f.file} is not read${f.problem ? ` (${f.problem})` : ""}: the roles it gave are served as last read`;
      problems.push(line);
      blocking.push(line);
      for (const role of last.values()) if (role.__file === f.file) given.push({ role: _.omit(role, "__file"), file: f.file, kept: true });
      continue;
    }
    f.roles.forEach((role, index) => given.push({ role, file: f.file, index }));
  }
  // the names given more than once : each refused, both places named
  const places = new Map();
  for (const g of given) {
    const name = typeof g.role?.name === "string" ? g.role.name : null;
    if (!name) continue;
    if (!places.has(name)) places.set(name, []);
    places.get(name).push(g.index !== undefined ? `${g.file}, entry ${g.index + 1}` : g.file);
  }
  const roles = [];
  const refused = new Set();
  let changed = files.length > 1;
  for (const g of given) {
    const name = typeof g.role?.name === "string" ? g.role.name : null;
    const twice = name && places.get(name).length > 1;
    const error = twice ? `the name '${name}' is given twice: ${places.get(name).join(" and ")}` : roleError(g.role);
    if (!error) {
      roles.push(g.role);
      last.set(name, { ...g.role, __file: g.file });
      if (g.kept) changed = true;
      continue;
    }
    changed = true;
    if (name && refused.has(name)) continue;
    if (name) refused.add(name);
    const before = name ? last.get(name) : null;
    const where = g.index !== undefined ? `${g.file} (entry ${g.index + 1})` : g.file;
    const line = `role ${name ? `'${name}'` : "without a name"} of ${where} is refused: ${error}${before ? " - served as last read" : ""}`;
    problems.push(line);
    blocking.push(line);
    if (before) roles.push(_.omit(before, "__file"));
  }
  // the admin and the default role : always there
  for (const name of REQUIRED_ROLES) {
    if (roles.some((r) => r.name === name)) continue;
    changed = true;
    const before = last.get(name);
    const fallback = before ? _.omit(before, "__file") : _.cloneDeep(closed.find((r) => r.name === name));
    if (!fallback) continue;
    roles.push(JSON.parse(JSON.stringify(fallback)));
    if (!refused.has(name)) problems.push(`the ${name} role is not given: ${before ? "the one last read is" : "the closed one is"} served - a repository always gives the admin and the default role`);
  }
  return { roles, problems, blocking, changed };
}

// ===========================================================================
// WHAT A ROLE NAMES
// ===========================================================================

/**
 * What the roles name that is not there : a local group or user (local/<name>), a runner, a secret
 * store - each said once, with the roles naming it. The credentials are patterns (cmdb-.*) : never
 * checked here. A directory's groups and users (ldap/, entraid/, oidc/) live in the directory.
 *
 * Args:
 *   roles (object[]): the roles served.
 *
 * Returns:
 *   Promise<string[]>: one line per name that is not there (none when each one is).
 */
export async function missingReferences(roles) {
  const names = async (sql, field) => new Set(((await mysql.do(sql, []).catch(() => [])) || []).map((r) => String(r[field] ?? "").toLowerCase()));
  const [groups, users, runners, stores] = await Promise.all([
    names("SELECT name FROM AnsibleForms.`groups`", "name"),
    names("SELECT username FROM AnsibleForms.`users`", "username"),
    names("SELECT name FROM AnsibleForms.`runners`", "name"),
    names("SELECT name FROM AnsibleForms.`secret_stores`", "name"),
  ]);
  const missing = new Map();
  const note = (what, name, role) => {
    const key = `${what} '${name}'`;
    if (!missing.has(key)) missing.set(key, []);
    if (!missing.get(key).includes(role)) missing.get(key).push(role);
  };
  const local = (ref) => {
    const m = /^local\/(.+)$/i.exec(String(ref ?? "").trim());
    return m ? m[1] : null;
  };
  for (const role of roles || []) {
    for (const ref of Array.isArray(role.groups) ? role.groups : []) {
      const name = local(ref);
      if (name && !groups.has(name.toLowerCase())) note("local group", name, role.name);
    }
    for (const ref of Array.isArray(role.users) ? role.users : []) {
      const name = local(ref);
      if (name && !users.has(name.toLowerCase())) note("local user", name, role.name);
    }
    for (const name of Array.isArray(role.runners) ? role.runners : []) if (!runners.has(String(name).toLowerCase())) note("runner", name, role.name);
    for (const name of Array.isArray(role.secretStores) ? role.secretStores : []) if (!stores.has(String(name).toLowerCase())) note("secret store", name, role.name);
  }
  return [...missing].map(([what, by]) => `no ${what}, which ${by.length > 1 ? "roles" : "role"} ${by.map((r) => `'${r}'`).join(", ")} ${by.length > 1 ? "name" : "names"}: it grants nothing until there is one`);
}

export default { roleError, servedRoles, missingReferences, REQUIRED_ROLES };
