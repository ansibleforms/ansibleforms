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

const { prepareSshKey, makeKeyFile, normalizeKey, SshKeyError } = await import("../src/rte/sshKey.js");

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
