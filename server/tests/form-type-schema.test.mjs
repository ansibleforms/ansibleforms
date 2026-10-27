// The form schema (server/schema/form_schema.json) : a form's type names the product it runs on.
// A template form says `template:` or `job:` (not both), the AWX keys belong to the awx family
// only, and `type: template` (a 7.0 preview name, never released) is no type.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import Ajv from "ajv";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-06.json"));
const schema = JSON.parse(fs.readFileSync(new URL("../schema/form_schema.json", import.meta.url), "utf8"));
const validate = ajv.compile(schema);

const form = (over) => ({ name: "f", roles: ["admin"], fields: [], ...over });
const ok = (f) => assert.equal(validate(f), true, JSON.stringify(validate.errors));
const refused = (f) => assert.equal(validate(f), false, "should be refused");

describe("a form's type", () => {
  test("every product is a type ; template is not", () => {
    for (const type of ["awx", "aap", "ascender", "semaphore"]) ok(form({ type, template: "x" }));
    for (const type of ["rundeck", "jenkins"]) ok(form({ type, job: "x" }));
    ok(form({ type: "ansible", playbook: "x.yml" }));
    refused(form({ type: "template", template: "x" }));
  });

  test("template and job say the same: one of them, not both, not none", () => {
    ok(form({ type: "rundeck", template: "tests/af-demo" }));
    ok(form({ type: "awx", job: "deploy" }));
    refused(form({ type: "rundeck", template: "a", job: "b" }));
    refused(form({ type: "semaphore" }));
  });

  test("the AWX keys are the awx family's only", () => {
    ok(form({ type: "aap", template: "x", awxCredentials: ["c"], executionEnvironment: "ee", instanceGroups: ["g"], scm_branch: "main" }));
    for (const key of ["awxCredentials", "executionEnvironment", "instanceGroups", "scm_branch"]) {
      refused(form({ type: "semaphore", template: "x", [key]: key === "scm_branch" || key === "executionEnvironment" ? "v" : ["v"] }));
    }
  });

  test("a template form has no playbook, a playbook form no template", () => {
    refused(form({ type: "rundeck", job: "x", playbook: "y.yml" }));
    refused(form({ type: "ansible", playbook: "y.yml", template: "x" }));
  });

  test("a multistep's steps follow the same types", () => {
    ok(form({ type: "multistep", steps: [{ type: "jenkins", name: "build", job: "ci/build" }, { type: "ansible", name: "after", playbook: "x.yml" }] }));
    refused(form({ type: "multistep", steps: [{ type: "template", name: "build", template: "x" }] }));
  });
});

describe("a form in the chat", () => {
  test("a wizard form can be offered in the chat, as a form with fields can", () => {
    ok(form({ type: "ansible", playbook: "x.yml", enableForChat: true }));
    ok({ name: "w", roles: ["admin"], type: "ansible", playbook: "x.yml", wizard: [{ subform: "basics" }], enableForChat: true });
  });
});
