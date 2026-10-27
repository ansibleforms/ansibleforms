// The chat assistant's contracts : the model
// has no launch tool, a target must come from the operator, a summary launches exactly its
// payload once and only from the operator's click, a claimed launch that never happened is
// replaced, and the limits hold. The chat service and the MCP handlers are the real ones ;
// the models are fakes and the model is scripted.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

const { createChatService } = await import("../src/chat/service.js");
const { clearSessions } = await import("../src/chat/sessions.js");
const { clearPlans } = await import("../src/chat/plans.js");
const { TOOLS } = await import("../src/chat/tools.js");

const user = { username: "alice", type: "local", roles: ["default"], options: { allowJobRelaunch: true } };
const other = { username: "bob", type: "local", roles: ["default"], options: {} };

const FORMS = {
  "Create a snapshot": {
    name: "Create a snapshot", type: "ansible", playbook: "snap.yml", roles: ["default"], enableForChat: true,
    description: "Take a snapshot of volumes",
    fields: [
      { name: "cluster", type: "enum", values: ["bb8", "r2d2"], default: "__auto__", required: true, label: "Cluster" },
      { name: "svm", type: "enum", runLocal: true, expression: "({bb8:['svm_test','svm_prod'], r2d2:['svm_x']})['$(cluster)']", required: true, label: "SVM" },
      { name: "snapshot_name", type: "text", required: true, label: "Snapshot name", regex: { expression: "^[a-z_]+$", description: "lowercase" } },
      { name: "api_token", type: "text", default: "t0k3n" },
      { name: "ticket", type: "expression", expression: "fn.fnTicket()" },
      { name: "add_expiry", type: "checkbox", label: "Add expiry" },
      { name: "expiry", type: "text", dependencies: [{ name: "add_expiry", values: [true] }] },
    ],
  },
  "Health report": {
    name: "Health report", type: "ansible", playbook: "health.yml", roles: ["default"], enableForChat: true,
    description: "Report the health of the clusters",
    fields: [{ name: "scope", type: "text", default: "all" }],
  },
  "Delete everything": {
    name: "Delete everything", type: "ansible", playbook: "rm.yml", roles: ["default"],
    fields: [{ name: "target", type: "text", required: true }],
  },
};

// a wizard, offered in the chat only by the test that uses it
const WIZARD = {
  name: "Build a VM", type: "ansible", playbook: "vm.yml", roles: ["default"], enableForChat: true,
  description: "Build a virtual machine", fields: [],
  wizard: [
    { subform: "basics", defaultModel: "vm" },
    { name: "extra", subform: "extras", optional: true },
  ],
  subforms: [
    { name: "basics", type: "subform", fields: [
      { name: "vm_name", type: "text", required: true, label: "VM name" },
      { name: "cpus", type: "number", default: 2, label: "CPUs" },
    ] },
    { name: "extras", type: "subform", fields: [{ name: "note", type: "text", required: true, label: "Note" }] },
  ],
};

let deps, model, ticket;
function scripted(results) {
  const m = { calls: 0, toolNames: [], histories: [] };
  m.complete = vi.fn(async ({ tools, history }) => {
    m.calls++;
    m.toolNames = tools.map((t) => t.name);
    m.histories.push(structuredClone(history));
    return results.length ? results.shift() : { text: "ok", toolCalls: [] };
  });
  return m;
}
const say = (text) => ({ text, toolCalls: [] });
let n = 0;
const call = (name, args) => ({ text: "", toolCalls: [{ id: `c${++n}`, name, arguments: args }] });

function service(results, settings = {}) {
  model = scripted(results);
  return createChatService({
    deps,
    complete: model.complete,
    loadSettings: async () => ({ provider: "anthropic", api_key: "k", model: "m", max_turns: 20, max_tool_rounds: 6, allow_job_status: 1, ...settings }),
    audit: vi.fn(),
    enabled: () => true,
  });
}

beforeEach(() => {
  clearSessions();
  clearPlans();
  ticket = "T-1";
  deps = {
    Form: {
      load: vi.fn(async (roles, name) => {
        if (!name) return { forms: Object.values(FORMS).map((f) => structuredClone(f)) };
        if (!FORMS[name]) { const e = new Error(`No form ${name}`); e.name = "NotFoundError"; throw e; }
        return { constants: {}, forms: [structuredClone(FORMS[name])], errors: [], warnings: [] };
      }),
    },
    Job: {
      launch: vi.fn(async () => ({ id: 77 })),
      findById: vi.fn(async () => ({ id: 42, form: "Create a snapshot", status: "success", start: "s", end: "e", user: "alice", extravars: "{\"secret\":\"x\"}", output: "line" })),
      relaunchWithValues: vi.fn(async ({ preview }) => (preview
        ? { form: "Create a snapshot", extravars: { snapshot: "old", password: "********" }, credentials: {}, payloadHash: "sha256:r", warnings: [] }
        : { id: 88, payloadHash: "sha256:r", warnings: [] })),
    },
    Expression: { execute: vi.fn(async () => ticket) },
    Query: { findAll: vi.fn(async () => []) },
    resolveFormQuery: vi.fn(),
  };
});

const allToolText = (history) => history.filter((m) => m.role === "tool").map((m) => m.text).join("\n");

describe("the model cannot launch", () => {
  test("its tools are catalog, resolve, plan, relaunch and job - no launch, no execute", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["catalog", "resolve", "plan", "relaunch", "job"]);
  });

  test("a tool it invents never reaches AnsibleForms", async () => {
    const chat = service([call("launch_job", { form: "Create a snapshot" }), call("execute", {}), say("I cannot launch it.")]);
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "launch it" });
    expect(out.reply).toBe("I cannot launch it.");
    expect(model.toolNames).toEqual(["catalog", "resolve", "plan", "relaunch", "job"]);
    expect(deps.Job.launch).not.toHaveBeenCalled();
    expect(allToolText(model.histories.at(-1)).match(/unknown_tool/g)).toHaveLength(2);
  });

  test("a form without enableForChat is refused, even though the user may open it", async () => {
    const chat = service([call("resolve", { form: "Delete everything", answers: { target: "x" } }), say("no")]);
    const { sessionId } = await chat.openSession(user);
    await chat.message(user, { sessionId, message: "delete everything on x" });
    expect(allToolText(model.histories.at(-1))).toMatch(/unsupported_form/);
  });

  test("catalog lists only the chat forms, ranked", async () => {
    const chat = service([call("catalog", { query: "snapshot of volumes" }), say("You can take a snapshot.")]);
    const { sessionId } = await chat.openSession(user);
    await chat.message(user, { sessionId, message: "what can I run for snapshots?" });
    const payload = JSON.parse(model.histories.at(-1).find((m) => m.role === "tool").text);
    expect(payload.forms.map((f) => f.form)).toEqual(["Create a snapshot", "Health report"]);
  });
});

describe("the operator chooses the targets", () => {
  test("a value typed at the end of a sentence counts ; a longer name does not", async () => {
    const { typedByOperator } = await import("../src/chat/policy.js");
    expect(typedByOperator("vol_mirko", 'vol_mirko.  snap is "test_ai"')).toBe(true);
    expect(typedByOperator("vol_mirko", "use vol_mirko, please")).toBe(true);
    expect(typedByOperator("vol_mirko", "is it vol_mirko?")).toBe(true);
    expect(typedByOperator("vol", "vol.1")).toBe(false);
    expect(typedByOperator("vol", "vol-2")).toBe(false);
    expect(typedByOperator("vol.1", "take vol.1.")).toBe(true);
  });

  test("resolve asks the missing fields and offers the choices", async () => {
    const chat = service([call("resolve", { form: "Create a snapshot", answers: {} }), say("Which cluster?")]);
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "take a snapshot" });
    expect(out.choices).toEqual([{ slot: "cluster", label: "Cluster", options: [{ value: "bb8" }, { value: "r2d2" }] }]);
    const payload = JSON.parse(model.histories.at(-1).find((m) => m.role === "tool").text);
    expect(payload.status).toBe("needs_input");
    expect(payload.missing_fields.map((f) => f.slot)).toEqual(["cluster", "snapshot_name", "svm"].filter((s) => payload.missing_fields.some((f) => f.slot === s)));
  });

  test("a cluster the operator never named is refused, and __auto__ always", async () => {
    const chat = service([
      call("resolve", { form: "Create a snapshot", answers: { cluster: "r2d2" } }),
      call("resolve", { form: "Create a snapshot", answers: { cluster: "__auto__" } }),
      say("Which cluster?"),
    ]);
    const { sessionId } = await chat.openSession(user);
    await chat.message(user, { sessionId, message: "take a snapshot on bb8" });
    const text = allToolText(model.histories.at(-1));
    expect(text).toMatch(/operator_choice_required/);
    expect(text).toMatch(/auto_rejected/);
  });

  test("a clicked choice counts - but only a value the page offered", async () => {
    const chat = service([
      call("resolve", { form: "Create a snapshot", answers: {} }), say("Which cluster?"),
      call("resolve", { form: "Create a snapshot", answers: { cluster: "r2d2" } }), say("Which SVM?"),
      call("resolve", { form: "Create a snapshot", answers: { cluster: "evil" } }), say("?"),
    ]);
    const { sessionId } = await chat.openSession(user);
    await chat.message(user, { sessionId, message: "snapshot please" });
    await chat.message(user, { sessionId, message: "r2d2", selection: { slot: "cluster", value: "r2d2" } });
    expect(allToolText(model.histories.at(-1))).not.toMatch(/operator_choice_required/);
    await chat.message(user, { sessionId, message: "the other one", selection: { slot: "cluster", value: "evil" } });
    expect(allToolText(model.histories.at(-1).slice(-3))).toMatch(/operator_choice_required/);
  });

  test("an unknown slot is refused before AnsibleForms is asked, naming the real ones", async () => {
    const chat = service([call("resolve", { form: "Create a snapshot", answers: { volume: "v1" } }), say("?")]);
    const { sessionId } = await chat.openSession(user);
    await chat.message(user, { sessionId, message: "snapshot of v1" });
    expect(allToolText(model.histories.at(-1))).toMatch(/unknown_answer.*cluster, svm, snapshot_name/);
  });
});

describe("a summary launches exactly its payload, once, from the click", () => {
  const ready = { form: "Create a snapshot", answers: { cluster: "bb8", svm: "svm_test", snapshot_name: "daily" } };
  const planned = async (chat) => {
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "snapshot daily of svm_test on bb8" });
    return { sessionId, out };
  };

  test("a complete form becomes a Launch summary ; nothing is launched ; secrets masked ; switches listed", async () => {
    const chat = service([call("resolve", ready), say("Click Launch.")]);
    const { out } = await planned(chat);
    expect(out.proposals).toHaveLength(1);
    const p = out.proposals[0];
    expect(p).toMatchObject({ label: "Launch", form: "Create a snapshot" });
    expect(p.summary).toMatch(/Cluster bb8/);
    expect(p.extravars.api_token).toBe("********");
    expect(p.optionalSwitches.map((s) => s.slot)).toEqual(["add_expiry"]);
    // the card's table : the chosen values by label, an off switch left to the list above
    expect(p.fields.map((f) => f.value)).toContain("bb8");
    expect(p.fields.some((f) => f.label === "add_expiry" || f.value === false)).toBe(false);
    expect(deps.Job.launch).not.toHaveBeenCalled();
    expect(allToolText(model.histories.at(-1))).toMatch(/"status":"planned"/);
    expect(allToolText(model.histories.at(-1))).not.toContain("t0k3n");
  });

  test("the click launches it once ; a second click is plan_used ; another conversation is refused", async () => {
    const chat = service([call("resolve", ready), say("Click Launch.")]);
    const { sessionId, out } = await planned(chat);
    const planId = out.proposals[0].planId;
    const other = await chat.openSession(user);
    await expect(chat.approve(user, { sessionId: other.sessionId, planId })).rejects.toMatchObject({ code: "plan_wrong_session" });
    const done = await chat.approve(user, { sessionId, planId });
    expect(done.job.id).toBe(77);
    // the conversation knows the job now : the next question can be about it
    await chat.message(user, { sessionId, message: "did it work?" });
    expect(model.histories.at(-1).some((m) => m.role === "user" && /job 77 was launched/.test(m.text))).toBe(true);
    expect(deps.Job.launch).toHaveBeenCalledTimes(1);
    expect(deps.Job.launch.mock.calls[0][0]).toMatchObject({ form: "Create a snapshot", fromClient: true, validated: true });
    await expect(chat.approve(user, { sessionId, planId })).rejects.toMatchObject({ code: "plan_used" });
    expect(deps.Job.launch).toHaveBeenCalledTimes(1);
  });

  test("a click while a turn is answered is refused (409) and the plan stays usable", async () => {
    const chat = service([call("resolve", ready), say("Click Launch.")]);
    const { sessionId, out } = await planned(chat);
    const planId = out.proposals[0].planId;
    // a turn in progress : the model answers only when released
    let release;
    model.complete.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(say("still thinking")); }));
    const turn = chat.message(user, { sessionId, message: "and now?" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(chat.approve(user, { sessionId, planId })).rejects.toMatchObject({ code: "busy", status: 409 });
    expect(deps.Job.launch).not.toHaveBeenCalled();
    release();
    await turn;
    // the plan was not consumed by the refused click
    expect((await chat.approve(user, { sessionId, planId })).job.id).toBe(77);
  });

  test("a launch that ends while a turn runs adds its note after that turn", async () => {
    const chat = service([call("resolve", ready), say("Click Launch.")]);
    const { sessionId, out } = await planned(chat);
    const { getSession } = await import("../src/chat/sessions.js");
    // the launch waits until released
    let launchDone;
    deps.Job.launch.mockImplementationOnce(() => new Promise((resolve) => { launchDone = () => resolve({ id: 77 }); }));
    const click = chat.approve(user, { sessionId, planId: out.proposals[0].planId });
    await vi.waitFor(() => expect(launchDone).toBeTypeOf("function"));
    // a turn starts meanwhile, and its model answer waits too
    let release;
    model.complete.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(say("done")); }));
    const turn = chat.message(user, { sessionId, message: "hello" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    launchDone();
    await click;
    const session = getSession(sessionId, user);
    // not inside the running turn
    expect(session.messages.some((m) => /job 77 was launched/.test(m.text || ""))).toBe(false);
    release();
    await turn;
    // after it
    expect(session.messages.at(-1)).toMatchObject({ role: "user" });
    expect(session.messages.at(-1).text).toMatch(/job 77 was launched/);
  });

  test("another user cannot even reach the conversation", async () => {
    const chat = service([call("resolve", ready), say("Click Launch.")]);
    const { sessionId, out } = await planned(chat);
    await expect(chat.approve(other, { sessionId, planId: out.proposals[0].planId })).rejects.toMatchObject({ code: "session_not_found" });
    expect(deps.Job.launch).not.toHaveBeenCalled();
  });

  test("a payload that moved since the summary is refused (plan_stale), nothing launched", async () => {
    const chat = service([call("resolve", ready), say("Click Launch.")]);
    const { sessionId, out } = await planned(chat);
    ticket = "T-2"; // the server expression now answers differently
    await expect(chat.approve(user, { sessionId, planId: out.proposals[0].planId })).rejects.toMatchObject({ code: "plan_stale" });
    expect(deps.Job.launch).not.toHaveBeenCalled();
  });

  test("a read form gets a Launch button - it still waits for the click", async () => {
    const chat = service([call("resolve", { form: "Health report", answers: {} }), say("Click Launch.")]);
    const { out } = await planned(chat);
    expect(out.proposals[0].label).toBe("Launch");
    expect(deps.Job.launch).not.toHaveBeenCalled();
  });
});

describe("a wizard form", () => {
  beforeEach(() => { FORMS["Build a VM"] = WIZARD; });
  afterEach(() => { delete FORMS["Build a VM"]; });

  test("its slots are <step>.<field> ; an optional step nobody answered is skipped ; the click launches the merged steps", async () => {
    const chat = service([
      call("resolve", { form: "Build a VM", answers: {} }),
      call("resolve", { form: "Build a VM", answers: { "basics.vm_name": "web01" } }),
      say("Click Launch."),
    ]);
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "build vm web01" });
    const tools = model.histories.at(-1).filter((m) => m.role === "tool").map((m) => JSON.parse(m.text));
    expect(tools[0].status).toBe("needs_input");
    expect(tools[0].missing_fields.map((f) => f.slot)).toEqual(["basics.vm_name"]);
    expect(tools[0].note).toMatch(/extra/);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].extravars).toEqual({ vm: { vm_name: "web01", cpus: 2 } });
    await chat.approve(user, { sessionId, planId: out.proposals[0].planId });
    const launched = deps.Job.launch.mock.calls[0][0];
    expect(launched.extravars).toEqual({ vm: { vm_name: "web01", cpus: 2 } });
    expect(launched.rawFormData).toEqual({ __wizard__: true, drafts: { basics: { vm_name: "web01" } }, skipped: { extra: true } });
  });
});

describe("relaunch", () => {
  test("previews, the Relaunch button launches once with the previewed hash, credentials stay off the page", async () => {
    const chat = service([call("relaunch", { job_id: 42 }), say("Click Relaunch.")]);
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "run job 42 again" });
    const p = out.proposals[0];
    expect(p).toMatchObject({ label: "Relaunch", sourceJobId: 42 });
    expect(p.extravars.password).toBe("********");
    expect(deps.Job.relaunchWithValues).toHaveBeenCalledTimes(1);
    const done = await chat.approve(user, { sessionId, planId: p.planId });
    expect(done.job.id).toBe(88);
    const last = deps.Job.relaunchWithValues.mock.calls.at(-1)[0];
    expect(last).toMatchObject({ id: 42, preview: false, expectedPayloadHash: "sha256:r" });
    await expect(chat.approve(user, { sessionId, planId: p.planId })).rejects.toMatchObject({ code: "plan_used" });
  });

  test("the job id must be typed by the operator", async () => {
    const chat = service([call("relaunch", { job_id: 42 }), say("Which job?")]);
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "run my last job again" });
    expect(allToolText(model.histories.at(-1))).toMatch(/operator_choice_required/);
    expect(out.proposals).toEqual([]);
    expect(deps.Job.relaunchWithValues).not.toHaveBeenCalled();
  });
});

describe("the conversation loop", () => {
  test("a claimed launch that did not happen is nudged once, then replaced by the truth", async () => {
    const chat = service([say("The job has been launched."), say("The job has been launched.")]);
    const { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "go" });
    expect(out.reply).toMatch(/Nothing was launched/);
    expect(out.proposals).toEqual([]);
    expect(model.calls).toBe(2);
    expect(deps.Job.launch).not.toHaveBeenCalled();
  });

  test("an empty reply is retried once", async () => {
    const chat = service([say(""), say("Hello")]);
    const { sessionId } = await chat.openSession(user);
    expect((await chat.message(user, { sessionId, message: "hi" })).reply).toBe("Hello");
  });

  test("the message limit of a conversation refuses without calling the model", async () => {
    const chat = service([say("1"), say("2"), say("3")], { max_turns: 2 });
    const { sessionId } = await chat.openSession(user);
    await chat.message(user, { sessionId, message: "a" });
    await chat.message(user, { sessionId, message: "b" });
    await expect(chat.message(user, { sessionId, message: "c" })).rejects.toMatchObject({ code: "turn_limit", status: 429 });
    expect(model.calls).toBe(2);
  });

  test("too many tool rounds in one message stop", async () => {
    const chat = service(Array.from({ length: 10 }, () => call("catalog", { query: "x" })), { max_tool_rounds: 3 });
    const { sessionId } = await chat.openSession(user);
    await expect(chat.message(user, { sessionId, message: "loop" })).rejects.toMatchObject({ code: "tool_round_limit" });
  });

  test("job status only when the settings allow it, and never the extravars or the output", async () => {
    let chat = service([call("job", { job_id: 42 }), say("It succeeded.")]);
    let { sessionId } = await chat.openSession(user);
    const out = await chat.message(user, { sessionId, message: "status of job 42?" });
    expect(out.job).toEqual({ id: 42, form: "Create a snapshot", status: "success", start: "s", end: "e", user: "alice" });
    chat = service([call("job", { job_id: 42 }), say("I cannot.")], { allow_job_status: 0 });
    ({ sessionId } = await chat.openSession(user));
    await chat.message(user, { sessionId, message: "status of job 42?" });
    expect(allToolText(model.histories.at(-1))).toMatch(/not_allowed/);
  });

  test("off or unconfigured: no conversation", async () => {
    const off = createChatService({ deps, complete: vi.fn(), loadSettings: async () => ({}), enabled: () => false });
    await expect(off.openSession(user)).rejects.toMatchObject({ code: "chat_disabled" });
    expect(await off.config()).toEqual({ enabled: false });
    const unconfigured = createChatService({ deps, complete: vi.fn(), loadSettings: async () => ({ provider: "anthropic", api_key: "", model: "m" }), enabled: () => true });
    await expect(unconfigured.openSession(user)).rejects.toMatchObject({ code: "chat_not_configured", status: 503 });
    const on = service([]);
    expect(await on.config()).toEqual({ enabled: true, provider: "anthropic", model: "m", maxTurns: 20, jobStatus: true, examples: [] });
    // the welcome names this user's chat forms - never the ones without enableForChat
    expect((await on.config(user)).examples).toEqual(["Create a snapshot", "Health report"]);
  });
});

describe("the real form list carries the chat flags", () => {
  // Regression : Form.load without a form name trims every form to its tile info, and the
  // flags were not part of it - the catalog was always empty on a real instance while the
  // tests above (whose fake Form.load returns whole forms) passed.
  test("getFormInfo's list mode keeps enableForChat", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("../src/models/form.model.js", import.meta.url), "latin1");
    const list = src.slice(src.indexOf("function getFormInfo"), src.indexOf("else if(form.name == formName)"));
    expect(list).toMatch(/enableForChat: form\.enableForChat === true/);
  });
});
