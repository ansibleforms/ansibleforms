"use strict";
import { EVERYONE_ROLES, everyoneEntry } from "../lib/defaultRole.js";
import { memberRefs } from "../lib/directoryTypes.js";
import crypto from "../lib/crypto.js";
import logger from "../lib/logger.js";
import Ldap from "./ldap.model.js";
import Form from "./form.model.js";
import yaml from "yaml";
import mysql from "./db.model.js";
import helpers from "../lib/common.js";
import Token from "./token.model.js";
import CrudModel from './crud.model.js';

/**
 * Fill in every option the roles did not express an opinion about.
 *
 * Extracted so the FAILURE path below can produce the same shape. Absent is not false
 * here: most options default to true, a few to isAdmin, and BOTH showExtravars spellings
 * are filled - see the notes in client/src/config/roles.js.
 */
function applyOptionDefaults(options, isAdmin) {
  if (options.allowVerboseMode === undefined) options.allowVerboseMode = true;
  if (options.showSettings === undefined) options.showSettings = isAdmin;
  if (options.showDesigner === undefined) options.showDesigner = isAdmin;
  // in the designer, each kind of file written (saved, new, removed, pushed) : on for every
  // designer unless a role says otherwise
  if (options.allowPlaybookDesign === undefined) options.allowPlaybookDesign = true;
  // the forms config in the designer (categories, constants, forms) : as the files, on unless a role says otherwise
  if (options.allowFormDesign === undefined) options.allowFormDesign = true;
  // every form in the designer, or only those of the user's roles (lib/designerForms.js) : on
  // unless a role turns it off, always on for an admin
  if (options.designAllForms === undefined || isAdmin) options.designAllForms = true;
  // every playbook and every workflow file in the designer, or only those the forms the user sees
  // use and those no form uses (lib/designerForms.js) : as designAllForms
  if (options.designAllPlaybooks === undefined || isAdmin) options.designAllPlaybooks = true;
  if (options.designAllWorkflows === undefined || isAdmin) options.designAllWorkflows = true;
  // api tokens (lib/tokenLifetime.js) : off unless a role turns them on - a role from before this
  // option, with only extendedTokenExpiration (then the token permission), keeps them ;
  // extendedTokenExpiration (with them, one that never expires) off as well
  if (options.allowApiTokens === undefined) options.allowApiTokens = !!options.extendedTokenExpiration;
  if (options.extendedTokenExpiration === undefined) options.extendedTokenExpiration = false;
  if (options.allowWorkflowDesign === undefined) options.allowWorkflowDesign = true;
  if (options.allowInventoryDesign === undefined) options.allowInventoryDesign = true;
  if (options.allowVarsFileDesign === undefined) options.allowVarsFileDesign = true;
  if (options.showLogs === undefined) options.showLogs = isAdmin;
  // the audit log on its own (the settings give it too) : as the server log, the admins'
  if (options.showAuditLog === undefined) options.showAuditLog = isAdmin;
  // a part of the settings on its own (lib/settingsSections.js) : off unless a role turns it on
  // (showSettings gives every part)
  if (options.showAppearanceSettings === undefined) options.showAppearanceSettings = false;
  if (options.showConnectionsSettings === undefined) options.showConnectionsSettings = false;
  if (options.allowBackupOps === undefined) options.allowBackupOps = isAdmin;
  if (options.showJobs === undefined) options.showJobs = true;
  if (options.showDebugButtons === undefined) options.showDebugButtons = true;
  if (options.showExtravars === undefined) options.showExtravars = true;
  if (options.showExtraVars === undefined) options.showExtraVars = true;
  if (options.showArtifacts === undefined) options.showArtifacts = true;
  if (options.allowJobRelaunch === undefined) options.allowJobRelaunch = isAdmin;
  if (options.showAllJobLogs === undefined) options.showAllJobLogs = isAdmin;
  // every user's jobs acted on (abort, delete, relaunch ; job.model.js managesAllJobs) : the admins'
  if (options.manageAllJobs === undefined) options.manageAllJobs = isAdmin;
  if (options.allowScheduledJobs === undefined) options.allowScheduledJobs = isAdmin;
  if (options.allowStoredJobs === undefined) options.allowStoredJobs = true;
  // sharing a stored job, and loading the ones others shared (lib/storedJobScope.js) : the admins'
  if (options.allowStoredJobsShare === undefined) options.allowStoredJobsShare = isAdmin;
  if (options.allowStoredJobsViewAll === undefined) options.allowStoredJobsViewAll = isAdmin;
  // a form's file fields, uploaded to the server : on unless a role turns it off
  if (options.allowFileUploads === undefined) options.allowFileUploads = true;
  // deleting jobs (their own ; every job for an admin) : on unless a role turns it off
  if (options.allowJobDeletion === undefined) options.allowJobDeletion = true;
  if (options.allowPlannedJobs === undefined) options.allowPlannedJobs = true;
  // the chat assistant (ENABLE_CHAT) : on for everyone unless a role says otherwise
  if (options.allowChat === undefined) options.allowChat = true;
  // the MCP server (ENABLE_MCP) : as the chat assistant unless a role says otherwise, so a
  // role that turned allowChat off before allowMcp existed keeps the MCP server off too
  if (options.allowMcp === undefined) options.allowMcp = options.allowChat;
  return options;
}

/**
 * Adds to users the ids of all their groups (group_ids) : their first one (group_id) and the
 * others (the user_groups table).
 *
 * Args:
 *   users (object[]): users as read from the users table.
 *
 * Returns:
 *   Promise<object[]>: the same users, each with group_ids.
 */
async function withGroupIds(users) {
  const list = (users || []).filter(Boolean);
  if (!list.length) return users;
  const links = await mysql.do("SELECT user_id, group_id FROM AnsibleForms.`user_groups`", []);
  const extra = new Map();
  for (const l of links || []) {
    if (!extra.has(l.user_id)) extra.set(l.user_id, []);
    extra.get(l.user_id).push(l.group_id);
  }
  for (const u of list) {
    u.group_ids = [u.group_id, ...(extra.get(u.id) || []).filter((g) => g !== u.group_id)];
  }
  return users;
}

class User extends CrudModel {
  static modelName = 'users';

  // Override create to hash password
  static async create(data) {
    // a new user signs in : its sign-in is blocked by setBlocked alone
    delete data.blocked;
    // nor has it signed in yet : its latest sign-in is written by recordSignIn alone
    delete data.last_login;
    logger.info(`Creating user ${data.username}`);
    // Hash password before storing
    const hash = await crypto.hashPassword(data.password);
    data.password = hash;
    return super.create(this.modelName, data);
  }

  // Override update to conditionally hash password
  static async update(data, id) {
    logger.info(`Updating user ${data.username ? data.username : id}`);
    // its sign-in is blocked or allowed by setBlocked alone (its own route, its own checks)
    delete data.blocked;
    // its latest sign-in is written by recordSignIn alone, never by an edit
    delete data.last_login;
    // the admin user keeps its name : renamed, it would no longer be the account to sign in with
    if (data.username !== undefined && data.username !== 'admin') {
      const current = await super.findById(this.modelName, id);
      if (current && current.username === 'admin') {
        throw new Error("You cannot rename user 'admin'");
      }
    }
    // the API shows the password masked : sent back, it means "keep the current one" as well
    if (typeof data.password === 'string' && /^\*{8,}$/.test(data.password)) delete data.password;
    // An empty password means "keep the current one" ; an empty description or email is a value
    // (one cleared on the user's page), stored empty. Any other empty field is left out.
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (key === 'description' || key === 'email') {
        if (value === null || value === undefined) data[key] = '';
        continue;
      }
      if (value === undefined || value === null || value === '') delete data[key];
    }
    // nothing left to change : nothing to write (an empty update is not a valid query)
    if (Object.keys(data).length === 0) return { changed: false };

    // Hash password if provided
    if (data.password) {
      logger.info(`Updating user with password ${data.username ? data.username : id}`);
      const hash = await crypto.hashPassword(data.password);
      data.password = hash;
    }
    
    return super.update(this.modelName, data, id);
  }

  // Override delete to cleanup tokens
  static async delete(id) {
    logger.info(`Deleting user ${id}`);
    // Get user to find username (will throw NotFoundError if not exists)
    const user = await super.findById(this.modelName, id);
    // the admin user is the way back in : never deleted, however the request comes
    if (user && user.username === 'admin') {
      throw new Error("You cannot delete user 'admin'");
    }
    // Delete all tokens for this user
    await Token.deleteAllForUser(user.username);
    return super.delete(this.modelName, id);
  }

  static async findAll() {
    return withGroupIds(await super.findAll(this.modelName));
  }

  /**
   * Blocks or allows a local user's sign-in.
   *
   * Args:
   *   id (number): the user.
   *   blocked (boolean): true to block.
   *
   * Returns:
   *   Promise<void>: settles once written.
   */
  static async setBlocked(id, blocked) {
    await mysql.do('UPDATE AnsibleForms.`users` SET blocked = ? WHERE id = ?', [blocked ? 1 : 0, id]);
  }

  /**
   * Whether an admin blocked a local user's sign-in.
   *
   * Args:
   *   username (string): the username.
   *
   * Returns:
   *   Promise<boolean>: true when blocked.
   */
  static async isBlocked(username) {
    const rows = await mysql.do('SELECT blocked FROM AnsibleForms.`users` WHERE username = ?', [username]);
    return !!rows?.[0]?.blocked;
  }

  /**
   * Records a local user's sign-in : its latest sign-in is now.
   *
   * Args:
   *   username (string): the username.
   *
   * Returns:
   *   Promise<void>: settles once written.
   */
  static async recordSignIn(username) {
    await mysql.do('UPDATE AnsibleForms.`users` SET last_login = NOW() WHERE username = ?', [username]);
  }

  static async findById(id) {
    const [user] = await withGroupIds([await super.findById(this.modelName, id)]);
    return user;
  }

  /**
   * Adds a group to a user, besides the ones it has.
   *
   * Args:
   *   id (number): the user.
   *   groupId (number): the group.
   *
   * Raises:
   *   Error: the user is in that group already.
   */
  static async addGroup(id, groupId) {
    const [user] = await withGroupIds([await super.findById(this.modelName, id)]);
    const gid = parseInt(groupId, 10);
    if (user.group_ids.includes(gid)) throw new Error("The user is in that group already");
    logger.info(`Adding user ${user.username} to group ${gid}`);
    await mysql.do("INSERT INTO AnsibleForms.`user_groups` (user_id, group_id) VALUES (?, ?)", [user.id, gid]);
  }

  /**
   * Removes a group from a user. Its first group (users.group_id) gives way to another of its
   * groups, which takes its place ; a user keeps at least one group.
   *
   * Args:
   *   id (number): the user.
   *   groupId (number): the group.
   *
   * Raises:
   *   Error: it is the user's only group, or the user is not in it.
   */
  static async removeGroup(id, groupId) {
    const [user] = await withGroupIds([await super.findById(this.modelName, id)]);
    const gid = parseInt(groupId, 10);
    if (!user.group_ids.includes(gid)) throw new Error("The user is not in that group");
    if (user.group_ids.length === 1) throw new Error("A user keeps at least one group");
    logger.info(`Removing user ${user.username} from group ${gid}`);
    if (user.group_id === gid) {
      // the next group becomes its first, and leaves the other groups
      const next = user.group_ids.find((g) => g !== gid);
      await mysql.do("UPDATE AnsibleForms.`users` SET group_id=? WHERE id=?", [next, user.id]);
      await mysql.do("DELETE FROM AnsibleForms.`user_groups` WHERE user_id=? AND group_id=?", [user.id, next]);
    } else {
      await mysql.do("DELETE FROM AnsibleForms.`user_groups` WHERE user_id=? AND group_id=?", [user.id, gid]);
    }
  }

  static async findByUsername(username) {
    // username is the natural key
    return super.findByName(this.modelName, username);
  }

  // Additional methods (not CRUD operations)

  static authenticate(username, password) {
    logger.info(`Checking password for user ${username}`);
    // every group of the user : its first (users.group_id) and the others (user_groups)
    var query = "SELECT users.*,(SELECT GROUP_CONCAT(g.name) FROM AnsibleForms.`groups` g WHERE g.id=users.group_id OR g.id IN (SELECT ug.group_id FROM AnsibleForms.`user_groups` ug WHERE ug.user_id=users.id)) `groups` FROM AnsibleForms.`users` WHERE username=?;";
    return mysql.do(query, username).then((res) => {
      if (res.length > 0 && res[0].password) {
        return crypto.checkPassword(password, res[0].password, res[0]);
      } else {
        // as long as a wrong password : the timing does not tell which names exist
        return crypto.checkNoPassword(password).then(() => { throw `User ${username} not found`; });
      }
    });
  }

  /**
   * The names of a local user's groups : its first (users.group_id) and the others
   * (user_groups), as authenticate reads them at sign-in. The token no longer carries them
   * (lib/userGroups.js).
   *
   * Args:
   *   username (string): the username.
   *
   * Returns:
   *   Promise<string|null>: the names, comma separated ("" for none) ; null when there is no
   *     such user.
   */
  static async groupNames(username) {
    const rows = await mysql.do(
      "SELECT (SELECT GROUP_CONCAT(g.name) FROM AnsibleForms.`groups` g WHERE g.id=users.group_id OR g.id IN (SELECT ug.group_id FROM AnsibleForms.`user_groups` ug WHERE ug.user_id=users.id)) `groups` FROM AnsibleForms.`users` WHERE username=?;",
      [username],
    );
    if (!rows?.length) return null;
    return rows[0].groups || "";
  }

  static async getRolesAndOptions(groups, user) {
  var result = {};
  var roles = [];
  var options = {};
  var full_username = `${user.type}/${user.username}`;

  // 'showExtravars' and 'showExtraVars' are the same permission spelled two ways :
  // the json schema and the roles editor write the lowercase 'v', the documentation
  // and the client both use the capital 'V'. Neither spelling may be normalized
  // away (both exist in the wild), so mirror one agreed value onto both keys. False
  // wins, exactly like addRoleAndOptions ANDs an option across the roles a user
  // matches - otherwise turning the option off in one spelling is undone by the
  // other spelling defaulting to true (which made the roles editor's Show Extravars
  // switch have no effect at all). Absent stays absent : with no opinion in either
  // spelling nothing is written, so the defaults below still apply.
  const collapseExtravars = function (opts) {
    if (opts.showExtravars === undefined && opts.showExtraVars === undefined) return;
    const value = (opts.showExtravars === false || opts.showExtraVars === false)
      ? false
      : (opts.showExtravars !== undefined ? opts.showExtravars : opts.showExtraVars);
    opts.showExtravars = value;
    opts.showExtraVars = value;
  }

  const addRoleAndOptions = function (role) {
    if (!roles.includes(role.name)) {
      roles.push(role.name);
    }
    if (role.options) {
      for (const [key, value] of Object.entries(role.options)) {
        logger.debug(`Adding option ${key} = ${value}`);
        if (options[key] === undefined) {
          options[key] = value;
        } else {
          options[key] = options[key] && value;
        }
      }
    }
  }

  logger.debug(`Getting roles and options for ${full_username}`);

  try {
    const baseConfig = await Form.load(null, null, null, true);
    // derive roles from forms
    baseConfig.roles.forEach(function (role) {

      // the role's members as they are matched : entraid/<name> is azuread/<name> (memberRef)
      const users = memberRefs(role.users);
      const roleGroups = memberRefs(role.groups);

      // if we match the user, we add the role
      if(users.includes(full_username)){
        addRoleAndOptions(role);
      }

      // if the role matches one of the user's groups, we add the role
      groups.forEach(function (group) {
        if (roleGroups.includes(group)) {
          addRoleAndOptions(role);
        }
      });
    });

    // Collapse the two extravars spellings BEFORE the default merge : that merge
    // only fills options nobody has an opinion about, and it can only see that
    // through the key it is looking at. With mixed spellings (default role
    // 'showExtravars: false', the user's own role 'showExtraVars: true') the default
    // value used to land on the untouched lowercase key and the collapse then
    // pulled the explicit 'true' down with it - the default role overruling the
    // user's own roles, which is exactly what "we don't overwrite" forbids.
    collapseExtravars(options);

    // every user has the default role, and public its old name : a form listing either matches
    logger.debug(`Adding the default role to ${full_username}`);
    for (const name of EVERYONE_ROLES) if (!roles.includes(name)) roles.push(name);
    // its options are everyone's defaults : they fill what none of the user's own roles set, they
    // never overwrite
    const everyone = everyoneEntry(baseConfig.roles);
    if (everyone?.options) {
      for (const [key, value] of Object.entries(everyone.options)) {
        if (options[key] === undefined) {
          logger.debug(`Adding default option ${key} = ${value}`);
          options[key] = value;
        }
      }
    }

    result.roles = roles;
    result.options = options;

    // and once more after the merge, for the case where ONLY the default role has
    // an opinion : it may have written a single spelling, which must still apply
    // to both before the defaults below fill the other one with true
    collapseExtravars(options);

    // Apply defaults for undefined options
    applyOptionDefaults(options, roles.includes("admin"));

    return result;
  } catch (e) {
    logger.error(e);
    // return temp role if needed
    if (groups.includes("local/admins")) {
      roles.push("admin");
    }
    // MUST be the same shape as the success path. Every caller does
    // `user.roles = ro.roles; user.options = ro.options` (auth_basic.js and both login
    // controllers), so returning the bare array left BOTH undefined - and the very next
    // line, hasValidLoginOption, dereferences user.options.allowLogin. That throws
    // inside passport's req.login callback, which discards the returned promise, so the
    // surrounding try/catch never sees it and NO RESPONSE IS EVER SENT: every local and
    // ldap login hung for ever, leaking a socket each time. This branch is reached
    // whenever Form.load throws - a yaml syntax error in config.yaml is enough - so a
    // bad config took the whole login page down instead of degrading.
    //
    // It also made the local/admins emergency fallback above dead code: the caller
    // discarded the roles it carefully pushed 'admin' into.
    return { roles, options: applyOptionDefaults({}, roles.includes("admin")) };
  }
}

static getGroups(user, groupObj, ldapConfig = {}) {
  var group = "";
  var groups = [];

  // ldap type
  if (user.type == "ldap" && ldapConfig.groups_attribute) {
    if (groupObj[ldapConfig.groups_attribute]) {
      // get the memberOf field, force to array
      var ldapgroups = [].concat(groupObj[ldapConfig.groups_attribute]);
      //logger.debug(`LDAP Groups = ${ldapgroups}`)
      // loop ldap groups
      ldapgroups.forEach(function (v) {
        // grab groupname part
        // logger.debug(JSON.stringify(v))
        var groupObject = v["objectName"] || v; // https://github.com/ansibleforms/ansibleforms/issues/119 first try objectName and then fall back.  Different flavours of ldap servers return different group objects.  Until someone else hit's another flavour, these are the ones we implement.
        var groupMatch = groupObject.match("^[cCnN]{2}=([^,]*)");
        if (groupMatch.length > 0) {
          groups.push(groupMatch[1]);
        }
      });
    }
    // The optional group filter, applied on the bare name and BEFORE the ldap/ prefix, so
    // the pattern an admin writes here is the same one they would write for Entra ID or
    // OIDC (login.vue filters those before the server prefixes them too). A directory user
    // in a hundred AD groups otherwise carries all hundred through every role lookup, every
    // token and every job. A group of a directory other than the default one carries its
    // name : ldap/corp/Admins (Ldap.qualify).
    return helpers.filterGroups(groups, ldapConfig.groupfilter).map((g) => "ldap/" + Ldap.qualify(ldapConfig, g));
  } else if (user.type == "local") {
    var localgroups = groupObj.split(",");
    localgroups.forEach(function (v) {
      group = "local/" + v;
      // add all the roles that match the group
      groups.push(group);
    });
    return groups;
  } else {
    return groups;
  }
}

static checkLdap(username, password) {
  // across the directories, the first that knows the user deciding (Ldap.signIn) : resolves
  // { directory, entry }
  return Ldap.signIn(username, password)
    .catch((err) => {
      var em;
      if (err.message) {
        em = err.message;
      } else {
        try {
          em = yaml.stringify(err);
        } catch (e) {
          em = err;
        }
      }

      if (err.admin) {
        if (err.admin.code) {
          em = err.admin.code;
          if (err.admin.code == "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
            em = "Unable to verify the certificate";
          }
          if (err.admin.code == 49) {
            em = "Wrong binding credentials";
          }
        }
      }
      logger.error("Error connecting to ldap: " + em);
      throw "Ldap: " + em;
    });
  }
}

export default User;
