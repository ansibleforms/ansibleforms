// A designer save the user got wrong answers as the user's mistake, with its message : an
// invalid form 400, a forbidden change 403, a duplicate form name 409. It used to answer 500
// for all of them, which read as a broken server. Only a real failure stays a 500.
// The designer's check (POST /api/v2/config/check) answers an invalid configuration the same.
import { describe, test, expect, vi, beforeEach } from "vitest";
import yaml from "yaml";

vi.setConfig({ testTimeout: 30000 });

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

const roles = [{ name: "admin", groups: ["local/admins"] }, { name: "default", groups: [] }];
const form = (name, extra = {}) => ({ name, type: "ansible", playbook: "x.yaml", roles: ["default"], categories: [], fields: [], source: "demo.yaml", ...extra });
const payload = (forms) => ({ forms: yaml.stringify({ categories: [{ name: "Default", icon: "bars" }], roles, constants: {}, forms }) });

describe("Form.save refuses what the user got wrong with a status of its own", () => {
  const load = async () => (await import("../src/models/form.model.js")).default;

  test("a form name used twice is a conflict (409)", async () => {
    const Form = await load();
    const err = await Form.save(payload([form("Deploy"), form("Deploy", { source: "other.yaml" })])).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/'Deploy' already exists/);
  });

  test("a form failing validation is a bad request (400), with the validation message", async () => {
    const Form = await load();
    // a playbook form without its playbook
    const err = await Form.save(payload([form("Deploy", { playbook: undefined })])).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/playbook/);
  });

  test("text that is not yaml is a bad request (400)", async () => {
    const Form = await load();
    const err = await Form.save({ forms: "roles: [unclosed" }).catch((e) => e);
    expect(err.status).toBe(400);
  });

  test("a form without a file is a bad request (400)", async () => {
    const Form = await load();
    const err = await Form.save(payload([form("Deploy", { source: undefined })])).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/not in a file: Deploy/);
  });

  test("a file outside the forms folder is a bad request (400)", async () => {
    const Form = await load();
    const err = await Form.save(payload([form("Deploy", { source: "../escape.yaml" })])).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Invalid form source/);
  });
});

describe("the save endpoint answers the refusal's status", () => {
  let saveImpl;
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../src/models/lock.model.js", () => ({
      default: { status: async () => ({ free: false, match: true }), set: async () => {}, delete: async () => {} },
    }));
    vi.doMock("../src/models/settings.model.js", () => ({
      default: { getActiveConfig: async () => yaml.stringify({ roles }) },
    }));
    vi.doMock("../src/models/form.model.js", () => {
      // the controller builds a Form of the body, then hands it to Form.parse and Form.save
      class Form { constructor(body) { this.forms = body.forms; } }
      Form.parse = (d) => yaml.parse(d.forms);
      Form.save = (...a) => saveImpl(...a);
      return { default: Form };
    });
  });

  const call = async (body) => {
    const controller = (await import("../src/controllers/v2/config.controller.js")).default;
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const user = { username: "dee", roles: ["admin"], options: { showDesigner: true } };
    await controller.save({ body, user: { user }, ip: "127.0.0.1", headers: {} }, res);
    return res;
  };

  test.each([
    ["a duplicate form name", "ConflictError", 409],
    ["an invalid form", "BadRequestError", 400],
    ["a forbidden change", "AccessDeniedError", 403],
    ["a form that is not there", "NotFoundError", 404],
  ])("%s answers %s's status, with its message", async (_what, cls, status) => {
    const Errors = (await import("../src/lib/errors.js")).default;
    saveImpl = async () => { throw new Errors[cls]("the reason"); };
    const res = await call(payload([form("Deploy")]));
    expect(res.statusCode).toBe(status);
    expect(res.body.details).toBe("the reason");
  });

  test("a real failure stays a 500", async () => {
    saveImpl = async () => { throw new Error("disk full"); };
    const res = await call(payload([form("Deploy")]));
    expect(res.statusCode).toBe(500);
    expect(res.body.details).toBe("disk full");
  });
});

describe("the check endpoint answers an invalid configuration as the save does", () => {
  const call = async (body) => {
    vi.resetModules();
    vi.doUnmock("../src/models/form.model.js");
    const controller = (await import("../src/controllers/v2/config.controller.js")).default;
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await controller.validate({ body, headers: {} }, res);
    return res;
  };

  test("a valid configuration passes", async () => {
    const res = await call(payload([form("Deploy")]));
    expect(res.statusCode).toBe(200);
  });

  test("a form failing validation is a bad request (400), with the validation message", async () => {
    const res = await call(payload([form("Deploy", { playbook: undefined })]));
    expect(res.statusCode).toBe(400);
    expect(res.body.details).toMatch(/playbook/);
  });

  test("text that is not yaml is a bad request (400)", async () => {
    const res = await call({ forms: "roles: [unclosed" });
    expect(res.statusCode).toBe(400);
  });
});
