// The Audit log page picks a period (a year, a month or a day of the browser's calendar, sent as
// the instants [from, to)). The period is checked (a 400 otherwise), and the facets give the
// oldest entry's time, the first year the page offers.
import { describe, test, expect, beforeEach, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// what the database was asked
let queries = [];
let oldest = null;
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      queries.push({ sql, vars });
      if (/COUNT\(\*\)/.test(sql)) return [{ total: 0 }];
      if (/MIN\(created_at\)/.test(sql)) return [{ oldest }];
      return [];
    },
  },
}));

const { default: Audit } = await import("../src/models/audit.model.js");
const { default: controller, validInstant } = await import("../src/controllers/v2/audit.controller.js");

/**
 * A response that records its status and its JSON body.
 *
 * Returns:
 *   object: the response ; statusCode and body (json).
 */
function response() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

const selectOf = () => queries.find((q) => /SELECT id, created_at/.test(q.sql));

beforeEach(() => {
  queries = [];
  oldest = null;
});

describe("the period", () => {
  test("is [from, to) on created_at, both as zone-less UTC values", async () => {
    await Audit.find({ from: "2026-10-31T23:00:00.000Z", to: "2026-11-30T23:00:00.000Z" });
    const select = selectOf();
    expect(select.sql).toMatch(/created_at >= \? AND created_at < \?/);
    expect(select.vars.slice(0, 2)).toEqual(["2026-10-31 23:00:00", "2026-11-30 23:00:00"]);
  });

  test("takes ISO dates and date-times, refuses anything else", () => {
    for (const ok of [undefined, "", "2026-11-14", "2026-11-13T23:00:00.000Z", "2026-11-14T00:00:00+01:00"]) {
      expect(validInstant(ok)).toBe(true);
    }
    for (const bad of ["yesterday", "2026-13-45T00:00:00Z", "1731542400000", ["2026-11-14"], "2026-11-14 00:00"]) {
      expect(validInstant(bad)).toBe(false);
    }
  });

  test("a bound that is no ISO date is a 400 and nothing is read", async () => {
    const res = response();
    await controller.findAll({ query: { from: "last week" } }, res);
    expect(res.statusCode).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(queries).toHaveLength(0);
  });
});

describe("the facets", () => {
  test("give the oldest entry's time, with one MIN query", async () => {
    oldest = new Date("2024-03-05T10:00:00Z");
    const facets = await Audit.facets();
    expect(facets.oldest).toEqual(oldest);
    expect(queries.filter((q) => /MIN\(created_at\)/.test(q.sql))).toHaveLength(1);
  });

  test("nothing recorded, no oldest", async () => {
    expect((await Audit.facets()).oldest).toBe(null);
  });
});
