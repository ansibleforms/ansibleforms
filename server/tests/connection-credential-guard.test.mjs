// A notification channel posts its token (a webhook's bearer, a telegram bot's) or signs in with
// its login (mail) at an address its editor types, and a repository hands git its credential at
// the address it clones from. A user with only connections access could name a runner's token or
// an SSO client there, or point a channel or a repository that names a credential at their own
// server, and receive the secret. These pin the rules : a credential only an admin may name is
// refused to them, a repository takes a credential with a password or a token only, and a move to
// another address drops the credential (and a repository's own password) unless chosen again.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the credentials there are : an open api token, a runner's token, an SSO client, a git login
const creds = {
  "hook-token": { name: "hook-token", credential_type: "api" },
  "rte-token": { name: "rte-token", credential_type: "rte" },
  "sso-client": { name: "sso-client", credential_type: "oidc", user: "client-id", password: "enc" },
  "git-bot": { name: "git-bot", credential_type: "git", user: "bot", password: "enc" },
  "db-login": { name: "db-login", credential_type: "database", user: "deploy", password: "enc" },
  "git-nopass": { name: "git-nopass", credential_type: "git", user: "bot", password: "" },
  "vaulted": { name: "vaulted", credential_type: "userpass", user: "bot", password: null, secret_store: "vault", secret_ref: "git/bot" },
  "runner-login": { name: "runner-login", credential_type: "userpass", user: "runner", password: "enc" },
  // a git credential signing in with a token keeps no user (git sends GIT_TOKEN_USER with it)
  "git-token": { name: "git-token", credential_type: "git", user: "", password: "enc" },
  // one saved with Write to a secret store : the row keeps the reference, its user and password
  // are in the store
  "store-written": { name: "store-written", credential_type: "git", user: "", password: "", secret_store: "vault", secret_ref: "git/bot" },
  // mail logins : one holding its server, one from before credentials held it (the channel's own)
  "mail-host": { name: "mail-host", credential_type: "smtp", host: "smtp.corp.local", user: "mailer", password: "enc" },
  "mail-nohost": { name: "mail-nohost", credential_type: "smtp", host: "", user: "mailer", password: "enc" },
};
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    findRowByName: async (name) => creds[name] || null,
    async isAdminGuarded(record) {
      if (!record) return false;
      return ["rte", "oidc", "ldap", "entraid"].includes(record.credential_type) || record.name === "runner-login";
    },
    async firstAdminGuarded(names) {
      for (const n of names.filter(Boolean)) if (await this.isAdminGuarded(creds[n])) return n;
      return null;
    },
  },
}));

// the channels there are, and what the model was asked to write
const writes = [];
const channels = {
  1: { id: 1, name: "hook", type: "webhook", url: "https://hooks.local/x", verify_tls: 1, token_credential: "hook-token" },
  2: { id: 2, name: "bot", type: "telegram", api_url: "", token_credential: "hook-token", chat_id: "1" },
  // a mail channel of a credential with its server, its own server left from before
  3: { id: 3, name: "mail", type: "mail", credential: "mail-host", server: "old.corp.local", port: 25, secure: 0 },
  // a mail channel of a credential without a server : its own is where it sends
  4: { id: 4, name: "old-mail", type: "mail", credential: "mail-nohost", server: "relay.corp.local", port: 25, secure: 0 },
};
vi.mock("../src/models/notificationChannel.model.js", () => ({
  default: {
    findById: async (id) => (channels[id] ? { ...channels[id] } : null),
    credentialType: async (name) => creds[name]?.credential_type || null,
    credentialServer: async (name) => (creds[name]?.host ? { server: creds[name].host, port: null, secure: 0 } : null),
    create: async (data) => { writes.push(["create", { ...data }]); return 5; },
    update: async (data, id) => { writes.push(["update", { ...data }, id]); return true; },
  },
}));
vi.mock("../src/lib/notifiers.js", () => ({ send: async () => "id" }));

// the repositories there are
const repos = {
  infra: { id: 1, name: "infra", uri: "https://git.local/infra.git", credential: "git-bot", password: "" },
  legacy: { id: 2, name: "legacy", uri: "https://git.local/legacy.git", credential: null, user: "me", password: "stored" },
};
const repoWrites = [];
vi.mock("../src/models/repository.model.js", () => ({
  default: {
    findByName: async (name) => ({ ...repos[name] }),
    create: async (data) => { repoWrites.push(["create", { ...data }]); return 3; },
    update: async (data, name, opts) => { repoWrites.push(["update", { ...data }, name, opts]); return true; },
  },
}));
vi.mock("../src/services/cron.service.js", () => ({ default: { addRepository() {}, removeRepository() {} } }));

const { default: channelController } = await import("../src/controllers/v2/notificationChannel.controller.js");
const { default: repoController } = await import("../src/controllers/v2/repository.controller.js");

function call(handler, user, { body = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; },
    };
    handler({ body, params, query: {}, headers: {}, user: { user } }, res);
  });
}

const ops = { username: "ops", roles: ["ops"], options: { showConnectionsSettings: true } };
const admin = { username: "admin", roles: ["admin"] };

beforeEach(() => { writes.length = 0; repoWrites.length = 0; });

describe("a notification channel", () => {
  test("naming a runner's token or an SSO client: refused to a connections user", async () => {
    expect((await call(channelController.create, ops, { body: { name: "x", type: "webhook", url: "https://evil", token_credential: "rte-token" } })).status).toBe(403);
    expect((await call(channelController.update, ops, { body: { token_credential: "sso-client" }, params: { id: "1" } })).status).toBe(403);
    expect(writes).toEqual([]);
  });

  test("an admin may name them", async () => {
    expect((await call(channelController.create, admin, { body: { name: "x", type: "webhook", url: "https://a", token_credential: "rte-token" } })).status).toBeLessThan(300);
  });

  test("an open credential stays usable", async () => {
    expect((await call(channelController.create, ops, { body: { name: "x", type: "webhook", url: "https://a", token_credential: "hook-token" } })).status).toBeLessThan(300);
  });

  test("moved to another url by a connections user: the credential it keeps is dropped", async () => {
    await call(channelController.update, ops, { body: { url: "https://evil", token_credential: "hook-token" }, params: { id: "1" } });
    expect(writes[0][1].token_credential).toBe("");
  });

  test("the certificate check turned off counts as a move", async () => {
    await call(channelController.update, ops, { body: { verify_tls: 0 }, params: { id: "1" } });
    expect(writes[0][1].token_credential).toBe("");
  });

  test("a telegram bot moved to another API address drops its token too", async () => {
    await call(channelController.update, ops, { body: { api_url: "https://evil" }, params: { id: "2" } });
    expect(writes[0][1].token_credential).toBe("");
  });

  test("the same url keeps it ; an admin's move keeps it", async () => {
    await call(channelController.update, ops, { body: { url: "https://hooks.local/x ", token_credential: "hook-token" }, params: { id: "1" } });
    await call(channelController.update, admin, { body: { url: "https://new", token_credential: "hook-token" }, params: { id: "1" } });
    expect(writes.map((w) => w[1].token_credential)).toEqual(["hook-token", "hook-token"]);
  });
});

describe("a mail channel", () => {
  test("its credential holding the server : the own server sent empty (its page's save) keeps the credential", async () => {
    const body = { description: "changed", credential: "mail-host", server: "", port: "", secure: 0 };
    expect((await call(channelController.update, ops, { body, params: { id: "3" } })).status).toBeLessThan(300);
    expect(writes[0][1].credential).toBe("mail-host");
  });

  test("its credential holding the server : another own server moves nothing, the mail goes to the credential's", async () => {
    await call(channelController.update, ops, { body: { server: "evil.example.com", port: 2525 }, params: { id: "3" } });
    expect(writes[0][1].credential).toBe(undefined);
  });

  test("its credential without a server : its own server saved as it is keeps the credential", async () => {
    const body = { description: "changed", credential: "mail-nohost", server: "relay.corp.local", port: 25, secure: 0 };
    await call(channelController.update, ops, { body, params: { id: "4" } });
    expect(writes[0][1].credential).toBe("mail-nohost");
  });

  test("its credential without a server : another own server is a move, the credential is dropped", async () => {
    await call(channelController.update, ops, { body: { server: "evil.example.com" }, params: { id: "4" } });
    expect(writes[0][1].credential).toBe("");
    // an admin's keeps it
    writes.length = 0;
    await call(channelController.update, admin, { body: { server: "evil.example.com" }, params: { id: "4" } });
    expect(writes[0][1].credential).toBe(undefined);
  });
});

describe("a repository", () => {
  test("takes a git or a userpass credential only, whoever saves it", async () => {
    const r = await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "hook-token" } });
    expect(r.status).toBe(400);
    expect((await call(repoController.update, admin, { body: { credential: "rte-token" }, params: { name: "infra" } })).status).toBe(400);
    expect(repoWrites).toEqual([]);
  });

  test("any credential with a user and a password, whatever its type ; one without : 400", async () => {
    // an admin's database login, a secret store's password : a login git can use
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "db-login" } })).status).toBeLessThan(300);
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "vaulted" } })).status).toBeLessThan(300);
    expect((await call(repoController.update, ops, { body: { credential: "db-login" }, params: { name: "infra" } })).status).toBeLessThan(300);
    // a git credential without its password
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "git-nopass" } })).status).toBe(400);
  });

  test("a token without a user, or a login written to a secret store: taken", async () => {
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "git-token" } })).status).toBeLessThan(300);
    expect((await call(repoController.update, ops, { body: { credential: "git-token" }, params: { name: "infra" } })).status).toBeLessThan(300);
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "store-written" } })).status).toBeLessThan(300);
    expect(repoWrites.map((w) => w[1].credential)).toEqual(["git-token", "git-token", "store-written"]);
  });

  test("a sign-in's client, user and password though it has : refused to a connections user", async () => {
    expect((await call(repoController.update, ops, { body: { credential: "sso-client" }, params: { name: "infra" } })).status).toBe(403);
  });

  test("a credential that does not exist: 400", async () => {
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "nope" } })).status).toBe(400);
  });

  test("a userpass credential a runner names: refused to a connections user", async () => {
    expect((await call(repoController.update, ops, { body: { credential: "runner-login" }, params: { name: "infra" } })).status).toBe(403);
    expect((await call(repoController.create, admin, { body: { name: "r", uri: "https://git", credential: "runner-login" } })).status).toBeLessThan(300);
  });

  test("moved to another address by a connections user: refused, nothing written", async () => {
    // the address is an admin's since 7.3 (assertRepositoryAdminFields) : the move that would
    // have dropped the credential and the password is not made at all
    const r = await call(repoController.update, ops, { body: { uri: "https://evil/x.git", credential: "git-bot" }, params: { name: "infra" } });
    expect(r.status).toBe(403);
    expect((await call(repoController.update, ops, { body: { uri: "https://evil/x.git", password: "typed" }, params: { name: "legacy" } })).status).toBe(403);
    expect(repoWrites).toEqual([]);
  });

  test("an admin's move keeps both", async () => {
    await call(repoController.update, admin, { body: { uri: "https://new/x.git", credential: "git-bot" }, params: { name: "infra" } });
    expect(repoWrites[0][1].credential).toBe("git-bot");
    expect(repoWrites[0][3]).toEqual({ dropPassword: false });
  });
});
