// The Audit log page picks a period (a year, a month or a day of the browser's calendar, sent as
// the instants [from, to)), sorts its columns on the server, and downloads every entry its
// filters select as a CSV file. The period and the sort are checked (a 400 otherwise), the sort
// reaches the SQL only through a whitelist with id as the tiebreaker, and the CSV quotes every
// cell and keeps a spreadsheet from running one as a formula.
import { describe, test, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// what the database was asked, and the rows the streamed query gives
let queries = [];
let streamRows = [];
let oldest = null;
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      queries.push({ sql, vars });
      if (/COUNT\(\*\)/.test(sql)) return [{ total: 0 }];
      if (/MIN\(created_at\)/.test(sql)) return [{ oldest }];
      return [];
    },
    stream: async function* (sql, vars) {
      queries.push({ sql, vars });
      for (const row of streamRows) yield row;
    },
  },
}));

const { default: Audit, SORT_COLUMNS } = await import("../src/models/audit.model.js");
const { default: controller, csvCell, downloadName, validInstant } = await import("../src/controllers/v2/audit.controller.js");

/**
 * A response that records its status, headers and what was written.
 *
 * Returns:
 *   object: the response ; statusCode, headers, body (json) and text (written).
 */
function response() {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, headers: {}, body: undefined, text: "", headersSent: false, ended: false });
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
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    res.headersSent = true;
    res.text += chunk;
    return true;
  };
  res.end = () => {
    res.ended = true;
  };
  res.destroy = () => {};
  return res;
}

const selectOf = () => queries.find((q) => /SELECT id, created_at/.test(q.sql));

beforeEach(() => {
  queries = [];
  streamRows = [];
  oldest = null;
});

describe("the period", () => {
  test("is [from, to) on created_at, both as zone-less UTC values", async () => {
    await Audit.find({ from: "2026-10-31T23:00:00.000Z", to: "2026-11-30T23:00:00.000Z" });
    const select = selectOf();
    expect(select.sql).toMatch(/created_at >= \? AND created_at < \?/);
    expect(select.vars.slice(0, 2)).toEqual(["2026-10-31 23:00:00", "2026-11-30 23:00:00"]);
  });

  test("takes ISO dates and date-times, refuses anything else", () => {
    for (const ok of [undefined, "", "2026-11-14", "2026-11-13T23:00:00.000Z", "2026-11-14T00:00:00+01:00"]) {
      expect(validInstant(ok)).toBe(true);
    }
    for (const bad of ["yesterday", "2026-13-45T00:00:00Z", "1731542400000", ["2026-11-14"], "2026-11-14 00:00"]) {
      expect(validInstant(bad)).toBe(false);
    }
  });

  test("a bound that is no ISO date is a 400 and nothing is read", async () => {
    const res = response();
    await controller.findAll({ query: { from: "last week" } }, res);
    expect(res.statusCode).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(queries).toHaveLength(0);
  });
});

describe("the sort", () => {
  test("goes through the whitelist, with id the same way as the tiebreaker", async () => {
    await Audit.find({ sort: "actor", dir: "asc" });
    expect(selectOf().sql).toMatch(/ORDER BY actor ASC, id ASC LIMIT/);
    queries = [];
    await Audit.find({ sort: "time", dir: "desc" });
    expect(selectOf().sql).toMatch(/ORDER BY created_at DESC, id DESC LIMIT/);
  });

  test("none is the newest first, as always", async () => {
    await Audit.find({});
    expect(selectOf().sql).toMatch(/ORDER BY created_at DESC, id DESC LIMIT/);
  });

  test("the model never puts an unknown column in the SQL", () => {
    expect(Audit.orderBy("detail; DROP TABLE audit", "asc")).toBe("created_at DESC, id DESC");
    expect(Audit.orderBy("constructor", "asc")).toBe("created_at DESC, id DESC");
    expect(Audit.orderBy("ip", "sideways")).toBe("ip DESC, id DESC");
    expect([...SORT_COLUMNS.keys()]).toEqual(["time", "actor", "action", "target", "outcome", "ip"]);
  });

  test("an unknown column or direction is refused with a 400, not ignored", async () => {
    for (const query of [{ sort: "detail" }, { sort: "__proto__" }, { sort: "time", dir: "up" }, { sort: ["time", "ip"] }]) {
      const res = response();
      await controller.findAll({ query }, res);
      expect(res.statusCode).toBe(400);
    }
    expect(queries).toHaveLength(0);
  });
});

describe("the facets", () => {
  test("give the oldest entry's time, with one MIN query", async () => {
    oldest = new Date("2024-03-05T10:00:00Z");
    const facets = await Audit.facets();
    expect(facets.oldest).toEqual(oldest);
    expect(queries.filter((q) => /MIN\(created_at\)/.test(q.sql))).toHaveLength(1);
  });

  test("nothing recorded, no oldest", async () => {
    expect((await Audit.facets()).oldest).toBe(null);
  });
});

describe("GET /api/v2/audit/download", () => {
  test("a CSV of every entry the filters select, in the order asked", async () => {
    streamRows = [
      {
        id: 2,
        created_at: new Date("2026-11-14T09:30:00Z"),
        actor: "alice",
        action: "credential.update",
        target: 'prod, "main"',
        outcome: "success",
        ip: "10.0.0.1",
        detail: '{"name":"prod"}',
      },
      { id: 1, created_at: new Date("2026-11-14T08:00:00Z"), actor: null, action: "auth.login", target: null, outcome: "failure", ip: null, detail: null },
    ];
    const res = response();
    await controller.download(
      { query: { actor: "alice", outcome: "success", from: "2026-11-13T23:00:00.000Z", to: "2026-11-14T23:00:00.000Z", sort: "target", dir: "asc", period: "2026-11-14" } },
      res
    );
    // the filters and the order : the page's own
    const q = queries[0];
    expect(q.sql).toMatch(/WHERE actor = \? AND outcome = \? AND created_at >= \? AND created_at < \?/);
    expect(q.sql).toMatch(/ORDER BY target ASC, id ASC$/);
    expect(q.sql).not.toMatch(/LIMIT/);
    expect(q.vars).toEqual(["alice", "success", "2026-11-13 23:00:00", "2026-11-14 23:00:00"]);
    // the headers
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="audit-2026-11-14.csv"');
    // the byte order mark, the header row, a line per entry, every cell quoted
    const lines = res.text.split("\r\n");
    expect(lines[0]).toBe('﻿"time","actor","action","target","outcome","ip","detail"');
    expect(lines[1]).toBe('"2026-11-14T09:30:00.000Z","alice","credential.update","prod, ""main""","success","10.0.0.1","{""name"":""prod""}"');
    expect(lines[2]).toBe('"2026-11-14T08:00:00.000Z","","auth.login","","failure","",""');
    expect(res.ended).toBe(true);
  });

  test("no entry is the header row alone", async () => {
    const res = response();
    await controller.download({ query: {} }, res);
    expect(res.text).toBe('﻿"time","actor","action","target","outcome","ip","detail"\r\n');
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="audit.csv"');
  });

  test("a period or a sort that is not one is a 400, before any row", async () => {
    let res = response();
    await controller.download({ query: { to: "tomorrow" } }, res);
    expect(res.statusCode).toBe(400);
    res = response();
    await controller.download({ query: { sort: "password" } }, res);
    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });

  test("a cell a spreadsheet would run as a formula shows as text", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("\"'+1\"");
    expect(csvCell("-2+3")).toBe("\"'-2+3\"");
    expect(csvCell("@SUM(A1)")).toBe("\"'@SUM(A1)\"");
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('""');
  });

  test("is named after its period, and only a year, a month or a day names it", () => {
    expect(downloadName("2026")).toBe("audit-2026.csv");
    expect(downloadName("2026-11")).toBe("audit-2026-11.csv");
    expect(downloadName("2026-11-14")).toBe("audit-2026-11-14.csv");
    expect(downloadName(undefined)).toBe("audit.csv");
    expect(downloadName('x"; filename="evil.exe')).toBe("audit.csv");
  });
});
