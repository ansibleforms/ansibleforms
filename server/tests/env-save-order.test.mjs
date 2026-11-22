// Saving environment variables writes a FILE and then applies the live ones to the running
// process. The order matters and it was the wrong way round.
//
// applyLive mutates things you cannot put back by hand: the log level, every configured
// path, VAULT_TOKEN, the db pool size, the TLS context. writeManaged can still fail after
// that - a read-only persistent volume is the exact case ALLOW_ENV_EDIT=0 exists for, and
// ENOSPC is the other. The caller then got a 500 saying the save had failed while every one
// of those changes was already in force, and stayed in force until a restart, with nothing
// on disk to explain where they came from.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.ALLOW_ENV_EDIT = "1";

const calls = [];
let writeFails = false;

vi.mock("../src/lib/envSettings.js", () => {
  const REFUSED = {};
  return {
    default: {
      REFUSED,
      ENV_EDIT_DISABLED_REASON: "disabled",
      OWNED_ELSEWHERE: /^$/,
      SECRET_ENV_NAME: /_PASSWORD$/,
      RELOCATES: new Set(),
      classify: () => "live",
      isOverridden: () => false,
      readManaged: async () => new Map(),
      validate: () => null,
      applyLive: (name) => { calls.push(`apply:${name}`); return true; },
      writeManaged: async () => {
        calls.push("write");
        if (writeFails) throw new Error("persistent/ is not writable");
        return "";
      },
    },
  };
});

vi.mock("../src/models/help.model.js", () => ({
  default: {
    get: async () => ([{ name: "Environment Variables", items: [{ name: "LOG_LEVEL", default: "info" }] }]),
  },
}));
vi.mock("../src/models/audit.model.js", () => ({ default: { log: async () => {} } }));

const controller = (await import("../src/controllers/v2/config.controller.js")).default;

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const save = async (body) => {
  const res = makeRes();
  await controller.saveEnv({ body, user: { user: { username: "root", options: { showSettings: true } } }, ip: "::1" }, res);
  return res;
};

beforeEach(() => { calls.length = 0; writeFails = false; });
afterEach(() => { delete process.env.LOG_LEVEL; });

describe("an environment save persists before it applies", () => {
  test("the file is written first, then the live values are applied", async () => {
    const res = await save({ LOG_LEVEL: "debug" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ["write", "apply:LOG_LEVEL"],
      "applying first means a failed write leaves the process changed with nothing on disk");
  });

  test("a write that fails changes nothing in the running process", async () => {
    writeFails = true;
    const res = await save({ LOG_LEVEL: "debug" });
    assert.equal(res.statusCode, 500, "the caller must be told the save failed");
    assert.equal(calls.includes("apply:LOG_LEVEL"), false,
      "nothing may be applied when the save it belongs to did not happen");
  });
});
