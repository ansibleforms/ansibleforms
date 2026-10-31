// A playbook's structured events (rte/callback_plugins/af_events.py) are stored on the job and read
// back by everyone who may see it. They kept a host's whole result with its invocation (the
// module's arguments), wrote it to a file of the shared temporary folder under a name anyone could
// guess, and escaped its non-ASCII texts so the app's mask missed a secret with an accent. These pin
// the rules : the whole result whatever the job's verbosity (as on AWX, a host's line always opens
// its details), never its invocation, its secret keys masked (by the plugin and again when stored),
// its size capped, non-ASCII kept, and the file in a private folder of its own.
import { describe, test, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.LOG_PATH ||= "/tmp/ansibleforms-test-logs";

// what the events model was asked to insert
const inserts = [];
vi.mock("../src/models/db.model.js", () => ({
  default: { do: async (sql, params) => { inserts.push(params); return { affectedRows: 1 }; } },
}));

const { artifactsEnv, makeEventsFile, removeEventsDir, executeCommand } = await import("../src/rte/ansible-core.js");
const { createEventTail } = await import("../src/rte/events.js");
const { default: JobEvent, redactResult } = await import("../src/models/jobEvent.model.js");

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/rte/callback_plugins/af_events.py");

// ---------------------------------------------------------------------------------------------
// The events file
// ---------------------------------------------------------------------------------------------

describe("the events file", () => {
  test("is made in a private folder of its own, before the playbook starts", () => {
    const a = makeEventsFile(42);
    const b = makeEventsFile(42);
    try {
      // a folder of its own under the temporary folder, never a name anyone could guess
      expect(path.dirname(a.dir)).toBe(os.tmpdir());
      expect(a.dir).not.toBe(b.dir);
      expect(path.dirname(a.file)).toBe(a.dir);
      expect(fs.existsSync(a.file)).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(a.dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(a.file).mode & 0o777).toBe(0o600);
      }
    } finally {
      removeEventsDir(a.dir);
      removeEventsDir(b.dir);
    }
    expect(fs.existsSync(a.dir)).toBe(false);
  });

  test("a playbook run makes it, hands it to the plugin, and leaves nothing behind", async () => {
    const jobid = 900000 + Math.floor(Math.random() * 99999);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "af-events-run-"));
    const left = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`af_events_${jobid}_`));
    // what the run tells the job : its output kept (the program says the file's mode there)
    const output = [];
    const io = {
      writeOutput: async (id, record) => { output.push(JSON.stringify(record)); },
      started: async () => {},
      exited: async () => {},
      end: async () => {},
      isAbortRequested: async () => false,
      writeEvents: async () => {},
      setJobLog: async () => {},
    };
    // a program that writes where AF_EVENTS_FILE says, as the plugin does, and tells what it saw
    const script = "const fs=require('fs');fs.appendFileSync(process.env.AF_EVENTS_FILE,'{\"type\":\"play\"}\\n');" +
      "process.stdout.write(String(fs.statSync(process.env.AF_EVENTS_FILE).mode & 0o777))";
    try {
      await executeCommand({ directory: cwd, file: process.execPath, args: ["-e", script], task: "t", artifactsFile: path.join(cwd, "a.json"), events: true }, jobid, 0, io);
      expect(left()).toEqual([]);
      // the file the plugin opened was there already, readable by this user only (0600 : 384)
      if (process.platform !== "win32") expect(output.join("")).toContain("384");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the tail reads it and removes it with its folder", async () => {
    const { dir, file } = makeEventsFile(43);
    const got = [];
    const tail = createEventTail({ file, dir, write: async (batch) => got.push(...batch) });
    fs.appendFileSync(file, JSON.stringify({ type: "play", play: "p" }) + "\n");
    await tail.stop();
    expect(got.map((e) => e.type)).toEqual(["play"]);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// What the playbook is told
// ---------------------------------------------------------------------------------------------

describe("the playbook's environment", () => {
  const tmp = os.tmpdir();

  test("no longer asks for the whole result apart, even for a verbose job : the plugin always keeps it", () => {
    // a caller that still says the job runs verbose (the former fifth argument) changes nothing
    expect(artifactsEnv({}, tmp, "/x/a.json", "/x/e.jsonl", true).AF_EVENTS_FULL).toBeUndefined();
    expect(artifactsEnv({}, tmp, "/x/a.json", "/x/e.jsonl").AF_EVENTS_FULL).toBeUndefined();
  });

  test("passes the app's secret keys pattern with the events file", () => {
    expect(artifactsEnv({}, tmp, "/x/a.json", "/x/e.jsonl").AF_EVENTS_MASK_REGEX).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------------------------

describe("a stored result", () => {
  test("loses its invocation at any depth, its secret keys masked", () => {
    const out = redactResult({
      changed: true,
      invocation: { module_args: { password: "p" } },
      json: { access_token: "abc", name: "x", api_key: "k" },
      headers: { Authorization: "Bearer t", "set-cookie": "s=1", server: "nginx" },
      results: [{ item: "a", invocation: { module_args: {} }, secret: "" }],
    });
    expect(out.invocation).toBeUndefined();
    expect(out.results[0].invocation).toBeUndefined();
    expect(out.json).toEqual({ access_token: "********", name: "x", api_key: "********" });
    expect(out.headers).toEqual({ Authorization: "********", "set-cookie": "********", server: "nginx" });
    // an empty one has nothing to hide, a flag stays one
    expect(out.results[0].secret).toBe("");
    expect(out.changed).toBe(true);
  });

  test("is redacted again when the events are stored", async () => {
    inserts.length = 0;
    await JobEvent.create(7, [{ order: 1, type: "ok", host: "h", data: { msg: "hi" }, result: { invocation: { module_args: { password: "p" } }, token: "t", msg: "hi" } }]);
    const row = inserts[0][0][0];
    const stored = JSON.parse(row[9]);
    expect(stored).toEqual({ token: "********", msg: "hi" });
  });

  test("an event without one stores none", async () => {
    inserts.length = 0;
    await JobEvent.create(7, [{ order: 1, type: "ok", host: "h", data: { msg: "hi" } }]);
    expect(inserts[0][0][0][9]).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The plugin itself (when ansible is installed where the tests run)
// ---------------------------------------------------------------------------------------------

// a host's result, as ansible hands it to the plugin (on its standard input, as JSON) : what its _fields keeps of
// it, as JSON. Where ansible is not installed (the tests' CI), its CallbackBase is a stub : the
// plugin's own code runs all the same
const PROBE = `
import importlib.util, json, sys, types
try:
    import ansible.plugins.callback
except ImportError:
    stub = types.ModuleType("ansible.plugins.callback")
    stub.CallbackBase = type("CallbackBase", (), {})
    for name in ("ansible", "ansible.plugins"):
        sys.modules[name] = types.ModuleType(name)
    sys.modules["ansible.plugins.callback"] = stub
spec = importlib.util.spec_from_file_location("af_events", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class R: pass
r = R()
r._task = None
fields = mod.CallbackModule._fields(None, r, json.load(sys.stdin))
print(json.dumps(fields, ensure_ascii=False))
`;
const hasPython = spawnSync("python3", ["--version"]).status === 0;

// a result as a module returns it : its message, its invocation, a response with a secret, a loop item
const RESULT = {
  msg: "café",
  changed: true,
  invocation: { module_args: { password: "p" } },
  json: { token: "t", name: "n" },
  item: { user: "zoë", password: "pw" },
  _ansible_no_log: false,
};

/**
 * Runs the probe on the plugin, as a job that does not run verbose : no -v flag, and nothing in
 * the environment that would ask for the whole result.
 *
 * Args:
 *   data (object): the host's result, as ansible hands it to the plugin.
 *
 * Returns:
 *   object: what the plugin keeps of the result.
 */
function probe(data = RESULT) {
  const run = spawnSync("python3", ["-c", PROBE, PLUGIN], { input: JSON.stringify(data), encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout);
}

describe.skipIf(!hasPython)("the af_events plugin", () => {
  test("keeps the summary and the whole result whatever the job's verbosity, as on AWX", () => {
    const fields = probe();
    expect(fields.data).toEqual({ msg: "café", changed: true });
    expect(fields.result).toEqual({ msg: "café", changed: true, json: { token: "********", name: "n" }, item: { user: "zoë", password: "********" } });
  });

  test("leaves out its invocation and Ansible's own keys, its secrets masked", () => {
    const fields = probe();
    expect(fields.result.invocation).toBeUndefined();
    expect(fields.result._ansible_no_log).toBeUndefined();
    expect(fields.result.json).toEqual({ token: "********", name: "n" });
  });

  test("cuts a result too large to keep", () => {
    // 300 lines of 9000 characters : past MAX_RESULT, its list and its texts are cut
    const fields = probe({ changed: false, stdout_lines: Array.from({ length: 300 }, () => "x".repeat(9000)) });
    expect(JSON.stringify(fields.result).length).toBeLessThanOrEqual(65536);
    expect(fields.result).toEqual({ msg: "The result is too large to keep", keys: ["changed", "stdout_lines"] });
    // a smaller one only has its long texts and its long list cut
    const cut = probe({ stdout_lines: Array.from({ length: 250 }, () => "y".repeat(100)), stdout: "z".repeat(70000) }).result;
    expect(cut.stdout.length).toBe(8003);
    expect(cut.stdout_lines).toHaveLength(201);
    expect(cut.stdout_lines[200]).toBe("... 50 more");
  });

  test("a dictionary item is JSON with its non-ASCII kept and its secrets masked", () => {
    const fields = probe();
    expect(JSON.parse(fields.item)).toEqual({ user: "zoë", password: "********" });
    expect(fields.item).toContain("zoë");
  });
});
