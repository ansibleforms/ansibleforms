// A disclaimer version added over the API is numbered the next one : the number a request sends is
// never used (a disclaimer repository's file and the config seed give their own). Taken from the
// request, a copy of version 1 posted back inserted version 1 again (a duplicate, a 500) and a
// number that is not one inserted NaN.
import { test, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const created = [];
vi.mock("../src/models/disclaimer.model.js", () => ({
  default: { createVersion: async (data) => { created.push({ ...data }); return 4; } },
}));
vi.mock("../src/lib/repoObjects/index.js", () => ({ default: { following: async (_type, fn) => fn() } }));

const { default: controller } = await import("../src/controllers/v2/disclaimer.controller.js");

function call(handler, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; },
    };
    handler({ body, params: {}, query: {}, headers: {}, user: { user: { username: "admin", roles: ["admin"] } } }, res);
  });
}

test("the number a request sends is not passed on : the next one is given", async () => {
  for (const version of [1, "abc"]) {
    const r = await call(controller.createVersion, { version, title: "Terms", text: "words", checkbox_label: "I agree" });
    assert.equal(r.status, 200);
  }
  assert.deepEqual(created.map((d) => d.version), [undefined, undefined]);
  assert.equal(created[0].title, "Terms");
});
