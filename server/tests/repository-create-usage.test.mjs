// A new repository made the repository of object types (the schedules, the credentials ...) takes
// the app's objects once its first clone is done, in the background : the create has answered by
// then, so nothing told the admin what was taken, what stayed in the app or what failed. What it
// did is said in the repository's pull output, after the clone's own lines, where its page shows it.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/repo.model.js", () => ({
  default: { isValidName: (name) => /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(String(name || "")) },
}));

vi.mock("../src/models/crud.model.js", () => {
  class CrudModel {
    static async create() {
      return 9;
    }
    static getCache() {
      return null;
    }
  }
  return { default: CrudModel };
});

const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      queries.push({ sql, vars });
      return { affectedRows: 1 };
    },
  },
}));

// the engine : what the activation reports, and the lines it reads as
let report = {};
const asked = [];
vi.mock("../src/lib/repoObjects/index.js", () => ({
  default: {
    assertUsageAllowed: async () => {},
    afterUsageChange: async (before, name, now, opts) => {
      asked.push({ before, name, opts });
      return report;
    },
    usageReportText: async (r) => (Object.keys(r).length ? `\nNow holds the schedules: ${JSON.stringify(r)}` : ""),
  },
}));

const Repository = (await import("../src/models/repository.model.js")).default;

/**
 * Creates a repository and waits for what follows its clone (in the background).
 *
 * Args:
 *   data (object): the repository.
 */
async function create(data) {
  vi.spyOn(Repository, "clone").mockResolvedValue();
  await Repository.create({ branch: "main", uri: "https://git/x.git", ...data });
  await vi.waitFor(() => assert.ok(asked.length || !data.use_for_schedules));
  // the write after the activation
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  queries.length = 0;
  asked.length = 0;
  report = {};
});

describe("a new repository of object types", () => {
  test("says in its pull output what it took once cloned, after the clone's lines", async () => {
    report = { schedules: { activated: { written: ["nightly"] } } };
    await create({ name: "jobs", use_for_schedules: 1 });
    assert.deepEqual(asked[0], { before: null, name: "jobs", opts: { pull: false } });
    const write = queries.find((q) => /set pull_output = CONCAT\(COALESCE\(pull_output, ''\), \?\)/.test(q.sql));
    assert.ok(write, "the pull output is added to");
    assert.deepEqual(write.vars, [`\nNow holds the schedules: ${JSON.stringify(report)}`, "jobs"]);
  });

  test("writes nothing when the activation did nothing, nor for a repository of content only", async () => {
    await create({ name: "jobs", use_for_schedules: 1 });
    await create({ name: "forms", use_for_forms: 1 });
    assert.equal(asked.length, 1);
    assert.equal(queries.filter((q) => /pull_output/.test(q.sql)).length, 0);
  });
});

describe("a repository a repositories.yaml holds", () => {
  test("its uri edited in the app to carry a user or a token : refused, its secret never goes to git", async () => {
    vi.spyOn(Repository, "findByName").mockResolvedValue({ id: 3, name: "forms", uri: "https://git/forms.git", repository: "hub", repo_file: "repositories.yaml" });
    await assert.rejects(
      Repository.update({ uri: "https://bot:ghp_secret@github.com/org/forms.git" }, "forms"),
      /kept in hub\/repositories.yaml: its uri must not carry a user or a token/,
    );
    assert.equal(queries.length, 0, "nothing saved");
  });
});

describe("a repository a repositories.yaml makes", () => {
  test("without a branch : made, on the remote's default branch, as the config seed makes one", async () => {
    vi.spyOn(Repository, "clone").mockResolvedValue();
    assert.equal(await Repository.create({ name: "forms", uri: "https://git/forms.git" }, { fromRepo: true }), 9);
    // one made in the app still needs its branch
    await assert.rejects(Repository.create({ name: "other", uri: "https://git/other.git" }), /Missing required field: branch/);
  });
});
