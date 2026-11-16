// #1437 : the stored jobs API checks a stored job's own days unused (unused_days) against the
// setting (STORED_JOB_UNUSED_DAYS) on create and update, not only the Store dialog : at most the
// setting's, never none while it is above 0 ; with the setting 0 any whole number or none.
import { test, describe, vi, beforeEach, expect } from "vitest";

// i18n reaches the locale files; keep it out of the way and make the key visible
vi.mock("../src/lib/i18n.js", () => ({
  default: { t: (_req, key, values) => (values ? `${key}:${JSON.stringify(values)}` : key) },
}));

// the rows live in this array instead of the database
let rows = [];
vi.mock("../src/models/crud.model.js", () => ({
  default: {
    findAll: vi.fn(async () => rows.map((r) => ({ ...r }))),
    findById: vi.fn(async (_model, id) => ({ ...rows.find((r) => String(r.id) === String(id)) })),
    create: vi.fn(async () => 99),
    update: vi.fn(async () => true),
    delete: vi.fn(async () => true),
  },
}));
vi.mock("../src/models/form.model.js", () => ({
  default: { load: vi.fn(async (_roles, name) => ({ forms: [{ name }] })) },
}));

const CrudModel = (await import("../src/models/crud.model.js")).default;
const controller = (await import("../src/controllers/v2/stored-jobs.controller.js")).default;
// the config the controller reads (no test alias at its depth)
const appConfig = (await import("../config/app.config.js")).default;

// Minimal express-shaped double; `status()` must be chainable
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}
const alice = { user: { type: "local", username: "alice", options: { allowStoredJobs: true } } };
const job = { name: "monthly", form_name: "Demo", form_data: "{}", visibility: "private" };

/**
 * Creates a stored job with these days, under this setting.
 *
 * Args:
 *   setting (number): STORED_JOB_UNUSED_DAYS.
 *   days (any): the body's unused_days (undefined leaves it out).
 *
 * Returns:
 *   Promise<object>: the response double.
 */
async function create(setting, days) {
  appConfig.storedJobUnusedDays = setting;
  const res = makeRes();
  await controller.create({ user: alice, params: {}, query: {}, body: { ...job, ...(days !== undefined ? { unused_days: days } : {}) } }, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [{ id: 1, ...job, username: "local/alice", unused_days: 20 }];
});

describe("a stored job's own days unused", () => {
  test("with a setting : 1 to its days are stored, as a number", async () => {
    expect((await create(30, 30)).statusCode).toBe(201);
    expect(CrudModel.create.mock.calls[0][1]).toMatchObject({ unused_days: 30 });
    expect((await create(30, "7")).statusCode).toBe(201);
    expect(CrudModel.create.mock.calls[1][1]).toMatchObject({ unused_days: 7 });
  });

  test("with a setting : more is refused with a 400 naming the most allowed ; none follows the setting", async () => {
    const longer = await create(30, 31);
    expect(longer.statusCode).toBe(400);
    expect(JSON.stringify(longer.body)).toContain('resources.storedJobUnusedDaysTooLong:{\\"days\\":30}');
    expect(CrudModel.create).not.toHaveBeenCalled();
    // none : the setting's days still remove it, so a stored job removed on a date keeps none
    expect((await create(30, null)).statusCode).toBe(201);
  });

  test("not a whole number of at least 1 : refused, setting or not", async () => {
    for (const days of [0, -3, 2.5, "abc"]) {
      expect((await create(0, days)).statusCode).toBe(400);
      expect((await create(30, days)).statusCode).toBe(400);
    }
    expect(CrudModel.create).not.toHaveBeenCalled();
  });

  test("without a setting (0) : any number, or none (stored as null)", async () => {
    expect((await create(0, 400)).statusCode).toBe(201);
    expect((await create(0, "")).statusCode).toBe(201);
    expect(CrudModel.create.mock.calls[1][1]).toMatchObject({ unused_days: null });
  });

  test("left out : not checked, the stored job follows the setting", async () => {
    expect((await create(30, undefined)).statusCode).toBe(201);
    expect(CrudModel.create.mock.calls[0][1].unused_days).toBeUndefined();
  });

  test("an update checks them the same, and one that leaves them out saves the rest", async () => {
    appConfig.storedJobUnusedDays = 10;
    // 20 from before the setting was lowered : a save of the name alone is not refused for it
    const rename = makeRes();
    await controller.update({ user: alice, params: { id: "1" }, query: {}, body: { name: "renamed" } }, rename);
    expect(rename.statusCode).toBe(200);
    const longer = makeRes();
    await controller.update({ user: alice, params: { id: "1" }, query: {}, body: { unused_days: 20 } }, longer);
    expect(longer.statusCode).toBe(400);
    const shorter = makeRes();
    await controller.update({ user: alice, params: { id: "1" }, query: {}, body: { unused_days: 5 } }, shorter);
    expect(shorter.statusCode).toBe(200);
    expect(CrudModel.update.mock.calls.at(-1)[1]).toEqual({ unused_days: 5 });
  });
});
