// A form or a workflow node runs its playbook from its own repository with `__self__` (issue
// #1501's follow-up) : the repository the form, or the workflow file, is read from. A form in no
// repository keeps __self__, and its launch is refused, saying why.
import { test, describe, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { SELF_REPOSITORY, selfRepository } = await import("../src/lib/selfRepository.js");
const { resolveSelfRepository } = await import("../src/models/form.model.js");
const { default: Repository } = await import("../src/models/repository.model.js");
const { pushForminfoToExtravars } = await import("../src/models/job.model.js");
const { nodeForm } = await import("../src/models/workflowRun.js");
const { workflowsOf } = await import("../src/lib/workflowDefs.js");

afterEach(() => vi.restoreAllMocks());

describe("__self__ as a playbook's repository", () => {
  test("the keyword, and a name kept as it is", () => {
    assert.equal(SELF_REPOSITORY, "__self__");
    assert.equal(selfRepository("__self__", "infra"), "infra");
    assert.equal(selfRepository("__self__", null), "__self__");
    assert.equal(selfRepository("other", "infra"), "other");
    assert.equal(selfRepository(undefined, "infra"), undefined);
  });

  test("a form read from a repository : that repository, on the form and on its steps", () => {
    const form = {
      name: "Deploy",
      playbookRepository: "__self__",
      steps: [{ type: "ansible", playbookRepository: "__self__" }, { type: "ansible", playbookRepository: "other" }, { type: "ansible" }],
    };
    const errors = [];
    resolveSelfRepository(form, "infra", (m) => errors.push(m));
    assert.equal(form.playbookRepository, "infra");
    assert.deepEqual(form.steps.map((s) => s.playbookRepository), ["infra", "other", undefined]);
    assert.deepEqual(errors, []);
  });

  test("a form in no repository : __self__ kept, and a load error naming the form", () => {
    const form = { name: "Deploy", playbookRepository: "__self__" };
    const errors = [];
    resolveSelfRepository(form, null, (m) => errors.push(m));
    assert.equal(form.playbookRepository, "__self__");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Form 'Deploy': playbookRepository __self__ names the repository the form is in, and the form is in none/);
  });

  test("its launch is refused, saying why", async () => {
    assert.throws(
      () => pushForminfoToExtravars({ name: "Deploy", type: "ansible", playbook: "site.yml", playbookRepository: "__self__" }, {}),
      /runs its playbook from its own repository \(playbookRepository: __self__\), and the form is in none/,
    );
    await assert.rejects(Repository.playbookRepositoryRoot("__self__"), /names the repository the form or the workflow is in, and it is in none/);
  });

  test("a resolved form launches from its repository", () => {
    const extravars = {};
    pushForminfoToExtravars({ name: "Deploy", type: "ansible", playbook: "site.yml", playbookRepository: "infra" }, extravars);
    assert.equal(extravars.__playbookRepository__, "infra");
  });

  test("a workflow node : the repository its workflow file is in", () => {
    const [wf] = workflowsOf(`workflow_job_templates:
  - name: deploy
    workflow_nodes:
      - identifier: web
        playbook_repository: __self__
        unified_job_template: { type: job_template, name: playbooks/site.yml }
`);
    assert.equal(nodeForm(wf, wf.nodes[0], new Map(), "", {}, "ops").playbookRepository, "ops");
    // the local workflows folder : kept, so its launch is refused
    assert.equal(nodeForm(wf, wf.nodes[0], new Map()).playbookRepository, "__self__");
    assert.equal(nodeForm(wf, { ...wf.nodes[0], playbook_repository: "infra" }, new Map(), "", {}, "ops").playbookRepository, "infra");
  });
});
