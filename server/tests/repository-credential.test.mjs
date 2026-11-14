// A repository can use a credential of Connections > Credentials instead of its own user and
// password. Repository.withCredential puts that credential's user and password on the record
// git uses - and only there : the record the API returns keeps the repository's own fields.
// These pin what it resolves, how it looks the credential up, and that a missing one fails.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/repo.model.js", () => ({ default: {} }));
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => ({ affectedRows: 1 }) } }));
vi.mock("../src/models/crud.model.js", () => {
  class CrudModel {
    static getCache() { return null; }
  }
  return { default: CrudModel };
});

// the lookups withCredential made, and what the credential store answers
const lookups = [];
let stored = { user: "git-bot", password: "s3cret-token" };
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    resolveCredential: async (regex) => {
      lookups.push(regex);
      if (stored === null) throw new Error("No credential found");
      return { ...stored };
    },
    // the exact name, escaped into an anchored pattern, as the model does
    resolveByName(name) {
      return this.resolveCredential("^" + String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
    },
  },
}));

const { default: Repository, GIT_TOKEN_USER } = await import("../src/models/repository.model.js");

beforeEach(() => {
  lookups.length = 0;
  stored = { user: "git-bot", password: "s3cret-token" };
});

describe("Repository.withCredential", () => {
  test("uses the named credential's user and password", async () => {
    const repo = { name: "infra", uri: "https://git.example.com/infra.git", user: "", password: "", credential: "git.bot" };
    const out = await Repository.withCredential(repo);
    assert.equal(out.user, "git-bot");
    assert.equal(out.password, "s3cret-token");
    // a copy : the record itself (what the API may still return) keeps its own fields
    assert.equal(repo.user, "");
    assert.equal(repo.password, "");
  });

  test("looks the credential up by its exact name, regex characters escaped", async () => {
    await Repository.withCredential({ name: "infra", credential: "git.bot(1)" });
    assert.deepEqual(lookups, ["^git\\.bot\\(1\\)$"]);
  });

  test("leaves a repository without a credential as it is", async () => {
    const repo = { name: "infra", user: "me", password: "pw" };
    assert.equal(await Repository.withCredential(repo), repo);
    assert.equal(lookups.length, 0);
  });

  test("fails when the credential does not exist", async () => {
    stored = null;
    await assert.rejects(Repository.withCredential({ name: "infra", credential: "gone" }));
  });

  test("a token without a user : git sends the token user with it", async () => {
    stored = { user: "", password: "ghp_token" };
    const out = await Repository.withCredential({ name: "infra", credential: "token" });
    assert.equal(out.user, GIT_TOKEN_USER);
    assert.equal(out.user, "oauth2");
    assert.equal(out.password, "ghp_token");
  });

  test("fails when the credential has neither a user nor a password", async () => {
    stored = { user: "", password: "" };
    await assert.rejects(Repository.withCredential({ name: "infra", credential: "half" }), /not found/);
  });

  test("git signs in with the credential, never through the address", async () => {
    const out = await Repository.withCredential({ name: "infra", uri: "https://git.example.com/infra.git", credential: "git.bot" });
    assert.deepEqual(Repository.gitAuth(out), { user: "git-bot", password: "s3cret-token" });
    assert.equal(out.uri, "https://git.example.com/infra.git", "the address git is given carries no user or token");
  });

  test("over ssh, or without a user and token, git is given none", () => {
    assert.equal(Repository.gitAuth({ uri: "git@github.com:org/infra.git", user: "u", password: "p" }), null);
    assert.equal(Repository.gitAuth({ uri: "https://git.example.com/infra.git" }), null);
  });
});
