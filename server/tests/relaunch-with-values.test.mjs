// Job.relaunchWithValues : a stored job relaunched with some fields changed, through the form
// engine - and the raw_form_data it is built from, stored without passwords (list rows too).
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

const form = {
  name: "Create host",
  subforms: [{ name: "acl", type: "subform", fields: [
    { name: "who", type: "text", required: true },
  ] }],
  fields: [
    { name: "host", type: "text", required: true, regex: { expression: "^prod-", description: "Must start with prod-" }, model: "vm.name" },
    { name: "size", type: "number", default: 10 },
    { name: "acls", type: "list", subform: "acl", deleteMarker: "deleted" },
  ],
};
vi.mock("../src/models/form.model.js", () => ({
  default: { load: vi.fn(async () => ({ constants: {}, forms: [structuredClone(form)] })) },
}));

const Job = (await import("../src/models/job.model.js")).default;
const Form = (await import("../src/models/form.model.js")).default;
const { filterRawFormData } = await import("../src/lib/formEngine/output.js");

const user = { username: "alice", type: "local", roles: ["default"], options: { allowJobRelaunch: true } };
const storedJob = () => ({
  id: 42, form: "Create host", status: "success", user: "alice", user_type: "local",
  extravars: JSON.stringify({ vm: { name: "prod-1" }, size: 10, acls: [{ who: "bob" }], __verbose__: true, ansibleforms_user: { username: "bob" } }),
  credentials: "{}",
  raw_form_data: JSON.stringify({ __form__: "Create host", host: "prod-1", size: 10, acls: [{ who: "bob", __output__: { who: "bob" } }] }),
});

beforeEach(() => {
  Job.findById = vi.fn(async () => storedJob());
  Job.launch = vi.fn(async () => ({ id: 43 }));
  Job.sendEventNotification = vi.fn(async () => {});
  Form.load.mockResolvedValue({ constants: {}, forms: [structuredClone(form)] });
});

describe("Job.relaunchWithValues", () => {
  test("the stored values with the change, launched as a new job by the caller", async () => {
    const r = await Job.relaunchWithValues({ user, id: 42, values: { size: 20 } });
    expect(r).toMatchObject({ id: 43, payloadHash: expect.stringMatching(/^sha256:/) });
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ form: "Create host", user, fromClient: true, validated: true });
    expect(arg.extravars).toEqual({ vm: { name: "prod-1" }, size: 20, acls: [{ who: "bob" }] });
    // the original's verbose flag and submitter are not carried over
    expect(arg.extravars.__verbose__).toBeUndefined();
    expect(arg.replay).toBeUndefined();
    expect(Job.sendEventNotification).toHaveBeenCalledWith(42, "relaunch", user);
  });

  test("a form with a password field cannot be relaunched with changes - the password is gone", async () => {
    const withPw = structuredClone(form);
    withPw.fields.push({ name: "pw", type: "password" });
    Form.load.mockResolvedValue({ constants: {}, forms: [withPw] });
    const err = await Job.relaunchWithValues({ user, id: 42, values: { size: 20, pw: "n3w" } }).catch((e) => e);
    expect(err).toMatchObject({ name: "BadRequestError", code: "unsupported", details: { passwordFields: ["pw"] } });
    expect(Job.launch).not.toHaveBeenCalled();
  });

  test("a password field its dependencies hide does not stand in the way", async () => {
    const hiddenPw = structuredClone(form);
    hiddenPw.fields.push({ name: "pw", type: "password", dependencies: [{ name: "MODE", values: ["manual"] }] });
    Form.load.mockResolvedValue({ constants: { MODE: "auto" }, forms: [hiddenPw] });
    await expect(Job.relaunchWithValues({ user, id: 42, values: { size: 20 } })).resolves.toMatchObject({ id: 43 });
    expect(Job.launch.mock.calls[0][0].extravars).toEqual({ vm: { name: "prod-1" }, size: 20, acls: [{ who: "bob" }] });
  });

  test("a password in a subform only counts too", async () => {
    const withRowPw = structuredClone(form);
    withRowPw.subforms[0].fields.push({ name: "token", type: "password" });
    Form.load.mockResolvedValue({ constants: {}, forms: [withRowPw] });
    const err = await Job.relaunchWithValues({ user, id: 42, values: { size: 20 }, preview: true }).catch((e) => e);
    expect(err).toMatchObject({ code: "unsupported", details: { passwordFields: ["acls[0].token"] } });
  });

  test("a preview builds and hashes without launching", async () => {
    const p = await Job.relaunchWithValues({ user, id: 42, values: { host: "prod-2" }, preview: true });
    expect(p.extravars).toMatchObject({ vm: { name: "prod-2" } });
    expect(Job.launch).not.toHaveBeenCalled();
    const again = await Job.relaunchWithValues({ user, id: 42, values: { host: "prod-2" }, expectedPayloadHash: p.payloadHash });
    expect(again.payloadHash).toBe(p.payloadHash);
    const err = await Job.relaunchWithValues({ user, id: 42, values: { host: "prod-3" }, expectedPayloadHash: p.payloadHash }).catch((e) => e);
    expect(err).toMatchObject({ name: "ConflictError", code: "payload_mismatch" });
  });

  test("a change that breaks a rule is refused with the failing fields", async () => {
    const err = await Job.relaunchWithValues({ user, id: 42, values: { host: "test-1", acls: [{ who: "" }] } }).catch((e) => e);
    expect(err).toMatchObject({ name: "ValidationError", code: "form_incomplete" });
    expect(err.details.validationErrors).toEqual({ host: [{ type: "regex", description: "Must start with prod-" }] });
    expect(err.details.rowErrors).toEqual({ acls: [{ index: 0, missing: ["who"] }] });
    expect(Job.launch).not.toHaveBeenCalled();
  });

  test("someone else's job - even one waiting for approval, which findById hands out - is not relaunched or previewed", async () => {
    Job.findById = vi.fn(async () => ({ ...storedJob(), user: "bob", status: "approve" }));
    await expect(Job.relaunchWithValues({ user, id: 42, preview: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    await expect(Job.relaunchWithValues({ user, id: 42 })).rejects.toMatchObject({ name: "AccessDeniedError" });
    // an admin, or a role that manages every user's jobs, may ; one that only sees them may not
    await expect(Job.relaunchWithValues({ user: { ...user, roles: ["admin"] }, id: 42, preview: true })).resolves.toHaveProperty("payloadHash");
    await expect(Job.relaunchWithValues({ user: { ...user, options: { ...user.options, manageAllJobs: true } }, id: 42, preview: true })).resolves.toHaveProperty("payloadHash");
    await expect(Job.relaunchWithValues({ user: { ...user, options: { ...user.options, showAllJobLogs: true } }, id: 42, preview: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  test("the relaunch permission and the verbose permission are checked", async () => {
    await expect(Job.relaunchWithValues({ user: { ...user, options: {} }, id: 42 })).rejects.toMatchObject({ name: "AccessDeniedError" });
    await expect(Job.relaunchWithValues({ user, id: 42, verbose: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  test("a job without stored form data cannot be relaunched with changes, and says why", async () => {
    Job.findById = vi.fn(async () => ({ ...storedJob(), raw_form_data: null }));
    const err = await Job.relaunchWithValues({ user, id: 42, values: { size: 20 } }).catch((e) => e);
    expect(err).toMatchObject({ name: "BadRequestError", code: "no_form_data" });
    expect(err.message).toContain("before form values were stored");
  });

  test("a running job is previewed but not relaunched", async () => {
    Job.findById = vi.fn(async () => ({ ...storedJob(), status: "running" }));
    await expect(Job.relaunchWithValues({ user, id: 42, preview: true })).resolves.toHaveProperty("payloadHash");
    await expect(Job.relaunchWithValues({ user, id: 42 })).rejects.toMatchObject({ name: "ConflictError" });
  });
});

describe("a relaunch without changes", () => {
  const withPw = () => {
    const f = structuredClone(form);
    f.fields.push({ name: "pw", type: "password", model: "secrets.pw" });
    return f;
  };
  const jobWithPw = () => ({ ...storedJob(), extravars: JSON.stringify({ vm: { name: "prod-1" }, size: 10, acls: [{ who: "bob" }], secrets: { pw: "s3cr3t" }, __verbose__: true }) });

  test("off / log: a replay of the stored extravars - passwords included, on the server", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [withPw()] });
    Job.findById = vi.fn(async () => jobWithPw());
    const r = await Job.relaunchWithValues({ user, id: 42 });
    expect(r).toMatchObject({ id: 43, replayed: true });
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ replay: true });
    expect(arg.extravars.secrets).toEqual({ pw: "s3cr3t" });
    expect(arg.extravars.__verbose__).toBeUndefined();
  });

  test("its preview masks the stored password", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [withPw()] });
    Job.findById = vi.fn(async () => jobWithPw());
    const p = await Job.relaunchWithValues({ user, id: 42, preview: true });
    expect(p).toMatchObject({ replayed: true, extravars: { secrets: { pw: "********" } } });
    expect(JSON.stringify(p)).not.toContain("s3cr3t");
    expect(Job.launch).not.toHaveBeenCalled();
  });

  test("enforce: through the engine - refused when a password field is shown", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [{ ...withPw(), launchValidation: "enforce" }] });
    Job.findById = vi.fn(async () => jobWithPw());
    await expect(Job.relaunchWithValues({ user, id: 42 })).rejects.toMatchObject({ code: "unsupported", details: { passwordFields: ["pw"] } });
    // the plain Relaunch (REST, browser button) takes the same road
    await expect(Job.relaunch(user, 42, false)).rejects.toMatchObject({ code: "unsupported" });
    expect(Job.launch).not.toHaveBeenCalled();
  });

  test("enforce: a hidden password field does not stand in the way - the server builds the extravars", async () => {
    const f = { ...structuredClone(form), launchValidation: "enforce", fields: [...form.fields, { name: "pw", type: "password", dependencies: [{ name: "MODE", values: ["manual"] }] }] };
    Form.load.mockResolvedValue({ constants: { MODE: "auto" }, forms: [f] });
    Job.findById = vi.fn(async () => jobWithPw());
    await Job.relaunch(user, 42, false);
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ validated: true });
    expect(arg.replay).toBeUndefined();
    expect(arg.extravars).toEqual({ vm: { name: "prod-1" }, size: 10, acls: [{ who: "bob" }] });
  });
});

describe("a wizard job relaunched", () => {
  const wizardForm = {
    name: "Create host", fields: [],
    wizard: [{ subform: "basics", defaultModel: "vm" }, { name: "extra", subform: "extras", optional: true }],
    subforms: [
      { name: "basics", type: "subform", fields: [
        { name: "host", type: "text", required: true, regex: { expression: "^prod-", description: "Must start with prod-" } },
        { name: "size", type: "number", default: 10 },
      ] },
      { name: "extras", type: "subform", fields: [{ name: "note", type: "text", required: true }] },
    ],
  };
  const wizardJob = () => ({
    ...storedJob(),
    extravars: JSON.stringify({ vm: { host: "prod-1", size: 10 } }),
    raw_form_data: JSON.stringify({ __form__: "Create host", __wizard__: true, drafts: { basics: { host: "prod-1", size: 10 } }, skipped: { extra: true } }),
  });
  beforeEach(() => {
    Form.load.mockResolvedValue({ constants: {}, forms: [structuredClone(wizardForm)] });
    Job.findById = vi.fn(async () => wizardJob());
  });

  test("with changes per step, through the engine ; the changed drafts are stored with the new job", async () => {
    const r = await Job.relaunchWithValues({ user, id: 42, values: { basics: { size: 20 } } });
    expect(r).toMatchObject({ id: 43, payloadHash: expect.stringMatching(/^sha256:/) });
    const arg = Job.launch.mock.calls[0][0];
    expect(arg.extravars).toEqual({ vm: { host: "prod-1", size: 20 } });
    expect(arg.rawFormData).toEqual({ __wizard__: true, drafts: { basics: { host: "prod-1", size: 20 } }, skipped: { extra: true } });
  });

  test("a skipped step given a change is walked again ; a change that breaks a rule is refused", async () => {
    const p = await Job.relaunchWithValues({ user, id: 42, values: { extra: { note: "n" } }, preview: true });
    expect(p.extravars).toEqual({ vm: { host: "prod-1", size: 10 }, note: "n" });
    expect(Job.launch).not.toHaveBeenCalled();
    await expect(Job.relaunchWithValues({ user, id: 42, values: { basics: { host: "dev-1" } } })).rejects.toMatchObject({ code: "form_incomplete" });
  });

  test("changes not given per step, or a job without its step drafts, are refused and say why", async () => {
    await expect(Job.relaunchWithValues({ user, id: 42, values: { size: 20 } })).rejects.toMatchObject({ code: "invalid_request", details: { steps: ["basics", "extra"] } });
    Job.findById = vi.fn(async () => ({ ...wizardJob(), raw_form_data: JSON.stringify({ __form__: "Create host", host: "prod-1" }) }));
    await expect(Job.relaunchWithValues({ user, id: 42, values: { basics: { size: 20 } } })).rejects.toMatchObject({ code: "unsupported" });
    expect(Job.launch).not.toHaveBeenCalled();
  });
});

describe("raw form data is stored without passwords", () => {
  test("in list rows too, nested and in their __output__", () => {
    const subforms = [
      { name: "u", fields: [{ name: "user", type: "text" }, { name: "pw", type: "password", model: "cred.pw" }, { name: "keys", type: "list", subform: "k" }] },
      { name: "k", fields: [{ name: "secret", type: "password" }, { name: "id", type: "text" }] },
    ];
    const out = filterRawFormData(
      [{ name: "users", type: "list", subform: "u" }, { name: "top", type: "password" }, { name: "c", type: "constant" }],
      { top: "x", c: 1, users: [{ user: "a", pw: "p1", keys: [{ id: 1, secret: "s" }], __output__: { user: "a", cred: { pw: "p1" }, keys: [{ id: 1, secret: "s" }] } }] },
      subforms,
    );
    expect(out).toEqual({ users: [{ user: "a", keys: [{ id: 1 }], __output__: { user: "a", cred: {}, keys: [{ id: 1 }] } }] });
  });
});

// a job an admin-level schedule launched, as the Schedule Service : its extravars are the
// schedule's own, and it has no form values (#1063)
describe("a job launched by a schedule", () => {
  const admin = { username: "root", type: "local", roles: ["admin"], options: { allowJobRelaunch: true } };
  const scheduleJob = () => ({ ...storedJob(), user: "Schedule Service", user_type: "schedule", raw_form_data: null });

  test("is relaunched without changes as it ran, even under enforce", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [{ ...structuredClone(form), launchValidation: "enforce" }] });
    Job.findById = vi.fn(async () => scheduleJob());
    await Job.relaunch(admin, 42, false);
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ replay: true, user: admin });
    expect(arg.extravars.vm).toEqual({ name: "prod-1" });
  });

  test("cannot be relaunched with changes, and says it is the schedule's", async () => {
    Job.findById = vi.fn(async () => scheduleJob());
    const err = await Job.relaunchWithValues({ user: admin, id: 42, values: { size: 20 } }).catch((e) => e);
    expect(err).toMatchObject({ code: "no_form_data" });
    expect(err.message).toContain("launched by a schedule");
  });

  test("under enforce, only who may manage schedules replays one: not a user who merely manages every job", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [{ ...structuredClone(form), launchValidation: "enforce" }] });
    Job.findById = vi.fn(async () => scheduleJob());
    const watcher = { username: "eve", type: "local", roles: ["ops"], options: { allowJobRelaunch: true, manageAllJobs: true } };
    await expect(Job.relaunch(watcher, 42, false)).rejects.toMatchObject({ code: "no_form_data" });
    expect(Job.launch).not.toHaveBeenCalled();
    await Job.relaunch({ ...watcher, options: { ...watcher.options, allowScheduledJobs: true } }, 42, false);
    expect(Job.launch).toHaveBeenCalledTimes(1);
  });

  test("a user's job without form values under enforce is still refused, not replayed", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [{ ...structuredClone(form), launchValidation: "enforce" }] });
    Job.findById = vi.fn(async () => ({ ...storedJob(), raw_form_data: null }));
    await expect(Job.relaunch(user, 42, false)).rejects.toMatchObject({ code: "no_form_data" });
    expect(Job.launch).not.toHaveBeenCalled();
  });
});
