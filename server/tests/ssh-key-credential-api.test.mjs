// An SSH credential's private key and its passphrase never leave through the API : find all,
// find by id and find by name show both masked, as a password (issue #1345).
import { describe, test, expect, vi } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\n";
const row = () => ({ id: 1, name: "deploy", credential_type: "ssh", user: "ansible", password: "pw", client_key: KEY, key_passphrase: "open sesame" });

vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    findById: async () => row(),
    findAll: async () => [row()],
    findByName: async () => row(),
    usageCounts: async () => new Map(),
  },
}));
// no forms and no workflows name it
vi.mock("../src/models/form.model.js", () => ({ default: { load: async () => ({ forms: [] }) } }));
vi.mock("../src/models/workflowRun.js", () => ({ workflowCredentials: async () => [] }));
vi.mock("../src/auth/auth_entraid.js", () => ({ default: { initialize: async () => {} } }));
vi.mock("../src/auth/auth_oidc.js", () => ({ default: { initialize: async () => {} } }));

const { default: controller } = await import("../src/controllers/v2/credential.controller.js");

/**
 * Calls a controller handler as an admin, and gives what it answered.
 *
 * Args:
 *   handler (function): the handler.
 *   req (object): the request's query and params.
 *
 * Returns:
 *   Promise<object>: the JSON body it answered.
 */
function call(handler, req = {}) {
  return new Promise((resolve) => {
    const res = { status() { return this; }, json(data) { resolve(data); return this; } };
    handler({ headers: {}, user: { user: { username: "admin", roles: ["admin"] } }, query: {}, params: { id: "1" }, ...req }, res);
  });
}

describe("the API shows an SSH credential's key and passphrase masked", () => {
  test.each([
    ["find by id", () => call(controller.findById)],
    ["find all", () => call(controller.find)],
    ["find by name", () => call(controller.find, { query: { name: "deploy" } })],
  ])("%s", async (_, run) => {
    const text = JSON.stringify(await run());
    expect(text).not.toContain("OPENSSH");
    expect(text).not.toContain("open sesame");
    expect(text).toContain('"client_key":"**********"');
    expect(text).toContain('"key_passphrase":"**********"');
  });
});
