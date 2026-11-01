// CI against a real database (.github/workflows/ci.yml, job `database`) : an upgrade from the
// 7.2.0 schema, with the rows the 7.3 patches move around, checked where the unit tests cannot -
// they mock every statement, so a move that fails on a real table (an unknown column, a key
// that cannot be added, a statement order that reads a column before it exists) only showed
// on a user's upgrade.
//
//   node scripts/ci-upgrade.mjs seed     the 7.2.0 schema (tests/fixtures/schema-7.2.0.sql, as
//                                        that release created it) and its rows ; the database
//                                        AnsibleForms is DROPPED first
//   node scripts/ci-upgrade.mjs check    once the app has started on it and patched it : every
//                                        move done, the schema manifest complete
//   node scripts/ci-upgrade.mjs restore <base url>
//                                        restores the backup taken before the upgrade through
//                                        the API : it must upgrade the 7.2.0 schema again
//                                        before it reports success (check again after it)
//
// The connection is DB_HOST, DB_PORT, DB_USER and DB_PASSWORD, and the secrets are encrypted
// with ENCRYPTION_SECRET, as the app reads them. Exits 1 on any difference, saying which.
//
// Locally, against a throwaway database only (seed drops AnsibleForms) :
//   DB_HOST=127.0.0.1 DB_PORT=3399 DB_USER=root DB_PASSWORD=... ENCRYPTION_SECRET=... \
//     node scripts/ci-upgrade.mjs seed
//   (start the app on it with the same variables, wait for /api/v2/ready)
//   node scripts/ci-upgrade.mjs check
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql2 from "mysql2/promise";
import crypto from "../src/lib/crypto.js";
import { appVersion } from "../src/lib/version.js";
import { SCHEMA_MANIFEST } from "../src/models/schema.model.js";
import { missingFromManifest } from "../src/lib/schemaCompleteness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "../tests/fixtures/schema-7.2.0.sql");

// ---------------------------------------------------------------------------------------
// What is seeded, in clear : the seed encrypts it, the check decrypts what the moves wrote
// ---------------------------------------------------------------------------------------

const SECRETS = {
  ldap: "ldap-bind-password",
  entra: "entra-client-secret",
  oidc: "oidc-client-secret",
  mail: "mail-password",
  rte: "rte-token",
  aap: "aap-token",
  vault: "vault-token",
  cmdb: "cmdb-password",
};

/**
 * A connection to the database server, as the app makes it (DB_* variables).
 *
 * Args:
 *   options (object): extra mysql2 options (multipleStatements for the schema file).
 *
 * Returns:
 *   Promise<object>: a mysql2 connection.
 */
function connect(options = {}) {
  return mysql2.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    ...options,
  });
}

// ---------------------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------------------

/**
 * The 7.2.0 schema and the rows the 7.3 patches move : an LDAP directory with its servers and
 * bind password, an Entra ID and an Open ID provider with their client, the mail settings with
 * their login, an RTE and an AAP runner with their own token and address, a Vault with its
 * address and token, an environment label, a schedule, a repository with its pull output, two
 * database credentials (one of type database, one with its database flag only, as before the
 * types) that 7.5 makes a database of Connections > Databases each, and the schema_migrations
 * rows 7.2.0 recorded.
 *
 * Returns:
 *   Promise<void>
 */
async function seed() {
  // step 1 : the schema, as 7.2.0 created it on a fresh install
  const db = await connect({ multipleStatements: true });
  try {
    await db.query("DROP DATABASE IF EXISTS AnsibleForms");
    await db.query(fs.readFileSync(FIXTURE, "utf8"));
    const enc = (v) => crypto.encrypt(v);
    // step 2 : the rows
    await db.query(
      "INSERT INTO AnsibleForms.`settings` (mail_server, mail_port, mail_secure, mail_username, mail_password, mail_from, url, forms_yaml, env_label, env_label_color, env_label_show) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, 1)",
      ["smtp.example.com", 587, 1, "mailer", enc(SECRETS.mail), "af@example.com", "PRODUCTION", "red"],
    );
    await db.query(
      "INSERT INTO AnsibleForms.`ldap` (server, port, ignore_certs, enable_tls, cert, ca_bundle, bind_user_dn, bind_user_pw, search_base, username_attribute, groups_attribute, enable) VALUES (?, 636, 0, 1, '', '', ?, ?, ?, 'sAMAccountName', 'memberOf', 1)",
      ["ldap.example.com", "cn=bind,dc=example,dc=com", enc(SECRETS.ldap), "dc=example,dc=com"],
    );
    // the SSO providers disabled : an enabled one fetches its discovery document at the start,
    // and the made-up addresses here would log errors the workflow fails on. The moves do not
    // look at enable
    await db.query(
      "INSERT INTO AnsibleForms.`oauth2_providers` (provider, name, tenant_id, client_id, client_secret, enable, redirect_uri) VALUES ('azuread', 'Entra', ?, ?, ?, 0, ?)",
      ["tenant-0001", "entra-client-id", enc(SECRETS.entra), "https://af.example.com/api/v2/auth/azureadoauth2/callback"],
    );
    await db.query(
      "INSERT INTO AnsibleForms.`oauth2_providers` (provider, name, issuer, client_id, client_secret, enable) VALUES ('oidc', 'Keycloak', ?, ?, ?, 0)",
      ["https://kc.example.com/realms/af", "oidc-client-id", enc(SECRETS.oidc)],
    );
    await db.query(
      "INSERT INTO AnsibleForms.`runners` (name, type, uri, token, ignore_certs, is_default) VALUES ('rte1', 'rte', ?, ?, 0, 1)",
      ["https://rte1.example.com:8443/", enc(SECRETS.rte)],
    );
    await db.query(
      "INSERT INTO AnsibleForms.`runners` (name, type, flavour, uri, token, ignore_certs) VALUES ('aap1', 'awx', 'aap', ?, ?, 0)",
      ["https://aap.example.com", enc(SECRETS.aap)],
    );
    await db.query(
      "INSERT INTO AnsibleForms.`secret_stores` (name, type, url, token, kv_version) VALUES ('vault1', 'vault', ?, ?, 2)",
      ["https://vault.example.com:8200", enc(SECRETS.vault)],
    );
    await db.query("INSERT INTO AnsibleForms.`schedule` (name, cron, form, status, state) VALUES ('nightly', '0 2 * * *', 'Demo', 'idle', 'idle')");
    await db.query(
      "INSERT INTO AnsibleForms.`repositories` (name, uri, use_for_forms, branch, status, output) VALUES ('forms', 'https://git.example.com/forms.git', 0, 'main', 'success', 'Already up to date.')",
    );
    // the database credentials forms query : each becomes a database of its name (7.5)
    await db.query(
      "INSERT INTO AnsibleForms.`credentials` (name, user, password, host, port, description, secure, db_type, db_name, is_database, credential_type) VALUES ('cmdb', 'reader', ?, 'db.example.com', 3306, 'The CMDB', 0, 'mysql', 'cmdb', 1, 'database')",
      [enc(SECRETS.cmdb)],
    );
    await db.query(
      "INSERT INTO AnsibleForms.`credentials` (name, user, password, host, port, description, db_type, db_name, is_database) VALUES ('inventory', 'reader', ?, 'pg.example.com', 5432, '', 'postgres', 'inventory', 1)",
      [enc(SECRETS.cmdb)],
    );
    // step 3 : what 7.2.0 recorded after its patch run
    for (const name of ["patchVersion4", "patchVersion5", "patchVersion6", "patchVersion7"]) {
      await db.query("INSERT INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES (?, '7.2.0', NOW())", [name]);
    }
    await db.query("INSERT INTO AnsibleForms.`schema_migrations` (name, version, applied_at) VALUES ('schema', '7.2.0', NOW())");
  } finally {
    await db.end();
  }
  console.log(`seeded the 7.2.0 schema and its rows, to be upgraded to ${appVersion}`);
}

// ---------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------

/**
 * Every move of the 7.3 patches done on the seeded rows, and the schema manifest complete.
 *
 * Returns:
 *   Promise<string[]>: what is wrong ; empty when all is well.
 */
async function check() {
  const db = await connect();
  const problems = [];
  const one = async (sql, params) => (await db.query(sql, params))[0][0];
  const expect = (what, actual, wanted) => {
    if (actual !== wanted) problems.push(`${what}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  };
  try {
    // step 1 : the credentials the moves made, of the right type, with the right secret
    const credential = async (name, type, secret, extra = {}) => {
      const c = await one("SELECT * FROM AnsibleForms.`credentials` WHERE name = ?", [name]);
      if (!c) {
        problems.push(`no credential ${name}`);
        return;
      }
      expect(`credential ${name} type`, c.credential_type, type);
      expect(`credential ${name} secret`, c.password ? crypto.decrypt(c.password) : null, secret);
      for (const [column, wanted] of Object.entries(extra)) expect(`credential ${name} ${column}`, c[column], wanted);
    };
    await credential("main-ldap", "ldap", SECRETS.ldap, { user: "cn=bind,dc=example,dc=com", host: "ldap.example.com", port: 636, secure: 1 });
    await credential("entra-sso", "entraid", SECRETS.entra, { user: "entra-client-id", tenant_id: "tenant-0001" });
    await credential("keycloak-sso", "oidc", SECRETS.oidc, { user: "oidc-client-id", issuer: "https://kc.example.com/realms/af" });
    await credential("mail-login", "smtp", SECRETS.mail, { user: "mailer", host: "smtp.example.com", port: 587 });
    await credential("rte1-token", "rte", SECRETS.rte, { url: "https://rte1.example.com:8443" });
    await credential("aap1-token", "aap", SECRETS.aap, { url: "https://aap.example.com" });
    await credential("vault1-token", "vault", SECRETS.vault, { url: "https://vault.example.com:8200" });

    // step 2 : the records name them, their own secrets and addresses emptied
    const rte = await one("SELECT credential, token, uri FROM AnsibleForms.`runners` WHERE name = 'rte1'");
    expect("runner rte1 credential", rte?.credential, "rte1-token");
    expect("runner rte1 token", rte?.token, null);
    // an RTE added by hand keeps its address : one still on 7.2 finds its runner by it
    expect("runner rte1 uri", rte?.uri, "https://rte1.example.com:8443/");
    expect("runner aap1 credential", (await one("SELECT credential FROM AnsibleForms.`runners` WHERE name = 'aap1'"))?.credential, "aap1-token");
    expect("secret store vault1 credential", (await one("SELECT credential FROM AnsibleForms.`secret_stores` WHERE name = 'vault1'"))?.credential, "vault1-token");
    const ldap = await one("SELECT name, credential, server FROM AnsibleForms.`ldap`");
    expect("ldap name", ldap?.name, "main");
    expect("ldap credential", ldap?.credential, "main-ldap");
    expect("ldap server", ldap?.server, null);
    for (const [name, cred] of [["Entra", "entra-sso"], ["Keycloak", "keycloak-sso"]]) {
      const p = await one("SELECT credential, client_id, client_secret FROM AnsibleForms.`oauth2_providers` WHERE name = ?", [name]);
      expect(`sso ${name} credential`, p?.credential, cred);
      expect(`sso ${name} client_id`, p?.client_id, null);
    }
    const channel = await one("SELECT type, credential, is_active FROM AnsibleForms.`notification_channels` WHERE name = 'default'");
    expect("mail channel default type", channel?.type, "mail");
    expect("mail channel default credential", channel?.credential, "mail-login");
    expect("mail settings emptied", (await one("SELECT mail_server FROM AnsibleForms.`settings`"))?.mail_server, "");

    // step 3 : the renamed and new columns, and the rows made from the old ones
    const columns = (await db.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'AnsibleForms' AND table_name = 'repositories'"))[0].map((r) => r.c);
    if (!columns.includes("pull_output") || columns.includes("output")) problems.push(`repositories columns: ${columns.join(", ")} (wanted pull_output, not output)`);
    expect("repository pull_output", (await one("SELECT pull_output FROM AnsibleForms.`repositories` WHERE name = 'forms'"))?.pull_output, "Already up to date.");
    const label = await one("SELECT name, color, enabled FROM AnsibleForms.`labels` ORDER BY position LIMIT 1");
    expect("first label", label?.name, "PRODUCTION");
    expect("first label color", label?.color, "red");
    expect("schedule nightly enabled", (await one("SELECT enabled FROM AnsibleForms.`schedule` WHERE name = 'nightly'"))?.enabled, 1);

    // the database credentials : a database each, by their name and naming them, the credentials
    // as they were (their connection and login, their type)
    await credential("cmdb", "database", SECRETS.cmdb, { host: "db.example.com", port: 3306, db_type: "mysql", db_name: "cmdb", user: "reader" });
    await credential("inventory", "database", SECRETS.cmdb, { host: "pg.example.com", port: 5432, db_type: "postgres", db_name: "inventory" });
    const databases = (await db.query("SELECT name, description, credential FROM AnsibleForms.`databases` ORDER BY name"))[0];
    expect("databases", JSON.stringify(databases.map((d) => [d.name, d.credential, d.description]).filter((d) => ["cmdb", "inventory"].includes(d[0]))), JSON.stringify([["cmdb", "cmdb", "The CMDB"], ["inventory", "inventory", null]]));
    expect("databases made once", !!(await one("SELECT 1 AS x FROM AnsibleForms.`schema_migrations` WHERE name = 'databases_from_credentials'")), true);

    // step 4 : what the upgrade recorded
    expect("schema recorded", (await one("SELECT version FROM AnsibleForms.`schema_migrations` WHERE name = 'schema'"))?.version, appVersion);
    expect("credentials retyped once", !!(await one("SELECT 1 AS x FROM AnsibleForms.`schema_migrations` WHERE name = 'retype_connection_credentials'")), true);
    expect("backed up before the upgrade", (await one("SELECT version FROM AnsibleForms.`schema_migrations` WHERE name = 'upgrade_backup'"))?.version, appVersion);

    // step 5 : nothing the manifest names is missing
    const pool = { do: async (sql, params) => (await db.query(sql, params))[0] };
    const { missingTables, missingColumns, missingIndexes } = await missingFromManifest(SCHEMA_MANIFEST, pool);
    if (missingTables.length || missingColumns.length || missingIndexes.length) {
      problems.push(`the schema lacks tables [${missingTables}] columns [${missingColumns}] indexes [${missingIndexes}]`);
    }
  } finally {
    await db.end();
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------

/**
 * Restores the backup the upgrade took (the 7.2.0 schema and its rows) through the API, as an
 * admin would after a failed upgrade : the restore must upgrade that schema again before it
 * says it completed, or this release runs on the 7.2.0 tables. `check` after it says whether
 * every move was done again.
 *
 * Args:
 *   base (string): the app's address.
 *
 * Returns:
 *   Promise<string[]>: what is wrong ; empty when all is well.
 */
async function restore(base) {
  // step 1 : signed in as the default admin, whose public default password must be changed
  // before anything but the profile answers (lib/middleware.js passwordChangeGate)
  const signIn = async (password) => {
    const res = await fetch(`${base}/api/v2/auth/login`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` },
    });
    return res.status === 200 ? (await res.json()).token : null;
  };
  const DEFAULT_PASSWORD = "AnsibleForms!123";
  const CI_PASSWORD = "Ci-Upgrade-Restore-2026!";
  const first = await signIn(DEFAULT_PASSWORD);
  if (!first) return ["the default admin cannot sign in"];
  const changed = await fetch(`${base}/api/v2/profile`, {
    method: "PUT",
    headers: { authorization: `Bearer ${first}`, "content-type": "application/json" },
    body: JSON.stringify({ password: CI_PASSWORD, currentPassword: DEFAULT_PASSWORD }),
  });
  if (changed.status !== 200) return [`the admin's password could not be changed (${changed.status} ${await changed.text()})`];
  // the change revokes the tokens issued until then, to the second (lib/tokenRevocation.js) : one
  // asked for in that same second is refused
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const token = await signIn(CI_PASSWORD);
  if (!token) return ["the admin cannot sign in with the changed password"];
  const headers = { authorization: `Bearer ${token}` };
  // step 2 : the backup taken before the upgrade
  const list = await (await fetch(`${base}/api/v2/backup`, { headers })).json();
  const backup = (list.records || []).find((b) => /^Before the upgrade to /.test(b.description || ""));
  if (!backup) return [`no backup taken before the upgrade among ${JSON.stringify((list.records || []).map((b) => b.description))}`];
  // step 3 : restored, and upgraded again before it says so
  const res = await fetch(`${base}/api/v2/backup/${backup.folder}/restore`, { method: "POST", headers });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) return [`the restore answered ${res.status}: ${JSON.stringify(body)}`];
  if (body.message !== "Restore completed" || body.schemaUpgraded !== true) return [`the restore said ${JSON.stringify(body)}`];
  console.log(`restored ${backup.folder} (${backup.description}), and upgraded it again`);
  return [];
}

// ---------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------

const command = process.argv[2];
try {
  if (command === "seed") {
    await seed();
  } else if (command === "check") {
    const problems = await check();
    if (problems.length) {
      for (const p of problems) console.error(`FAIL : ${p}`);
      process.exit(1);
    }
    console.log(`upgraded from 7.2.0 to ${appVersion}: every move done, the schema complete`);
  } else if (command === "restore") {
    const problems = await restore(process.argv[3] || "http://127.0.0.1:8000");
    if (problems.length) {
      for (const p of problems) console.error(`FAIL : ${p}`);
      process.exit(1);
    }
  } else {
    console.error("usage: node scripts/ci-upgrade.mjs seed|check|restore <base url>");
    process.exit(2);
  }
} catch (err) {
  console.error(`FAIL : ${err.message || err}`);
  process.exit(1);
}
process.exit(0);
