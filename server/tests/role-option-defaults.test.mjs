// A role's options left out take their defaults : an admin has API tokens, as every other right
// of theirs, but no token that never expires ; the others neither, unless a role says so.
import { test, describe, expect, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

const { applyOptionDefaults } = await import("../src/models/user.model.js");

describe("the api token options' defaults", () => {
  test("an admin : api tokens, never one that never expires", () => {
    const opts = {};
    applyOptionDefaults(opts, true);
    expect(opts.allowApiTokens).toBe(true);
    expect(opts.extendedTokenExpiration).toBe(false);
  });

  test("an admin's role can still turn them off", () => {
    const opts = { allowApiTokens: false };
    applyOptionDefaults(opts, true);
    expect(opts.allowApiTokens).toBe(false);
  });

  test("anyone else : none, unless a role turns them on or only sets extendedTokenExpiration", () => {
    const none = {};
    applyOptionDefaults(none, false);
    expect(none.allowApiTokens).toBe(false);
    const before = { extendedTokenExpiration: true };
    applyOptionDefaults(before, false);
    expect(before.allowApiTokens).toBe(true);
  });
});
