// A form's fields read the repository the form is in with $(__repository__.name) and
// $(__repository__.path) (issue #1501's follow-up) : the server's answer, the same in the form's
// subforms, both empty for a form in no repository, and never taken from the caller.
import { describe, test, expect, vi } from "vitest";
import path from "path";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { attachOwnRepository } = await import("../src/models/form.model.js");
const { resolveForm } = await import("../src/lib/formEngine/resolve.js");
const { evalSandbox } = await import("../src/lib/formEngine/node/sandbox.js");
const { resolveFormExpression } = await import("../src/lib/expressionPolicy.js");

const services = () => ({ evalSandbox, serverExpression: vi.fn(async (e) => e), query: vi.fn(async () => []) });

describe("__repository__", () => {
  test("a form in a repository : its name and its folder, the same for its subforms", () => {
    const form = { name: "Deploy", fields: [], subforms: [{ name: "row", fields: [] }] };
    attachOwnRepository(form, "infra");
    expect(form.ownRepository.name).toBe("infra");
    expect(path.isAbsolute(form.ownRepository.path)).toBe(true);
    expect(path.basename(form.ownRepository.path)).toBe("infra");
    expect(form.subforms[0].ownRepository).toEqual(form.ownRepository);
  });

  test("a form in no repository : both empty", () => {
    const form = { name: "Deploy", fields: [] };
    attachOwnRepository(form, null);
    expect(form.ownRepository).toEqual({ name: "", path: "" });
  });

  test("its fields read it, empty when the form is in none", async () => {
    const own = { name: "infra", path: "/repos/infra" };
    const res = await resolveForm({
      form: {
        name: "Deploy",
        ownRepository: own,
        fields: [{ name: "file", type: "local", expression: "'$(__repository__.path)/extra_vars/my.yml'" }],
      },
      services: services(),
    });
    expect(res.fields[0].value).toBe("/repos/infra/extra_vars/my.yml");
    const empty = await resolveForm({
      form: { name: "Deploy", ownRepository: { name: "", path: "" }, fields: [{ name: "n", type: "local", expression: "'[$(__repository__.name)]'" }] },
      services: services(),
    });
    expect(empty.fields[0].value).toBe("[]");
  });

  test("a server expression reads the server's, never the caller's", async () => {
    const formObj = {
      name: "Deploy",
      ownRepository: { name: "infra", path: "/repos/infra" },
      fields: [{ name: "list", type: "expression", expression: "fn.fnReadYamlFile('$(__repository__.path)/vars.yml', '.my_list')" }],
    };
    const { expression } = await resolveFormExpression({
      user: { username: "bob", roles: ["default"] },
      formName: "Deploy",
      fieldName: "list",
      values: { "__repository__.path": "/etc" },
      formConfig: { forms: [formObj], constants: {} },
    });
    expect(expression).toContain("/repos/infra/vars.yml");
    expect(expression).not.toContain("/etc");
  });
});
