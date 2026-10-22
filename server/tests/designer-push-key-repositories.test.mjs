// The repositories holding the roles, the categories or the constants (lib/configKeys.js) are the
// designer's to push, as the forms repositories are : a designer save writes those keys into their
// working trees. Since the Config usage was split in three, the config repository of 7.3 (now holding
// the three keys) was left out of the designer's Push and of its changes-not-pushed flag, and its
// scheduled pull was skipped for the changes nobody could push from the designer.
import { test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the repositories table : a forms repository, the one 7.3 read its config from (upgraded to the
// three keys), and one holding the roles alone
const state = vi.hoisted(() => ({ rows: [] }));
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, params) => {
      const on = (flag) => state.rows.filter((r) => Number(r[flag]));
      if (/WHERE (use_for_\w+ OR ){2}use_for_\w+ ORDER/.test(sql)) return state.rows.filter((r) => r.use_for_roles || r.use_for_categories || r.use_for_constants);
      if (/WHERE use_for_forms/.test(sql)) return on("use_for_forms");
      if (/WHERE name = \?/.test(sql)) return state.rows.filter((r) => r.name === params[0]);
      return [];
    },
  },
}));
vi.mock("../src/models/repo.model.js", () => {
  const Repo = { folderOf: (name) => `/nowhere/${name}`, isValidName: () => true, hasChanges: async (name) => name === "cfg" };
  return { default: Repo, repoFolder: Repo.folderOf };
});
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const { default: Repository } = await import("../src/models/repository.model.js");

const row = (name, flags = {}) => ({ name, status: "success", head: "abc", use_for_forms: 0, use_for_roles: 0, use_for_categories: 0, use_for_constants: 0, ...flags });

beforeEach(() => {
  state.rows = [row("forms", { use_for_forms: 1 }), row("cfg", { use_for_categories: 1, use_for_constants: 1 }), row("access", { use_for_roles: 1 })];
});

test("the repositories of the roles, the categories and the constants are pushed from the designer", async () => {
  const names = (await Repository.findPushableRepositories()).map((r) => r.name);
  expect(names).toEqual(["forms", "cfg", "access"]);
});

test("the designer's status flags their changes, and names the categories' repository its config repository", async () => {
  const status = await Repository.formsRepoStatus();
  expect(status.repositories.find((r) => r.name === "cfg")).toMatchObject({ dirty: true });
  expect(status.configRepo).toBe("cfg");
});

test("a repository both for forms and for the keys is listed once", async () => {
  state.rows = [row("forms", { use_for_forms: 1, use_for_roles: 1, use_for_categories: 1, use_for_constants: 1 })];
  expect((await Repository.findPushableRepositories()).map((r) => r.name)).toEqual(["forms"]);
});
