// #1036 : the access token carried every group of the user. An Entra ID user has each group
// twice (its object id and its name), so a user in about 120 groups had a token of some 15 KB,
// sent on every request in the Authorization header : with the other headers it passed Node's
// 16 KB limit and every api call was refused with 431, before it reached the app.
//
// The tokens now leave the groups out. The sign-in still resolves the roles and options from
// them and stores them (a directory user's record, a local user's groups), and the server puts
// them back on req.user.user (lib/userGroups.js) : the token refresh, the job's
// ansibleforms_user, a planned job's owner and the profile see them as before.
import { describe, test, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── a database in memory : the directory users, the local users, the tokens ──────────────────
const db = vi.hoisted(() => ({ directory: new Map(), local: new Map(), tokens: new Map(), queries: 0 }));
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params) => {
      db.queries++;
      if (/INSERT INTO AnsibleForms.`directory_users` \(type, username, external_id/.test(sql)) {
        const [type, username, , , , groups, roles] = params;
        db.directory.set(`${type}/${username}`, { type, username, groups, roles, blocked: 0 });
        return {};
      }
      if (/SELECT blocked FROM AnsibleForms.`directory_users`/.test(sql)) return [];
      if (/SELECT \* FROM AnsibleForms.`directory_users` WHERE type = \? AND username = \?/.test(sql)) {
        const row = db.directory.get(`${params[0]}/${params[1]}`);
        return row ? [row] : [];
      }
      if (/GROUP_CONCAT\(g.name\)/.test(sql)) {
        const username = Array.isArray(params) ? params[0] : params;
        return db.local.has(username) ? [{ groups: db.local.get(username) }] : [];
      }
      // the tokens a refresh replaced stay a few seconds, marked (models/token.model.js)
      if (/INSERT INTO AnsibleForms.`tokens`/.test(sql)) { db.tokens.set(params.refresh_token, null); return {}; }
      if (/SELECT replaced_at IS NULL AS current/.test(sql)) {
        return db.tokens.has(params[3]) ? [{ current: db.tokens.get(params[3]) === null ? 1 : 0, recent: 1 }] : [];
      }
      if (/SET replaced_at=UTC_TIMESTAMP\(\)/.test(sql)) {
        if (db.tokens.get(params[2]) !== null) return { affectedRows: 0 };
        db.tokens.set(params[2], Date.now());
        return { affectedRows: 1 };
      }
      if (/DELETE FROM AnsibleForms.`tokens` .*refresh_token=\?/.test(sql)) { db.tokens.delete(params[2]); return {}; }
      if (/DELETE FROM AnsibleForms.`tokens`/.test(sql)) return {};
      return [];
    },
    tryDo: async () => [],
  },
}));
vi.mock("../src/lib/tokenRevocation.js", () => ({
  newSessionId: () => crypto.randomUUID(),
  isRevoked: async () => false,
  revokeSession: async () => {},
  consumeOnce: async () => true,
}));
const TENANT = "11111111-2222-3333-4444-555555555555";
const provider = { enable: 1, groupfilter: "", tenant_id: TENANT };
vi.mock("../src/models/entraId.model.js", () => ({ default: { isEnabled: async () => provider, find: async () => provider } }));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: async () => {} } }));
vi.mock("../src/lib/i18n.js", () => ({ default: { t: (_req, key) => key } }));
vi.mock("../src/services/cron.service.js", () => ({ default: { removeSchedule: () => {}, addSchedule: () => {} } }));
vi.mock("../src/models/job.model.js", () => ({ default: { launch: async () => ({ id: 1 }) }, guardLaunch: async () => {} }));
// the roles : one per kind of user, granted through a group
const roles = vi.hoisted(() => [
  { name: "operators", groups: ["azuread/SG-Operators"] },
  { name: "netops", groups: ["ldap/netops"] },
  { name: "builders", groups: ["local/builders"] },
  { name: "admin", groups: ["local/admins"] },
]);
vi.mock("../src/models/form.model.js", () => ({
  default: { load: async (_roles, name) => (name ? { forms: [{ name }] } : { roles }) },
}));

const { signHandoff } = await import("../src/lib/ssoHandoff.js");
const controller = (await import("../src/controllers/v2/login.controller.js")).default;
const tokenController = (await import("../src/controllers/v2/token.controller.js")).default;
const authConfig = (await import("../config/auth.config.js")).default;
const { groupsOf, clearGroupsCache, forgetGroups } = await import("../src/lib/userGroups.js");
const Helpers = (await import("../src/lib/common.js")).default;
const { default: Schedule } = await import("../src/models/schedule.model.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const passport = (await import("passport")).default;
await import("../src/auth/auth_jwt.js");

const res = () => { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

/**
 * Signs in an Entra ID user whose Graph membership is the given group names.
 *
 * Args:
 *   names (string[]): the group names.
 *
 * Returns:
 *   Promise<object>: the login's answer, { token, refreshtoken }.
 */
async function azureLogin(names, { reauth = false } = {}) {
  const value = names.map((n) => ({ id: crypto.randomUUID(), displayName: n }));
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ value }) }));
  const entraToken = jwt.sign({ upn: "first.lastname@contoso.com", oid: crypto.randomUUID(), tid: TENANT, name: "First Lastname" }, "x");
  const r = res();
  await controller.entraidLogin({ body: { token: signHandoff(entraToken, "azuread", { reauth }) }, headers: {}, ip: "127.0.0.1" }, r);
  expect(r.statusCode).toBe(200);
  return r.body;
}

/**
 * What the jwt strategy makes of an access token : req.user.
 *
 * Args:
 *   token (string): the access token.
 *
 * Returns:
 *   Promise<object>: the verified payload, its user with its groups.
 */
function authenticate(token) {
  const payload = jwt.verify(token, authConfig.secret);
  return new Promise((resolve, reject) => {
    passport._strategy("jwt")._verify(payload, (err, user) => (err ? reject(err) : resolve(user)));
  });
}

// 500 groups as a corporate tenant names them, the one that grants a role first
const manyGroups = ["SG-Operators", ...Array.from({ length: 499 }, (_, i) => `SG-Dept-Infrastructure-Brussels-Office-${i}-Members`)];

beforeEach(() => {
  db.directory.clear();
  db.local.clear();
  db.tokens.clear();
  clearGroupsCache();
});

describe("the tokens leave the groups out", () => {
  test("an Entra ID user in 500 groups gets small tokens, with its roles, and its groups recorded", async () => {
    const { token, refreshtoken } = await azureLogin(manyGroups);
    // it was some 61 KB : every group twice, by object id and by name
    expect(token.length).toBeLessThan(4096);
    expect(refreshtoken.length).toBeLessThan(4096);
    const { user } = jwt.verify(token, authConfig.secret);
    expect(user.groups).toBeUndefined();
    expect(user.roles).toContain("operators");
    expect(jwt.verify(refreshtoken, authConfig.secret).user.groups).toBeUndefined();
    const record = JSON.parse(db.directory.get("azuread/first.lastname@contoso.com").groups);
    expect(record).toHaveLength(1000);
    expect(record).toContain("azuread/SG-Operators");
  });

  test("an api token (expiryDays) leaves them out too", async () => {
    db.local.set("bob", "builders");
    vi.spyOn(passport, "authenticate").mockImplementationOnce((_name, cb) => () =>
      cb(null, { username: "bob", type: "local", id: 2, groups: ["local/builders"], roles: ["builders"], options: { allowLogin: true, extendedTokenExpiration: true } }));
    const r = res();
    // the login answers from passport's callback, which nobody awaits : wait for the answer
    const answered = new Promise((resolve) => { const json = r.json; r.json = (b) => { json(b); resolve(); return r; }; });
    await controller.basic({ headers: {}, ip: "127.0.0.1", query: { expiryDays: "30" }, login: (u, o, cb) => cb() }, r, () => {});
    await answered;
    const payload = jwt.verify(r.body.token, authConfig.secret);
    expect(payload.api).toBe(true);
    expect(payload.user.groups).toBeUndefined();
    expect(payload.user.roles).toEqual(["builders"]);
  });
});

describe("the server puts the groups back", () => {
  test("on req.user.user: a directory user's from its record, a local user's from its groups", async () => {
    const { token } = await azureLogin(manyGroups);
    const req = await authenticate(token);
    expect(req.user.groups).toHaveLength(1000);
    expect(req.user.groups).toContain("azuread/SG-Operators");

    db.local.set("bob", "builders,users");
    const local = jwt.sign({ user: { username: "bob", type: "local", roles: ["builders"] }, access: true }, authConfig.secret);
    expect((await authenticate(local)).user.groups).toEqual(["local/builders", "local/users"]);
  });

  test("a token issued before, with its groups, is accepted and keeps them", async () => {
    const old = jwt.sign({ user: { username: "carol", type: "ldap", groups: ["ldap/netops"], roles: ["netops"] }, access: true }, authConfig.secret);
    const req = await authenticate(old);
    expect(req.user.groups).toEqual(["ldap/netops"]);
    expect(req.user.roles).toEqual(["netops"]);
  });

  test("a user with nothing stored has none ; the lookup is cached", async () => {
    expect(await groupsOf({ username: "ghost", type: "oidc" })).toEqual([]);
    db.local.set("bob", "builders");
    const before = db.queries;
    await groupsOf({ username: "bob", type: "local" });
    await groupsOf({ username: "bob", type: "local" });
    expect(db.queries - before).toBe(1);
  });

  test("the job's ansibleforms_user still carries them", async () => {
    const { token } = await azureLogin(manyGroups);
    const req = await authenticate(token);
    const user = Helpers.userForExtravars(req.user, undefined);
    expect(user.groups).toContain("azuread/SG-Operators");
    expect(Helpers.userForExtravars(req.user, "username,groups").groups).toHaveLength(1000);
  });

  test("a planned job's owner carries them", async () => {
    let created = null;
    CrudModel.create = async (_model, data) => { created = data; return 7; };
    const { token } = await azureLogin(manyGroups);
    const req = await authenticate(token);
    await Schedule.plan({ ...req.user, options: { ...req.user.options, allowPlannedJobs: true } }, {
      name: "later", one_time_run: true, form: "Demo Form", extra_vars: "", run_at: "2030-01-01 10:00:00",
    });
    expect(JSON.parse(created.owner).groups).toContain("azuread/SG-Operators");
  });
});

// An api token has no refresh : it lives up to API_TOKEN_MAX_DAYS, or for ever. The roles and
// options it was signed with used to be trusted on every request, so a user taken out of the
// admin role kept admin through its api token until someone revoked it by hand. The jwt strategy
// now resolves them again from the user's groups as they are now, cached as the groups are.
describe("an api token follows the roles of its user as they are now", () => {
  /**
   * An api token of bob, signed as the login signs one : the roles and options of its sign-in.
   *
   * Args:
   *   roles (string[]): the roles the token was signed with.
   *   api (boolean): an api token (true) or a session's access token (false).
   *
   * Returns:
   *   string: the token.
   */
  function bobToken(roles, api = true) {
    const user = { username: "bob", type: "local", roles, options: { allowLogin: true, showSettings: true, signed: true } };
    return jwt.sign(api ? { user, access: true, sid: "s", api: true } : { user, access: true, sid: "s" }, authConfig.secret);
  }

  test("a user taken out of the admin role loses it, its options too", async () => {
    db.local.set("bob", "admins,builders");
    const token = bobToken(["admin", "builders", "default"]);
    expect((await authenticate(token)).user.roles).toContain("admin");
    // an admin takes bob out of the admins group ; the cache forgets it (a minute later at most)
    db.local.set("bob", "builders");
    forgetGroups("local", "bob");
    const req = await authenticate(token);
    expect(req.user.roles).not.toContain("admin");
    expect(req.user.roles).toContain("builders");
    // the options are resolved again, not the ones signed in the token
    expect(req.user.options.signed).toBeUndefined();
    expect(req.user.options.showSettings).toBe(false);
    expect(req.user.groups).toEqual(["local/builders"]);
  });

  test("a role granted since is there too", async () => {
    db.local.set("bob", "builders,admins");
    expect((await authenticate(bobToken(["builders", "default"]))).user.roles).toContain("admin");
  });

  test("resolved once per user and cached : a request then costs no query", async () => {
    db.local.set("bob", "builders");
    const token = bobToken(["builders", "default"]);
    await authenticate(token);
    const before = db.queries;
    await authenticate(token);
    await authenticate(token);
    // ApiToken.touch writes at most once a minute, and only the first request above did
    expect(db.queries - before).toBe(0);
  });

  test("the cache does not outlive a change by more than its 30 seconds", async () => {
    db.local.set("bob", "admins");
    const token = bobToken(["admin", "default"]);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect((await authenticate(token)).user.roles).toContain("admin");
      db.local.set("bob", "builders");
      clock.mockReturnValue(now + 31 * 1000);
      expect((await authenticate(token)).user.roles).not.toContain("admin");
    } finally {
      clock.mockRestore();
    }
  });

  test("a session's access token keeps the roles it carries (short-lived, a refresh resolves them)", async () => {
    db.local.set("bob", "builders");
    const req = await authenticate(bobToken(["admin", "builders", "default"], false));
    expect(req.user.roles).toContain("admin");
    expect(req.user.options.signed).toBe(true);
  });
});

describe("the token refresh", () => {
  /**
   * Refreshes a refresh token.
   *
   * Args:
   *   refreshtoken (string): the refresh token.
   *
   * Returns:
   *   Promise<object>: the answer.
   */
  async function refresh(refreshtoken) {
    const r = res();
    await tokenController.refresh({ body: { refreshtoken } }, r);
    return r;
  }

  test("re-resolves the roles from the stored groups, and leaves them out of the new tokens", async () => {
    const { refreshtoken } = await azureLogin(manyGroups);
    // the directory took the user out of SG-Operators : its record says so at the next sign-in,
    // here written by hand
    const key = "azuread/first.lastname@contoso.com";
    db.directory.set(key, { ...db.directory.get(key), groups: JSON.stringify(["azuread/SG-Other"]) });
    let r = await refresh(refreshtoken);
    expect(r.statusCode).toBe(200);
    let user = jwt.verify(r.body.token, authConfig.secret).user;
    expect(user.roles).not.toContain("operators");
    expect(user.groups).toBeUndefined();
    expect(jwt.verify(r.body.refreshtoken, authConfig.secret).user.groups).toBeUndefined();

    // and back in it
    db.directory.set(key, { ...db.directory.get(key), groups: JSON.stringify(["azuread/SG-Operators"]) });
    r = await refresh(r.body.refreshtoken);
    user = jwt.verify(r.body.token, authConfig.secret).user;
    expect(user.roles).toContain("operators");
  });

  test("a local user's groups as an admin set them now", async () => {
    db.local.set("bob", "users");
    const old = jwt.sign({ user: { username: "bob", type: "local", groups: ["local/users"], roles: ["default"] }, refresh: true, sid: "s" }, authConfig.secret, { issuer: authConfig.jwtIssuer });
    db.tokens.set(old, null);
    db.local.set("bob", "users,builders");
    const r = await refresh(old);
    expect(r.statusCode).toBe(200);
    const user = jwt.verify(r.body.token, authConfig.secret).user;
    expect(user.roles).toContain("builders");
    expect(user.groups).toBeUndefined();
  });

  test("a refresh token issued before, for a user with nothing stored, uses the groups it carries", async () => {
    const old = jwt.sign({ user: { username: "carol", type: "ldap", groups: ["ldap/netops"], roles: [] }, refresh: true, sid: "s" }, authConfig.secret, { issuer: authConfig.jwtIssuer });
    db.tokens.set(old, null);
    const r = await refresh(old);
    expect(r.statusCode).toBe(200);
    expect(jwt.verify(r.body.token, authConfig.secret).user.roles).toContain("netops");
  });
});

// #1068 : an api token is made from a session only shortly after its user proved who they are. An
// SSO sign-in the provider may have answered silently does not count ; one where it asked for the
// credentials again (prompt=login, the handoff's reauth) does. A refresh carries the time as it is.
describe("the sign-in time of a session (auth_time)", () => {
  async function refresh(refreshtoken) {
    const r = res();
    await tokenController.refresh({ body: { refreshtoken } }, r);
    return r;
  }

  test("a plain SSO sign-in has none", async () => {
    const { token, refreshtoken } = await azureLogin(["SG-Operators"]);
    expect(jwt.decode(token).auth_time).toBeUndefined();
    expect(jwt.decode(refreshtoken).auth_time).toBeUndefined();
    // and a refresh does not make one up
    const r = await refresh(refreshtoken);
    expect(r.statusCode).toBe(200);
    expect(jwt.decode(r.body.token).auth_time).toBeUndefined();
  });

  test("an SSO sign-in asked for again has it, and a refresh keeps it as it was", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { token, refreshtoken } = await azureLogin(["SG-Operators"], { reauth: true });
    const at = jwt.decode(token).auth_time;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(jwt.decode(refreshtoken).auth_time).toBe(at);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await refresh(refreshtoken);
    expect(jwt.decode(r.body.token).auth_time).toBe(at);
    expect(jwt.decode(r.body.refreshtoken).auth_time).toBe(at);
  });

  test("?reauth=1 asks the provider for the credentials (prompt=login), and only that callback says reauth", async () => {
    const { ssoStart, authCallback } = await import("../src/controllers/v2/login.controller.js");
    const handoffOf = async (req) => {
      let to = "";
      await authCallback(req, { redirect: (u) => (to = u) }, (e) => { throw e; }, "oidc")(null, { sub: "x", email: "a@b.c" });
      return jwt.decode(new URLSearchParams(to.split("#")[1]).get("token"));
    };
    const session = {};
    expect(ssoStart({ query: { reauth: "1" }, session })).toEqual({ prompt: "login" });
    expect(session.afReauth).toBeGreaterThan(0);
    const req = { session };
    expect((await handoffOf(req)).reauth).toBe(true);
    // taken once : a second callback on that session is a plain sign-in
    expect(session.afReauth).toBeUndefined();
    expect((await handoffOf(req)).reauth).toBeUndefined();
    // a plain sign-in forgets an older mark
    session.afReauth = Date.now();
    expect(ssoStart({ query: {}, session })).toEqual({});
    expect((await handoffOf({ session })).reauth).toBeUndefined();
    // a mark too old (an abandoned sign-in) does not count
    session.afReauth = Date.now() - 11 * 60 * 1000;
    expect((await handoffOf({ session })).reauth).toBeUndefined();
  });

  test("the handoff says reauth only when asked", () => {
    expect(jwt.decode(signHandoff({ sub: "x" }, "oidc")).reauth).toBeUndefined();
    expect(jwt.decode(signHandoff({ sub: "x" }, "oidc", { reauth: true })).reauth).toBe(true);
  });
});
