// Every SQL Server query gets a pool of its own : the library's global pool (client.connect)
// is shared whatever the config, so two queries with different credentials could swap servers.
import { describe, test, expect, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const pools = [];
vi.mock("mssql", () => {
  class ConnectionPool {
    constructor(config) { this.config = config; this.closed = false; pools.push(this); }
    async connect() { return this; }
    async query() { await new Promise((r) => setTimeout(r, 10)); return { recordset: [{ server: this.config.server, closed: this.closed }] }; }
    async close() { this.closed = true; }
  }
  return { default: { ConnectionPool, connect: () => { throw new Error("the global pool must not be used"); } } };
});
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: { resolveCredential: async (name) => ({ host: `${name}.db`, user: "u", password: "p", db_name: "d", port: 1433 }) },
}));

const { default: Mssql } = await import("../src/lib/mssql.js");

describe("SQL Server queries", () => {
  test("two at once, each on its own credential's server, neither closed under the other", async () => {
    const [a, b] = await Promise.all([Mssql.query("alpha", "SELECT 1"), Mssql.query("beta", "SELECT 1")]);
    expect(a).toEqual([{ server: "alpha.db", closed: false }]);
    expect(b).toEqual([{ server: "beta.db", closed: false }]);
    expect(pools.every((p) => p.closed)).toBe(true);
  });
});
