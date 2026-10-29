
import CrudModel from './crud.model.js';
import Errors from '../lib/errors.js';
import mysql from './db.model.js';
import logger from '../lib/logger.js';
import { isSingleTenant } from '../auth/auth_entraid.js';

class OAuth2 extends CrudModel {
    static modelName = 'oauth2';

    /**
     * Unset enable on the other providers of the same type when this one is enabled : the enabled
     * one of a type is the one its login button signs in with.
     *
     * Same trap as Awx.preProcess : this WRITES, and it ran before the required-field
     * check and before the managed guard, so a POST with no `name` answered 400 having
     * already switched off a seed-declared SSO provider. The blanket update now spares
     * managed rows, and a caller trying to displace one is refused instead.
     *
     * An update names only the fields it changes, so the type and the in-use state are the
     * resulting row's : the request's, else the stored ones. Reading only the request bound an
     * absent provider as NULL, which matched no row, so the seed guard never fired and two
     * providers of one type stayed in use (sign-in takes the lowest id).
     *
     * Args:
     *   data (object): The fields to write, enable normalised to 1 or 0 here.
     *   _action (string): 'create' or 'update'.
     *   opts (object): { fromSeed: true } for the declarative config seed only.
     *   current (object): The stored row on an update ({ provider, enable }), empty on a create.
     *
     * Returns:
     *   Promise<object>: The data to write.
     *
     * Raises:
     *   AccessDeniedError: When the type's provider in use is managed by the config seed.
     */
    static async preProcess(data, _action, opts = {}, current = {}) {
        // Step 1 : enable is 1 or 0, like auto_login ('0' is a string, and truthy)
        if (data.enable !== undefined && data.enable !== null) {
            data.enable = data.enable && data.enable !== '0' ? 1 : 0;
        }
        // Step 2 : the resulting row's type and in-use state
        const provider = data.provider ?? current.provider;
        const enabled = data.enable ?? current.enable;
        const typeChanged = data.provider !== undefined && current.provider !== undefined && data.provider !== current.provider;
        // Step 3 : a row put in use, or an in-use row moved to another type, is the only one of its type
        if (enabled && (data.enable || typeChanged)) {
            if (!opts.fromSeed) {
                const held = await mysql.do('SELECT name FROM AnsibleForms.`oauth2_providers` WHERE enable = 1 AND managed = 1 AND provider = ?', [provider]);
                if (held.length) {
                    throw new Errors.AccessDeniedError(`The enabled '${provider}' provider is managed by the config seed ('${held[0].name}') and cannot be displaced here`);
                }
            }
            logger.info('Unsetting enable on all other OAuth2 records');
            // the seed clears every row of this provider type ; an API caller only the
            // unmanaged ones (see the matching note in runner.model.js)
            await mysql.do('UPDATE AnsibleForms.`oauth2_providers` SET enable = 0 WHERE provider = ?'
              + (opts.fromSeed ? '' : ' AND managed = 0'), [provider]);
        }
        // Skip the login page : one provider at most sends users straight to it, the others stop
        if (data.auto_login && data.auto_login !== '0') {
            data.auto_login = 1;
            await mysql.do('UPDATE AnsibleForms.`oauth2_providers` SET auto_login = 0 WHERE auto_login = 1'
              + (opts.fromSeed ? '' : ' AND COALESCE(managed, 0) = 0'));
        }
        return data;
    }
    // opts carries { fromSeed:true } for the declarative config seed only
    // preProcess writes, so everything that can refuse runs first - including the
    // required-field check and checkExist, which otherwise happen inside super.*
    // an Entra ID provider names its tenant : without one (or with common, organizations,
    // consumers) any Microsoft tenant could sign in (auth/auth_entraid.js refuses to start)
    static assertEntraTenant(provider, tenantId) {
        if (provider === 'azuread' && !isSingleTenant(tenantId)) {
            throw new Errors.BadRequestError("A Microsoft Entra ID provider needs the tenant id of your tenant (a GUID or its domain), not empty, common, organizations or consumers");
        }
    }
    // the client a provider signs in as : a credential (its user the client id, its password the
    // secret), else its own client id and secret, both
    // the credential type of a provider : an Entra ID one's entraid, an Open ID one's oidc
    static credentialTypeOf(provider) {
        return provider === 'azuread' ? 'entraid' : 'oidc';
    }
    // the credential a provider names : one of Connections > Credentials, of its provider's type
    static async assertCredential(name, provider) {
        if (!name) return;
        const cred = await CrudModel.findByName('credential', name);
        if (!cred) throw new Errors.BadRequestError(`No credential named '${name}'`);
        const type = this.credentialTypeOf(provider);
        if (cred.credential_type !== type) {
            throw new Errors.BadRequestError(`This SSO provider needs an ${type} credential: '${name}' is not one`);
        }
        if (type === 'entraid' && !isSingleTenant(cred.tenant_id)) {
            throw new Errors.BadRequestError(`The credential '${name}' needs the tenant id of your tenant (a GUID or its domain)`);
        }
    }
    static assertClient(state) {
        if (state.credential) return;
        if (!state.client_id || !state.client_secret) {
            throw new Errors.BadRequestError("An SSO provider needs a client id and a client secret, or a credential");
        }
    }
    static async create(data, opts = {}) {
        CrudModel.assertRequired(this.modelName, data);
        this.assertClient(data);
        await this.assertCredential(data.credential, data.provider);
        // the tenant : its credential's (checked there), else its own
        if (!data.credential) this.assertEntraTenant(data.provider, data.tenant_id);
        // a new provider is the one its type signs in with when its type has none yet ; another is
        // chosen with Use for sign-in (enable : 1)
        if (data.enable === undefined && !opts.fromSeed) {
            const active = await mysql.do('SELECT id FROM AnsibleForms.`oauth2_providers` WHERE enable = 1 AND provider = ?', [data.provider]);
            data.enable = active.length ? 0 : 1;
        }
        data =await this.preProcess(data, 'create', opts);
        return super.create(this.modelName, data, opts);
    }
    static async update(data, id, opts = {}) {
        await CrudModel.checkExist(this.modelName, id);
        if (!opts.fromSeed) await CrudModel.assertNotManaged(this.modelName, id);
        if ('credential' in data || 'client_id' in data || 'client_secret' in data) {
            const current = (await mysql.do('SELECT provider, client_id, client_secret, credential FROM AnsibleForms.`oauth2_providers` WHERE id=?', [id]))?.[0] || {};
            // the masked secret (the page's) keeps the stored one
            const secret = 'client_secret' in data && !/^\*+$/.test(String(data.client_secret || '')) ? data.client_secret : current.client_secret;
            this.assertClient({ ...current, ...data, client_secret: secret });
            if ('credential' in data) await this.assertCredential(data.credential, data.provider ?? current.provider);
        }
        if ('tenant_id' in data || 'provider' in data || 'credential' in data) {
            const current = (await mysql.do('SELECT provider, tenant_id, credential FROM AnsibleForms.`oauth2_providers` WHERE id=?', [id]))?.[0] || {};
            // the tenant : its credential's (checked with it), else its own
            const credential = 'credential' in data ? data.credential : current.credential;
            if (!credential) this.assertEntraTenant(data.provider ?? current.provider, 'tenant_id' in data ? data.tenant_id : current.tenant_id);
        }
        // the stored type and in-use state : the request names only what it changes
        const stored = (await mysql.do('SELECT provider, enable FROM AnsibleForms.`oauth2_providers` WHERE id=?', [id]))?.[0] || {};
        data = await this.preProcess(data, 'update', opts, stored);
        return super.update(this.modelName, data, id, opts);
    }
    static async delete(id, opts = {}) {
        return super.delete(this.modelName, id, opts);
    }
    static async findById(id) {
        return super.findById(this.modelName, id);
    }
    static async findAll() {
        return super.findAll(this.modelName);
    }
    static async findByName(name) {
        return super.findByName(this.modelName, name);
    }
    static async findByProperty(property, value) {
        return super.findByProperty(this.modelName, property, value);
    }

    /**
     * The provider type the login page skips to : the enabled provider set to Skip the login
     * page (auto_login), the first by id. Whether it can sign in is the caller's (its type's
     * settings).
     *
     * Returns:
     *   Promise<string|null>: 'azuread' or 'oidc', or null when none is set or the table cannot be
     *     read (a database before its patch).
     */
    static async autoLoginProvider() {
        return mysql
            .do('SELECT provider FROM AnsibleForms.`oauth2_providers` WHERE enable = 1 AND auto_login = 1 ORDER BY id LIMIT 1')
            .then((rows) => rows?.[0]?.provider || null)
            .catch(() => null);
    }
}

export default OAuth2;
