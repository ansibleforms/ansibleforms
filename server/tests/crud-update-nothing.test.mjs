// An update with no field the model knows (unknown keys only, or nothing at all) is a bad
// request said in words : it never reaches MySQL as an UPDATE with an empty SET, whose SQL
// syntax error the caller was answered with (PUT /api/v2/profile with an unknown key).
import { test, describe, expect, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the queries run : the existence and managed checks may, the UPDATE must not
const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: { do: async (sql) => { queries.push(sql); return [{ id: 1, managed: 0 }]; } },
}));

const CrudModel = (await import("../src/models/crud.model.js")).default;

describe("an update with nothing to change", () => {
  test.each([
    ["only unknown keys", { user: { password: "x" } }],
    ["an empty body", {}],
  ])("%s is refused, without an UPDATE", async (_, data) => {
    queries.length = 0;
    await expect(CrudModel.update("users", data, 1)).rejects.toThrow(/Nothing to change/);
    expect(queries.some((q) => /^UPDATE/i.test(q))).toBe(false);
  });

  test("a known field still updates", async () => {
    queries.length = 0;
    await CrudModel.update("users", { email: "x@example.com" }, 1);
    expect(queries.some((q) => /^UPDATE/i.test(q))).toBe(true);
  });
});
