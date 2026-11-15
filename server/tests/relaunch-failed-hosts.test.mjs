// A job re-run on the hosts it failed on (POST /api/v2/job/:id/relaunch with failedHostsOnly) :
// the failed hosts from its events or its PLAY RECAP, the limit the re-run gets (a limit file of
// literal names, within the job's own limit), the same rights and validation as a relaunch, and
// AWX's own relaunch with `hosts: failed` for a template job.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the database : the queries of these tests answered by `db`
const db = { events: [], recap: [], job: null, outputs: [] };
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: vi.fn(async (sql, params) => {
      if (sql.includes("FROM AnsibleForms.`job_events`")) return db.events;
      if (sql.includes("LIKE '%PLAY RECAP%'")) return db.recap;
      if (sql.includes("SELECT id FROM AnsibleForms.`jobs` WHERE id = ?")) return [{ id: params[0] }];
      if (sql.includes("parent_id, abort_requested FROM AnsibleForms.`jobs`")) return db.job ? [db.job] : [];
      if (sql.includes("INSERT INTO AnsibleForms.`job_output`")) {
        db.outputs.push(params[0]);
        return { insertId: db.outputs.length };
      }
      return [];
    }),
  },
}));

const form = { name: "Patch", playbook: "patch.yml", fields: [{ name: "release", type: "text" }] };
vi.mock("../src/models/form.model.js", () => ({
  default: { load: vi.fn(async () => ({ constants: {}, forms: [structuredClone(form)] })) },
}));
// the runners table : the AWX the template jobs ran on
vi.mock("../src/models/runner.model.js", () => ({
  default: {
    findByName: vi.fn(async (name) => (name === "awx1" ? { name: "awx1", type: "awx", uri: "https://awx.example.com", token: "t" } : null)),
    findDefault: vi.fn(async () => null),
  },
}));

const { default: axios } = await import("axios");
const { default: Job, relaunchOriginLines } = await import("../src/models/job.model.js");
const Form = (await import("../src/models/form.model.js")).default;
const { Awx, failedHostsRelaunchBody } = await import("../src/runners/awx/api.js");
const lib = await import("../src/lib/failedHosts.js");
const core = await import("../src/rte/ansible-core.js");

const user = { username: "alice", type: "local", roles: ["default"], options: { allowJobRelaunch: true } };
// a playbook job that failed on 2 of its hosts
const playbookJob = (extra = {}) => ({
  id: 42, form: "Patch", status: "failed", user: "alice", user_type: "local", job_type: "ansible", runner: "rte1", runner_kind: "rte",
  extravars: JSON.stringify({ release: "1.2", __playbook__: "patch.yml", __limit__: "webservers" }),
  credentials: "{}", raw_form_data: JSON.stringify({ __form__: "Patch", release: "1.2" }), parent_id: null, awx_id: null, awx_workflow: null,
  ...extra,
});
const recapEvent = { order: 90, type: "stats", host: null, data: JSON.stringify({ web01: { ok: 3, failures: 0, unreachable: 0 }, web07: { ok: 1, failures: 1, unreachable: 0 }, web19: { ok: 0, failures: 0, unreachable: 1 } }) };

beforeEach(() => {
  db.events = [recapEvent];
  db.recap = [];
  db.outputs = [];
  db.job = null;
  Job.findById = vi.fn(async () => playbookJob());
  Job.launch = vi.fn(async () => ({ id: 43 }));
  Job.sendEventNotification = vi.fn(async () => {});
  Form.load.mockResolvedValue({ constants: {}, forms: [structuredClone(form)] });
});

// ---------------------------------------------------------------------------------------------
describe("the failed hosts of a job", () => {
  test("from its events : the recap's failures and unreachable hosts", () => {
    expect(lib.hostsFromEvents([{ type: "stats", data: JSON.parse(recapEvent.data) }])).toEqual(["web07", "web19"]);
  });

  test("without a recap : the failed and unreachable results, not a failure that was ignored", () => {
    const events = [
      { type: "failed", host: "a" },
      { type: "ignored", host: "a" },
      { type: "failed", host: "b" },
      { type: "unreachable", host: "c" },
    ];
    expect(lib.hostsFromEvents(events)).toEqual(["b", "c"]);
  });

  test("from the PLAY RECAP lines of the output, its colours and line breaks aside", () => {
    const text = [
      "TASK [patch] ***",
      "fatal: [db01]: FAILED!",
      "PLAY RECAP *********************************************************************",
      "\x1b[0;31mdb01\x1b[0m                       : ok=1    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0",
      "web01                      : ok=3    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0",
      "web,odd:name               : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0",
      "",
      "ok: [some later line : ok=1 failed=9]",
    ].join("<br>");
    expect(lib.hostsFromRecap(text)).toEqual(["db01", "web,odd:name"]);
  });

  test("a job without events is read from its recap", async () => {
    db.events = [];
    db.recap = [{ output: "PLAY RECAP ***\nweb33 : ok=1 changed=0 unreachable=0 failed=2 skipped=0" }];
    expect(await Job.failedHostsOf(playbookJob())).toEqual(["web33"]);
  });

  test("none for a workflow, a multistep, a step, a running job, or a Jenkins, Semaphore or Rundeck job", async () => {
    expect(await Job.failedHostsOf(playbookJob({ job_type: "workflow" }))).toBeNull();
    expect(await Job.failedHostsOf(playbookJob({ job_type: "multistep" }))).toBeNull();
    expect(await Job.failedHostsOf(playbookJob({ parent_id: 7 }))).toBeNull();
    expect(await Job.failedHostsOf(playbookJob({ status: "running" }))).toBeNull();
    for (const kind of ["jenkins", "semaphore", "rundeck"]) {
      expect(await Job.failedHostsOf(playbookJob({ job_type: "awx", runner_kind: kind, awx_id: 5 }))).toBeNull();
    }
    // an AWX workflow job template's job : no failed hosts either
    expect(await Job.failedHostsOf(playbookJob({ job_type: "awx", runner_kind: "awx", awx_id: 5, awx_workflow: "{\"id\":5}" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the limit of a re-run", () => {
  test("the job's one limit pattern is intersected (&), its operators kept", () => {
    expect(lib.rerunLimit(["web07", "web19"], "webservers")).toEqual({ hosts: ["web07", "web19"], within: ["&webservers"], skipped: [] });
    expect(lib.rerunLimit(["web07"], "webservers:&staging:!web99").within).toEqual(["&webservers", "&staging", "!web99"]);
    // several plain patterns cannot be intersected : the hosts ran under them already
    expect(lib.rerunLimit(["web07"], "web07,web08").within).toEqual([]);
    expect(lib.rerunLimit(["web07"], "").within).toEqual([]);
    expect(lib.rerunLimit(["web07"], "all").within).toEqual([]);
  });

  test("a re-run of a re-run stays within the hosts of the one before", () => {
    expect(lib.rerunLimit(["web07", "web19"], ["&webservers"], ["web07"])).toEqual({ hosts: ["web07"], within: ["&webservers"], skipped: [] });
  });

  test("names with commas and colons are kept whole ; a name ansible reads as a pattern is left out", () => {
    const r = lib.rerunLimit(["web,07", "fe80::1", "db:01", "web*", "~re", "!all", "&x", "a[0]", "@file", "with space"], "");
    expect(r.hosts).toEqual(["db:01", "fe80::1", "web,07"]);
    expect(r.skipped.sort()).toEqual(["!all", "&x", "@file", "a[0]", "web*", "with space", "~re"].sort());
  });

  test("the limit file : a line each, the hosts then the job's limit", () => {
    expect(lib.limitFileContent(["web,07", "db:01"], ["&webservers"])).toBe("web,07\ndb:01\n&webservers\n");
  });

  test("the limit of an RTE of an earlier release : a comma list that only ever narrows", () => {
    expect(lib.fallbackLimit(["web07", "web19"], ["&webservers"])).toBe("web07,web19,&webservers,");
    // one name : still a comma list, never split on its colons
    expect(lib.fallbackLimit(["db:01"])).toBe("db:01,");
    // a name with a comma is left out ; no name left : no host at all
    expect(lib.fallbackLimit(["web,07"])).toBe("!all,");
  });

  test("an IPv6 limit is one pattern, a [subscript] keeps its colon", () => {
    expect(lib.splitLimit("fe80::1")).toEqual(["fe80::1"]);
    expect(lib.splitLimit("web[0:2]:&db")).toEqual(["web[0:2]", "&db"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/v2/job/:id/relaunch with failedHostsOnly", () => {
  test("a replay of the job, its limit restricted to the failed hosts within its own", async () => {
    const r = await Job.relaunch(user, 42, false, { failedHostsOnly: true });
    expect(r).toMatchObject({ id: 43, failedHosts: ["web07", "web19"] });
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ form: "Patch", user, replay: true });
    // the stored extravars as they ran, and the server's own beside them
    expect(arg.extravars).toMatchObject({ release: "1.2", __limit__: "webservers" });
    expect(arg.serverExtravars).toEqual({
      __limitHosts__: ["web07", "web19"],
      __limitWithin__: ["&webservers"],
      __limit__: "web07,web19,&webservers,",
      __relaunchOf__: { id: 42, scope: "failedHosts" },
    });
    expect(Job.sendEventNotification).toHaveBeenCalledWith(42, "relaunch", user);
  });

  test("the same rights as a relaunch : another user's job, the role option, the form's allowRelaunch", async () => {
    Job.findById = vi.fn(async () => playbookJob({ user: "bob" }));
    await expect(Job.relaunch(user, 42, false, { failedHostsOnly: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    Job.findById = vi.fn(async () => playbookJob());
    await expect(Job.relaunch({ ...user, options: {} }, 42, false, { failedHostsOnly: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    Form.load.mockResolvedValue({ constants: {}, forms: [{ ...structuredClone(form), allowRelaunch: false }] });
    await expect(Job.relaunch(user, 42, false, { failedHostsOnly: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    await expect(Job.relaunch(user, 42, true, { failedHostsOnly: true })).rejects.toMatchObject({ name: "AccessDeniedError" });
    expect(Job.launch).not.toHaveBeenCalled();
  });

  test("under launch validation 'enforce' : through the form engine, the limit added after it", async () => {
    Form.load.mockResolvedValue({ constants: {}, forms: [{ ...structuredClone(form), launchValidation: "enforce" }] });
    await Job.relaunch(user, 42, false, { failedHostsOnly: true });
    const arg = Job.launch.mock.calls[0][0];
    expect(arg).toMatchObject({ validated: true, fromClient: true });
    expect(arg.replay).toBeUndefined();
    expect(arg.serverExtravars.__limitHosts__).toEqual(["web07", "web19"]);
  });

  test("a job without failed hosts, or one that cannot be re-run on them, is refused", async () => {
    db.events = [{ order: 9, type: "stats", data: JSON.stringify({ web01: { ok: 1, failures: 0, unreachable: 0 } }) }];
    await expect(Job.relaunch(user, 42, false, { failedHostsOnly: true })).rejects.toMatchObject({ name: "BadRequestError", code: "NO_FAILED_HOSTS" });
    Job.findById = vi.fn(async () => playbookJob({ job_type: "workflow" }));
    await expect(Job.relaunch(user, 42, false, { failedHostsOnly: true })).rejects.toMatchObject({ code: "NO_FAILED_HOSTS" });
    expect(Job.launch).not.toHaveBeenCalled();
  });

  test("a re-run of a re-run keeps within the hosts before ; a plain relaunch of a re-run is no re-run", async () => {
    Job.findById = vi.fn(async () => playbookJob({
      extravars: JSON.stringify({ __limitHosts__: ["web19"], __limitWithin__: ["&webservers"], __limit__: "web19,&webservers,", __relaunchOf__: { id: 41, scope: "failedHosts" } }),
    }));
    await Job.relaunch(user, 42, false, { failedHostsOnly: true });
    expect(Job.launch.mock.calls[0][0].serverExtravars).toMatchObject({ __limitHosts__: ["web19"], __limitWithin__: ["&webservers"] });
    await Job.relaunch(user, 42, false);
    const plain = Job.launch.mock.calls[1][0];
    expect(plain.extravars.__relaunchOf__).toBeUndefined();
    expect(plain.extravars.__limitHosts__).toEqual(["web19"]);
  });

  test("the relaunch options : the failed hosts for who may relaunch, none for other runners", async () => {
    db.job = playbookJob();
    expect(await Job.relaunchOptions(user, 42)).toEqual({ failedHosts: ["web07", "web19"] });
    db.job = playbookJob({ job_type: "awx", runner_kind: "jenkins", awx_id: 3 });
    expect(await Job.relaunchOptions(user, 42)).toEqual({ failedHosts: null });
    db.job = playbookJob({ user: "bob" });
    await expect(Job.relaunchOptions(user, 42)).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  test("no failed hosts choice when every host it ran on failed (one host, or all of them)", async () => {
    const stats = (data) => [{ order: 9, type: "stats", host: null, data: JSON.stringify(data) }];
    // its only host failed : a re-run on it is the full relaunch
    db.job = playbookJob();
    db.events = stats({ web01: { failures: 1, ok: 2 } });
    expect(await Job.relaunchOptions(user, 42)).toEqual({ failedHosts: null });
    // every host failed : the same
    db.events = stats({ web01: { failures: 1 }, web02: { unreachable: 1 } });
    expect(await Job.relaunchOptions(user, 42)).toEqual({ failedHosts: null });
    // one of two failed : a choice of its own
    db.events = stats({ web01: { failures: 0, ok: 3 }, web02: { failures: 1 } });
    expect(await Job.relaunchOptions(user, 42)).toEqual({ failedHosts: ["web02"] });
  });

  test("a re-run differs from a full relaunch only when some, not all, hosts failed", () => {
    expect(lib.rerunDiffers(["a"], ["a"])).toBe(false);
    expect(lib.rerunDiffers(["a", "b"], ["a", "b"])).toBe(false);
    expect(lib.rerunDiffers(["a"], ["a", "b"])).toBe(true);
    expect(lib.rerunDiffers(["a"], 3)).toBe(true);
    expect(lib.rerunDiffers(["a"], 1)).toBe(false);
    expect(lib.rerunDiffers([], ["a"])).toBe(false);
    // the hosts it ran on not known : the failed ones decide
    expect(lib.rerunDiffers(["a"], null)).toBe(true);
    expect(lib.ranHostsFromRecap("PLAY RECAP ***\nweb01 : ok=2 changed=0 unreachable=0 failed=1\nweb02 : ok=3 changed=1 unreachable=0 failed=0\n")).toEqual(["web01", "web02"]);
  });

  test("the new job's output says what it re-runs, and which names it left out", () => {
    expect(relaunchOriginLines({ __limitHosts__: ["web07", "web19"], __relaunchOf__: { id: 42, scope: "failedHosts", skipped: ["web*"] } })).toEqual([
      "ok: [Re-run of job 42 on its 2 failed host(s): web07, web19]",
      "[WARNING]: not re-run, ansible reads their names as patterns: web*",
    ]);
    expect(relaunchOriginLines({ __limit__: "x" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("an AWX, AAP or Ascender template job", () => {
  const awxJob = () => playbookJob({ job_type: "awx", runner: "awx1", runner_kind: "ascender", awx_id: 77 });

  test("its failed hosts are its job host summaries' ; the re-run goes to the AWX it ran on", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValueOnce({
      data: { results: [{ host_name: "web07", failures: 1, dark: 0, failed: true }, { host_name: "web19", failures: 0, dark: 1, failed: true }], next: null },
    });
    Job.findById = vi.fn(async () => awxJob());
    await Job.relaunch(user, 42, false, { failedHostsOnly: true });
    expect(get.mock.calls[0][0]).toBe("https://awx.example.com/api/v2/jobs/77/job_host_summaries/?failed=true&page_size=200");
    expect(Job.launch.mock.calls[0][0].serverExtravars).toMatchObject({
      __runner__: "awx1",
      __limitHosts__: ["web07", "web19"],
      __relaunchOf__: { id: 42, scope: "failedHosts", awxId: 77 },
    });
    get.mockRestore();
  });

  test("AWX not answering : its stored events count", async () => {
    const get = vi.spyOn(axios, "get").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await Job.failedHostsOf(awxJob())).toEqual(["web07", "web19"]);
    get.mockRestore();
  });

  test("the launch is AWX's relaunch of that job with hosts: failed, not the template", async () => {
    expect(failedHostsRelaunchBody()).toEqual({ hosts: "failed" });
    const post = vi.spyOn(axios, "post").mockResolvedValueOnce({ data: { id: 78, status: "pending" } });
    const findTemplate = vi.spyOn(Awx, "findJobTemplateByName");
    Job.update = vi.fn(async () => {});
    Job.printJobOutput = vi.fn(async () => {});
    const track = vi.spyOn(Awx, "trackJob").mockResolvedValueOnce(true);
    const runner = { name: "awx1", type: "awx", uri: "https://awx.example.com", token: "t" };
    await Awx.launch(runner, { __template__: "patch", __relaunchOf__: { id: 42, scope: "failedHosts", awxId: 77 } }, {}, 43, 1);
    expect(post).toHaveBeenCalledWith("https://awx.example.com/api/v2/jobs/77/relaunch/", { hosts: "failed" }, expect.any(Object));
    expect(findTemplate).not.toHaveBeenCalled();
    expect(Job.update).toHaveBeenCalledWith({ awx_id: 78 }, 43);
    expect(track).toHaveBeenCalled();
    post.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the RTE's arguments for a re-run", () => {
  const files = { extravarsFileName: "e.json", hiddenExtravarsFileName: "he_e.json", limitFileName: "limit_43.txt" };

  test("the hosts go as a limit file, never as the comma string", () => {
    const { args } = core.buildAnsibleArgs({ __playbook__: "p.yml", __limit__: "web07,", __limitHosts__: ["web07"], __limitWithin__: [] }, files);
    expect(args).toContain("@limit_43.txt");
    expect(args).not.toContain("web07,");
  });

  test("a job that is no re-run keeps its limit as it was", () => {
    const { args } = core.buildAnsibleArgs({ __playbook__: "p.yml", __limit__: "webservers" }, files);
    expect(args.slice(args.indexOf("--limit"), args.indexOf("--limit") + 2)).toEqual(["--limit", "webservers"]);
  });

  test("the file's lines : literal hosts only, the job's limit as & and ! lines", () => {
    expect(core.rerunHosts({ __limitHosts__: ["web07", "web*"], __limitWithin__: ["&webservers", "rm -rf", "!db01"] })).toEqual({ hosts: ["web07"], within: ["&webservers", "!db01"] });
    expect(core.rerunHosts({ __limit__: "x" })).toBeNull();
  });
});
