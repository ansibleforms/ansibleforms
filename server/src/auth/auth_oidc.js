import passport from 'passport';
import OIDC from '../models/oidc.model.js';
import logger from "../lib/logger.js";
import * as openidClient from 'openid-client';
// the library's strategy, with a state on every sign-in (#1296)
import { StatefulStrategy } from './statefulStrategy.js';


let oidcConfigCache = null;

const initialize = async () => {
  logger.debug("Initializing OIDC strategy");
  passport.serializeUser(function(user, done) {
    done(null, user);
  });

  passport.deserializeUser(function(user, done) {
    done(null, user);
  });

  let oidcConfig;
  let oidcSettings;
  let oidcEnabled;
  try {
    oidcSettings = await OIDC.isEnabled();
    oidcEnabled = !!oidcSettings.enable;
    if (!oidcEnabled) {
      logger.info('OIDC is not enabled');
    } else {
      oidcConfig = await OIDC.find();
    }
  } catch (err) {
    logger.error("Failed to getting OIDC Config or settings. ", err);
    return false;
  }
  try {
    logger.debug("Removing the strategy OIDC");
    passport.unuse('oidc');
    if (!oidcEnabled) {
      return true;
    }
  } catch (err) {
    logger.error("Failed to remove strategy. ", err);
  }

  if (!oidcEnabled || !oidcConfig?.issuer || !oidcConfig?.client_id) {
    logger.error('Could not enable OIDC strategy, missing config or URL');
    return false;
  }

  try {
    const issuerUrl = new URL(oidcConfig.issuer);
    logger.debug(`Discovering OIDC issuer at ${issuerUrl.href}`);

    // plain http only in development, for a local test provider ; a real provider is https
    const execute = [];
    if (issuerUrl.protocol === 'http:') {
      if (process.env.NODE_ENV !== 'development') {
        logger.error(`Could not enable OIDC: the issuer ${issuerUrl.href} is not https`);
        return false;
      }
      execute.push(openidClient.allowInsecureRequests);
    }

    const config = await openidClient.discovery(
      issuerUrl,
      oidcConfig.client_id,
      {
        client_secret: oidcConfig.client_secret,
      },
      undefined,
      {
        execute,
      }
    );

    oidcConfigCache = config;

    const strategyOptions = {
      config,
      scope: 'openid profile email',
      callbackURL: new URL(oidcConfig.redirect_uri),
    };

    const verify = (tokens, done) => {
      const claims = tokens.claims();
      logger.debug(`OIDC login successful for subject=${claims.sub || 'unknown'}`);
      return done(null, claims);
    };

    logger.debug('Registering OIDC passport strategy');
    passport.use('oidc', new StatefulStrategy(strategyOptions, verify));

    logger.info('OIDC strategy initialized successfully');
    return true;
  } catch (err) {
    logger.error(`Failed to initialize OIDC strategy. ${err?.message || err}`);
    if (err?.cause) {
      logger.error(`  Cause: ${err.cause.message || err.cause}`);
    }
    logger.error(err?.stack);
    return false;
  }
};

const getLogoutUrl = (baseUrl = '') => {
  try {
    if (!oidcConfigCache) return '';

    const url = openidClient.buildEndSessionUrl(oidcConfigCache, {
      ...(baseUrl ? { post_logout_redirect_uri: baseUrl } : {}),
    });

    return url.href;
  } catch (err) {
    logger.error(`Failed to build OIDC logout URL. ${err?.message || err}`);
    return '';
  }
};

export default {
  initialize,
  getLogoutUrl
};