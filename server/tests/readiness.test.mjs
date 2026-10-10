// Liveness and readiness (lib/readiness.js) : ready when the database answers and the schema is
// there, not while the process stops.
import { describe, test, expect } from "vitest";
import { readiness } from "../src/lib/readiness.js";

const db = (answer) => ({ do: async (sql) => answer(sql) });

describe("readiness", () => {
  test("the database answers and the schema is there : ready", async () => {
    expect(await readiness(db((sql) => (/information_schema/.test(sql) ? [{ n: 3 }] : [{ 1: 1 }])))).toEqual({ ready: true });
  });

  test("the database does not answer : not ready", async () => {
    expect(await readiness(db(() => { throw new Error("ECONNREFUSED"); }))).toEqual({ ready: false, reason: "database unreachable" });
  });

  test("an empty database : not ready", async () => {
    expect(await readiness(db((sql) => (/information_schema/.test(sql) ? [{ n: 0 }] : [])))).toEqual({ ready: false, reason: "schema not provisioned" });
  });
});
