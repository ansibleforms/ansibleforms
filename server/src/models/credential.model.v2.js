import CrudModel from './crud.model.js';
import Errors from '../lib/errors.js';
import logger from '../lib/logger.js';
import mysql from './db.model.js';
import crypto from '../lib/crypto.js';
import { readSecret, mapPayloadToCredential, parseInlineSecret, VAULT_STORE_NAME } from '../secrets/providers/index.js';
import dbConfig from '../../config/db.config.js';
import { stripTrailingSlashes } from '../lib/url.js';
import { isMasked } from '../lib/secretMask.js';
import { currentScope, assertCredentialAllowed, assertSecretStoreAllowed } from "../lib/resourceScope.js";

class CredentialModel extends CrudModel {
  static modelName = 'credential';

  // vault_path is deprecated : a credential names its store and the place in it. A write
  // that still uses vault_path is pointed at the store named `vault`, and a write that
  // names a store clears vault_path, so the two can never disagree.
  static mirrorVaultPath(data) {
    if (data.secret_store === '') data.secret_store = null;
    if (data.vault_path && !data.secret_store) {
      logger.warning(`Credential '${data.name || ''}': vault_path is deprecated since 7 and removed in 8 - use secret_store and secret_ref`);
      data.secret_store = VAULT_STORE_NAME;
      data.secret_ref = data.vault_path;
    } else if (data.secret_store !== undefined) {
      data.vault_path = null;
    }
    return data;
  }

  // the types a credential can be : what it is for. A cyberark one is how a CyberArk secret
  // store logs in : its AppID (user), and a client certificate and key when the AppID is
  // restricted to one
  // userpass : a user and a password for any login (a REST API, a service...), the default ; ssh :
  // one for SSH to a server, the login a workflow node's playbook connects with
  // ldap : an LDAP directory's bind account (its user the bind DN) ; entraid and oidc : an SSO
  // provider's client (its user the client id, its password the client secret ; an entraid one its
  // tenant too, an oidc one its issuer) ; smtp : a mail server (its host, port and TLS) and its
  // login (none for a relay)
  // rte, awx, aap, ascender, semaphore, rundeck and jenkins : how a runner of that kind signs in,
  // and where (its url) ; vault : how a HashiCorp Vault secret store logs in (its password the
  // token), and where
  static TYPES = ['userpass', 'ssh', 'git', 'api', 'database', 'cyberark', 'smtp', 'ldap', 'entraid', 'oidc',
    'rte', 'awx', 'aap', 'ascender', 'semaphore', 'rundeck', 'jenkins', 'vault'];

  /**
   * Keeps a credential's type and its is_database flag in step : the type sets the flag, and
   * a write that only sends the flag (an older client, the seed) gets the matching type -
   * database, or userpass on a create.
   *
   * Args:
   *   data (object): the record written.
   *   creating (boolean): a create (a credential without a type is a userpass one).
   *
   * Returns:
   *   object: the record.
   *
   * Raises:
   *   Error: an unknown type.
   */
  static mirrorType(data, creating = false) {
    if (data.credential_type !== undefined && data.credential_type !== null && data.credential_type !== '') {
      if (!this.TYPES.includes(data.credential_type)) {
        throw new Errors.BadRequestError(`Unknown credential type '${data.credential_type}': one of ${this.TYPES.join(', ')}`);
      }
      data.is_database = data.credential_type === 'database' ? 1 : 0;
    } else if (data.is_database !== undefined) {
      if (data.is_database && data.is_database !== '0') data.credential_type = 'database';
      else if (creating) data.credential_type = 'userpass';
    } else if (creating) {
      // the column's default makes it a database credential : say so
      data.credential_type = 'database';
    }
    return data;
  }

  /**
   * A credential's port as its column takes it : a whole number, or none. A credential without a
   * host (an api, a git or an smtp one) sends it empty, and MySQL refused '' for the int column
   * ("Incorrect integer value: '' for column 'port'") - saving a type change failed.
   *
   * Args:
   *   data (object): the record written.
   *
   * Returns:
   *   object: the record.
   *
   * Raises:
   *   BadRequestError: a port that is not a whole number from 1 to 65535.
   */
  static normalizePort(data) {
    if (data.port === undefined) return data;
    if (data.port === null || String(data.port).trim() === '') {
      data.port = null;
      return data;
    }
    const port = Number(String(data.port).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Errors.BadRequestError(`A credential's port is a whole number from 1 to 65535: '${data.port}' is not`);
    }
    data.port = port;
    return data;
  }

  /**
   * The fields a type cannot do without : an Entra ID credential's tenant (the sign-in needs it),
   * an Open ID one's issuer, an smtp one's host (the mail server), an ldap one's host (its
   * directory's servers). A create of one without it is
   * refused, and so is an update that empties it ; a type without a tenant or an issuer keeps
   * none.
   *
   * Args:
   *   data (object): the record written.
   *   creating (boolean): a create (the type and its fields are all there).
   *   opts (object): { fromSeed:true } for the config seed, which may leave a server out.
   *
   * Returns:
   *   object: the record.
   *
   * Raises:
   *   BadRequestError: an Entra ID credential without a tenant, an Open ID one without an
   *     issuer, an smtp one without a host, a runner's or a secret store's without its server.
   */
  static requireTypeFields(data, creating = false, opts = {}) {
    const empty = (key) => (data[key] === undefined ? creating : !String(data[key] ?? '').trim());
    if (data.credential_type !== undefined && data.credential_type !== 'entraid') {
      if (creating || data.tenant_id !== undefined) data.tenant_id = null;
    } else if (data.credential_type === 'entraid' && empty('tenant_id')) {
      throw new Errors.BadRequestError('A Microsoft Entra ID credential needs its tenant ID (tenant_id)');
    }
    if (data.credential_type !== undefined && data.credential_type !== 'oidc') {
      if (creating || data.issuer !== undefined) data.issuer = null;
    } else if (data.credential_type === 'oidc' && empty('issuer')) {
      throw new Errors.BadRequestError('An Open ID credential needs its issuer (the provider\'s address)');
    }
    if (data.issuer !== undefined && data.issuer !== null) data.issuer = String(data.issuer).trim();
    // a redirect URL : an entraid or an oidc one's only
    if (data.credential_type !== undefined && !['entraid', 'oidc'].includes(data.credential_type)) {
      if (creating || data.redirect_uri !== undefined) data.redirect_uri = null;
    } else if (data.redirect_uri !== undefined && data.redirect_uri !== null) {
      data.redirect_uri = String(data.redirect_uri).trim() || null;
    }
    if (data.credential_type === 'smtp' && empty('host')) {
      throw new Errors.BadRequestError('An smtp credential needs its mail server (host)');
    }
    if (data.credential_type === 'ldap' && empty('host')) {
      throw new Errors.BadRequestError('An ldap credential needs its directory servers (host)');
    }
    if (data.tenant_id !== undefined && data.tenant_id !== null) data.tenant_id = String(data.tenant_id).trim();
    // a server address : a runner's or a secret store's only (the one server it logs in to), and
    // one it needs
    if (data.credential_type !== undefined && !this.URL_TYPES.includes(data.credential_type)) {
      if (creating || data.url !== undefined) data.url = null;
    } else if (data.url !== undefined && data.url !== null) {
      data.url = stripTrailingSlashes(String(data.url).trim()) || null;
    }
    // an rte credential may have none : an outbound RTE dials the app, which needs no address of
    // it (the runner checks its own : Runner.assertComplete)
    if (!opts.fromSeed && this.URL_TYPES.includes(data.credential_type) && data.credential_type !== 'rte' && empty('url')) {
      throw new Errors.BadRequestError(`A ${data.credential_type} credential needs its server (url)`);
    }
    return data;
  }

  // the types that carry the address of the one server they log in to (Credential.url) : a
  // runner's and a secret store's
  static URL_TYPES = ['rte', 'awx', 'aap', 'ascender', 'semaphore', 'rundeck', 'jenkins', 'vault', 'cyberark'];

  // the types a sign-in reads its client, its tenant or issuer, or its bind account from : an LDAP
  // directory's bind account, an Entra ID or Open ID provider's client. Whoever changes one
  // chooses who signs in, and where the sign-in sends its secret : an admin's to change.
  static SIGNIN_TYPES = ['ldap', 'entraid', 'oidc'];

  // the fields that say where a credential's secret goes : its server (host and port), its
  // provider (issuer, tenant) or its address (url). A change of any of them by a user who did not
  // type the secret again must not take the stored secret along to the new target.
  static TARGET_FIELDS = ['host', 'port', 'issuer', 'tenant_id', 'url'];

  /**
   * Whether a credential is an admin's to change and to name : one a connection takes its address
   * from (URL_TYPES), one a sign-in reads (SIGNIN_TYPES), one that reads its password from a
   * secret store (secret_store, or the deprecated vault_path : only an admin chooses which secret,
   * controllers/v2/credential.controller.js assertSecretRefUnchanged), or one a runner names,
   * whatever its type. A user with only connections access may not point a notification channel or
   * a repository at it : both would hand its secret to a server of their choosing.
   *
   * Args:
   *   record (object|null): the credential ({ name, credential_type, secret_store, vault_path }).
   *
   * Returns:
   *   Promise<boolean>: true when only an admin may change or name it.
   */
  static async isAdminGuarded(record) {
    if (!record) return false;
    if (this.URL_TYPES.includes(record.credential_type)) return true;
    if (this.SIGNIN_TYPES.includes(record.credential_type)) return true;
    // a secret an admin chose to read from a secret store : named elsewhere by a connections user,
    // it would be sent to the address of their webhook or repository
    if (String(record.secret_store || '').trim() || String(record.vault_path || '').trim()) return true;
    return !!(record.name && (await this.runnersUsing(record.name)).length);
  }

  /**
   * The first of the credentials a record names that only an admin may name (isAdminGuarded).
   *
   * Args:
   *   names (string[]): the credential names, empty ones left out.
   *
   * Returns:
   *   Promise<string|null>: the first such name, or null when none is.
   */
  static async firstAdminGuarded(names) {
    for (const name of (names || []).filter(Boolean)) {
      if (await this.isAdminGuarded(await this.findRowByName(name))) return name;
    }
    return null;
  }

  /**
   * The credential a record names, read by its exact name without its secret : the row as the
   * credentials table holds it, or null when there is none.
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<object|null>: { name, credential_type, ... }, or null.
   */
  static async findRowByName(name) {
    if (!name) return null;
    return super.findByName(this.modelName, name);
  }

  /**
   * Whether a write moves a credential's secret to another target : one of TARGET_FIELDS sent
   * with another value than the stored one (text compared trimmed, so '389' and 389 are one).
   *
   * Args:
   *   before (object): the credential as it is.
   *   data (object): the fields written.
   *
   * Returns:
   *   boolean: true when the write points it elsewhere.
   */
  static targetChanged(before, data) {
    // a url is stored without its trailing slashes (requireTypeFields) : compared the same way
    const text = (f, v) => {
      const t = v === null || v === undefined ? '' : String(v).trim();
      return f === 'url' ? stripTrailingSlashes(t) : t;
    };
    return this.TARGET_FIELDS.some((f) => data?.[f] !== undefined && text(f, data[f]) !== text(f, before?.[f]));
  }

  /**
   * Where a credential connects : its server address and TLS, when it carries an address. A
   * secret store or a runner that names it then connects there (models/secretStore.model.js,
   * models/runner.model.js), whatever its own address.
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<object|null>: { url, ignore_certs, ca_bundle }, or null when it does not exist or
   *     carries no address.
   */
  static async connectionOf(name) {
    if (!name) return null;
    const cred = await CrudModel.findByName(this.modelName, name);
    const url = String(cred?.url || '').trim();
    if (!url) return null;
    return { url, ignore_certs: cred.ignore_certs ? 1 : 0, ca_bundle: cred.ca_bundle || null };
  }

  /**
   * Guards rte_cert_sha256, the digest of the ca_bundle an inbound RTE's certificate was stored
   * as (runners/rteHub.js) : only the RTE hub writes it (opts.fromRte), never the API nor the
   * seed. A write by anyone else that changes the ca_bundle clears it : the bundle is then the
   * admin's, and the RTE never replaces it.
   *
   * Args:
   *   data (object): the record written (changed in place).
   *   current (object|null): the credential as stored, null on a create.
   *   opts (object): { fromRte:true } for the RTE hub.
   *
   * Returns:
   *   object: the record.
   */
  static guardRtePin(data, current, opts = {}) {
    if (opts.fromRte) return data;
    delete data.rte_cert_sha256;
    const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
    if (current && data.ca_bundle !== undefined && text(data.ca_bundle) !== text(current.ca_bundle)) {
      data.rte_cert_sha256 = null;
    }
    return data;
  }

  // opts carries { fromSeed:true } for the declarative config seed only
  static async create(data, opts = {}) {
    this.guardRtePin(data, null, opts);
    return super.create(this.modelName, this.requireTypeFields(this.mirrorType(this.mirrorVaultPath(this.normalizePort(data)), true), true, opts), opts);
  }

  static async update(data, id, opts = {}) {
    // the api shows the client key masked ; the mask sent back means "unchanged", and an
    // empty one too (the dialog leaves a secret empty to keep it)
    if (isMasked(data.client_key) || data.client_key === '') delete data.client_key;
    // its type stays what it was made as (what uses it expects it : an SSO provider an entraid
    // one, a mail channel an smtp one) ; the config seed may change it
    if (!opts.fromSeed && data.credential_type !== undefined && data.credential_type !== null && data.credential_type !== '') {
      const current = await this.findById(id);
      if (current?.credential_type && data.credential_type !== current.credential_type) {
        throw new Errors.BadRequestError(`A credential keeps the type it was made as: '${current.name}' is ${current.credential_type}. Make a new credential for another type`);
      }
    }
    // the RTE's pin : the hub's to write ; a changed ca_bundle is the writer's from now on
    const stored = !opts.fromRte && data.ca_bundle !== undefined ? await this.findById(id) : null;
    this.guardRtePin(data, stored, opts);
    return super.update(this.modelName, this.requireTypeFields(this.mirrorType(this.mirrorVaultPath(this.normalizePort(data))), false, opts), id, opts);
  }

  static async delete(id, opts = {}) {
    const res = await super.delete(this.modelName, id, opts);
    // the regex lookups below are cached under their pattern, not under the name, so a
    // deleted credential must not stay resolvable through them until the ttl runs out
    this.changed(this.modelName);
    return res;
  }

  static async findAll() {
    return super.findAll(this.modelName);
  }

  /**
   * How many records use each credential, as its page's Used by tab lists them : the secret
   * stores, notification channels (a login or a token), repositories, LDAP directories, SSO
   * providers, runners, databases and the chat assistant that name it. The forms and the
   * designer's workflows are counted by the caller (lib/formLinks.js formCredentials, models/workflowRun.js
   * workflowCredentials), as they live in files, not in a table.
   *
   * Returns:
   *   Promise<Map<string, number>>: the count of each credential name used at least once.
   */
  static async usageCounts() {
    const rows = await mysql.do(
      "SELECT name, COUNT(*) AS n FROM (" +
        "SELECT credential AS name FROM AnsibleForms.`secret_stores` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`notification_channels` " +
        "UNION ALL SELECT token_credential FROM AnsibleForms.`notification_channels` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`repositories` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`ldap` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`oauth2_providers` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`runners` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`databases` " +
        "UNION ALL SELECT credential FROM AnsibleForms.`chat_settings`" +
        ") used WHERE name IS NOT NULL AND name <> '' GROUP BY name",
    );
    return new Map((rows || []).map((r) => [r.name, Number(r.n) || 0]));
  }

  /**
   * How many records use one credential (usageCounts : the tables that name it, not the forms
   * nor the workflows). What a delete or a rename would leave pointing at nothing.
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<number>: how many records name it, 0 when none.
   */
  static async usageOf(name) {
    if (!name) return 0;
    return (await this.usageCounts()).get(name) || 0;
  }

  /**
   * The runners that sign in with a credential : whoever changes it chooses where their jobs'
   * secrets go, whatever its type (a runner may still name a deprecated api or userpass one).
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<string[]>: the names of the runners that name it, empty when none.
   */
  static async runnersUsing(name) {
    if (!name) return [];
    const rows = await mysql.do("SELECT name FROM AnsibleForms.`runners` WHERE credential = ?", [name]);
    return (rows || []).map((r) => r.name);
  }

  static async findById(id) {
    return super.findById(this.modelName, id);
  }

  // Exact name, every column of the row (the API's ?name= and fnCredentials use it).
  // user/password come from the secret store when the row names one.
  static async findByName(name) {
    // the roles of the user this runs for may limit the credentials (lib/resourceScope.js)
    assertCredentialAllowed(name);
    const cached = await super.findByName(this.modelName, name);
    if (!cached) return cached;
    const result = { ...cached };
    const source = secretSource(result);
    if (source) await overlaySecret(result, source, !!result.is_database);
    stripSecretSource(result);
    return result;
  }

  // The one place a credential is resolved for use: by database queries, by playbook and
  // AWX jobs and by the REST expression helpers.
  // nameOrRegex is a MySQL REGEXP ; fallbackName is tried when it matches nothing.
  // Returns a fresh object on every call - callers reshape it (mysql.js does).
  static async resolveCredential(nameOrRegex, fallbackName = "") {
    // no name in the log : callers pass names taken from extravars, which CodeQL rightly
    // cannot tell apart from the secrets next to them
    logger.debug("Resolving a credential");
    // "vault:<path>" / "secret:<store>:<ref>" : straight from the store, no row
    const inline = parseInlineSecret(nameOrRegex);
    if (inline) return shapeInlineSecret(nameOrRegex, await this.readInlineSecret(nameOrRegex, inline));
    const row = await this.lookupCachedRow(nameOrRegex, fallbackName);
    // the roles of the user this runs for may limit the credentials (lib/resourceScope.js) :
    // checked on the name the pattern found, not on the pattern
    assertCredentialAllowed(row.name);
    const result = { ...row };
    const isDatabase = !!result.is_database;
    if (result.is_database) {
      result.multipleStatements = true;
    } else {
      delete result.secure;
      delete result.db_name;
      delete result.db_type;
      delete result.is_database;
    }
    const source = secretSource(result);
    if (source) {
      await overlaySecret(result, source, isDatabase);
    } else {
      try {
        result.password = crypto.decrypt(result.password);
      } catch {
        logger.error("Failed to decrypt the password.  Did the secretkey change ?");
        result.password = "";
      }
    }
    stripSecretSource(result);
    return result;
  }

  /**
   * The raw secret an inline reference points at, once the roles of the user this runs for
   * allow it (assertInlineAllowed) : the one way an inline secret is read, by resolveCredential
   * and by fnCredentials, which reshapes the raw secret with its jq before mapping it.
   *
   * Args:
   *   spec (string): the reference, "vault:<path>" or "secret:<store>:<ref>".
   *   inline (object): its store and ref, parseInlineSecret(spec) by default.
   *
   * Returns:
   *   Promise<object>: the secret, as its store gives it.
   *
   * Raises:
   *   Errors.AccessDeniedError: the scope does not allow it.
   *   Error: spec is no inline reference, or the store cannot read it.
   */
  static async readInlineSecret(spec, inline = parseInlineSecret(spec)) {
    if (!inline) throw new Error("Not an inline secret reference");
    // refused before the store is ever asked
    assertInlineAllowed(spec, inline);
    // no log here : the caller reports the error, and the store name comes from the
    // inline reference, which CodeQL cannot tell apart from the secrets next to it
    return readSecret(inline.store, inline.ref);
  }

  /**
   * A credential resolved for use by its exact name, never as a pattern : the name a record
   * stores (an LDAP directory's, an SSO provider's, a runner's, a repository's...) escaped into
   * an anchored REGEXP, so a name with a dot or a bracket finds itself and nothing else.
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<object>: the credential, as resolveCredential gives it.
   *
   * Raises:
   *   Errors.NotFoundError: no credential has that name.
   */
  static async resolveByName(name) {
    return this.resolveCredential(this.exactPattern(name));
  }

  /**
   * A credential's name as the REGEXP that finds it and nothing else : escaped and anchored, the
   * way a record that stores a name (a runner, a database of Connections > Databases) resolves it.
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   string: the pattern, ^name$ with its special characters escaped.
   */
  static exactPattern(name) {
    return "^" + String(name ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  }

  // The row a name or pattern finds (fallback when it finds none), cached with its password
  // still encrypted : decrypting and reading the secret store happen on every resolution, so a
  // rotated secret is never served from here.
  static async lookupCachedRow(nameOrRegex, fallbackName = "") {
    const cache = this.getCache(this.modelName);
    const cacheKey = `regex:${nameOrRegex}|${fallbackName || ""}`;
    let row = cache?.get(cacheKey);
    if (!row) {
      row = await lookupRow(nameOrRegex, fallbackName);
      cache?.set(cacheKey, row);
    }
    return row;
  }

  /**
   * Refuses a credential reference the scope does not allow, without reading any secret : the
   * name a pattern finds, the store of an inline secret, or the app's own database
   * (`__self__`). A reference that finds nothing is left to the resolution, which says so.
   *
   * Args:
   *   spec (string): "name[,fallback]", "__self__", "vault:<path>" or "secret:<store>:<ref>".
   *   scope (object|null): the scope (lib/resourceScope.js).
   *
   * Raises:
   *   Errors.AccessDeniedError: the scope does not allow it.
   */
  static async assertAllowed(spec, scope) {
    if (!scope || spec === undefined || spec === null || spec === "") return;
    if (spec === "__self__") return assertCredentialAllowed("__self__", scope);
    const inline = parseInlineSecret(String(spec));
    if (inline) return assertInlineAllowed(String(spec), inline, scope);
    const [name, fallback = ""] = String(spec).split(",").map((v) => v.trim());
    let row;
    try {
      row = await this.lookupCachedRow(name, fallback);
    } catch {
      return;
    }
    assertCredentialAllowed(row.name, scope);
  }

  // A form's credential map, { extravarKey: "name[,fallback]" | "__self__" } ->
  // { extravarKey: credential }. A credential that cannot be resolved is logged and left
  // out : the playbook runs without that extra var, as it did before 6.3.
  static async resolveCredentialMap(spec, selfConfig = dbConfig) {
    const credentials = {};
    for (const [key, value] of Object.entries(spec || {})) {
      if (value == "__self__") {
        // the app's own database : a credential like the others for the roles that list them
        try {
          assertCredentialAllowed("__self__");
        } catch (err) {
          logger.error(`Cannot resolve credential '${key}': ${err.message}`);
          continue;
        }
        credentials[key] = {
          host: selfConfig.host,
          user: selfConfig.user,
          port: selfConfig.port,
          password: selfConfig.password,
        };
        continue;
      }
      try {
        const [name, fallback = ""] = String(value).split(",").map((v) => v.trim());
        credentials[key] = await this.resolveCredential(name, fallback);
      } catch (err) {
        logger.error(`Cannot resolve credential '${key}': ${err.message || err}`);
      }
    }
    return credentials;
  }
}

/**
 * Refuses an inline secret (vault:<path>, secret:<store>:<ref>) the scope does not allow : its
 * store must be allowed, and when the roles limit the credentials but not the stores, the
 * reference itself must match a credential pattern - an inline secret is no way around them.
 *
 * Args:
 *   spec (string): the reference.
 *   inline (object): its store and ref (parseInlineSecret).
 *   scope (object|null): the scope, the current one by default.
 *
 * Raises:
 *   Errors.AccessDeniedError: the scope does not allow it.
 */
function assertInlineAllowed(spec, inline, scope = currentScope()) {
  if (!scope) return;
  assertSecretStoreAllowed(inline.store, scope);
  if (!scope.secretStores && scope.credentials) assertCredentialAllowed(spec, scope);
}

// an SSO credential its tenant (Entra ID) or issuer (Open ID) and its redirect URL too
const ROW_SQL = "SELECT host,port,db_name,name,user,password,secure,db_type,is_database,vault_path,secret_store,secret_ref,tenant_id,issuer,redirect_uri FROM AnsibleForms.`credentials` WHERE name REGEXP ?";

async function lookupRow(nameOrRegex, fallbackName) {
  let res = await mysql.do(ROW_SQL, nameOrRegex);
  if (!res.length && fallbackName) res = await mysql.do(ROW_SQL, fallbackName);
  if (!res.length) {
    throw new Errors.NotFoundError(`No credential found with filter ${nameOrRegex}${fallbackName ? ` or ${fallbackName}` : ""}`);
  }
  return res[0];
}

// Where the row's user and password live : the store it names, or - for a row written
// before secret stores existed - the store named `vault` at its vault_path.
function secretSource(row) {
  if (row.secret_store) return { store: row.secret_store, ref: row.secret_ref || "" };
  if (row.vault_path) return { store: VAULT_STORE_NAME, ref: row.vault_path };
  return null;
}

const isEmpty = (v) => v === undefined || v === null || v === "";

// user and password always come from the store. Host, port and database name stay those of
// the row, and are taken from the store only where the row leaves them empty - a CyberArk
// account carries its address, so the row need not repeat it.
async function overlaySecret(result, source, isDatabase) {
  let mapped;
  try {
    mapped = mapPayloadToCredential(await readSecret(source.store, source.ref));
  } catch (e) {
    logger.error(`Failed to read credential '${result.name}' from secret store '${source.store}': ${e.message}`);
    throw e;
  }
  result.user = mapped.user || result.user || "";
  result.password = mapped.password || "";
  if (isEmpty(result.host) && !isEmpty(mapped.host)) result.host = mapped.host;
  if (isEmpty(result.port) && !isEmpty(mapped.port)) result.port = mapped.port;
  if (isDatabase && isEmpty(result.db_name) && !isEmpty(mapped.db_name)) result.db_name = mapped.db_name;
}

// An inline secret carries the whole connection itself, under the keys mapPayloadToCredential
// knows (https://ansibleforms.com/secret-stores). With a db_type it is a database credential, shaped like a
// database row ; without one, user and password with the rest of the secret passed through.
// payload is the secret as readInlineSecret read it.
function shapeInlineSecret(name, payload) {
  const mapped = mapPayloadToCredential(payload);
  if (!mapped.db_type) return { ...mapped, name };
  return {
    name,
    user: mapped.user || "",
    password: mapped.password || "",
    host: mapped.host || "",
    port: mapped.port ?? null,
    db_name: mapped.db_name || "",
    db_type: mapped.db_type,
    secure: mapped.secure === true || mapped.secure === 1 || mapped.secure === "true" ? 1 : 0,
    is_database: 1,
    multipleStatements: true,
  };
}

// a playbook receives the credential as an extra var : where it came from is not its business
function stripSecretSource(result) {
  delete result.vault_path;
  delete result.secret_store;
  delete result.secret_ref;
}

export default CredentialModel;
