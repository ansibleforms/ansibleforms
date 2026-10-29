// PATCHING : Drop a table from the schema
function dropTable(table) {
  var message;
  var db = "AnsibleForms";
  var checksql = "SHOW TABLES FROM ?? WHERE ?? = ?";
  var sql = "DROP TABLE IF EXISTS ??.??";
  logger.debug(`dropping table '${table}'`);
  return mysql
    .do(checksql, [db, `Tables_in_${db}`, table])
    .then((checkres) => {
      if (checkres.length > 0) {
        return mysql.do(sql, [db, table]);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Table '${table}' is already absent`;
        logger.debug(message);
        return message;
      }
      message = `Dropped table '${table}'`;
      logger.warning(message);
      return message;
    });
}
"use strict";
import { DEFAULT_NAME as DEFAULT_LDAP, LEGACY_DEFAULT_NAME as LEGACY_DEFAULT_LDAP } from "../lib/ldapDirectories.js";
import logger from "../lib/logger.js";
import mysql from "./db.model.js";
import appConfig from "../../config/app.config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import init from "../init/index.js";
import { holdsWorkerLock } from "../lib/workerLock.js";
import { appVersion } from "../lib/version.js";
import { missingFromManifest } from "../lib/schemaCompleteness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

//user object create
class Schema {
  constructor() { }

  /**
   * Cached result of the first successful schema check.
   * Schema/table existence is essentially static at runtime — once the
   * server has confirmed everything is present at boot, every subsequent
   * call (e.g. the public schema endpoint that the SPA hits on every page
   * load / hard refresh) should NOT re-run a flood of SHOW DATABASES /
   * SHOW TABLES queries (with debug logging) for no reason. We cache the
   * first OK result and return it directly. Failures are never cached.
   */
  static _cachedOk = null;

  // Checks the schema, and patches it - but only in the process holding the worker lock : any
  // other (an app node, or a second AF_ROLE unset process waiting for the lock) only checks, so
  // it never runs DDL next to the worker patching the same tables.
  static async hasSchema() {
    if (Schema._cachedOk) return Schema._cachedOk;
    // one check at a time in a process : a restore re-checks the schema (upgradeAfterRestore)
    // and its change notice asks again a few seconds later ; two runs side by side would patch
    // the same tables at once
    if (!Schema._running) {
      Schema._running = checkAll({ patch: holdsWorkerLock() }).finally(() => { Schema._running = null; });
    }
    const result = await Schema._running;
    Schema._cachedOk = result;
    return result;
  }

  // the check in progress, shared by every caller of hasSchema meanwhile
  static _running = null;

  /**
   * After a database restore : the schema that came back can be an older release's (the backup
   * taken before an upgrade), and the cached "everything is present" of before would keep this
   * release running on it. The cache goes, and the schema is checked and patched again here when
   * this process holds the worker lock ; otherwise the worker patches it on the restore's change
   * notice (init/cluster.js) and this waits up to waitMs for the schema manifest to be complete.
   *
   * Args:
   *   options (object): { waitMs } - how long an app node waits for the worker's patching.
   *
   * Returns:
   *   Promise<object>: { upgraded: true } when the schema is complete ; { upgraded: false,
   *     failed: string[] } when the patching failed (or the worker had not finished in time).
   */
  static async upgradeAfterRestore({ waitMs = 60000 } = {}) {
    Schema._cachedOk = null;
    // step 1 : the worker : check and patch it now
    if (holdsWorkerLock()) {
      try {
        await Schema.hasSchema();
        return { upgraded: true };
      } catch (err) {
        return { upgraded: false, failed: err.result?.data?.failed?.length ? err.result.data.failed : [err.message || String(err)] };
      }
    }
    // step 2 : an app node : the worker patches it, this waits for the manifest to be complete
    const until = Date.now() + waitMs;
    let missing;
    for (;;) {
      try {
        const m = await missingFromManifest(SCHEMA_MANIFEST, mysql);
        missing = [...m.missingTables, ...m.missingColumns];
      } catch (err) {
        missing = [`the schema could not be checked (${err.message || err})`];
      }
      if (!missing.length) return { upgraded: true };
      if (Date.now() >= until) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { upgraded: false, failed: [`the worker has not patched the restored schema yet, it lacks ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`] };
  }

  /**
   * Whether this database holds anything worth protecting : the schema exists,
   * the users table exists, and it holds at least one account. Until all three
   * are true there is simply nobody to authenticate as, which is what lets the
   * documented bootstrap (POST /api/v2/schema against an empty database) run
   * unauthenticated - see the guard in routes/v2/schema.routes.js.
   *
   * The empty-users case is a genuinely broken install : create_schema_and_tables
   * ran but init() never got to seed the admin. It is self-healing, because init
   * re-creates the admin user on every boot when it is missing, so it can not
   * stay open across a restart.
   *
   * Deliberately NOT cached (unlike hasSchema) : it flips exactly once, at the
   * end of that bootstrap, and a wrong cached 'false' would keep a destructive
   * endpoint open. Three cheap statements, on one endpoint.
   */
  static async isProvisioned() {
    const db = "AnsibleForms";
    const schema = await mysql.do("SHOW DATABASES LIKE ?", [db]);
    if (!schema || schema.length === 0) return false;
    const table = await mysql.do("SHOW TABLES FROM ?? WHERE ?? = ?", [db, `Tables_in_${db}`, "users"]);
    if (table.length === 0) return false;
    const count = await mysql.do("SELECT COUNT(*) AS total FROM ??.??", [db, "users"]);
    return (count[0]?.total || 0) > 0;
  }
  /**
   * Whether this database has no AnsibleForms tables at all : the schema is absent,
   * or it exists and is completely empty.
   *
   * This is the ONLY safe precondition for running create_schema_and_tables.sql
   * unattended, because that file DROPs all 16 tables before recreating them.
   *
   * It is deliberately much stricter than isProvisioned(), which answers a different
   * question ("is there anybody to authenticate as?") and returns false for a database
   * that is full of forms, jobs and audit history but happens to have an empty users
   * table. hasSchema() is stricter still in the wrong direction : it fails for a single
   * missing column or a patch that could not apply. Driving an automatic create from
   * either of those would destroy a live database to fix a cosmetic gap - so the
   * startup bootstrap asks this, and only this.
   */
  static async isEmpty() {
    const db = "AnsibleForms";
    const schema = await mysql.do("SHOW DATABASES LIKE ?", [db]);
    if (!schema || schema.length === 0) return true;
    const tables = await mysql.do("SHOW TABLES FROM ??", [db]);
    return !tables || tables.length === 0;
  }

  /**
   * Runs create_schema_and_tables.sql. DESTRUCTIVE : every table is dropped first.
   * Callers are responsible for establishing that this is allowed - the endpoint
   * checks isProvisioned(), the startup bootstrap checks isEmpty().
   */
  // `onlyIf` is checked again once the lock is held : the startup bootstrap creates only an
  // empty database, and another process may have created it while this one waited.
  static async createTables({ onlyIf } = {}) {
    if (!appConfig.allowSchemaCreation) {
      throw new Error(`Schema creation is disabled`);
    }
    // two processes never run the script at the same time : it drops every table first,
    // so the second would wipe what the first had just created
    return mysql.withLock("ansibleforms_schema", 120, async () => {
      if (onlyIf && !(await onlyIf())) return false;
      return Schema.runCreateScript();
    });
  }

  static async runCreateScript() {
    // added in 5.0.3
    const buffer = fs.readFileSync(`${__dirname}/../db/create_schema_and_tables.sql`);
    const query = buffer.toString();
    // Invalidate BEFORE running, not after. This file drops tables first, so a failure
    // part way through leaves the schema genuinely incomplete - and the throw used to
    // skip the invalidation, leaving an earlier cached "everything is present" live.
    // GET /api/v2/schema then kept reporting a healthy schema for a database that had
    // just lost tables, so nothing ever offered the repair.
    Schema._cachedOk = null;
    // runIsolated, not do() : this script disables FOREIGN_KEY_CHECKS and selects a
    // default schema, and a failure must not hand that session back to the pool.
    const res = await mysql.runIsolated(query);
    if (!res || res.length === 0) {
      throw new Error(`Failed to create schema 'AnsibleForms' and/or tables`);
    }
    logger.notice(`Created schema 'AnsibleForms' and tables`);
    return true;
  }

  static async create() {
    logger.notice(`Trying to create database schema 'AnsibleForms' and tables`);
    await Schema.createTables();
    // the bootstrap that follows (the admin account, the default rows, the seed) is the
    // worker's : run here when this process is the worker, otherwise the worker finds the
    // new schema on its next check (init/worker.js)
    if (holdsWorkerLock()) await init()
    return { message: `Created schema 'AnsibleForms' and tables` };
  }
}

// Check if the AnsibleForms schema exists
async function checkSchema() {
  var message;
  var db = "AnsibleForms";
  logger.debug("checking schema " + db);
  var res = await mysql.do("SHOW DATABASES LIKE ?", [db]);
  if (res) {
    if (res.length > 0) {
      message = `Schema '${db}' is present`;
      logger.debug(message);
      return message;
    } else {
      message = `Schema '${db}' is not present`;
      logger.warning(message);
      var err = new Error(message);
      err.result = { message: [message], data: { success: [], failed: [message] } };
      throw err;
    }
  }
}

// Check if a table exists
async function checkTable(table) {
  var message;
  var db = "AnsibleForms";
  logger.debug("checking table " + table);
  var sql = "SHOW TABLES FROM ?? WHERE ?? = ?";
  var res = await mysql.do(sql, [db, `Tables_in_${db}`, table]);

  if (res.length > 0) {
    message = `Table '${table}' is present`;
    logger.debug(message);
    return message;
  } else {
    message = `Table '${table}' is not present`;
    logger.warning(message);
    throw new Error(message);
  }
}
// PATCHING : whether a table exists (the awx table is gone once 7 moved it to runners)
async function tablePresent(table) {
  const res = await mysql.do("SHOW TABLES FROM ?? WHERE ?? = ?", ["AnsibleForms", "Tables_in_AnsibleForms", table]);
  return res.length > 0;
}
function addIdPrimaryKey(table) {
  var message;
  var db = "AnsibleForms";
  var checksql = "SHOW COLUMNS FROM ??.?? WHERE Field = ?";
  var sql = "ALTER TABLE ??.?? ADD COLUMN id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY";
  logger.debug(`adding id primary key column on table '${table}'`);
  return mysql
    .do(checksql, [db, table, 'id'])
    .then((checkres) => {
      if (checkres.length == 0) {
        return mysql.do(sql, [db, table]);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Column 'id' is already present on '${table}'`;
        logger.debug(message);
        return message;
      }
      message = `added id primary key column on '${table}'`;
      logger.warning(message);
      return message;
    });
}

function addUniqueKey(table, column) {
  var message;
  var db = "AnsibleForms";
  var indexName = `unique_${column}`;
  var checksql = "SHOW INDEX FROM ??.?? WHERE Key_name = ?";
  var sql = "ALTER TABLE ??.?? ADD UNIQUE KEY ?? (??)";
  logger.debug(`adding unique key '${indexName}' on column '${column}' in table '${table}'`);
  return mysql
    .do(checksql, [db, table, indexName])
    .then((checkres) => {
      if (checkres.length == 0) {
        return mysql.do(sql, [db, table, indexName, column]);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Unique key '${indexName}' is already present on '${table}'`;
        logger.debug(message);
        return message;
      }
      message = `added unique key '${indexName}' on '${table}'`;
      logger.warning(message);
      return message;
    });
}
// PATCHING : add a column to a table
function addColumn(table, name, fieldtype, nullable, defaultvalue) {
  var message;
  var db = "AnsibleForms";
  var checksql = "SHOW COLUMNS FROM ??.?? WHERE Field = ?";
  var sql = `ALTER TABLE ??.?? ADD COLUMN ?? ${fieldtype}`;
  if (!nullable) {
    sql += " NOT NULL";
  }
  if (defaultvalue) {
    sql += ` DEFAULT ${defaultvalue}`;
  }
  logger.debug(`adding column '${name}' on table '${table}'`);
  return mysql
    .do(checksql, [db, table, name])
    .then((checkres) => {
      if (checkres.length == 0) {
        return mysql.do(sql, [db, table, name]);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Column '${name}' is already present on '${table}'`;
        logger.debug(message);
        return message;
      }
      message = `added column '${name}' on '${table}'`;
      logger.warning(message);
      return message;
    });
}


// PATCHING : drop a column when it is still there (a column 7 no longer uses)
function dropColumn(table, name) {
  var db = "AnsibleForms";
  var checksql = "SHOW COLUMNS FROM ??.?? WHERE Field = ?";
  var sql = "ALTER TABLE ??.?? DROP COLUMN ??";
  logger.debug(`dropping column '${name}' on table '${table}'`);
  return mysql
    .do(checksql, [db, table, name])
    .then((checkres) => (checkres.length ? mysql.do(sql, [db, table, name]) : false))
    .then((res) => {
      if (!res) {
        const gone = `Column '${name}' is already gone from '${table}'`;
        logger.debug(gone);
        return gone;
      }
      const message = `dropped column '${name}' from '${table}'`;
      logger.warning(message);
      return message;
    });
}

// PATCHING : rename a column, keeping its data, when it still has its old name (and the new one
// is not there yet) : a second run finds it renamed and does nothing
function renameColumn(table, from, to, fieldtype) {
  var db = "AnsibleForms";
  var checksql = "SHOW COLUMNS FROM ??.?? WHERE Field IN (?, ?)";
  var sql = `ALTER TABLE ??.?? CHANGE COLUMN ?? ?? ${fieldtype}`;
  logger.debug(`renaming column '${from}' to '${to}' on table '${table}'`);
  return mysql
    .do(checksql, [db, table, from, to])
    .then((checkres) => {
      const names = checkres.map((c) => c.Field);
      return names.includes(from) && !names.includes(to) ? mysql.do(sql, [db, table, from, to]) : false;
    })
    .then((res) => {
      if (!res) {
        const done = `Column '${from}' of '${table}' is already '${to}'`;
        logger.debug(done);
        return done;
      }
      const message = `renamed column '${from}' to '${to}' on '${table}'`;
      logger.warning(message);
      return message;
    });
}

// PATCHING : Add a table to the schema
// Add an index when it is not already there. SHOW INDEX is the cheap existence check ;
// ALTER TABLE ADD KEY has no IF NOT EXISTS in mysql.
function addIndex(table, indexName, columns) {
  var message;
  var db = "AnsibleForms";
  logger.debug(`adding index '${indexName}' on '${table}'`);
  return mysql
    .do("SHOW INDEX FROM ??.?? WHERE Key_name = ?", [db, table, indexName])
    .then((checkres) => {
      if (checkres.length > 0) {
        message = `Index '${indexName}' is already present on '${table}'`;
        logger.debug(message);
        return message;
      }
      const cols = columns.map(() => "??").join(",");
      return mysql
        .do(`ALTER TABLE ??.?? ADD KEY ?? (${cols})`, [db, table, indexName, ...columns])
        .then(() => {
          message = `added index '${indexName}' on '${table}'`;
          logger.warning(message);
          return message;
        });
    });
}

function addTable(table, sql) {
  var message;
  var db = "AnsibleForms";
  var checksql = "SHOW TABLES FROM ?? WHERE ?? = ?";
  logger.debug(`adding table '${table}'`);
  return mysql
    .do(checksql, [db, `Tables_in_${db}`, table])
    .then((checkres) => {
      if (checkres.length == 0) {
        return mysql.do(sql);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Table '${table}' is already present`;
        logger.debug(message);
        return message;
      }
      message = `added table '${table}'`;
      logger.warning(message);
      return message;
    });
}

// PATCHING : Set the charset of a column to utf8mb4
function setUtf8mb4CharacterSet(table, name, fieldtype) {
  var message;
  var db = "AnsibleForms";
  var checksql = "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ? AND character_set_name = 'utf8mb4'";
  var sql = `ALTER TABLE ??.?? MODIFY ?? ${fieldtype} character set utf8mb4 collate utf8mb4_unicode_ci`;
  logger.debug(`set charset column '${name}'->'utf8mb4' on table '${table}'`);
  return mysql
    .do(checksql, [db, table, name])
    .then((checkres) => {
      if (checkres.length == 0) {
        return mysql.do(sql, [db, table, name]);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Column '${name}' has already charset 'utf8mb4' on '${table}'`;
        logger.debug(message);
        return message;
      }
      message = `Changed charset to 'utf8mb4' on column '${name}' on '${table}'`;
      logger.warning(message);
      return message;
    });
}

// PATCHING : Make a column nullable (drop NOT NULL constraint)
function makeColumnNullable(table, name, fieldtype) {
  var message;
  var db = "AnsibleForms";
  var checksql = "SELECT IS_NULLABLE FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?";
  var sql = `ALTER TABLE ??.?? MODIFY ?? ${fieldtype} NULL`;
  logger.debug(`make column '${name}' nullable on table '${table}'`);
  return mysql
    .do(checksql, [db, table, name])
    .then((checkres) => {
      if (checkres.length > 0 && checkres[0].IS_NULLABLE !== "YES") {
        return mysql.do(sql, [db, table, name]);
      }
      return false;
    })
    .then((res) => {
      if (!res) {
        message = `Column '${name}' is already nullable on '${table}'`;
        logger.debug(message);
        return message;
      }
      message = `Made column '${name}' nullable on '${table}'`;
      logger.warning(message);
      return message;
    });
}

// PATCHING : one-time cleanup of the removed LDAP is_advanced toggle
// The is_advanced toggle was dropped from the UI ; the four group columns
// (groups_search_base, group_class, group_member_attribute,
// group_member_user_attribute) are now always applied when non-empty. On
// installs where the toggle was OFF these may hold stale values that would
// suddenly take effect, so drop the toggle column and blank them once. This is
// gated on the is_advanced column still existing, which makes it strictly
// one-time : after the drop it never runs again (so it can't wipe values a user
// later enters through the new UI).
function clearStaleLdapAdvancedGroupFields() {
  var message;
  var db = "AnsibleForms";
  var table = "ldap";
  var advancedFields = ["groups_search_base", "group_class", "group_member_attribute", "group_member_user_attribute"];
  var clearsql = "SET groups_search_base = '', group_class = '', group_member_attribute = '', group_member_user_attribute = ''";
  var checksql = "SHOW COLUMNS FROM ??.?? WHERE Field = ?";
  var countsql = "SELECT COUNT(*) AS total FROM ??.??";
  var selectsql = "SELECT groups_search_base, group_class, group_member_attribute, group_member_user_attribute FROM ??.?? WHERE is_advanced = 0 OR is_advanced IS NULL";
  var updateallsql = `UPDATE ??.?? ${clearsql}`;
  // the ldap table has no key (it is single-row by design), so a subset of rows can
  // only be addressed by the values snapshotted before the drop ; NULL never
  // matches in a comparison, hence the COALESCE on both sides
  var updatesomesql = `UPDATE ??.?? ${clearsql} WHERE (COALESCE(groups_search_base,''), COALESCE(group_class,''), COALESCE(group_member_attribute,''), COALESCE(group_member_user_attribute,'')) IN (?)`;
  // The "already done" marker, written in the same transaction as the blanking so the
  // two can never disagree. See the long comment below the snapshot.
  var marksql = "UPDATE ??.?? SET is_advanced = 1";
  var dropsql = "ALTER TABLE ??.?? DROP COLUMN is_advanced";
  logger.debug(`cleaning up stale ldap advanced group fields`);
  return mysql
    .do(checksql, [db, table, 'is_advanced'])
    .then(async (checkres) => {
      if (checkres.length == 0) {
        return false;
      }
      // Snapshot the rows to blank while the toggle column still exists.
      var stale = await mysql.do(selectsql, [db, table]);
      var total = (await mysql.do(countsql, [db, table]))[0].total;
      // only the rows that actually carry a value need blanking. On a retry (see
      // below) they are already empty, so there is nothing left to clear and the
      // update is skipped entirely.
      var dirty = stale.filter((row) => advancedFields.some((f) => row[f] !== null && row[f] !== ""));
      // Blank, and mark as done, in ONE transaction. Then drop, separately.
      //
      // The blanking has to be the undoable half, so it comes first : a failing UPDATE
      // rolls itself back and the next boot retries from a clean state. MySQL implicitly
      // commits before DDL and cannot roll a DDL back, so the DROP cannot be part of it.
      //
      // But keying "have I run?" on the column the DROP removes is not enough. A DROP
      // that fails (no ALTER grant - which does not stop the app, see init) used to leave
      // the values blanked AND the gate in place, so this ran again on every call. That is
      // not harmless: GET /api/v2/schema is public and re-runs patchAll while patching is
      // failing, so an admin who re-entered those four fields had them wiped again, over
      // and over. Hence the marker: setting is_advanced = 1 makes the snapshot query
      // (is_advanced = 0 OR NULL) match nothing next time, so the blanking is one-time
      // whether or not the column ever goes away. Nothing reads is_advanced any more, and
      // 1 is the truthful value - after 6.3.0 those fields are always applied.
      await mysql.transaction(async (query) => {
        if (dirty.length > 0) {
          // log the non-empty values at warning level BEFORE clearing them : this is the
          // only recovery trail for exactly what was cleared.
          dirty.forEach((row) => {
            var nonEmpty = advancedFields.filter((f) => row[f] !== null && row[f] !== "");
            logger.warning(`clearing stale ldap advanced group fields: ` + nonEmpty.map((f) => `${f}='${row[f]}'`).join(", "));
          });
          if (stale.length == total) {
            await query(updateallsql, [db, table]);
          } else {
            await query(updatesomesql, [db, table, dirty.map((row) => advancedFields.map((f) => row[f] || ""))]);
          }
        }
        await query(marksql, [db, table]);
      });
      // Separate from the transaction above, because a DDL failure must not be able to
      // look like the blanking never happened.
      await mysql.do(dropsql, [db, table]);
      return true;
    })
    .then((res) => {
      if (!res) {
        message = `Column 'is_advanced' is already absent on '${table}'`;
        logger.debug(message);
        return message;
      }
      message = `cleared stale advanced group fields and dropped 'is_advanced' on '${table}'`;
      logger.warning(message);
      return message;
    });
}

// What a fully patched schema looks like, mapped back to the patch that creates each item.
//
// This lives HERE, beside the patches, for the same reason the fresh-install SQL and the
// patches have to stay in sync: adding a patch means adding one line below, in the file you
// are already editing. Put it in health.model.js and it drifts the first time somebody adds
// a column without thinking about the health page.
//
// It exists because there is NO version table. Patches are idempotent and re-run on every
// boot, so nothing records where a database actually got to - a patch that fails leaves a
// half-migrated schema, one line in the startup log, and no way to ask about it afterwards.
//
// `audit` is included deliberately. The pre-patch `checkTables` excludes it, because that
// runs BEFORE patching and would otherwise block the very patch that creates it; this
// manifest is consumed after patching, so it must expect it.
const SCHEMA_MANIFEST = {
  // tables the fresh install creates, so they must exist however the database was built
  base: {
    tables: ['groups', 'users', 'tokens', 'credentials', 'ldap', 'jobs', 'job_output',
             'settings', 'repositories', 'schedule', 'audit', 'chat_settings', 'secret_stores', 'runners',
             'nodes', 'cache_epochs', 'designer_lock', 'user_groups', 'notification_channels', 'syslog_servers', 'login_failures', 'token_revocations', 'schema_migrations',
             'directory_users', 'announcements', 'disclaimer_versions', 'disclaimer_acceptances', 'api_tokens', 'labels',
             'runner_leases', 'runner_join_tokens', 'job_events'],
  },
  patches: {
    patchVersion4: { columns: ['ldap.groups_search_base', 'ldap.groups_attribute', 'ldap.group_class',
                               'ldap.group_member_attribute', 'ldap.group_member_user_attribute', 'ldap.mail_attribute'] },
    // NOT azuread / oidc : patchVersion5 still creates them for historical upgrades, but
    // they are superseded by `oauth2_providers` (azureAd.model and oidc.model both query
    // that table with a provider filter) and the fresh install does not create them. Every
    // table a patch ever made is NOT the same as the expected schema - listing them here
    // made this check report a false error on a perfectly healthy database.
    patchVersion5: { tables: ['repositories', 'schedule'],
                     // not azuread.groupfilter : its patch is commented out below, and an app node
                     // waits for every column listed here (app-start.js)
                     columns: ['users.email', 'jobs.awx_id',
                               'settings.forms_yaml', 'repositories.branch', 'jobs.awx_artifacts',
                               'jobs.abort_requested'] },
    // One entry per patch function, and there is one patch function per MAJOR version -
    // so everything 6.x adds is listed here, including all of 6.3.0. `indexes` is a
    // separate list from `columns` because the caller grades a missing index lower :
    // its absence is slow rather than broken.
    patchVersion6: { tables: ['oauth2_providers', 'stored_jobs',
                              'audit', 'chat_settings'],
                     columns: ['oauth2_providers.tenant_id', 'jobs.raw_form_data', 'repositories.use_for_config',
                               'jobs.pid', 'jobs.host', 'schedule.one_time_run',
                               'schedule.run_at', 'credentials.vault_path', 'jobs.awx_workflow', 'settings.logo',
                               'settings.config_source', 'settings.default_language',
                               'settings.default_theme', 'settings.default_theme_color',
                               'credentials.managed', 'oauth2_providers.managed',
                               'repositories.managed', 'ldap.managed', 'settings.managed',
                               'ldap.groupfilter', 'chat_settings.auth_type', 'chat_settings.api_version',
                               'chat_settings.request_user', 'chat_settings.extra_headers',
                               'chat_settings.ignore_certs'],
                     indexes: ['jobs.idx_jobs_retention'] },
    // 7 : runners - AWX connections are runners of type awx (the awx table is copied, then
    // dropped), and the job log a playbook writes is stored on the job
    // and the worker and several app nodes : the processes on the database, what changed
    // between them, the designer lock, and the node that follows a job
    patchVersion7: { tables: ['secret_stores', 'runners', 'nodes', 'cache_epochs', 'designer_lock', 'user_groups', 'notification_channels', 'syslog_servers', 'login_failures', 'token_revocations', 'schema_migrations',
                              'directory_users', 'announcements', 'disclaimer_versions', 'disclaimer_acceptances', 'api_tokens', 'labels',
                              'runner_leases', 'runner_join_tokens', 'job_events'],
                     columns: ['job_events.result', 'stored_jobs.visibility', 'runners.rte_mode', 'runners.enabled', 'schedule.enabled', 'runners.pending', 'runners.pending_since', 'runners.pending_info', 'runners.rte_cert_sha256', 'runners.rte_max_jobs', 'runners.rte_cache_mb', 'runners.rte_files', 'runners.rte_drain_seconds', 'schedule.owner', 'credentials.secret_store', 'credentials.secret_ref', 'settings.vault_env_imported_at', 'settings.syslog_env_imported_at', 'jobs.runner', 'jobs.runner_kind', 'jobs.runner_job_url',
                               'runners.username', 'runners.password', 'runners.use_credentials', 'runners.node_id', 'jobs.job_log',
                               'jobs.tracker', 'repositories.claim_node', 'repositories.claim_since',
                               'repositories.use_for_workflows', 'repositories.use_for_inventories',
                               'schedule.claim_node', 'schedule.claim_since', 'runners.flavour', 'runners.project',
                               'credentials.credential_type', 'repositories.credential', 'groups.description',
                               'secret_stores.credential', 'credentials.client_cert', 'credentials.client_key',
                               'chat_settings.credential',
                               'users.description', 'schedule.raw_form_data', 'users.blocked', 'users.last_login', 'settings.favicon',
                               'settings.app_name', 'settings.env_label', 'settings.env_label_show', 'settings.env_label_color',
                               'settings.banner_show', 'settings.disclaimer_enabled',
                               'settings.forms_view', 'settings.default_timezone', 'settings.default_date_format', 'settings.header_links',
                               'tokens.replaced_at', 'repositories.pull_output', 'repositories.push_output',
                               'repositories.pulled_at', 'repositories.pushed_at', 'repositories.push_status',
                               'ldap.id', 'ldap.name', 'ldap.position', 'ldap.domains', 'ldap.credential',
                               'oauth2_providers.credential', 'credentials.tenant_id', 'credentials.issuer', 'credentials.redirect_uri',
                               'credentials.ignore_certs', 'credentials.ca_bundle', 'credentials.rte_cert_sha256', 'oauth2_providers.auto_login',
                               'runners.credential', 'ldap.description', 'settings.disclaimer_version', 'announcements.enabled',
                               'credentials.url', 'settings.encryption_check'] },
  },
};

async function patchVersion4(messages, success, failed) {
  var buffer;
  var sql;

  // patches to db for v4.x.x
  // Before version 4.0.0, the schema was not utf8mb4, so we need to change the charset of some columns, due to some emoticons or utf16 characters
  // Also the ldap was enhanced for openLDAP and required some additional columns
  await checkPromise(setUtf8mb4CharacterSet("jobs", "extravars", "longtext"), messages, success, failed); // allow emoticon or utf16 character
  await checkPromise(setUtf8mb4CharacterSet("jobs", "notifications", "longtext"), messages, success, failed); // allow emoticon or utf16 character
  await checkPromise(setUtf8mb4CharacterSet("jobs", "approval", "longtext"), messages, success, failed); // allow emoticon or utf16 character
  await checkPromise(setUtf8mb4CharacterSet("job_output", "output", "longtext"), messages, success, failed); // allow emoticon or utf16 character
  await checkPromise(addColumn("ldap", "groups_search_base", "varchar(250)", true, "NULL"), messages, success, failed); // add column to have groups search base
  await checkPromise(addColumn("ldap", "groups_attribute", "varchar(250)", false, "'memberOf'"), messages, success, failed); // add column to have groups attribute
  await checkPromise(addColumn("ldap", "group_class", "varchar(250)", true, "NULL"), messages, success, failed); // add column to have group class
  await checkPromise(addColumn("ldap", "group_member_attribute", "varchar(250)", true, "NULL"), messages, success, failed); // add column to have group member attribute
  await checkPromise(addColumn("ldap", "group_member_user_attribute", "varchar(250)", true, "NULL"), messages, success, failed); // add column to have group member user attribute
  // NOTE: the is_advanced toggle column is intentionally NOT (re)created here.
  // It was removed from the UI and patchVersion6 does a one-time cleanup that
  // blanks the stale advanced group fields and drops this column. Re-adding it
  // here would let that cleanup re-run on the next boot and wipe group fields an
  // admin has since configured through the new UI (see clearStaleLdapAdvancedGroupFields).
  await checkPromise(addColumn("ldap", "mail_attribute", "varchar(250)", true, "NULL"), messages, success, failed); // add column to have mail attribute
  // also the settings tables was not present before 4.0.0, it contains the URL and mail settings for notification
  // later the column forms_yaml was added to store the forms in yaml format (but that was in 5.x.x)
  buffer = fs.readFileSync(`${__dirname}/../db/create_settings_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("settings", sql), messages, success, failed); // add settings table
}

// PATCHING : version 5
async function patchVersion5(messages, success, failed) {
  var buffer;
  var sql;

  // patches to db for v5.x.x
  // Before version 5, the users didn't have an email.  The was on request
  // AF passes the user object and the email address can then be used in ansible for notifications
  await checkPromise(addColumn("users", "email", "varchar(250)", true, "NULL"), messages, success, failed); // add column to have email

  // // Azure AD integration was added in 5.0.0, so we need to add the table and columns
  // buffer = fs.readFileSync(`${__dirname}/../db/create_azuread_table.sql`);
  // sql = buffer.toString();
  // await checkPromise(addTable("azuread", sql), messages, success, failed); // add azuread table

  // // A bit later, the groupfilter was added to limit the groups that can be used in AF, because the list can be very long and that's part of the JWT token
  // // which introduced a limit
  // await checkPromise(addColumn("azuread", "groupfilter", "varchar(250)", true, "NULL"), messages, success, failed); // add column to limit azuread groups

  // on request, the awx_id was added to the jobs table, to later retrieve it for future tracking
  await checkPromise(addColumn("jobs", "awx_id", "int(11)", true, "NULL"), messages, success, failed); // add for future tracking

  // patch for awx credentials, the use_credentials was added to the awx table, to allow the use of credentials
  // (only while the awx table exists : 7 moves it to runners, see patchVersion7)
  if (await tablePresent("awx")) {
    await checkPromise(addColumn("awx", "use_credentials", "tinyint(4)", true, "0"), messages, success, failed); // bugfix for awx credentials
  }

  // A new feature was added, the repositories table, to store the repositories for the forms and playbooks
  // A real gamechanger, because now the forms and playbooks can be stored in a git repository
  buffer = fs.readFileSync(`${__dirname}/../db/create_repositories_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("repositories", sql), messages, success, failed); // add repositories table

  // // In a first pull requests, mdaug was so kind to contribute the oidc table, to have OpenID Connect integration
  // buffer = fs.readFileSync(`${__dirname}/../db/create_oidc_table.sql`);
  // sql = buffer.toString();
  // await checkPromise(addTable("oidc", sql), messages, success, failed); // add oidc table

  // In 5.0.3, the settings was extended with a new column, forms_yaml, to store the forms in yaml format
  // If you use GIT to store the forms, but not the master forms.yaml, you can now store it in the database

  await checkPromise(addColumn("settings", "forms_yaml", "longtext", true, "NULL"), messages, success, failed); // add forms_yaml column
  await checkPromise(setUtf8mb4CharacterSet("settings", "forms_yaml", "longtext"), messages, success, failed); // allow emoticon or utf16 characters

  // In 5.0.8, the repositories table was extended with a new column, branch, to store the branch of the repository
  await checkPromise(addColumn("repositories", "branch", "varchar(250)", true, "NULL"), messages, success, failed); // add branch column

  // In 5.0.9, We add a scheduler
  buffer = fs.readFileSync(`${__dirname}/../db/create_schedule_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("schedule", sql), messages, success, failed); // add schedule table

  // In 5.0.10, we add a new column to the jobs table, to store the awx artifacts
  await checkPromise(addColumn("jobs", "awx_artifacts", "longtext", true, "NULL"), messages, success, failed); // add awx_artifacts column

  // In 5.1.0, add abort_requested bit to jobs table, default 0
  await checkPromise(addColumn("jobs", "abort_requested", "tinyint(4)", true, "NULL"), messages, success, failed); // add abort_requested column

  // In 6.0.0, we allow multiple awx instances, so we need to add id, name and description to the awx table
  // (only while the awx table exists : 7 moves it to runners, see patchVersion7)
  if (await tablePresent("awx")) {
    await checkPromise(addIdPrimaryKey("awx"), messages, success, failed); // add id column with auto_increment primary key
    await checkPromise(addColumn("awx", "name", "varchar(250)", true, "NULL"), messages, success, failed); // add name column
    await checkPromise(addUniqueKey("awx", "name"), messages, success, failed); // make name unique
    await checkPromise(addColumn("awx", "description", "varchar(250)", true, "NULL"), messages, success, failed); // add description column
    await checkPromise(addColumn("awx", "is_default", "tinyint(4)", true, "0"), messages, success, failed); // add is_default column
  }
}

// Patches for v6 
// In 6.0.0 we add oauth2 providers table
async function patchVersion6(messages, success, failed) {
  var buffer;
  var sql;

  // The datasource tables (datasource_schemas, datasource, staging) were created here until
  // 7.0.0 removed datasources ; patchVersion7 drops them.

  // In 6.0.0, we add oauth2 providers table
  buffer = fs.readFileSync(`${__dirname}/../db/create_oauth2_providers_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("oauth2_providers", sql), messages, success, failed);
  await checkPromise(addColumn("oauth2_providers", "tenant_id", "TEXT", true, "NULL"), messages, success, failed);
  
  // Add raw_form_data column to jobs table for job relaunch feature
  await checkPromise(addColumn("jobs", "raw_form_data", "longtext", true, "NULL"), messages, success, failed);
  
  // --- AzureAD migration to oauth2_providers ---
  // Check if azuread table exists
  try {
    // AzureAD migration
    const azureadTableCheck = await mysql.do("SHOW TABLES FROM AnsibleForms WHERE Tables_in_AnsibleForms = 'azuread'");
    if (azureadTableCheck.length > 0) {
      // Table exists, migrate record(s) from azuread to oauth2_providers if client_id is not empty
      const insertSql = `
        INSERT INTO AnsibleForms.oauth2_providers (name, provider, client_id, client_secret, groupfilter, enable)
        SELECT 'EntraID', 'azuread', client_id, secret_id, groupfilter, enable
        FROM AnsibleForms.azuread
        WHERE client_id IS NOT NULL AND client_id != ''
      `;
      await mysql.do(insertSql)
    }

    // OIDC migration
    const oidcTableCheck = await mysql.do("SHOW TABLES FROM AnsibleForms WHERE Tables_in_AnsibleForms = 'oidc'");
    if (oidcTableCheck.length > 0) {
      // Table exists, migrate record(s) from oidc to oauth2_providers if client_id is not empty
      const insertOidcSql = `
        INSERT INTO AnsibleForms.oauth2_providers (name, provider, client_id, client_secret, groupfilter, enable, issuer)
        SELECT 'OpenID', 'oidc', client_id, secret_id, groupfilter, enabled, issuer
        FROM AnsibleForms.oidc
        WHERE client_id IS NOT NULL AND client_id != ''
      `;
      await mysql.do(insertOidcSql)
    }
  } catch (e) {
    // messages.push("AzureAD/OIDC migration failed: " + e.message);
    // failed.push("AzureAD/OIDC migration failed: " + e.message);
  }
  // Drop the azuread table using dropTable and checkPromise
  await checkPromise(dropTable("azuread"), messages, success, failed);
  await checkPromise(dropTable("oidc"), messages, success, failed);
  
  // Add use_for_config column to repositories table (6.1.0+)
  // This allows a repository to be marked for config.yaml specifically
  await checkPromise(addColumn("repositories", "use_for_config", "tinyint(4)", true, "0"), messages, success, failed);
  
  // (6.1.0 added repositories.use_for_vars_files : 7 drops it, the vars files are the forms
  // repository's - see patchVersion7)
  
  // Add pid column to jobs table (6.1.4)
  // This stores the process ID for running jobs to allow direct process control
  await checkPromise(addColumn("jobs", "pid", "int(11)", true, "NULL"), messages, success, failed);
  
  // Add host column to jobs table (6.1.4)
  // This stores the hostname/container ID to prevent cross-instance process kills
  await checkPromise(addColumn("jobs", "host", "varchar(255)", true, "NULL"), messages, success, failed);
  
  // Add one_time_run column to schedule table (6.2.0)
  // This allows schedules to be either recurring (false) or one-time (true)
  await checkPromise(addColumn("schedule", "one_time_run", "tinyint(4)", true, "0"), messages, success, failed);
  
  // Add run_at column to schedule table (6.2.0)
  // This stores the datetime for one-time scheduled jobs
  await checkPromise(addColumn("schedule", "run_at", "datetime", true, "NULL"), messages, success, failed);
  
  // Create stored_jobs table (6.2.0)
  // This allows users to save and load form data
  buffer = fs.readFileSync(`${__dirname}/../db/create_stored_jobs_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("stored_jobs", sql), messages, success, failed);

  // Add vault_path column to credentials table (6.3.0)
  // When set, the credential's user/password are fetched from HashiCorp Vault
  // at this path instead of from the local DB columns. Non-secret connection
  // metadata (host, port, db_name, db_type, secure, is_database) stays in DB.
  await checkPromise(addColumn("credentials", "vault_path", "varchar(500)", true, "NULL"), messages, success, failed);
  // Allow user/password to be NULL for vault-backed credentials.
  await checkPromise(makeColumnNullable("credentials", "user", "varchar(250)"), messages, success, failed);
  await checkPromise(makeColumnNullable("credentials", "password", "text"), messages, success, failed);
  // `description` is optional metadata - crud.config.js does not mark it required and the
  // other description columns in this schema are already DEFAULT NULL - but these two were
  // NOT NULL with no default, so MySQL refused any insert that omitted them. An API client
  // creating a credential or a repository without one got a raw
  // "Field 'description' doesn't have a default value" 500 instead of the record it asked
  // for. (A TEXT column cannot carry a literal DEFAULT, so nullable is the fix rather than
  // DEFAULT ''.) The UI always sends the field, which is why this went unnoticed.
  await checkPromise(makeColumnNullable("credentials", "description", "text"), messages, success, failed);
  await checkPromise(makeColumnNullable("repositories", "description", "text"), messages, success, failed);

  // Add awx_workflow column to jobs table (6.3.0)
  // This stores the awx workflow nodes (name, status, relations) as json,
  // so the client can visualize the workflow graph of an awx workflow job
  await checkPromise(addColumn("jobs", "awx_workflow", "longtext", true, "NULL"), messages, success, failed);

  // Add logo column to the settings table (6.3.0)
  // This stores an optional custom logo as a base64 data url, shown in the
  // navbar instead of the default AnsibleForms logo (admin panel > logo)
  await checkPromise(addColumn("settings", "logo", "longtext", true, "NULL"), messages, success, failed);

  // --- the rest of 6.3.0 ---
  //
  // It all belongs in THIS function. The patch number is the MAJOR version, not a
  // counter : 4 is "for v4.x.x", 5 is "for v5.x.x", 6 is every 6.x, and the three
  // columns above are already labelled 6.3.0. A patchVersion7 would mean AnsibleForms
  // 7.0.0, and a function per feature invents versions that do not exist.
  //
  // Appending to a function that has already shipped is safe, and is what the entries
  // above do: patchAll runs every patch on every boot with no version bookkeeping, so
  // a new function would not be applied any differently. What makes that work is that
  // each helper is existence-checked - addColumn, addTable and addIndex all look first,
  // and the ldap cleanup no-ops once the column it keys off is gone.

  // the active config source, and the server-wide language and theme defaults
  await checkPromise(addColumn("settings", "config_source", "varchar(20)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("settings", "default_language", "varchar(5)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("settings", "default_theme", "varchar(10)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("settings", "default_theme_color", "varchar(7)", true, "NULL"), messages, success, failed);

  // one-time cleanup after removing the ldap is_advanced toggle (see the helper : it
  // snapshots, blanks and drops in one transaction, and no-ops once the column is gone)
  await checkPromise(clearStaleLdapAdvancedGroupFields(), messages, success, failed);

  // The audit trail. It is append only : nothing updates or deletes a row except the
  // retention sweep, which is why it carries no natural key and no unique constraint.
  buffer = fs.readFileSync(`${__dirname}/../db/create_audit_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("audit", sql), messages, success, failed);

  // The chat assistant's model provider : one row, its api key encrypted (6.5)
  buffer = fs.readFileSync(`${__dirname}/../db/create_chat_settings_table.sql`);
  sql = buffer.toString();
  await checkPromise(addTable("chat_settings", sql), messages, success, failed);
  // how to talk to an OpenAI-compatible provider or proxy : auth header, api version, the
  // user a proxy wants, extra headers (a table created before they existed gets them here)
  await checkPromise(addColumn("chat_settings", "auth_type", "varchar(20)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("chat_settings", "api_version", "varchar(50)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("chat_settings", "request_user", "varchar(100)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("chat_settings", "extra_headers", "text", true, "NULL"), messages, success, failed);
  // a proxy on a self-signed certificate (6.5.1)
  await checkPromise(addColumn("chat_settings", "ignore_certs", "tinyint(4)", true, "0"), messages, success, failed);

  // Job retention selects on parent_id + status + end. Without an index that is a full
  // scan of the biggest table in the schema, repeated once per batch.
  await checkPromise(addIndex("jobs", "idx_jobs_retention", ["parent_id", "status", "end"]), messages, success, failed);

  // The optional ldap group filter. Entra ID and OIDC have had one since 5.x,
  // in oauth2_providers.groupfilter ; this is the same thing for directory logins, and the
  // column is deliberately named the same. NULL / empty keeps every group, which is what
  // every existing installation has.
  await checkPromise(addColumn("ldap", "groupfilter", "varchar(250)", true, "NULL"), messages, success, failed);

  // The declarative config seed flags the objects it owns, so the API can refuse to
  // change them behind the seed's back. One column per seedable table. Default 0 :
  // everything that already exists was made by hand and stays editable.
  for (const table of ["credentials", "oauth2_providers", "repositories", "ldap", "settings"]) {
    await checkPromise(addColumn(table, "managed", "tinyint(4)", true, "0"), messages, success, failed);
  }
  // the awx table too, while it exists (7 moves it to runners, see patchVersion7)
  if (await tablePresent("awx")) {
    await checkPromise(addColumn("awx", "managed", "tinyint(4)", true, "0"), messages, success, failed);
  }

}

// Patches for v7
// 7.0.0 removed datasources : their tables go. staging first, it references datasource.
// The data schemas an import filled are separate databases of the user's own and stay.
async function patchVersion7(messages, success, failed) {
  await checkPromise(dropTable("staging"), messages, success, failed);
  await checkPromise(dropTable("datasource"), messages, success, failed);
  await checkPromise(dropTable("datasource_schemas"), messages, success, failed);

  // 7.x : secret stores (HashiCorp Vault, CyberArk, ...) and the credential columns that
  // point into one
  const buffer = fs.readFileSync(`${__dirname}/../db/create_secret_stores_table.sql`);
  await checkPromise(addTable("secret_stores", buffer.toString()), messages, success, failed);
  await checkPromise(addColumn("credentials", "secret_store", "varchar(250)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("credentials", "secret_ref", "varchar(500)", true, "NULL"), messages, success, failed);
  // a credential that read from vault through vault_path now names the store `vault`
  await checkPromise(copyVaultPathToSecretRef(), messages, success, failed);
  // when the VAULT_* variables were imported as the secret store `vault` (once, at the
  // first 7.x start that has them - secrets/importVaultEnv.js)
  await checkPromise(addColumn("settings", "vault_env_imported_at", "datetime", true, "NULL"), messages, success, failed);
  // the user a planned job ("Run later" with allowPlannedJobs) runs as - see Schedule.plan
  await checkPromise(addColumn("schedule", "owner", "longtext", true, "NULL"), messages, success, failed);
  // a planned job's raw field values, checked by the launch validation when it fires
  await checkPromise(addColumn("schedule", "raw_form_data", "longtext", true, "NULL"), messages, success, failed);

  // 7 : runners (where a playbook runs : an RTE) and the runner a job ran on
  const runners = fs.readFileSync(`${__dirname}/../db/create_runners_table.sql`);
  await checkPromise(addTable("runners", runners.toString()), messages, success, failed);
  await checkPromise(addColumn("jobs", "runner", "varchar(250)", true, "NULL"), messages, success, failed);
  // what that runner was when the job ran (the jobs list says jenkins, aap ...) : kept on the job,
  // so a runner removed or renamed later does not change it ; the jobs before it, once, from their
  // runner as it is now
  await checkPromise(addColumn("jobs", "runner_kind", "varchar(20)", true, "NULL"), messages, success, failed);
  // its address in that product's web UI : kept on the job, so a runner removed or renamed later
  // leaves its link (lib/runnerJobLinks.js) ; the jobs before it, when their page is first read
  await checkPromise(addColumn("jobs", "runner_job_url", "varchar(1000)", true, "NULL"), messages, success, failed);
  // AWX/AAP/Ascender connections are runners of type awx : the awx table is copied into
  // runners once, then dropped ; the job log a playbook writes is stored on the job
  await checkPromise(addColumn("runners", "username", "varchar(250)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("runners", "password", "text", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("runners", "use_credentials", "tinyint(4)", true, "0"), messages, success, failed);
  // the RTE that registered the runner itself (rte/register.js) ; NULL when added by hand or the seed
  await checkPromise(addColumn("runners", "node_id", "varchar(250)", true, "NULL"), messages, success, failed);
  // an awx runner that is an AAP or an Ascender (empty is AWX) : which product it is
  await checkPromise(addColumn("runners", "flavour", "varchar(20)", true, "NULL"), messages, success, failed);
  // the project a semaphore runner (its id) or a rundeck runner (its name) launches in
  await checkPromise(addColumn("runners", "project", "varchar(255)", true, "NULL"), messages, success, failed);
  // the jobs' runner kind, from their runner's type and flavour : after every runners column it
  // reads is there - on a database from before flavour, filling it earlier failed (Unknown
  // column 'r.flavour') and left the old jobs without a kind until the next start
  await checkPromise(fillJobRunnerKinds(), messages, success, failed);
  // what a credential is for : userpass, ssh, git, api, database... ; the existing ones from their
  // is_database flag
  await checkPromise(addColumn("credentials", "credential_type", "varchar(20)", true, "NULL"), messages, success, failed);
  await checkPromise(fillCredentialTypes(), messages, success, failed);
  // a repository can use a credential of Connections > Credentials instead of its own
  // user and password
  await checkPromise(addColumn("repositories", "credential", "varchar(250)", true, "NULL"), messages, success, failed);
  // a secret store (a Vault) can read its token from a credential of Connections > Credentials
  // instead of keeping its own
  await checkPromise(addColumn("secret_stores", "credential", "varchar(250)", true, "NULL"), messages, success, failed);
  // a cyberark credential's client certificate and key, how a CyberArk store's AppID may be
  // restricted
  await checkPromise(addColumn("credentials", "client_cert", "text", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("credentials", "client_key", "text", true, "NULL"), messages, success, failed);
  // where notifications go (Connections > Notifications) : SMTP servers (one active), Slack,
  // Teams, Telegram and webhooks. The mail servers of a 7 release candidate move in (their table
  // then goes), and the mail settings of before become the first, their login an smtp credential
  const channelsBuffer = fs.readFileSync(`${__dirname}/../db/create_notification_channels_table.sql`);
  await checkPromise(addTable("notification_channels", channelsBuffer.toString()), messages, success, failed);
  await checkPromise(moveMailServersToChannels(), messages, success, failed);
  await checkPromise(copyMailSettingsToServers(), messages, success, failed);
  // a mail channel's server, port and TLS belong to its smtp credential, with its login (the
  // SSO providers and the LDAP directories move theirs further down, once their columns are there)
  await checkPromise(moveMailServersToCredentials(), messages, success, failed);
  // the syslog servers the server log and the audit entries go to (Connections > Syslog) ; the
  // LOG_SYSLOG_* variables of before become the first, once (lib/syslogServers.js)
  const syslogBuffer = fs.readFileSync(`${__dirname}/../db/create_syslog_servers_table.sql`);
  await checkPromise(addTable("syslog_servers", syslogBuffer.toString()), messages, success, failed);
  await checkPromise(addColumn("settings", "syslog_env_imported_at", "datetime", true, "NULL"), messages, success, failed);
  // failed logins, for the account lockout (lib/loginThrottle.js)
  const loginFailures = fs.readFileSync(`${__dirname}/../db/create_login_failures_table.sql`);
  await checkPromise(addTable("login_failures", loginFailures.toString()), messages, success, failed);
  // the patches applied, and by which release (recordMigrations)
  const migrations = fs.readFileSync(`${__dirname}/../db/create_schema_migrations_table.sql`);
  await checkPromise(addTable("schema_migrations", migrations.toString()), messages, success, failed);
  // revoked tokens : logouts and password changes (lib/tokenRevocation.js)
  const tokenRevocations = fs.readFileSync(`${__dirname}/../db/create_token_revocations_table.sql`);
  await checkPromise(addTable("token_revocations", tokenRevocations.toString()), messages, success, failed);
  // the LDAP and SSO users seen at sign-in, and their sign-in blocked (models/directoryUser.model.js)
  const directoryUsers = fs.readFileSync(`${__dirname}/../db/create_directory_users_table.sql`);
  await checkPromise(addTable("directory_users", directoryUsers.toString()), messages, success, failed);
  // the chat's key can be an api credential's password instead of its own
  await checkPromise(addColumn("chat_settings", "credential", "varchar(250)", true, "NULL"), messages, success, failed);
  // a description on the local groups and users : what a group is for, who owns an account
  await checkPromise(addColumn("groups", "description", "varchar(250)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("users", "description", "varchar(250)", true, "NULL"), messages, success, failed);
  // a local user's sign-in blocked by an admin, as an LDAP or SSO user's (lib/signInGate.js)
  await checkPromise(addColumn("users", "blocked", "tinyint(4)", false, "0"), messages, success, failed);
  // a local user's latest sign-in, as an LDAP or SSO user's (lib/signInGate.js)
  await checkPromise(addColumn("users", "last_login", "datetime", true, "NULL"), messages, success, failed);
  // the website icon (Settings > Appearance > Icon), a data url like the logo
  await checkPromise(addColumn("settings", "favicon", "longtext", true, "NULL"), messages, success, failed);
  // Settings > Appearance : the name, the environment label, the announcement and
  // the forms list's view, the time zone and the date format for everyone, the header's own links
  for (const [name, type] of [["app_name", "varchar(100)"], ["env_label", "varchar(40)"], ["env_label_color", "varchar(20)"],
    ["forms_view", "varchar(10)"],
    ["default_timezone", "varchar(64)"], ["default_date_format", "varchar(20)"], ["header_links", "text"]]) {
    await checkPromise(addColumn("settings", name, type, true, "NULL"), messages, success, failed);
  }
  // the environment label shown or not (Settings > Appearance > Environment) : shown
  await checkPromise(addColumn("settings", "env_label_show", "tinyint(4)", false, "1"), messages, success, failed);
  // the labels beside the logo (Settings > Appearance > Labels), several where there was one
  // environment label : that label (its text, its colour, shown or not) is their first, once,
  // on the start that makes the table
  await checkPromise(addLabelsTable(), messages, success, failed);
  // the announcements shown or not (Settings > Appearance > Announcements) : shown ; and the
  // announcements themselves, each with its start and its end
  await checkPromise(addColumn("settings", "banner_show", "tinyint(4)", false, "1"), messages, success, failed);
  const announcements = fs.readFileSync(`${__dirname}/../db/create_announcements_table.sql`);
  await checkPromise(addTable("announcements", announcements.toString()), messages, success, failed);
  // the disclaimer users accept once (Settings > Access > Disclaimer) : off until switched on,
  // its versions and who accepted which
  await checkPromise(addColumn("settings", "disclaimer_enabled", "tinyint(4)", false, "0"), messages, success, failed);
  const disclaimerTables = fs.readFileSync(`${__dirname}/../db/create_disclaimer_tables.sql`).toString();
  await checkPromise(addTable("disclaimer_versions", disclaimerTables), messages, success, failed);
  await checkPromise(addTable("disclaimer_acceptances", disclaimerTables), messages, success, failed);
  await checkPromise(copyAwxToRunners(), messages, success, failed);
  await checkPromise(addColumn("jobs", "job_log", "longtext", true, "NULL"), messages, success, failed);

  // 7 : a worker and several app nodes on one database (lib/nodes.js, lib/epochs.js,
  // the designer lock in models/lock.model.js, the node following a job)
  // and a local user's groups besides its first one
  for (const table of ["nodes", "cache_epochs", "designer_lock", "user_groups"]) {
    const sql = fs.readFileSync(`${__dirname}/../db/create_${table}_table.sql`);
    await checkPromise(addTable(table, sql.toString()), messages, success, failed);
  }
  await checkPromise(addColumn("jobs", "tracker", "varchar(250)", true, "NULL"), messages, success, failed);
  // who holds a repository's or a schedule's 'running' claim, and since when : a claim left by a
  // node that went away is released by the worker (Repository.releaseStaleClaims, Schedule.releaseStale)
  for (const table of ["repositories", "schedule"]) {
    await checkPromise(addColumn(table, "claim_node", "varchar(250)", true, "NULL"), messages, success, failed);
    await checkPromise(addColumn(table, "claim_since", "datetime", true, "NULL"), messages, success, failed);
  }
  // a repository for the workflows the designer builds ; the vars files are no longer a usage of
  // their own : they are the forms repository's (its vars folder, Repository.getVarsFilesPath)
  await checkPromise(addColumn("repositories", "use_for_workflows", "tinyint(4)", true, "0"), messages, success, failed);
  // a repository for the inventories the playbook forms name (inventory: <name>)
  await checkPromise(addColumn("repositories", "use_for_inventories", "tinyint(4)", true, "0"), messages, success, failed);
  await checkPromise(dropColumn("repositories", "use_for_vars_files"), messages, success, failed);
  // a refresh token replaced by a refresh is kept a few seconds, marked, rather than deleted :
  // a request that refreshed with it at the same time is told so instead of being refused as
  // an unknown token (models/token.model.js, #1062)
  await checkPromise(addColumn("tokens", "replaced_at", "datetime", true, "NULL"), messages, success, failed);
  // what git said on a repository's last pull and on its last push, apart : a push no longer hides
  // what the pull before it said. Its output was the last of either : it is the pull's now
  await checkPromise(renameColumn("repositories", "output", "pull_output", "longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL"), messages, success, failed);
  await checkPromise(addColumn("repositories", "push_output", "longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", true, "NULL"), messages, success, failed);
  // several LDAP directories (Settings > Access > LDAP) : the single row gets the id it never had,
  // a name (the existing one is 'default', whose members keep their short names), the order a
  // bare username is looked up in, and the sign-in domains that go straight to it
  await checkPromise(addIdPrimaryKey("ldap"), messages, success, failed);
  await checkPromise(addColumn("ldap", "name", "varchar(100)", false, "'default'"), messages, success, failed);
  await checkPromise(addColumn("ldap", "position", "int(11)", false, "1"), messages, success, failed);
  await checkPromise(addColumn("ldap", "domains", "varchar(1000)", true, "NULL"), messages, success, failed);
  // the name is unique : rows that share one (several rows of the single-row table of before,
  // all named 'default' by the column's default) get distinct names first, or the key could
  // never be added and this patch failed at every start
  await checkPromise(dedupeLdapNames(), messages, success, failed);
  await checkPromise(addUniqueKey("ldap", "name"), messages, success, failed);
  // the LDAP directory named "default" up to 7.2 is "main" from 7.3 : its members keep their short
  // names. Here, after the name column and its key, and before its servers move to a credential
  // below (moveLdapServersToCredentials) : that credential is named after the directory, so it is
  // main-ldap, not a default-ldap left behind for the directory main
  await checkPromise(renameDefaultLdap(), messages, success, failed);
  // a directory can bind with a credential of Connections > Credentials instead of its own user
  // and password, as a repository can
  await checkPromise(addColumn("ldap", "credential", "varchar(250)", true, "NULL"), messages, success, failed);
  // an SSO provider too : the credential's user its client id, its password the client secret (which
  // can then come from a secret store)
  await checkPromise(addColumn("oauth2_providers", "credential", "varchar(250)", true, "NULL"), messages, success, failed);
  // an Entra ID credential holds its tenant, as Microsoft's own credential does (tenant, client id,
  // client secret)
  await checkPromise(addColumn("credentials", "tenant_id", "varchar(250)", true, "NULL"), messages, success, failed);
  // and an Open ID one its issuer : where the provider is and as whom, one credential
  await checkPromise(addColumn("credentials", "issuer", "varchar(500)", true, "NULL"), messages, success, failed);
  // and the redirect URL registered with the client : the app registration as one credential
  await checkPromise(addColumn("credentials", "redirect_uri", "varchar(1000)", true, "NULL"), messages, success, failed);
  // an ldap credential holds its directory's servers and TLS with the bind account, as an smtp one
  // its mail server : whether certificates are checked, the CA bundle
  await checkPromise(addColumn("credentials", "ignore_certs", "tinyint(4)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("credentials", "ca_bundle", "text", true, "NULL"), messages, success, failed);
  // the SHA-256 of the ca_bundle an inbound RTE's certificate was stored as (runners/rteHub.js) :
  // while the bundle still has that digest the RTE may replace it (a renewed certificate) ; an
  // admin who changes the bundle clears it, and the RTE never overwrites their bundle
  await checkPromise(addColumn("credentials", "rte_cert_sha256", "varchar(64)", true, "NULL"), messages, success, failed);
  // an SSO provider's client (and its tenant or issuer) belongs to a credential of its type, and an
  // LDAP directory's servers and TLS to its ldap credential, with its bind account : only now, after
  // every column they read and write (oauth2_providers.credential, the ldap id, name and credential,
  // the credentials' tenant_id, issuer, redirect_uri, ignore_certs and ca_bundle) - run before them,
  // an upgrade from 6 failed on an unknown column and moved nothing until the next start
  await checkPromise(moveSsoClientsToCredentials(), messages, success, failed);
  await checkPromise(moveLdapServersToCredentials(), messages, success, failed);
  // Skip the login page, per SSO provider (it was the SSO_AUTO_LOGIN variable, until 7.3)
  await checkPromise(addColumn("oauth2_providers", "auto_login", "tinyint(4)", true, "0"), messages, success, failed);
  // a runner signs in with a credential of Connections > Credentials, as every other connection
  await checkPromise(addColumn("runners", "credential", "varchar(250)", true, "NULL"), messages, success, failed);
  // and the token, user and password of each runner moved to a credential
  await checkPromise(moveRunnerSecretsToCredentials(), messages, success, failed);
  // an LDAP directory says what it is, as every record
  await checkPromise(addColumn("ldap", "description", "varchar(250)", true, "NULL"), messages, success, failed);
  // the disclaimer version users accept, as Restore chose it ; none : the latest
  await checkPromise(addColumn("settings", "disclaimer_version", "int(11)", true, "NULL"), messages, success, failed);
  // each announcement enabled on its own ; the switch of before (all of them hidden) moves in
  await checkPromise(addColumn("announcements", "enabled", "tinyint(4)", false, "1"), messages, success, failed);
  await checkPromise(moveBannerSwitchToAnnouncements(), messages, success, failed);
  // and when each ended, worked or not, shown beside the repository's Pull and Push
  await checkPromise(addColumn("repositories", "pulled_at", "datetime", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("repositories", "pushed_at", "datetime", true, "NULL"), messages, success, failed);
  // how the last push ended : it wrote the pull's status (a failed push read as a failed pull)
  await checkPromise(addColumn("repositories", "push_status", "varchar(50)", true, "NULL"), messages, success, failed);
  // an api, userpass or cyberark credential carries the address of the one server it logs in to,
  // with its TLS : a secret store's and a runner's (other than an RTE) move into it
  await checkPromise(addColumn("credentials", "url", "varchar(1000)", true, "NULL"), messages, success, failed);
  // a known text encrypted with the key the stored secrets are encrypted with : which key that
  // is, when ENCRYPTION_SECRET changes (lib/keyRotation.js)
  await checkPromise(addColumn("settings", "encryption_check", "text", true, "NULL"), messages, success, failed);
  await checkPromise(moveConnectionsToCredentials(), messages, success, failed);
  // and those credentials are of the runner's or the store's kind : rte, awx, aap, ascender,
  // semaphore, rundeck, jenkins, vault (a CyberArk's already cyberark) ; once (its marker in
  // schema_migrations), so a type an admin chooses later is never rewritten
  await checkPromise(retypeConnectionCredentials(), messages, success, failed);
  // the API tokens issued, listed and revoked on the profile and the user's page (models/apiToken.model.js)
  const apiTokens = fs.readFileSync(`${__dirname}/../db/create_api_tokens_table.sql`);
  await checkPromise(addTable("api_tokens", apiTokens.toString()), messages, success, failed);
  // the RTE over a WebSocket (rte/socket) : how each RTE talks to the app (database, outbound or
  // inbound), the app node holding each socket, and the join tokens runners add themselves with
  await checkPromise(addColumn("runners", "rte_mode", "varchar(10)", true, "NULL"), messages, success, failed);
  // a runner turned off takes no job (Connections > Runners, Enable / Disable)
  await checkPromise(addColumn("runners", "enabled", "tinyint(4)", true, "1"), messages, success, failed);
  // a schedule turned off does not fire (Settings > Schedules, Enable / Disable)
  await checkPromise(addColumn("schedule", "enabled", "tinyint(4)", true, "1"), messages, success, failed);
  // an RTE that asks to join waits for an admin's approval (Connections > Runners, Approve)
  await checkPromise(addColumn("runners", "pending", "tinyint(4)", true, "0"), messages, success, failed);
  await checkPromise(addColumn("runners", "pending_since", "datetime", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("runners", "pending_info", "text", true, "NULL"), messages, success, failed);
  // the same for a runner that keeps its own ca_bundle (no credential) : the digest of the bundle
  // its RTE's certificate was stored as
  await checkPromise(addColumn("runners", "rte_cert_sha256", "varchar(64)", true, "NULL"), messages, success, failed);
  // a socket-mode RTE's settings, set on its runner page and sent over its socket
  // (rte/socket/settings.js) : empty is the default
  await checkPromise(addColumn("runners", "rte_max_jobs", "int(11)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("runners", "rte_cache_mb", "int(11)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("runners", "rte_files", "varchar(10)", true, "NULL"), messages, success, failed);
  await checkPromise(addColumn("runners", "rte_drain_seconds", "int(11)", true, "NULL"), messages, success, failed);
  const leases = fs.readFileSync(`${__dirname}/../db/create_runner_leases_table.sql`);
  await checkPromise(addTable("runner_leases", leases.toString()), messages, success, failed);
  const joinTokens = fs.readFileSync(`${__dirname}/../db/create_runner_join_tokens_table.sql`);
  await checkPromise(addTable("runner_join_tokens", joinTokens.toString()), messages, success, failed);
  // a playbook's structured events (the af_events callback plugin) : the job page's grid and recap
  const jobEvents = fs.readFileSync(`${__dirname}/../db/create_job_events_table.sql`);
  await checkPromise(addTable("job_events", jobEvents.toString()), messages, success, failed);
  // a host's whole result, as its details show it (a click on its line of the output)
  await checkPromise(addColumn("job_events", "result", "longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", true, "NULL"), messages, success, failed);
  // a stored job private to its owner or shared with other users (lib/storedJobScope.js)
  await checkPromise(addColumn("stored_jobs", "visibility", "varchar(10)", false, "'private'"), messages, success, failed);
}

/**
 * Makes the labels table, and on that start only (the table was not there) carries the
 * environment label of the settings row into it as its first label : deleting every label
 * later never brings it back.
 *
 * Returns:
 *   Promise<string>: what was done, for the patch's messages.
 */
async function addLabelsTable() {
  const existed = await mysql.do("SHOW TABLES FROM ?? WHERE ?? = ?", ["AnsibleForms", "Tables_in_AnsibleForms", "labels"]);
  const sql = fs.readFileSync(`${__dirname}/../db/create_labels_table.sql`).toString();
  const message = await addTable("labels", sql);
  if (existed.length) return message;
  const rows = await mysql.do("SELECT env_label, env_label_color, env_label_show FROM AnsibleForms.`settings` LIMIT 1");
  const old = rows?.[0];
  const name = String(old?.env_label || "").trim();
  if (!name) return message;
  await mysql.do("INSERT INTO AnsibleForms.`labels` (name, color, enabled, position) VALUES (?, ?, ?, 1)", [
    name.slice(0, 40),
    old.env_label_color || "red",
    old.env_label_show === 0 ? 0 : 1,
  ]);
  return `${message}, with the environment label '${name}' as its first`;
}

// Idempotent by its WHERE clause : only a job with a runner and no kind yet gets one, from its
// runner as it is now (none when that runner is gone)
function fillJobRunnerKinds() {
  return mysql
    .do(
      "UPDATE AnsibleForms.`jobs` j JOIN AnsibleForms.`runners` r ON r.name = j.runner " +
        "SET j.runner_kind = IF(r.type = 'awx', COALESCE(NULLIF(r.flavour, ''), 'awx'), r.type) " +
        "WHERE j.runner_kind IS NULL AND j.runner IS NOT NULL"
    )
    .then((res) => `filled the runner kind of ${res?.affectedRows ?? 0} job(s)`);
}

// Idempotent by its WHERE clause : only a credential without a type gets one - database for
// a database one, else userpass, a user and a password : what a credential from 6 is, mostly a
// REST login (it used to become ssh).
//
// Only a MISSING type (NULL or empty), never one outside a list kept here : this ran on every
// boot with the types of 7.0 written out (NOT IN ('userpass', ... 'oidc')), so every
// credential of a type added later (rte, awx, aap, ascender, semaphore, rundeck, jenkins,
// vault in 7.3) was turned back into a userpass one at each start. The API validates the
// type on every write (Credential.TYPES), so a type that is set is a valid one.
function fillCredentialTypes() {
  return mysql
    .do("UPDATE AnsibleForms.`credentials` SET credential_type=IF(is_database,'database','userpass') WHERE credential_type IS NULL OR credential_type = ''")
    .then((res) => `Set the type of ${res?.affectedRows ?? 0} credential(s)`);
}

// Idempotent by its WHERE clause : a row is copied once, and never over a store chosen since
function copyVaultPathToSecretRef() {
  return mysql
    .do("UPDATE AnsibleForms.`credentials` SET secret_store='vault', secret_ref=vault_path WHERE vault_path IS NOT NULL AND vault_path<>'' AND (secret_store IS NULL OR secret_store='')")
    .then((res) => {
      const n = res?.affectedRows || 0;
      const message = n ? `pointed ${n} credential(s) with a vault_path at the secret store 'vault'` : "No credential vault_path left to copy";
      if (n) logger.warning(message); else logger.debug(message);
      return message;
    });
}

/**
 * Copies every AWX connection into runners (type awx), then drops the awx table. Idempotent :
 * a row is copied once (by name), and with no awx table left there is nothing to do. Both
 * tables encrypt password and token with the same key, so the ciphertext is copied as is.
 * A name already taken by a runner of ANOTHER type cannot be copied : then the awx table is
 * kept (nothing is lost) and the log says which name to change ; the next start retries.
 */
export async function copyAwxToRunners() {
  if (!(await tablePresent("awx"))) return "No awx table left to copy";
  const copied = await mysql.do(
    "INSERT INTO AnsibleForms.`runners` (name, type, description, uri, token, username, password, use_credentials, ignore_certs, ca_bundle, is_default, managed) " +
    "SELECT a.name, 'awx', a.description, a.uri, NULLIF(a.token,''), NULLIF(a.username,''), NULLIF(a.password,''), COALESCE(a.use_credentials,0), COALESCE(a.ignore_certs,0), a.ca_bundle, COALESCE(a.is_default,0), COALESCE(a.managed,0) " +
    "FROM AnsibleForms.`awx` a WHERE a.name IS NOT NULL AND NOT EXISTS (SELECT 1 FROM AnsibleForms.`runners` r WHERE r.name = a.name)"
  );
  const blocked = await mysql.do(
    "SELECT a.name FROM AnsibleForms.`awx` a LEFT JOIN AnsibleForms.`runners` r ON r.name = a.name AND r.type = 'awx' WHERE r.id IS NULL"
  );
  if (blocked.length) {
    const names = blocked.map((b) => b.name || "(no name)").join(", ");
    const message = `AWX connection(s) ${names} could not move to runners: a runner of another type has that name, or the connection has none. Rename it ; the awx table is kept until then`;
    logger.error(message);
    return message;
  }
  await dropTable("awx");
  const n = copied?.affectedRows || 0;
  const message = n ? `Moved ${n} AWX connection(s) to runners (type awx) and dropped the awx table` : "Dropped the awx table, its connections were already runners";
  logger.warning(message);
  return message;
}

/**
 * The mail servers of a 7 release candidate (the mail_servers table, before notification
 * channels) moved to notification channels of type mail, then their table dropped : only once
 * every one of them is there (one named like a channel already there is not copied over it,
 * and the table is kept, said in the log). Idempotent : nothing to do without the table.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveMailServersToChannels() {
  const exists = await mysql.do("SHOW TABLES FROM AnsibleForms LIKE 'mail_servers'");
  if (!exists.length) return null;
  const copied = await mysql.do(
    "INSERT INTO AnsibleForms.`notification_channels` (name, description, type, enabled, is_active, server, port, secure, from_address, credential, managed) " +
      "SELECT m.name, m.description, 'mail', 1, m.is_active, m.server, m.port, m.secure, m.from_address, m.credential, m.managed FROM AnsibleForms.`mail_servers` m " +
      "WHERE NOT EXISTS (SELECT 1 FROM AnsibleForms.`notification_channels` c WHERE c.name = m.name)",
  );
  // every one of them a mail channel now : the table goes ; else it stays, and says why
  const left = await mysql.do(
    "SELECT m.name FROM AnsibleForms.`mail_servers` m WHERE NOT EXISTS " +
      "(SELECT 1 FROM AnsibleForms.`notification_channels` c WHERE c.name = m.name AND c.type = 'mail')",
  );
  if (left.length) {
    const message = `Mail server(s) ${left.map((r) => r.name).join(", ")} could not move to notification channels: a channel of another type has that name. Rename it ; the mail_servers table is kept until then`;
    logger.error(message);
    return message;
  }
  await dropTable("mail_servers");
  const n = copied?.affectedRows || 0;
  const message = n ? `Moved ${n} mail server(s) to notification channels (type mail) and dropped the mail_servers table` : "Dropped the mail_servers table, its servers were already notification channels";
  logger.warning(message);
  return message;
}

/**
 * The mail settings as the first mail channel, active, their login an smtp credential.
 * Not on a seeded instance : the seed owns the mail settings, which stay what it sends with.
 *
 * Once, and only once : the settings' mail server, user and password are emptied in the same
 * transaction as the copy. It used to key only on "no mail channel yet", with the settings left
 * as they were - so an admin who deleted the channel 'default' got it back at the next restart,
 * every restart. The copy, the credential and the emptying apply together or not at all, so a
 * crash in between can neither lose the settings nor copy them twice.
 *
 * A channel already named 'default' (a Slack or Teams one made by hand) is never overwritten :
 * the insert would fail on its unique name and fail the whole patch at every start. The settings
 * are then left as they are (the mail still goes out through them while no mail channel is
 * active) and the log says what to rename.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function copyMailSettingsToServers() {
  const servers = await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`notification_channels` WHERE type = 'mail'");
  if (servers[0]?.n) return null;
  const rows = await mysql.do("SELECT * FROM AnsibleForms.`settings` LIMIT 1");
  const s = rows[0];
  if (!s?.mail_server || s.managed) return null;
  // the name it takes is somebody's already : skipped, said once per start
  const named = await mysql.do("SELECT type FROM AnsibleForms.`notification_channels` WHERE name = 'default'");
  if (named.length) {
    const message = `The mail settings were not copied to a mail channel: a ${named[0].type} channel is named 'default' already. Rename it and restart, or add a mail channel under Connections > Notifications`;
    logger.warning(message);
    return message;
  }
  let credential = null;
  await mysql.transaction(async (query) => {
    if (s.mail_username) {
      // the password is copied as it is stored : the same key encrypts both tables ; a
      // credential already named mail-login (made by hand) is never taken over
      credential = await freeCredentialName("mail-login", query);
      await query(
        "INSERT INTO AnsibleForms.`credentials` (name, user, password, description, is_database, credential_type) VALUES (?, ?, ?, 'The login of the mail server (from the mail settings)', 0, 'smtp')",
        [credential, s.mail_username, s.mail_password || null],
      );
    }
    await query(
      "INSERT INTO AnsibleForms.`notification_channels` (name, description, type, enabled, server, port, secure, from_address, credential, is_active) VALUES (?, ?, 'mail', 1, ?, ?, ?, ?, ?, 1)",
      ["default", "From the mail settings", s.mail_server, s.mail_port || null, s.mail_secure ? 1 : 0, s.mail_from || null, credential],
    );
    // copied : the settings no longer send, nor copy again ('' : what a fresh install has)
    await query("UPDATE AnsibleForms.`settings` SET mail_server = '', mail_username = '', mail_password = ''");
  });
  return "Copied the mail settings to the mail channel 'default'" + (credential ? `, its login to the credential '${credential}'` : "");
}

/**
 * A credential name not taken yet : the one asked for, else with -2, -3... after it.
 *
 * Args:
 *   name (string): the name wanted.
 *   query (function): what runs the lookups ; the move's transaction (mysql.transaction hands
 *     one over), so the name is checked on the connection that inserts it. mysql.do when none.
 *
 * Returns:
 *   Promise<string>: a free name.
 */
async function freeCredentialName(name, query = (sql, params) => mysql.do(sql, params)) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const taken = await query("SELECT 1 FROM AnsibleForms.`credentials` WHERE name = ?", [candidate]);
    if (!taken.length) return candidate;
  }
}

/**
 * The server, port and TLS of each mail channel moved to its smtp credential, with its login :
 * where it sends and as whom are one credential, as an SSH or a database one holds its host.
 *   - its credential has no server yet : the channel's goes into it
 *   - it has the same one : nothing to copy
 *   - it has another (two channels shared one login, each its server) : a copy of the credential
 *     with the channel's server, the channel then names the copy
 *   - no credential (a relay, no login) : a new smtp credential, <channel>-smtp, without a user
 * The channel's own then emptied. Not a seeded channel : the seed owns it, and its own server is
 * still used while its credential has none. Idempotent : only a channel with a server left.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveMailServersToCredentials() {
  const channels = await mysql.do(
    "SELECT id, name, server, port, secure, credential FROM AnsibleForms.`notification_channels` " +
      "WHERE type = 'mail' AND COALESCE(managed, 0) = 0 AND server IS NOT NULL AND server <> ''",
  );
  if (!channels.length) return null;
  const done = [];
  for (const c of channels) {
    // one transaction per record : the credential and the record that names it are written
    // together or not at all. A crash in between used to leave a credential nothing named,
    // and the next start made a second one (-2) beside it
    await mysql.transaction(async (query) => {
      const server = String(c.server).trim();
      const port = c.port || null;
      const secure = c.secure ? 1 : 0;
      const creds = c.credential ? await query("SELECT * FROM AnsibleForms.`credentials` WHERE name = ?", [c.credential]) : [];
      const cred = creds[0];
      let name = cred?.name || null;
      if (cred && !String(cred.host || "").trim()) {
        await query("UPDATE AnsibleForms.`credentials` SET host = ?, port = ?, secure = ? WHERE id = ?", [server, port, secure, cred.id]);
        done.push(`${c.name} into ${name}`);
      } else if (cred && (String(cred.host).trim() !== server || (cred.port || null) !== port || (cred.secure ? 1 : 0) !== secure)) {
        // a copy : its login (stored encrypted, the same key for both rows) and the channel's server
        name = await freeCredentialName(`${cred.name}-${c.name}`, query);
        await query(
          "INSERT INTO AnsibleForms.`credentials` (name, user, password, description, is_database, credential_type, secret_store, secret_ref, host, port, secure) " +
            "SELECT ?, user, password, ?, 0, 'smtp', secret_store, secret_ref, ?, ?, ? FROM AnsibleForms.`credentials` WHERE id = ?",
          [name, `The login of ${cred.name}, with the server of the mail channel ${c.name}`, server, port, secure, cred.id],
        );
        done.push(`${c.name} into a copy of ${cred.name}, ${name}`);
      } else if (!cred) {
        name = await freeCredentialName(`${c.name}-smtp`, query);
        await query(
          "INSERT INTO AnsibleForms.`credentials` (name, description, is_database, credential_type, host, port, secure) VALUES (?, ?, 0, 'smtp', ?, ?, ?)",
          [name, `The server of the mail channel ${c.name}`, server, port, secure],
        );
        done.push(`${c.name} into ${name}`);
      }
      await query("UPDATE AnsibleForms.`notification_channels` SET server = NULL, port = NULL, secure = 0, credential = ? WHERE id = ?", [name, c.id]);
    });
  }
  const message = `Moved the server of ${channels.length} mail channel(s) to their smtp credential${done.length ? ` (${done.join(", ")})` : ""}`;
  logger.notice(message);
  return message;
}

/**
 * The announcements' switch of before (Settings > Appearance > Announcements, all of them shown
 * or hidden) on each announcement : switched off, every announcement is disabled, and the switch
 * is set back on, so this runs once. Idempotent : only while the switch is off.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveBannerSwitchToAnnouncements() {
  const rows = await mysql.do("SELECT banner_show FROM AnsibleForms.`settings` LIMIT 1");
  if (!rows.length || rows[0].banner_show !== 0) return null;
  const res = await mysql.do("UPDATE AnsibleForms.`announcements` SET enabled = 0");
  await mysql.do("UPDATE AnsibleForms.`settings` SET banner_show = 1");
  const message = `Announcements were hidden: disabled ${res.affectedRows || 0} announcement(s), each now enabled on its own`;
  logger.notice(message);
  return message;
}

/**
 * The client of each SSO provider in a credential of its type, with its tenant (Entra ID) or its
 * issuer (Open ID) and its redirect URL : the app registration at the identity provider is one
 * credential, as a mail channel's server and login are.
 *   - a provider with its own client (from before credentials) : a new credential of its type,
 *     named after it, its user the client id, its password the client secret (copied as stored :
 *     the same key encrypts both tables)
 *   - a provider with a credential : its tenant or issuer, and its redirect URL, copied into it
 *     when it has none
 * The provider's own client, tenant, issuer and redirect URL then emptied. Not a seeded provider : the seed owns
 * it, and its own are still used while it has no credential. Idempotent : only a provider with
 * its own client, tenant, issuer or redirect URL left.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveSsoClientsToCredentials() {
  const providers = await mysql.do(
    "SELECT id, name, provider, tenant_id, issuer, redirect_uri, client_id, client_secret, credential FROM AnsibleForms.`oauth2_providers` " +
      "WHERE COALESCE(managed, 0) = 0 AND (COALESCE(client_id, '') <> '' OR COALESCE(tenant_id, '') <> '' OR COALESCE(issuer, '') <> '' OR COALESCE(redirect_uri, '') <> '')",
  );
  if (!providers.length) return null;
  const done = [];
  for (const p of providers) {
    // one transaction per record : the credential and the record that names it are written
    // together or not at all. A crash in between used to leave a credential nothing named,
    // and the next start made a second one (-2) beside it
    await mysql.transaction(async (query) => {
      const type = p.provider === "azuread" ? "entraid" : "oidc";
      const tenant = type === "entraid" ? p.tenant_id || null : null;
      const issuer = type === "oidc" ? p.issuer || null : null;
      let name = p.credential || null;
      if (name) {
        // its credential : the tenant or the issuer it lacks
        const column = type === "entraid" ? "tenant_id" : "issuer";
        const value = type === "entraid" ? tenant : issuer;
        if (value) {
          await query(`UPDATE AnsibleForms.\`credentials\` SET ${column} = ? WHERE name = ? AND (${column} IS NULL OR ${column} = '')`, [value, name]);
        }
        if (p.redirect_uri) {
          await query("UPDATE AnsibleForms.`credentials` SET redirect_uri = ? WHERE name = ? AND (redirect_uri IS NULL OR redirect_uri = '')", [p.redirect_uri, name]);
        }
        done.push(`${p.name} kept ${name}`);
      } else if (p.client_id) {
        const slug = String(p.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || type;
        name = await freeCredentialName(`${slug}-sso`, query);
        await query(
          "INSERT INTO AnsibleForms.`credentials` (name, user, password, description, is_database, credential_type, tenant_id, issuer, redirect_uri) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
          [name, p.client_id, p.client_secret || null, `The client of the SSO provider ${p.name}`, type, tenant, issuer, p.redirect_uri || null],
        );
        done.push(`${p.name} into ${name}`);
      } else {
        // no client and no credential : nothing signs in with it yet ; its own kept for when one is
        // chosen
        return;
      }
      await query(
        "UPDATE AnsibleForms.`oauth2_providers` SET client_id = NULL, client_secret = NULL, tenant_id = NULL, issuer = NULL, redirect_uri = NULL, credential = ? WHERE id = ?",
        [name, p.id],
      );
    });
  }
  if (!done.length) return null;
  const message = `Moved the client of ${done.length} SSO provider(s) to credentials (${done.join(", ")})`;
  logger.notice(message);
  return message;
}

/**
 * The token, user and password of each runner moved to a credential of Connections > Credentials,
 * as every connection's : a new one, <runner>-token or <runner>-login, its secrets copied as
 * stored (the same key encrypts both tables), the runner then names it.
 *   - an RTE, a Semaphore, a Rundeck, an AWX with its token : an api credential, its password the
 *     token
 *   - an AWX with a user and password : a userpass credential
 *   - a Jenkins : a userpass credential, its user and the user's API token
 * The runner's own then emptied. Not a seeded runner (the seed owns it), nor one its RTE registered
 * (its registration writes its token) : their own are still used. Idempotent : only a runner
 * without a credential and with a secret of its own left.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveRunnerSecretsToCredentials() {
  const runners = await mysql.do(
    "SELECT id, name, type, token, username, password, use_credentials FROM AnsibleForms.`runners` " +
      "WHERE COALESCE(managed, 0) = 0 AND node_id IS NULL AND COALESCE(credential, '') = '' " +
      "AND (COALESCE(token, '') <> '' OR COALESCE(password, '') <> '')",
  );
  if (!runners.length) return null;
  const done = [];
  for (const r of runners) {
    // one transaction per record : the credential and the record that names it are written
    // together or not at all. A crash in between used to leave a credential nothing named,
    // and the next start made a second one (-2) beside it
    await mysql.transaction(async (query) => {
      const login = r.type === "jenkins" || (r.type === "awx" && r.use_credentials);
      const name = await freeCredentialName(`${r.name}-${login ? "login" : "token"}`, query);
      await query("INSERT INTO AnsibleForms.`credentials` SET ?", [
        {
          name,
          user: login ? r.username || null : null,
          // a Jenkins' password is its user's API token ; an AWX's with a login its password
          password: r.type === "jenkins" ? r.token || null : login ? r.password || null : r.token || null,
          description: `The ${login ? "login" : "token"} of the runner ${r.name}`,
          is_database: 0,
          credential_type: login ? "userpass" : "api",
        },
      ]);
      await query("UPDATE AnsibleForms.`runners` SET token = NULL, password = NULL, credential = ? WHERE id = ?", [name, r.id]);
      done.push(`${r.name} into ${name}`);
    });
  }
  const message = `Moved the token or login of ${runners.length} runner(s) to credentials (${done.join(", ")})`;
  logger.notice(message);
  return message;
}

// the credential types a secret store's or a runner's address moved into, before they got a type
// of their own (retypeConnectionCredentials)
const URL_TYPES = ["api", "userpass", "cyberark"];

/**
 * The address and TLS of each secret store, and of each runner (an RTE too), moved to its
 * credential : a login that works on one server carries that server, as a mail channel's or an
 * LDAP directory's credential does.
 *   - its credential has no address yet : the record's goes into it
 *   - it has the same one : nothing to copy
 *   - it has another (two records shared one login, each its server), or it is of a type without
 *     an address : a copy of the credential with the record's address, the record then names the
 *     copy
 *   - no credential : a new one, <record>-token (a Vault's token, a runner's), or
 *     <record>-appid (a CyberArk's AppID and client certificate and key), its secrets copied as
 *     stored (the same key encrypts all tables)
 * The record's own address and TLS then emptied (the columns are NOT NULL : ''). Not a seeded
 * record : the seed owns it, and its own address is still used while its credential has none.
 * Not an RTE that registered itself : it writes its own address and token. An RTE added by hand
 * keeps its address as well (its credential's is the one used) : an RTE still on 7.2 finds its
 * runner by that address, and would otherwise register itself as a second runner. Idempotent :
 * only a record with an address left, an RTE only while its credential has not that address.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveConnectionsToCredentials() {
  const kinds = [
    {
      label: "secret store",
      table: "secret_stores",
      column: "url",
      rows: await mysql.do(
        "SELECT id, name, type, url AS address, token, app_id, client_cert, client_key, ignore_certs, ca_bundle, credential FROM AnsibleForms.`secret_stores` " +
          "WHERE COALESCE(managed, 0) = 0 AND COALESCE(url, '') <> ''",
      ),
    },
    {
      label: "runner",
      table: "runners",
      column: "uri",
      rows: await mysql.do(
        "SELECT id, name, type, uri AS address, token, ignore_certs, ca_bundle, credential FROM AnsibleForms.`runners` " +
          "WHERE COALESCE(managed, 0) = 0 AND node_id IS NULL AND COALESCE(uri, '') <> ''",
      ),
    },
  ];
  // an RTE whose credential has its address already : moved before (it keeps its own, above)
  const credUrls = new Map(
    ((await mysql.do("SELECT name, url FROM AnsibleForms.`credentials`")) || []).map((c) => [c.name, String(c.url || "").trim().replace(/\/+$/, "")]),
  );
  const runnersKind = kinds.find((k) => k.table === "runners");
  runnersKind.rows = (runnersKind.rows || []).filter(
    (r) => !(r.type === "rte" && r.credential && credUrls.get(r.credential) === String(r.address).trim().replace(/\/+$/, "")),
  );
  if (!kinds.some((k) => k.rows.length)) return null;
  const done = [];
  for (const kind of kinds) {
    for (const r of kind.rows) {
      // one transaction per record : the credential and the record that names it are written
      // together or not at all. A crash in between used to leave a credential nothing named,
      // and the next start made a second one (-2) beside it
      await mysql.transaction(async (query) => {
        const c = {
          url: String(r.address).trim().replace(/\/+$/, ""),
          ignore_certs: r.ignore_certs ? 1 : 0,
          ca_bundle: r.ca_bundle || null,
        };
        const creds = r.credential ? await query("SELECT * FROM AnsibleForms.`credentials` WHERE name = ?", [r.credential]) : [];
        const cred = creds[0];
        let name = cred?.name || null;
        // its own secrets moved with it : emptied on the record too
        let ownSecrets = false;
        if (cred && URL_TYPES.includes(cred.credential_type) && !String(cred.url || "").trim()) {
          await query("UPDATE AnsibleForms.`credentials` SET ? WHERE id = ?", [c, cred.id]);
          done.push(`${r.name} into ${name}`);
        } else if (cred && (!URL_TYPES.includes(cred.credential_type) || String(cred.url).trim() !== c.url)) {
          // a copy : its login (stored encrypted, the same key for both rows) and the record's address
          name = await freeCredentialName(`${cred.name}-${r.name}`, query);
          const type = URL_TYPES.includes(cred.credential_type) ? cred.credential_type : "api";
          await query(
            "INSERT INTO AnsibleForms.`credentials` (name, user, password, description, is_database, credential_type, secret_store, secret_ref, client_cert, client_key, url, ignore_certs, ca_bundle) " +
              "SELECT ?, user, password, ?, 0, ?, secret_store, secret_ref, client_cert, client_key, ?, ?, ? FROM AnsibleForms.`credentials` WHERE id = ?",
            [name, `The login of ${cred.name}, with the address of the ${kind.label} ${r.name}`, type, c.url, c.ignore_certs, c.ca_bundle, cred.id],
          );
          done.push(`${r.name} into a copy of ${cred.name}, ${name}`);
        } else if (!cred) {
          const cyberark = r.type === "cyberark_ccp";
          name = await freeCredentialName(`${r.name}-${cyberark ? "appid" : "token"}`, query);
          await query("INSERT INTO AnsibleForms.`credentials` SET ?", [
            {
              name,
              user: cyberark ? r.app_id || null : null,
              password: cyberark ? null : r.token || null,
              client_cert: cyberark ? r.client_cert || null : null,
              client_key: cyberark ? r.client_key || null : null,
              description: `The ${cyberark ? "AppID" : "token"} and address of the ${kind.label} ${r.name}`,
              is_database: 0,
              credential_type: cyberark ? "cyberark" : "api",
              ...c,
            },
          ]);
          ownSecrets = true;
          done.push(`${r.name} into ${name}`);
        }
        const cleared = { [kind.column]: "", ignore_certs: 0, ca_bundle: null, credential: name };
        // an RTE keeps its address : one still on 7.2 finds its runner by it (see above)
        if (kind.table === "runners" && r.type === "rte") delete cleared[kind.column];
        if (ownSecrets) {
          Object.assign(cleared, kind.table === "secret_stores" ? { token: null, app_id: null, client_cert: null, client_key: null } : { token: null });
        }
        await query(`UPDATE AnsibleForms.\`${kind.table}\` SET ? WHERE id = ?`, [cleared, r.id]);
      });
    }
  }
  const count = kinds.reduce((n, k) => n + k.rows.length, 0);
  const message = `Moved the address of ${count} secret store(s) and runner(s) to their credential${done.length ? ` (${done.join(", ")})` : ""}`;
  logger.notice(message);
  return message;
}

/**
 * The type a runner's or a secret store's credential is of : the runner's kind (an awx runner's its
 * flavour, AWX when none), a Vault's vault, a CyberArk's cyberark.
 *
 * Args:
 *   record (object): { table, type, flavour }.
 *
 * Returns:
 *   string: the credential type.
 */
function connectionCredentialType(record) {
  if (record.table === "secret_stores") return record.type === "cyberark_ccp" ? "cyberark" : "vault";
  return record.type === "awx" ? record.flavour || "awx" : record.type;
}

/**
 * The credentials of the secret stores and runners given the type of their kind : rte, awx, aap,
 * ascender, semaphore, rundeck, jenkins or vault (a CyberArk's is cyberark already), as a mail
 * channel's is smtp. Where it says what to fill in (a token, a user and its API token) and its
 * server is required.
 *   - used by records of one kind only : its type becomes that kind
 *   - used by records of several kinds, or by something else that checks its type (a notification
 *     channel, a repository, an LDAP directory, an SSO provider, the chat assistant) : a copy of it
 *     for each kind but the one it keeps, <credential>-<kind>, which those records then name
 * A credential of the config seed is left as it is : the seed declares its type. Forms and workflows
 * name credentials without a type : not concerned. Idempotent : only a credential of another type
 * than its records' kind.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
/**
 * Renames the LDAP directory named "default" (up to 7.2) to "main" (DEFAULT_NAME) : the one whose
 * members keep their short names, so no role, group or user name changes. Only when no
 * directory is named "main" yet ; the column's default follows.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
/**
 * Gives the LDAP directories that share a name distinct ones, before the unique key on the name
 * is added : the table was single-row by design up to 7.2, without a key, so a database could
 * hold several rows, and the name column a patch adds names every one of them 'default'. The
 * first (lowest id) keeps its name, the others get -<id> after it (-<id>-2 ... when that is
 * taken). Not once the key is there : a name can not be shared then.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function dedupeLdapNames() {
  const key = await mysql.do("SHOW INDEX FROM ??.?? WHERE Key_name = ?", ["AnsibleForms", "ldap", "unique_name"]);
  if (key.length) return null;
  const rows = await mysql.do("SELECT id, name FROM AnsibleForms.`ldap` ORDER BY id");
  const taken = new Set(rows.map((r) => r.name));
  const seen = new Set();
  const renamed = [];
  for (const r of rows) {
    if (!seen.has(r.name)) {
      seen.add(r.name);
      continue;
    }
    let name = `${r.name}-${r.id}`;
    for (let n = 2; taken.has(name); n++) name = `${r.name}-${r.id}-${n}`;
    taken.add(name);
    await mysql.do("UPDATE AnsibleForms.`ldap` SET name = ? WHERE id = ?", [name, r.id]);
    renamed.push(`${r.id} to '${name}'`);
  }
  if (!renamed.length) return null;
  const message = `LDAP directories shared a name: renamed ${renamed.join(", ")} so the name can be unique`;
  logger.warning(message);
  return message;
}

export async function renameDefaultLdap() {
  const rows = await mysql.do("SELECT name FROM AnsibleForms.`ldap` WHERE name IN (?, ?)", [LEGACY_DEFAULT_LDAP, DEFAULT_LDAP]);
  const names = new Set(rows.map((r) => r.name));
  await mysql.do(`ALTER TABLE AnsibleForms.\`ldap\` ALTER COLUMN \`name\` SET DEFAULT '${DEFAULT_LDAP}'`);
  if (!names.has(LEGACY_DEFAULT_LDAP) || names.has(DEFAULT_LDAP)) return null;
  await mysql.do("UPDATE AnsibleForms.`ldap` SET name = ? WHERE name = ?", [DEFAULT_LDAP, LEGACY_DEFAULT_LDAP]);
  return `LDAP directory '${LEGACY_DEFAULT_LDAP}' renamed to '${DEFAULT_LDAP}'`;
}

// the schema_migrations row that says the credentials of the secret stores and runners were
// given the type of their kind (retypeConnectionCredentials) : once, never again after
const RETYPE_MARKER = "retype_connection_credentials";

// the credential types of one product line : an awx runner is an AWX, an AAP or an Ascender
// (its flavour), and the three speak the same API with the same login. A credential of any of
// them serves a runner of any other : never retyped, nor split, within the family
const AWX_FAMILY = new Set(["awx", "aap", "ascender"]);

/**
 * The family a credential type belongs to, for the comparison in retypeConnectionCredentials :
 * awx for awx, aap and ascender (AWX_FAMILY), the type itself for any other.
 *
 * Args:
 *   type (string|null): a credential type, or a runner's or a secret store's kind.
 *
 * Returns:
 *   string|null: the family.
 */
function credentialFamily(type) {
  return AWX_FAMILY.has(type) ? "awx" : type;
}

export async function retypeConnectionCredentials() {
  // step 1 : once only. It ran at every start, so an admin who chose another type (an aap
  // credential for an awx runner, the same product line) had it rewritten at the next restart
  const marker = await mysql.do("SELECT 1 FROM AnsibleForms.`schema_migrations` WHERE name = ?", [RETYPE_MARKER]);
  if (marker.length) return null;
  // step 2 : the records that name a credential
  const stores = await mysql.do("SELECT id, type, NULL AS flavour, credential FROM AnsibleForms.`secret_stores` WHERE COALESCE(credential, '') <> ''");
  const runners = await mysql.do("SELECT id, type, flavour, credential FROM AnsibleForms.`runners` WHERE COALESCE(credential, '') <> ''");
  const records = [...stores.map((r) => ({ ...r, table: "secret_stores" })), ...runners.map((r) => ({ ...r, table: "runners" }))];
  const done = [];
  if (records.length) await retypeRecords(records, done);
  // step 6 : recorded, also when there was nothing to retype (a fresh install) : a runner or a
  // credential an admin adds later is theirs, never retyped. Not reached when a transaction
  // failed : the next start tries again
  await mysql.do("INSERT IGNORE INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES (?, ?, NOW())", [RETYPE_MARKER, appVersion]);
  if (!done.length) return null;
  const message = `Gave the credentials of the secret stores and runners the type of their kind (${done.join(", ")})`;
  logger.notice(message);
  return message;
}

/**
 * The work of retypeConnectionCredentials, once its marker said it had not run : each credential
 * the records name given their kind, or copied per family of kinds.
 *
 * Args:
 *   records (object[]): the secret stores and runners that name a credential, each with its table.
 *   done (string[]): what was done, appended to.
 *
 * Returns:
 *   Promise<void>
 */
async function retypeRecords(records, done) {
  const others = new Set(
    (
      await mysql.do(
        "SELECT credential AS name FROM AnsibleForms.`notification_channels` UNION SELECT token_credential FROM AnsibleForms.`notification_channels` " +
          "UNION SELECT credential FROM AnsibleForms.`repositories` UNION SELECT credential FROM AnsibleForms.`ldap` " +
          "UNION SELECT credential FROM AnsibleForms.`oauth2_providers` UNION SELECT credential FROM AnsibleForms.`chat_settings`",
      )
    ).map((r) => r.name),
  );
  const byCredential = new Map();
  for (const r of records) {
    if (!byCredential.has(r.credential)) byCredential.set(r.credential, []);
    byCredential.get(r.credential).push(r);
  }
  for (const [credName, users] of byCredential) {
    // one transaction per credential : its new type, its copies and the records that name
    // them are written together or not at all. A crash in between used to leave a copy nothing
    // named, and the next start made a second one (-2) beside it
    await mysql.transaction(async (query) => {
      const cred = (await query("SELECT * FROM AnsibleForms.`credentials` WHERE name = ?", [credName]))[0];
      if (!cred || cred.managed) return;
      // step 3 : the families its records are of, each with the first kind seen in it (the type
      // a copy for that family gets) : an AWX and an AAP runner sharing one login are one
      // family, served by one credential, and an aap credential serves an awx runner as it is
      const families = new Map();
      for (const u of users) {
        const kind = connectionCredentialType(u);
        if (!families.has(credentialFamily(kind))) families.set(credentialFamily(kind), kind);
      }
      if (families.size === 1 && families.has(credentialFamily(cred.credential_type))) return;
      // step 4 : the type it keeps : its records' kind when they are all of one family and
      // nothing else checks it
      const keeps = families.size === 1 && !others.has(credName) ? [...families.values()][0] : cred.credential_type;
      if (keeps !== cred.credential_type) {
        await query("UPDATE AnsibleForms.`credentials` SET credential_type = ?, is_database = 0 WHERE id = ?", [keeps, cred.id]);
        done.push(`${credName} is ${keeps}`);
      }
      // step 5 : a copy for each other family, which the records of that family then name
      for (const [family, kind] of families) {
        if (family === credentialFamily(keeps)) continue;
        // a copy : its login (stored encrypted, the same key for both rows), its server and TLS
        const copy = await freeCredentialName(`${credName}-${kind}`, query);
        await query(
          "INSERT INTO AnsibleForms.`credentials` (name, user, password, description, is_database, credential_type, secret_store, secret_ref, client_cert, client_key, url, ignore_certs, ca_bundle) " +
            "SELECT ?, user, password, ?, 0, ?, secret_store, secret_ref, client_cert, client_key, url, ignore_certs, ca_bundle FROM AnsibleForms.`credentials` WHERE id = ?",
          [copy, `The ${kind} login of ${credName}`, kind, cred.id],
        );
        for (const r of users.filter((u) => credentialFamily(connectionCredentialType(u)) === family)) {
          await query(`UPDATE AnsibleForms.\`${r.table}\` SET credential = ? WHERE id = ?`, [copy, r.id]);
        }
        done.push(`a copy of ${credName} for ${kind}, ${copy}`);
      }
      // kept of a type without a server : the address it was given went with its copies
      if (!["rte", "awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault", "cyberark"].includes(keeps) && cred.url) {
        await query("UPDATE AnsibleForms.`credentials` SET url = NULL WHERE id = ?", [cred.id]);
      }
    });
  }
}

/**
 * The servers, port, TLS and certificates of each LDAP directory moved to its ldap credential,
 * with its bind account : where it connects and as whom are one credential, as a mail channel's.
 *   - its credential has no servers yet : the directory's go into it
 *   - it has the same ones : nothing to copy
 *   - it has others (two directories shared one bind account) : a copy of the credential with the
 *     directory's servers, the directory then names the copy
 *   - no credential (its own bind DN and password) : a new ldap credential, <directory>-ldap, its
 *     user the bind DN, its password the bind password (copied as stored : the same key encrypts
 *     both tables)
 * The directory's own then emptied. Not a seeded directory : the seed owns it, and its own are still
 * used while its credential has none. Idempotent : only a directory with a server left.
 *
 * Returns:
 *   Promise<string|null>: what was done, or null when there was nothing to do.
 */
export async function moveLdapServersToCredentials() {
  const dirs = await mysql.do(
    "SELECT id, name, server, port, enable_tls, ignore_certs, cert, ca_bundle, bind_user_dn, bind_user_pw, credential FROM AnsibleForms.`ldap` " +
      "WHERE COALESCE(managed, 0) = 0 AND server IS NOT NULL AND server <> ''",
  );
  if (!dirs.length) return null;
  const done = [];
  for (const d of dirs) {
    // one transaction per record : the credential and the record that names it are written
    // together or not at all. A crash in between used to leave a credential nothing named,
    // and the next start made a second one (-2) beside it
    await mysql.transaction(async (query) => {
      const c = {
        host: String(d.server).trim(),
        port: d.port || null,
        secure: d.enable_tls ? 1 : 0,
        ignore_certs: d.ignore_certs ? 1 : 0,
        client_cert: d.cert || null,
        ca_bundle: d.ca_bundle || null,
      };
      const creds = d.credential ? await query("SELECT * FROM AnsibleForms.`credentials` WHERE name = ?", [d.credential]) : [];
      const cred = creds[0];
      let name = cred?.name || null;
      if (cred && !String(cred.host || "").trim()) {
        await query("UPDATE AnsibleForms.`credentials` SET ? WHERE id = ?", [c, cred.id]);
        done.push(`${d.name} into ${name}`);
      } else if (cred && (String(cred.host).trim() !== c.host || (cred.port || null) !== c.port || (cred.secure ? 1 : 0) !== c.secure)) {
        name = await freeCredentialName(`${cred.name}-${d.name}`, query);
        await query(
          "INSERT INTO AnsibleForms.`credentials` (name, user, password, description, is_database, credential_type, secret_store, secret_ref, host, port, secure, ignore_certs, client_cert, ca_bundle) " +
            "SELECT ?, user, password, ?, 0, 'ldap', secret_store, secret_ref, ?, ?, ?, ?, ?, ? FROM AnsibleForms.`credentials` WHERE id = ?",
          [name, `The bind account of ${cred.name}, with the servers of the LDAP directory ${d.name}`, c.host, c.port, c.secure, c.ignore_certs, c.client_cert, c.ca_bundle, cred.id],
        );
        done.push(`${d.name} into a copy of ${cred.name}, ${name}`);
      } else if (!cred) {
        name = await freeCredentialName(`${d.name}-ldap`, query);
        await query("INSERT INTO AnsibleForms.`credentials` SET ?", [
          {
            name,
            user: d.bind_user_dn || null,
            password: d.bind_user_pw || null,
            description: `The servers and bind account of the LDAP directory ${d.name}`,
            is_database: 0,
            credential_type: "ldap",
            ...c,
          },
        ]);
        done.push(`${d.name} into ${name}`);
      }
      await query(
        "UPDATE AnsibleForms.`ldap` SET server = NULL, port = NULL, enable_tls = 0, ignore_certs = 0, cert = NULL, ca_bundle = NULL, credential = ? WHERE id = ?",
        [name, d.id],
      );
    });
  }
  const message = `Moved the servers of ${dirs.length} LDAP directory(ies) to their ldap credential${done.length ? ` (${done.join(", ")})` : ""}`;
  logger.notice(message);
  return message;
}

// the tables 7.0.0 drops : their presence means an upgrade is pending
const LEGACY_TABLES = ["staging", "datasource", "datasource_schemas", "awx", "azuread", "oidc"];

/**
 * Compares two release numbers (7.2.0, 7.3.0-rc.1) on their numeric parts : major, minor,
 * patch. A pre-release suffix is ignored, so 7.3.0-rc.1 and 7.3.0 compare equal : the schema
 * of a release candidate is the release's.
 *
 * Args:
 *   a (string): a release number.
 *   b (string): another.
 *
 * Returns:
 *   number|null: below 0 when a is older, 0 when equal, above 0 when newer ; null when either
 *     is not a release number (a local build reporting "unknown").
 */
export function compareReleases(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
    return m ? m.slice(1, 4).map(Number) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/**
 * Whether the patches have something to change that is worth a backup first :
 *   - a table an upgrade drops (and copies from first) : that loses data
 *   - a schema recorded by an older release than this one (schema_migrations, row 'schema',
 *     written by recordMigrations after every successful patch run) : a new release moves
 *     data around too (7.3 moves secrets into credentials, retypes them, renames the LDAP
 *     directory), not only adds to it, and there was no way back from that
 *   - a database from before schema_migrations existed (the table is missing) : the same
 *     upgrade, from further back
 *   - a database with the table and no row, whose core tables (users, jobs) are there while the
 *     schema manifest names tables or columns it lacks : a 7.x install whose patches always
 *     failed, so the row was never written
 * A fresh install has the table without the row, and lacks nothing : nothing to back up there, and a backup that
 * cannot run (no mysqldump on a development machine) must not stop its first patch run. The
 * same release starting again finds its own version recorded : no backup on every restart.
 *
 * Returns:
 *   Promise<string[]>: what is pending, for the log ; empty when nothing is.
 */
async function pendingUpgrade() {
  const pending = [];
  // what loses data : the tables an upgrade drops (and copies from first)
  const legacy = await mysql.do(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema='AnsibleForms' AND table_name IN (?)",
    [LEGACY_TABLES]
  );
  pending.push(...legacy.map((r) => `drop ${r.t}`));
  // what a new release moves : the schema an older release recorded
  if (!(await tablePresent("schema_migrations"))) {
    pending.push(`upgrade an unrecorded schema to ${appVersion}`);
    return pending;
  }
  const rows = await mysql.do("SELECT version FROM AnsibleForms.`schema_migrations` WHERE name = 'schema'");
  const recorded = rows?.[0]?.version;
  if (recorded && (compareReleases(recorded, appVersion) ?? 0) < 0) {
    pending.push(`upgrade the schema from ${recorded} to ${appVersion}`);
  }
  // a 7.x database whose patches never completed has no 'schema' row either (recordMigrations
  // runs only after a successful patch run) : it read as a fresh install, and was patched with
  // no backup. A fresh install lacks nothing the manifest names (create_schema_and_tables.sql
  // builds all of it), while that database lacks what its failing patches add, beside the core
  // tables (users, jobs) holding its data. Not with a row of this release : a development build
  // adding a column patches without a backup, as it always did (no dump tool needed there)
  if (!recorded) {
    const missing = await missingOnExistingDatabase();
    if (missing.length) {
      pending.push(`upgrade an unrecorded schema to ${appVersion} (it lacks ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? `, and ${missing.length - 5} more` : ""})`);
    }
  }
  return pending;
}

/**
 * What the schema manifest names that the database lacks (tables and columns, not the indexes :
 * a missing index is slow, not lost data), when it already holds the core tables (users and
 * jobs) : an existing install, not a fresh one.
 *
 * Returns:
 *   Promise<string[]>: the missing tables and columns ; empty for a complete or a fresh schema.
 */
async function missingOnExistingDatabase() {
  const { missingTables, missingColumns, haveTables } = await missingFromManifest(SCHEMA_MANIFEST, mysql);
  if (!haveTables.has("users") || !haveTables.has("jobs")) return [];
  return [...missingTables, ...missingColumns];
}

// the schema_migrations row naming the release the database was last backed up for before an
// upgrade (backupBeforeUpgrade) : one backup per release, however often the patches fail
const UPGRADE_BACKUP_MARKER = "upgrade_backup";

/**
 * Whether the database was backed up before the upgrade to this release already : the
 * UPGRADE_BACKUP_MARKER row names this release. A database without schema_migrations (from
 * before it existed) has no row : not backed up yet.
 *
 * Returns:
 *   Promise<boolean>
 */
async function upgradeBackedUp() {
  if (!(await tablePresent("schema_migrations"))) return false;
  const rows = await mysql.do("SELECT version FROM AnsibleForms.`schema_migrations` WHERE name = ?", [UPGRADE_BACKUP_MARKER]);
  return rows?.[0]?.version === appVersion;
}

/**
 * Records that the database was backed up before the upgrade to this release
 * (UPGRADE_BACKUP_MARKER). Without schema_migrations yet (the patches make it) nothing is
 * recorded : the next start, the patches having run, records it if it backs up again. A failure
 * to record is logged, never fatal : the backup itself succeeded.
 *
 * Returns:
 *   Promise<void>
 */
async function recordUpgradeBackup() {
  try {
    if (!(await tablePresent("schema_migrations"))) return;
    await mysql.do(
      "INSERT INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE version = VALUES(version), applied_at = NOW()",
      [UPGRADE_BACKUP_MARKER, appVersion]
    );
  } catch (err) {
    logger.warning(`Couldn't record the backup before the upgrade to ${appVersion}: ${err.message}`);
  }
}

// a backup that failed is not tried again on every request (an app node checks the schema per
// request until it is complete) : once a minute at most
const BACKUP_RETRY_MS = 60000;
let backupFailedAt = 0;

/**
 * A backup of the database before an upgrade changes it : the patches drop tables and alter
 * others, and there was no way back. The regular backup (Backups page), named after the release.
 * A failed backup stops the upgrade, unless UPGRADE_BACKUP=0.
 *
 * Returns:
 *   Promise<string|null>: what was done, for the patch messages ; null when nothing is pending.
 *
 * Raises:
 *   Error: the backup failed (and UPGRADE_BACKUP is not 0).
 */
async function backupBeforeUpgrade() {
  const pending = await pendingUpgrade();
  if (!pending.length) return null;
  logger.notice(`The database needs upgrading (${pending.slice(0, 8).join(", ")}${pending.length > 8 ? ", ..." : ""})`);
  if (String(process.env.UPGRADE_BACKUP ?? "1").trim() === "0") {
    logger.warning("UPGRADE_BACKUP=0: upgrading the database without a backup first");
    return "Upgrading without a backup (UPGRADE_BACKUP=0)";
  }
  if (Date.now() - backupFailedAt < BACKUP_RETRY_MS) {
    throw new Error("The database needs upgrading, and the backup before it failed less than a minute ago. Fix the backup (MYSQLDUMP_COMMAND, BACKUP_PATH), or set UPGRADE_BACKUP=0 to upgrade without one");
  }
  // backed up once per release : a patch that keeps failing leaves the upgrade pending, and every
  // restart took another full backup of the database, filling the backup folder
  if (await upgradeBackedUp()) {
    logger.notice(`The database was backed up before the upgrade to ${appVersion} already: not again`);
    return `Backed up before the upgrade to ${appVersion} already`;
  }
  const { default: Backup } = await import("./backup.model.js");
  try {
    const { backupFolder } = await Backup.doBackup(`Before the upgrade to ${appVersion}`);
    logger.notice(`Backed up the database before the upgrade: ${backupFolder}`);
    await recordUpgradeBackup();
    return `Backed up the database before the upgrade (${backupFolder})`;
  } catch (err) {
    backupFailedAt = Date.now();
    // not the backup's own message : it can carry the dump command, and the backup logged why
    // it failed already (masked)
    throw new Error("The database needs upgrading, and the backup before it failed (the backup's error is logged above). Fix the backup (MYSQLDUMP_COMMAND, BACKUP_PATH), or set UPGRADE_BACKUP=0 to upgrade without one", { cause: err });
  }
}

/**
 * Records the patches this release applied : the first release that applied each, and the
 * release the schema is at now (row 'schema').
 *
 * Returns:
 *   Promise<void>: settles once recorded.
 */
async function recordMigrations() {
  for (const name of Object.keys(SCHEMA_MANIFEST.patches || {})) {
    await mysql.do("INSERT IGNORE INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES (?, ?, NOW())", [name, appVersion]);
  }
  await mysql.do(
    "INSERT INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES ('schema', ?, NOW()) ON DUPLICATE KEY UPDATE applied_at = IF(version = VALUES(version), applied_at, NOW()), version = VALUES(version)",
    [appVersion]
  );
}

// ---------------------------------------------------------------------------------------
// The ENABLE_SSO and SSO_AUTO_LOGIN variables, removed in 7.3
// ---------------------------------------------------------------------------------------

// the schema_migrations row that says they were imported (recordMigrations writes the others)
const SSO_ENV_MARKER = "sso_env_import";

/**
 * Whether a removed boolean variable is set to an off value : 0, false, no or off.
 *
 * Args:
 *   value (string|undefined): the variable.
 *
 * Returns:
 *   boolean: true when it switches something off.
 */
function envOff(value) {
  return ["0", "false", "no", "off"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * Whether a removed boolean variable is set to an on value : 1, true, yes or on.
 *
 * Args:
 *   value (string|undefined): the variable.
 *
 * Returns:
 *   boolean: true when it switches something on.
 */
function envOn(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * The ENABLE_SSO and SSO_AUTO_LOGIN variables of before 7.3 carried over, once, to the SSO
 * providers that replaced them (each has Enabled and Skip the login page since 7.3) : without
 * this an upgrade dropped them silently, so an instance with SSO switched off as a whole came
 * back with its providers' login buttons, and one that skipped the login page no longer did.
 *   - ENABLE_SSO off (0, false) : every SSO provider disabled
 *   - SSO_AUTO_LOGIN on (1, true) and exactly one provider enabled (what it acted on : the only
 *     active provider) : that provider skips the login page
 * Recorded in schema_migrations (row sso_env_import) in the same transaction, so it runs once :
 * a provider enabled again later is never switched off by the variable still being there. While
 * either variable is set, every start says it is ignored and where it is configured now.
 * Nothing is recorded while neither is set (a fresh install, an instance that never used them).
 *
 * Args:
 *   options (object): { env } - the environment, for tests.
 *
 * Returns:
 *   Promise<string>: "none" (neither variable set), "imported" or "ignored" (imported before).
 */
export async function importSsoEnvOnce({ env = process.env } = {}) {
  const enableSso = env.ENABLE_SSO;
  const autoLogin = env.SSO_AUTO_LOGIN;
  const isSet = (v) => v !== undefined && String(v).trim() !== "";
  if (!isSet(enableSso) && !isSet(autoLogin)) return "none";
  const notice = "ENABLE_SSO and SSO_AUTO_LOGIN are no longer read since 7.3: single sign-on is configured per provider under Settings > SSO (Enabled, Skip the login page) - remove them from the environment";
  const marker = await mysql.do("SELECT 1 FROM AnsibleForms.`schema_migrations` WHERE name = ?", [SSO_ENV_MARKER]);
  if (marker.length) {
    logger.warning(notice);
    return "ignored";
  }
  const done = [];
  await mysql.transaction(async (query) => {
    // SSO switched off as a whole : every provider's login button goes
    if (envOff(enableSso)) {
      const res = await query("UPDATE AnsibleForms.`oauth2_providers` SET enable = 0 WHERE enable <> 0");
      done.push(`ENABLE_SSO=${enableSso} disabled ${res?.affectedRows ?? 0} SSO provider(s)`);
    }
    // the login page went straight to the only active provider : that one skips it now
    if (envOn(autoLogin)) {
      const enabled = await query("SELECT id, name FROM AnsibleForms.`oauth2_providers` WHERE enable = 1");
      if (enabled.length === 1) {
        await query("UPDATE AnsibleForms.`oauth2_providers` SET auto_login = 1 WHERE id = ?", [enabled[0].id]);
        done.push(`SSO_AUTO_LOGIN=${autoLogin} set the provider '${enabled[0].name}' to skip the login page`);
      } else {
        done.push(`SSO_AUTO_LOGIN=${autoLogin} applied to no provider: ${enabled.length} are enabled, it acted on exactly one`);
      }
    }
    await query("INSERT IGNORE INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES (?, ?, NOW())", [SSO_ENV_MARKER, appVersion]);
  });
  logger.warning(`Imported the SSO environment variables once${done.length ? ` (${done.join("; ")})` : ""}. ${notice}`);
  return "imported";
}

// PATCHING : Patch All
async function patchAll(messages, success, failed) {
  await checkPromise(patchVersion4(messages, success, failed), messages, success, failed);
  await checkPromise(patchVersion5(messages, success, failed), messages, success, failed);
  await checkPromise(patchVersion6(messages, success, failed), messages, success, failed);
  await checkPromise(patchVersion7(messages, success, failed), messages, success, failed);
}
async function checkPromise(promise, messages, success, failed) {
  try {
    var res = await promise;
    if(res!=null){
      messages.push(res);
      success.push(res);
    }
  } catch (e) {
    if(e.message!=null){
      messages.push(e.message);
      failed.push(e.message);
    }
  }
}

async function checkTables(tables, messages, success, failed) {
  for (var i = 0; i < tables.length; i++) {
    await checkPromise(checkTable(tables[i]), messages, success, failed);
  }
}

async function checkAll({ patch = true } = {}) {
  var messages = [];
  var success = [];
  var failed = [];
  var resultobj;

  // check the database
  await checkPromise(checkSchema(), messages, success, failed);

  if (failed.length > 0) {
    // if schema does not exist, we can't check the tables // throw now
    resultobj = { message: messages, data: { success: success, failed: failed } };
    const err = new Error("Schema is missing");
    err.result = resultobj;
    throw err;
  }

  // check all the tables
  // not awx : 7 copies it into runners and drops it (patchVersion7)
  var tables = ["credentials", "groups", "job_output", "jobs", "ldap", "tokens", "users"];
  await checkPromise(checkTables(tables, messages, success, failed), messages, success, failed);

  if (failed.length > 0) {
    // some of the tables are missing, we can't patch them // throw now
    resultobj = { message: messages, data: { success: success, failed: failed } };
    const err = new Error("Tables are missing");
    err.result = resultobj;
    throw err;
  }

  // patch the tables : a backup first when they have something to change, and what was applied
  // recorded after
  // whether the backup before the upgrade failed : the patches did not run at all then, and the
  // caller (init) names that cause, and the UPGRADE_BACKUP=0 escape, rather than what fails next
  let backupFailed = false;
  if (patch) {
    try {
      const done = await backupBeforeUpgrade();
      if (done) { messages.push(done); success.push(done); }
    } catch (err) {
      const why = err.message || String(err);
      messages.push(why);
      failed.push(why);
      logger.error(why);
      backupFailed = true;
    }
    if (failed.length === 0) await checkPromise(patchAll(messages, success, failed), messages, success, failed);
    if (failed.length === 0) await checkPromise(recordMigrations().then(() => null), messages, success, failed);
  }

  if (failed.length > 0) {
    // some of the patches failed // throw now
    resultobj = { message: messages, data: { success: success, failed: failed, backupFailed } };
    const err = new Error("Patching failed");
    err.result = resultobj;
    throw err;
  }

  // all passed fine
  resultobj = { message: messages, data: { success: success, failed: failed } };
  return resultobj;
}

export { SCHEMA_MANIFEST };
// the 7 patch on its own, for the test that runs it on a database from before its columns
export { patchVersion7 };
// what makes a start back up the database before patching, for its test
export { pendingUpgrade, backupBeforeUpgrade };
export default Schema;

// function addRecord(table,names,values){
//   var message
//   var db="AnsibleForms"
//   logger.debug("checking record in table " + table)
//   var checksql = `SELECT * FROM ${db}.${table}`
//   var sql = `INSERT INTO ${db}.${table}(${names.join(",")}) VALUES(${values.join(",")});`
//   return mysql.do(checksql)
//     .then((checkres)=>{
//       if(checkres.length==0){
//         return mysql.do(sql)
//       }
//       return false
//     })
//     .then((res)=>{
//       if(!res){
//         message=`Record in '${table}' is present`
//         logger.debug(message)
//         return message
//       }
//       message=`added record in '${table}'`
//       logger.warning(message)
//       return message
//     })
// }

// function dropIndex(table,index){
//   var message
//   var db="AnsibleForms"
//   logger.debug(`dropping index '${index}' on table '${table}'`)
//   var checksql = `SHOW INDEX FROM ${db}.${table} WHERE Key_name='${index}'`
//   var sql = `DROP INDEX \`PRIMARY\` ON ${db}.${table}`
//   return mysql.do(checksql)
//     .then((checkres)=>{
//       if(checkres.length>0){
//         return mysql.do(sql)
//       }
//       return false
//     })
//     .then((res)=>{
//       if(!res){
//         message=`Index '${index}' is already dropped on '${table}'`
//         logger.debug(message)
//         return message
//       }
//       message=`Index '${index}' dropped on '${table}'`
//       logger.warning(message)
//       return message
//     })
// }
// function renameColumn(table,name,newname,fieldtype){
//   var message
//   var db="AnsibleForms"
//   var checksql = `SHOW COLUMNS FROM ${db}.${table} WHERE Field='${newname}'`
//   var sql = `ALTER TABLE ${db}.${table} CHANGE \`${name}\` \`${newname}\` ${fieldtype}`
//   logger.debug(`rename column '${name}'->'${newname}' on table '${table}'`)
//   return mysql.do(checksql)
//     .then((checkres)=>{
//       if(checkres.length==0){
//         return mysql.do(sql)
//       }
//       return false
//     })
//     .then((res)=>{
//       if(!res){
//         message=`Column '${name}' is already present on '${table}'`
//         logger.debug(message)
//         return message
//       }
//       message=`renamed column '${name}'->'${newname}' on '${table}'`
//       logger.warning(message)
//       return message
//     })
// }
// function resizeColumn(table,name,fieldtype){
//   var message
//   var db="AnsibleForms"
//   var checksql = `SHOW COLUMNS FROM ${db}.${table} WHERE Field='${name}' and type='${fieldtype}'`
//   var sql = `ALTER TABLE ${db}.${table} MODIFY \`${name}\` ${fieldtype}`
//   logger.debug(`resize column '${name}'->'${fieldtype}' on table '${table}'`)
//   return mysql.do(checksql)
//     .then((checkres)=>{
//       if(checkres.length==0){
//         return mysql.do(sql)
//       }
//       return false
//     })
//     .then((res)=>{
//       if(!res){
//         message=`Column '${name}' has already correct size on '${table}'`
//         logger.debug(message)
//         return message
//       }
//       message=`resized column '${name}'->'${fieldtype}' on '${table}'`
//       logger.warning(message)
//       return message
//     })
// }
