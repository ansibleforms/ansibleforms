// LOG_PATH and the seven LOG_SYSLOG_* settings are applied without a restart, which means
// tearing a transport down and building a new one. Two things about that were wrong:
//
//  - winston's remove() only UNPIPES a transport, it never closes it. So every rebuild
//    orphaned whatever the old one held - a DailyRotateFile's open write stream and its
//    file-stream-rotator watchers, a Syslog's udp/tcp socket - for the process lifetime.
//    Each of the seven syslog variables triggers its own rebuild and saveEnv applies them
//    one at a time, so saving that tab with all seven changed leaked six sockets at once.
//  - setLogLevel('file') mutated the transport captured at IMPORT. After a LOG_PATH change
//    that one is orphaned, so a later LOG_LEVEL change updated something nothing was piped
//    to, while logConfig and the Status page both reported the new level. The file kept
//    logging at the old one.
import { test, describe, beforeEach, expect, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
// a host, so the syslog transport exists from the start
process.env.LOG_SYSLOG_HOST = "127.0.0.1";

// Stand-ins that record what happens to them. Subclassing the real transports would drag in
// real sockets and real files, and this is about lifecycle, not about winston's internals.
const built = { file: [], syslog: [] };
class FakeTransport {
  constructor(opts = {}) { this.level = opts.level; this.closed = false; this.opts = opts; }
  on() { return this; }
  close() { this.closed = true; }
  log(info, cb) { if (cb) cb(); }
}
class FakeDailyRotateFile extends FakeTransport {
  constructor(opts) { super(opts); built.file.push(this); }
}
class FakeSyslog extends FakeTransport {
  constructor(opts) { super(opts); built.syslog.push(this); }
}

const piped = new Set();
vi.mock("winston", () => {
  const printf = () => ({});
  const logger = {
    transports: [],
    level: "info",
    add(t) { piped.add(t); return this; },
    // exactly what the real remove() does: unpipe, and nothing else
    remove(t) { piped.delete(t); return this; },
    warning() {}, error() {}, info() {}, notice() {}, debug() {},
  };
  return {
    default: {
      // winston.format is a function (a custom format) with printf and combine on it
      format: Object.assign(() => () => ({}), { printf, combine: () => ({}) }),
      config: { syslog: { levels: { emerg: 0, alert: 1, crit: 2, error: 3, warning: 4, notice: 5, info: 6, debug: 7 } } },
      createLogger: (opts) => { (opts.transports || []).forEach((t) => piped.add(t)); return logger; },
      transports: { Console: FakeTransport, DailyRotateFile: FakeDailyRotateFile, Syslog: FakeSyslog },
    },
  };
});
vi.mock("winston-daily-rotate-file", () => ({ default: {} }));
vi.mock("winston-syslog", () => ({ default: {} }));

const loggerModule = await import("../src/lib/logger.js");
const { rebuildFileTransports, rebuildSyslogTransport, setLogLevel } = loggerModule;

beforeEach(() => { built.file.length = 0; built.syslog.length = 0; });

describe("a rebuilt transport releases what it was holding", () => {
  test("the file transports are closed, not just unpiped", () => {
    const before = [...piped].filter((t) => t instanceof FakeDailyRotateFile);
    expect(before.length).toBe(2);        // the main log and the errors log
    expect(rebuildFileTransports()).toBe(true);
    for (const old of before) {
      expect(old.closed, "an unpiped transport still owns its write stream").toBe(true);
      expect(piped.has(old)).toBe(false);
    }
    // and the replacements are attached and open
    expect(built.file.length).toBe(2);
    for (const t of built.file) {
      expect(piped.has(t)).toBe(true);
      expect(t.closed).toBe(false);
    }
  });

  test("the syslog transport is closed too", () => {
    const before = [...piped].find((t) => t instanceof FakeSyslog);
    expect(before, "a syslog host is configured, so one should exist").toBeTruthy();
    expect(rebuildSyslogTransport()).toBe(true);
    expect(before.closed, "an unpiped syslog transport still owns its socket").toBe(true);
    expect(piped.has(before)).toBe(false);
    expect(built.syslog.length).toBe(1);
    expect(piped.has(built.syslog[0])).toBe(true);
  });

  test("seven rebuilds in one save leave exactly one socket open", () => {
    // this is the real shape: each LOG_SYSLOG_* variable applies separately
    for (let i = 0; i < 7; i++) rebuildSyslogTransport();
    const live = [...piped].filter((t) => t instanceof FakeSyslog);
    expect(live.length).toBe(1);
    const orphans = built.syslog.filter((t) => !piped.has(t) && !t.closed);
    expect(orphans).toEqual([]);
  });
});

describe("the level setter follows the transport that is actually attached", () => {
  test("a level change after a path change reaches the live file transport", () => {
    rebuildFileTransports();
    const live = built.file.find((t) => t.level !== "error");   // the main log, not the errors one
    expect(setLogLevel("file", "debug")).toBe(true);
    expect(live.level, "the level must land on the transport lines actually go to").toBe("debug");
  });

  test("and not on the one that was orphaned by the rebuild", () => {
    const orphaned = [...piped].filter((t) => t instanceof FakeDailyRotateFile);
    expect(orphaned.length).toBe(2);
    // a sentinel rather than "not debug" : these tests share module state, so an earlier
    // one may already have set a level here and the assertion would pass for the wrong
    // reason - or fail for one, depending on the order they happen to run in
    orphaned.forEach((t) => { t.level = "untouched"; });
    rebuildFileTransports();
    setLogLevel("file", "debug");
    for (const old of orphaned) expect(old.level).toBe("untouched");
  });
});
