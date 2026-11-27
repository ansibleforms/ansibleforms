// The form that started a job reaches the playbook as the extravar `__formname__` (issue #1567).
import { test } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { pushForminfoToExtravars, stripReservedExtravars } = await import("../src/models/job.model.js");

test("the form's name is passed as __formname__", () => {
  const extravars = {};
  pushForminfoToExtravars({ name: "Create VM", type: "ansible", playbook: "vm.yml" }, extravars);
  assert.equal(extravars.__formname__, "Create VM");
});

test("a client cannot set __formname__ itself", () => {
  const extravars = { __formname__: "Another form" };
  stripReservedExtravars(extravars, { name: "Create VM", fields: [] });
  pushForminfoToExtravars({ name: "Create VM", type: "ansible", playbook: "vm.yml" }, extravars);
  assert.equal(extravars.__formname__, "Create VM");
});
