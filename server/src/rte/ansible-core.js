// The one place a playbook runs : the RTE (AF_ROLE=rte, src/rte/server.js) calls
// runAnsibleJob with a job id and the job's secrets, which the app resolved and sealed for it
// (lib/jobSecrets.js, lib/sealedSecrets.js). The RTE never reads the credentials table nor a
// secret store. The app never imports this module : since 7 it runs no playbook itself.
//
// Everything else - the job, its output, its log, its events, its end - goes through the job's
// I/O (useJobIO) : the database in database mode (rte/jobio-db.js, deprecated), the socket to
// the app in the socket modes (socketJobIO in rte/socket/rte-socket.js). This module imports no database
// module, so a socket-mode RTE runs without DB_* at all.
//
// The approval gate is NOT here : a job reaches an RTE only once it may run
// (runners/orchestrator.js, in the app).
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import logger from "../lib/logger.js";
import Cmd from "../lib/cmd.js";
import Helpers from "../lib/common.js";
import { safeParse } from "../lib/safejson.js";
import ansibleConfig from "../../config/ansible.config.js";
import appConfig from "../../config/app.config.js";
import { nodeId } from "../lib/role.js";
import { registerJobSecrets, forgetJobSecrets } from "../lib/outputMask.js";
import { playbookEnv } from "../lib/playbookEnv.js";
import { createOutputBatcher } from "../lib/outputBatcher.js";
import { resolveInventory } from "../lib/inventories.js";
import { createEventTail } from "./events.js";

// ─── the job's I/O ────────────────────────────────────────────────────────────

// where the job is read from and its output written to : set once at the RTE's start for its
// mode (rte/server.js), or by a test
let jobIO = null;

/**
 * Sets where the jobs are read from and their output written to.
 *
 * Args:
 *   io (object): the database's (rte/jobio-db.js) or the socket's (socketJobIO in rte/socket/rte-socket.js).
 */
export function useJobIO(io) {
  jobIO = io;
}

/**
 * The job's I/O in use.
 *
 * Returns:
 *   object: the I/O.
 *
 * Raises:
 *   Error: none was set (a start that skipped useJobIO).
 */
function currentIO() {
  if (!jobIO) throw new Error("the RTE has no job I/O: useJobIO was not called at its start");
  return jobIO;
}

// ─── a playbook's artifacts (set_stats) ───────────────────────────────────────
// The callback plugin that writes what set_stats gathered to a file (callback_plugins/
// af_artifacts.py) : the job stores it as its artifacts, a workflow passes it on (AWX's way).
const CALLBACK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "callback_plugins");
// where ansible looks for callback plugins when nothing says otherwise
const DEFAULT_CALLBACK_PATHS = ["~/.ansible/plugins/callback", "/usr/share/ansible/plugins/callback"];

/**
 * The callback_plugins an ansible.cfg sets, as ansible finds the file : ANSIBLE_CONFIG, else
 * ./ansible.cfg (the playbook folder), ~/.ansible.cfg, /etc/ansible/ansible.cfg. A relative path
 * is the file's folder's.
 *
 * Args:
 *   directory (string): the folder the playbook runs from.
 *   env (object): the playbook's environment.
 *
 * Returns:
 *   string[]: the paths it sets, none when no file sets any.
 */
function configCallbackPaths(directory, env) {
  const home = env.HOME || os.homedir();
  const candidates = [env.ANSIBLE_CONFIG, path.join(directory, "ansible.cfg"), path.join(home, ".ansible.cfg"), "/etc/ansible/ansible.cfg"];
  for (const file of candidates.filter(Boolean)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // the first file found is the one ansible reads, whatever it sets
    let section = "";
    for (const line of text.split(/\r?\n/)) {
      const head = line.match(/^\s*\[([^\]]+)\]/);
      if (head) section = head[1].trim().toLowerCase();
      const set = section === "defaults" && line.match(/^\s*callback_plugins\s*[=:]\s*(.*?)\s*$/i);
      if (set) return set[1].split(path.delimiter).filter(Boolean).map((p) => (p.startsWith("~") || path.isAbsolute(p) ? p : path.resolve(path.dirname(file), p)));
    }
    return [];
  }
  return [];
}

/**
 * The environment a playbook runs with so that its set_stats data is written to a file : the
 * artifacts plugin's folder first in the callback plugins path, then the folders the
 * environment or the ansible.cfg named (an environment variable replaces the config's, so they
 * are kept), else ansible's own ; and the file to write.
 *
 * Args:
 *   env (object): the playbook's environment.
 *   directory (string): the folder the playbook runs from.
 *   artifactsFile (string): the file the plugin writes.
 *   eventsFile (string): the file the events plugin writes a host's results to (its summary and
 *     its whole result, whatever the job's verbosity) ; none when empty.
 *
 * Returns:
 *   object: the environment.
 */
export function artifactsEnv(env, directory, artifactsFile, eventsFile = "") {
  const named = env.ANSIBLE_CALLBACK_PLUGINS ? env.ANSIBLE_CALLBACK_PLUGINS.split(path.delimiter).filter(Boolean) : configCallbackPaths(directory, env);
  const paths = [CALLBACK_DIR, ...(named.length ? named : DEFAULT_CALLBACK_PATHS)];
  const out = { ...env, ANSIBLE_CALLBACK_PLUGINS: [...new Set(paths)].join(path.delimiter), AF_ARTIFACTS_FILE: artifactsFile };
  // the structured events (callback_plugins/af_events.py, loaded without enabling, as the
  // artifacts one) : one JSON line per play, task and host result, next to the usual text output
  if (eventsFile) out.AF_EVENTS_FILE = eventsFile;
  // and the keys whose values a stored result masks : the app's own pattern, the plugin adds it to
  // its built-in one when Python reads it
  if (eventsFile && appConfig.maskExtravarsRegex) out.AF_EVENTS_MASK_REGEX = String(appConfig.maskExtravarsRegex);
  return out;
}

/**
 * Makes the file a job's events are written to : in a folder of its own under the temporary
 * folder (mkdtemp, a random name, readable by this user only), the file created there before
 * ansible-playbook starts, exclusively and readable by this user only. In the shared temporary
 * folder under a name anyone could guess (af_events_<id>.jsonl), another local user could read a
 * job's results, or plant the file (a link) before the playbook wrote it.
 *
 * Args:
 *   jobid (number|string): the job.
 *
 * Returns:
 *   {dir: string, file: string}: the folder and the file in it.
 */
export function makeEventsFile(jobid) {
  const safeId = String(jobid).replace(/[^0-9A-Za-z_-]/g, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `af_events_${safeId}_`));
  // mkdtemp makes it 0700 already : said again, whatever the platform
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "events.jsonl");
  // wx : created here, never one already there
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  return { dir, file };
}

/**
 * Makes the file set_stats is written to (the artifacts plugin) : in a folder of its own under the
 * temporary folder (mkdtemp, readable by this user only), as the events file. Under the guessable
 * name af_artifacts_<id>.json in the shared temporary folder, another local user could read a
 * job's artifacts, or plant the file (a link) before the plugin wrote it.
 *
 * Args:
 *   jobid (number|string): the job.
 *
 * Returns:
 *   {dir: string, file: string}: the folder and the file the plugin writes in it (not made yet :
 *     the plugin writes it only when the playbook calls set_stats).
 */
export function makeArtifactsFile(jobid) {
  const safeId = String(jobid).replace(/[^0-9A-Za-z_-]/g, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `af_artifacts_${safeId}_`));
  fs.chmodSync(dir, 0o700);
  return { dir, file: path.join(dir, "artifacts.json") };
}

/**
 * Removes a job's events folder and what is left in it, quietly : stop() of the tail removes the
 * file, this the folder, on every way out (a playbook that never started too).
 *
 * Args:
 *   dir (string): the folder (makeEventsFile), empty or none for nothing.
 *
 * Returns:
 *   void
 */
export function removeEventsDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.debug(`The events folder ${dir} could not be removed: ${e.message}`);
  }
}

/**
 * The artifacts the plugin wrote, and the file gone : {} when there is none (the playbook did
 * not get to its end) or it cannot be read.
 *
 * Args:
 *   file (string): the file.
 *
 * Returns:
 *   object: the artifacts.
 */
export function takeArtifacts(file) {
  if (!file) return {};
  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch (e) {
    if (e.code !== "ENOENT") logger.warning(`The set_stats data in ${file} could not be read: ${e.message}`);
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // never written, or gone
  }
  return data;
}

/** this RTE's name, stored in jobs.host on the jobs it claims : rte-<hostname>-<port> (lib/role.js) */
export function runnerIdentity() {
  return nodeId;
}

/**
 * The folder the playbook runs from, as the job's I/O finds it : the playbooks repository,
 * else ANSIBLE_PATH (or the files the app sent with the job), plus the form's sub path.
 *
 * Args:
 *   playbookSubPath (string): the form's playbookSubPath.
 *   jobId (number): the job.
 *
 * Returns:
 *   Promise<string>: the folder.
 */
export async function resolvePlaybookDirectory(playbookSubPath = "", jobId = 0) {
  const directory = await currentIO().playbookDirectory(jobId, playbookSubPath);
  return directory || (playbookSubPath ? path.join(ansibleConfig.path, playbookSubPath) : ansibleConfig.path);
}

/**
 * A form's playbook as ansible-playbook takes it : its file (deploy.yml, team/deploy.yml), or its
 * name without the extension (deploy), as a form may name a workflow - the .yml or the .yaml file
 * of that name in the playbook folder. A name with no such file goes as it is : ansible-playbook
 * then says it is not found.
 *
 * Args:
 *   directory (string): the folder the playbook runs from.
 *   playbook (string): the form's playbook.
 *
 * Returns:
 *   string: the playbook's file.
 */
export function playbookFile(directory, playbook) {
  const name = String(playbook ?? "");
  if (!name || /\.ya?ml$/i.test(name) || !directory) return name;
  if (fs.existsSync(path.join(directory, name))) return name;
  for (const ext of [".yml", ".yaml"]) {
    if (fs.existsSync(path.join(directory, name + ext))) return name + ext;
  }
  return name;
}

/**
 * The ansible-playbook arguments for a job's extravars. No shell runs them, so no value
 * needs quoting ; the vault password is not among them (it goes in on stdin).
 */
export function buildAnsibleArgs(extravars, { extravarsFileName, hiddenExtravarsFileName, vaultPassword = "" }) {
  // ansible can have multiple inventories : one -i per entry. A list used to be passed joined
  // as well (-i a,b), which ansible reads as a HOST list - adding hosts named after the files
  const inventory = [];
  if (extravars["__inventory__"]) {
    [].concat(extravars["__inventory__"]).forEach((item) => {
      if (typeof item == "string") {
        inventory.push(item);
      } else {
        logger.warning("Non-string inventory entry");
      }
    });
  }
  const tags = extravars?.__tags__ || "";
  // a workflow node's (AWX's skip_tags, and its verbosity level 1 to 5)
  const skipTags = extravars?.__skipTags__ || "";
  const verbosity = Math.min(5, Math.max(0, Number(extravars?.__verbosity__) || 0));
  const check = extravars?.__check__ || false;
  const verbose = extravars?.__verbose__ || false;
  const limit = extravars?.__limit__ || "";
  const diff = extravars?.__diff__ || false;

  // each argument is text the way the quoted shell string made it : a list becomes "a,b"
  const arg = (value) => String(value ?? "");
  const args = ["-e", `@${extravarsFileName}`, "-e", `@${hiddenExtravarsFileName}`];
  if (vaultPassword) {
    // read from stdin, never from a file or the command line
    args.push("--vault-password-file=/bin/cat");
  }
  inventory.forEach((item) => {
    args.push("-i", arg(item));
  });
  if (tags) {
    args.push("-t", arg(tags));
  }
  if (check) {
    args.push("--check");
  }
  if (diff) {
    args.push("--diff");
  }
  if (skipTags) {
    args.push("--skip-tags", arg(skipTags));
  }
  if (verbose) {
    args.push("-vvv");
  } else if (verbosity) {
    args.push(`-${"v".repeat(verbosity)}`);
  }
  if (limit) {
    args.push("--limit", arg(limit));
  }
  args.push(arg(extravars?.__playbook__));
  return { args, inventory };
}

/**
 * Runs a job's playbook : reads the row, writes the extravars files with the job's secrets,
 * runs ansible-playbook and writes its output and final status to the database.
 * Resolves true on success, false otherwise (the job row says why).
 *
 * Args:
 *   jobId (number): the job.
 *   secrets (object): the job's secrets as the app resolved them (lib/jobSecrets.js) :
 *     { credentials, ansible, vault }.
 */
export async function runAnsibleJob({ jobId, secrets }) {
  if (!secrets || typeof secrets !== "object") throw new Error(`Job ${jobId} came without its secrets`);
  const io = currentIO();
  const job = await io.load(jobId);
  if (!job) throw new Error(`Job ${jobId} does not exist`);
  const extravars = typeof job.extravars === "string" ? safeParse(job.extravars, {}, `job.extravars id=${jobId}`) : { ...(job.extravars || {}) };
  // stored before the id was known
  extravars.__jobid__ = jobId;
  const credentials = secrets.credentials || {};
  // what the output must not show : the credentials' secrets and the password fields' values
  // (in the socket modes the app masks what it writes, and this registers the RTE's own copy)
  await io.registerOutputSecrets(jobId, { form: job.form, extravars, credentials });
  try {
    return await launchPlaybook(extravars, secrets, jobId, Number(job.lastOrder) || 0);
  } finally {
    forgetJobSecrets(jobId);
  }
}

// Jinja markers. ansible templates a string from an extravars file whenever the playbook
// uses it, so a form value of `{{ lookup('pipe', '...') }}` ran that command on the RTE.
const JINJA = /\{\{|\{%|\{#/;

/**
 * The extravars with every string that carries a Jinja marker wrapped as
 * {"__ansible_unsafe": "..."} - ansible's JSON spelling of !unsafe : the playbook receives
 * the same string, it is just never templated. Strings without a marker, numbers, booleans
 * and the structure are left exactly as they were. AWX refuses Jinja in launch-time extra
 * vars by default (ALLOW_JINJA_IN_EXTRA_VARS) ; this is the same rule for the RTE, and a
 * form opts out with allowJinjaInExtravars.
 */
export function markUnsafe(value) {
  if (typeof value === "string") return JINJA.test(value) ? { __ansible_unsafe: value } : value;
  if (Array.isArray(value)) return value.map(markUnsafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = markUnsafe(v);
    return out;
  }
  return value;
}

async function launchPlaybook(ev, secrets, jobid, counter) {
  const credentials = secrets.credentials || {};
  // we make a copy, we don't want to mutate the original
  var extravars = { ...ev };
  var playbook = extravars?.__playbook__;
  var keepExtravars = extravars?.__keepExtravars__ || false;
  var ansibleCredentials = extravars?.__ansibleCredentials__ || "";
  var vaultCredentials = extravars?.__vaultCredentials__ || "";
  var playbookSubPath = extravars?.__playbookSubPath__ || "";
  // merge credentials now
  const merged = { ...extravars, ...credentials };
  // define hiddenExtravars
  var hiddenExtravars = {};
  try {
    if (ansibleCredentials) {
      // resolved by the app ; an error is why it could not read it
      const runCredential = secrets.ansible;
      if (!runCredential || runCredential.error) throw new Error(runCredential?.error || "the app sent no ansible credentials");
      hiddenExtravars.ansible_user = runCredential.user;
      hiddenExtravars.ansible_password = runCredential.password;
      registerJobSecrets(jobid, [runCredential.password]);
    }
    // a credential's password is never a template
    hiddenExtravars = JSON.stringify(markUnsafe(hiddenExtravars));
  } catch (err) {
    logger.error("Failed to get ansible credentials: ", err);
    await currentIO().end(jobid, counter + 1, "stderr", "failed", "[ERROR]: Failed to get ansible credentials");
    return false;
  }
  // define vaultPassword
  var vaultPassword = "";
  try {
    if (vaultCredentials) {
      const vaultCredential = secrets.vault;
      if (!vaultCredential || vaultCredential.error) throw new Error(vaultCredential?.error || "the app sent no vault credentials");
      vaultPassword = vaultCredential.password;
      registerJobSecrets(jobid, [vaultPassword]);
    }
  } catch (err) {
    logger.error("Failed to get vault credentials: ", err);
    await currentIO().end(jobid, counter + 1, "stderr", "failed", "[ERROR]: Failed to get vault credentials");
    return false;
  }
  // an inventory the form names by its name (inventory: production) : that inventory's folder,
  // here - in the inventories folder or an inventories repository, as this RTE sees them
  if (extravars.__inventory__) {
    try {
      const roots = await currentIO().inventoryRoots(jobid);
      const isDir = (p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      };
      extravars.__inventory__ = Array.isArray(extravars.__inventory__)
        ? extravars.__inventory__.map((i) => resolveInventory(i, roots, isDir))
        : resolveInventory(extravars.__inventory__, roots, isDir);
    } catch (err) {
      await currentIO().end(jobid, counter + 1, "stderr", "failed", `[ERROR]: ${err.message}`);
      return false;
    }
  }
  const extravarsFileName = `extravars_${jobid}.json`;
  const hiddenExtravarsFileName = `he_${extravarsFileName}`;
  logger.debug(`Extravars File: ${extravarsFileName}`);
  const directory = await resolvePlaybookDirectory(playbookSubPath, jobid);
  // its name (deploy) as its file (deploy.yml) : a form may name it either way
  playbook = playbookFile(directory, playbook);
  extravars.__playbook__ = playbook;
  const { args, inventory } = buildAnsibleArgs(extravars, { extravarsFileName, hiddenExtravarsFileName, vaultPassword });
  var cmdObj = {
    directory,
    file: "ansible-playbook",
    args: args,
    stdin: vaultPassword,
    description: "Running playbook",
    task: "Playbook",
    extravars: JSON.stringify(merged.__allowJinjaInExtravars__ === true ? merged : markUnsafe(merged)),
    hiddenExtravars: hiddenExtravars,
    extravarsFileName: extravarsFileName,
    hiddenExtravarsFileName: hiddenExtravarsFileName,
    keepExtravars: keepExtravars,
    // what set_stats gathers : written there by the artifacts plugin, stored on the job
    // (a private folder made when the playbook starts : makeArtifactsFile)
    artifactsFile: path.join(os.tmpdir(), `af_artifacts_${jobid}.json`),
    // and the structured events (af_events) : one JSON line each, sent on as they come, in a
    // private folder made when the playbook starts (makeEventsFile) ; a host's whole result with
    // them, whatever the playbook's verbosity, as on AWX
    events: true,
  };

  logger.notice("Running from directory: " + cmdObj.directory);
  logger.notice("Running playbook: " + playbook);
  // the keys only : the values include the resolved credentials
  logger.debug("extravars: " + Object.keys(merged).join(", "));
  logger.debug("inventory: " + inventory);
  try {
    await executeCommand(cmdObj, jobid, counter);
    return true;
  } catch (err) {
    logger.error("Ansible job failed: ", err);
    return false;
  }
}

export function executeCommand(cmd, jobid, counter, io = currentIO()) {
  // a counter to order the output (as it's very fast and the database can mess up the order)
  var jobstatus = "success";
  // a program and its arguments, run without a shell : form values never pass through one
  var file = cmd.file;
  var args = cmd.args || [];
  // written to the process's stdin, then closed (the vault password ; ansible reads it
  // with --vault-password-file=/bin/cat)
  var stdin = cmd.stdin || "";
  var directory = cmd.directory;
  var description = cmd.description;
  var extravars = cmd.extravars;
  var hiddenExtravars = cmd.hiddenExtravars;
  var extravarsFileName = cmd.extravarsFileName;
  var hiddenExtravarsFileName = cmd.hiddenExtravarsFileName;
  var keepExtravars = cmd.keepExtravars;
  var task = cmd.task;
  var artifactsFile = cmd.artifactsFile;
  var artifactsDir = "";
  // the structured events : asked for by a playbook (cmd.events), their file made in a private
  // folder just before ansible-playbook starts (makeEventsFile)
  var eventsWanted = !!cmd.events;
  var eventsFile = "";
  var eventsDir = "";
  // the structured events, read from their file as the playbook writes them
  let events = null;
  // the abort flag lives in the database (Job.abort sets it), so whoever runs the process
  // - this host or another - notices it here and stops the playbook itself
  let killed = false;
  let abortPoll = null;
  let syncJobLog = async () => {};

  // the extravars files hold the resolved credentials : removed on every way out, once
  var filepath;
  var he_filepath;
  const removeExtravarsFiles = () => {
    for (const [file, keep] of [[filepath, keepExtravars], [he_filepath, false]]) {
      if (!file || keep) continue;
      try {
        fs.unlinkSync(file);
      } catch (e) {
        if (e.code !== "ENOENT") logger.error(`[Job ${jobid}] Could not remove ${file}: ${e.message}`);
      }
    }
    filepath = undefined;
    he_filepath = undefined;
  };

  // execute the procces
  return new Promise((resolve, reject) => {
    // a spawn error fires `error` and then `close`, never `exit` ; a failing kill can fire
    // `error` after `exit`. Whichever comes first ends the job, the other is ignored.
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearInterval(abortPoll);
      return true;
    };
    logger.debug(`${description}, ${directory} > ${Helpers.logSafe([file, ...args].join(" "))}`);
    try {
      // the playbook folder is a mount or a repository on the RTE : say so, rather than fail
      // writing the extravars file into a folder that is not there
      if (!directory || !fs.existsSync(directory)) {
        throw new Error(`the playbook folder ${directory || "(none)"} does not exist on RTE ${runnerIdentity()}: mount the playbooks or the repository there, or set ANSIBLE_PATH`);
      }
      if (extravarsFileName) {
        logger.debug(`Storing extravars to file ${extravarsFileName}`);
        filepath = path.join(directory, extravarsFileName);
        fs.writeFileSync(filepath, extravars);

        logger.debug(
          `Storing hidden extravars to file ${hiddenExtravarsFileName}`
        );
        he_filepath = path.join(directory, hiddenExtravarsFileName);
        fs.writeFileSync(he_filepath, hiddenExtravars);
      } else {
        logger.warning("No filename was given");
      }

      // the events file : made now, so it exists, private, before the plugin opens it
      if (eventsWanted) ({ dir: eventsDir, file: eventsFile } = makeEventsFile(jobid));
      // and the artifacts file's folder, private as well
      if (artifactsFile) ({ dir: artifactsDir, file: artifactsFile } = makeArtifactsFile(jobid));

      // adding abort signal
      // spawn, not exec : no shell, and exec ignores `detached`. Detached, the process runs
      // in its own process group, so stopping it stops ansible-playbook and all its workers.
      var child = spawn(file, args, {
        cwd: directory,
        detached: true,
        // the RTE's environment without AnsibleForms' own variables : a playbook never reads
        // ENCRYPTION_SECRET, the database password or a token through lookup('env')
        // and, for a playbook, the artifacts plugin that writes what set_stats gathered
        env: artifactsFile ? artifactsEnv(playbookEnv(), directory, artifactsFile, eventsFile) : playbookEnv(),
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      // a playbook that prompts gets end-of-input instead of waiting for ever
      child.stdin.on("error", (e) => logger.debug(`[Job ${jobid}] stdin: ${e.message}`));
      child.stdin.end(stdin);

      const stopProcess = (why) => {
        if (killed) return;
        killed = true;
        logger.warning(`[Job ${jobid}] ${why}, stopping the playbook`);
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (e) {
          // no process group (already gone, or a platform without them) : walk the tree
          logger.debug(`[Job ${jobid}] Process group kill failed: ${e.message}`);
          Cmd.killChildren(child.pid);
        }
      };
      const stopIfAborted = (abortRequested) => {
        if (abortRequested) stopProcess("Abort requested");
      };
      // the output, written in batches (lib/outputBatcher.js) : past PROCESS_MAX_BUFFER bytes on
      // a stream it is no longer stored, and the playbook goes on
      const output = createOutputBatcher({
        write: (record) => io.writeOutput(jobid, record).catch((error) => logger.error("Failed to create output: ", error)),
        jobId: jobid,
        nextOrder: () => ++counter,
        maxBytes: Number(appConfig.processMaxBuffer) || 0,
      });
      // A playbook may write a log file of its own, .joblogs/job_log_<id>.log next to it,
      // which the job's Logfile panel shows. The app has no playbook folder, so the file is
      // stored on the job (jobs.job_log) : while the playbook runs, when it changed, and once
      // more at the end, after which the file goes.
      const jobLogPath = path.join(directory, ".joblogs", `job_log_${jobid}.log`);
      let jobLogSeen = null;
      syncJobLog = async (final = false) => {
        try {
          const st = await fs.promises.stat(jobLogPath);
          const seen = `${st.size}:${st.mtimeMs}`;
          if (seen !== jobLogSeen) {
            jobLogSeen = seen;
            const content = await fs.promises.readFile(jobLogPath, "utf8");
            await io.setJobLog(jobid, content);
          }
          if (final) await fs.promises.unlink(jobLogPath);
        } catch (e) {
          if (e.code !== "ENOENT") logger.debug(`[Job ${jobid}] Job log sync failed: ${e.message}`);
        }
      };
      // a quiet playbook writes no output for minutes, so the flag is also polled
      abortPoll = setInterval(() => {
        io.isAbortRequested(jobid)
          .then(stopIfAborted)
          .catch((e) => logger.debug(`[Job ${jobid}] Abort check failed: ${e.message}`));
        syncJobLog();
      }, 2000);

      // Store the process ID and host identifier in the database for job control
      if (child.pid) {
        const hostname = runnerIdentity();
        logger.info(`[Job ${jobid}] Process started with PID: ${child.pid} on host: ${hostname}`);
        io.started(jobid, child.pid, hostname)
          .then(() => {
            logger.debug(`[Job ${jobid}] PID ${child.pid} and host ${hostname} stored in database`);
          })
          .catch((err) => {
            logger.error(`[Job ${jobid}] Failed to store PID and host in database: ${err.message}`);
          });
      }

      // the structured events : read from their file every half second and sent on in order
      if (eventsFile && io.writeEvents) {
        events = createEventTail({ file: eventsFile, dir: eventsDir, write: (batch) => io.writeEvents(jobid, batch) });
      }
      // add output eventlistener to the process to save output
      // the abort flag is polled every 2 seconds (abortPoll) : no check per chunk any more
      child.stdout.on("data", (data) => output.add("stdout", data));
      child.stderr.on("data", (data) => output.add("stderr", data));

      // add exit eventlistener to the process to handle status update
      child.on("exit", async function (data) {
        if (!settle()) return;
        // what the playbook wrote last, before the end line
        await output.flush();
        if (events) await events.stop();
        removeEventsDir(eventsDir);
        // first : ansible-playbook is gone, nothing reads them any more, and the database
        // calls below can stall or be cut short by a stop
        removeExtravarsFiles();
        // what set_stats gathered, stored on the job whatever its end (AWX keeps a failed job's too)
        const artifacts = takeArtifacts(artifactsFile);
        removeEventsDir(artifactsDir);
        // the log as the playbook left it, before the job ends
        await syncJobLog(true);
        // Clear the PID and host from the database as the process has ended
        logger.debug(`[Job ${jobid}] Process with PID ${child.pid} has exited`);
        await io.exited(jobid)
          .catch((err) => {
            logger.error(`[Job ${jobid}] Failed to clear PID and host from database: ${err.message}`);
          });
        
        // if the exit was an actual request ; set aborted
        if (child.signalCode == "SIGTERM") {
          const abort_requested = await io.isAbortRequested(jobid);
          if (abort_requested) {
            await io.resetAbortRequested(jobid); // reset the abort requested flag
            await io.end(
              jobid,
              ++counter,
              "stderr",
              "aborted",
              `${task} was aborted by the operator`,
              artifacts
            );
            reject(`${task} was aborted by the operator`);
          } else {
            await io.end(
              jobid,
              ++counter,
              "stderr",
              "failed",
              `${task} was aborted by the main process.  Likely some buffer or memory error occured.  Also check the maxBuffer option.`
            );
            reject(`${task} was aborted by the main process`);
          }
        } else {
          // if the exit was natural; set the jobstatus (either success or failed)
          if (data != 0) {
            jobstatus = "failed";
            logger.error(`[${jobid}] Failed with code ${data}`);
            await io.end(
              jobid,
              ++counter,
              "stderr",
              jobstatus,
              `[ERROR]: ${task} failed with status (${data})`,
              artifacts
            );
            reject(`${task} failed with status (${data})`);
          } else {
            await io.end(
              jobid,
              ++counter,
              "stdout",
              jobstatus,
              `ok: [${task} finished] with status (${data})`,
              artifacts
            );
            resolve(true);
          }
        }
      });
      // add error eventlistener to the process; set failed
      child.on("error", async function (data) {
        if (!settle()) return;
        await output.flush();
        if (events) await events.stop();
        removeEventsDir(eventsDir);
        removeExtravarsFiles();
        takeArtifacts(artifactsFile);
        removeEventsDir(artifactsDir);
        await syncJobLog(true);
        // Clear the PID and host from the database as the process has errored
        logger.debug(`[Job ${jobid}] Process with PID ${child.pid} encountered an error`);
        await io.exited(jobid)
          .catch((err) => {
            logger.error(`[Job ${jobid}] Failed to clear PID and host from database: ${err.message}`);
          });
        
        await io.end(jobid, ++counter, "stderr", "failed", `${task} failed: ` + data);
        reject(data);
      });
    } catch (e) {
      if (!settle()) return;
      removeExtravarsFiles();
      takeArtifacts(artifactsFile);
      removeEventsDir(artifactsDir);
      // the tail's last read before its folder goes
      if (events) events.stop().finally(() => removeEventsDir(eventsDir));
      else removeEventsDir(eventsDir);
      io.end(jobid, ++counter, "stderr", "failed", `[ERROR]: ${task} failed: ${e.message || e}`)
        .catch((err) => logger.error(`[Job ${jobid}] Failed to end the job: ${err.message}`))
        // rejected once the end is written : whoever waits on the run sees the job ended
        .finally(() => reject(e));
    }
  });
}
