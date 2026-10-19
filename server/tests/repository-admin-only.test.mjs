// A repository marked use_for_config, use_for_forms or use_for_playbooks (or workflows,
// inventories) is pulled into the configuration, the forms and the playbooks AnsibleForms runs. A
// user with only connections access (showConnectionsSettings without the admin role) who could add
// one, point one at their own git server, or mark one of theirs so, would write the roles (and make
// themselves admin) or the code the runners execute. These pin the rule : adding or deleting a
// repository, changing its address, its branch or a use_for_* flag is an admin's ; its description,
// schedule, and pulling, pushing or resetting it stay open to a connections user.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ---------------------------------------------------------------------------------------------
// The repositories there are, and what the model was asked to do
// ---------------------------------------------------------------------------------------------

const repos = {
  forms: { id: 1, name: "forms", uri: "https://git.local/forms.git", branch: "main", description: "", cron: null,
    use_for_forms: 1, use_for_config: 0, use_for_playbooks: 0, use_for_workflows: 0, use_for_inventories: 0, credential: null, password: "" },
};
const calls = [];
vi.mock("../src/models/repository.model.js", () => ({
  default: {
    // a repository just added reads back with its name and no schedule
    findByName: async (name) => (repos[name] ? { ...repos[name] } : { name, cron: null }),
    withUnpushed: async (list) => list,
    create: async (data) => { calls.push(["create", { ...data }]); return 3; },
    update: async (data, name) => { calls.push(["update", { ...data }, name]); return true; },
    delete: async (name) => { calls.push(["delete", name]); return true; },
    pull: async (name) => { calls.push(["pull", name]); },
    reset: async (name) => { calls.push(["reset", name]); },
    sync: async (name) => { calls.push(["sync", name]); return "pushed"; },
  },
}));
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: { findRowByName: async () => null, isAdminGuarded: async () => false },
}));
vi.mock("../src/services/cron.service.js", () => ({ default: { addRepository() {}, removeRepository() {} } }));

const { default: controller } = await import("../src/controllers/v2/repository.controller.js");

/**
 * Calls a controller handler as the given user, and answers what it sent.
 *
 * Args:
 *   handler (Function): the controller's handler.
 *   user (object): the signed-in user (its roles).
 *   opts (object): { body, params } of the request.
 *
 * Returns:
 *   Promise<{status: number, data: object}>: the answer.
 */
function call(handler, user, { body = {}, params = { name: "forms" } } = {}) {
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

beforeEach(() => { calls.length = 0; });

// ---------------------------------------------------------------------------------------------
// A connections user
// ---------------------------------------------------------------------------------------------

describe("a connections user", () => {
  test("may not add a repository, whatever it is used for", async () => {
    for (const flags of [{ use_for_config: 1 }, { use_for_forms: 1 }, { use_for_playbooks: 1 }, {}]) {
      const r = await call(controller.create, ops, { body: { name: "evil", uri: "https://evil/x.git", branch: "main", ...flags } });
      expect(r.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("may not delete one", async () => {
    expect((await call(controller.delete, ops)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test.each([
    ["its address", { uri: "https://evil/forms.git" }],
    ["its branch", { branch: "evil" }],
    ["use_for_config on", { use_for_config: true }],
    ["use_for_playbooks on", { use_for_playbooks: "1" }],
    ["use_for_inventories on", { use_for_inventories: 1 }],
    ["use_for_workflows on", { use_for_workflows: true }],
    // its schedules run as the Schedule Service, with the admin role
    ["use_for_schedules on", { use_for_schedules: 1 }],
    ["use_for_forms off", { use_for_forms: false }],
  ])("may not change %s", async (_label, body) => {
    expect((await call(controller.update, ops, { body })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("may save it with those fields sent back unchanged, and change its description", async () => {
    const body = { ...repos.forms, uri: " https://git.local/forms.git ", use_for_forms: true, use_for_config: false, description: "ours" };
    const r = await call(controller.update, ops, { body });
    expect(r.status).toBeLessThan(300);
    expect(calls[0][0]).toBe("update");
    expect(calls[0][1].description).toBe("ours");
  });

  test("may still pull, reset and push it", async () => {
    expect((await call(controller.pull, ops)).status).toBeLessThan(300);
    expect((await call(controller.reset, ops)).status).toBeLessThan(300);
    expect((await call(controller.sync, ops)).status).toBeLessThan(300);
    expect(calls.map((c) => c[0])).toEqual(["pull", "reset", "sync"]);
  });
});

// ---------------------------------------------------------------------------------------------
// An admin
// ---------------------------------------------------------------------------------------------

describe("an admin", () => {
  test("may add, change and delete one", async () => {
    expect((await call(controller.create, admin, { body: { name: "cfg", uri: "https://git/cfg.git", branch: "main", use_for_config: 1 } })).status).toBeLessThan(300);
    expect((await call(controller.update, admin, { body: { uri: "https://git/new.git", branch: "dev", use_for_config: 1 } })).status).toBeLessThan(300);
    expect((await call(controller.delete, admin)).status).toBeLessThan(300);
    expect(calls.map((c) => c[0])).toEqual(["create", "update", "delete"]);
  });
});
