// The Server log page picks a day : GET /api/v2/log/dates lists the days that have a log file
// (plain, or zipped by the rotation), GET /api/v2/log?date= reads a day's last lines (a .gz
// unzipped) and GET /api/v2/log/download?date= sends a day's file. A date is a real calendar day
// written as YYYY-MM-DD, or the request is refused : a path is never built from anything else.
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";

// a LOG_PATH of the tests' own, filled with a few days
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-logs-"));
process.env.LOG_PATH = dir;

const { default: logConfig } = await import("../config/log.config.js");
const { default: Log } = await import("../src/models/log.model.js");
const { default: controller, dayToRead } = await import("../src/controllers/v2/log.controller.js");

/**
 * A response that records its status, headers, body and the file it was asked to send.
 *
 * Returns:
 *   object: the response.
 */
function response() {
  const res = { statusCode: 200, body: undefined, headers: {}, file: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (name, value) => {
    res.headers[name] = value;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.download = (file) => {
    res.file = file;
    return res;
  };
  return res;
}

// a zipped day of 50 numbered lines
const zippedLines = Array.from({ length: 50 }, (_, i) => `zipped line ${i + 1}`).join("\n") + "\n";

beforeAll(() => {
  logConfig.path = dir;
  fs.writeFileSync(path.join(dir, `ansibleforms.${Log.today()}.log`), "today 1\ntoday 2\n");
  fs.writeFileSync(path.join(dir, "ansibleforms.2026-11-10.log.gz"), zlib.gzipSync(zippedLines));
  fs.writeFileSync(path.join(dir, "ansibleforms.2025-12-31.log"), "last year\n");
  // not main log files : the errors, the rotation's audit json, a day that does not exist
  fs.writeFileSync(path.join(dir, "ansibleforms.errors.2026-11-01.log"), "an error\n");
  fs.writeFileSync(path.join(dir, "ansibleforms.errors.2026-11-02.log.gz"), zlib.gzipSync("an error\n"));
  fs.writeFileSync(path.join(dir, ".af-audit.json"), "{}");
  fs.writeFileSync(path.join(dir, "ansibleforms.2026-02-30.log"), "no such day\n");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a log date", () => {
  test("is a real calendar day written as YYYY-MM-DD", () => {
    expect(Log.isDate("2026-11-14")).toBe(true);
    expect(Log.isDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-5", "../../etc/passwd", "2026-11-14x", "", null, ["2026-11-14"]]) {
      expect(Log.isDate(bad)).toBe(false);
    }
  });

  test("a request without one reads today", () => {
    expect(dayToRead(undefined)).toBe(Log.today());
    expect(dayToRead("")).toBe(Log.today());
    expect(dayToRead("2026-11-10")).toBe("2026-11-10");
    expect(dayToRead("2026-11-10/../x")).toBe(null);
  });
});

describe("GET /api/v2/log/dates", () => {
  test("lists the days with a main log file, zipped included, newest first", async () => {
    const res = response();
    await controller.dates({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    const today = Log.today();
    const expected = [...new Set([today, "2026-11-10", "2025-12-31"])].sort().reverse();
    expect(res.body.records).toEqual(expected);
    // the errors files and a day that does not exist are not offered
    expect(res.body.records).not.toContain("2026-11-01");
    expect(res.body.records).not.toContain("2026-11-02");
    expect(res.body.records).not.toContain("2026-02-30");
  });
});

describe("GET /api/v2/log?date=", () => {
  test("a date that is no day is a 400 with a message, and nothing is read", async () => {
    for (const date of ["2026-02-30", "14-11-2026", "../../secret", ["2026-11-10", "2026-11-11"]]) {
      const res = response();
      await controller.get({ query: { date } }, res);
      expect(res.statusCode).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
  });

  test("a zipped day gives its last lines, unzipped", async () => {
    const res = response();
    await controller.get({ query: { date: "2026-11-10", lines: "3" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("zipped line 48\nzipped line 49\nzipped line 50\n");
    expect(res.headers["X-Log-Missing"]).toBeUndefined();
    // the day read is named, so the page knows which day it shows
    expect(res.headers["X-Log-Date"]).toBe("2026-11-10");
  });

  test("a zipped day shorter than the lines asked gives all of it", async () => {
    expect(await Log.readZippedTail(path.join(dir, "ansibleforms.2026-11-10.log.gz"), 500)).toBe(zippedLines);
  });

  test("a plain day gives its last lines", async () => {
    const res = response();
    await controller.get({ query: { date: "2025-12-31" } }, res);
    expect(res.body).toBe("last year\n");
  });

  test("no date reads the server's today, and names it", async () => {
    const res = response();
    await controller.get({ query: {} }, res);
    expect(res.body).toBe("today 1\ntoday 2\n");
    expect(res.headers["X-Log-Date"]).toBe(Log.today());
  });

  test("a day without a file is an empty log said missing, never a 500", async () => {
    const res = response();
    await controller.get({ query: { date: "2020-01-01" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["X-Log-Missing"]).toBe("true");
  });
});

describe("GET /api/v2/log/download?date=", () => {
  test("sends the day's file : the plain log, or the zipped one as it is", () => {
    let res = response();
    controller.download({ query: {} }, res);
    expect(res.file).toBe(path.join(dir, `ansibleforms.${Log.today()}.log`));
    res = response();
    controller.download({ query: { date: "2026-11-10" } }, res);
    expect(res.file).toBe(path.join(dir, "ansibleforms.2026-11-10.log.gz"));
  });

  test("a day without a file is a 404, a date that is no day a 400", () => {
    let res = response();
    controller.download({ query: { date: "2020-01-01" } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.file).toBeUndefined();
    res = response();
    controller.download({ query: { date: "../ansibleforms.errors.2026-11-01" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.file).toBeUndefined();
  });
});
