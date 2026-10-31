// The openid-client passport strategy, with a `state` on every authorization request (#1296).
//
// openid-client's strategy adds a random `state` only when the provider does NOT advertise PKCE
// support (build/passport.js, authorizationRequest) : with PKCE it relies on the code verifier
// alone. Providers that require a state anyway (Authelia by default) refuse such a request
// ("Request parameter 'state' must be at least 8 characters"), and one told to accept it sends a
// state back that openid-client then refuses ("unexpected state response parameter").
//
// The strategy already handles a state the request carries : it keeps it in the sign-in's
// session next to the code verifier, and the callback passes it as `expectedState` to the code
// exchange, which refuses a callback whose state is missing or another one. So this subclass
// only puts a random state into the request parameters ; the storing and the checking stay the
// library's.
import * as openidClient from 'openid-client';
import { Strategy as OpenIdClientStrategy } from 'openid-client/passport';

/**
 * openid-client's passport strategy that always sends a random `state`.
 *
 * Used by the OpenID Connect and the Microsoft Entra ID sign-ins, with the same options and the
 * same verify callback as the library's strategy.
 */
export class StatefulStrategy extends OpenIdClientStrategy {
  /**
   * The parameters of the authorization request : the library's, plus a random `state` when
   * they carry none.
   *
   * Args:
   *   req (object): the request starting the sign-in.
   *   options (object): the passport.authenticate options.
   *
   * Returns:
   *   URLSearchParams: the authorization request parameters, with a `state`.
   */
  authorizationRequestParams(req, options) {
    // Step 1: the library's parameters (scope, prompt, redirect uri, ...)
    const params = super.authorizationRequestParams(req, options);
    // Step 2: a random state (43 url-safe characters), unless one is already set ; the
    // library stores it in the session and checks it on the callback
    if (!params.has('state')) params.set('state', openidClient.randomState());
    return params;
  }
}

export default StatefulStrategy;
