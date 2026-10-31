// Microsoft Entra ID (formerly Azure AD) login, on openid-client : the authorization code flow with
// PKCE and a state, the ID token checked by the library (signature, issuer, audience,
// expiry) - and the tenant pinned. The login is against the configured tenant's own v2.0
// issuer, never the common endpoint, and the token's `tid` must be that tenant : a user of
// another Microsoft tenant is refused, not let in as `default`.
//
// The access token the same login returns is for Microsoft Graph (User.Read,
// GroupMember.Read.All) : the login step reads the user's groups with it (lib/entraGraph.js).
import passport from 'passport';
import * as openidClient from 'openid-client';
// the library's strategy, with a state on every sign-in (#1296)
import { StatefulStrategy } from './statefulStrategy.js';
import EntraId from '../models/entraId.model.js';
import logger from '../lib/logger.js';
import authConfig from '../../config/auth.config.js';

// the tenant ids that are not one tenant : refused, they would let any tenant in
const NOT_A_TENANT = new Set(['', 'common', 'organizations', 'consumers']);

// what the login asks for : the ID token's claims, and an access token for Graph
export const ENTRA_SCOPES = 'openid profile email User.Read GroupMember.Read.All';

/**
 * Whether a tenant id names one tenant (a GUID or a domain), not a multi-tenant endpoint.
 *
 * Args:
 *   tenantId (string): the configured tenant id.
 *
 * Returns:
 *   boolean: true for one tenant.
 */
export function isSingleTenant(tenantId) {
  return !NOT_A_TENANT.has(String(tenantId || '').trim().toLowerCase());
}

/**
 * Checks the claims of a login : the token's tenant must be the configured one.
 *
 * Args:
 *   claims (object): the ID token's claims.
 *   tenantId (string): the configured tenant id (a GUID, or a domain of the tenant).
 *
 * Raises:
 *   Error: the token is of another tenant.
 */
export function assertTenant(claims, tenantId) {
  const tid = String(claims?.tid || '').toLowerCase();
  const want = String(tenantId || '').trim().toLowerCase();
  // a domain as tenant id : the issuer, pinned by the discovery, names the tenant's GUID ;
  // a GUID : it must be the token's tid
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(want);
  if (!tid) throw new Error('The Microsoft Entra ID token carries no tenant (tid)');
  if (guid && tid !== want) throw new Error(`The Microsoft Entra ID token is of another tenant (${tid})`);
  if (!guid && !String(claims?.iss || '').toLowerCase().includes(`/${tid}/`)) {
    throw new Error('The Microsoft Entra ID token does not come from the tenant it names');
  }
}

const initialize = async () => {
  logger.debug('Initializing Microsoft Entra ID strategy');
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  let entra;
  let entraConfig;
  try {
    entra = await EntraId.isEnabled();
    if (entra.enable) entraConfig = await EntraId.find();
    else logger.info('Microsoft Entra ID is not enabled');
  } catch (err) {
    logger.error('Failed to get the Microsoft Entra ID configuration. ', err);
    return false;
  }
  try {
    passport.unuse('entraid');
  } catch (err) {
    logger.error('Failed to remove the Microsoft Entra ID strategy. ', err);
  }
  if (!entra?.enable) return true;
  if (!entraConfig?.client_id || !entraConfig?.redirect_uri) {
    logger.error('Could not enable Microsoft Entra ID: the client id and the redirect uri are required');
    return false;
  }
  if (!isSingleTenant(entraConfig.tenant_id)) {
    logger.error(`Could not enable Microsoft Entra ID: set the tenant id to your tenant ('${entraConfig.tenant_id || ''}' would let any Microsoft tenant log in)`);
    return false;
  }
  try {
    const tenant = encodeURIComponent(String(entraConfig.tenant_id).trim());
    // the authority : Microsoft's public cloud, a national cloud (ENTRA_AUTHORITY_URI), or in
    // development a local test provider over plain http
    const authority = String(authConfig.entraAuthorityUrl || 'https://login.microsoftonline.com').replace(/\/+$/, '');
    const issuer = new URL(`${authority}/${tenant}/v2.0`);
    const plainHttp = issuer.protocol === 'http:';
    if (plainHttp && process.env.NODE_ENV !== 'development') {
      logger.error(`Could not enable Microsoft Entra ID: the authority ${authority} is not https`);
      return false;
    }
    const config = await openidClient.discovery(issuer, entraConfig.client_id, { client_secret: entraConfig.client_secret }, undefined,
      plainHttp ? { execute: [openidClient.allowInsecureRequests] } : undefined);
    const verify = (tokens, done) => {
      try {
        const claims = tokens.claims();
        assertTenant(claims, entraConfig.tenant_id);
        logger.debug(`Microsoft Entra ID login for subject=${claims.sub || 'unknown'}`);
        // the claims and the Graph access token, for the handoff (lib/ssoHandoff.js)
        return done(null, { claims, accessToken: tokens.access_token });
      } catch (err) {
        logger.warning(`Microsoft Entra ID login refused: ${err.message}`);
        return done(err);
      }
    };
    passport.use('entraid', new StatefulStrategy({
      config,
      scope: ENTRA_SCOPES,
      callbackURL: new URL(entraConfig.redirect_uri),
    }, verify));
    logger.info('Microsoft Entra ID strategy initialized');
    return true;
  } catch (err) {
    logger.error(`Failed to initialize the Microsoft Entra ID strategy. ${err?.message || err}`);
    return false;
  }
};

export default {
  initialize,
};
