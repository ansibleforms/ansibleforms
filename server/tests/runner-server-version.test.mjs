// A runner of another kind than the AnsibleForms ones keeps the version its server said it runs at
// its connection test, with when ; never one of the AnsibleForms kinds (their socket says theirs),
// never from a request.
import { test, describe, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";

const sql = [];
vi.mock("../src/models/db.model.js", () => ({ default: { do: async (q, p) => { sql.push([q, p]); return []; } } }));
vi.mock("../src/lib/logger.js", () => ({ default: { info() {}, debug() {}, warning() {}, error() {}, notice() {} } }));
const changed = [];
vi.mock("../src/models/crud.model.js", () => ({ default: class CrudModel { static changed(m) { changed.push(m); } } }));
vi.mock("../src/models/credential.model.v2.js", () => ({ default: {} }));
const reports = {};
vi.mock("../src/runners/index.js", () => ({
  RUNNER_TYPES: ["awx", "rte", "builder", "jenkins"],
  getRunner: (type) => ({ check: async () => reports[type] }),
}));

const Runner = (await import("../src/models/runner.model.js")).default;

describe("a runner's version", () => {
  beforeEach(() => { sql.length = 0; });

  test("kept with when at its connection test, as its server said it", async () => {
    reports.awx = { templates: 3, version: "24.6.1" };
    const info = await Runner.check({ id: 15, name: "awx-prod", type: "awx" });
    assert.equal(info.version, "24.6.1");
    assert.equal(sql.length, 1);
    assert.match(sql[0][0], /SET server_version = \?, server_version_at = NOW\(\) WHERE id = \?/);
    assert.deepEqual(sql[0][1], ["24.6.1", 15]);
    // its cached row dropped, so its page shows the version at once
    assert.deepEqual(changed, ["runner"]);
  });

  test("none said : nothing written, the one kept before stays", async () => {
    reports.jenkins = { user: "af" };
    await Runner.check({ id: 3, name: "jenkins", type: "jenkins" });
    assert.equal(sql.length, 0);
  });

  test("an AnsibleForms runner's or a builder's never : their socket says theirs", async () => {
    reports.rte = { version: "7.8.0" };
    reports.builder = { version: "7.8.0" };
    await Runner.check({ id: 1, name: "rte", type: "rte" });
    await Runner.check({ id: 2, name: "b", type: "builder" });
    assert.equal(sql.length, 0);
  });

  test("never from a request", () => {
    const data = { name: "x", type: "awx", server_version: "1", server_version_at: "2026-01-01" };
    Runner.normalize(data);
    assert.equal(data.server_version, undefined);
    assert.equal(data.server_version_at, undefined);
  });
});
