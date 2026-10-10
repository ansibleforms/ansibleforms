// The jobs list returns MAX_JOBS_LIST jobs at most, whatever ?records= asks.
import { describe, test, expect, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

let asked;
vi.mock("../src/models/job.model.js", () => ({ default: { findAll: async (_u, n) => { asked = n; return []; } } }));

const { default: controller, MAX_JOBS_LIST } = await import("../src/controllers/v2/job.controller.js");

async function list(records) {
  const res = { status() { return this; }, json() { return this; } };
  await controller.findAllJobs({ query: records === undefined ? {} : { records }, user: { user: { username: "u", roles: [] } } }, res);
  return asked;
}

describe("the jobs list", () => {
  test("what the page asks, bounded", async () => {
    expect(await list("200")).toBe(200);
    // none asked : JOBS_LIST_SIZE, within the bound
    expect(await list(undefined)).toBeGreaterThan(0);
    expect(await list(undefined)).toBeLessThanOrEqual(MAX_JOBS_LIST);
    expect(await list("10000000")).toBe(MAX_JOBS_LIST);
    expect(await list("-5")).toBe(1);
  });
});
