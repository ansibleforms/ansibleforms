'use strict';
import logger from "../lib/logger.js";
import mysql from "./db.model.js";
import helpers from "../lib/common.js";
import yaml from "yaml";
import crypto from "../lib/crypto.js";
import { authenticate } from 'ldap-authentication';
import { DEFAULT_NAME, NAME_RULE, qualify, route, isUnreachable, urls, setDirectoryNames } from '../lib/ldapDirectories.js';
import Credential from './credential.model.v2.js';
import Errors from '../lib/errors.js';
import { moveOneStep } from './listOrder.js';

//ldap object create
var Ldap=function(ldap){
    // the directory : its name (DEFAULT_NAME keeps the short member names), the order a bare
    // username is looked up in, and the sign-in domains that go straight to it
    if (ldap.name !== undefined) this.name = String(ldap.name).trim();
    if (ldap.position !== undefined && ldap.position !== "") this.position = parseInt(ldap.position, 10) || 1;
    if (ldap.domains !== undefined) this.domains = ldap.domains || "";
    // what it is, for the list and its page
    if (ldap.description !== undefined) this.description = ldap.description || "";
    this.server = ldap.server;
    this.port = ldap.port;
    this.ignore_certs = (ldap.ignore_certs)?1:0;
    this.enable_tls = (ldap.enable_tls)?1:0;
    this.cert = ldap.cert;
    this.ca_bundle = ldap.ca_bundle;
    this.bind_user_dn = ldap.bind_user_dn;
    // a credential of Connections > Credentials to bind with instead (Ldap.bindAccount)
    if (ldap.credential !== undefined) this.credential = ldap.credential || "";
    // Handle bind_user_pw: undefined = don't update, "" = clear password, "value" = encrypt
    if (ldap.bind_user_pw !== undefined) {
        if (ldap.bind_user_pw === "") {
            this.bind_user_pw = "";
        } else {
            this.bind_user_pw = crypto.encrypt(ldap.bind_user_pw);
        }
    }
    this.search_base = ldap.search_base;
    this.username_attribute = ldap.username_attribute;
    this.groups_attribute = ldap.groups_attribute;
    this.enable = (ldap.enable)?1:0;
    this.groups_search_base = ldap.groups_search_base || ""
    this.group_class = ldap.group_class || ""
    this.group_member_attribute = ldap.group_member_attribute || ""
    this.group_member_user_attribute = ldap.group_member_user_attribute || ""
    this.groupfilter = ldap.groupfilter || ""
    this.mail_attribute = ldap.mail_attribute
    this.testpassword = ldap.testpassword || ""
    this.testuser = ldap.testuser || ""
};
// ─── the directories ──────────────────────────────────────────────────────────
// The directory whose members keep their short names (ldap/<group>, the bare username) : the
// one there was before several could be made. It cannot be renamed nor deleted.
Ldap.DEFAULT_NAME = DEFAULT_NAME;
// the pure rules (lib/ldapDirectories.js) : a member's qualified name, where a username is looked
// up, whether a failure is an unreachable server, a directory's server urls
Ldap.qualify = qualify;
Ldap.route = route;
Ldap.isUnreachable = isUnreachable;
Ldap.urls = urls;

/**
 * The fields a declaration gives (the config seed's ldap section, a repository's directory file),
 * converted as a save from the app converts them (the constructor : the yes or no flags, the bind
 * password encrypted) - only those it declares : the constructor materialises every field it
 * knows (an absent flag as 0, the group fields as ""), and writing that whole would blank what the
 * declaration never mentioned.
 *
 * Args:
 *   cfg (object): the declared fields.
 *
 * Returns:
 *   object: the fields to write.
 */
Ldap.declared = function (cfg) {
  const converted = { ...new Ldap(cfg) };
  const record = {};
  for (const key of Object.keys(converted)) {
    if (key === "testuser" || key === "testpassword") continue;
    if (cfg[key] === undefined || converted[key] === undefined) continue;
    record[key] = converted[key];
  }
  return record;
};

/**
 * A directory as stored, its bind password decrypted (an undecryptable one emptied).
 *
 * Args:
 *   row (object): the row.
 *
 * Returns:
 *   object: the directory.
 */
function decrypted(row) {
  if (!row) return row;
  try {
    row.bind_user_pw = crypto.decrypt(row.bind_user_pw);
  } catch (e) {
    logger.error(`Couldn't decrypt the binding password of ldap directory '${row.name}', did the secretkey change ?`);
    row.bind_user_pw = "";
  }
  return row;
}

/**
 * Checks the credential a directory names : one of Connections > Credentials, of type ldap. Its
 * servers and bind account are where the directory connects and as whom, so a credential of
 * another kind (a runner's token, a database login) is never handed to an LDAP server - not by a
 * save, not by a test (controllers/v2/ldapDirectory.controller.js check).
 *
 * Args:
 *   name (string): the credential's name ; none, nothing to check.
 *
 * Raises:
 *   Errors.BadRequestError: no such credential, or another type.
 */
Ldap.checkCredential = async function (name) {
  if (!name) return;
  const rows = await mysql.do("SELECT credential_type FROM AnsibleForms.`credentials` WHERE name = ?", [name]);
  if (!rows.length) throw new Errors.BadRequestError(`No credential named '${name}'`);
  if (rows[0].credential_type !== "ldap") throw new Errors.BadRequestError(`An LDAP directory needs an ldap credential: '${name}' is not one`);
};

/**
 * Checks a directory's name : the rule, and DEFAULT_NAME ('main') reserved for the first one.
 *
 * Args:
 *   name (string): the name.
 *   current (object): the directory renamed, or none for a new one.
 *
 * Raises:
 *   Errors.BadRequestError: the name breaks the rule, is taken, or renames the default directory.
 */
async function checkName(name, current) {
  if (current && current.name === Ldap.DEFAULT_NAME && name !== Ldap.DEFAULT_NAME) {
    throw new Errors.BadRequestError(`The directory '${Ldap.DEFAULT_NAME}' keeps its name: its members' names depend on it`);
  }
  if (!NAME_RULE.test(name || "")) {
    throw new Errors.BadRequestError("A directory's name has letters, digits, - and _ only (at most 50)");
  }
  if ((!current || current.name !== Ldap.DEFAULT_NAME) && name.toLowerCase() === Ldap.DEFAULT_NAME) {
    throw new Errors.BadRequestError(`'${Ldap.DEFAULT_NAME}' is the name of the first directory`);
  }
  const taken = await mysql.do("SELECT id FROM AnsibleForms.`ldap` WHERE name = ? AND id <> ?", [name, current?.id ?? 0]);
  if (taken.length) throw new Errors.BadRequestError(`There is already a directory named '${name}'`);
}

/**
 * The directories, in the order a bare username is looked up in.
 *
 * Returns:
 *   object[]: the directories, their bind passwords decrypted.
 */
Ldap.findAll = async function () {
  const rows = await mysql.do("SELECT * FROM AnsibleForms.`ldap` ORDER BY position, id");
  // the names qualify compares a default directory's name with (lib/ldapDirectories.js)
  setDirectoryNames(rows.map((r) => r.name));
  return rows.map(decrypted);
};

/**
 * Reads the directories' names again for qualify, after a directory was added, renamed or
 * deleted. A failure only leaves the names as they were : the next sign-in reads them anyway.
 *
 * Returns:
 *   Promise<void>
 */
async function refreshDirectoryNames() {
  try {
    const rows = await mysql.do("SELECT name FROM AnsibleForms.`ldap`");
    setDirectoryNames(rows.map((r) => r.name));
  } catch (e) {
    logger.warning(`Couldn't read the ldap directory names: ${e.message || e}`);
  }
}

/**
 * A directory by its id.
 *
 * Args:
 *   id (number|string): the id.
 *
 * Returns:
 *   object|null: the directory, its bind password decrypted ; null when there is none.
 */
Ldap.findById = async function (id) {
  const rows = await mysql.do("SELECT * FROM AnsibleForms.`ldap` WHERE id = ?", [id]);
  return rows.length ? decrypted(rows[0]) : null;
};

/**
 * The default directory : the one named DEFAULT_NAME, else the first (a database not patched
 * yet has one row and no names).
 *
 * Returns:
 *   object: the directory, its bind password decrypted.
 *
 * Raises:
 *   string: there is no directory at all.
 */
Ldap.find = async function () {
  const rows = await Ldap.findAll().catch(async () => (await mysql.do("SELECT * FROM AnsibleForms.`ldap` limit 1;")).map(decrypted));
  const found = rows.find((r) => r.name === Ldap.DEFAULT_NAME) || rows[0];
  if (found) return found;
  logger.error("No ldap record in the database, something is wrong");
  throw "No ldap record in the database, something is wrong";
};

/**
 * Updates the default directory (the config seed's ldap section, the API's /ldap).
 *
 * Args:
 *   record (object): the fields to write, converted (new Ldap).
 *   opts (object): as updateById's ({ fromSeed : the config seed's }).
 */
Ldap.update = async function (record, opts = {}) {
  const current = await Ldap.find();
  return Ldap.updateById(current.id, record, opts);
};

/**
 * Updates a directory.
 *
 * Args:
 *   id (number|string): the directory.
 *   record (object): the fields to write, converted (new Ldap).
 *   opts (object): { fromRepo (its repository's pull), fromSeed (the config seed's) } ; none : an
 *     edit in the app, refused when git would undo it (lib/repoObjects/engine.js assertAppEdit).
 *
 * Raises:
 *   Errors.NotFoundError: no such directory.
 *   Errors.BadRequestError: its new name or its credential is not valid.
 *   Errors.ConflictError: an edit in the app git would undo (its bind password taken from an
 *     environment variable, its entry gone or renamed in git).
 */
Ldap.updateById = async function (id, record, opts = {}) {
  const current = await Ldap.findById(id);
  if (!current) throw new Errors.NotFoundError(`No ldap directory ${id}`);
  // an edit in the app of a repository's directory that git would undo : refused before anything is
  // written, its bind password compared as the rows hold it (decrypted)
  if (!opts.fromRepo && !opts.fromSeed) {
    const { assertAppEdit } = await import("../lib/repoObjects/engine.js");
    const plain = record.bind_user_pw ? { ...record, bind_user_pw: crypto.decrypt(record.bind_user_pw) } : record;
    await assertAppEdit("ldap", id, plain);
  }
  // the test fields and the id are never columns to write
  delete record.testuser;
  delete record.testpassword;
  delete record.id;
  if (record.name !== undefined) await checkName(record.name, current);
  if (record.credential !== undefined) await Ldap.checkCredential(record.credential);
  logger.info(`Updating ldap directory '${current.name}'`);
  const res = await mysql.do("UPDATE AnsibleForms.`ldap` set ? WHERE id = ?", [record, id]);
  if (record.name !== undefined) await refreshDirectoryNames();
  return res;
};

/**
 * Adds a directory, last in the lookup order unless it says its own (one a repository's file
 * makes : its place is the one its file says, else its column's).
 *
 * Args:
 *   record (object): the fields, converted (new Ldap).
 *   opts (object): { fromRepo (true : a repository's file makes it, lib/repoObjects) }.
 *
 * Returns:
 *   number: its id.
 *
 * Raises:
 *   Errors.BadRequestError: its name is not valid or taken, its credential is not an ldap one, or
 *     it has no servers.
 */
Ldap.create = async function (record, opts = {}) {
  delete record.testuser;
  delete record.testpassword;
  delete record.id;
  await checkName(record.name);
  await Ldap.checkCredential(record.credential);
  // where it connects : its credential's servers (its own, from before, only for the config seed
  // and the API of before)
  if (!String(record.server || "").trim() && !(await Ldap.connectionOf(record.credential))) {
    throw new Errors.BadRequestError("An LDAP directory needs an ldap credential with its servers (host)");
  }
  if (!record.position && !opts.fromRepo) {
    const last = await mysql.do("SELECT COALESCE(MAX(position), 0) AS p FROM AnsibleForms.`ldap`");
    record.position = (last[0]?.p || 0) + 1;
  }
  logger.info(`Adding ldap directory '${record.name}'`);
  const res = await mysql.do("INSERT INTO AnsibleForms.`ldap` set ?", record);
  await refreshDirectoryNames();
  return res.insertId;
};

/**
 * Moves a directory one place up or down in the lookup order (the list's order), the others
 * renumbered 1, 2, 3 ... with it.
 *
 * Args:
 *   id (number|string): the directory.
 *   direction (string): 'up' (looked up sooner) or 'down'.
 *
 * Returns:
 *   boolean: false when it is already first (up) or last (down) : nothing moved.
 *
 * Raises:
 *   Errors.BadRequestError: another direction.
 *   Errors.NotFoundError: no such directory.
 */
Ldap.move = async function (id, direction) {
  // the one rule of the ordered lists (models/listOrder.js), as the labels' : renumbered in one
  // transaction, never by halves
  const rows = await mysql.do("SELECT id FROM AnsibleForms.`ldap` ORDER BY position, id");
  return moveOneStep("ldap", rows, id, direction, "directory");
};

/**
 * Deletes a directory ; never the default one.
 *
 * Args:
 *   id (number|string): the directory.
 *
 * Raises:
 *   Errors.NotFoundError: no such directory.
 *   Errors.BadRequestError: it is the default one.
 *   Errors.AccessDeniedError: it is the config seed's.
 */
Ldap.deleteById = async function (id) {
  const current = await Ldap.findById(id);
  if (!current) throw new Errors.NotFoundError(`No ldap directory ${id}`);
  if (current.name === Ldap.DEFAULT_NAME) throw new Errors.BadRequestError(`The directory '${Ldap.DEFAULT_NAME}' cannot be deleted: turn it off instead`);
  if (current.managed) throw new Errors.AccessDeniedError("This directory comes from the config seed");
  logger.info(`Deleting ldap directory '${current.name}'`);
  const res = await mysql.do("DELETE FROM AnsibleForms.`ldap` WHERE id = ?", [id]);
  await refreshDirectoryNames();
  return res;
};

// Does an ldap-authentication failure mean 'the search found no such user' ?
// authenticate() throws ONLY the last message of the failed result, and we always
// call it in admin mode (no userDn, no verifyUserExists) : there a user search
// that finds nothing yields 'Authentication identity not found'. The older
// 'user not found or usernameAttribute is wrong' text only comes from the
// verifyUserExists path and is matched as well, so both library paths keep
// working. A wrong password yields the invalid-credentials message (the
// directory's own bind error) and must NEVER match : the UPN retry may only fire
// on a missing user, or it would double the bind attempts and, with it, the
// directory's lockout counter.
Ldap.isUserNotFound = function(message){
  return /authentication identity not found|user not found or usernameAttribute is wrong/i.test(message || "")
}
/**
 * The ldap-authentication options of a directory for a user, without the server (Ldap.urls).
 *
 * Args:
 *   cfg (object): the directory.
 *   bindPassword (string): the bind user's password, in clear.
 *   username (string): the user, as the directory knows it.
 *   password (string): the user's password.
 *
 * Returns:
 *   object: the options.
 *
 * Raises:
 *   Error: the TLS certificates are not valid.
 */
function authOptions(cfg, bindPassword, username, password) {
  const options = {
    ldapOpts: { tlsOptions: {} },
    adminDn: cfg.bind_user_dn,
    adminPassword: bindPassword,
    userPassword: password,
    userSearchBase: cfg.search_base,
    usernameAttribute: cfg.username_attribute,
    username,
  };
  // every attribute of the entry, and its groups' by name : an operational attribute (OpenLDAP's
  // memberOf) is only returned when asked for ; Active Directory returns it either way
  if (cfg.groups_attribute) options.attributes = ["*", cfg.groups_attribute];
  if (cfg.groups_search_base) options.groupsSearchBase = cfg.groups_search_base;
  if (cfg.group_class) options.groupClass = cfg.group_class;
  if (cfg.group_member_attribute) options.groupMemberAttribute = cfg.group_member_attribute;
  if (cfg.group_member_user_attribute) options.groupMemberUserAttribute = cfg.group_member_user_attribute;
  if (cfg.enable_tls == 1) {
    const verify = !(cfg.ignore_certs == 1);
    // ldap-authentication checks certificates badly : they are checked first
    if (verify && (!helpers.checkCertificate(cfg.cert) || !helpers.checkCertificate(cfg.ca_bundle))) {
      throw new Error("Certificate is not valid");
    }
    options.ldapOpts.tlsOptions.requestCert = true;
    if (verify && cfg.cert) options.ldapOpts.tlsOptions.cert = cfg.cert;
    if (verify && cfg.ca_bundle) options.ldapOpts.tlsOptions.ca = cfg.ca_bundle;
    options.ldapOpts.tlsOptions.rejectUnauthorized = verify;
  }
  return options;
}

/**
 * Where a credential connects an LDAP directory : its servers (host, in failover order), port,
 * TLS, whether certificates are checked, the client certificate and the CA bundle. None for a
 * credential without servers (one from before credentials held them).
 *
 * Args:
 *   name (string): the credential's name.
 *
 * Returns:
 *   Promise<object|null>: { server, port, enable_tls, ignore_certs, cert, ca_bundle }, or null.
 */
Ldap.connectionOf = async function (name) {
  if (!name) return null;
  const rows = await mysql.do(
    "SELECT host, port, secure, ignore_certs, client_cert, ca_bundle FROM AnsibleForms.`credentials` WHERE name = ?",
    [name],
  );
  const c = rows[0];
  if (!c || !String(c.host || "").trim()) return null;
  return {
    server: String(c.host).trim(),
    port: c.port || null,
    enable_tls: c.secure ? 1 : 0,
    ignore_certs: c.ignore_certs ? 1 : 0,
    cert: c.client_cert || null,
    ca_bundle: c.ca_bundle || null,
  };
};

/**
 * A directory as it connects : its credential's servers, port, TLS and certificates (the
 * credential holds where and as whom), else its own (from before credentials held them).
 *
 * Args:
 *   cfg (object): the directory.
 *
 * Returns:
 *   Promise<object>: a copy, its connection its credential's when it has one.
 */
Ldap.withConnection = async function (cfg) {
  const connection = await Ldap.connectionOf(cfg?.credential).catch(() => null);
  return connection ? { ...cfg, ...connection } : cfg;
};

/**
 * The account a directory binds with : the credential it names (Connections > Credentials, read
 * from its secret store when it has one), else its own bind user and password.
 *
 * Args:
 *   cfg (object): the directory.
 *   ownPassword (string): its own bind password, in clear.
 *
 * Returns:
 *   object: { dn, password } : the bind user and its password, in clear.
 *
 * Raises:
 *   Error: the credential it names is not found or has no user.
 */
Ldap.bindAccount = async function (cfg, ownPassword) {
  if (!cfg.credential) return { dn: cfg.bind_user_dn, password: ownPassword };
  const cred = await Credential.resolveByName(cfg.credential);
  if (!cred || !cred.user) {
    throw new Error(`The ldap directory '${cfg.name}' uses the credential '${cfg.credential}', which is not found`);
  }
  return { dn: cred.user, password: cred.password };
};

/**
 * A user's sign-in on one directory : its servers in order, the next one only when one cannot be
 * reached ; a user@domain the directory does not know is tried again as the bare name (never on a
 * wrong password, which would count twice against the directory's lockout).
 *
 * Args:
 *   cfg (object): the directory.
 *   bindPassword (string): the bind user's password, in clear.
 *   username (string): the user.
 *   password (string): the user's password.
 *
 * Returns:
 *   object: the user's directory entry.
 *
 * Raises:
 *   any: the directory's answer (a wrong password, no such user), or the last server's failure.
 */
Ldap.authenticateOn = async function (directory, bindPassword, username, password) {
  // where it connects : its credential's servers and TLS, else its own
  const cfg = await Ldap.withConnection(directory);
  const servers = Ldap.urls(cfg);
  if (!servers.length) throw new Error(`The ldap directory '${cfg.name}' has no server`);
  // its credential's account, else its own
  const account = await Ldap.bindAccount(cfg, bindPassword);
  const base = authOptions({ ...cfg, bind_user_dn: account.dn }, account.password, username, password);
  let last;
  for (const url of servers) {
    const options = { ...base, ldapOpts: { ...base.ldapOpts, url } };
    try {
      try {
        return await authenticate(options);
      } catch (err) {
        const local = String(username).includes("@") ? String(username).split("@")[0] : "";
        if (local && Ldap.isUserNotFound(err?.message)) {
          logger.info(`Ldap user '${username}' not found in '${cfg.name}', retrying as '${local}'`);
          return await authenticate({ ...options, username: local });
        }
        throw err;
      }
    } catch (err) {
      if (!Ldap.isUnreachable(err)) throw err;
      logger.warning(`Ldap server ${url} of '${cfg.name}' cannot be reached: ${err?.message || err?.admin?.code || err}`);
      last = err;
    }
  }
  throw last;
};

/**
 * A user's sign-in across the directories (Ldap.route) : the first directory that knows the user
 * decides - a wrong password there is the answer, never a try in the next one, which might hold
 * someone else of that name. A directory that cannot be reached is passed over.
 *
 * Args:
 *   username (string): what was typed.
 *   password (string): the password.
 *
 * Returns:
 *   object: { directory, entry } : the directory that signed the user in and the user's entry.
 *
 * Raises:
 *   string: no directory is enabled.
 *   any: the deciding directory's answer, or the last failure.
 */
Ldap.signIn = async function (username, password) {
  const enabled = (await Ldap.findAll()).filter((d) => d.enable == 1);
  if (!enabled.length) throw "No ldap configured or not enabled";
  let last;
  for (const { directory, username: asked } of Ldap.route(username, enabled)) {
    try {
      logger.info(`Checking ldap directory '${directory.name}' for user ${asked}`);
      const entry = await Ldap.authenticateOn(directory, directory.bind_user_pw, asked, password);
      return { directory, entry };
    } catch (err) {
      last = err;
      if (Ldap.isUserNotFound(err?.message) || Ldap.isUnreachable(err)) continue;
      throw err;
    }
  }
  throw last;
};

/**
 * A directory's test (its page's Test connection) : a sign-in of the test user, on its servers in
 * order. A test user it does not know still proves the connection and the binding.
 *
 * Args:
 *   ldapConfig (object): the directory as converted (new Ldap : its bind password encrypted), with
 *     testuser and testpassword.
 *
 * Returns:
 *   object|undefined: the test user's entry ; none when the directory does not know the user.
 *
 * Raises:
 *   Error: why the directory could not be used, said plainly.
 */
Ldap.check = async function (ldapConfig) {
  try {
    logger.notice("Authenticating");
    // its own bind password only when it binds with it (not with a credential)
    const own = ldapConfig.credential ? "" : crypto.decrypt(ldapConfig.bind_user_pw);
    return await Ldap.authenticateOn(ldapConfig, own, ldapConfig.testuser, ldapConfig.testpassword);
  } catch (err) {
    let em;
    if (err?.message) {
      em = err.message;
    } else {
      try { em = yaml.stringify(err); } catch (e) { em = err; }
    }
    if (err?.admin) {
      if (err.admin.lde_message) {
        try { em = yaml.stringify(err.admin.lde_message); } catch (e) { em = err; }
      } else if (err.admin.code) {
        try { em = yaml.stringify(err.admin); } catch (e) { em = err; }
        if (err.admin.code == "UNABLE_TO_VERIFY_LEAF_SIGNATURE") em = "Unable to verify the certificate";
        else if (err.admin.code == 49) em = "Wrong binding credentials";
        else if (err.admin.code == "ENOTFOUND") em = "Bad server or port (connection failed)";
      }
    }
    if (Ldap.isUserNotFound(em)) {
      logger.notice("Checking ldap connection ok");
      return;
    }
    logger.notice("Checking ldap connection result: " + em);
    throw new Error(em, { cause: err });
  }
};

export default  Ldap;
