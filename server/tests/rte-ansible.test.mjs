// The RTE's playbook run (server/src/rte/ansible-core.js), the approval gate and which
// runner a job goes to (server/src/runners/orchestrator.js). A playbook job runs from its
// jobs row alone, so these tests drive it through the row, with ansible-playbook replaced
// by a fake process.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

let child;
const spawned = [];
// an RTE with the OpenSSH client, faked : ssh-agent opens its socket, ssh-add loads the key, and
// the agents started are kept to see that they were stopped (off : no ssh-agent on the RTE)
const fakeOpenSsh = { on: false, agents: [] };
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((file, args, options) => {
      if (file === "ssh-agent" && fakeOpenSsh.on) {
        // ssh-agent -D -a <socket> : the socket appears, and a SIGTERM stops it
        const agent = new EventEmitter();
        agent.exitCode = null;
        agent.signalCode = null;
        agent.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
        agent.kill = vi.fn((signal) => {
          agent.signalCode = signal;
          setTimeout(() => agent.emit("exit", null, signal), 1);
          return true;
        });
        fs.writeFileSync(args[2], "");
        fakeOpenSsh.agents.push(agent);
        return agent;
      }
      if (file === "ssh-add" && fakeOpenSsh.on) {
        // the key loads : ssh-add ends with status 0
        const add = new EventEmitter();
        add.stdout = new EventEmitter();
        add.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
        add.kill = () => true;
        setTimeout(() => add.emit("close", 0), 1);
        return add;
      }
      // an RTE without the OpenSSH client : no ssh-agent to load a key with a passphrase into
      if (file === "ssh-agent") throw Object.assign(new Error("spawn ssh-agent ENOENT"), { code: "ENOENT" });
      child = new EventEmitter();
      child.pid = 5151;
      child.signalCode = null;
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stdin = Object.assign(new EventEmitter(), { end(data) { child.stdinWritten = data; } });
      // what ansible-playbook would read : the extravars files, while it runs
      const read = (name) => JSON.parse(fs.readFileSync(path.join(options.cwd, name), "utf8"));
      spawned.push({ file, args, options, extravars: read("extravars_11.json"), hidden: read("he_extravars_11.json") });
      return child;
    }),
  };
});

// the credentials table : resolved by name, nothing else
const credentialRows = {
  db: { name: "db", user: "dbuser", password: "dbpw", host: "db.local" },
  ssh: { name: "ssh", user: "root", password: "sshpw" },
  vault: { name: "vault", user: "", password: "v@ult" },
};
vi.mock("../src/models/credential.model.v2.js", () => ({
  default: {
    resolveCredentialMap: async (map) => {
      const out = {};
      for (const [key, name] of Object.entries(map || {})) if (credentialRows[name]) out[key] = { ...credentialRows[name] };
      return out;
    },
    resolveCredential: async (name) => {
      if (!credentialRows[name]) throw new Error(`no credential ${name}`);
      return { ...credentialRows[name] };
    },
  },
}));

// the runners table : by name, and the one marked default
let runnerRows = [];
vi.mock("../src/models/runner.model.js", () => ({
  default: {
    findByName: async (name) => runnerRows.find((r) => r.name === name) || undefined,
    findDefault: async (type) => runnerRows.find((r) => r.is_default && r.type === type) || null,
  },
}));

const jobExports = await import("../src/models/job.model.js");
const { default: Job } = jobExports;
const { default: mysql } = await import("../src/models/db.model.js");
const { default: Repository } = await import("../src/models/repository.model.js");
const core = await import("../src/rte/ansible-core.js");
// the jobs read and written in the database, as a database-mode RTE does
core.useJobIO((await import("../src/rte/jobio-db.js")).default);
const { resolveJobSecrets } = await import("../src/lib/jobSecrets.js");
const { dispatch, resolveRunner } = await import("../src/runners/orchestrator.js");
const { RUNNERS } = await import("../src/runners/index.js");

let jobRow;
let outputs;
mysql.do = async function (sql, params) {
  if (sql.includes("extravars, credentials FROM") || sql.includes("SELECT form, extravars FROM")) return [{ form: jobRow.form, extravars: jobRow.extravars, credentials: jobRow.credentials }];
  if (sql.includes("MAX(`order`)")) return [{ last: outputs.reduce((m, o) => Math.max(m, o.order), 0) }];
  if (sql.includes("INSERT INTO AnsibleForms.`job_output`")) {
    outputs.push({ ...params[0] });
    return { insertId: outputs.length };
  }
  if (sql.includes("UPDATE AnsibleForms.`jobs` set ?")) {
    Object.assign(jobRow, params[0]);
    return { changedRows: 1 };
  }
  // Job.transitionStatus : only from the statuses it names
  if (sql.includes("UPDATE AnsibleForms.`jobs` SET ? WHERE id=? AND status IN (?)")) {
    if (!params[2].includes(jobRow.status ?? "running")) return { affectedRows: 0 };
    Object.assign(jobRow, params[0]);
    return { affectedRows: 1, changedRows: 1 };
  }
  if (sql.includes("SELECT abort_requested")) return [{ abort_requested: 0 }];
  if (sql.includes("SET runner=?")) { jobRow.runner = params[0]; return { changedRows: 1 }; }
  if (sql.includes("SET job_log=?")) { jobRow.job_log = params[0]; return { changedRows: 1 }; }
  if (sql.includes("SELECT id FROM AnsibleForms.`jobs`")) return [{ id: params[0] }];
  return { changedRows: 1 };
};
Job.sendStatusNotification = async () => {};
const approvalMails = [];
Job.sendApprovalNotification = async (approval, extravars, jobid) => { approvalMails.push({ approval, jobid }); };

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-runner-"));
  vi.spyOn(Repository, "getAnsiblePath").mockResolvedValue(dir);
  outputs = [];
  spawned.length = 0;
  approvalMails.length = 0;
  runnerRows = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function row(extravars, credentials = {}) {
  jobRow = { id: 11, status: "running", extravars: JSON.stringify(extravars), credentials: JSON.stringify(credentials) };
}

// the job as the RTE gets it : its secrets resolved by the app from the row (lib/jobSecrets.js)
async function runJob() {
  const secrets = await resolveJobSecrets(JSON.parse(jobRow.extravars), JSON.parse(jobRow.credentials));
  return core.runAnsibleJob({ jobId: 11, secrets });
}

async function runToEnd(start, exitCode = 0) {
  const done = start();
  await new Promise((r) => setTimeout(r, 20));
  child.emit("exit", exitCode);
  return done;
}

describe("the ansible-playbook arguments", () => {
  const files = { extravarsFileName: "e.json", hiddenExtravarsFileName: "he_e.json" };

  test("every option, values passed as they are", () => {
    const { args } = core.buildAnsibleArgs({
      __playbook__: "site.yml", __inventory__: ["hosts", "extra"], __tags__: "a,b", __check__: true,
      __diff__: true, __verbose__: true, __limit__: "web*",
    }, files);
    assert.deepEqual(args, [
      "-e", "@e.json", "-e", "@he_e.json",
      "-i", "hosts", "-i", "extra",
      "-t", "a,b", "--check", "--diff", "-vvv", "--limit", "web*", "site.yml",
    ]);
  });

  test("each inventory once: a list is never joined into a host list", () => {
    const one = core.buildAnsibleArgs({ __playbook__: "p.yml", __inventory__: "hosts" }, files).args;
    assert.deepEqual(one.filter((a, i) => one[i - 1] === "-i"), ["hosts"]);
    const adhoc = core.buildAnsibleArgs({ __playbook__: "p.yml", __inventory__: "web1,web2," }, files).args;
    assert.deepEqual(adhoc.filter((a, i) => adhoc[i - 1] === "-i"), ["web1,web2,"], "a host list the form meant stays one");
  });

  test("a value with quotes and spaces stays one argument", () => {
    const { args } = core.buildAnsibleArgs({ __playbook__: "my play.yml", __limit__: "it's \"x\"; rm -rf /" }, files);
    assert.deepEqual(args.slice(-3), ["--limit", "it's \"x\"; rm -rf /", "my play.yml"]);
  });

  test("a vault password adds the stdin reader, never the password itself", () => {
    const { args } = core.buildAnsibleArgs({ __playbook__: "p.yml" }, { ...files, vaultPassword: "secret" });
    assert.ok(args.includes("--vault-password-file=/bin/cat"));
    assert.equal(args.join(" ").includes("secret"), false);
  });
});

describe("a playbook job runs from its jobs row", () => {
  test("credentials, hidden credentials and the vault password are resolved from the names in the row", async () => {
    row({ __playbook__: "site.yml", __credentials__: { dbcred: "db" }, __ansibleCredentials__: "ssh", __vaultCredentials__: "vault" });
    const ok = await runToEnd(() => runJob());
    assert.equal(ok, true);
    const run = spawned[0];
    assert.equal(run.file, "ansible-playbook");
    assert.equal(run.options.cwd, dir);
    assert.deepEqual(run.extravars.dbcred, credentialRows.db, "a resolved credential becomes an extravar");
    assert.equal(run.extravars.__jobid__, 11, "the row lacks the id ; the runner adds it");
    assert.deepEqual(run.hidden, { ansible_user: "root", ansible_password: "sshpw" });
    assert.equal(child.stdinWritten, "v@ult");
    assert.equal(jobRow.status, "success");
    assert.equal(fs.existsSync(path.join(dir, "extravars_11.json")), false, "files removed afterwards");
  });

  test("the playbook runs without the app's secrets in its environment", async () => {
    const saved = { e: process.env.ENCRYPTION_SECRET, d: process.env.DB_PASSWORD };
    process.env.ENCRYPTION_SECRET = "the-key";
    process.env.DB_PASSWORD = "db-root";
    try {
      row({ __playbook__: "site.yml" });
      await runToEnd(() => runJob());
    } finally {
      if (saved.e === undefined) delete process.env.ENCRYPTION_SECRET; else process.env.ENCRYPTION_SECRET = saved.e;
      if (saved.d === undefined) delete process.env.DB_PASSWORD; else process.env.DB_PASSWORD = saved.d;
    }
    const env = spawned[0].options.env;
    assert.equal(env.ENCRYPTION_SECRET, undefined);
    assert.equal(env.DB_PASSWORD, undefined);
    assert.equal(env.PATH, process.env.PATH, "the rest of the environment is passed");
  });

  test("the playbook sub path is the working folder", async () => {
    fs.mkdirSync(path.join(dir, "sub"));
    row({ __playbook__: "site.yml", __playbookSubPath__: "sub" });
    await runToEnd(() => runJob());
    assert.equal(spawned[0].options.cwd, path.join(dir, "sub"));
  });

  test("a missing ansible credential fails the job with the line it always had", async () => {
    row({ __playbook__: "site.yml", __ansibleCredentials__: "nope" });
    const ok = await runJob();
    assert.equal(ok, false);
    assert.equal(spawned.length, 0, "nothing ran");
    assert.equal(jobRow.status, "failed");
    assert.ok(outputs.some((o) => o.output === "[ERROR]: Failed to get ansible credentials"));
  });

  test("a credential, the ansible and vault passwords never reach the output", async () => {
    row({ __playbook__: "site.yml", __credentials__: { dbcred: "db" }, __ansibleCredentials__: "ssh", __vaultCredentials__: "vault" });
    credentialRows.vault.password = "v@ultPw";
    credentialRows.db.password = "dbpw-long";
    try {
      const done = runJob();
      await new Promise((r) => setTimeout(r, 20));
      child.stdout.emit("data", "ok: dbpw-long sshpw v@ultPw dbuser\n");
      await new Promise((r) => setTimeout(r, 10));
      child.emit("exit", 0);
      await done;
    } finally {
      credentialRows.vault.password = "v@ult";
      credentialRows.db.password = "dbpw";
    }
    const line = outputs.find((o) => o.output_type === "stdout" && o.output.startsWith("ok: "));
    assert.equal(line.output, "ok: ******** ******** ******** dbuser\n");
  });

  test("output continues after what the job already wrote", async () => {
    row({ __playbook__: "site.yml" });
    outputs.push({ output: "changed: [approved by admin]", order: 4 });
    await runToEnd(() => runJob());
    const after = outputs.slice(1).map((o) => o.order);
    assert.ok(after.every((n) => n > 4), "every new line comes after the existing ones");
  });
});

describe("an SSH credential with a private key as the ansible login", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n-----END OPENSSH PRIVATE KEY-----\n";
  beforeEach(() => {
    credentialRows.sshkey = { name: "sshkey", user: "deploy", password: "", private_key: KEY };
  });
  afterEach(() => {
    delete credentialRows.sshkey;
  });

  test("the key is in a private file while the playbook runs, passed as ansible_ssh_private_key_file", async () => {
    row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
    const done = runJob();
    await new Promise((r) => setTimeout(r, 20));
    const hidden = spawned[0].hidden;
    const file = hidden.ansible_ssh_private_key_file;
    assert.deepEqual(Object.keys(hidden).sort(), ["ansible_ssh_private_key_file", "ansible_user"], "no empty password next to the key");
    assert.equal(fs.readFileSync(file, "utf8"), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(spawned[0].extravars).includes("PRIVATE KEY"), false, "never in the plain extravars");
    child.emit("exit", 0);
    assert.equal(await done, true);
    assert.equal(fs.existsSync(path.dirname(file)), false, "its folder removed at the end");
  });

  test("a failed playbook removes the key too", async () => {
    row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
    const ok = await runToEnd(() => runJob(), 2);
    assert.equal(ok, false);
    assert.equal(fs.existsSync(path.dirname(spawned[0].hidden.ansible_ssh_private_key_file)), false);
  });

  test("a password with the key is passed as well", async () => {
    credentialRows.sshkey.password = "sudo-pass";
    row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
    await runToEnd(() => runJob());
    assert.equal(spawned[0].hidden.ansible_password, "sudo-pass");
  });

  test("the key never reaches the output, whole or line by line", async () => {
    row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
    const done = runJob();
    await new Promise((r) => setTimeout(r, 20));
    child.stdout.emit("data", `key: ${JSON.stringify(KEY)}\nline: ${KEY.split("\n")[1]}\n`);
    await new Promise((r) => setTimeout(r, 10));
    child.emit("exit", 0);
    await done;
    const text = outputs.map((o) => o.output).join("");
    assert.equal(text.includes("b3BlbnNzaC1rZXkt"), false, text);
    assert.ok(text.includes('key: "********"'), text);
  });

  test("a passphrase without ssh-agent on the RTE fails the job, saying so, and runs nothing", async () => {
    credentialRows.sshkey.private_key_passphrase = "open sesame";
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_11_"));
    row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
    const ok = await runJob();
    assert.equal(ok, false);
    assert.equal(spawned.length, 0, "no playbook ran");
    assert.equal(jobRow.status, "failed");
    assert.ok(outputs.some((o) => /ssh-agent is not available on this RTE/.test(o.output)), JSON.stringify(outputs));
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_11_")), before, "no key left behind");
  });

  describe("a step that fails after the key is ready, before the playbook starts", () => {
    beforeEach(() => {
      fakeOpenSsh.on = true;
      fakeOpenSsh.agents.length = 0;
    });
    afterEach(() => {
      fakeOpenSsh.on = false;
      fakeOpenSsh.agents.length = 0;
    });

    test("a key with a passphrase : the job's ssh-agent is stopped and its folder removed", async () => {
      credentialRows.sshkey.private_key_passphrase = "open sesame";
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_11_"));
      // the playbook's folder cannot be found : the step right after the key is made ready
      vi.spyOn(Repository, "getAnsiblePath").mockRejectedValue(new Error("the playbooks repository is gone"));
      row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
      await assert.rejects(runJob(), /the playbooks repository is gone/);
      assert.equal(spawned.length, 0, "no playbook ran");
      assert.equal(fakeOpenSsh.agents.length, 1, "the job's agent was started");
      assert.equal(fakeOpenSsh.agents[0].kill.mock.calls.length, 1, "and stopped, with the key it held");
      assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_11_")), before, "no key folder left behind");
    });

    test("a key without a passphrase : its file and folder are removed", async () => {
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_11_"));
      vi.spyOn(Repository, "getAnsiblePath").mockRejectedValue(new Error("the playbooks repository is gone"));
      row({ __playbook__: "site.yml", __ansibleCredentials__: "sshkey" });
      await assert.rejects(runJob(), /the playbooks repository is gone/);
      assert.equal(spawned.length, 0, "no playbook ran");
      assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_11_")), before, "no key folder left behind");
    });
  });
});

describe("a form value is never a template", () => {
  // ansible templates a string from an extravars file when the playbook uses it : a value of
  // `{{ lookup('pipe', ...) }}` typed into a form field ran that command on the RTE
  const attack = "{{ lookup('pipe', 'id') }}";

  test("a string with a Jinja marker is written as ansible's unsafe, anywhere in the extravars", async () => {
    row({ __playbook__: "site.yml", name: attack, list: ["ok", "{% if 1 %}x{% endif %}"], nested: { note: "{# c #}" } });
    await runToEnd(() => runJob());
    const ev = spawned[0].extravars;
    assert.deepEqual(ev.name, { __ansible_unsafe: attack });
    assert.deepEqual(ev.list, ["ok", { __ansible_unsafe: "{% if 1 %}x{% endif %}" }]);
    assert.deepEqual(ev.nested, { note: { __ansible_unsafe: "{# c #}" } });
  });

  test("everything without a marker is written exactly as before", async () => {
    const values = { __playbook__: "site.yml", name: "web01", n: 3, on: true, none: null, tags: ["a", "b"], obj: { k: "{ not jinja }" } };
    row(values);
    await runToEnd(() => runJob());
    assert.deepEqual(spawned[0].extravars, { ...values, __jobid__: 11 });
  });

  test("a credential's password is never templated, in the extravars or the hidden file", async () => {
    credentialRows.braces = { name: "braces", user: "u", password: "p{{w}}" };
    row({ __playbook__: "site.yml", __credentials__: { c: "braces" }, __ansibleCredentials__: "braces" });
    await runToEnd(() => runJob());
    assert.deepEqual(spawned[0].extravars.c.password, { __ansible_unsafe: "p{{w}}" });
    assert.deepEqual(spawned[0].hidden.ansible_password, { __ansible_unsafe: "p{{w}}" });
    delete credentialRows.braces;
  });

  test("a form with allowJinjaInExtravars keeps its templates", async () => {
    row({ __playbook__: "site.yml", __allowJinjaInExtravars__: true, name: "{{ inventory_hostname }}" });
    await runToEnd(() => runJob());
    assert.equal(spawned[0].extravars.name, "{{ inventory_hostname }}");
  });

  test("only a real true opts out", async () => {
    row({ __playbook__: "site.yml", __allowJinjaInExtravars__: "false", name: attack });
    await runToEnd(() => runJob());
    assert.deepEqual(spawned[0].extravars.name, { __ansible_unsafe: attack });
  });
});

describe("the form decides allowJinjaInExtravars, never the request", () => {
  test("the form property is handed to the RTE as __allowJinjaInExtravars__", () => {
    const formObj = { name: "f", playbook: "site.yml", allowJinjaInExtravars: true, fields: [] };
    const ev = {};
    jobExports.pushForminfoToExtravars(formObj, ev);
    assert.equal(ev.__allowJinjaInExtravars__, true);
  });

  test("a client cannot switch it on for a form that does not declare it", () => {
    const ev = jobExports.stripReservedExtravars({ __allowJinjaInExtravars__: true, name: "x" }, { name: "f", fields: [{ name: "name" }] });
    assert.equal("__allowJinjaInExtravars__" in ev, false);
  });
});

describe("every way out removes the files holding the credentials, and ends the job once", () => {
  const endLines = () => outputs.filter((o) => /failed|finished/.test(o.output || ""));

  test("ansible-playbook missing (a spawn error: error and close, never exit)", async () => {
    row({ __playbook__: "site.yml", __credentials__: { dbcred: "db" } });
    const done = runJob();
    await new Promise((r) => setTimeout(r, 20));
    child.emit("error", Object.assign(new Error("spawn ansible-playbook ENOENT"), { code: "ENOENT" }));
    child.emit("close", -2);
    const ok = await done;
    assert.equal(ok, false, "the run settles - before, it never did and the RTE listed the job as running for ever");
    assert.equal(jobRow.status, "failed");
    assert.equal(fs.existsSync(path.join(dir, "extravars_11.json")), false, "the resolved credentials are not left on disk");
    assert.equal(fs.existsSync(path.join(dir, "he_extravars_11.json")), false);
    assert.equal(endLines().length, 1);
  });

  test("an error after the exit (a kill that failed) does not end the job a second time", async () => {
    row({ __playbook__: "site.yml" });
    const done = runJob();
    await new Promise((r) => setTimeout(r, 20));
    child.emit("exit", 0);
    await done;
    child.emit("error", new Error("kill ESRCH"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(jobRow.status, "success");
    assert.equal(endLines().length, 1);
  });

  test("a playbook folder missing on the RTE says so, instead of failing on the extravars file", async () => {
    row({ __playbook__: "site.yml", __playbookSubPath__: "not/mounted" });
    const ok = await runJob();
    assert.equal(ok, false);
    assert.equal(spawned.length, 0, "nothing ran");
    assert.equal(jobRow.status, "failed");
    assert.ok(outputs.some((o) => /playbook folder .*not\/mounted does not exist on RTE/.test(o.output)), "the line names the folder and what to do");
  });
});

describe("the job log a playbook writes", () => {
  test("is stored on the job while it runs and at the end, then the file goes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      row({ __playbook__: "site.yml" });
      fs.mkdirSync(path.join(dir, ".joblogs"));
      const logFile = path.join(dir, ".joblogs", "job_log_11.log");
      const done = runJob();
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(logFile, "step 1 of 2\n");
      await vi.advanceTimersByTimeAsync(2000);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(jobRow.job_log, "step 1 of 2\n", "visible while the playbook runs");
      fs.appendFileSync(logFile, "step 2 of 2\n");
      child.emit("exit", 0);
      await done;
      assert.equal(jobRow.job_log, "step 1 of 2\nstep 2 of 2\n", "the final content");
      assert.equal(fs.existsSync(logFile), false, "the file is removed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("no log file is no job log, and no error", async () => {
    row({ __playbook__: "site.yml" });
    await runToEnd(() => runJob());
    assert.equal(jobRow.job_log, undefined);
    assert.equal(jobRow.status, "success");
  });
});

describe("the approval gate", () => {
  test("halts the job with the APPROVE line and never runs the playbook", async () => {
    row({ __playbook__: "site.yml" });
    const approval = { roles: ["admin"], title: "ok?" };
    await dispatch({ jobId: 11, jobType: "ansible", extravars: { __playbook__: "site.yml" }, approval });
    assert.equal(spawned.length, 0);
    assert.equal(jobRow.status, "approve");
    assert.equal(jobRow.approval, JSON.stringify(approval));
    assert.ok(jobRow.end);
    assert.equal(outputs[0].output, `APPROVE [site.yml] ${"*".repeat(69 - "site.yml".length)}`);
    assert.equal(approvalMails.length, 1);
  });

  test("a playbook path longer than the APPROVE line still halts for approval", async () => {
    const playbook = "playbooks/vmware/provisioning/create-virtual-machine-from-template-with-disks.yml";
    row({ __playbook__: playbook });
    await dispatch({ jobId: 11, jobType: "ansible", extravars: { __playbook__: playbook }, approval: { roles: ["admin"] } });
    assert.equal(jobRow.status, "approve", "a RangeError here left the job running for ever");
    assert.equal(outputs[0].output, `APPROVE [${playbook}] `);
  });

  test("an approved job goes to its runner", async () => {
    runnerRows = [{ name: "rte-default", type: "rte", is_default: 1 }];
    const launch = vi.spyOn(RUNNERS.rte, "launch").mockResolvedValue(true);
    try {
      row({ __playbook__: "site.yml" });
      await dispatch({ jobId: 11, jobType: "ansible", extravars: {}, approval: { roles: [] }, approved: true });
      assert.equal(launch.mock.calls.length, 1);
      assert.equal(launch.mock.calls[0][0].runner.name, "rte-default");
    } finally {
      launch.mockRestore();
    }
  });

  test("an awx job is labelled with its template", async () => {
    await dispatch({ jobId: 11, jobType: "awx", extravars: { __template__: "Deploy" }, approval: { roles: [] } });
    assert.equal(outputs[0].output, `APPROVE [Deploy] ${"*".repeat(69 - "Deploy".length)}`);
  });
});

describe("which runner runs a playbook job", () => {
  test("no runner named and no default: the job fails with a line that says what to do", async () => {
    row({ __playbook__: "site.yml" });
    await assert.rejects(resolveRunner({ jobType: "ansible", extravars: {} }), /No runner to run this playbook/);
    const ok = await dispatch({ jobId: 11, jobType: "ansible", extravars: {}, approval: null });
    assert.equal(ok, false);
    assert.equal(spawned.length, 0, "the app runs no playbook itself");
    assert.equal(jobRow.status, "failed");
    assert.ok(outputs.some((o) => /No runner to run this playbook: add one of type rte/.test(o.output)));
  });

  test("a default of another type is not a playbook runner's default", async () => {
    runnerRows = [{ name: "aap", type: "awx", is_default: 1 }];
    await assert.rejects(resolveRunner({ jobType: "ansible", extravars: {} }), /No runner to run this playbook/);
  });

  test("the form's runner: name wins over the default", async () => {
    runnerRows = [{ name: "rte-default", type: "rte", is_default: 1 }, { name: "rte-vmware", type: "rte" }];
    const picked = await resolveRunner({ jobType: "ansible", extravars: { __runner__: "rte-vmware" } });
    assert.equal(picked.impl.type, "rte");
    assert.equal(picked.row.name, "rte-vmware");
    const byDefault = await resolveRunner({ jobType: "ansible", extravars: {} });
    assert.equal(byDefault.row.name, "rte-default");
  });

  test("a form's type names the runner type: its runner must be one, its default is that type's", async () => {
    runnerRows = [
      { name: "sem", type: "semaphore", is_default: 1 }, { name: "rd", type: "rundeck", is_default: 1 }, { name: "ci", type: "jenkins" },
      { name: "aap-prod", type: "awx", flavour: "aap", is_default: 1 },
    ];
    assert.equal((await resolveRunner({ jobType: "awx", formType: "jenkins", extravars: { __runner__: "ci" } })).impl.type, "jenkins");
    assert.equal((await resolveRunner({ jobType: "awx", formType: "semaphore", extravars: { __runner__: "sem" } })).impl.type, "semaphore");
    // no runner named : the default of the form's type
    assert.equal((await resolveRunner({ jobType: "awx", formType: "rundeck", extravars: {} })).row.name, "rd");
    assert.equal((await resolveRunner({ jobType: "awx", formType: "aap", extravars: {} })).row.name, "aap-prod", "an aap form runs on the awx default");
    assert.equal((await resolveRunner({ jobType: "awx", formType: "ascender", extravars: { __runner__: "aap-prod" } })).row.name, "aap-prod", "no flavour check");
    // a runner of another type : refused, with the type to name
    await assert.rejects(resolveRunner({ jobType: "awx", formType: "semaphore", extravars: { __runner__: "rd" } }), /Runner 'rd' is a rundeck runner, this form is of type semaphore: name a semaphore runner/);
    await assert.rejects(resolveRunner({ jobType: "awx", formType: "awx", extravars: { __runner__: "sem" } }), /Runner 'sem' is a semaphore runner, this form is of type awx: name an awx runner/);
    await assert.rejects(resolveRunner({ jobType: "ansible", formType: "ansible", extravars: { __runner__: "ci" } }), /Runner 'ci' is a jenkins runner, this form is of type ansible: name an RTE runner/);
    // no default of its type : what to add
    await assert.rejects(resolveRunner({ jobType: "awx", formType: "jenkins", extravars: {} }), /No runner for a form of type jenkins: add one of type jenkins/);
  });

  test("a runner turned off takes no job, named or default ; one from before the column takes them", async () => {
    runnerRows = [{ name: "rte-off", type: "rte", is_default: 1, enabled: 0 }, { name: "rte-on", type: "rte", enabled: 1 }, { name: "rte-old", type: "rte" }];
    await assert.rejects(resolveRunner({ jobType: "ansible", extravars: {} }), /Runner 'rte-off' is disabled - enable it under Connections > Runners/);
    await assert.rejects(resolveRunner({ jobType: "ansible", extravars: { __runner__: "rte-off" } }), /Runner 'rte-off' is disabled/);
    assert.equal((await resolveRunner({ jobType: "ansible", extravars: { __runner__: "rte-on" } })).row.name, "rte-on");
    assert.equal((await resolveRunner({ jobType: "ansible", extravars: { __runner__: "rte-old" } })).row.name, "rte-old");
  });

  test("a job whose form type is not given is matched by capability, as before", async () => {
    runnerRows = [{ name: "sem", type: "semaphore" }, { name: "ci", type: "jenkins" }];
    assert.equal((await resolveRunner({ jobType: "awx", extravars: { __runner__: "ci" } })).impl.type, "jenkins");
    await assert.rejects(resolveRunner({ jobType: "ansible", extravars: { __runner__: "sem" } }), /Runner 'sem' \(semaphore\) cannot run a playbook/);
  });

  test("a runner the form names but nobody added fails the job with a line that says so", async () => {
    row({ __playbook__: "site.yml", __runner__: "rte-nope" });
    const ok = await dispatch({ jobId: 11, jobType: "ansible", extravars: { __runner__: "rte-nope" } });
    assert.equal(ok, false);
    assert.equal(spawned.length, 0);
    assert.equal(jobRow.status, "failed");
    assert.ok(outputs.some((o) => /No runner named 'rte-nope'/.test(o.output)));
  });

  test("a named rte is handed the job, and the job remembers it for the abort", async () => {
    runnerRows = [{ name: "rte-vmware", type: "rte", uri: "http://rte:8000", token: "t" }];
    const launch = vi.spyOn(RUNNERS.rte, "launch").mockResolvedValue(true);
    try {
      row({ __playbook__: "site.yml", __runner__: "rte-vmware" });
      await dispatch({ jobId: 11, jobType: "ansible", extravars: { __runner__: "rte-vmware" } });
      assert.equal(launch.mock.calls.length, 1);
      assert.equal(launch.mock.calls[0][0].runner.name, "rte-vmware");
      assert.equal(jobRow.runner, "rte-vmware");
    } finally {
      launch.mockRestore();
    }
  });

  test("a template job runs on the default awx runner, never on an rte", async () => {
    runnerRows = [{ name: "rte-default", type: "rte", is_default: 1 }, { name: "aap", type: "awx", is_default: 1 }];
    const picked = await resolveRunner({ jobType: "awx", extravars: {} });
    assert.equal(picked.impl.type, "awx");
    assert.equal(picked.row.name, "aap");
    runnerRows = [{ name: "rte-default", type: "rte", is_default: 1 }];
    await assert.rejects(resolveRunner({ jobType: "awx", extravars: {} }), /No runner to run this template: add one of type awx/);
  });

  test("runner: on a template form names the awx runner ; an rte cannot run a template", async () => {
    runnerRows = [{ name: "aap-prod", type: "awx" }, { name: "rte-vmware", type: "rte" }];
    assert.equal((await resolveRunner({ jobType: "awx", extravars: { __runner__: "aap-prod" } })).row.name, "aap-prod");
    await assert.rejects(resolveRunner({ jobType: "awx", extravars: { __runner__: "rte-vmware" } }), /cannot run a template/);
    await assert.rejects(resolveRunner({ jobType: "ansible", extravars: { __runner__: "aap-prod" } }), /cannot run a playbook/);
  });

  test("awx: is an alias of runner:, and runner: wins when both are there", async () => {
    runnerRows = [{ name: "aap-old", type: "awx" }, { name: "aap-new", type: "awx" }];
    assert.equal((await resolveRunner({ jobType: "awx", extravars: { __awx__: "aap-old" } })).row.name, "aap-old");
    assert.equal((await resolveRunner({ jobType: "awx", extravars: { __awx__: "aap-old", __runner__: "aap-new" } })).row.name, "aap-new");
  });
});
