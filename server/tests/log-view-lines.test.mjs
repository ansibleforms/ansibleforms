// LOG_VIEW_LINES (Settings > System > General > Logging) : the lines of today's log the Logs page
// shows, and the most GET /api/v2/log answers whatever a request asks. A whole number of at least
// 1, no upper limit, 1000 by default. Before it, the page asked 1000 and the endpoint took any
// number, so one request could make the server read the whole day's file every time.
import { describe, test, expect, vi, beforeEach } from "vitest";

// the lines each read asked for
const reads = [];

vi.mock("../src/models/log.model.js", () => ({
  default: {
    getFileName: () => "/tmp/ansibleforms.2026-11-14.log",
    today: () => "2026-11-14",
    isDate: (value) => value === "2026-11-14",
    find: async (lines) => {
      reads.push(lines);
      return "line\n";
    },
  },
}));

const { parseViewLines, validViewLines, LOG_VIEW_LINES_DEFAULT, default: logConfig } = await import("../config/log.config.js");
const { default: controller, linesToRead } = await import("../src/controllers/v2/log.controller.js");

/**
 * Asks the log endpoint with the given query.
 *
 * Args:
 *   query (object): the request's query.
 *
 * Returns:
 *   Promise<number>: the lines the model was asked to read.
 */
async function ask(query) {
  const res = { status: () => res, json: () => res, set: () => res };
  await controller.get({ query }, res);
  return reads.at(-1);
}

describe("LOG_VIEW_LINES", () => {
  beforeEach(() => {
    reads.length = 0;
    logConfig.viewLines = LOG_VIEW_LINES_DEFAULT;
  });

  test("is 1000 by default, and a whole number of at least 1 with no upper limit", () => {
    expect(LOG_VIEW_LINES_DEFAULT).toBe(1000);
    expect(parseViewLines(undefined)).toBe(1000);
    expect(parseViewLines("")).toBe(1000);
    expect(parseViewLines("250")).toBe(250);
    expect(parseViewLines(" 1 ")).toBe(1);
    expect(parseViewLines("2000000")).toBe(2000000);
    for (const bad of ["0", "-5", "12.5", "lots", "1e3"]) expect(parseViewLines(bad)).toBe(1000);
  });

  test("accepts empty or a whole number of at least 1, nothing else", () => {
    expect(validViewLines("")).toBe(true);
    expect(validViewLines("1")).toBe(true);
    expect(validViewLines("500000")).toBe(true);
    for (const bad of ["0", "-1", "3.5", "abc"]) expect(validViewLines(bad)).toBe(false);
  });

  test("a request reads at most the setting, and the setting when it asks none", () => {
    expect(linesToRead(undefined, 1000)).toBe(1000);
    expect(linesToRead("200", 1000)).toBe(200);
    expect(linesToRead("10000000", 1000)).toBe(1000);
    expect(linesToRead("0", 1000)).toBe(1000);
    expect(linesToRead("abc", 1000)).toBe(1000);
  });

  test("the endpoint follows the setting, a change included, without a restart", async () => {
    expect(await ask({})).toBe(1000);
    expect(await ask({ lines: "99999999" })).toBe(1000);
    logConfig.viewLines = 5000;
    expect(await ask({})).toBe(5000);
    expect(await ask({ lines: "300" })).toBe(300);
  });
});
