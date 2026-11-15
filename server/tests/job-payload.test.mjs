// `payload` is the word a Rundeck job uses for what the form sends : POST /api/v2/job takes it as
// well as `extravars`, GET /api/v2/job/:id answers both. Neither is deprecated.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

let launched;
vi.mock("../src/models/job.model.js", () => ({
  default: {
    launch: async (args) => { launched = args; return { id: 7 }; },
    relaunchOptions: async () => ({ failedHosts: ["web02"] }),
    findById: async () => ({ id: 7, status: "failed", extravars: JSON.stringify({ who: "Mirko" }), credentials: "{}", approval: "{}", notifications: "{}", subjobs: "" }),
  },
}));

const { default: controller } = await import("../src/controllers/v2/job.controller.js");

const user = { user: { username: "ann", roles: ["admin"], options: { allowVerboseMode: true } } };
function res() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

beforeEach(() => { launched = null; });

describe("payload and extravars", () => {
  test("POST takes extravars, and payload the same", async () => {
    await controller.launch({ body: { formName: "f", extravars: { who: "a" } }, user }, res());
    expect(launched.extravars).toEqual({ who: "a" });
    await controller.launch({ body: { formName: "f", payload: { who: "b" } }, user }, res());
    expect(launched.extravars).toEqual({ who: "b" });
  });

  test("both sent: extravars wins", async () => {
    await controller.launch({ body: { formName: "f", extravars: { who: "a" }, payload: { who: "b" } }, user }, res());
    expect(launched.extravars).toEqual({ who: "a" });
  });

  test("GET answers both names", async () => {
    const r = res();
    await controller.getJob({ params: { id: 7 }, query: {}, user }, r);
    const job = r.body?.data?.output ?? r.body;
    expect(job.extravars).toEqual({ who: "Mirko" });
    expect(job.payload).toEqual(job.extravars);
    // an ended job carries what its Relaunch offers, so the page draws it with its other buttons
    expect(job.relaunchOptions).toEqual({ failedHosts: ["web02"] });
  });
});
