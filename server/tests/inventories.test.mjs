// An inventory named by its name (inventory: production) : its folder, in the inventories folder
// or one of the inventories repositories ; anything else goes to ansible as it is. And the
// designer's inventories files from several repositories, each under its name.
import { test, describe, beforeAll, afterAll, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

const { resolveInventory } = await import("../src/lib/inventories.js");

describe("an inventory by its name", () => {
  const dirs = new Set(["/inv/staging", "/inv/lab", "/repos/production", "/repos/lab"]);
  const isDir = (p) => dirs.has(p);
  const roots = [
    { repository: null, root: "/inv" },
    { repository: "production", root: "/repos/production" },
  ];

  test("a repository used for inventories is the inventory of its name ; a local folder too", () => {
    assert.equal(resolveInventory("production", roots, isDir), "/repos/production");
    assert.equal(resolveInventory("staging", roots, isDir), "/inv/staging");
  });

  test("anything else goes to ansible as it is", () => {
    assert.equal(resolveInventory("hosts.yml", roots, isDir), "hosts.yml");
    assert.equal(resolveInventory("inventories/production/hosts.yml", roots, isDir), "inventories/production/hosts.yml");
    assert.equal(resolveInventory("nope", roots, isDir), "nope", "no such inventory");
    assert.equal(resolveInventory("..", roots, isDir), "..");
    assert.equal(resolveInventory(["x"], roots, isDir).length, 1, "not a string: as it is");
  });

  test("a name both a repository and a local folder must be renamed", () => {
    const both = [...roots, { repository: "lab", root: "/repos/lab" }];
    assert.throws(() => resolveInventory("lab", both, isDir), /Inventory 'lab' is both a repository and a folder/);
  });
});

describe("the inventories: the local folder and the repositories that are inventories", () => {
  let base;
  let ProjectFiles;
  beforeAll(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "af-inv-"));
    // the local folder : staging, and a folder hidden by the production repository
    fs.mkdirSync(path.join(base, "local/staging"), { recursive: true });
    fs.writeFileSync(path.join(base, "local/staging/inventory.yaml"), "all: {}\n");
    fs.mkdirSync(path.join(base, "local/production"), { recursive: true });
    fs.writeFileSync(path.join(base, "local/production/inventory.yaml"), "hidden: {}\n");
    // the production repository : the inventory at its root
    fs.mkdirSync(path.join(base, "repos/production/group_vars"), { recursive: true });
    fs.writeFileSync(path.join(base, "repos/production/inventory.yaml"), "all: {}\n");
    fs.writeFileSync(path.join(base, "repos/production/group_vars/all.yaml"), "x: 1\n");
    const { default: Repository } = await import("../src/models/repository.model.js");
    const { default: Repo } = await import("../src/models/repo.model.js");
    Repository.getInventoryRoots = async () => [
      { repository: null, root: path.join(base, "local") },
      { repository: "production", root: path.join(base, "repos/production") },
    ];
    Repository.claimForWrite = async () => undefined;
    // no forms repository : a write checks it is no form file (Form.formsFileTest)
    Repository.getFormsFolders = async () => [];
    Repo.hasChanges = vi.fn(async () => true);
    ({ default: ProjectFiles } = await import("../src/models/projectFiles.model.js"));
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  test("are listed side by side, each inventory at the top", async () => {
    const list = await ProjectFiles.list("inventories");
    assert.deepEqual(list.files.map((f) => f.path).sort(), [
      "production/group_vars/all.yaml",
      "production/inventory.yaml",
      "staging/inventory.yaml",
    ], "the local production folder is hidden by the repository");
    assert.deepEqual(list.repositories.map((r) => r.name), ["production"]);
    assert.equal(list.dirty, true);
  });

  test("are read, written and deleted where they are", async () => {
    assert.equal((await ProjectFiles.read("inventories", "production/group_vars/all.yaml")).content, "x: 1\n");
    assert.equal((await ProjectFiles.read("inventories", "staging/inventory.yaml")).content, "all: {}\n");
    await ProjectFiles.write("inventories", "production/host_vars/web1.yaml", "y: 2\n", true);
    assert.equal(fs.readFileSync(path.join(base, "repos/production/host_vars/web1.yaml"), "utf8"), "y: 2\n");
    await ProjectFiles.remove("inventories", "production/host_vars/web1.yaml");
    assert.equal(fs.existsSync(path.join(base, "repos/production/host_vars")), false, "the folder it leaves empty goes too");
    await ProjectFiles.write("inventories", "lab/inventory.yaml", "all: {}\n", true);
    assert.equal(fs.existsSync(path.join(base, "local/lab/inventory.yaml")), true, "a new inventory: in the local folder");
  });
});
