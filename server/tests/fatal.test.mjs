// An uncaught exception exits the process to restart clean ; a rejection is logged (lib/fatal.js).
import { describe, test, expect, vi } from "vitest";

const logger = (await import("../src/lib/logger.js")).default;
const { installFatalHandlers } = await import("../src/lib/fatal.js");

describe("the fatal handlers", () => {
  test("an uncaught exception is logged and exits with 1, once ; a rejection is only logged", async () => {
    vi.useFakeTimers();
    const added = {};
    const on = vi.spyOn(process, "on").mockImplementation((event, fn) => { added[event] = fn; return process; });
    const lines = [];
    logger.crit = (m) => lines.push(["crit", m]);
    logger.error = (m) => lines.push(["error", m]);
    const exits = [];
    try {
      installFatalHandlers("app", (code) => exits.push(code));
      added.unhandledRejection(new Error("a rejection"));
      expect(exits).toEqual([]);
      added.uncaughtException(new Error("boom"));
      added.uncaughtException(new Error("boom again"));
      await vi.advanceTimersByTimeAsync(1500);
      expect(exits).toEqual([1]);
      expect(lines.map((l) => l[0])).toEqual(["error", "crit", "crit"]);
      expect(lines[1][1]).toMatch(/uncaught exception, exiting to restart clean : Error: boom/);
    } finally {
      on.mockRestore();
      vi.useRealTimers();
    }
  });
});
