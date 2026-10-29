// A raw expression (POST /api/v2/expression with an `expression` of its own) runs with the server's
// reach : fn.fnReadYamlFile reads any file. It is a designer's who may edit the forms only when they
// see every form, playbook and workflow (lib/expressionPolicy.js mayRunRawExpression) : a designer
// limited by designAllForms, designAllPlaybooks or designAllWorkflows read the forms and the
// playbooks hidden from them through it. showSettings, and an admin, still run one.
import { test, describe, beforeAll, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const { mayRunRawExpression, resolveExpression } = await import("../src/lib/expressionPolicy.js");

const designer = (options = {}) => ({ username: "olga", roles: ["ops"], options: { showDesigner: true, allowFormDesign: true, ...options } });
const raw = (user) => resolveExpression({ user: { user }, body: { expression: "fn.fnReadYamlFile('/app/persistent/forms/team.yaml')" }, query: {} });

beforeAll(() => {
  appConfig.showDesigner = true;
});

describe("a raw expression", () => {
  test("runs for a designer who edits the forms and sees every form, playbook and workflow", async () => {
    assert.equal(mayRunRawExpression(designer()), true);
    assert.equal((await raw(designer({ designAllForms: true, designAllPlaybooks: true, designAllWorkflows: true }))).expression, "fn.fnReadYamlFile('/app/persistent/forms/team.yaml')");
  });

  test("is refused to a designer some forms, playbooks or workflows are hidden from", async () => {
    for (const option of ["designAllForms", "designAllPlaybooks", "designAllWorkflows"]) {
      assert.equal(mayRunRawExpression(designer({ [option]: false })), false, option);
      await assert.rejects(raw(designer({ [option]: false })), { statusCode: 403 });
    }
  });

  test("still runs for settings access and for an admin, whatever the designer's options say", () => {
    assert.equal(mayRunRawExpression(designer({ designAllForms: false, showSettings: true })), true);
    assert.equal(mayRunRawExpression({ roles: ["admin"], options: { showDesigner: true, allowFormDesign: true, designAllForms: false } }), true);
  });
});
