// Runners : where a job runs. One row per RTE (runtime environment container) ; a form
// names one with `runner: <name>`, or runs on the default one of its type.
import CrudModel from './crud.model.js';
import { SECRET_MASK, isMasked } from '../lib/secretMask.js';
import Errors from '../lib/errors.js';
import logger from '../lib/logger.js';
import mysql from './db.model.js';
import { RUNNER_TYPES, getRunner } from '../runners/index.js';
import { stripTrailingSlashes } from '../lib/url.js';
import Credential from './credential.model.v2.js';
import { normalizeRunnerSettings } from '../rte/socket/settings.js';

// the flavours of an awx runner (none is AWX) : which product it is (its uri carries its API path)
export const RUNNER_FLAVOURS = ['aap', 'ascender'];
// the runners that sign in with a token and launch in one project of their server
const TOKEN_AND_PROJECT = ['semaphore', 'rundeck'];

// the secret the api shows instead of a stored token ; sent back it means "unchanged" (any run
// of asterisks : lib/secretMask.js)
export { SECRET_MASK };

// how an RTE talks to the app (RTE_MODE) : database (deprecated, the default), outbound (it
// dials the app) or inbound (the app dials it) - the socket modes hold no database credentials
export const RTE_MODES = ['database', 'outbound', 'inbound'];
// the modes that talk over a WebSocket (runners/rteHub.js) : defined with the socket's protocol
export { SOCKET_MODES } from '../rte/socket/protocol.js';

// a runner its RTE registered (rte/register.js) whose RTE has not answered for this long is
// removed by the worker ; until then the Runners page shows it as unresponsive
export const UNRESPONSIVE_REMOVE_SECONDS = 600;
// an RTE that asked to join and nobody approved : removed after a day, its credential with it
export const PENDING_REMOVE_HOURS = 24;
// how many RTEs may wait for approval at once : more are refused until some are approved or rejected
export const PENDING_MAX = 20;

class Runner extends CrudModel {
  static modelName = 'runner';

  static normalize(data, opts = {}) {
    // which RTE registered a runner is the RTE's to say (rte/register.js), never the api's
    if (!opts.fromRte) delete data.node_id;
    // waiting for approval is the RTE's to ask (rteHub.authenticate) and an admin's to end
    // (approve, reject), never set through the api
    if (!opts.fromRte) {
      delete data.pending;
      delete data.pending_since;
      delete data.pending_info;
      // the digest of the ca_bundle its RTE's certificate was stored as : the RTE hub's only
      // (rteHub.authenticate) ; cleared by update() when anyone else changes the bundle
      delete data.rte_cert_sha256;
    }
    // the version its server said it runs : its connection test's only (check)
    delete data.server_version;
    delete data.server_version_at;
    if (data.type !== undefined && !RUNNER_TYPES.includes(data.type)) {
      throw new Errors.BadRequestError(`Unknown runner type '${data.type}' - use one of ${RUNNER_TYPES.join(', ')}`);
    }
    // the api shows secrets masked ; the mask sent back means "unchanged"
    if (isMasked(data.token)) delete data.token;
    if (isMasked(data.password)) delete data.password;
    if (typeof data.uri === 'string') data.uri = stripTrailingSlashes(data.uri.trim());
    // a semaphore or rundeck runner signs in with its token only : a user and password are
    // an awx runner's choice
    // (jenkins signs in with a user and its API token : username and token, no password)
    if (TOKEN_AND_PROJECT.includes(data.type) || data.type === 'jenkins') data.use_credentials = 0;
    if (typeof data.project === 'string') data.project = data.project.trim() || null;
    // the image its container runs (informational) : trimmed, empty is none
    if (typeof data.rte_image === 'string') data.rte_image = data.rte_image.trim() || null;
    // an RTE's mode : database, outbound or inbound ; empty is database (as before 7.3)
    if (data.rte_mode !== undefined) {
      if (data.rte_mode === '' || data.rte_mode === null) data.rte_mode = null;
      else if (!RTE_MODES.includes(data.rte_mode)) {
        throw new Errors.BadRequestError(`Unknown runner mode '${data.rte_mode}' - use one of ${RTE_MODES.join(', ')}`);
      }
    }
    // turned on or off (Enable / Disable) : 1 or 0, whatever the client or the seed sends
    if (data.enabled !== undefined && data.enabled !== null) {
      data.enabled = data.enabled === true || data.enabled === 1 || data.enabled === '1' || data.enabled === 'true' ? 1 : 0;
    }
    // a socket-mode RTE's settings (the runner page's RTE tab) : a whole number in range, transfer
    // or local, or empty for the default
    const badSetting = normalizeRunnerSettings(data);
    if (badSetting) throw new Errors.BadRequestError(badSetting);
    // the flavour of an awx runner : 'aap', 'ascender', or none (AWX) - which product it is
    if (data.flavour !== undefined) {
      if (data.flavour === '' || data.flavour === null) data.flavour = null;
      else if (!RUNNER_FLAVOURS.includes(data.flavour)) {
        throw new Errors.BadRequestError(`Unknown runner flavour '${data.flavour}' - use one of ${RUNNER_FLAVOURS.join(', ')}, or none`);
      }
    }
    return data;
  }

  /**
   * Checks the credential a runner names : it exists and is of the runner's kind - an rte, a
   * semaphore, a rundeck or a jenkins one, an awx runner's an awx, an aap or an ascender one (one
   * product, the flavour may change). The config seed may still name an api or a userpass one, as
   * before 7.3 (deprecated).
   *
   * Args:
   *   row (object): the runner as it will be stored.
   *   opts (object): { fromSeed:true } for the config seed.
   *
   * Raises:
   *   BadRequestError: no such credential, or one of another type.
   */
  static async assertCredential(row, opts = {}) {
    if (!row.credential) return;
    const rows = await mysql.do('SELECT credential_type FROM AnsibleForms.`credentials` WHERE name = ?', [row.credential]);
    if (!rows.length) throw new Errors.BadRequestError(`No credential named '${row.credential}'`);
    const type = rows[0].credential_type;
    const kind = row.type === 'awx' ? row.flavour || 'awx' : row.type;
    // a builder signs in as a runner does : its token in an rte credential
    const wanted = row.type === 'awx' ? ['awx', 'aap', 'ascender'] : row.type === 'builder' ? ['rte'] : [row.type];
    if (wanted.includes(type)) return;
    const legacy = row.type === 'jenkins' ? ['userpass'] : row.type === 'awx' ? ['api', 'userpass'] : ['api'];
    if (opts.fromSeed && legacy.includes(type)) {
      logger.warning(`Runner '${row.name}': its credential '${row.credential}' is ${type}, deprecated for a runner since 7.3 - declare it as credential_type: ${kind}`);
      return;
    }
    throw new Errors.BadRequestError(`A ${kind} runner signs in with a ${kind} credential: '${row.credential}' is ${type}`);
  }

  /**
   * A runner as it signs in : the token, user and password of its credential (Connections >
   * Credentials, read from its secret store when it names one), else its own.
   *   - an api credential : its password the token
   *   - a userpass one : an AWX's user and password (use credentials), a Jenkins user and its
   *     API token
   *
   * Args:
   *   row (object): the runner, as stored (decrypted).
   *
   * Returns:
   *   Promise<object>: a copy, its secrets its credential's when it names one.
   */
  static async withCredential(row) {
    if (!row?.credential) return row;
    // where it connects : its credential's address and TLS when that carries an address
    const conn = await this.connectionFor(row);
    if (conn) row = { ...row, ...conn };
    const cred = await Credential.resolveByName(row.credential).catch((e) => {
      logger.error(`Couldn't read the credential '${row.credential}' of the runner '${row.name}': ${e.message || e}`);
      return null;
    });
    if (!cred) return row;
    if (row.type === 'jenkins') return { ...row, username: cred.user || '', token: cred.password || '' };
    if (row.type === 'awx' && cred.user) {
      return { ...row, use_credentials: 1, username: cred.user, password: cred.password || '', token: null };
    }
    return { ...row, use_credentials: 0, token: cred.password || '' };
  }

  /**
   * Where a runner connects when its credential carries an address : that address and its TLS.
   * An RTE that registered itself keeps its own (it writes its address and token itself).
   *
   * Args:
   *   row (object): the runner.
   *
   * Returns:
   *   Promise<object|null>: { uri, ignore_certs, ca_bundle }, or null : its own address.
   */
  static async connectionFor(row) {
    if (!row?.credential || row.node_id) return null;
    const conn = await Credential.connectionOf(row.credential).catch(() => null);
    return conn ? { uri: conn.url, ignore_certs: conn.ignore_certs, ca_bundle: conn.ca_bundle } : null;
  }

  // What each type needs to work, checked on the row as it will be stored ; a credential gives
  // its secrets (Runner.assertCredential checks it), and its address when it carries one
  static assertComplete(row, credentialAddress = false) {
    const missing = (field) => { throw new Errors.BadRequestError(`A runner of type ${row.type} needs ${field}`); };
    // an outbound RTE dials the app : the app needs no address of it
    const outbound = (row.type === 'rte' || row.type === 'builder') && row.rte_mode === 'outbound';
    if (!row.uri && !credentialAddress && !outbound) {
      missing('an address: a credential with a server address, or its own uri');
    }
    if (row.credential) {
      if (TOKEN_AND_PROJECT.includes(row.type) && !row.project) {
        missing(row.type === 'semaphore' ? 'a project (the project id)' : 'a project (the project name)');
      }
      return;
    }
    if (row.type === 'rte' && !row.token) missing('a token (the RTE_TOKEN of the runner)');
    if (TOKEN_AND_PROJECT.includes(row.type)) {
      if (!row.token) missing('an API token');
      if (!row.project) missing(row.type === 'semaphore' ? 'a project (the project id)' : 'a project (the project name)');
    }
    // a jenkins runner : a user and its API token ; its folder (project) is optional
    if (row.type === 'jenkins') {
      if (!row.username) missing('a username (the Jenkins user the API token is of)');
      if (!row.token) missing('an API token');
    }
    if (row.type === 'awx') {
      if (row.use_credentials) {
        if (!row.username || !row.password) missing('a username and a password (use credentials is on)');
      } else if (!row.token) {
        missing('a token, or use credentials with a username and a password');
      }
    }
  }

  // The default of a type is a managed row's to keep : an API caller may not take it away
  // from one
  static async assertDefaultAllowed(data, type, opts) {
    if (data.is_default && !opts.fromSeed) {
      const held = await mysql.do('SELECT name FROM AnsibleForms.`runners` WHERE is_default = 1 AND managed = 1 AND type = ?', [type]);
      if (held.length) {
        throw new Errors.AccessDeniedError(`The default ${type} runner is managed by the config seed ('${held[0].name}') and cannot be changed here`);
      }
    }
  }

  // One default per type : after the write, never before it - a refused write must not
  // clear the others
  static async clearOtherDefaults(keepId, type, opts = {}) {
    logger.info(`Unsetting is_default on the other ${type} runners`);
    const scope = opts.fromSeed ? '' : ' AND managed = 0';
    await mysql.do('UPDATE AnsibleForms.`runners` SET is_default = 0 WHERE id <> ? AND type = ?' + scope, [keepId, type]);
    this.changed(this.modelName);
  }

  // opts carries { fromSeed:true } for the declarative config seed only
  static async create(data, opts = {}) {
    CrudModel.assertRequired(this.modelName, data);
    data = this.normalize(data, opts);
    const conn = await this.connectionFor(data);
    // its credential's address empties its own : one place for it (the seed keeps what it declares)
    if (conn && !opts.fromSeed) Object.assign(data, { uri: '', ignore_certs: 0, ca_bundle: null });
    this.assertComplete(data, !!conn);
    await this.assertCredential(data, opts);
    // The first runner of a type is its default : forms of that type that name no runner need
    // one, and nobody should have to remember the tick. Not for the seed, which declares the
    // flag itself - setting it here would flip it back on every start.
    // ... never one waiting for approval : it becomes the default when it is approved ; nor one a
    // repository's file makes, which says itself whether it is the default (lib/repoObjects)
    // a builder is never a default : no form runs on it
    if (!data.is_default && data.type !== 'builder' && !opts.fromSeed && !opts.fromRepo && !data.pending && !(await this.findDefault(data.type))) {
      data.is_default = 1;
    }
    await this.assertDefaultAllowed(data, data.type, opts);
    const insertId = await super.create(this.modelName, data, opts);
    if (data.is_default && insertId) await this.clearOtherDefaults(insertId, data.type, opts);
    return insertId;
  }

  static async update(data, id, opts = {}) {
    await CrudModel.checkExist(this.modelName, id);
    if (!opts.fromSeed) await CrudModel.assertNotManaged(this.modelName, id);
    data = this.normalize(data, opts);
    // the stored row decides what is missing : an update may send only what changed
    const current = await this.findStoredById(id);
    // its type stays what it was made as (the forms that run on it expect it) ; an AWX one may
    // change flavour (AWX, AAP, Ascender), the same type. The config seed may change it.
    if (!opts.fromSeed && data.type !== undefined && current?.type && data.type !== current.type) {
      throw new Errors.BadRequestError(`A runner keeps the type it was made as: '${current.name}' is ${current.type}. Make a new runner for another type`);
    }
    const merged = { ...current, ...data };
    const conn = await this.connectionFor(merged);
    if (conn && !opts.fromSeed) {
      Object.assign(data, { uri: '', ignore_certs: 0, ca_bundle: null });
      Object.assign(merged, data);
    }
    // a ca_bundle changed by anyone but the RTE hub is theirs : its RTE never replaces it
    const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
    if (!opts.fromRte && data.ca_bundle !== undefined && text(data.ca_bundle) !== text(current?.ca_bundle)) {
      data.rte_cert_sha256 = null;
    }
    this.assertComplete(merged, !!conn);
    if ('credential' in data) await this.assertCredential(merged, opts);
    await this.assertDefaultAllowed(data, merged.type, opts);
    const res = await super.update(this.modelName, data, id, opts);
    if (data.is_default) await this.clearOtherDefaults(id, merged.type, opts);
    return res;
  }

  static async delete(id, opts = {}) {
    return super.delete(this.modelName, id, opts);
  }

  // read as they sign in : a runner naming a credential has its token, user and password
  static async findAll() {
    const rows = await super.findAll(this.modelName);
    return Promise.all((rows || []).map((r) => this.withCredential(r)));
  }

  static async findById(id) {
    return this.withCredential(await super.findById(this.modelName, id));
  }

  static async findByName(name) {
    return this.withCredential(await super.findByName(this.modelName, name));
  }

  // as stored, its own secrets (an update merges onto these : never the credential's)
  static async findStoredById(id) {
    return super.findById(this.modelName, id);
  }

  /**
   * Approves an RTE that asked to join : it is enabled and takes jobs from now on, and becomes
   * the default of its type when there is none.
   *
   * Args:
   *   id (number): the runner.
   *
   * Returns:
   *   Promise<object>: the runner.
   *
   * Raises:
   *   NotFoundError: no such runner ; BadRequestError: it is not waiting for approval.
   */
  static async approve(id) {
    const row = await this.findStoredById(id);
    if (!row) throw new Errors.NotFoundError(`No runner with id ${id}`);
    if (!Number(row.pending)) throw new Errors.BadRequestError(`Runner '${row.name}' is not waiting for approval`);
    const data = { pending: 0, pending_since: null, pending_info: null, enabled: 1 };
    if (row.type !== 'builder' && !(await this.findDefault(row.type))) data.is_default = 1;
    await CrudModel.update(this.modelName, data, id, { fromRte: true });
    if (data.is_default) await this.clearOtherDefaults(id, row.type);
    logger.notice(`Runner '${row.name}' approved: it takes jobs from now on`);
    this.changed(this.modelName);
    return this.findStoredById(id);
  }

  /**
   * Rejects an RTE that asked to join : the runner goes, with the credential its token was kept
   * in. The RTE may ask again ; it then waits for approval again.
   *
   * Args:
   *   id (number): the runner.
   *
   * Returns:
   *   Promise<object>: the runner as it was.
   *
   * Raises:
   *   NotFoundError: no such runner ; BadRequestError: it is not waiting for approval.
   */
  static async reject(id) {
    const row = await this.findStoredById(id);
    if (!row) throw new Errors.NotFoundError(`No runner with id ${id}`);
    if (!Number(row.pending)) throw new Errors.BadRequestError(`Runner '${row.name}' is not waiting for approval`);
    await this.removeWithCredential(row);
    logger.notice(`Runner '${row.name}' rejected: it was removed with its credential`);
    return row;
  }

  /**
   * Removes a runner that asked to join, and the credential made for its token then (never one
   * the config seed manages) ; that credential's file too when a credentials repository holds it
   * (lib/repoObjects), under the repository's write claim - or its next pull would make it again.
   *
   * Args:
   *   row (object): the runner as stored.
   *
   * Raises:
   *   Errors.ConflictError: the credentials repository still busy once the wait is over (nothing
   *     removed).
   */
  static async removeWithCredential(row) {
    const rows = row.credential ? await mysql.do('SELECT * FROM AnsibleForms.`credentials` WHERE name = ?', [row.credential]) : [];
    const credential = (rows || []).find((c) => c.name === row.credential && c.credential_type === 'rte' && !Number(c.managed || 0));
    const { default: RepoObjects } = await import('../lib/repoObjects/index.js');
    await RepoObjects.holding([], async () => {
      await mysql.do('DELETE FROM AnsibleForms.`runners` WHERE id = ?', [row.id]);
      if (credential) {
        await mysql.do('DELETE FROM AnsibleForms.`credentials` WHERE id = ?', [credential.id]);
        if (credential.repository) await RepoObjects.appDeleted('credentials', credential);
      }
    }, credential || null);
    this.changed(this.modelName);
  }

  /**
   * How many RTEs wait for approval.
   *
   * Returns:
   *   Promise<number>
   */
  static async countPending() {
    // the runners' (the header bell, Connections > Runners) ; the builders wait in the Designer
    const rows = await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`runners` WHERE pending = 1 AND type <> 'builder'");
    return Number(rows?.[0]?.n || 0);
  }

  /**
   * The worker's sweep : RTEs that asked to join and nobody approved within
   * PENDING_REMOVE_HOURS, removed with their credential.
   *
   * Returns:
   *   Promise<number>: how many.
   */
  static async removeStalePending() {
    const rows = await mysql.do(
      'SELECT id, name, credential FROM AnsibleForms.`runners` WHERE pending = 1 AND pending_since < (NOW() - INTERVAL ? HOUR)',
      [PENDING_REMOVE_HOURS],
    );
    for (const row of rows || []) await this.removeWithCredential(row);
    return (rows || []).length;
  }

  /** the runner of this type marked default, or null */
  static async findDefault(type) {
    const all = await this.findAll();
    return (all || []).find((r) => r.is_default && r.type === type) || null;
  }

  /**
   * The worker's sweep : runners an RTE registered itself whose RTE has not written its
   * heartbeat for UNRESPONSIVE_REMOVE_SECONDS - a recreated container registered again under
   * its new address. Never a runner added by hand or by the seed. A runner whose node row is
   * missing is left alone : its RTE may not have written its first heartbeat yet.
   */
  static async removeUnresponsive() {
    // a plain DELETE with a subquery : a multi-table DELETE resolves its alias against the
    // connection's default database, and ours has none ("No database selected")
    const res = await mysql.do(
      'DELETE FROM AnsibleForms.`runners` WHERE node_id IS NOT NULL AND COALESCE(managed, 0) = 0 ' +
        'AND node_id IN (SELECT id FROM AnsibleForms.`nodes` WHERE last_seen < (NOW() - INTERVAL ? SECOND))',
      [UNRESPONSIVE_REMOVE_SECONDS],
    );
    const n = res?.affectedRows || 0;
    if (n) this.changed(this.modelName);
    return n;
  }

  /**
   * The row an RTE registered itself (rte/register.js) at the address a seed item declares,
   * or null. The seed adopts it instead of adding a second runner for the same RTE : an RTE
   * starts with the app, so its first registration can land before the seed is applied.
   * Only a registered row (node_id set, not managed) : a row added by hand is somebody's work.
   *
   * Args:
   *   item (object): the declared runner, its `type` and `uri`.
   *
   * Returns:
   *   object|null: the registered row at that address, or null.
   */
  static async findRegisteredAt(item) {
    if (item?.type !== 'rte' || typeof item.uri !== 'string') return null;
    const uri = stripTrailingSlashes(item.uri.trim());
    const all = (await this.findAll()) || [];
    return all.find((r) => r.type === 'rte' && r.node_id && !r.managed && stripTrailingSlashes(String(r.uri || '')) === uri) || null;
  }

  /**
   * The seed takes over a row an RTE registered itself : the declared fields, the declared
   * name, and no longer a registered row (node_id cleared), so the worker's sweep of
   * unresponsive RTEs never removes it. The jobs that ran on it follow its new name.
   *
   * Args:
   *   data (object): the record the seed writes (managed).
   *   row (object): the registered row, from findRegisteredAt.
   *   opts (object): { fromSeed: true }.
   *
   * Returns:
   *   Promise<boolean>: whether the row was written.
   */
  static async adoptRegistered(data, row, opts = {}) {
    const res = await this.update({ ...data, node_id: null }, row.id, { ...opts, fromRte: true });
    if (data.name && data.name !== row.name) await this.moveJobs(row.name, data.name);
    return res;
  }

  /**
   * A row an RTE registered itself at the address of a seeded row : a second runner for one
   * RTE, left by a registration that landed while the seed was creating its row. Removed, its
   * jobs moved to the seeded row.
   *
   * Args:
   *   row (object): the registered row.
   *   keep (object): the seeded row at the same address.
   *
   * Returns:
   *   Promise<boolean>: whether the row was removed.
   */
  static async removeDuplicate(row, keep) {
    await this.moveJobs(row.name, keep.name);
    return this.delete(row.id, { fromRte: true });
  }

  // jobs name their runner (jobs.runner) : the ones that ran on a runner that changes its
  // name, or goes into another, name the runner it is now
  static async moveJobs(from, to) {
    await mysql.do('UPDATE AnsibleForms.`jobs` SET runner = ? WHERE runner = ?', [to, from]);
  }

  /**
   * Proves the runner answers and accepts us ; what it reports is up to the runner type. The
   * version a runner of another kind than the AnsibleForms ones says it runs is kept on its row
   * with when it was read, and stays while the server is unreachable (an AnsibleForms runner
   * says its own over its socket).
   *
   * Args:
   *   runner (object): the runner.
   *
   * Returns:
   *   Promise<object>: what its type reports (version among it, when it gives one).
   *
   * Raises:
   *   BadRequestError: a type without a connection test, or the test failed.
   */
  static async check(runner) {
    const impl = getRunner(runner.type);
    if (!impl.check) throw new Errors.BadRequestError(`A ${runner.type} runner has no connection test`);
    const info = await impl.check(runner);
    const version = String(info?.version ?? '').trim().slice(0, 100);
    if (version && runner?.id && !['rte', 'builder'].includes(runner.type)) {
      await mysql
        .do('UPDATE AnsibleForms.`runners` SET server_version = ?, server_version_at = NOW() WHERE id = ?', [version, runner.id])
        // the cached rows dropped, here and on the other processes, so its page shows it at once
        .then(() => CrudModel.changed(this.modelName))
        .catch((e) => logger.warning(`Could not keep the version of runner '${runner.name}': ${e.message}`));
    }
    return info;
  }
}

export default Runner;
