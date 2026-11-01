'use strict';
// Declarative config seed : config as code for the admin objects.
//
// When CONFIG_SEED_PATH is set, that file is read at startup and the objects it
// declares (awx, credentials, databases, oauth2 providers, repositories, ldap, mail/url) are
// upserted into the database. This is the piece that lets a whole instance be
// rebuilt from git on an empty database - see https://ansibleforms.com/seed.
//
// Objects that come from the seed are flagged `managed` : the seed re-applies them on
// every start and the API refuses to change them, so the file stays authoritative.
// Dropping an object from the file releases the flag (the record stays, editable
// again) ; `prune: true` on a section deletes it instead. Unsetting CONFIG_SEED_PATH turns
// the seed off and releases every managed record at the next start (releaseWhenOff).
//
// A hand-made object is never touched UNLESS the seed declares its name, in which case
// it is adopted : the declared fields are enforced and it becomes read-only. That is
// the right outcome, but it overwrites what somebody typed, so it is logged as a
// warning and recorded in the audit entry rather than happening silently.
//
// An invalid seed is FATAL on purpose AT BOOT. The alternative - come up on the previous
// configuration - means an instance whose behaviour no longer matches the manifest that is
// supposed to describe it, and nothing says so out loud. A RELOAD of an already running
// instance is the opposite : see reloadConfigSeed.
import fs from "fs";
import { createHash } from "node:crypto";
import yaml from "yaml";
import logger from "./logger.js";
import crypto from "./crypto.js";
import appConfig from "../../config/app.config.js";
import { validateSeed, interpolateEnv, foldAwxIntoRunners, foldRunnerSecretsIntoCredentials, runnerOwnsSecrets } from "./seed-schema.js";
import CrudModel from "../models/crud.model.js";
import OAuth2 from "../models/oauth2.model.js";
import Credential from "../models/credential.model.v2.js";
import SecretStore from "../models/secretStore.model.js";
import Runner from "../models/runner.model.js";
import Database from "../models/database.model.js";
import Repository from "../models/repository.model.js";
import SyslogServer from "../models/syslogServer.model.js";
import Label from "../models/label.model.js";
import NotificationChannel from "../models/notificationChannel.model.js";
import Ldap from "../models/ldap.model.js";
import Settings from "../models/settings.model.js";
import ChatSettings, { normaliseExtraHeaders } from "../models/chatSettings.model.js";
import Audit from "../models/audit.model.js";
import mysql from "../models/db.model.js";
import { repoFolder } from "../models/repo.model.js";

// The one thing that distinguishes the seed from an API caller. Everything the seed
// writes goes through the normal models, so encryption, the is_default handling and
// the repository clone behave exactly as they do for a save from the UI.
const seedOpts = { fromSeed: true };

// The comparison below works on decrypted values throughout : CrudModel.findByName
// (postProcess), Ldap.find and Settings.find all decrypt their secret columns before
// returning, so a declared plaintext password can be compared with what is stored.
const listSections = [
  {
    // before the credentials that name them
    key: "secret_stores",
    modelName: "secretstore",
    label: "secret store",
    defaults: { description: "" },
    create: (d) => SecretStore.create(d, seedOpts),
    update: (d, row) => SecretStore.update(d, row.id, seedOpts),
    remove: (row) => SecretStore.delete(row.id, seedOpts),
  },
  {
    // before the runners that name them
    key: "credentials",
    modelName: "credential",
    label: "credential",
    defaults: { description: "" },
    create: (d) => Credential.create(d, seedOpts),
    update: (d, row) => Credential.update(d, row.id, seedOpts),
    remove: (row) => Credential.delete(row.id, seedOpts),
  },
  {
    // the databases forms query (Connections > Databases) : after the credentials they name, which
    // they check (one of type database)
    key: "databases",
    modelName: "database",
    label: "database",
    defaults: { description: "" },
    create: (d) => Database.create(d, seedOpts),
    update: (d, row) => Database.update(d, row.id, seedOpts),
    remove: (row) => Database.delete(row.id, seedOpts),
  },
  {
    key: "runners",
    modelName: "runner",
    label: "runner",
    defaults: { description: "" },
    create: (d) => Runner.create(d, seedOpts),
    update: (d, row) => Runner.update(d, row.id, seedOpts),
    remove: (row) => Runner.delete(row.id, seedOpts),
    // an RTE registers itself (rte/register.js), maybe before the seed is applied : the row
    // it wrote at the declared address is adopted, or that RTE would be two runners
    findAdoptable: (item) => Runner.findRegisteredAt(item),
    adopt: (d, row) => Runner.adoptRegistered(d, row, seedOpts),
  },
  {
    key: "oauth2",
    modelName: "oauth2",
    label: "oauth2",
    create: (d) => OAuth2.create(d, seedOpts),
    update: (d, row) => OAuth2.update(d, row.id, seedOpts),
    remove: (row) => OAuth2.delete(row.id, seedOpts),
  },
  {
    key: "repositories",
    modelName: "repositories",
    label: "repository",
    defaults: { description: "" },
    create: (d) => Repository.create(d, seedOpts),
    // NOT Repository.update : it runs removeEmptyFields, which DROPS a declared "" before
    // writing. differs() then still sees "" vs the stored value, so a seed that clears a
    // repository's user/password/cron reported "1 updated" on every boot for ever while
    // never actually clearing it - the old credential kept being injected into the clone
    // URL. Going through CrudModel writes the empty value, which is what was declared.
    update: (d, row) => CrudModel.update("repositories", d, row.id, seedOpts),
    remove: (row) => Repository.delete(row.name, seedOpts),
  },
  {
    // the labels beside the header's logo (Settings > Appearance > Labels)
    key: "labels",
    modelName: "label",
    label: "label",
    create: (d) => Label.create(d, seedOpts),
    update: (d, row) => Label.update(d, row.id, seedOpts),
    remove: (row) => Label.delete(row.id, seedOpts),
  },
  {
    // where the server log and the audit entries go (Connections > Syslog)
    key: "syslog_servers",
    modelName: "syslogserver",
    label: "syslog server",
    defaults: { description: "" },
    create: (d) => SyslogServer.create(d, seedOpts),
    update: (d, row) => SyslogServer.update(d, row.id, seedOpts),
    remove: (row) => SyslogServer.delete(row.id, seedOpts),
  },
  {
    // where notifications go (Connections > Notifications) : SMTP servers, Slack, Teams,
    // Telegram and webhooks. After the credentials : a channel names one
    key: "notification_channels",
    modelName: "notificationchannel",
    label: "notification channel",
    defaults: { description: "" },
    create: (d) => NotificationChannel.create(d, seedOpts),
    update: (d, row) => NotificationChannel.update(d, row.id, seedOpts),
    remove: (row) => NotificationChannel.delete(row.id, seedOpts),
  },
];

// JSON with object keys in a stable (sorted) order, recursively, so two structurally
// equal documents always produce the same string. Array order is meaningful and is kept.
// Exported for the test that pins the MySQL key-sorting behaviour this exists for.
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

// Whether any declared field differs from what is stored.
//
// Without this the seed would rewrite every row on every boot, because encryption
// uses a random IV : the same password produces different ciphertext each time, so
// "did it change?" cannot be answered by comparing what is about to be written. That
// would make the audit trail claim a change on every restart and make the applied
// counts meaningless. Comparison is loose (String()) because a port declared as 389
// comes back from MySQL as "389" in a varchar column.
// Exported for the tests of the JSON comparisons.
export function differs(declared, stored) {
  for (const [key, value] of Object.entries(declared)) {
    if (key === "managed") continue;
    const before = stored[key];
    if (typeof value === "boolean") {
      if ((before ? 1 : 0) !== (value ? 1 : 0)) return true;
      continue;
    }
    if (value === null || value === undefined) continue;
    // A JSON column (oauth2_providers.extra) is returned PARSED by mysql2, so String()
    // gives "[object Object]" and every comparison against the declared string differed
    // - rewriting the row on every boot, and with it re-running the "only one enabled
    // provider per type" side effect that disables a sibling somebody enabled by hand.
    //
    // Comparing must be CANONICAL, not just structural: MySQL sorts an object's keys when
    // it stores JSON (verified - '{"b":2,"a":1}' comes back as '{"a":1,"b":2}'), while
    // JSON.parse preserves the declared order. A plain JSON.stringify of each side
    // therefore still differs for any declared object whose keys are not already sorted.
    if (before !== null && typeof before === "object") {
      let parsed = value;
      if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch { parsed = value; }
      }
      if (canonicalJson(before) !== canonicalJson(parsed)) return true;
      continue;
    }
    // the other way round : an object declared for a TEXT column holding JSON
    // (secret_stores.extra), which String() would turn into "[object Object]"
    if (typeof value === "object") {
      let parsed;
      try { parsed = JSON.parse(before ?? "null"); } catch { parsed = before; }
      if (canonicalJson(parsed) !== canonicalJson(value)) return true;
      continue;
    }
    if (String(before ?? "") !== String(value)) return true;
  }
  return false;
}

/**
 * The record to write for a declared item.
 *
 * `section.defaults` are applied on CREATE ONLY. They exist purely to satisfy columns
 * with no database default (credentials.description is NOT NULL without one), and
 * applying them on UPDATE too meant a seed that says nothing about `description`
 * BLANKED an existing one - which on a hand-made record adopted by name silently
 * destroyed somebody's text. Exported so that stays covered by a test.
 */
export function buildRecord(section, item, isCreate) {
  return isCreate
    ? { ...(section.defaults || {}), ...item, managed: true }
    : { ...item, managed: true };
}

async function applyListSection(section, cfg, summary) {
  const items = cfg.items || [];
  const declared = new Set(items.map((i) => i.name));

  for (const item of items) {
    const existing = await CrudModel.findByName(section.modelName, item.name);
    if (existing) {
      const data = buildRecord(section, item, false);
      // already managed and unchanged : leave the row alone entirely
      if (existing.managed && !differs(data, existing)) {
        summary.unchanged++;
        continue;
      }
      // Declaring a name that already exists ADOPTS that record : its declared fields
      // are overwritten and it becomes read-only. That is the right outcome (the file
      // is authoritative) but it is not obvious from the file, so say so out loud -
      // otherwise the only signal is somebody's hand-made entry quietly changing.
      if (!existing.managed) {
        logger.warning(`Config seed adopts the existing ${section.label} '${item.name}', which was not managed before: its declared fields are now enforced from the seed file`);
        summary.adopted.push(`${section.label}:${item.name}`);
      }
      await section.update(data, existing);
      summary.updated.push(`${section.label}:${item.name}`);
      continue;
    }
    // No row by that name, but one the section adopts under it (a runner an RTE registered
    // itself at the declared address) : taken over with the fields of a new row, never a
    // second row next to it
    const adoptable = section.findAdoptable ? await section.findAdoptable(item) : null;
    if (adoptable) {
      logger.warning(`Config seed adopts the ${section.label} '${adoptable.name}' (${adoptable.uri}), which its RTE registered itself, as '${item.name}': its declared fields are now enforced from the seed file`);
      summary.adopted.push(`${section.label}:${item.name}`);
      await section.adopt(buildRecord(section, item, true), adoptable);
      summary.updated.push(`${section.label}:${item.name}`);
    } else {
      const data = buildRecord(section, item, true);
      await section.create(data);
      summary.created.push(`${section.label}:${item.name}`);
    }
  }

  // Managed rows that are no longer declared. Released by default (the record stays
  // and becomes editable again) or deleted when the section asks to prune. Rows that
  // were never managed are somebody's manual work and are never considered here.
  const all = await CrudModel.findAll(section.modelName);
  for (const row of all) {
    if (!row.managed || declared.has(row.name)) continue;
    if (cfg.prune) {
      await section.remove(row);
      summary.pruned.push(`${section.label}:${row.name}`);
    } else {
      await CrudModel.update(section.modelName, { managed: false }, row.id, seedOpts);
      summary.released.push(`${section.label}:${row.name}`);
    }
  }
}

/**
 * Re-clone a seeded repository that has no working tree.
 *
 * Repository.create fires Repository.clone WITHOUT awaiting it, and only the CREATE path
 * does. So if that first clone failed - bad credentials, DNS, or the pod killed mid-clone by
 * a readiness probe - every later boot took the `unchanged` fast path, because status/head/
 * output are runtime state and deliberately not declarable, so differs() never looks at
 * them. A repository marked use_for_config then made the instance serve NO forms, for ever,
 * while the seed reported itself applied.
 *
 * Checking the directory rather than `status` on purpose: status can read 'success' from an
 * earlier life while the tree has since been removed, and a 'failed' row whose tree is
 * actually fine must not be re-cloned underneath a working instance. The atomic
 * status='running' claim inside clone() is what keeps this from racing the boot rebase.
 */
async function ensureRepositoryClones(doc, summary) {
  for (const item of doc.repositories?.items || []) {
    const dir = repoFolder(item.name);
    if (fs.existsSync(dir)) continue;
    logger.warning(`Seeded repository '${item.name}' has no working tree: cloning it again`);
    summary.recloned.push(`repository:${item.name}`);
    // not awaited, exactly like the create path : a slow clone must not delay the boot,
    // and the claim serialises it against the rebase block that runs later
    Repository.clone(item.name).catch((e) => {
      logger.error(`Re-clone of seeded repository '${item.name}' failed: ${e.message || e}`);
    });
  }
}

async function applyLdap(cfg, summary) {
  const stored = await Ldap.find();
  // The Ldap constructor does the boolean casts and the password encryption, exactly as
  // a save from the UI would - but it also MATERIALISES every field it knows about:
  // absent booleans become 0 and the four group fields become "". Writing that record
  // wholesale blanked seven fields the seed never mentioned, which on an instance with
  // hand-configured LDAP set enable=0 and destroyed the group mapping - it stopped
  // directory logins. So take only the keys the seed actually declared, with the
  // constructor's conversion applied. Same rule as applySettings, and as buildRecord.
  const converted = { ...new Ldap(cfg) };
  const record = {};
  for (const key of Object.keys(converted)) {
    if (key === 'testuser' || key === 'testpassword') continue;
    if (cfg[key] === undefined) continue;          // not declared : leave it alone
    if (converted[key] === undefined) continue;
    record[key] = converted[key];
  }
  // compare against what was declared, not against the freshly encrypted record
  if (stored?.managed && !differs(cfg, stored)) {
    summary.unchanged++;
    return;
  }
  // Same signal as for the list sections : taking over a hand-configured directory is
  // the most consequential adoption of all, so it must not happen silently.
  if (!stored?.managed) {
    logger.warning("Config seed adopts the existing ldap configuration, which was not managed before: its declared fields are now enforced from the seed file");
    summary.adopted.push("ldap");
  }
  record.managed = 1;
  await Ldap.update(record);
  summary.updated.push("ldap");
}

async function applySettings(cfg, summary) {
  const stored = await Settings.find();
  // Partial update on purpose : the settings row also carries forms_yaml, the logo
  // and the theme defaults, none of which are seed material.
  const record = {};
  for (const k of ["mail_server", "mail_port", "mail_username", "mail_from", "url"]) {
    if (cfg[k] !== undefined) record[k] = cfg[k];
  }
  if (cfg.mail_secure !== undefined) record.mail_secure = cfg.mail_secure ? 1 : 0;
  if (cfg.mail_password !== undefined) {
    record.mail_password = cfg.mail_password === "" ? "" : crypto.encrypt(cfg.mail_password);
  }
  if (stored?.managed && !differs(cfg, stored)) {
    summary.unchanged++;
    return;
  }
  if (!stored?.managed) {
    logger.warning("Config seed adopts the existing mail/url settings, which were not managed before: its declared fields are now enforced from the seed file");
    summary.adopted.push("settings");
  }
  record.managed = 1;
  await Settings.update(record);
  summary.updated.push("settings");
}

// The chat assistant's provider row : the ldap rule - only the declared keys, converted by
// the model's constructor (encryption, clamping), compared against what was declared.
export async function applyChat(declared, summary) {
  // extra headers may be written as a yaml mapping : compared and stored as the model keeps
  // them (normalised JSON text), or every start would see a difference
  const cfg = declared.extra_headers === undefined ? declared : { ...declared, extra_headers: normaliseExtraHeaders(declared.extra_headers) };
  const stored = await ChatSettings.find();
  const converted = { ...new ChatSettings(cfg) };
  const record = {};
  for (const key of Object.keys(converted)) {
    if (cfg[key] === undefined || converted[key] === undefined) continue;
    record[key] = converted[key];
  }
  if (stored?.managed && !differs(cfg, stored)) {
    summary.unchanged++;
    return;
  }
  if (!stored?.managed) {
    logger.warning("Config seed adopts the existing chat settings, which were not managed before: its declared fields are now enforced from the seed file");
    summary.adopted.push("chat");
  }
  record.managed = 1;
  await ChatSettings.update(record);
  summary.updated.push("chat");
}

/**
 * Applies the seed file when CONFIG_SEED_PATH is set. Returns a summary, or null when
 * no seed is configured (after releasing what an earlier seed managed, see releaseWhenOff).
 * Throws on anything wrong : the caller treats that as fatal.
 */
// One apply at a time : the boot, the reload poll and SIGHUP each find-then-create per
// section, so two at once could create the same row twice. Each waits for the one before.
let seedRun = Promise.resolve();
function oneAtATime(fn) {
  const run = seedRun.then(fn, fn);
  seedRun = run.catch(() => {});
  return run;
}

export function applyConfigSeed(opts) {
  return oneAtATime(() => applySeedNow(opts));
}

export function reloadConfigSeed(opts) {
  return oneAtATime(() => reloadSeedNow(opts));
}

async function applySeedNow({ schemaIsReady = true } = {}) {
  const seedPath = appConfig.configSeedPath;
  // No seed configured at all : the seed is OFF, and whatever it marked managed on an earlier
  // start is released here (see releaseWhenOff). That is deliberately NOT what happens when
  // CONFIG_SEED_PATH is set but its file is missing - just below, that refuses to start,
  // because a mounted file (a ConfigMap, a secret volume) may simply not be there YET, and
  // releasing on that would unlock every managed object because of a slow mount.
  if (!seedPath) {
    await releaseWhenOff();
    return null;
  }

  // NOT fatal on its own. `schemaIsReady` is false when hasSchema() collected ANY failure -
  // including a single addIndex that could not apply, which schemaCheck itself grades only a
  // WARNING ("slow, not broken"). Refusing to start on that turned an upgrade into a
  // CrashLoopBackOff with no way in: the app never listens, so POST /api/v2/schema - the
  // documented manual repair, and the readiness probe in https://ansibleforms.com/seed - is unreachable, and
  // the only escape is editing the Deployment to unset CONFIG_SEED_PATH. It also contradicted
  // schema.model.js's own note that a missing ALTER grant "does not stop the app".
  //
  // So attempt the seed anyway. If it genuinely cannot write, the model throws a real error
  // naming the table or column, and THAT is fatal - which is better diagnostics than a
  // blanket refusal, and it cannot fire on a gap the seed does not care about.
  if (!schemaIsReady) {
    logger.warning("The database schema reported problems ; applying the config seed anyway - a real failure will name the table or column");
  }
  if (!fs.existsSync(seedPath)) {
    throw new Error(`CONFIG_SEED_PATH points to '${seedPath}' but that file does not exist`);
  }
  // A directory passes existsSync and then fails the read with a bare "EISDIR: illegal
  // operation on a directory". That is the likeliest mistake of all on kubernetes, where
  // a ConfigMap mounts AS a directory - CONFIG_SEED_PATH=/seed instead of /seed/seed.yaml.
  // Worth naming, since the operator only sees this in a crash-looping pod's log.
  if (!fs.statSync(seedPath).isFile()) {
    throw new Error(`CONFIG_SEED_PATH points to '${seedPath}' which is a directory, not a file (a mounted ConfigMap is a directory - point this at the file inside it)`);
  }

  logger.notice(`Applying config seed from ${seedPath}`);
  const raw = fs.readFileSync(seedPath, "utf8");
  let doc = yaml.parse(raw);
  // an empty file is a valid seed that declares nothing : it releases everything
  if (doc === null || doc === undefined) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Seed file must contain a yaml mapping at the top level");
  }
  doc = interpolateEnv(doc);
  validateSeed(doc);
  if (doc.awx) {
    logger.warning("The config seed's awx: section is deprecated since 7 and removed in 8: declare those connections under runners: with type: awx");
    doc = foldAwxIntoRunners(doc);
  }
  // a runner's own token, or user and password : deprecated since 7.3 in favour of a credential
  // of its kind (credential:), removed in 8. Applied as such a credential, named after the runner
  // The credentials made by hand are reserved : a generated name equal to one of them would
  // adopt it (applyListSection), overwriting it with the runner's token. Read only when a
  // runner has secrets to fold. The seed's own (managed) ones are not reserved : the one named
  // after the runner is this credential, from the previous start.
  let reserved = [];
  if ((doc.runners?.items || []).some(runnerOwnsSecrets)) {
    // the names only : findAll would decrypt every secret for nothing
    reserved = (await mysql.do("SELECT name FROM AnsibleForms.`credentials` WHERE COALESCE(managed, 0) = 0")).map((c) => c.name);
  }
  const runnerSecrets = foldRunnerSecretsIntoCredentials(doc, reserved);
  doc = runnerSecrets.doc;
  for (const name of runnerSecrets.folded) {
    const credential = doc.runners.items.find((r) => r.name === name).credential;
    logger.warning(`The config seed's runner '${name}' carries its own token or user and password, deprecated since 7.3 and removed in 8: declare a credential of its kind with its url and name it with credential: (applied now as the credential '${credential}')`);
  }

  const summary = { created: [], updated: [], released: [], pruned: [], adopted: [], recloned: [], unchanged: 0 };

  // There is no transaction across the sections, so a failure part way through leaves
  // the database half applied. It re-converges on the next boot, but the records already
  // written would otherwise carry a `managed` flag with nothing in the trail explaining
  // who set it - so record what got as far as being applied, then re-throw.
  try {
    await applySections(doc, summary);
  } catch (e) {
    await logApply(seedPath, summary, 'failure');
    throw e;
  }

  // The hash of what was ACTUALLY applied, taken from the bytes this run read rather than
  // from whatever the poller looked at a moment earlier. A file rewritten between the two
  // is then simply applied on this pass instead of being remembered as already applied.
  lastApplied = { hash: hashOf(raw), at: new Date().toISOString() };
  lastFailure = { hash: null, error: null, at: null };

  await logApply(seedPath, summary, 'success');
  return summary;
}

// ---------------------------------------------------------------------------------
// Turning the seed off.
//
// Only an APPLIED seed releases a row it no longer declares (applyListSection, applySections).
// Removing CONFIG_SEED_PATH altogether applied nothing, so every row the seed had created
// stayed `managed` - read-only in the interface and refused by the API - for ever, with no
// seed left to change it either : an instance that had used a seed once could never change
// those objects again (a runner adopted under Database mode, its credential, ...).
//
// So a start without CONFIG_SEED_PATH releases every managed row of every section the seed
// manages, exactly as an applied empty seed would, keeping the rows and their values. Once
// released there is nothing left to find, so every later start is a no-op that writes
// nothing : no log line, no audit entry.

// The single-row sections (applyLdap, applySettings, applyChat) : the table that holds the
// `managed` flag, and the name the release reports. The list sections carry theirs in
// listSections, through their crud config. Exported so a test can hold the two lists against
// every `managed` column in the schema, which is how a new seedable table cannot be missed.
export const singleRowSections = [
  { key: "ldap", table: "ldap" },
  { key: "settings", table: "settings" },
  { key: "chat", table: "chat_settings" },
];

/**
 * Release every row the seed manages, because the seed is off (CONFIG_SEED_PATH unset).
 *
 * Sets `managed` to 0 on every seedable table and nothing else : the rows, their values and
 * their secrets stay as they are, they only become editable again. The caches of the list
 * sections are flushed (and the other processes told) the way a save does it, so the
 * interface stops showing them read-only straight away.
 *
 * Says what it released at warning level, since objects change from read-only to editable
 * without anybody asking in the app, and writes an audit entry like an apply that released
 * something does. Neither happens when there was nothing to release.
 *
 * Returns:
 *   {string[]} What was released, as `label:name` for a list section and the section key
 *   for a single-row one - the same form as an apply's `released` list.
 *
 * Raises:
 *   Whatever the database throws. The caller (applyConfigSeed at boot) treats it as fatal,
 *   like any other failure of the seed.
 */
async function releaseWhenOff() {
  const released = [];
  const groups = [];

  // Step 1 : the list sections, one table each. The names first, for the log and the audit
  // entry - only the names, findAll would decrypt every secret for nothing.
  for (const section of listSections) {
    const config = CrudModel.getConfig(section.modelName);
    const rows = await mysql.do(`SELECT name FROM ${config.table} WHERE managed=1`);
    if (!rows.length) continue;
    await mysql.do(`UPDATE ${config.table} SET managed=0 WHERE managed=1`);
    CrudModel.changed(section.modelName);
    const names = rows.map((r) => r.name);
    released.push(...names.map((n) => `${section.label}:${n}`));
    groups.push(`${section.key}: ${names.join(", ")}`);
  }

  // Step 2 : the single-row sections, which have no name to report
  for (const section of singleRowSections) {
    const res = await mysql.do(`UPDATE AnsibleForms.\`${section.table}\` SET managed=0 WHERE managed=1`);
    if (res.affectedRows > 0) {
      released.push(section.key);
      groups.push(section.key);
    }
  }

  // Step 3 : say so, once. Nothing released (every start after the first) is silent.
  if (!released.length) return released;
  logger.warning(
    `Config seed is off: released ${released.length} managed row${released.length === 1 ? "" : "s"} ` +
    `(${groups.join("; ")}) so they can be changed in the app`
  );
  // the seed runs outside any request, so without this the rows would turn editable with
  // nothing in the trail saying when or why (the same reason logApply writes one)
  await Audit.log({
    action: "seed.release",
    outcome: "success",
    targetType: "seed",
    target: "CONFIG_SEED_PATH",
    detail: { released },
  });
  return released;
}

// ---------------------------------------------------------------------------------
// Live reload.
//
// The seed used to be the one file read exactly once. Everything else that comes from
// disk is already refreshed under the running process : repositories have a cron pull,
// config.yaml has PUT /settings/importConfig, the TLS certificate reloads itself. And
// health.model's configSeedCheck could already SEE the file change, but the only thing
// it could say about it was that the NEXT RESTART would refuse to start.
//
// Re-applying instead closes that gap. It matters most where the file is not edited by
// hand at all : on kubernetes a ConfigMap updated from git is remounted under the running
// pod within about a minute, so a change reaches the instance without rolling it - which
// is the whole point of declaring the configuration in git in the first place.
let lastApplied = { hash: null, at: null };
let lastFailure = { hash: null, error: null, at: null };

function hashOf(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * What the last apply and the last failed reload did, for the Status page. Deliberately
 * carries no part of the file itself : almost every value in it is a secret.
 */
export function getSeedState() {
  return {
    path: appConfig.configSeedPath || null,
    appliedAt: lastApplied.at,
    failure: lastFailure.at ? { at: lastFailure.at, error: lastFailure.error } : null,
  };
}

// Reset between tests. Not for production use : nothing in the application has any reason
// to forget what it has applied.
export function _resetSeedState() {
  lastApplied = { hash: null, at: null };
  lastFailure = { hash: null, error: null, at: null };
}

function recordFailure(hash, err, trigger) {
  const error = err.message || String(err);
  lastFailure = { hash, error, at: new Date().toISOString() };
  logger.error(`Config seed reload (${trigger}) failed, keeping the configuration already in force: ${error}`);
  return { status: "failed", error };
}

/**
 * Re-apply the seed under a running process.
 *
 * NEVER fatal, which is the one way this differs from the boot path. Refusing to start is
 * a safe failure - the old pod keeps serving under a rolling deployment and nothing has
 * changed anywhere. Exiting an instance that is already up, because a file it watches was
 * edited badly, would take the application down with no operator action at all - a typo in
 * git would be enough. So a failed reload keeps the configuration already in force, says so
 * in the log, and turns the Status page's seed row red.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force]   Apply even if the file is unchanged (the API and SIGHUP).
 * @param {string}  [opts.trigger] Where the call came from, for the log line.
 * @returns {Promise<object>} `{status}`, one of :
 *   off       - CONFIG_SEED_PATH is not set, nothing to do
 *   unchanged - byte for byte what was applied last
 *   skipped   - broken, and unchanged since it last failed
 *   applied   - re-applied, with the summary
 *   failed    - threw ; the previous configuration is kept
 */
async function reloadSeedNow({ force = false, trigger = "poll" } = {}) {
  const seedPath = appConfig.configSeedPath;
  if (!seedPath) return { status: "off" };

  let raw;
  try {
    raw = fs.readFileSync(seedPath, "utf8");
  } catch (e) {
    // A file that has gone missing is a failed reload like any other. The instance keeps
    // running on what it already applied, which is exactly what the operator would want
    // while a ConfigMap is being remounted underneath it.
    return recordFailure(null, e, trigger);
  }

  const hash = hashOf(raw);
  if (!force) {
    if (hash === lastApplied.hash) return { status: "unchanged" };
    // The same broken content as last time. Re-reading it every tick would write an
    // identical error to the log for ever and could not end differently : the file has to
    // change, or somebody has to ask for it explicitly, before another attempt is worth
    // anything. The Status page keeps reporting it in the meantime, so it is not lost.
    if (hash === lastFailure.hash) return { status: "skipped", error: lastFailure.error };
  }

  logger.notice(`Config seed re-apply triggered (${trigger})`);
  try {
    const summary = await applySeedNow();
    return { status: "applied", summary };
  } catch (e) {
    return recordFailure(hash, e, trigger);
  }
}

async function applySections(doc, summary) {
  for (const section of listSections) {
    // an absent section behaves like an empty one, so deleting a block from the file
    // releases its records rather than freezing them for ever
    await applyListSection(section, doc[section.key] || { items: [] }, summary);
  }

  await ensureRepositoryClones(doc, summary);

  if (doc.ldap) {
    await applyLdap(doc.ldap, summary);
  } else {
    const res = await mysql.do("UPDATE AnsibleForms.`ldap` SET managed=0 WHERE managed=1");
    if (res.affectedRows > 0) summary.released.push("ldap");
  }

  if (doc.settings) {
    await applySettings(doc.settings, summary);
  } else {
    const res = await mysql.do("UPDATE AnsibleForms.`settings` SET managed=0 WHERE managed=1");
    if (res.affectedRows > 0) summary.released.push("settings");
  }

  if (doc.chat) {
    await applyChat(doc.chat, summary);
  } else {
    const res = await mysql.do("UPDATE AnsibleForms.`chat_settings` SET managed=0 WHERE managed=1");
    if (res.affectedRows > 0) summary.released.push("chat");
  }

}

// One entry per apply that changed something. Names only : never a declared value,
// which is very often a secret. A no-op apply writes nothing, so the trail stays
// meaningful instead of gaining a row per restart.
async function logApply(seedPath, summary, outcome) {
  const counts = {
    created: summary.created.length,
    updated: summary.updated.length,
    released: summary.released.length,
    pruned: summary.pruned.length,
    unchanged: summary.unchanged,
  };
  if (outcome === 'success') logger.notice(
    `Config seed applied: ${counts.created} created, ${counts.updated} updated, ` +
    `${counts.released} released, ${counts.pruned} pruned, ${counts.unchanged} unchanged`
  );

  // The seed runs at startup, outside any request, so the audit middleware never sees
  // it - without this a credential would change owner with no trace of who or why.
  if (counts.created || counts.updated || counts.released || counts.pruned) {
    await Audit.log({
      action: "seed.apply",
      outcome,
      targetType: "seed",
      target: seedPath,
      // The lists ARE the counts - spreading `counts` in as well only produced keys the
      // arrays then overwrote, so `created` read as a list and `created` as a number
      // silently vanished. `unchanged` has no list, so it stays a number.
      detail: {
        created: summary.created,
        updated: summary.updated,
        released: summary.released,
        pruned: summary.pruned,
        adopted: summary.adopted,
        recloned: summary.recloned,
        unchanged: counts.unchanged,
      },
    });
  }
}

export { listSections, applyListSection };
export default { applyConfigSeed, reloadConfigSeed, getSeedState };
