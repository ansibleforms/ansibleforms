// The form names a stored job is made of (GET /api/v2/config/formnames, issue #1329) : a user who
// may only store jobs is let in and gets the forms their roles open ; a user of the settings or
// the schedules gets every form, as before ; subforms never.
import { test, describe, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

// every form, or those the roles open
const loads = [];
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: async (roles, name, full) => {
      loads.push({ roles, full: !!full });
      const all = [{ name: "Mine" }, { name: "Theirs" }, { name: "Sub", type: "subform" }];
      return { forms: roles ? all.filter((f) => f.name !== "Theirs") : all };
    },
  },
}));

const { default: configController } = await import("../src/controllers/v2/config.controller.js");
const { default: Middleware } = await import("../src/lib/middleware.js");

/**
 * Runs the form names endpoint as a user.
 *
 * Args:
 *   options (object): the user's role options.
 *
 * Returns:
 *   Promise<string[]>: the names answered.
 */
async function namesFor(options) {
  let body;
  const res = { json: (b) => (body = b), status() { return this; } };
  await configController.formNames({ user: { user: { username: "u", roles: ["users"], options } } }, res);
  return (body?.data?.output || body?.records || body?.data || []).map((f) => f.name);
}

/**
 * Whether the route's guard lets a user through.
 *
 * Args:
 *   options (object): the user's role options.
 *
 * Returns:
 *   boolean: true when next() was called.
 */
function guardLets(options) {
  let passed = false;
  const res = { status() { return this; }, json() {} };
  Middleware.checkFormNamesMiddleware({ user: { user: { options } } }, res, () => (passed = true));
  return passed;
}

beforeEach(() => (loads.length = 0));

describe("the form names of the stored jobs page", () => {
  test("a user who may only store jobs is let in ; one who may do none of it is not", () => {
    assert.equal(guardLets({ allowStoredJobs: true }), true);
    assert.equal(guardLets({ allowScheduledJobs: true }), true);
    assert.equal(guardLets({ showSettings: true }), true);
    assert.equal(guardLets({ showJobs: true }), false);
  });

  test("stored jobs only : the forms of their roles, no subform", async () => {
    assert.deepEqual(await namesFor({ allowStoredJobs: true }), ["Mine"]);
    assert.deepEqual(loads[0].roles, ["users"]);
  });

  test("settings or schedules : every form, as before, no subform", async () => {
    assert.deepEqual(await namesFor({ allowScheduledJobs: true, allowStoredJobs: true }), ["Mine", "Theirs"]);
    assert.equal(loads[0].roles, undefined);
    assert.deepEqual(await namesFor({ showSettings: true }), ["Mine", "Theirs"]);
  });
});
