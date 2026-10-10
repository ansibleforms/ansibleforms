// A running playbook's output, written in batches (lib/outputBatcher.js).
import { describe, test, expect, vi } from "vitest";
import { createOutputBatcher } from "../src/lib/outputBatcher.js";

function batcher(maxBytes = 0) {
  const rows = [];
  let order = 0;
  const b = createOutputBatcher({ write: async (r) => { rows.push(r); }, jobId: 7, nextOrder: () => ++order, maxBytes });
  return { b, rows };
}

describe("the output batcher", () => {
  test("chunks of a stream become one row, the order between the streams is kept", async () => {
    const { b, rows } = batcher();
    b.add("stdout", "a");
    b.add("stdout", "b");
    b.add("stderr", "E");
    b.add("stdout", "c");
    await b.flush();
    expect(rows.map((r) => [r.output_type, r.output, r.order])).toEqual([["stdout", "ab", 1], ["stderr", "E", 2], ["stdout", "c", 3]]);
    expect(rows.every((r) => r.job_id === 7)).toBe(true);
  });

  test("written within half a second, without a flush", async () => {
    vi.useFakeTimers();
    try {
      const { b, rows } = batcher();
      b.add("stdout", "line\n");
      expect(rows).toEqual([]);
      await vi.advanceTimersByTimeAsync(600);
      expect(rows.map((r) => r.output)).toEqual(["line\n"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("64 KB kept is written at once", async () => {
    const { b, rows } = batcher();
    b.add("stdout", "x".repeat(70 * 1024));
    await Promise.resolve();
    await b.flush();
    expect(rows.length).toBe(1);
  });

  test("past the limit : what fits, one warning, nothing more - per stream", async () => {
    const { b, rows } = batcher(10);
    b.add("stdout", "0123456789ABC");
    b.add("stdout", "never");
    b.add("stderr", "err");
    await b.flush();
    expect(rows[0].output).toMatch(/^0123456789\n\[WARNING\]: the stdout of this job passed PROCESS_MAX_BUFFER \(10 bytes\)/);
    expect(rows.map((r) => r.output).join("")).not.toContain("never");
    expect(rows[1]).toMatchObject({ output_type: "stderr", output: "err" });
  });
});
