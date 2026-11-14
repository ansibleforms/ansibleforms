// GET /api/v2/log before today's log file exists (just after midnight, a quiet server) :
// an empty log (200), not a 500. Settings > Logs stopped following on the 500 and never
// showed the lines that came once the file was made.
import { describe, test, expect, vi, beforeEach } from "vitest";

// whether today's file is there, and what reading it gives
const state = { exists: true, lines: "line 1\nline 2\n" };

vi.mock("../src/models/log.model.js", () => ({
  default: {
    getFileName: () => {
      if (!state.exists) throw new Error("No logfile ansibleforms.2026-10-18.log found");
      return "/tmp/ansibleforms.2026-10-18.log";
    },
    today: () => "2026-10-18",
    isDate: (value) => value === "2026-10-18",
    // no file for the day : null, as the model answers it
    find: async () => (state.exists ? state.lines : null),
  },
}));

const { default: controller } = await import("../src/controllers/v2/log.controller.js");

/**
 * A response that records its status and body.
 *
 * Returns:
 *   object: the response ; statusCode and body once answered.
 */
function response() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
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

describe("GET /api/v2/log", () => {
  beforeEach(() => {
    state.exists = true;
  });

  test("today's file missing is an empty log, answered 200", async () => {
    state.exists = false;
    const res = response();
    await controller.get({ query: { lines: 50 } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    // said missing, so the page can say there is no log for that day
    expect(res.headers["X-Log-Missing"]).toBe("true");
  });

  test("today's file present gives its last lines", async () => {
    const res = response();
    await controller.get({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("line 1\nline 2\n");
    expect(res.headers["X-Log-Missing"]).toBeUndefined();
  });
});
