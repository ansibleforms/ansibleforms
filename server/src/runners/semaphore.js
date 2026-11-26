// The semaphore runner : a template on Semaphore UI (semaphoreui.com). A form of type semaphore
// names it with `runner: <name>` (or runs on the default one) and its template with
// `template: <name or id>` ; the task's output
// is followed back into the job, as an AWX job's is.
//
// The runner row : uri (the Semaphore server, e.g. https://semaphore.example.com), token (an
// API token of a Semaphore user), project (the project id the templates are in).
import logger from "../lib/logger.js";
import Errors from "../lib/errors.js";
import mysql from "../models/db.model.js";
import Credential from "../models/credential.model.v2.js";
// a cycle (job.model imports the orchestrator) ; only used when a job runs
import Job from "../models/job.model.js";
import { forgetJobSecrets } from "../lib/outputMask.js";
import { clientFor, contactTolerance, delay, jobEnded, lostContact } from "./common.js";
import { rememberRunnerJobUrl } from "../lib/runnerJobLinks.js";

const POLL_MS = 1000;

// Semaphore colours its output with ansi escapes ; the job output colours ansible's lines
// itself (Helpers.formatOutput), from the plain text
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // eslint-disable-line no-control-regex

// a task's status (Semaphore's task_logger) : these three end it
const ENDED = { success: "success", error: "failed", stopped: "aborted" };

function client(runner) {
  return clientFor(runner, { Authorization: `Bearer ${runner.token || ""}` });
}

// what the job output (or the connection test) says when Semaphore does not take the call
function describe(err, runner) {
  const status = err?.response?.status;
  const at = `Semaphore at ${runner.uri}`;
  if (status === 401) return `${at} refused the token: check the API token stored here`;
  if (status === 404) return err.what === "project" ? `${at} has no project ${runner.project}` : `${at} has no such ${err.what || "object"} in project ${runner.project}`;
  if (status) return `${at} answered ${status}: ${err.response.data?.error || err.response.data?.message || err.message}`;
  return `${at} is unreachable: ${err.code || err.message}`;
}

const projectPath = (runner) => `/api/project/${encodeURIComponent(runner.project)}`;

/** proves the connection works : Semaphore answers, the token is a user's, the project exists */
async function check(runner) {
  const http = client(runner);
  try {
    await http.get("/api/ping");
    // the version it runs : its info says it ; none when it does not, the test passing all the same
    const version = await http.get("/api/info").then((res) => res?.data?.version, () => undefined);
    const { data: user } = await http.get("/api/user");
    const { data: project } = await http.get(projectPath(runner)).catch((err) => {
      err.what = "project";
      throw err;
    });
    return { user: user?.username, project: project?.name, projectId: project?.id, ...(version ? { version: String(version) } : {}) };
  } catch (err) {
    throw new Errors.BadRequestError(describe(err, runner));
  }
}

/**
 * The template a form names : its id when the name is a number, else the template of that
 * exact name in the runner's project.
 */
async function findTemplate(http, runner, name) {
  const wanted = String(name ?? "").trim();
  if (!wanted) throw new Errors.BadRequestError("The form names no template (template: <name>)");
  if (/^\d+$/.test(wanted)) {
    try {
      const { data } = await http.get(`${projectPath(runner)}/templates/${wanted}`);
      return data;
    } catch (err) {
      if (err?.response?.status !== 404) throw err;
    }
  }
  const { data } = await http.get(`${projectPath(runner)}/templates`, { params: { sort: "name", order: "asc" } });
  const found = (Array.isArray(data) ? data : []).find((t) => t.name === wanted);
  if (!found) throw new Errors.NotFoundError(`No template '${wanted}' in Semaphore project ${runner.project}`);
  return found;
}

/**
 * The inventory a form names (`inventory:`) : its id when the name is a number, else the
 * inventory of that exact name in the runner's project.
 */
async function findInventory(http, runner, name) {
  const wanted = String(name).trim();
  if (/^\d+$/.test(wanted)) return { id: Number(wanted), name: wanted };
  const { data } = await http.get(`${projectPath(runner)}/inventory`, { params: { sort: "name", order: "asc" } });
  const found = (Array.isArray(data) ? data : []).find((i) => i.name === wanted);
  if (!found) throw new Errors.NotFoundError(`No inventory '${wanted}' in Semaphore project ${runner.project}`);
  return found;
}

// What a template lets a task change. Since 2.10 a template says it (task_params) and
// Semaphore SILENTLY ignores what it does not allow - a limit it ignores runs the playbook on
// every host. A template from before has no task_params and takes them all.
function allows(template, what) {
  if (!template || !Object.prototype.hasOwnProperty.call(template, "task_params")) return true;
  return !!template.task_params?.[what];
}

// the extra vars Semaphore passes to ansible-playbook : the form's values and its resolved
// credentials, without AnsibleForms' own __x__ execution parameters
function extraVars(extravars, credentials) {
  const vars = {};
  for (const [k, v] of Object.entries(extravars || {})) if (!/^__.*__$/.test(k)) vars[k] = v;
  return { ...vars, ...credentials };
}

async function launchTemplate(runner, extravars, credentials, jobid, counter) {
  const http = client(runner);
  await Job.printJobOutput(`ok: [Running on Semaphore ${runner.name} (${runner.uri})]`, "stdout", jobid, ++counter);
  let template;
  let task;
  try {
    template = await findTemplate(http, runner, extravars.__template__);
    const body = {
      template_id: template.id,
      environment: JSON.stringify(extraVars(extravars, credentials)),
      message: `AnsibleForms job ${jobid}`,
    };
    // another inventory, or a limit, the template does not allow would be ignored : the job
    // would run on other hosts than the form asked for, so it does not run
    const refuse = (what, setting) => {
      throw new Errors.BadRequestError(`template ${template.name} does not allow ${what}: switch on "${setting}" on the template in Semaphore`);
    };
    // a form's inventory : one name or id (an RTE form may list several ; Semaphore takes one)
    const inventory = Array.isArray(extravars.__inventory__) ? extravars.__inventory__[0] : extravars.__inventory__;
    if (inventory !== undefined && inventory !== null && String(inventory).trim() !== "") {
      if (!allows(template, "allow_override_inventory")) refuse("another inventory", "Allow override inventory");
      body.inventory_id = (await findInventory(http, runner, inventory)).id;
    }
    // the ansible options : in `params` since Semaphore 2.10 (2.18 ignores them anywhere else),
    // at the top for the versions before
    const params = {};
    if (extravars.__limit__) {
      if (!allows(template, "allow_override_limit")) refuse("a limit", "Allow override limit");
      params.limit = String(extravars.__limit__).split(",").map((h) => h.trim()).filter(Boolean);
    }
    // verbose output is a nicety : without the template's leave the job runs, and says so
    if (extravars.__verbose__) {
      if (allows(template, "allow_debug")) params.debug = true;
      else await Job.printJobOutput(`[WARNING]: template ${template.name} does not allow debug in Semaphore: the output is not verbose`, "stderr", jobid, ++counter);
    }
    if (extravars.__check__) params.dry_run = true;
    if (extravars.__diff__) params.diff = true;
    if (Object.keys(params).length) {
      body.params = params;
      Object.assign(body, params, params.limit ? { limit: params.limit.join(",") } : {});
    }
    ({ data: task } = await http.post(`${projectPath(runner)}/tasks`, body));
    if (!task?.id) throw new Error("Semaphore returned no task");
  } catch (err) {
    const name = template?.name || extravars.__template__;
    const why = err instanceof Errors.NotFoundError || err instanceof Errors.BadRequestError ? err.message : describe(err, runner);
    logger.error(`Job ${jobid}: could not launch template ${name} on Semaphore: ${why}`);
    // "failed" : endJobStatus also mails the status
    await Job.endJobStatus(jobid, counter + 1, "stderr", "failed", `[ERROR]: Failed to launch template ${name}: ${why}`);
    throw jobEnded(new Errors.ApiError(why));
  }
  logger.info(`Job ${jobid}: Semaphore task ${task.id} of template ${template.name}`);
  await Job.update({ awx_id: task.id }, jobid);
  // its address in the product's UI, kept on the job (lib/runnerJobLinks.js)
  await rememberRunnerJobUrl(jobid);
  await Job.printJobOutput(`ok: [Launched template ${template.name} with taskid ${task.id}]`, "stdout", jobid, ++counter);
  return trackTask(runner, template, task.id, jobid, counter);
}

/**
 * Follow a task to its end : its new output lines into the job, its status mapped onto ours.
 * A loop, as the AWX tracker : one request pair a second for as long as the task runs.
 */
async function trackTask(runner, template, taskId, jobid, counter) {
  const http = client(runner);
  const base = `${projectPath(runner)}/tasks/${taskId}`;
  const contact = contactTolerance();
  // Semaphore returns the whole output on every call : the rows already written
  let seen = 0;
  let toldConfirmation = false;
  let abortSent = false;
  for (;;) {
    let task;
    let rows;
    try {
      ({ data: task } = await http.get(base));
      ({ data: rows } = await http.get(`${base}/output`));
      contact.ok();
    } catch (err) {
      const message = describe(err, runner);
      const r = contact.failed();
      if (r.giveUp) {
        return lostContact(jobid, counter + 1, `[ERROR]: lost contact with Semaphore while following task ${taskId} (${message}): it may still be running, check it in Semaphore`);
      }
      logger.warning(`Job ${jobid}: Semaphore did not answer [${r.failures}], retrying in ${r.waitMs / 1000}s: ${message}`);
      await delay(r.waitMs);
      continue;
    }
    const lines = (Array.isArray(rows) ? rows : []).slice(seen).map((r) => String(r?.output ?? "").replace(ANSI, "").replace(/\n+$/, ""));
    seen += lines.length;
    // printJobOutput answers the abort flag, also when there is nothing to write
    const abortRequested = await Job.printJobOutput(lines.join("\n"), "stdout", jobid, ++counter);

    const ended = ENDED[task?.status];
    if (ended) {
      if (ended === "success") {
        await Job.endJobStatus(jobid, counter + 1, "stdout", "success", `ok: [Successfully completed template ${template.name}]`);
        return true;
      }
      if (ended === "aborted") {
        await Job.resetAbortRequested(jobid);
        await Job.endJobStatus(jobid, counter + 1, "stderr", "aborted", `Template ${template.name} was aborted`);
        return `Template ${template.name} was aborted`;
      }
      const message = `Template ${template.name} completed with status ${task.status}`;
      await Job.endJobStatus(jobid, counter + 1, "stderr", "failed", `[ERROR]: ${message}`);
      return message;
    }
    if (task?.status === "rejected") {
      const message = `Template ${template.name} was rejected in Semaphore`;
      await Job.endJobStatus(jobid, counter + 1, "stderr", "failed", `[ERROR]: ${message}`);
      return message;
    }
    if (task?.status === "waiting_confirmation" && !toldConfirmation) {
      toldConfirmation = true;
      await Job.printJobOutput(`Template ${template.name} waits for a confirmation in Semaphore`, "stderr", jobid, ++counter);
    }
    if (abortRequested && !abortSent) {
      abortSent = true;
      await Job.printJobOutput("Abort requested", "stderr", jobid, ++counter);
      try {
        await http.post(`${base}/stop`, { force: false });
        // the task ends as stopped : the next polls write its last lines and end the job
      } catch (err) {
        await Job.printJobOutput(`Abort request denied (${describe(err, runner)}), reverting abort request`, "stderr", jobid, ++counter);
        await Job.resetAbortRequested(jobid);
        abortSent = false;
      }
    }
    await delay(POLL_MS);
  }
}

export default {
  type: "semaphore",
  capabilities: { playbook: false, template: true },
  check,
  // resolves once the task has ended and its output is tracked
  async launch(ctx) {
    const { jobId, extravars, credentialMap, runner } = ctx;
    const credentials = await Credential.resolveCredentialMap(extravars.__credentials__ || credentialMap || {});
    // the task's output is tracked here : the credentials' secrets and the password fields'
    // values are masked in it (they are passed to Semaphore as extra vars)
    const rows = await mysql.do("SELECT form FROM AnsibleForms.`jobs` WHERE id=?", [jobId]);
    await Job.registerOutputSecrets(jobId, { form: rows?.[0]?.form, extravars, credentials });
    try {
      return await launchTemplate(runner, extravars, credentials, jobId, await Job.lastOrder(jobId));
    } finally {
      forgetJobSecrets(jobId);
    }
  },
  // the fast path : stops the task straight away ; the tracker also sees the abort flag
  async cancel(ctx) {
    const rows = await mysql.do("SELECT awx_id FROM AnsibleForms.`jobs` WHERE id=?", [ctx.jobId]);
    const taskId = rows?.[0]?.awx_id;
    if (!taskId) return;
    try {
      await client(ctx.runner).post(`${projectPath(ctx.runner)}/tasks/${taskId}/stop`, { force: false });
    } catch (err) {
      logger.debug(`Job ${ctx.jobId}: Semaphore did not take the stop (${err.message}) ; the tracker will`);
    }
  },
};
