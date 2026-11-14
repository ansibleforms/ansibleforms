// Where notifications go (Settings > Connections > Notifications) : a channel of one type -
//   mail      an SMTP server : approval requests and job notifications by mail. Several can be
//             kept, one is active : the one the app sends its mail with. Its server, port, TLS and
//             login are an smtp credential of Connections > Credentials (the user and password
//             left empty for a relay) ; without a credential, its own server, port and TLS, and no
//             login (a relay too). Its own are also used while its credential has no server.
//   slack     an incoming webhook of a Slack channel
//   teams     a Microsoft Teams webhook (a Workflows webhook, or an incoming webhook)
//   telegram  a bot posting in a chat : its token the password of an api credential
//   webhook   any HTTP endpoint : a JSON body from a template, an optional bearer token (the
//             password of an api credential)
// A form names channels in its notifications and its approval (channels: [...]) ; how each type
// sends is lib/notifiers.js. A webhook address of Slack or Teams is a secret : stored encrypted,
// never handed back by the API (masked, as a password is).
import CrudModel from './crud.model.js';
import { SECRET_MASK } from '../lib/secretMask.js';
import Credential from './credential.model.v2.js';
import Errors from '../lib/errors.js';
import mysql from './db.model.js';
import logger from '../lib/logger.js';

// the types a channel can be, in the order the wizard offers them
export const CHANNEL_TYPES = ['mail', 'slack', 'teams', 'telegram', 'webhook'];
// the methods a webhook channel sends with
export const WEBHOOK_METHODS = ['POST', 'PUT'];
// what a secret looks like when the API hands a channel back (crud.model takes it back as
// "unchanged" on an update)
// the mask a secret is shown as, for whoever imported it from here (lib/secretMask.js)
export { SECRET_MASK };
// the body a webhook channel sends when it has no template of its own : every placeholder
export const DEFAULT_PAYLOAD = `{
  "title": "{{title}}",
  "text": "{{text}}",
  "status": "{{status}}",
  "event": "{{event}}",
  "job": { "id": "{{jobId}}", "form": "{{form}}", "user": "{{user}}" },
  "link": "{{link}}"
}`;
// the placeholders a webhook's template may use
export const PAYLOAD_PLACEHOLDERS = ['title', 'text', 'status', 'event', 'jobId', 'form', 'user', 'link'];

/**
 * A webhook's body : its template with each {{placeholder}} filled in. A placeholder that is a
 * whole JSON string ("{{text}}") becomes that value as JSON (a string, or null) ; inside a longer
 * string, its text escaped for JSON. An unknown placeholder is left as written.
 *
 * Args:
 *   template (string): the JSON template ; empty : DEFAULT_PAYLOAD.
 *   values (object): the placeholders' values.
 *
 * Returns:
 *   string: the body.
 */
export function renderPayload(template, values) {
  const text = String(template || '').trim() || DEFAULT_PAYLOAD;
  const known = (name) => PAYLOAD_PLACEHOLDERS.includes(name);
  const asJson = (v) => JSON.stringify(v === undefined || v === null ? '' : String(v));
  // first the placeholders that are a whole string, quotes included
  const whole = text.replace(/"\{\{\s*(\w+)\s*\}\}"/g, (all, name) => (known(name) ? asJson(values[name]) : all));
  // then those inside a longer string
  return whole.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, name) => (known(name) ? asJson(values[name]).slice(1, -1) : all));
}

/**
 * Whether a text is an http(s) address.
 *
 * Args:
 *   value (string): the text.
 *
 * Returns:
 *   boolean: true for an http or https url.
 */
function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

class NotificationChannel extends CrudModel {
  static modelName = 'notificationchannel';

  /**
   * Checks a credential a channel names : it exists and is of the type it needs. Empty means
   * none.
   *
   * Args:
   *   data (object): the fields being saved.
   *   key (string): credential or token_credential.
   *   type (string): the credential type it needs (smtp, api).
   *   what (string): the channel's type, for the message.
   *
   * Raises:
   *   BadRequestError: the credential does not exist, or is of another type.
   */
  static async assertCredential(data, key, type, what) {
    if (data[key] === undefined) return;
    if (data[key] === '' || data[key] === null) {
      data[key] = null;
      return;
    }
    const cred = await CrudModel.findByName('credential', data[key]);
    if (!cred) throw new Errors.BadRequestError(`No credential named '${data[key]}'`);
    if (cred.credential_type !== type) {
      throw new Errors.BadRequestError(`A ${what} channel needs an ${type} credential: '${data[key]}' is not one`);
    }
  }

  /**
   * Checks the fields of a channel being saved, by its type, and fills the ones left empty
   * with their default. Its type is set when it is made and stays.
   *
   * Args:
   *   data (object): the fields being saved.
   *   existing (object): the channel as stored, on an update ; null on a create.
   *   opts (object): { fromSeed:true } for the declarative config seed, which writes what it
   *     declares as it is.
   *
   * Raises:
   *   BadRequestError: a field is not valid, or one its type needs is missing.
   */
  static async normalise(data, existing = null, opts = {}) {
    if (existing && data.type !== undefined && data.type !== existing.type) {
      throw new Errors.BadRequestError(`A channel's type stays what it was made as: '${existing.name}' is ${existing.type}`);
    }
    const type = existing ? existing.type : data.type || 'mail';
    if (!CHANNEL_TYPES.includes(type)) {
      throw new Errors.BadRequestError(`A channel's type is one of ${CHANNEL_TYPES.join(', ')}: '${type}' is not`);
    }
    if (!existing) data.type = type;
    // the secret shown masked and sent back : unchanged (crud.model skips it)
    const merged = { ...(existing || {}), ...data };
    const missing = (key) => {
      const value = merged[key];
      // the mask sent back : there is one only when one is stored
      if (CrudModel.isSecretMask(value)) return !existing?.[key];
      return !String(value ?? '').trim();
    };
    if (data.port !== undefined && data.port !== '' && data.port !== null) {
      const port = Number(data.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Errors.BadRequestError(`A channel's port is a number from 1 to 65535: '${data.port}' is not`);
      }
      data.port = port;
    } else if (data.port === '') {
      data.port = null;
    }
    if (type === 'mail') {
      // step 1 : its credential, when it names one (none : a relay, its own server without a login)
      await this.assertCredential(data, 'credential', 'smtp', 'mail');
      // step 2 : where it sends : its credential's server, else its own
      const credentialServer = await this.credentialServer(data.credential === undefined ? merged.credential : data.credential);
      if (missing('server') && !credentialServer) {
        throw new Errors.BadRequestError('A mail channel needs its mail server: an smtp credential with its server (host), or its own server');
      }
      // step 3 : a credential with its server is where it sends : the channel's own, typed before
      // one was chosen, is emptied, never left to be moved into a credential at the next start
      // (schema.model.js moveMailServersToCredentials). The seed writes what it declares.
      if (credentialServer && !opts.fromSeed && String(merged.server ?? '').trim()) {
        Object.assign(data, { server: null, port: null, secure: 0 });
      }
    } else if (data.is_active) {
      // only mail has an active one
      data.is_active = 0;
    }
    if (type === 'slack' || type === 'teams') {
      if (missing('webhook_url')) throw new Errors.BadRequestError(`A ${type} channel needs its webhook address`);
      if (data.webhook_url !== undefined && !CrudModel.isSecretMask(data.webhook_url) && !isHttpUrl(data.webhook_url)) {
        throw new Errors.BadRequestError(`A ${type} channel's webhook address is an http(s) url`);
      }
    }
    if (type === 'telegram') {
      if (missing('token_credential')) throw new Errors.BadRequestError('A telegram channel needs the credential of its bot token');
      if (missing('chat_id')) throw new Errors.BadRequestError('A telegram channel needs its chat id');
      if (data.api_url && !isHttpUrl(data.api_url)) throw new Errors.BadRequestError("A telegram channel's Bot API address is an http(s) url");
    }
    if (type === 'telegram' || type === 'webhook') {
      await this.assertCredential(data, 'token_credential', 'api', type);
    }
    if (type === 'webhook') {
      if (missing('url')) throw new Errors.BadRequestError('A webhook channel needs its url');
      if (data.url !== undefined && !isHttpUrl(data.url)) throw new Errors.BadRequestError("A webhook channel's url is an http(s) url");
      if (data.method !== undefined && data.method !== null && data.method !== '') {
        data.method = String(data.method).toUpperCase();
        if (!WEBHOOK_METHODS.includes(data.method)) {
          throw new Errors.BadRequestError(`A webhook channel's method is one of ${WEBHOOK_METHODS.join(', ')}: '${data.method}' is not`);
        }
      }
      if (data.headers !== undefined && String(data.headers ?? '').trim()) {
        let headers;
        try {
          headers = JSON.parse(data.headers);
        } catch {
          throw new Errors.BadRequestError("A webhook channel's headers are a JSON object: they do not read as JSON");
        }
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
          throw new Errors.BadRequestError("A webhook channel's headers are a JSON object, of names and values");
        }
      }
      if (data.payload !== undefined && String(data.payload ?? '').trim()) {
        // read with every placeholder filled : the template must give JSON
        const sample = Object.fromEntries(PAYLOAD_PLACEHOLDERS.map((name) => [name, 'x']));
        try {
          JSON.parse(renderPayload(data.payload, sample));
        } catch (e) {
          throw new Errors.BadRequestError(`A webhook channel's payload is a JSON template: ${e.message}`);
        }
      }
    }
    // the defaults, written so the table and the API say what is used
    if (!existing) {
      if (data.enabled === undefined) data.enabled = 1;
      if (type === 'webhook') {
        data.method = data.method || 'POST';
        if (data.verify_tls === undefined) data.verify_tls = 1;
      }
    } else if (type === 'webhook' && data.method === '') {
      data.method = 'POST';
    }
  }

  /**
   * Makes a mail channel the only active one : the others stop being it.
   *
   * Args:
   *   id (number): the channel now active.
   */
  static async clearOtherActive(id) {
    await mysql.do("UPDATE AnsibleForms.`notification_channels` SET is_active = 0 WHERE id <> ? AND type = 'mail'", [id]);
    this.changed(this.modelName);
  }

  // opts carries { fromSeed:true } for the declarative config seed only
  static async create(data, opts = {}) {
    await this.normalise(data, null, opts);
    // the first mail channel is the active one : mail needs one, nobody should have to tick it
    if (data.type === 'mail' && !data.is_active && !(await this.findActive({ enabledOnly: false }))) data.is_active = 1;
    const id = await super.create(this.modelName, data, opts);
    if (data.is_active && id) await this.clearOtherActive(id);
    return id;
  }

  static async update(data, id, opts = {}) {
    const existing = await this.findById(id);
    if (!existing) throw new Errors.NotFoundError(`No notification channel with id ${id}`);
    await this.normalise(data, existing, opts);
    const res = await super.update(this.modelName, data, id, opts);
    if (data.is_active && existing.type === 'mail') await this.clearOtherActive(id);
    return res;
  }

  static async delete(id, opts = {}) {
    return super.delete(this.modelName, id, opts);
  }

  static async findAll() {
    return super.findAll(this.modelName);
  }

  static async findById(id) {
    return super.findById(this.modelName, id);
  }

  static async findByName(name) {
    return super.findByName(this.modelName, name);
  }

  /**
   * The active mail channel : the one the app sends its mail with. Turned off, there is none.
   *
   * Args:
   *   options (object): { enabledOnly : false also counts an active one turned off }.
   *
   * Returns:
   *   Promise<object|null>: the channel, or null.
   */
  static async findActive({ enabledOnly = true } = {}) {
    const all = await this.findAll();
    return (all || []).find((s) => s.type === 'mail' && s.is_active && (!enabledOnly || s.enabled)) || null;
  }

  /**
   * A channel as the API hands it out : its secret masked.
   *
   * Args:
   *   channel (object): the channel, as stored (decrypted).
   *
   * Returns:
   *   object: a copy, the webhook address masked.
   */
  static masked(channel) {
    if (!channel) return channel;
    return { ...channel, webhook_url: channel.webhook_url ? SECRET_MASK : '' };
  }

  /**
   * The server an smtp credential names : its host, port and TLS. None without a credential, or
   * for one without a host (one from before credentials held the server).
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<object|null>: { server, port, secure }, or null.
   */
  static async credentialServer(name) {
    if (!name) return null;
    const cred = await CrudModel.findByName('credential', name);
    if (!cred?.host || !String(cred.host).trim()) return null;
    return { server: String(cred.host).trim(), port: cred.port || null, secure: cred.secure ? 1 : 0 };
  }

  /**
   * Mail channels as the API hands them out : the server they send through, their credential's
   * (server, port and secure as before, so a reader of the API sees where the mail goes).
   *
   * Args:
   *   channels (object[]): the channels, as stored.
   *
   * Returns:
   *   Promise<object[]>: copies, a mail channel's server, port and secure those it uses.
   */
  static async withServer(channels) {
    return Promise.all(
      (channels || []).map(async (c) => {
        if (!c || c.type !== 'mail') return c;
        const server = await this.credentialServer(c.credential).catch(() => null);
        return server ? { ...c, ...server } : c;
      }),
    );
  }

  /**
   * A mail channel as the mail sender takes it (Settings.maildo) : the server, port and TLS of
   * its credential (its own, from before, while the credential has none), and the credential's
   * user and password (read from a secret store when the credential names one ; none for a
   * relay).
   *
   * Args:
   *   server (object): the mail channel.
   *
   * Returns:
   *   Promise<object>: mail_server, mail_port, mail_secure, mail_username, mail_password and
   *     mail_from.
   *
   * Raises:
   *   Error: the credential it names does not exist.
   */
  static async toMailConfig(server) {
    const own = (await this.credentialServer(server.credential)) || server;
    const config = {
      mail_server: own.server,
      mail_port: own.port,
      mail_secure: own.secure ? 1 : 0,
      mail_username: '',
      mail_password: '',
      mail_from: server.from_address,
    };
    if (server.credential) {
      const cred = await this.resolveCredential(server.credential);
      if (!cred) {
        logger.error(`Mail channel '${server.name}' uses the credential '${server.credential}', which is not found`);
        throw new Error(`Mail channel '${server.name}' uses the credential '${server.credential}', which is not found`);
      }
      config.mail_username = cred.user;
      config.mail_password = cred.password;
    }
    return config;
  }

  /**
   * A credential by its exact name, resolved for use (its secret store read) : user, password.
   *
   * Args:
   *   name (string): the credential's name.
   *
   * Returns:
   *   Promise<object|null>: { user, password }, or null when there is none.
   */
  static async resolveCredential(name) {
    return Credential.resolveByName(name);
  }
}

export default NotificationChannel;
