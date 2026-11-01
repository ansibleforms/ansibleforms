import CredentialModel from '../../models/credential.model.v2.js';
import RestResult from '../../models/restResult.model.v2.js';
import Errors from '../../lib/errors.js';
import i18n from '../../lib/i18n.js';
import { publicError } from './publicError.js';
import Query from '../../models/query.model.js';
import auth_entraid from '../../auth/auth_entraid.js';
import auth_oidc from '../../auth/auth_oidc.js';
import logger from '../../lib/logger.js';
import Form from '../../models/form.model.js';
import { formCredentials } from '../../lib/formLinks.js';
import { workflowCredentials } from '../../models/workflowRun.js';
import { isAdminRequest } from '../../lib/adminGrants.js';
import { SECRET_MASK, masked, isMasked } from '../../lib/secretMask.js';

// the credential types an SSO provider signs in with : a change to one of them is a change to the
// sign-in, which reads its client, tenant or issuer and redirect URL when it starts
const SSO_TYPES = ['entraid', 'oidc'];

/**
 * Starts the SSO sign-ins again, with their credentials as they are now. A failure is logged : the
 * credential was saved, its provider says why it cannot sign in.
 *
 * Returns:
 *   Promise<void>: settles once both have started.
 */
async function reloadSso() {
  try {
    await auth_entraid.initialize();
    await auth_oidc.initialize();
  } catch (err) {
    logger.error(`Could not start the SSO sign-in again after a credential changed: ${err?.message || err}`);
  }
}

/**
 * Refuses a change of a credential a connection takes its address from, or a runner signs in with,
 * to anyone but an admin : the same rule as a change of the runner itself
 * (controllers/v2/runner.controller.js assertAdmin). Since 7.3 a runner, a secret store and the
 * other connections take their URL and token from their credential : a user with only connections
 * access who could point one at another server would receive every secret sent through it,
 * although the runner itself is closed to them.
 *
 * Args:
 *   req (object): the request.
 *   records (object[]): the credential as it is and as it is written ({ name, credential_type }),
 *     any of them missing.
 *
 * Returns:
 *   Promise<void>: settles when the change is allowed.
 *
 * Raises:
 *   Errors.AccessDeniedError: the user is not an admin and the credential carries an address, a
 *     sign-in reads it (ldap, entraid, oidc) or a runner names it.
 */
async function assertMayChange(req, ...records) {
  if (isAdminRequest(req)) return;
  const present = records.filter(Boolean);
  // a type a sign-in reads (an LDAP bind account, an SSO client) : who changes it chooses who
  // signs in, and where the sign-in sends its secret
  if (present.some((r) => CredentialModel.SIGNIN_TYPES.includes(r.credential_type))) {
    throw new Errors.AccessDeniedError(i18n.t(req, 'resources.credentialSignInAdminOnly'));
  }
  // a type that carries the address of the one server it logs in to (a runner's, a secret store's)
  let guarded = present.some((r) => CredentialModel.URL_TYPES.includes(r.credential_type));
  // or one a runner names, whatever its type (a deprecated api or userpass one)
  for (const r of present) {
    if (guarded) break;
    if (r.name && (await CredentialModel.runnersUsing(r.name)).length) guarded = true;
  }
  if (guarded) throw new Errors.AccessDeniedError(i18n.t(req, 'resources.credentialAdminOnly'));
}

// where a credential reads its password from : a secret store, and the place in it (vault_path the
// deprecated one, the store named `vault`)
const SECRET_REF_FIELDS = ['secret_store', 'secret_ref', 'vault_path'];

/**
 * Refuses to a user who is not an admin a write that chooses which secret a credential reads. A
 * credential naming a secret store and a secret_ref (or a vault_path) is given that secret when it
 * is used : a user with only connections access who could point one at any path of any store, and
 * then name it in a webhook or a repository of theirs, would receive whatever the store keeps
 * there (another team's passwords, a runner's token). Setting or changing secret_store, secret_ref
 * or vault_path, on any credential, is therefore an admin's. Sent back as they are, or all three
 * emptied (the credential then reads no secret at all), is left to them.
 *
 * Args:
 *   req (object): the request.
 *   before (object|null): the credential as it is, null on a create.
 *
 * Returns:
 *   void
 *
 * Raises:
 *   Errors.AccessDeniedError: the user is not an admin and the write sets or changes where the
 *     credential reads its secret from.
 */
function assertSecretRefUnchanged(req, before) {
  if (isAdminRequest(req) || !req.body) return;
  const body = req.body;
  // text compared trimmed, so the dialog sending the same value back is no change
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const changed = SECRET_REF_FIELDS.some((f) => body[f] !== undefined && text(body[f]) !== text(before?.[f]));
  if (!changed) return;
  // what it reads from once written : the field sent, else the one it has
  const after = (f) => text(body[f] !== undefined ? body[f] : before?.[f]);
  // every reference dropped : it reads no secret, nothing to receive
  if (SECRET_REF_FIELDS.every((f) => after(f) === '')) return;
  throw new Errors.AccessDeniedError(i18n.t(req, 'resources.credentialSecretRefAdminOnly'));
}

/**
 * Refuses to delete or rename a credential records still name (an LDAP directory, an SSO provider,
 * a runner, a mail channel...) : they would point at nothing, and stop working without a word.
 *
 * Args:
 *   req (object): the request.
 *   name (string): the credential's name as it is.
 *
 * Returns:
 *   Promise<void>: settles when nothing names it.
 *
 * Raises:
 *   Errors.ConflictError: records name it (its Used by tab lists them).
 */
async function assertUnused(req, name) {
  const count = await CredentialModel.usageOf(name);
  if (count) throw new Errors.ConflictError(i18n.t(req, 'resources.credentialInUse', { name, count }));
}

/**
 * Keeps a stored secret from following a credential to another target. A user who is not an admin
 * and moves a credential to another server, port, issuer, tenant or address without typing its
 * password again would otherwise send the stored password (or the secret store's) to a server of
 * their choosing : the write clears the stored password, and the secret store reference unless it
 * names another one. An admin's write is left as it is.
 *
 * Args:
 *   req (object): the request (its body is changed in place).
 *   before (object|null): the credential as it is.
 *
 * Returns:
 *   void
 */
function dropSecretOnRetarget(req, before) {
  if (isAdminRequest(req) || !before || !req.body) return;
  const body = req.body;
  if (!CredentialModel.targetChanged(before, body)) return;
  // a password typed again is the user's own choice to send there ; the mask or nothing is not
  const typed = typeof body.password === 'string' && body.password !== '' && !isMasked(body.password);
  if (!typed) body.password = '';
  // a secret store reference sent back as it is (or not sent) follows the same rule
  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const sameStore = text(body.secret_store ?? before.secret_store) === text(before.secret_store)
    && text(body.secret_ref ?? before.secret_ref) === text(before.secret_ref);
  if ((before.secret_store || before.vault_path) && sameStore) {
    body.secret_store = null;
    body.secret_ref = null;
    body.vault_path = null;
  }
}

/**
 * Tests a database connection : its engine's least query on the credential (Query.testConnection),
 * a credential of type database's own Test connection and a database's of Connections > Databases
 * (controllers/v2/database.controller.js).
 *
 * Args:
 *   req (object): the request (its language for the answer).
 *   credential (string): the credential's name, found by that exact name.
 *   dbType (string): its database type.
 *
 * Returns:
 *   Promise<void>: settles once it answered.
 *
 * Raises:
 *   Errors.BadRequestError: the credential has no database type.
 *   Error: the connection's or the query's error.
 */
export async function testDatabase(req, credential, dbType) {
  try {
    await Query.testConnection(CredentialModel.exactPattern(credential), dbType);
  } catch (err) {
    if (err?.code === 'NO_DB_TYPE') throw new Errors.BadRequestError(i18n.t(req, 'resources.dbTypeNotSet'));
    throw err;
  }
}

const credentialController = {
  async find(req, res) {
    try {
      if (req.query.name) {
        const credential = await CredentialModel.findByName(req.query.name);
        // Mask password before returning to API
        if (credential && credential.password) {
          credential.password = SECRET_MASK;
        }
        if (credential && credential.client_key) credential.client_key = SECRET_MASK;
        res.json(RestResult.single(credential));
      } else {
        // how many records use each (used_by_count), as its Used by tab lists them ; a count that
        // cannot be read leaves the list as it is
        const usage = await CredentialModel.usageCounts().catch(() => new Map());
        // and the forms that name each (a form counts once per credential, wherever it names it)
        try {
          const config = await Form.load(undefined, undefined, true);
          for (const form of formCredentials(config.forms)) {
            for (const name of new Set(form.credentials.map((c) => c.name))) usage.set(name, (usage.get(name) || 0) + 1);
          }
        } catch (err) {
          logger.debug(`The forms are left out of the credentials' Used by count: ${err?.message || err}`);
        }
        // and the designer's workflows whose nodes name each (a workflow counts once per credential)
        try {
          for (const wf of await workflowCredentials()) {
            for (const name of new Set(wf.credentials.map((c) => c.name))) usage.set(name, (usage.get(name) || 0) + 1);
          }
        } catch (err) {
          logger.debug(`The workflows are left out of the credentials' Used by count: ${err?.message || err}`);
        }
        const credentials = (await CredentialModel.findAll()).map((c) => ({
          ...c,
          // Mask passwords before returning to API
          password: masked(c.password),
          client_key: masked(c.client_key),
          used_by_count: usage.get(c.name) || 0,
        }));
        res.json(RestResult.list(credentials));
      }
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async create(req, res) {
    try {
      await assertMayChange(req, req.body);
      // the secret it reads from a secret store : an admin's to choose
      assertSecretRefUnchanged(req, null);
      const credential = await CredentialModel.create(req.body);
      res.json(RestResult.single({ message: i18n.t(req, 'success.created', { resource: 'Credential' }), id: credential }));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async findById(req, res) {
    try {
      const credential = await CredentialModel.findById(req.params.id);
      // Mask password before returning to API
      credential.password = SECRET_MASK;
      if (credential.client_key) credential.client_key = SECRET_MASK;
      res.json(RestResult.single(credential));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async update(req, res) {
    try {
      const before = await CredentialModel.findById(req.params.id).catch(() => null);
      await assertMayChange(req, before, req.body);
      // the secret it reads from a secret store : an admin's to choose or change (checked on the
      // write as sent, before dropSecretOnRetarget empties the reference itself)
      assertSecretRefUnchanged(req, before);
      // moved elsewhere without its password typed again : the stored one stays behind
      dropSecretOnRetarget(req, before);
      // a new name leaves what names the old one pointing at nothing
      if (before && req.body?.name !== undefined && req.body.name !== before.name) await assertUnused(req, before.name);
      await CredentialModel.update(req.body, req.params.id);
      if ([before?.credential_type, req.body?.credential_type].some((t) => SSO_TYPES.includes(t))) await reloadSso();
      res.json(RestResult.single({ message: i18n.t(req, 'success.updated', { resource: 'Credential' }) }));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async delete(req, res) {
    try {
      const before = await CredentialModel.findById(req.params.id).catch(() => null);
      await assertMayChange(req, before);
      if (before) await assertUnused(req, before.name);
      await CredentialModel.delete(req.params.id);
      if (SSO_TYPES.includes(before?.credential_type)) await reloadSso();
      res.json(RestResult.single({ message: i18n.t(req, 'success.deleted', { resource: 'Credential' }) }));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  },

  async testDb(req, res) {
    try {
      const credential = await CredentialModel.findById(req.params.id);
      await testDatabase(req, credential.name, credential.db_type);
      res.json(RestResult.single({ message: i18n.t(req, 'success.connectionOk', { resource: 'Database' }) }));
    } catch (err) {
      Errors.ReturnError(res, publicError(req, err));
    }
  }
};

export default credentialController;
