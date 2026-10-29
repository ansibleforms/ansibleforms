// The designer's file explorers (models/projectFiles.model.js) never list, read, write nor delete a
// file a usage type of its repository owns (lib/repoObjects/ownedPaths.js), by its content : each
// file giving the key of a type the repository holds (roles:, credentials:, general: ... any name,
// any folder), config.yaml of before, and the images a logo: or icon: map names ; nor write a file
// whose content would give such a key. A repository used for workflows (its root the explorer's) and
// for the roles as well let a designer write roles.yaml, and so make themselves an admin ;
// credentials and general.yaml were read the same way.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).db }));
vi.mock("../src/models/repo.model.js", async () => {
  const fx = await import("./fixtures/repoObjects.mjs");
  return { default: { ...fx.repo, hasChanges: async () => false }, repoFolder: fx.repo.folderOf };
});
vi.mock("../src/models/repository.model.js", async () => {
  const fx = await import("./fixtures/repoObjects.mjs");
  const path = await import("path");
  const ops = { repository: "ops", root: path.join(fx.ROOT, "ops") };
  // the files the base configuration may be served from, as the model gives them
  const { default: actual } = await vi.importActual("../src/models/repository.model.js");
  return {
    default: {
      ...fx.repository,
      getConfigCandidates: actual.getConfigCandidates,
      // the workflows and the inventories : a local folder, then the repository's root
      getWorkflowsRoots: async () => [{ repository: null, root: path.join(fx.ROOT, "local") }, ops],
      getInventoryRoots: async () => [{ repository: null, root: path.join(fx.ROOT, "local") }, ops],
      // its playbooks : its root (no playbooks folder)
      getAnsiblePath: async () => ops.root,
      getVarsFilesPath: async () => path.join(fx.ROOT, "vars"),
    },
  };
});
vi.mock("../src/lib/crypto.js", async () => ({ default: (await import("./fixtures/repoObjects.mjs")).crypto }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const fx = await import("./fixtures/repoObjects.mjs");
const appConfig = (await import("./__mocks__/app.config.js")).default;
const { default: ProjectFiles } = await import("../src/models/projectFiles.model.js");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(fx.ROOT, "ops", rel)), { recursive: true });
  fs.writeFileSync(path.join(fx.ROOT, "ops", rel), text);
};
const ROLES = YAML.stringify({ roles: [{ name: "admin", groups: ["local/admins"] }] });
const ESCALATE = YAML.stringify({ roles: [{ name: "admin", groups: ["local/admins"], users: ["local/eve"] }] });

beforeEach(() => {
  appConfig.repoPath = fx.ROOT;
  fx.reset({
    repositories: [
      { id: 1, name: "ops", use_for_workflows: 1, use_for_inventories: 1, use_for_playbooks: 1, use_for_roles: 1, use_for_constants: 1, use_for_credentials: 1, use_for_general: 1, use_for_logo: 1, use_for_name: 1, use_for_repositories: 1 },
    ],
  });
  fs.mkdirSync(path.join(fx.ROOT, "local"), { recursive: true });
  write("roles.yaml", ROLES);
  write("config.yaml", YAML.stringify({ constants: { env: "prod" } }));
  write("credentials/git.yaml", YAML.stringify({ credentials: [{ name: "git", password: "${GIT_PASSWORD}" }] }));
  write("general.yaml", "general:\n  LOG_LEVEL: info\n");
  write("repositories.yaml", "repositories: []\n");
  // the logo's map names its image relative to its file
  write("branding/logo.yaml", YAML.stringify({ logo: { logo: "../images/logo.png" } }));
  write("name.yaml", YAML.stringify({ name: { app_name: "Ops" } }));
  write("images/logo.png", PNG);
  write("deploy.yml", "workflow_job_templates: []\n");
});

const denied = { status: 403, message: /(holds|gives) .+ of repository 'ops': it is not (read nor )?written in the designer/ };

describe("a file a usage type of the repository owns", () => {
  test("is never written : roles.yaml through the workflows explorer leaves the roles as they are", async () => {
    await assert.rejects(ProjectFiles.write("workflows", "ops/roles.yaml", ESCALATE), { status: 403, message: "'ops/roles.yaml' holds the roles of repository 'ops': it is not read nor written in the designer" });
    assert.equal(fs.readFileSync(path.join(fx.ROOT, "ops", "roles.yaml"), "utf8"), ROLES);
    // config.yaml (the keys read from it, deprecated), a new file of an object type's folder, a list file
    await assert.rejects(ProjectFiles.write("workflows", "ops/config.yaml", ESCALATE), denied);
    await assert.rejects(ProjectFiles.write("inventories", "ops/credentials/new.yaml", "credentials:\n  - name: new\n", true), denied);
    await assert.rejects(ProjectFiles.write("playbooks", "repositories.yaml", "repositories: []\n"), denied);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "ops", "credentials", "new.yaml")), false);
  });

  test("is never read, nor deleted : credentials, general.yaml, name.yaml, the logo its map names", async () => {
    await assert.rejects(ProjectFiles.read("workflows", "ops/credentials/git.yaml"), denied);
    await assert.rejects(ProjectFiles.read("playbooks", "general.yaml"), denied);
    await assert.rejects(ProjectFiles.read("inventories", "ops/images/logo.png"), denied);
    await assert.rejects(ProjectFiles.remove("workflows", "ops/branding/logo.yaml"), denied);
    await assert.rejects(ProjectFiles.remove("workflows", "ops/name.yaml"), denied);
    assert.ok(fs.existsSync(path.join(fx.ROOT, "ops", "branding", "logo.yaml")));
    assert.ok(fs.existsSync(path.join(fx.ROOT, "ops", "name.yaml")));
  });

  test("is never listed ; the explorer's own files are", async () => {
    const listed = (await ProjectFiles.list("workflows")).files.map((f) => f.path);
    assert.deepEqual(listed, ["ops/deploy.yml"]);
    assert.equal((await ProjectFiles.read("workflows", "ops/deploy.yml")).content, "workflow_job_templates: []\n");
    await ProjectFiles.write("workflows", "ops/deploy.yml", "workflow_job_templates: [] # edited\n");
  });

  test("is never made through a linked folder : a new roles.yaml or credential lands where its link leads", async () => {
    // a link committed in git, to the repository's own root
    fs.rmSync(path.join(fx.ROOT, "ops", "roles.yaml"));
    fs.symlinkSync(".", path.join(fx.ROOT, "ops", "sub"));
    await assert.rejects(ProjectFiles.write("workflows", "ops/sub/roles.yaml", ESCALATE, true), denied);
    await assert.rejects(ProjectFiles.write("workflows", "ops/sub/credentials/evil.yaml", "credentials:\n  - name: evil\n", true), denied);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "ops", "roles.yaml")), false);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "ops", "credentials", "evil.yaml")), false);
  });

  test("by its content, whatever its name or folder : a file giving a key the repository holds is refused, written or read", async () => {
    // any name, any depth
    await assert.rejects(ProjectFiles.write("workflows", "ops/a/b/c/anything.yml", ESCALATE, true), {
      status: 403,
      message: "'ops/a/b/c/anything.yml' gives roles:, the roles of repository 'ops': it is not written in the designer",
    });
    assert.equal(fs.existsSync(path.join(fx.ROOT, "ops", "a")), false);
    // a file of the explorer's turned into one : refused, left as it was
    await assert.rejects(ProjectFiles.write("workflows", "ops/deploy.yml", "workflow_job_templates: []\ncredentials:\n  - name: x\n"), denied);
    assert.equal(fs.readFileSync(path.join(fx.ROOT, "ops", "deploy.yml"), "utf8"), "workflow_job_templates: []\n");
    // one written in git elsewhere : hidden and refused as soon as it gives the key
    write("team/extra.yaml", YAML.stringify({ notes: "kept", labels: [] , credentials: [{ name: "x" }] }));
    assert.equal((await ProjectFiles.list("workflows")).files.some((f) => f.path === "ops/team/extra.yaml"), false);
    await assert.rejects(ProjectFiles.read("workflows", "ops/team/extra.yaml"), denied);
    // a key the repository does not hold, a form, a file named as a type's : the designer's
    await ProjectFiles.write("workflows", "ops/labels.yaml", "labels:\n  - name: PROD\n");
    await ProjectFiles.write("workflows", "ops/credentials-notes.yaml", "notes: about the credentials\n");
    await ProjectFiles.write("workflows", "ops/form.yaml", YAML.stringify({ name: "a form", type: "ansible", roles: ["public"], icon: "x" }));
    const listed = (await ProjectFiles.list("workflows")).files.map((f) => f.path);
    assert.deepEqual(listed, ["ops/credentials-notes.yaml", "ops/deploy.yml", "ops/form.yaml", "ops/labels.yaml"]);
  });

  test("belongs to the type only while the repository is used for it", async () => {
    fx.reset({ repositories: [{ id: 1, name: "ops", use_for_workflows: 1 }] });
    await ProjectFiles.write("workflows", "ops/roles.yaml", "# notes\n");
    assert.equal((await ProjectFiles.read("workflows", "ops/roles.yaml")).content, "# notes\n");
    await ProjectFiles.write("workflows", "ops/roles.yaml", ROLES);
    assert.equal((await ProjectFiles.read("workflows", "ops/roles.yaml")).content, ROLES);
  });
});

describe("the file the whole base configuration is served from (no repository holds the roles)", () => {
  // the 7.3 layout : the roles in the forms repository's config.yaml, no repository flagged for the
  // roles, the categories nor the constants ; the repository used for workflows and playbooks too
  beforeEach(() => {
    fx.reset({ repositories: [{ id: 1, name: "ops", use_for_forms: 1, use_for_workflows: 1, use_for_playbooks: 1, use_for_inventories: 1 }] });
    write("forms/a.yaml", "name: a\n");
    write("config.yaml", ROLES);
    appConfig.formsStagingPath = path.join(fx.ROOT, "staging");
    appConfig.formsFolderPath = path.join(fx.ROOT, "localforms");
  });

  test("is never read, written nor deleted : a designer cannot add themselves to the admin role", async () => {
    const owned = { status: 403, message: "'ops/config.yaml' holds the configuration of repository 'ops': it is not read nor written in the designer" };
    await assert.rejects(ProjectFiles.read("workflows", "ops/config.yaml"), owned);
    await assert.rejects(ProjectFiles.write("workflows", "ops/config.yaml", ESCALATE), owned);
    await assert.rejects(ProjectFiles.write("playbooks", "config.yaml", ESCALATE), denied);
    await assert.rejects(ProjectFiles.remove("inventories", "ops/config.yaml"), denied);
    assert.equal(fs.readFileSync(path.join(fx.ROOT, "ops", "config.yaml"), "utf8"), ROLES);
    assert.equal((await ProjectFiles.list("workflows")).files.some((f) => f.path === "ops/config.yaml"), false);
  });

  test("is never made either : a config.yaml written there would be served", async () => {
    fs.rmSync(path.join(fx.ROOT, "ops", "config.yaml"));
    await assert.rejects(ProjectFiles.write("workflows", "ops/config.yaml", ESCALATE, true), denied);
    assert.equal(fs.existsSync(path.join(fx.ROOT, "ops", "config.yaml")), false);
  });

  test("is the designer's again once a repository holds the roles : it is no longer served", async () => {
    fx.reset({ repositories: [{ id: 1, name: "ops", use_for_forms: 1, use_for_workflows: 1 }, { id: 2, name: "keys", use_for_roles: 1 }] });
    write("forms/a.yaml", "name: a\n");
    await ProjectFiles.write("workflows", "ops/config.yaml", "# notes\n");
    assert.equal((await ProjectFiles.read("workflows", "ops/config.yaml")).content, "# notes\n");
  });
});

describe("a local folder holding the repositories' folder", () => {
  test("never reaches a repository's owned files through it", async () => {
    // the local playbooks folder (ANSIBLE_PATH) a parent of the repositories' root
    fx.reset({ repositories: [{ id: 1, name: "ops", use_for_roles: 1 }] });
    write("roles.yaml", ROLES);
    const { default: Repository } = await import("../src/models/repository.model.js");
    const spy = vi.spyOn(Repository, "getAnsiblePath").mockResolvedValue(path.dirname(fx.ROOT));
    try {
      const rel = `${path.basename(fx.ROOT)}/ops/roles.yaml`;
      await assert.rejects(ProjectFiles.write("playbooks", rel, ESCALATE), denied);
      assert.equal(fs.readFileSync(path.join(fx.ROOT, "ops", "roles.yaml"), "utf8"), ROLES);
    } finally {
      spy.mockRestore();
    }
  });
});
