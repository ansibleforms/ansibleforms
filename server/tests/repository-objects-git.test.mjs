// The repository model and the repository-backed objects (lib/repoObjects) around git :
//   first clone   a repository that holds object types takes the app's objects on its first clone
//                 (no working tree before it) - one not cloned when its usage was turned on takes
//                 them once it is ; a clone over a tree already there, or one the caller activates
//                 itself (a new repository, a usage turned on), only reads its files
//   reset         cloned again by a reset : an object whose file is not in the remote is unlinked,
//                 never deleted
//   push          a Push into a missing working tree clones it as every clone into a missing tree :
//                 its files read as cloned again, the app's other objects taken, before the commit ;
//                 into one already there, its files read in after it (its rebase brings git's edits)
//   delete        its objects unlinked only once the delete holds the repository : a delete refused
//                 (a pull running) leaves them linked
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the working trees, a folder of the test's own
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-repository-git-"));
vi.mock("../src/models/repo.model.js", () => ({
  default: {
    folderOf: (name) => path.join(ROOT, name),
    isValidName: (name) => /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(String(name || "")),
    clone: async (uri, name) => {
      fs.mkdirSync(path.join(ROOT, name), { recursive: true });
      return "cloned";
    },
    pull: async () => "pulled",
    sync: async () => "pushed",
    delete: async (name) => fs.rmSync(path.join(ROOT, name), { recursive: true, force: true }),
    info: async () => "abc123",
    hasChanges: async () => false,
    maskGitToken: (text) => text,
  },
}));

// the repository : one holding the credentials
let row = {};
vi.mock("../src/models/crud.model.js", () => {
  class CrudModel {
    static async findByName() {
      return { ...row };
    }
    static async assertNotManaged() {}
    static getCache() {
      return null;
    }
  }
  return { default: CrudModel };
});

// the claim : refused while 'busy'
let busy = false;
const queries = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      queries.push({ sql, vars });
      if (/set status = 'running'/.test(sql)) return { affectedRows: busy ? 0 : 1 };
      return { affectedRows: 1 };
    },
  },
}));

// what the repository's git asks of the objects : recorded
const asked = [];
vi.mock("../src/lib/repoObjects/index.js", () => ({
  default: {
    afterGit: async (name, repo, opts) => {
      asked.push(["afterGit", name, opts]);
      // when, among the queries : before the claim is released or after
      queries.push({ sql: "afterGit" });
      return "";
    },
    afterUsageChange: async (before, name, now, opts) => {
      asked.push(["afterUsageChange", name, opts.pull]);
      return { credentials: { deactivated: { pull: "", unlinked: 1 } } };
    },
    asHolding: async (name, run) => run(),
  },
}));
vi.mock("../src/lib/configKeys.js", () => ({ deprecationLines: async () => "" }));
vi.mock("../src/models/form.model.js", () => ({ default: { duplicateLines: async () => "" } }));

const Repository = (await import("../src/models/repository.model.js")).default;

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  row = { id: 7, name: "creds", uri: "https://git/creds.git", branch: "main", status: "success", use_for_credentials: 1 };
  busy = false;
  queries.length = 0;
  asked.length = 0;
});

describe("the clone of a repository holding credentials", () => {
  test("its first clone takes the app's credentials (activate), its files read as cloned again", async () => {
    await Repository.clone("creds");
    assert.deepEqual(asked, [["afterGit", "creds", { activate: true, reset: true }]]);
  });

  test("a clone over a working tree already there only reads its files", async () => {
    fs.mkdirSync(path.join(ROOT, "creds"));
    await Repository.clone("creds");
    assert.deepEqual(asked, [["afterGit", "creds", { activate: false, reset: false }]]);
  });

  test("a clone whose caller activates it itself only reads its files, as cloned again", async () => {
    await Repository.clone("creds", false, { activate: false });
    assert.deepEqual(asked, [["afterGit", "creds", { activate: false, reset: true }]]);
  });

  test("a reset clones it again as a reset : never an activation, its gone files unlinked", async () => {
    fs.mkdirSync(path.join(ROOT, "creds"));
    await Repository.reset("creds");
    assert.deepEqual(asked, [["afterGit", "creds", { activate: false, reset: true }]]);
  });
});

describe("the push of a repository holding credentials", () => {
  test("into a missing working tree : cloned, its files read as every fresh clone reads them, before the commit", async () => {
    const output = await Repository.sync("creds", "admin");
    assert.deepEqual(asked, [["afterGit", "creds", { activate: true, reset: true }]]);
    assert.match(output, /^cloned\npushed$/);
  });

  test("into a working tree already there : pushed, then its files read in under the claim - the rebase may bring git's edits", async () => {
    fs.mkdirSync(path.join(ROOT, "creds"));
    assert.equal(await Repository.sync("creds", "admin"), "pushed");
    // read as a pull reads them
    assert.deepEqual(asked, [["afterGit", "creds", undefined]]);
    // read while the push still holds the repository : its claim released after it
    const release = queries.findIndex((q) => /set push_output = \?/.test(q.sql));
    assert.ok(release > queries.findIndex((q) => q.sql === "afterGit"));
  });

  test("a repository holding no object type : nothing read", async () => {
    row = { ...row, use_for_credentials: 0, use_for_forms: 1 };
    fs.mkdirSync(path.join(ROOT, "creds"));
    assert.equal(await Repository.sync("creds", "admin"), "pushed");
    assert.deepEqual(asked, []);
  });
});

describe("the delete of a repository holding credentials", () => {
  test("refused while a pull runs : its credentials never unlinked", async () => {
    busy = true;
    await assert.rejects(() => Repository.delete("creds"), /already running/);
    assert.deepEqual(
      asked.filter((a) => a[0] === "afterUsageChange"),
      [],
    );
  });

  test("pulled first, then its credentials unlinked under the delete's claim, the pull said", async () => {
    fs.mkdirSync(path.join(ROOT, "creds"));
    const report = {};
    await Repository.delete("creds", { report });
    assert.deepEqual(asked.filter((a) => a[0] === "afterUsageChange"), [["afterUsageChange", "creds", false]]);
    const claim = queries.findIndex((q) => /set status = 'running'/.test(q.sql) && q.vars?.[1] === "creds");
    const removed = queries.findIndex((q) => /DELETE FROM AnsibleForms.`repositories`/.test(q.sql));
    assert.ok(claim >= 0 && removed > claim);
    assert.equal(fs.existsSync(path.join(ROOT, "creds")), false);
  });
});
