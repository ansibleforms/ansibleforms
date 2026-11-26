// What happens to a job between "it may start" and "a runner runs it" : the approval gate,
// then the runner. Notifications and the multistep sequence stay in job.model.js.
import moment from "moment";
import logger from "../lib/logger.js";
import Errors from "../lib/errors.js";
import mysql from "../models/db.model.js";
import Job from "../models/job.model.js";
import Runner from "../models/runner.model.js";
import { getRunner } from "./index.js";
import { runnerKind, RUNNER_TYPE_OF } from "../lib/jobTypes.js";

function getTimestamp() {
  return moment.utc(Date.now()).format("YYYY-MM-DD HH:mm:ss");
}

/** what the approval line names : the playbook or the template */
function approvalLabel(jobType, extravars) {
  return String((jobType === "awx" ? extravars?.__template__ : extravars?.__playbook__) ?? "?");
}

/**
 * Halts a job for approval : the APPROVE line, status 'approve' and the notification.
 * The job continues through Job.approve -> Job.continue -> dispatch({ approved: true }).
 */
export async function approvalGate({ jobId, jobType, extravars, approval }) {
  const label = approvalLabel(jobType, extravars);
  await Job.sendApprovalNotification(approval, extravars, jobId);
  await Job.printJobOutput(
    `APPROVE [${label}] ${"*".repeat(Math.max(0, 69 - label.length))}`,
    "stdout",
    jobId,
    (await Job.lastOrder(jobId)) + 1
  );
  // only a running job waits for approval : one aborted meanwhile stays aborted
  await Job.transitionStatus(jobId, ["running"], {
    status: "approve",
    approval: JSON.stringify(approval),
    end: getTimestamp(),
  });
  return true;
}

// What a job of each job type needs from its runner : a job of a form that does not say its type
// (an older caller) is matched by capability, and falls back to the default rte or awx
const NEEDS = {
  ansible: { capability: "playbook", defaultType: "rte" },
  awx: { capability: "template", defaultType: "awx" },
};

// how the error names a runner type
const RUNNER_LABEL = { rte: "an AnsibleForms", awx: "an awx", semaphore: "a semaphore", rundeck: "a rundeck", jenkins: "a jenkins" };

// `awx: <name>` on a form is the 7.x way of naming the AWX connection : an alias of
// `runner: <name>` since 7, removed in 8. Said once per name, not on every job.
const warnedAwxAlias = new Set();
function warnAwxAlias(name) {
  if (warnedAwxAlias.has(name)) return;
  warnedAwxAlias.add(name);
  logger.warning(`Form property awx: '${name}' is deprecated since 7 and removed in 8: use runner: '${name}'`);
}

/**
 * Refuses a runner turned off (Connections > Runners, Disable) : no job goes to it, the default
 * of its type included, until it is turned on again. A row from before the column is on.
 *
 * Args:
 *   row (object): the runner.
 *
 * Raises:
 *   BadRequestError: it is turned off.
 */
function assertEnabled(row) {
  if (row.enabled !== undefined && row.enabled !== null && Number(row.enabled) === 0) {
    throw new Errors.BadRequestError(`Runner '${row.name}' is disabled - enable it under Connections > Runners, or name another runner on the form with runner: <name>`);
  }
}

/**
 * Where a job runs. A form's type names the product it runs on (RUNNER_TYPE_OF : ansible an
 * RTE, awx, aap and ascender an awx runner, semaphore, rundeck, jenkins their own) ; the form
 * names a runner of that type with `runner: <name>` (extravar __runner__ ; `awx: <name>` is a
 * deprecated alias), or runs on its type's default. Without that the job fails : since 7 the
 * app runs nothing itself.
 * Returns { impl, row } : the runner implementation and its row.
 */
export async function resolveRunner({ jobType, formType, extravars }) {
  const needs = NEEDS[jobType];
  if (!needs) throw new Errors.BadRequestError(`No runner for jobs of type '${jobType}'`);
  const what = needs.capability;
  // the runner type the form's type asks for ; none when the caller did not say (by capability)
  const runnerType = RUNNER_TYPE_OF[formType];
  let name = extravars?.__runner__;
  if (!name && extravars?.__awx__) {
    name = extravars.__awx__;
    warnAwxAlias(name);
  }
  if (name) {
    const row = await Runner.findByName(name);
    if (!row) throw new Errors.NotFoundError(`No runner named '${name}' - add it under Connections > Runners`);
    const impl = getRunner(row.type);
    if (runnerType && row.type !== runnerType) {
      throw new Errors.BadRequestError(`Runner '${name}' is ${RUNNER_LABEL[row.type] || row.type} runner, this form is of type ${formType}: name ${RUNNER_LABEL[runnerType] || runnerType} runner`);
    }
    if (!impl.capabilities[what]) throw new Errors.BadRequestError(`Runner '${name}' (${row.type}) cannot run a ${what}`);
    assertEnabled(row);
    return { impl, row };
  }
  const defaultType = runnerType || needs.defaultType;
  const row = await Runner.findDefault(defaultType);
  if (row) {
    assertEnabled(row);
    return { impl: getRunner(row.type), row };
  }
  const forms = runnerType ? `for a form of type ${formType}` : `to run this ${what}`;
  throw new Errors.NotFoundError(`No runner ${forms}: add one of type ${defaultType} under Connections > Runners and mark it as default, or name it on the form with runner: <name>`);
}

/**
 * Runs an ansible or awx job : through the approval gate (unless approved, or a step of a
 * multistep, which approves as a whole), then on its runner. Resolves when the job ended.
 */
export async function dispatch({ jobId, jobType, formType, extravars, credentialMap, approval = null, approved = false }) {
  if (approval && !approved) {
    return approvalGate({ jobId, jobType, extravars, approval });
  }
  if (approval) logger.notice(`Continuing ${jobType} job ${jobId}, it has been approved`);
  let runner;
  try {
    runner = await resolveRunner({ jobType, formType, extravars });
  } catch (err) {
    await Job.endJobStatus(jobId, (await Job.lastOrder(jobId)) + 1, "stderr", "failed", `[ERROR]: ${err.message}`);
    return false;
  }
  // remembered on the job : an abort knows where to send the cancel
  // and what it is (jenkins, aap ...) : the jobs list says where the job ran, whatever becomes
  // of the runner later
  await mysql.do("UPDATE AnsibleForms.`jobs` SET runner=?, runner_kind=? WHERE id=?", [runner.row?.name || null, runnerKind(runner.row), jobId]);
  return runner.impl.launch({ jobId, jobType, extravars, credentialMap, runner: runner.row });
}
