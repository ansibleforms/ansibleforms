// Test connection on a runner's page shows the message the check route answers. For an RTE it
// says what the RTE reported of itself : its release, its Ansible version and, in socket mode,
// the app node holding its socket. Other runners keep the plain message.
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the runner and what its check() returns, set by each test
let stored;
let health;
vi.mock("../src/models/runner.model.js", () => ({
  SECRET_MASK: "********",
  default: {
    findById: async () => stored,
    check: async () => health,
  },
}));

const { default: controller, checkMessage } = await import("../src/controllers/v2/runner.controller.js");

// a request in a given language, as the af_language cookie sets it
const inLanguage = (lang) => ({ headers: { cookie: `af_language=${lang}` }, params: { id: 1 } });

// calls the check route and returns what it answered
async function callCheck(req) {
  let body;
  const res = { json: (b) => (body = b), status: () => res };
  await controller.check(req, res);
  return body;
}

describe("the message of Test connection", () => {
  test("a socket-mode RTE: its release, its Ansible version and the node holding its socket", () => {
    const msg = checkMessage(inLanguage("en"), { type: "rte" }, { version: "7.3.0", ansible: "2.18.1", socketNode: "app-1" });
    assert.equal(msg, "Runner connection is OK: AnsibleForms 7.3.0, Ansible core 2.18.1, on node app-1");
  });

  test("a database-mode RTE: its release and its Ansible version, no node", () => {
    const msg = checkMessage(inLanguage("en"), { type: "rte" }, { version: "7.3.0", ansible: "2.18.1" });
    assert.equal(msg, "Runner connection is OK: AnsibleForms 7.3.0, Ansible core 2.18.1");
  });

  test("an older ansible that prints no core version: shown as it said it", () => {
    const msg = checkMessage(inLanguage("en"), { type: "rte" }, { version: "7.3.0", ansible: "ansible-playbook 2.9.27" });
    assert.equal(msg, "Runner connection is OK: AnsibleForms 7.3.0, Ansible ansible-playbook 2.9.27");
  });

  test("an RTE without ansible: only its release", () => {
    const msg = checkMessage(inLanguage("en"), { type: "rte" }, { version: "7.3.0", ansible: null });
    assert.equal(msg, "Runner connection is OK: AnsibleForms 7.3.0");
  });

  test("an RTE that said nothing of itself: the plain message", () => {
    assert.equal(checkMessage(inLanguage("en"), { type: "rte" }, {}), "Runner connection is OK");
    assert.equal(checkMessage(inLanguage("en"), { type: "rte" }, undefined), "Runner connection is OK");
  });

  test("another type of runner: the plain message, whatever its details", () => {
    const msg = checkMessage(inLanguage("en"), { type: "semaphore" }, { user: "admin", version: "2.10" });
    assert.equal(msg, "Runner connection is OK");
  });

  test("translated, with the language's own separator", () => {
    const details = { version: "7.3.0", ansible: "2.18.1", socketNode: "app-1" };
    assert.equal(checkMessage(inLanguage("nl"), { type: "rte" }, details), "Runner verbinding is OK: AnsibleForms 7.3.0, Ansible core 2.18.1, op node app-1");
    assert.equal(checkMessage(inLanguage("zh"), { type: "rte" }, details), "运行器连接正常：AnsibleForms 7.3.0，Ansible core 2.18.1，位于节点 app-1");
  });

  test("every language has every part", async () => {
    const { default: i18n } = await import("../src/lib/i18n.js");
    const keys = ["runnerConnectionOkDetails", "runnerRteRelease", "runnerAnsibleCore", "runnerAnsible", "runnerOnNode", "runnerDetailsSeparator"];
    for (const lang of i18n.supportedLocales) {
      const { default: messages } = await import(`../src/locales/${lang}.js`);
      for (const key of keys) assert.ok(messages.resources?.[key], `${lang} has resources.${key}`);
    }
  });
});

describe("the check route", () => {
  test("answers an RTE's details in its message", async () => {
    stored = { id: 1, name: "rte-1", type: "rte" };
    health = { version: "7.3.0", ansible: "2.18.1", socketNode: "app-2" };
    const body = await callCheck(inLanguage("en"));
    assert.equal(body.result, "Runner connection is OK: AnsibleForms 7.3.0, Ansible core 2.18.1, on node app-2");
    assert.deepEqual(body.details, health);
  });
});
