import CrudModel from './crud.model.js';
import Errors from '../lib/errors.js';
import logger from '../lib/logger.js';
import mysql from './db.model.js';
import crypto from '../lib/crypto.js';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readSecret, mapPayloadToCredential, parseInlineSecret, VAULT_STORE_NAME } from '../secrets/providers/index.js';
import dbConfig from '../../config/db.config.js';
import { stripTrailingSlashes } from '../lib/url.js';
import { isMasked } from '../lib/secretMask.js';
import { certificateProblem } from '../lib/microsoftMail.js';
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
  // one for SSH to a server, the login a workflow node's playbook connects with (a password, a
  // private key in client_key with its passphrase in key_passphrase, or both)
  // ldap : an LDAP directory's bind account (its user the bind DN) ; entraid and oidc : an SSO
  // provider's client (its user the client id, its password the client secret ; an entraid one its
  // tenant too, an oidc one its issuer), an entraid one also how mail is sent through Microsoft 365
  // (its secret, or a certificate and its key : client_cert, client_key) ; smtp : a mail server (its host, port and TLS) and its
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
   * host (a git one, or a user and password or an api one left without its optional host and port)
   * sends it empty, and MySQL refused '' for the int column ("Incorrect integer value: '' for
   * column 'port'") - saving a type change failed. Any type may store a host and a port : a user
   * and password or an api one's are only handed to the playbook and the expressions with it.
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
    if (data.credential_type === 'entraid') this.checkEntraCertificate(data, creating);
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

  /**
   * An Entra ID credential's certificate and private key, when it signs in with a certificate
   * instead of its secret (mail through Microsoft 365, lib/microsoftMail.js) : the certificate a
   * PEM certificate, the key a PEM private key without a passphrase, and a new certificate comes
   * with its key. Each is also held to the rules the sender holds it to (microsoftMail.js
   * certificateProblem) : an RSA key, and a certificate inside its validity dates, so one that
   * cannot send is refused here instead of every mail failing. The messages never hold the key.
   *
   * Args:
   *   data (object): the record written (client_cert, client_key).
   *   creating (boolean): a create (a certificate then needs its key in the same write).
   *   now (number): the time, in milliseconds (Date.now()).
   *
   * Raises:
   *   BadRequestError: the certificate or the key does not read, the key is not an RSA key, a new
   *     certificate comes without its key, the two do not go together, or the certificate has
   *     expired or is not valid yet.
   */
  static checkEntraCertificate(data, creating = false, now = Date.now()) {
    const text = (v) => String(v ?? '').trim();
    // step 1 : what is written ; the key left out (or masked, removed by update) keeps the stored one
    const certPem = text(data.client_cert);
    const keyPem = isMasked(data.client_key) ? '' : text(data.client_key);
    if (!certPem && !keyPem) return;
    // step 2 : each reads
    let cert = null;
    let key = null;
    if (certPem) {
      try {
        cert = new X509Certificate(certPem);
      } catch {
        throw new Errors.BadRequestError('The certificate of a Microsoft Entra ID credential is a PEM certificate (-----BEGIN CERTIFICATE-----)');
      }
    }
    if (keyPem) {
      try {
        key = createPrivateKey(keyPem);
      } catch {
        throw new Errors.BadRequestError('The private key of a Microsoft Entra ID credential is a PEM private key without a passphrase (-----BEGIN PRIVATE KEY-----)');
      }
    }
    // step 3 : a key the sender can sign with (an RSA one)
    const keyProblem = certificateProblem(null, key, now);
    if (keyProblem) {
      throw new Errors.BadRequestError(`The private key of a Microsoft Entra ID credential ${keyProblem.reason}`);
    }
    // step 4 : a new certificate comes with its key, and they go together
    if (cert && !key && creating) {
      throw new Errors.BadRequestError("A Microsoft Entra ID credential that signs in with a certificate needs the certificate's private key too");
    }
    if (cert && key && !cert.checkPrivateKey(key)) {
      throw new Errors.BadRequestError('The private key does not belong to the certificate of this Microsoft Entra ID credential');
    }
    // step 5 : a certificate inside its validity dates
    const certProblem = certificateProblem(cert, null, now);
    if (certProblem) {
      throw new Errors.BadRequestError(`The certificate of a Microsoft Entra ID credential ${certProblem.reason}`);
    }
  }

  /**
   * An Entra ID credential's certificate and private key on an update that changes only one of
   * them : the half sent is checked against the stored other half (checkEntraCertificate only
   * sees what a write sends, so a renewed certificate saved over a stored key of the old one was
   * taken, and every mail failed at send time). Both halves sent without the type are checked
   * together when the stored type is entraid (requireTypeFields only checks them when the type is
   * sent). A key sent empty or masked keeps the stored one
   * (update removed it from the record), a half sent as null is removed and leaves nothing to
   * check. Another type is left alone : a CyberArk or an SSH credential keeps its client key in
   * the same column. The messages never hold the key.
   *
   * Args:
   *   data (object): the record written, the masked or empty key already removed.
   *   id (number|string): the credential's id.
   *   current (object|null): the stored credential when the caller already read it (findById,
   *     its key decrypted), or null to read it here.
   *
   * Returns:
   *   Promise<void>: resolves when the pair goes together, or there is no pair to check.
   *
   * Raises:
   *   BadRequestError: the half sent does not read or cannot sign in (checkEntraCertificate), a
   *     new certificate meets no stored key, or the half sent does not go with the stored other
   *     half.
   */
  static async checkEntraPairOnUpdate(data, id, current = null) {
    const text = (v) => String(v ?? '').trim();
    // step 1 : only one half written with a value, the other one left out (kept as stored) ; or
    // both written without the type, which requireTypeFields does not see as an Entra ID one
    const certOnly = text(data.client_cert) !== '' && data.client_key === undefined;
    const keyOnly = text(data.client_key) !== '' && data.client_cert === undefined;
    const bothUntyped = !data.credential_type && (text(data.client_cert) !== '' || text(data.client_key) !== '');
    if (!certOnly && !keyOnly && !bothUntyped) return;
    // step 2 : an Entra ID credential's only, the type sent or the stored one
    const stored = current || (await this.findById(id));
    const type = data.credential_type || stored?.credential_type;
    if (type !== 'entraid') return;
    // step 2b : both halves sent, untyped : checked together as a create checks them
    if (!certOnly && !keyOnly) {
      this.checkEntraCertificate(data, false);
      return;
    }
    // step 3 : the half sent reads (the same messages as a create)
    this.checkEntraCertificate({ client_cert: certOnly ? data.client_cert : '', client_key: keyOnly ? data.client_key : '' }, false);
    // step 4 : the stored other half, decrypted by findById ; one that does not read counts as none
    const readOrNull = (read) => {
      try {
        return read();
      } catch {
        return null;
      }
    };
    const cert = readOrNull(() => new X509Certificate(text(certOnly ? data.client_cert : stored?.client_cert)));
    const key = readOrNull(() => createPrivateKey(text(keyOnly ? data.client_key : stored?.client_key)));
    // step 5 : a new certificate needs a key to sign with ; a new key without a stored
    // certificate waits for one (the certificate's write checks the pair)
    if (certOnly && !key) {
      throw new Errors.BadRequestError("A Microsoft Entra ID credential that signs in with a certificate needs the certificate's private key too: upload the matching private key with the certificate");
    }
    if (!cert || !key) return;
    // step 6 : the two go together
    if (!cert.checkPrivateKey(key)) {
      throw new Errors.BadRequestError(
        certOnly
          ? 'The new certificate does not belong to the stored private key of this Microsoft Entra ID credential: upload the matching private key with the certificate'
          : 'The new private key does not belong to the stored certificate of this Microsoft Entra ID credential: upload the matching certificate with the private key',
      );
    }
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

  // the first and last lines of an SSH credential's private key : a PEM one (-----BEGIN RSA PRIVATE
  // KEY-----, -----BEGIN EC PRIVATE KEY-----, -----BEGIN PRIVATE KEY-----...) or an OpenSSH one
  // (-----BEGIN OPENSSH PRIVATE KEY-----) ; the key type a few words at most
  static PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
  static PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;

  /**
   * Whether a text is a private key : its BEGIN line, some content, then its END line. The two
   * lines are looked for one after the other : one pattern running from the first to the last
   * over the whole key took quadratic time on a text made to look like one.
   *
   * Args:
   *   text (string): the key as typed.
   *
   * Returns:
   *   boolean: true when it reads as a PEM or OpenSSH private key.
   */
  static isPrivateKey(text) {
    // Step 1 : its first line
    const begin = this.PRIVATE_KEY_BEGIN.exec(text);
    if (!begin) return false;
    // Step 2 : its last line after it, with something between
    const rest = text.slice(begin.index + begin[0].length);
    const end = this.PRIVATE_KEY_END.exec(rest);
    return !!end && rest.slice(0, end.index).trim() !== '';
  }

  /**
   * Checks an SSH credential's private key and keeps its passphrase to it : the key
   * (client_key, stored encrypted) must read as a PEM or an OpenSSH private key, and a type
   * other than ssh keeps no passphrase (key_passphrase, stored encrypted). The key is stored
   * as it was typed : the RTE writes it out with the line ends ssh wants (rte/sshKey.js), so
   * the config seed still finds what it declared stored unchanged.
   *
   * Args:
   *   data (object): the record written (changed in place).
   *   creating (boolean): a create (the type and its fields are all there).
   *
   * Returns:
   *   object: the record.
   *
   * Raises:
   *   BadRequestError: an SSH credential whose private key is not one.
   */
  static checkSshKey(data, creating = false) {
    // step 1 : a passphrase belongs to an ssh credential's key only
    if (data.credential_type !== undefined && data.credential_type !== null && data.credential_type !== '' && data.credential_type !== 'ssh') {
      if (creating || data.key_passphrase !== undefined) data.key_passphrase = null;
      return data;
    }
    // step 2 : a key typed (not the mask, not emptied) must be a private key
    const key = data.client_key;
    if (data.credential_type === 'ssh' && typeof key === 'string' && key.trim() !== '' && !isMasked(key)) {
      if (!this.isPrivateKey(key)) {
        throw new Errors.BadRequestError("An SSH credential's private key is a PEM or OpenSSH private key, from -----BEGIN ... PRIVATE KEY----- to -----END ... PRIVATE KEY-----");
      }
    }
    return data;
  }

  /**
   * Normalises and checks a new credential exactly as create() writes it : the RTE's pin, an
   * empty passphrase or SSH key as none, the SSH key, the port, the deprecated vault_path, the type
   * and the fields the type needs. Nothing is written.
   *
   * Args:
   *   data (object): the record written (changed in place).
   *   opts (object): { fromSeed:true } for the declarative config seed, { fromRte:true } for the
   *     RTE hub.
   *
   * Returns:
   *   object: the record, as create() hands it to the database.
   *
   * Raises:
   *   BadRequestError: a field the credential cannot be saved with (its type, its port, its SSH
   *     key, a field its type needs).
   */
  static prepareCreate(data, opts = {}) {
    this.guardRtePin(data, null, opts);
    // an empty passphrase is none, and so is an ssh one's empty private key (a CyberArk or an
    // Entra ID one's client key is written as it was sent)
    if (data.key_passphrase === '') data.key_passphrase = null;
    if (data.credential_type === 'ssh' && data.client_key === '') data.client_key = null;
    this.checkSshKey(data, true);
    return this.requireTypeFields(this.mirrorType(this.mirrorVaultPath(this.normalizePort(data)), true), true, opts);
  }

  /**
   * Normalises and checks a change of a credential exactly as update() writes it : the masked
   * secrets sent back left as they are, the SSH key, the type it keeps, the RTE's pin, the port,
   * the deprecated vault_path and the fields the type needs. Nothing is written.
   *
   * Args:
   *   data (object): the fields written (changed in place).
   *   id (number|string): the credential's id.
   *   opts (object): { fromSeed:true } for the declarative config seed, { fromRte:true } for the
   *     RTE hub.
   *
   * Returns:
   *   Promise<object>: the fields, as update() hands them to the database.
   *
   * Raises:
   *   BadRequestError: a field the credential cannot be saved with, or another type than the one
   *     it was made as.
   *   NotFoundError: no credential with that id (read for its type or its ca_bundle).
   */
  static async prepareUpdate(data, id, opts = {}) {
    // the api shows the client key (a CyberArk or an Entra ID one's, an SSH one's private key) and
    // an SSH key's
    // passphrase masked ; the mask sent back means "unchanged", and an empty one too (the
    // dialog leaves a secret empty to keep it). null removes it.
    for (const key of ['client_key', 'key_passphrase']) {
      if (isMasked(data[key]) || data[key] === '') delete data[key];
    }
    this.checkSshKey(data, false);
    // its type stays what it was made as (what uses it expects it : an SSO provider an entraid
    // one, a mail channel an smtp one) ; the config seed may change it
    let current = null;
    if (!opts.fromSeed && data.credential_type !== undefined && data.credential_type !== null && data.credential_type !== '') {
      current = await this.findById(id);
      if (current?.credential_type && data.credential_type !== current.credential_type) {
        throw new Errors.BadRequestError(`A credential keeps the type it was made as: '${current.name}' is ${current.credential_type}. Make a new credential for another type`);
      }
    }
    // an Entra ID credential's new certificate (or key) goes with its stored key (or certificate)
    await this.checkEntraPairOnUpdate(data, id, current);
    // the RTE's pin : the hub's to write ; a changed ca_bundle is the writer's from now on
    const stored = !opts.fromRte && data.ca_bundle !== undefined ? await this.findById(id) : null;
    this.guardRtePin(data, stored, opts);
    return this.requireTypeFields(this.mirrorType(this.mirrorVaultPath(this.normalizePort(data))), false, opts);
  }

  /**
   * Checks, without writing anything, that a create or an update of a credential will pass every
   * check the save itself runs : the model's (prepareCreate, prepareUpdate), the table's (its
   * required fields, the record existing and not managed by the config seed) and its unique name.
   * Run on a copy : the record sent is left as it is. A caller that must do something outside the
   * database before the save (the controller writing a typed password to a secret store) calls it
   * first, so a save that would be refused changes nothing anywhere.
   *
   * Args:
   *   data (object): the record or the fields written (not changed).
   *   id (number|string|null): the credential's id on an update, null on a create.
   *   opts (object): the options create() or update() is called with.
   *
   * Returns:
   *   Promise<void>: settles when the save would pass its checks.
   *
   * Raises:
   *   BadRequestError: a field the credential cannot be saved with, a required one missing.
   *   NotFoundError: no credential with that id.
   *   AccessDeniedError: the credential is managed by the config seed.
   *   ConflictError: another credential has that name already.
   */
  static async assertSavable(data, id = null, opts = {}) {
    const creating = id === null || id === undefined;
    // step 1 : the model's normalising and checks, on a copy, as create() or update() runs them
    const copy = { ...(data || {}) };
    this.stripManaged(copy, opts);
    if (creating) {
      this.prepareCreate(copy, opts);
      this.assertRequired(this.modelName, copy);
    } else {
      // the record first : a missing one is a 404, a seeded one read only, as update() answers
      await this.checkExist(this.modelName, id);
      if (!opts.fromSeed) await this.assertNotManaged(this.modelName, id);
      await this.prepareUpdate(copy, id, opts);
    }
    this.assertValidCronFields(this.modelName, copy);
    // step 2 : its name, unique in the table (the database refuses a second one on the write)
    if (copy.name === undefined || copy.name === null) return;
    const table = this.getConfig(this.modelName).table;
    const rows = await mysql.do(`SELECT id FROM ${table} WHERE name = ?`, [copy.name]);
    if ((rows || []).some((r) => creating || String(r.id) !== String(id))) {
      throw new Errors.ConflictError(`A credential named '${copy.name}' exists already`);
    }
  }

  // opts carries { fromSeed:true } for the declarative config seed only
  static async create(data, opts = {}) {
    return super.create(this.modelName, this.prepareCreate(data, opts), opts);
  }

  static async update(data, id, opts = {}) {
    return super.update(this.modelName, await this.prepareUpdate(data, id, opts), id, opts);
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
    // an SSH one's private key and its passphrase, decrypted ; the type and the stored columns
    // never reach a playbook
    overlaySshKey(result);
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
// and its type, its client key and the key's passphrase : an SSH one's private key
// (overlaySshKey), never a CyberArk one's client key
const ROW_SQL = "SELECT host,port,db_name,name,user,password,secure,db_type,is_database,vault_path,secret_store,secret_ref,tenant_id,issuer,redirect_uri,credential_type,client_key,key_passphrase FROM AnsibleForms.`credentials` WHERE name REGEXP ?";

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

/**
 * An SSH credential's private key and its passphrase as a resolved credential carries them :
 * private_key and private_key_passphrase, decrypted, when it has a key. The columns they are
 * stored in (client_key, key_passphrase) and the type go : a CyberArk credential's client key
 * never leaves the app this way, and a credential of any other type is resolved as before.
 * Both names are secret keys to the output mask (lib/outputMask.js), so a playbook handed the
 * credential in its credentials map never shows them in its output.
 *
 * Args:
 *   result (object): the resolved credential, as lookupRow read it (changed in place).
 *
 * Returns:
 *   object: the credential.
 */
function overlaySshKey(result) {
  const isSsh = result.credential_type === "ssh";
  const key = result.client_key;
  const passphrase = result.key_passphrase;
  delete result.credential_type;
  delete result.client_key;
  delete result.key_passphrase;
  if (!isSsh || !key) return result;
  try {
    result.private_key = crypto.decrypt(key);
    const phrase = passphrase ? crypto.decrypt(passphrase) : "";
    if (phrase) result.private_key_passphrase = phrase;
  } catch {
    // never the key nor the passphrase in the log
    logger.error("Failed to decrypt the private key.  Did the secretkey change ?");
    delete result.private_key;
    delete result.private_key_passphrase;
  }
  return result;
}

// a playbook receives the credential as an extra var : where it came from is not its business
function stripSecretSource(result) {
  delete result.vault_path;
  delete result.secret_store;
  delete result.secret_ref;
}

export default CredentialModel;
