// `payload` is the word a Rundeck job uses for what the form sends : POST /api/v2/job takes it as
// well as `extravars`, GET /api/v2/job/:id answers both. Neither is deprecated.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

let launched;
// the stored job the job read below was launched from
let stored_job_id = null;
vi.mock("../src/models/job.model.js", () => ({
  default: {
    launch: async (args) => { launched = args; return { id: 7 }; },
    relaunchOptions: async () => ({ failedHosts: ["web02"] }),
    findById: async () => ({ id: 7, status: "failed", extravars: JSON.stringify({ who: "Mirko" }), credentials: "{}", approval: "{}", notifications: "{}", subjobs: "", stored_job_id }),
  },
}));

// the stored job a job names (#1437) : any id is a stored job this viewer sees, named monthly
vi.mock("../src/lib/storedJobUse.js", () => ({
  storedJobOfJob: async (_user, id) => (id ? { id, name: "monthly" } : null),
}));

const { default: controller } = await import("../src/controllers/v2/job.controller.js");

const user = { user: { username: "ann", roles: ["admin"], options: { allowVerboseMode: true } } };
function res() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

beforeEach(() => { launched = null; stored_job_id = null; });

describe("payload and extravars", () => {
  test("POST takes extravars, and payload the same", async () => {
    await controller.launch({ body: { formName: "f", extravars: { who: "a" } }, user }, res());
    expect(launched.extravars).toEqual({ who: "a" });
    await controller.launch({ body: { formName: "f", payload: { who: "b" } }, user }, res());
    expect(launched.extravars).toEqual({ who: "b" });
  });

  test("the stored job the form was filled from is handed to the launch, none without one (#1437)", async () => {
    await controller.launch({ body: { formName: "f", extravars: {}, storedJobId: 12 }, user }, res());
    expect(launched.storedJobId).toBe(12);
    await controller.launch({ body: { formName: "f", extravars: {} }, user }, res());
    expect(launched.storedJobId).toBeNull();
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

  test("GET names the stored job it was launched from, without its bare id ; none without one (#1437)", async () => {
    const r = res();
    await controller.getJob({ params: { id: 7 }, query: {}, user }, r);
    const job = r.body?.data?.output ?? r.body;
    expect(job.storedJob).toBeNull();
    stored_job_id = 5;
    const r2 = res();
    await controller.getJob({ params: { id: 7 }, query: {}, user }, r2);
    const named = r2.body?.data?.output ?? r2.body;
    expect(named.storedJob).toEqual({ id: 5, name: "monthly" });
    expect(named.stored_job_id).toBeUndefined();
  });
});
