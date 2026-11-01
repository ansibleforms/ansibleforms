// The Groups and Users types on the engine (lib/repoObjects/groups.js, users.js) : the local groups
// holding their members, and the users - local ones and those of a directory - in one list, found
// by their type and username. On the shared fixture :
//   groups     a pull makes a group and puts the listed local users in it ; a user left out is taken
//              out (never out of its only group) ; the built-in admin never moves ; the admins
//              group is never deleted ; an edit in the app is written back, members included
//   users      a new local user takes the groups whose entries list it (the first by name its first
//              group), its password hashed from its ${ENV} reference ; one no group lists is
//              refused ; a local and an LDAP user of one username are two users ; a directory
//              user's entry makes its row (blocked before its first sign-in), its removal deletes it ;
//              the built-in admin, and what a directory user may not say, are refused
//   activation the local users written without their password ; a directory user only when the
//              app holds something of it
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repo }));
vi.mock("../src/models/repository.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).repository }));
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

// what a save tells the rest of the app : nothing here
vi.mock("../src/lib/liveEvents.js", () => ({ publish: () => {} }));

const fx = await import("./fixtures/repoObjects.mjs");
const { default: RepoObjects } = await import("../src/lib/repoObjects/index.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");

const { default: GroupController } = await import("../src/controllers/v2/group.controller.js");
const { default: UserController } = await import("../src/controllers/v2/user.controller.js");

/**
 * Calls a controller as a request of the admin would.
 *
 * Args:
 *   handler (function): the controller's function.
 *   req (object): { body, params }.
 *
 * Returns:
 *   Promise<object>: { status, data }.
 */
function asAdmin(handler, { body = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(data) {
        resolve({ status: this.statusCode, data });
        return this;
      },
    };
    handler({ body, params, headers: {}, query: {}, user: { user: { username: "admin", type: "local", roles: ["admin"], options: { showSettings: true } } } }, res);
  });
}

// one repository holds both types, as an Access repository would
const REPO = "access-repo";
const groupsDesc = () => RepoObjects.descriptorOf("groups");
const usersDesc = () => RepoObjects.descriptorOf("users");

/**
 * Pulls the repository's groups then its users, as a pull reads them (APPLY_ORDER).
 *
 * Returns:
 *   Promise<object>: { groups, users } - each type's summary.
 */
async function pullBoth() {
  const groups = await RepoObjects.syncRepository(await groupsDesc(), REPO);
  const users = await RepoObjects.syncRepository(await usersDesc(), REPO);
  return { groups, users };
}

// the local users' groups, by username : their first group's name first
function groupsOf(username) {
  const user = fx.state.tables.users.find((u) => u.username === username);
  if (!user) return undefined;
  const name = (id) => fx.state.tables.groups.find((g) => g.id === Number(id))?.name;
  const others = fx.state.tables.user_groups.filter((l) => l.user_id === user.id).map((l) => name(l.group_id));
  return [name(user.group_id), ...others.sort()];
}

beforeEach(() => {
  process.env.BOB_PASSWORD = "s3cret-Bob!";
  fx.reset({
    repositories: [{ id: 1, name: REPO, uri: "https://git/x.git", use_for_groups: 1, use_for_users: 1 }],
    groups: [
      { id: 1, name: "admins", description: "" },
      { id: 2, name: "ops", description: "" },
    ],
    // the built-in admin, in the admins group
    users: [{ id: 1, username: "admin", password: "x", email: "", description: "", group_id: 1, blocked: 0 }],
  });
  CrudModel.flushAllLocal();
});

describe("groups", () => {
  test("a pull makes a group and puts the local users it lists in it, the admin left alone", async () => {
    fx.state.tables.users.push({ id: 2, username: "alice", password: "x", email: "a@x", description: "", group_id: 2, blocked: 0 });
    fx.writeEntry(REPO, "access/groups.yaml", "groups", [
      { name: "vmware", description: "The VMware team", users: ["alice"] },
      { name: "admins", users: [] },
    ]);
    const summary = await RepoObjects.syncRepository(await groupsDesc(), REPO);
    assert.deepEqual(summary.refused, []);
    const vmware = fx.rowNamed("groups", "vmware");
    assert.equal(vmware.repository, REPO);
    assert.equal(vmware.repo_file, "access/groups.yaml");
    assert.deepEqual(groupsOf("alice"), ["ops", "vmware"]);
    // admins lists nobody : the built-in admin stays in it
    assert.deepEqual(groupsOf("admin"), ["admins"]);
  });

  test("a user its entry no longer lists leaves the group, never its only one", async () => {
    fx.state.tables.users.push({ id: 2, username: "alice", password: "x", email: "a@x", description: "", group_id: 2, blocked: 0 });
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: ["alice"] }, { name: "vmware", users: ["alice"] }]);
    await RepoObjects.syncRepository(await groupsDesc(), REPO);
    assert.deepEqual(groupsOf("alice"), ["ops", "vmware"]);
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: [] }, { name: "vmware", users: ["alice"] }]);
    await RepoObjects.syncRepository(await groupsDesc(), REPO);
    assert.deepEqual(groupsOf("alice"), ["vmware"]);
    // vmware is her only group now : it keeps her
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: [] }, { name: "vmware", users: [] }]);
    await RepoObjects.syncRepository(await groupsDesc(), REPO);
    assert.deepEqual(groupsOf("alice"), ["vmware"]);
  });

  test("the admins group is never deleted, its entry removed refused", async () => {
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "admins" }, { name: "ops" }]);
    await RepoObjects.syncRepository(await groupsDesc(), REPO);
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops" }]);
    const summary = await RepoObjects.syncRepository(await groupsDesc(), REPO);
    assert.ok(fx.rowNamed("groups", "admins"), "the admins group stays");
    assert.ok(JSON.stringify(summary).includes("the admins group is never deleted"), JSON.stringify(summary));
  });

  test("activation writes the app's groups with their members, the admin never", async () => {
    fx.state.tables.users.push({ id: 2, username: "bob", password: "x", email: "b@x", description: "", group_id: 2, blocked: 0 });
    const report = await RepoObjects.activate(await groupsDesc(), REPO);
    assert.equal(report.file, "groups.yaml");
    assert.deepEqual(fx.readEntry(REPO, "groups.yaml", "groups", "ops"), { name: "ops", users: ["bob"] });
    assert.equal(fx.readEntry(REPO, "groups.yaml", "groups", "admins").users, undefined);
  });
});

describe("users", () => {
  test("a new local user takes the groups whose entries list it, its password hashed from the environment", async () => {
    fx.writeEntry(REPO, "groups.yaml", "groups", [
      { name: "ops", users: ["bob"] },
      { name: "vmware", users: ["bob"] },
    ]);
    fx.writeEntry(REPO, "users.yaml", "users", [{ username: "bob", email: "bob@example.com", password: "${BOB_PASSWORD}" }]);
    const { groups, users } = await pullBoth();
    assert.deepEqual([...groups.refused, ...users.refused], []);
    const bob = fx.state.tables.users.find((u) => u.username === "bob");
    assert.equal(bob.email, "bob@example.com");
    assert.equal(bob.repository, REPO);
    assert.ok(bcrypt.compareSync("s3cret-Bob!", bob.password), "its password is the variable's, hashed");
    // ops before vmware : its first group
    assert.deepEqual(groupsOf("bob"), ["ops", "vmware"]);
    // pulled again, nothing changed : the password compared with its hash
    const again = await RepoObjects.syncRepository(await usersDesc(), REPO);
    assert.equal(again.updated, 0);
  });

  test("a password changed in the environment is git's change : the user's hash follows it", async () => {
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: ["bob"] }]);
    fx.writeEntry(REPO, "users.yaml", "users", [{ username: "bob", password: "${BOB_PASSWORD}" }]);
    await pullBoth();
    process.env.BOB_PASSWORD = "n3w-Secret-Bob!";
    const summary = await RepoObjects.syncRepository(await usersDesc(), REPO);
    assert.deepEqual(summary.refused, []);
    assert.equal(summary.updated, 1);
    const bob = fx.state.tables.users.find((u) => u.username === "bob");
    assert.ok(bcrypt.compareSync("n3w-Secret-Bob!", bob.password));
  });

  test("a local user no group lists is refused", async () => {
    fx.writeEntry(REPO, "users.yaml", "users", [{ username: "carol", email: "c@x" }]);
    const summary = await RepoObjects.syncRepository(await usersDesc(), REPO);
    assert.equal(fx.state.tables.users.some((u) => u.username === "carol"), false);
    assert.ok(JSON.stringify(summary.refused).includes("no group lists 'carol'"), JSON.stringify(summary.refused));
  });

  test("a local and an LDAP user of one username are two users ; a directory user's entry makes its row", async () => {
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: ["jdoe"] }]);
    fx.writeEntry(REPO, "users.yaml", "users", [
      { username: "jdoe", email: "jdoe@local" },
      { username: "jdoe", type: "ldap", blocked: true, description: "Left the company" },
      { username: "mary@example.com", type: "entraid" },
    ]);
    const { groups, users } = await pullBoth();
    assert.deepEqual([...groups.refused, ...users.refused], []);
    assert.ok(fx.state.tables.users.find((u) => u.username === "jdoe"));
    const ldap = fx.state.tables.directory_users.find((u) => u.type === "ldap" && u.username === "jdoe");
    assert.equal(Number(ldap.blocked), 1);
    assert.equal(ldap.description, "Left the company");
    assert.equal(ldap.repository, REPO);
    // Entra ID : entraid in its file, azuread stored
    assert.ok(fx.state.tables.directory_users.find((u) => u.type === "azuread" && u.username === "mary@example.com"));
    // its entry removed : its row goes, blocked or not
    fx.writeEntry(REPO, "users.yaml", "users", [{ username: "jdoe", email: "jdoe@local" }]);
    await RepoObjects.syncRepository(await usersDesc(), REPO);
    assert.equal(fx.state.tables.directory_users.length, 0);
    assert.ok(fx.state.tables.users.find((u) => u.username === "jdoe"), "the local jdoe stays");
  });

  test("the built-in admin, and a directory user's email or password, are refused", async () => {
    fx.writeEntry(REPO, "users.yaml", "users", [
      { username: "admin", email: "root@x" },
      { username: "jdoe", type: "ldap", email: "jdoe@corp" },
    ]);
    const summary = await RepoObjects.syncRepository(await usersDesc(), REPO);
    const said = JSON.stringify(summary.refused);
    assert.ok(said.includes("the built-in admin user is never read"), said);
    assert.ok(said.includes("come from its directory"), said);
    assert.equal(fx.state.tables.directory_users.length, 0);
  });

  test("a plain password is refused : an ${ENV} reference only", async () => {
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: ["bob"] }]);
    fx.writeEntry(REPO, "users.yaml", "users", [{ username: "bob", password: "plain" }]);
    const { users } = await pullBoth();
    assert.ok(JSON.stringify(users.refused).includes("must be an ${ENV} reference"), JSON.stringify(users.refused));
  });

  test("activation writes the local users without their password, a directory user only when the app holds something of it", async () => {
    fx.state.tables.users.push({ id: 2, username: "alice", password: "hash", email: "a@x", description: "Lead", group_id: 2, blocked: 0 });
    fx.state.tables.directory_users.push(
      { id: 7, type: "ldap", username: "seen-only", blocked: 0, description: null },
      { id: 8, type: "azuread", username: "gone@corp", blocked: 1, description: null },
    );
    const report = await RepoObjects.activate(await usersDesc(), REPO);
    assert.equal(report.file, "users.yaml");
    const entries = fx.readEntry(REPO, "users.yaml", "users");
    assert.deepEqual(entries.find((e) => e.username === "alice"), { username: "alice", email: "a@x", description: "Lead" });
    assert.deepEqual(entries.find((e) => e.username === "gone@corp"), { username: "gone@corp", type: "entraid", blocked: true });
    assert.equal(entries.some((e) => e.username === "seen-only"), false);
    assert.equal(entries.some((e) => e.username === "admin"), false);
  });
});

describe("saves in the app, written back", () => {
  test("a group's description edited in the app : its entry rewritten, its members kept", async () => {
    fx.state.tables.users.push({ id: 2, username: "alice", password: "x", email: "a@x", description: "", group_id: 2, blocked: 0 });
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: ["alice"] }]);
    await RepoObjects.syncRepository(await groupsDesc(), REPO);
    const ops = fx.rowNamed("groups", "ops");
    const res = await asAdmin(GroupController.update, { body: { description: "Operations" }, params: { id: ops.id } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(fx.readEntry(REPO, "groups.yaml", "groups", "ops"), { name: "ops", description: "Operations", users: ["alice"] });
  });

  test("a user put in a group in the app : the group's entry lists it", async () => {
    fx.state.tables.groups.push({ id: 3, name: "vmware", description: "" });
    fx.state.tables.users.push({ id: 2, username: "alice", password: "x", email: "a@x", description: "", group_id: 2, blocked: 0 });
    fx.writeEntry(REPO, "groups.yaml", "groups", [{ name: "ops", users: ["alice"] }, { name: "vmware" }]);
    await RepoObjects.syncRepository(await groupsDesc(), REPO);
    const res = await asAdmin(UserController.addGroup, { body: { group_id: 3 }, params: { id: 2 } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(fx.readEntry(REPO, "groups.yaml", "groups", "vmware"), { name: "vmware", users: ["alice"] });
  });
});
