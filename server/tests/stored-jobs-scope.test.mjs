// The stored jobs api : who sees which stored job.
//
// A stored job holds the field values a user saved for a form, so it belongs to that user.
// allowStoredJobs is on for every user by default, which makes the scope of each route the
// only thing between one user and another user's values. The per-id routes (read, update,
// delete) always checked ownership, but the plain list (the stored jobs page) returned
// every row of every user. These tests pin one rule across all of them : a settings user
// (showSettings) manages everyone's, any other user only their own.
import { test, describe, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";

// i18n reaches the locale files; keep it out of the way and make the key visible
vi.mock("../src/lib/i18n.js", () => ({
  default: { t: (_req, key) => key },
}));

// the rows live in this array instead of the database
let rows = [];
vi.mock("../src/models/crud.model.js", () => ({
  default: {
    findAll: vi.fn(async () => rows.map(r => ({ ...r }))),
    findById: vi.fn(async (_model, id) => {
      const row = rows.find(r => String(r.id) === String(id));
      if (!row) {
        const err = new Error(`No record found with id ${id}`);
        err.statusCode = 404;
        throw err;
      }
      return { ...row };
    }),
    create: vi.fn(async () => 99),
    update: vi.fn(async () => true),
    delete: vi.fn(async () => true),
  },
}));

// the forms a user may open : Demo and Other share, Locked turns sharing off, Hidden is no one's
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: vi.fn(async (_roles, name) => ({
      forms: name === "Hidden" ? [] : [{ name, ...(name === "Locked" ? { allowStoredJobSharing: false } : {}) }],
    })),
  },
}));

const CrudModel = (await import("../src/models/crud.model.js")).default;
const controller = (await import("../src/controllers/v2/stored-jobs.controller.js")).default;

// Minimal express-shaped double; `status()` must be chainable
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// a logged in user as the auth middleware leaves it on req.user
const user = (username, options = {}) => ({
  user: { type: "local", username, options: { allowStoredJobs: true, ...options } },
});

async function call(handler, who, { params = {}, query = {}, body = {} } = {}) {
  const res = makeRes();
  await controller[handler]({ user: who, params, query, body }, res);
  return res;
}

const alice = user("alice");
const bob = user("bob");
const admin = user("admin", { showSettings: true });

beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    { id: 1, name: "a1", form_name: "Demo", username: "local/alice", form_data: '{"key":"alice-value"}' },
    { id: 2, name: "b1", form_name: "Demo", username: "local/bob", form_data: '{"key":"bob-value"}' },
    { id: 3, name: "a2", form_name: "Other", username: "local/alice", form_data: '{"key":"alice-other"}' },
  ];
});

describe("the stored jobs list", () => {
  test("a user without settings only gets their own stored jobs", async () => {
    const res = await call("find", bob);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.records.map(r => r.id), [2]);
    assert.ok(!JSON.stringify(res.body).includes("alice-value"), "another user's values must not be listed");
  });

  test("a user with no stored jobs gets an empty list, not everyone's", async () => {
    const res = await call("find", user("carol"));
    assert.deepEqual(res.body.records, []);
  });

  test("the same username from another login type is another user", async () => {
    const ldapAlice = { user: { type: "ldap", username: "alice", options: { allowStoredJobs: true } } };
    const res = await call("find", ldapAlice);
    assert.deepEqual(res.body.records, []);
  });

  test("a settings user still gets every stored job", async () => {
    const res = await call("find", admin);
    assert.deepEqual(res.body.records.map(r => r.id), [1, 2, 3]);
  });

  test("the form filter only gives the caller's own, even for a settings user", async () => {
    const res = await call("find", alice, { query: { form_name: "Demo" } });
    assert.deepEqual(res.body.records.map(r => r.id), [1]);
    const resAdmin = await call("find", admin, { query: { form_name: "Demo" } });
    assert.deepEqual(resAdmin.body.records, []);
  });
});

describe("the per-id routes refuse another user's stored job", () => {
  for (const handler of ["findById", "update", "delete"]) {
    test(`${handler} answers 403 for another user's stored job`, async () => {
      const res = await call(handler, bob, { params: { id: "1" }, body: { name: "x" } });
      assert.equal(res.statusCode, 403);
      assert.ok(!JSON.stringify(res.body).includes("alice-value"));
    });

    test(`${handler} is allowed on the caller's own stored job`, async () => {
      const res = await call(handler, alice, { params: { id: "1" }, body: { name: "x" } });
      assert.equal(res.statusCode, 200);
    });

    test(`${handler} is allowed for a settings user on anyone's stored job`, async () => {
      const res = await call(handler, admin, { params: { id: "2" }, body: { name: "x" } });
      assert.equal(res.statusCode, 200);
    });
  }
});

describe("the body of a create or update only reaches the writable columns", () => {
  const body = {
    id: 2147483647, username: "local/bob", created_at: "2000-01-01T00:00:00.000Z",
    name: "n", description: "d", form_name: "Demo", form_data: "{}", expires_at: null,
  };

  test("create drops id, username and created_at, and owns the row to the caller", async () => {
    const res = await call("create", alice, { body });
    assert.equal(res.statusCode, 201);
    const [model, data] = CrudModel.create.mock.calls[0];
    assert.equal(model, "stored_jobs");
    assert.deepEqual(data, {
      name: "n", description: "d", form_name: "Demo", form_data: "{}", expires_at: null,
      username: "local/alice",
    });
  });

  test("update drops id, username and created_at", async () => {
    const res = await call("update", alice, { params: { id: "1" }, body });
    assert.equal(res.statusCode, 200);
    const [, data, id] = CrudModel.update.mock.calls[0];
    assert.equal(id, "1");
    assert.deepEqual(data, { name: "n", description: "d", form_name: "Demo", form_data: "{}", expires_at: null });
  });

  test("an update with nothing writable does not reach the database", async () => {
    const res = await call("update", alice, { params: { id: "1" }, body: { id: 5 } });
    assert.equal(res.statusCode, 200);
    assert.equal(CrudModel.update.mock.calls.length, 0);
  });
});

// #1269 : a stored job shared with other users. The owner stays its owner ; another user sees it
// with allowStoredJobsViewAll, for a form they may open that does not turn sharing off.
describe("a shared stored job", () => {
  const viewer = user("carol", { allowStoredJobsViewAll: true });
  const sharer = user("alice", { allowStoredJobsShare: true });

  beforeEach(() => {
    rows = [
      { id: 1, name: "a1", form_name: "Demo", username: "local/alice", visibility: "shared", form_data: '{"key":"alice-shared"}' },
      { id: 2, name: "a2", form_name: "Demo", username: "local/alice", visibility: "private", form_data: '{"key":"alice-private"}' },
      { id: 3, name: "c1", form_name: "Demo", username: "local/carol", visibility: "private", form_data: "{}" },
      { id: 4, name: "l1", form_name: "Locked", username: "local/alice", visibility: "shared", form_data: "{}" },
      { id: 5, name: "h1", form_name: "Hidden", username: "local/alice", visibility: "shared", form_data: "{}" },
    ];
  });

  test("the Load list gives the caller's own and the shared ones, with allowStoredJobsViewAll", async () => {
    const res = await call("find", viewer, { query: { form_name: "Demo" } });
    assert.deepEqual(res.body.records.map(r => r.id), [1, 3]);
    assert.ok(!JSON.stringify(res.body).includes("alice-private"));
  });

  test("without allowStoredJobsViewAll the Load list stays the caller's own", async () => {
    const res = await call("find", user("carol"), { query: { form_name: "Demo" } });
    assert.deepEqual(res.body.records.map(r => r.id), [3]);
  });

  test("a form that turns sharing off, or one the caller may not open, shows no shared one", async () => {
    assert.deepEqual((await call("find", viewer, { query: { form_name: "Locked" } })).body.records, []);
    assert.deepEqual((await call("find", viewer, { query: { form_name: "Hidden" } })).body.records, []);
  });

  test("the stored jobs page stays the caller's own", async () => {
    const res = await call("find", viewer);
    assert.deepEqual(res.body.records.map(r => r.id), [3]);
  });

  test("a shared one is read by id, a private one or one of a locked form is not", async () => {
    assert.equal((await call("findById", viewer, { params: { id: "1" } })).statusCode, 200);
    assert.equal((await call("findById", viewer, { params: { id: "2" } })).statusCode, 403);
    assert.equal((await call("findById", viewer, { params: { id: "4" } })).statusCode, 403);
  });

  test("a shared one is not the viewer's to change or delete", async () => {
    assert.equal((await call("update", viewer, { params: { id: "1" }, body: { name: "x" } })).statusCode, 403);
    assert.equal((await call("delete", viewer, { params: { id: "1" } })).statusCode, 403);
    assert.equal(CrudModel.update.mock.calls.length + CrudModel.delete.mock.calls.length, 0);
  });

  test("sharing needs allowStoredJobsShare", async () => {
    const body = { name: "n", form_name: "Demo", form_data: "{}", visibility: "shared" };
    assert.equal((await call("create", alice, { body })).statusCode, 403);
    assert.equal((await call("update", alice, { params: { id: "2" }, body: { visibility: "shared" } })).statusCode, 403);
    assert.equal(CrudModel.create.mock.calls.length + CrudModel.update.mock.calls.length, 0);
    const res = await call("create", sharer, { body });
    assert.equal(res.statusCode, 201);
    assert.equal(CrudModel.create.mock.calls[0][1].visibility, "shared");
    assert.equal(CrudModel.create.mock.calls[0][1].username, "local/alice");
  });

  test("a form that turns sharing off refuses a shared one", async () => {
    const res = await call("create", sharer, { body: { name: "n", form_name: "Locked", form_data: "{}", visibility: "shared" } });
    assert.equal(res.statusCode, 403);
  });

  test("a visibility other than private or shared is a 400 ; private needs no option", async () => {
    assert.equal((await call("update", alice, { params: { id: "1" }, body: { visibility: "public" } })).statusCode, 400);
    assert.equal((await call("update", alice, { params: { id: "1" }, body: { visibility: "private" } })).statusCode, 200);
  });
});
