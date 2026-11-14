// The RTE's side of an SSH credential's private key (server/src/rte/sshKey.js, issue #1345) :
// the key in a private file of the job's own, removed when the job ends ; a key with a
// passphrase loaded into an ssh-agent of the job's own, its key file gone once loaded, the agent
// stopped at the end ; a missing ssh-agent or a wrong passphrase fails with a clear message and
// leaves nothing behind. The real ssh-agent test runs where ssh-keygen, ssh-agent and ssh-add are.
import { describe, test, expect } from "vitest";
import { EventEmitter } from "events";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const { prepareSshKey, makeKeyFile, normalizeKey, SshKeyError, checkAskpassRuns, startAgent, stopAgent, AGENT_KEY_LIFETIME_SECONDS } = await import("../src/rte/sshKey.js");

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\r\n-----END OPENSSH PRIVATE KEY-----";

/**
 * Whether a program can be run here.
 *
 * Args:
 *   program (string): its name.
 *
 * Returns:
 *   boolean: true when it is on the PATH.
 */
function has(program) {
  return spawnSync("sh", ["-c", `command -v ${program}`]).status === 0;
}
const HAVE_OPENSSH = process.platform !== "win32" && ["ssh-keygen", "ssh-agent", "ssh-add"].every(has);

describe("the private key file", () => {
  test("its line ends as ssh wants them : \\n, and one at the end", () => {
    expect(normalizeKey(KEY)).toBe(KEY.replace(/\r\n/g, "\n") + "\n");
  });

  test("in a folder of the job's own (0700), the file 0600, never one already there", () => {
    const { dir, file } = makeKeyFile(42, KEY);
    try {
      expect(path.basename(dir)).toMatch(/^af_sshkey_42_/);
      expect(path.dirname(dir)).toBe(os.tmpdir());
      if (process.platform !== "win32") {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
      expect(fs.readFileSync(file, "utf8")).toBe(normalizeKey(KEY));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a job id cannot lead the folder elsewhere", () => {
    const { dir } = makeKeyFile("../../etc/x", KEY);
    try {
      expect(path.dirname(dir)).toBe(os.tmpdir());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a key without a passphrase", () => {
  test("is passed as ansible_ssh_private_key_file, and gone with its folder after the cleanup", async () => {
    const ready = await prepareSshKey(7, KEY, "");
    const file = ready.extravars.ansible_ssh_private_key_file;
    expect(file).toBe(path.join(ready.dir, "id_key"));
    expect(fs.existsSync(file)).toBe(true);
    expect(ready.env).toEqual({});
    await ready.cleanup();
    expect(fs.existsSync(ready.dir)).toBe(false);
    // twice is harmless
    await ready.cleanup();
  });
});

describe("a key with a passphrase, without ssh-agent", () => {
  /**
   * A spawn that finds no program : the error a missing ssh-agent gives.
   *
   * Returns:
   *   object: a child that fails with ENOENT.
   */
  const missing = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.exitCode = null;
    setTimeout(() => child.emit("error", Object.assign(new Error("spawn ssh-agent ENOENT"), { code: "ENOENT" })), 5);
    return child;
  };

  test("fails with a clear message, and leaves no key behind", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_8_"));
    const err = await prepareSshKey(8, KEY, "phrase", missing).catch((e) => e);
    expect(err).toBeInstanceOf(SshKeyError);
    expect(err.message).toMatch(/ssh-agent is not available on this RTE/);
    expect(err.message).toMatch(/Install the OpenSSH client/);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_8_"));
    expect(after).toEqual(before);
  });
});

describe.skipIf(!HAVE_OPENSSH)("a key with a passphrase, with the real ssh-agent", () => {
  /**
   * A new ed25519 key protected by a passphrase, made by ssh-keygen in a folder of its own.
   *
   * Args:
   *   passphrase (string): its passphrase.
   *
   * Returns:
   *   {key: string, pub: string, dir: string}: the private key, the public one, the folder.
   */
  function newKey(passphrase) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-test-key-"));
    const file = path.join(dir, "id");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "af-test", "-f", file]);
    return { key: fs.readFileSync(file, "utf8"), pub: fs.readFileSync(`${file}.pub`, "utf8").trim(), dir };
  }

  test("is loaded into the job's own agent, its file gone, the agent stopped at the end", async () => {
    const made = newKey("correct horse battery");
    try {
      const ready = await prepareSshKey(9, made.key, "correct horse battery");
      const socket = ready.env.SSH_AUTH_SOCK;
      expect(socket).toBe(path.join(ready.dir, "agent.sock"));
      expect(ready.extravars).toEqual({});
      // held by the agent, not on the disk
      expect(fs.existsSync(path.join(ready.dir, "id_key"))).toBe(false);
      const listed = spawnSync("ssh-add", ["-L"], { env: { ...process.env, SSH_AUTH_SOCK: socket }, encoding: "utf8" });
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain(made.pub.split(" ")[1]);
      await ready.cleanup();
      expect(fs.existsSync(ready.dir)).toBe(false);
      const gone = spawnSync("ssh-add", ["-l"], { env: { ...process.env, SSH_AUTH_SOCK: socket }, encoding: "utf8" });
      expect(gone.status).toBe(2);
    } finally {
      fs.rmSync(made.dir, { recursive: true, force: true });
    }
  }, 20000);

  test("a wrong passphrase fails at once, asked once, and leaves nothing behind", async () => {
    const made = newKey("the right one");
    try {
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_10_"));
      const started = Date.now();
      const err = await prepareSshKey(10, made.key, "not the right one").catch((e) => e);
      expect(err).toBeInstanceOf(SshKeyError);
      expect(err.message).toMatch(/could not be loaded into ssh-agent/);
      expect(err.message).not.toContain("not the right one");
      expect(Date.now() - started).toBeLessThan(15000);
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_10_"));
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(made.dir, { recursive: true, force: true });
    }
  }, 20000);
});

/**
 * A fake ssh-agent and ssh-add : the agent opens its socket, ssh-add ends as asked.
 *
 * Args:
 *   addStatus (number): ssh-add's status.
 *   addStderr (string): what ssh-add says.
 *   seen (object): where the agent's arguments are kept.
 *
 * Returns:
 *   function: a spawn.
 */
const fakeOpenSsh = (addStatus = 0, addStderr = "", seen = {}) => (file, a) => {
  const p = new EventEmitter();
  p.exitCode = null;
  p.signalCode = null;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = (signal) => {
    p.signalCode = signal;
    setTimeout(() => p.emit("exit", null, signal), 1);
    return true;
  };
  if (file === "ssh-agent") {
    seen.agentArgs = a;
    fs.writeFileSync(a[a.indexOf("-a") + 1], "");
  } else {
    setTimeout(() => {
      if (addStderr) p.stderr.emit("data", addStderr);
      p.emit("close", addStatus);
    }, 5);
  }
  return p;
};

describe("the job's ssh-agent never outlives its job", () => {
  test("its keys expire (-t) after a bounded time, should the RTE die before it stops the agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-test-agent-"));
    const seen = {};
    try {
      const { agent } = await startAgent(dir, fakeOpenSsh(0, "", seen));
      const args = seen.agentArgs;
      expect(args[args.indexOf("-t") + 1]).toBe(String(AGENT_KEY_LIFETIME_SECONDS));
      expect(AGENT_KEY_LIFETIME_SECONDS).toBeGreaterThan(0);
      expect(AGENT_KEY_LIFETIME_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
      await stopAgent(agent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a temporary folder that runs no program (noexec)", () => {
  // a spawnSync that cannot run the file : what a noexec mount gives
  const noexec = () => ({ error: Object.assign(new Error("spawnSync EACCES"), { code: "EACCES" }), status: null });
  // a spawnSync that ran the script
  const ran = () => ({ status: 1 });

  test("the askpass script is checked, and runs where the temporary folder allows it", () => {
    const { dir } = makeKeyFile(12, KEY);
    try {
      const script = path.join(dir, "probe.sh");
      fs.writeFileSync(script, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      if (process.platform !== "win32") expect(() => checkAskpassRuns(dir, script)).not.toThrow();
      expect(() => checkAskpassRuns(dir, script, noexec)).toThrow(SshKeyError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says noexec and TMPDIR instead of asking whether the passphrase is right, and leaves nothing behind", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_13_"));
    const err = await prepareSshKey(13, KEY, "phrase", fakeOpenSsh(0), noexec).catch((e) => e);
    expect(err).toBeInstanceOf(SshKeyError);
    expect(err.message).toMatch(/noexec/);
    expect(err.message).toMatch(/TMPDIR/);
    expect(err.message).not.toMatch(/passphrase right/);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("af_sshkey_13_"))).toEqual(before);
  });

  test("ssh-add failing to run the script says so too", async () => {
    const stderr = "ssh_askpass: exec(/tmp/af_sshkey_14_x/askpass.sh): Permission denied\n";
    const err = await prepareSshKey(14, KEY, "phrase", fakeOpenSsh(1, stderr), ran).catch((e) => e);
    expect(err).toBeInstanceOf(SshKeyError);
    expect(err.message).toMatch(/cannot be run \(Permission denied\).*noexec.*TMPDIR/);
  });

  test("a wrong passphrase is still said as one", async () => {
    const err = await prepareSshKey(15, KEY, "phrase", fakeOpenSsh(1, "Bad passphrase, try again for /tmp/k:\n"), ran).catch((e) => e);
    expect(err).toBeInstanceOf(SshKeyError);
    expect(err.message).toMatch(/is the passphrase right\?/);
  });
});
