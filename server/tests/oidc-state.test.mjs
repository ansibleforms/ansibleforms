// #1296 : the OpenID Connect sign-in sent no `state`. openid-client's passport strategy adds one
// only when the provider does not advertise PKCE, and providers that require a state anyway
// (Authelia by default) refused the request ; told to accept it, they sent a state back that
// openid-client then refused. Both sign-ins (OpenID Connect and Entra ID) now send a random
// state, kept in the sign-in's session and checked on the callback.
import { describe, test, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import passport from "passport";
import * as openidClient from "openid-client";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

const TENANT = "11111111-2222-3333-4444-555555555555";
const oidcProvider = { enable: 1, issuer: "https://idp.example.com", client_id: "af-client", client_secret: "s3cret", redirect_uri: "https://af.example.com/api/v2/auth/oidc/callback" };
const entraProvider = { enable: 1, tenant_id: TENANT, client_id: "af-entra", client_secret: "s3cret", redirect_uri: "https://af.example.com/api/v2/auth/entraid/callback" };
vi.mock("../src/models/oidc.model.js", () => ({ default: { isEnabled: async () => oidcProvider, find: async () => oidcProvider } }));
vi.mock("../src/models/entraId.model.js", () => ({ default: { isEnabled: async () => entraProvider, find: async () => entraProvider } }));

// the provider : its metadata advertises PKCE (as Authelia's does), and its token endpoint
// answers the code exchange with an ID token signed by this key - no network
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const tokenCalls = [];
function providerConfig(issuer, clientId, extraClaims = {}) {
  const config = new openidClient.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      code_challenge_methods_supported: ["S256"],
    },
    clientId,
    "s3cret",
  );
  config[openidClient.customFetch] = async (url, init) => {
    tokenCalls.push({ url, body: String(init.body) });
    const now = Math.floor(Date.now() / 1000);
    const idToken = jwt.sign({ iss: issuer, aud: clientId, sub: "alice", iat: now, exp: now + 300, ...extraClaims }, privateKey, { algorithm: "RS256" });
    return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return config;
}
// discovery returns the provider above for the issuer asked for
vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    discovery: async (issuer, clientId) => {
      const href = String(issuer).replace(/\/+$/, "");
      return providerConfig(href, clientId, href.includes(TENANT) ? { tid: TENANT } : {});
    },
  };
});

const authOidc = (await import("../src/auth/auth_oidc.js")).default;
const authEntraId = (await import("../src/auth/auth_entraid.js")).default;

/**
 * Runs a strategy on a request, as passport.authenticate with a custom callback does.
 *
 * Args:
 *   name (string): the strategy ('oidc' or 'entraid').
 *   req (object): the request.
 *
 * Returns:
 *   Promise<object>: { redirect } for the redirect to the provider, { err, user, info } otherwise.
 */
function run(name, req) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end() { resolve({ redirect: this.headers.location }); },
    };
    passport.authenticate(name, (err, user, info) => resolve({ err, user, info }))(req, res, (err) => resolve({ err }));
  });
}

// a request of the browser, on the sign-in's session
const request = (path, session) => ({ method: "GET", protocol: "https", host: "af.example.com", url: path, originalUrl: path, query: {}, headers: {}, session });

beforeEach(() => { tokenCalls.length = 0; });

describe.each([
  ["oidc", authOidc, "/api/v2/auth/oidc"],
  ["entraid", authEntraId, "/api/v2/auth/entraid"],
])("the %s sign-in sends a state and checks it", (name, auth, path) => {
  // starts the sign-in : the redirect's state, and the session it was kept in
  async function start() {
    expect(await auth.initialize()).toBe(true);
    const session = {};
    const { redirect } = await run(name, request(path, session));
    return { url: new URL(redirect), session };
  }

  test("the redirect to the provider carries a random state, kept in the session", async () => {
    const first = await start();
    const second = await start();
    const state = first.url.searchParams.get("state");
    // openid-client's randomState : 32 random bytes, 43 url-safe characters
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.url.searchParams.get("state")).not.toBe(state);
    // PKCE as before
    expect(first.url.searchParams.get("code_challenge_method")).toBe("S256");
    const [stateData] = Object.values(first.session);
    expect(stateData).toMatchObject({ state, code_verifier: expect.any(String) });
  });

  test("the callback with the state of the redirect signs the user in", async () => {
    const { url, session } = await start();
    const state = url.searchParams.get("state");
    const result = await run(name, request(`${path}/callback?code=abc&state=${state}`, session));
    expect(result.err).toBeFalsy();
    expect(result.user).toBeTruthy();
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toContain("code=abc");
  });

  test("a callback with another state, or without one, is refused before the code exchange", async () => {
    for (const query of ["code=abc&state=tampered-state-value", "code=abc"]) {
      const { session } = await start();
      const result = await run(name, request(`${path}/callback?${query}`, session));
      expect(result.user).toBeFalsy();
      // openid-client wraps the reason : response parameter "state" missing, or another value
      expect(String(result.err?.cause?.message || result.err?.message)).toMatch(/"state"/);
    }
    expect(tokenCalls).toHaveLength(0);
  });
});
