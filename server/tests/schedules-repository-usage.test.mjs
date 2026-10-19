// The Schedules usage of a repository (use_for_schedules) : one repository at most holds the
// schedules - a second one is refused, by the API and by the config seed, naming the one in use ;
// turning it on makes the repository take the app's schedules (ScheduleRepo.activate), turning it
// off or deleting the repository unlinks them, keeping them in the app (ScheduleRepo.deactivate).
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the repositories as the database holds them
let repos;
const calls = [];
vi.mock("../src/models/repo.model.js", () => ({
  default: {
    rename: () => true,
    delete: async (name) => calls.push(`rm:${name}`),
    clone: async () => "",
    maskGitToken: (s) => s,
    info: async () => "abc1234",
    folderOf: (name) => `/nowhere/${name}`,
    isValidName: (name) => /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(String(name || "")),
  },
}));
vi.mock("../src/models/crud.model.js", () => {
  class CrudModel {
    static async findByName(_m, name) {
      const found = repos.find((r) => r.name === name);
      return found ? { ...found } : null;
    }
    static async assertNotManaged() {}
    static async update(_m, data, id) {
      Object.assign(repos.find((r) => r.id === id), data);
      return true;
    }
    static async create(_m, data) {
      repos.push({ id: repos.length + 1, ...data });
      return repos.length;
    }
    static getCache() {
      return null;
    }
  }
  return { default: CrudModel };
});
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars = []) => {
      if (/SELECT name FROM AnsibleForms.`repositories` WHERE use_for_schedules AND name <> \?/.test(sql)) {
        return repos.filter((r) => Number(r.use_for_schedules) && r.name !== vars[0]).map((r) => ({ name: r.name }));
      }
      if (/SELECT use_for_schedules FROM AnsibleForms.`repositories` WHERE name = \?/.test(sql)) {
        return repos.filter((r) => r.name === vars[0]).map((r) => ({ use_for_schedules: Number(r.use_for_schedules) ? 1 : 0 }));
      }
      return { affectedRows: 1 };
    },
    tryDo: async () => [],
  },
}));
vi.mock("../src/models/scheduleRepo.model.js", () => ({
  default: {
    activate: async (name, opts) => {
      calls.push(`activate:${name}:${opts?.pull === false ? "nopull" : "pull"}`);
      return { repository: name, written: ["Nightly"], matched: [], kept: [] };
    },
    deactivate: async (name) => {
      calls.push(`deactivate:${name}`);
      return { repository: name, pull: "pulled", unlinked: 2 };
    },
    renameRepository: async () => {},
  },
}));

const Repository = (await import("../src/models/repository.model.js")).default;
const { validateSeed } = await import("../src/lib/seed-schema.js");

beforeEach(() => {
  calls.length = 0;
  repos = [
    { id: 1, name: "ops", use_for_schedules: 1, status: "success" },
    { id: 2, name: "forms", use_for_schedules: 0, status: "success" },
  ];
});

describe("one schedules repository at most", () => {
  test("ticking Schedules on a second repository is refused, naming the one in use", async () => {
    await assert.rejects(Repository.update({ use_for_schedules: 1 }, "forms"), (e) => {
      assert.equal(e.name, "BadRequestError");
      assert.match(e.message, /Repository 'ops' is already used for schedules/);
      return true;
    });
    assert.equal(repos[1].use_for_schedules, 0, "nothing saved");
  });

  test("a new repository with Schedules is refused too", async () => {
    await assert.rejects(Repository.create({ name: "more", uri: "https://x/y.git", branch: "main", use_for_schedules: true }), /'ops' is already used for schedules/);
  });

  test("the config seed refuses two", () => {
    const repo = (name, flag) => ({ name, uri: "https://x/y.git", use_for_schedules: flag });
    assert.throws(() => validateSeed({ repositories: { items: [repo("a", true), repo("b", true)] } }), /use_for_schedules on more than one repository: a, b/);
    assert.ok(validateSeed({ repositories: { items: [repo("a", true), repo("b", false)] } }));
  });
});

describe("turning it on and off", () => {
  test("on : the repository takes the app's schedules, and says what it did", async () => {
    repos[0].use_for_schedules = 0;
    const report = {};
    await Repository.update({ use_for_schedules: 1 }, "forms", { report });
    assert.deepEqual(calls, ["activate:forms:pull"]);
    assert.deepEqual(report.schedules.activated.written, ["Nightly"]);
  });

  test("off : its schedules are unlinked, kept in the app", async () => {
    const report = {};
    await Repository.update({ use_for_schedules: 0 }, "ops", { report });
    assert.deepEqual(calls, ["deactivate:ops"]);
    assert.equal(report.schedules.deactivated.unlinked, 2);
  });

  test("unchanged : nothing happens to the schedules", async () => {
    await Repository.update({ description: "x", use_for_schedules: 1 }, "ops", {});
    assert.deepEqual(calls, []);
  });

  test("deleted : its schedules are unlinked before its working copy goes", async () => {
    const report = {};
    await Repository.delete("ops", { report });
    assert.deepEqual(calls, ["deactivate:ops", "rm:ops"]);
    assert.equal(report.schedules.deactivated.unlinked, 2);
  });

  test("a new schedules repository takes the schedules once cloned", async () => {
    repos[0].use_for_schedules = 0;
    await Repository.create({ name: "fresh", uri: "https://x/y.git", branch: "main", use_for_schedules: 1 });
    await vi.waitFor(() => assert.ok(calls.includes("activate:fresh:nopull"), calls.join(",")));
  });
});
