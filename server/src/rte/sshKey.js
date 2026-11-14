/******************************************************************/
/*                                                                */
/*  An SSH credential's private key, for one playbook job.        */
/*                                                                */
/*  A form's Ansible login (ansibleCredentials) may be an SSH     */
/*  credential with a private key. The RTE writes the key to a    */
/*  file of the job's own : in a folder made for it under the     */
/*  temporary folder (mkdtemp, readable by this user only), the   */
/*  file created there exclusively and readable by this user      */
/*  only, as the events file (ansible-core.js makeEventsFile).    */
/*  ansible-playbook gets it as ansible_ssh_private_key_file.     */
/*                                                                */
/*  A key with a passphrase is loaded into an ssh-agent started   */
/*  for that job alone : ssh-add reads the passphrase from an     */
/*  askpass script that answers once from its environment (the    */
/*  passphrase is never written to a file), the key file goes as  */
/*  soon as the agent holds the key, and ansible-playbook gets    */
/*  the agent's socket as SSH_AUTH_SOCK. The agent is stopped and */
/*  the folder removed when the job ends, whatever its end.       */
/*                                                                */
/******************************************************************/
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import logger from "../lib/logger.js";
import { playbookEnv } from "../lib/playbookEnv.js";

// how long ssh-agent may take to open its socket, and ssh-add to load the key
const AGENT_START_MS = 5000;
const ADD_TIMEOUT_MS = 30000;

// the askpass script ssh-add runs for the passphrase : it answers once (a wrong passphrase is
// not asked again for ever), from its environment, never from a file
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  "# AnsibleForms : the passphrase of the job's private key, once",
  '[ -e "$AF_ASKPASS_DONE" ] && exit 1',
  ': > "$AF_ASKPASS_DONE"',
  "printf '%s\\n' \"$AF_KEY_PASSPHRASE\"",
  "",
].join("\n");

/**
 * The reason a job cannot use its private key : said as it is in the job's output.
 */
export class SshKeyError extends Error {
  /**
   * Args:
   *   message (string): what went wrong, for the job's output.
   */
  constructor(message) {
    super(message);
    this.name = "SshKeyError";
  }
}

/**
 * A private key as ssh reads it from a file : its lines ended by \n (a key pasted on Windows
 * comes with \r\n, which OpenSSH refuses as "invalid format"), and a last line end, which it
 * needs as well.
 *
 * Args:
 *   key (string): the key as stored.
 *
 * Returns:
 *   string: the key to write.
 */
export function normalizeKey(key) {
  return String(key ?? "").replace(/\r\n?/g, "\n").trim() + "\n";
}

/**
 * Makes the job's private folder and writes the key in it : mkdtemp (a random name, 0700), the
 * file opened exclusively (wx, never one already there, not a link) and 0600.
 *
 * Args:
 *   jobid (number|string): the job.
 *   key (string): the private key.
 *
 * Returns:
 *   {dir: string, file: string}: the folder and the key file in it.
 */
export function makeKeyFile(jobid, key) {
  const safeId = String(jobid).replace(/[^0-9A-Za-z_-]/g, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `af_sshkey_${safeId}_`));
  // mkdtemp makes it 0700 already : said again, whatever the platform
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "id_key");
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, normalizeKey(key));
  } finally {
    fs.closeSync(fd);
  }
  // a umask cannot have widened it, but ssh refuses a key others can read : said again
  fs.chmodSync(file, 0o600);
  return { dir, file };
}

/**
 * Removes the job's key folder and what is left in it (the key, the agent's socket, the
 * askpass script), quietly.
 *
 * Args:
 *   dir (string): the folder (makeKeyFile), empty or none for nothing.
 *
 * Returns:
 *   void
 */
export function removeKeyDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.debug(`The private key folder ${dir} could not be removed: ${e.message}`);
  }
}

/**
 * The error a missing ssh-agent or ssh-add gives, said the way an operator can act on.
 *
 * Args:
 *   program (string): ssh-agent or ssh-add.
 *
 * Returns:
 *   SshKeyError: the error.
 */
function notAvailable(program) {
  return new SshKeyError(
    `${program} is not available on this RTE: a private key with a passphrase is loaded into an ssh-agent for the job. Install the OpenSSH client (ssh-agent and ssh-add) on the RTE, or use a key without a passphrase`,
  );
}

/**
 * Starts an ssh-agent for the job, in the foreground (-D, so this process holds it and stops
 * it) with its socket in the job's private folder, and waits for the socket.
 *
 * Args:
 *   dir (string): the job's private folder.
 *   spawnFn (function): spawn, or a test's.
 *
 * Returns:
 *   Promise<{agent: object, socket: string}>: the agent's process and its socket.
 *
 * Raises:
 *   SshKeyError: ssh-agent is missing, or does not open its socket in time.
 */
export async function startAgent(dir, spawnFn = spawn) {
  const socket = path.join(dir, "agent.sock");
  // step 1 : the agent, without a shell, with the playbook's environment
  let agent;
  try {
    agent = spawnFn("ssh-agent", ["-D", "-a", socket], { stdio: ["ignore", "ignore", "pipe"], env: playbookEnv() });
  } catch (e) {
    if (e?.code === "ENOENT") throw notAvailable("ssh-agent");
    throw new SshKeyError(`ssh-agent could not start: ${e.message}`);
  }
  let stderr = "";
  agent.stderr?.setEncoding?.("utf8");
  agent.stderr?.on?.("data", (d) => {
    stderr += d;
  });
  // step 2 : its socket, or the reason it never came
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    agent.on("error", (e) => finish(e?.code === "ENOENT" ? notAvailable("ssh-agent") : new SshKeyError(`ssh-agent could not start: ${e.message}`)));
    agent.on("exit", (code) => finish(new SshKeyError(`ssh-agent stopped at its start (status ${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
    const poll = setInterval(() => {
      if (fs.existsSync(socket)) finish();
    }, 25);
    const timer = setTimeout(() => finish(new SshKeyError("ssh-agent did not open its socket in time")), AGENT_START_MS);
  }).catch((err) => {
    stopAgent(agent);
    throw err;
  });
  return { agent, socket };
}

/**
 * Stops the job's ssh-agent, quietly : the key it holds goes with it.
 *
 * Args:
 *   agent (object|null): its process (startAgent).
 *
 * Returns:
 *   Promise<void>: settles once it stopped, or after a second.
 */
export async function stopAgent(agent) {
  // none, or gone already (ended, or stopped by a signal)
  if (!agent) return;
  if ((agent.exitCode !== null && agent.exitCode !== undefined) || agent.signalCode) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    agent.once?.("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      agent.kill("SIGTERM");
    } catch (e) {
      logger.debug(`The job's ssh-agent could not be stopped: ${e.message}`);
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Loads the key into the job's agent with ssh-add, its passphrase read from the askpass script
 * (SSH_ASKPASS with SSH_ASKPASS_REQUIRE=force ; detached, so without a terminal, for an
 * OpenSSH older than 8.4 that does not know force). The passphrase is in ssh-add's
 * environment only, which no other user can read.
 *
 * Args:
 *   dir (string): the job's private folder.
 *   keyFile (string): the key file.
 *   socket (string): the agent's socket.
 *   passphrase (string): the key's passphrase.
 *   spawnFn (function): spawn, or a test's.
 *
 * Returns:
 *   Promise<void>: settles once the agent holds the key.
 *
 * Raises:
 *   SshKeyError: ssh-add is missing, the passphrase is wrong or the key cannot be read.
 */
export async function addKey(dir, keyFile, socket, passphrase, spawnFn = spawn) {
  // step 1 : the askpass script, made as the key file (exclusively, readable by this user only)
  const askpass = path.join(dir, "askpass.sh");
  const fd = fs.openSync(askpass, "wx", 0o700);
  try {
    fs.writeSync(fd, ASKPASS_SCRIPT);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(askpass, 0o700);
  const base = playbookEnv();
  const env = {
    ...base,
    SSH_AUTH_SOCK: socket,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: "force",
    // an OpenSSH before 8.4 runs the askpass only with a display set
    DISPLAY: base.DISPLAY || ":0",
    AF_ASKPASS_DONE: path.join(dir, "askpass.done"),
    AF_KEY_PASSPHRASE: String(passphrase),
  };
  // step 2 : ssh-add, without a shell, and stopped when it takes too long
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn("ssh-add", [keyFile], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
    } catch (e) {
      reject(e?.code === "ENOENT" ? notAvailable("ssh-add") : new SshKeyError(`ssh-add could not start: ${e.message}`));
      return;
    }
    let stderr = "";
    child.stdout?.on?.("data", () => {});
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (d) => {
      stderr += d;
    });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // gone already
      }
      reject(new SshKeyError("ssh-add did not load the private key in time"));
    }, ADD_TIMEOUT_MS);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e?.code === "ENOENT" ? notAvailable("ssh-add") : new SshKeyError(`ssh-add could not start: ${e.message}`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      // its own words (Bad passphrase, invalid format...) : they never hold the passphrase
      else reject(new SshKeyError(`the private key could not be loaded into ssh-agent (is the passphrase right?)${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
    });
  });
}

/**
 * Makes a job's private key ready for ansible-playbook : written to a private file, passed as
 * ansible_ssh_private_key_file ; with a passphrase, loaded into an ssh-agent of the job's own
 * instead, its socket passed as SSH_AUTH_SOCK and the key file removed once loaded. The
 * cleanup it returns stops the agent and removes the folder : called when the job ends,
 * whatever its end. On an error, what was made is removed before it is thrown.
 *
 * Args:
 *   jobid (number|string): the job.
 *   privateKey (string): the private key (PEM or OpenSSH).
 *   passphrase (string): its passphrase, empty for none.
 *   spawnFn (function): spawn, or a test's.
 *
 * Returns:
 *   Promise<{extravars: object, env: object, dir: string, cleanup: function}>: the hidden
 *     extravars and the environment to add to the playbook's, the folder, and the cleanup.
 *
 * Raises:
 *   SshKeyError: the key cannot be written, ssh-agent or ssh-add is missing, or the key does
 *     not load (a wrong passphrase).
 */
export async function prepareSshKey(jobid, privateKey, passphrase = "", spawnFn = spawn) {
  // step 1 : the key, in the job's private folder
  let made;
  try {
    made = makeKeyFile(jobid, privateKey);
  } catch (e) {
    throw new SshKeyError(`the private key could not be written: ${e.message}`);
  }
  const { dir, file } = made;
  let agent = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stopAgent(agent);
    removeKeyDir(dir);
  };
  // step 2 : no passphrase, the file is all ansible needs
  if (!passphrase) return { extravars: { ansible_ssh_private_key_file: file }, env: {}, dir, cleanup };
  // step 3 : a passphrase, the job's own agent holds the key
  try {
    const started = await startAgent(dir, spawnFn);
    agent = started.agent;
    await addKey(dir, file, started.socket, passphrase, spawnFn);
    // held by the agent now : no key on the disk while the playbook runs
    fs.rmSync(file, { force: true });
    return { extravars: {}, env: { SSH_AUTH_SOCK: started.socket }, dir, cleanup };
  } catch (e) {
    await cleanup();
    throw e instanceof SshKeyError ? e : new SshKeyError(e.message || String(e));
  }
}

export default { SshKeyError, normalizeKey, makeKeyFile, removeKeyDir, startAgent, stopAgent, addKey, prepareSshKey };
