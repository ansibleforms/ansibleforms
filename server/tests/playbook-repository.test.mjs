// A form names the repository its playbook runs from (playbookRepository, issue #1501) : several
// repositories may hold playbooks, and a form naming one runs from that repository's root, so its
// ansible.cfg, roles and collections apply. A form without one runs as before : the first
// repository used for playbooks, from its playbooks folder, else its root.
import { test, describe, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Ajv from "ajv";
import { createRequire } from "module";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { default: Repository } = await import("../src/models/repository.model.js");
const { default: Repo } = await import("../src/models/repo.model.js");
const { default: dbJobIO } = await import("../src/rte/jobio-db.js");
const { pushForminfoToExtravars, stripReservedExtravars } = await import("../src/models/job.model.js");
const { nodeForm } = await import("../src/models/workflowRun.js");
const { workflowsOf } = await import("../src/lib/workflowDefs.js");

afterEach(() => vi.restoreAllMocks());

// two repositories used for playbooks : "first" (added first, with a playbooks folder) and "infra"
const twoRepositories = () => {
  vi.spyOn(Repository, "playbooksRepositories").mockResolvedValue([{ id: 3, name: "first" }, { id: 7, name: "infra" }]);
  vi.spyOn(Repository, "getAnsiblePath").mockResolvedValue("/repos/first/playbooks");
  vi.spyOn(Repo, "folderOf").mockImplementation((name) => `/repos/${name}`);
};

describe("the folder a playbook runs from, on the controller and a database-mode RTE", () => {
  test("without playbookRepository : the first repository's playbooks folder, as before", async () => {
    twoRepositories();
    assert.equal(await dbJobIO.playbookDirectory(1, ""), "/repos/first/playbooks");
    assert.equal(await dbJobIO.playbookDirectory(1, "team"), "/repos/first/playbooks/team");
  });

  test("with one : that repository's root, its playbookSubPath from there", async () => {
    twoRepositories();
    assert.equal(await dbJobIO.playbookDirectory(1, "", "infra"), "/repos/infra");
    assert.equal(await dbJobIO.playbookDirectory(1, "playbooks", "infra"), "/repos/infra/playbooks");
    // the first one too : from its root, not its playbooks folder
    assert.equal(await dbJobIO.playbookDirectory(1, "", "first"), "/repos/first");
  });

  test("a repository not used for playbooks : refused, saying so", async () => {
    twoRepositories();
    await assert.rejects(dbJobIO.playbookDirectory(1, "", "forms"), /playbookRepository 'forms' is not a repository used for playbooks/);
  });
});

describe("the folder a playbook runs from, on a socket RTE", async () => {
  const { socketJobIO, jobs } = await import("../src/rte/socket/rte-socket.js");
  const sent = fs.mkdtempSync(path.join(os.tmpdir(), "af-pbrepo-"));
  afterEach(() => jobs.clear());

  test("the files sent with the job : the repository's root as sent, its sub path from there", async () => {
    jobs.set(81, { paths: { playbookRepo: "infra", playbookRoot: true }, dirs: { playbooks: sent } });
    assert.equal(await socketJobIO.playbookDirectory(81, ""), sent);
    assert.equal(await socketJobIO.playbookDirectory(81, "playbooks"), path.join(sent, "playbooks"));
  });

  test("files sent but none for the repository (not one used for playbooks) : refused, saying so", async () => {
    jobs.set(82, { paths: { playbookRepo: "forms", playbookRoot: true }, dirs: { inventories: [] } });
    await assert.rejects(socketJobIO.playbookDirectory(82, ""), /playbookRepository 'forms' is not a repository used for playbooks/);
  });

  test("a job without one : the files sent, as before", async () => {
    jobs.set(83, { paths: { playbookRepo: "first" }, dirs: { playbooks: sent } });
    assert.equal(await socketJobIO.playbookDirectory(83, ""), sent);
  });
});

describe("the Designer's Playbooks section", () => {
  test("the first repository as before, then each other one under its name, whole", async () => {
    twoRepositories();
    const { default: ProjectFiles } = await import("../src/models/projectFiles.model.js");
    const roots = await ProjectFiles.roots("playbooks");
    assert.equal(roots.length, 2);
    assert.deepEqual([roots[0].prefix, roots[0].root], ["", path.resolve("/repos/first/playbooks")]);
    assert.deepEqual(roots[1], { prefix: "infra", root: path.resolve("/repos/infra"), repository: "infra" });
  });

  test("one repository used for playbooks : one root, as before", async () => {
    vi.spyOn(Repository, "playbooksRepositories").mockResolvedValue([{ id: 3, name: "first" }]);
    vi.spyOn(Repository, "getAnsiblePath").mockResolvedValue("/repos/first/playbooks");
    const { default: ProjectFiles } = await import("../src/models/projectFiles.model.js");
    assert.equal((await ProjectFiles.roots("playbooks")).length, 1);
  });
});

describe("the form's key, its job and its workflow nodes", () => {
  test("a form's playbookRepository becomes the job's __playbookRepository__ ; a request never sets it", () => {
    const extravars = {};
    pushForminfoToExtravars({ type: "ansible", playbook: "playbooks/site.yml", playbookRepository: "infra" }, extravars);
    assert.equal(extravars.__playbookRepository__, "infra");
    assert.equal(extravars.__playbook__, "playbooks/site.yml");
    const sentByClient = { __playbookRepository__: "other", name: "x" };
    stripReservedExtravars(sentByClient, { type: "ansible", fields: [{ name: "name" }] });
    assert.equal(sentByClient.__playbookRepository__, undefined);
  });

  test("a workflow's playbook node : playbook_repository read from its file, and run as the form's key", () => {
    const [wf] = workflowsOf(`workflow_job_templates:
  - name: deploy
    workflow_nodes:
      - identifier: web
        playbook_repository: infra
        unified_job_template: { type: job_template, name: playbooks/site.yml }
`);
    assert.equal(wf.nodes[0].playbook_repository, "infra");
    const form = nodeForm(wf, wf.nodes[0], new Map());
    assert.equal(form.playbookRepository, "infra");
    assert.equal(form.playbook, "playbooks/site.yml");
    assert.equal(nodeForm(wf, { ...wf.nodes[0], playbook_repository: "" }, new Map()).playbookRepository, undefined);
  });

  test("the form schema : an ansible form may name one, a template form may not", () => {
    const require = createRequire(import.meta.url);
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-06.json"));
    const validate = ajv.compile(JSON.parse(fs.readFileSync(new URL("../schema/form_schema.json", import.meta.url), "utf8")));
    const form = (over) => ({ name: "f", roles: ["admin"], fields: [], ...over });
    assert.equal(validate(form({ type: "ansible", playbook: "playbooks/site.yml", playbookRepository: "infra" })), true, JSON.stringify(validate.errors));
    assert.equal(validate(form({ type: "awx", template: "x", playbookRepository: "infra" })), false);
  });
});
