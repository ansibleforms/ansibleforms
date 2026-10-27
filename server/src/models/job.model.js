"use strict";
import { publish } from "../lib/liveEvents.js";
import fs from "fs";
import moment from "moment";
import Helpers from "../lib/common.js";
import Errors from "../lib/errors.js";
import Settings from "./settings.model.js";
import logger from "../lib/logger.js";
import { safeParse } from "../lib/safejson.js";
import loggerConfig from "../../config/log.config.js";
import appConfig from "../../config/app.config.js";
import mysql from "./db.model.js";
import NotificationChannel from "./notificationChannel.model.js";
import Form from "./form.model.js";
import Expression from "./expression.model.js";
import Query from "./query.model.js";
import { resolveFormQuery } from "../lib/queryPolicy.js";
import { createFormServices } from "../lib/formServices.js";
import { validateLaunch, describeLaunchErrors, compareExtravars, stepModel } from "../lib/launchValidation.js";
import { filterRawFormData, readModelPath, maskPasswords } from "../lib/formEngine/output.js";
import { collectSecrets, registerJobSecrets, maskOutput } from "../lib/outputMask.js";
import { sha256 } from "../lib/formEngine/node/hash.js";
import path from "path";
import { fileURLToPath } from "url";
import i18n from "../lib/i18n.js";
import { dispatch, resolveRunner } from "../runners/orchestrator.js";
import Credential from "./credential.model.v2.js";
import { scopeFromRoles, assertRunnerAllowed, runWithScope } from "../lib/resourceScope.js";
import { getRunner } from "../runners/index.js";
import Runner from "./runner.model.js";
import { stripTrailingSlashes } from "../lib/url.js";
import { nodeId } from "../lib/role.js";
import { NODE_DEAD_SECONDS } from "../lib/nodes.js";
import { SOCKET_MODES, queueMinutes } from "../rte/socket/protocol.js";
import { runWorkflow } from "./workflowRun.js";
import { jobTypeOf } from "../lib/jobTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function pushForminfoToExtravars(formObj, extravars, creds = {}) {
  // push top form fields to extravars
  // change in 4.0.16 => easier to process & available in playbook, might be handy
  // no credentials added here, because then can also come from asCredential property and these would get lost.
  const topFields = [
    "template",
    "awx",
    "runner",
    "playbook",
    "tags",
    "limit",
    "executionEnvironment",
    "check",
    "diff",
    "verbose",
    "keepExtravars",
    "allowJinjaInExtravars",
    "credentials",
    "inventory",
    "awxCredentials",
    "ansibleCredentials",
    "vaultCredentials",
    "instanceGroups",
    "scmBranch",
    "playbookSubPath",
    // a workflow node's run (models/workflowRun.js) : AWX's skip_tags and verbosity level
    "skipTags",
    "verbosity"
  ];
  for (const fieldName of topFields) {
    // Check if the field exists in formObj and if the property is not present in extravars
    if (
      Object.prototype.hasOwnProperty.call(formObj, fieldName) &&
      extravars[`__${fieldName}__`] === undefined
    ) {
      extravars[`__${fieldName}__`] = formObj[fieldName];
    }
  }
  // the form schema spells it scm_branch ; the reserved key stayed __scmBranch__
  if (extravars.__scmBranch__ === undefined && formObj.scm_branch !== undefined) extravars.__scmBranch__ = formObj.scm_branch;
  // `job:` is `template:` in a Rundeck's or a Jenkins' words : the runners read __template__
  if (extravars.__template__ === undefined && formObj.job !== undefined) extravars.__template__ = formObj.job;
  extravars["__credentials__"] = { ...extravars["__credentials__"], ...creds };
  // console.log(extravars)
}
/**
 * Strip the reserved `__x__` execution parameters from a CLIENT-supplied extravars object.
 *
 * pushForminfoToExtravars copies playbook, inventory, tags, limit, credentials and friends
 * out of the FORM definition into `__x__` keys - but only when the key is not already set.
 * Since the launch controller passed req.body.extravars through untouched, a caller could
 * pre-set them and win:
 *
 *   {"formName":"Some form I may run","extravars":{"__playbook__":"provision.yml"}}
 *
 * ...which runs a playbook the role filter on forms was there to keep them away from, with
 * __playbookSubPath__ choosing the working directory and __ansibleCredentials__ choosing
 * whose credentials to inject. These belong to the form, never to the request.
 *
 * `__verbose__` is the one exception: it is a real client choice and the controller checks
 * allowVerboseMode before this runs.
 */
const CLIENT_SETTABLE_RESERVED = new Set(["__verbose__"]);

/**
 * The reserved keys the FORM declares as fields of its own.
 *
 * Several `__x__` keys are a documented feature: "you can also dynamically set the template
 * by using a field called `__template__`" (help.yaml), and the same for `__playbook__`,
 * `__inventory__` and `__tags__`. Such a field is declared in config.yaml, so it is the FORM
 * author's decision - but its value is submitted by the browser like any other field, which
 * makes it indistinguishable on the wire from a key an attacker injected into a raw API
 * call. Stripping every `__x__` therefore silently disabled the documented overrides: the
 * key was dropped, pushForminfoToExtravars then filled it from the static form property
 * (it only writes a reserved key when it is absent), and the job ran the WRONG template
 * while reporting success.
 *
 * The form definition is the thing that tells the two apart, so it is the gate: a reserved
 * key is accepted only when the form declares a field that writes it - by that name, by its
 * `model`, or inside a wizard step's subform. A client that
 * invents `__playbook__` for a form which never declared it is still refused, which is the
 * hole this was written to close.
 */
function declaredReservedFields(formObj) {
  const names = new Set();
  if (!formObj || typeof formObj !== "object") return names;
  const reserved = (key) => typeof key === "string" && /^__.*__$/.test(key);
  // The top-level extravar a field writes, as the client builds it : its `model` (one or
  // several) or else its name, under the wizard step's defaultModel unless the model starts
  // with "/" (written at the root). "a.b" and "a[0]" land under "a".
  const topKeys = (field, prefix = "") => {
    const models = field.model !== undefined && field.model !== null ? [].concat(field.model) : [field.name];
    return models
      .filter((m) => typeof m === "string" && m.trim())
      .map((m) => (m.startsWith("/") ? m.slice(1) : prefix ? `${prefix}.${m}` : m))
      .map((m) => m.split(/\s*\.\s*/)[0].replace(/\[[0-9]+\]$/, "").trim());
  };
  const addFields = (fields, prefix = "") => {
    for (const field of fields || []) {
      if (!field || typeof field !== "object") continue;
      // the field's own name, as before : a field called __playbook__ is a declaration
      if (!prefix && reserved(field.name)) names.add(field.name);
      for (const key of topKeys(field, prefix)) if (reserved(key)) names.add(key);
    }
  };
  addFields(formObj.fields);
  // multistep: each step carries its own fields, and a step is launched as a form of its own
  for (const step of formObj.steps || []) addFields(step?.fields);
  // wizard: each step is a subform whose fields are merged into the extravars, under the
  // step's defaultModel when it has one. Form.load inlines those subforms as formObj.subforms.
  for (const step of Array.isArray(formObj.wizard) ? formObj.wizard : []) {
    const sub = (formObj.subforms || []).find((s) => s?.name === step?.subform);
    if (!sub) continue;
    const prefix = typeof step.defaultModel === "string" ? step.defaultModel.trim().replace(/^\.+|\.+$/g, "") : "";
    addFields(sub.fields, prefix);
  }
  return names;
}
function stripReservedExtravars(extravars, formObj = null) {
  if (!extravars || typeof extravars !== "object") return {};
  const declared = declaredReservedFields(formObj);
  const removed = [];
  for (const key of Object.keys(extravars)) {
    if (/^__.*__$/.test(key) && !CLIENT_SETTABLE_RESERVED.has(key) && !declared.has(key)) {
      delete extravars[key];
      removed.push(key);
    }
  }
  if (removed.length) {
    logger.warning(`Ignoring reserved extravars supplied by the client: ${removed.join(", ")}`);
  }
  return extravars;
}

/**
 * Keep only the credentials a CLIENT may send : the ones the form declares.
 *
 * The browser sends a credentials map built from the form's credential fields (a field of
 * type `credential`, or any field with `asCredential: true`), keyed by the field's name.
 * pushForminfoToExtravars merges that map into `__credentials__`, so a raw REST call could
 * add a key of its own and hand the job any stored credential, under any name, on a form
 * that never asked for one. The form definition is the gate, as for the reserved extravars :
 * a key survives only when the form (one of its multistep steps, or a wizard step's
 * subform) declares a credential field by that name.
 *
 * Args:
 *   credentials (object): the credentials map from the request body.
 *   formObj (object): the form being launched, as Form.load returned it.
 *
 * Returns:
 *   object: a new map holding only the declared keys ; {} when none is declared or the
 *     map is not an object.
 */
function stripUndeclaredCredentials(credentials, formObj = null) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return {};
  const declared = new Set();
  const addFields = (fields) => {
    for (const field of fields || []) {
      if (!field || typeof field !== "object" || typeof field.name !== "string") continue;
      if (field.asCredential === true || field.type === "credential") declared.add(field.name);
    }
  };
  addFields(formObj?.fields);
  // multistep: each step carries its own fields
  for (const step of formObj?.steps || []) addFields(step?.fields);
  // wizard: each step is a subform, inlined by Form.load as formObj.subforms
  for (const step of Array.isArray(formObj?.wizard) ? formObj.wizard : []) {
    const sub = (formObj.subforms || []).find((s) => s?.name === step?.subform);
    if (sub) addFields(sub.fields);
  }
  const kept = {};
  const removed = [];
  for (const [key, value] of Object.entries(credentials)) {
    if (declared.has(key)) kept[key] = value;
    else removed.push(key);
  }
  if (removed.length) {
    logger.warning(`Ignoring credentials supplied by the client that the form does not declare: ${removed.join(", ")}`);
  }
  return kept;
}

/**
 * The raw form data a job keeps, for a relaunch : the user's input only, filtered by the
 * form's fields (filterRawFormData). A wizard has no fields of its own ; its raw form data
 * is its step drafts (`{ __wizard__: true, drafts, skipped }`), each draft filtered by its
 * step's subform, so that a relaunch can check the steps again.
 *
 * Args:
 *   formObj (object): the form, its subforms inlined.
 *   rawFormData (object): the raw form data the launch sent.
 *
 * Returns:
 *   object: the filtered raw form data.
 */
function filterRawFormDataOf(formObj, rawFormData) {
  const subforms = formObj?.subforms || [];
  const steps = Array.isArray(formObj?.wizard) ? formObj.wizard.filter((step) => step && !step.summary) : [];
  if (!steps.length) return filterRawFormData(formObj?.fields || [], rawFormData, subforms);
  if (rawFormData?.__wizard__ !== true || !rawFormData.drafts || typeof rawFormData.drafts !== "object") return {};
  const drafts = {};
  const skipped = {};
  for (const step of steps) {
    const name = step.name || step.subform;
    const sub = subforms.find((s) => s?.name === step.subform);
    const draft = rawFormData.drafts[name];
    if (sub && draft && typeof draft === "object" && !Array.isArray(draft)) {
      drafts[name] = filterRawFormData(sub.fields || [], draft, subforms);
    }
    if (rawFormData.skipped?.[name] === true) skipped[name] = true;
  }
  return { __wizard__: true, drafts, skipped };
}

/**
 * The scope of a user : the credentials, secret stores and runners their roles allow
 * (lib/resourceScope.js), from the roles of the configuration as it is now.
 *
 * Args:
 *   user (object): the user.
 *
 * Returns:
 *   Promise<object|null>: the scope, or null when nothing limits the user.
 */
async function scopeOfUser(user) {
  if (!user || (user.roles || []).includes("admin")) return null;
  const base = await Form.load(null, null, null, true);
  return scopeFromRoles(user, base?.roles || []);
}

/**
 * Refuses a launch whose credentials or runner the user's roles do not allow : every
 * credential the job passes on (its credential map, the ansible and vault credentials) and
 * the runner it would run on. Checked as the launching user, before the job exists ; the job's
 * own dispatch then runs with no request scope, so an approver's roles never judge it.
 *
 * Args:
 *   user (object): the launching user.
 *   jobType (string): ansible, awx or multistep.
 *   extravars (object): the job's extravars (its __credentials__, __runner__ ...).
 *   creds (object): the job's credential map.
 *
 * Raises:
 *   Errors.AccessDeniedError: a credential, a secret store or the runner is not allowed.
 */
async function assertLaunchScope(user, jobType, extravars, creds, formType) {
  const scope = await scopeOfUser(user);
  if (!scope) return;
  const specs = [...Object.values(extravars.__credentials__ || creds || {}), extravars.__ansibleCredentials__, extravars.__vaultCredentials__];
  for (const spec of specs) await Credential.assertAllowed(spec, scope);
  if (scope.runners && (jobType === "ansible" || jobType === "awx")) {
    let runner = null;
    try {
      runner = (await resolveRunner({ jobType, formType, extravars }))?.row || null;
    } catch {
      // no runner at all : the dispatch fails the job and says why
    }
    if (runner) assertRunnerAllowed(runner.name, scope);
  }
}

/**
 * Put the launching user into the extravars/**
 * Put the launching user into the extravars as `ansibleforms_user`, trimmed to whatever the
 * instance and the form asked for (see Helpers.userForExtravars).
 *
 * Called from Job.launch rather than from the four places that used to assign the object -
 * the two launch controllers, the schedule and the datasource - because this is the first
 * point where the FORM is known, and the form may override the global setting with its own
 * `userExtravars`. One place instead of four, and it runs before the job row is written, so
 * the copy in jobs.extravars is trimmed too : that copy, not just the one AWX receives, is
 * half of what the setting exists to stop leaking.
 *
 * Delete first, ALWAYS. A client controls req.body.extravars and the controllers used to
 * overwrite `ansibleforms_user` with the real user - but under `none` there is nothing to
 * overwrite it with, so an assignment that is merely skipped would leave a forged object
 * standing in for the one the setting took away.
 *
 * Whose user object it is : the `user` passed to Job.launch, always, with one exception.
 * A relaunch (`replay`) replays a stored job, whose extravars carry the user who SUBMITTED
 * it, and replaying a job must not rewrite who ran it, so that one is kept. If the stored
 * job has none, because it ran under `none`, the replay gets none either; filling in the
 * person who pressed relaunch would make them the submitter.
 *
 * Nothing else may keep a user found in the extravars. The launch controllers get them
 * from a request body, and the schedule and the datasource get them from their own
 * `extra_vars` YAML, which whoever edits the schedule writes. Either way an
 * `ansibleforms_user` in there is somebody claiming to be a user they are not, which is
 * precisely the claim the FAQ tells playbook authors to assert on.
 */
function setUserExtravars(extravars, user, formObj, replay = false) {
  const source = replay ? extravars.ansibleforms_user : user;
  delete extravars.ansibleforms_user;
  if (source === undefined || source === null) return extravars;
  const trimmed = Helpers.userForExtravars(source, formObj?.userExtravars);
  if (trimmed !== undefined) extravars.ansibleforms_user = trimmed;
  return extravars;
}

function getTimestamp() {
  return moment.utc(Date.now()).format("YYYY-MM-DD HH:mm:ss");
}

//job stuff... interaction with job database
var Job = function (job) {
  if (job.form && job.form != "") {
    // first time insert
    this.form = job.form;
    this.target = job.target;
    this.user = job.user;
    this.user_type = job.user_type;
    this.job_type = job.job_type;
    this.start = getTimestamp();
    this.extravars = job.extravars;
    this.credentials = job.credentials;
    this.notifications = job.notifications;
  }
  if (job.step && job.step != "") {
    // allow single step update
    this.step = job.step;
  }
  if (job.status && job.status != "") {
    // allow single status update
    this.status = job.status;
  }
  if (job.end && job.end != "") {
    // allow single status update
    this.end = job.end;
  }
  if (job.parent_id) {
    this.parent_id = job.parent_id;
  }
};
Job.create = async function (record) {
  // create job
  logger.notice(`Creating job`);
  // the node that follows this job (tracks it on its runner, drives its steps) : when that
  // node restarts or dies, its jobs are ended rather than left 'running' for good
  const res = await mysql.do("INSERT INTO AnsibleForms.`jobs` set ?", { tracker: nodeId, ...record });
  return res.insertId;
};
// ─── the sweeps : jobs nobody follows any more end as abandoned ───
//
// A sweep matches only a job that is still under way : status 'running' (and, where the loop
// that drove it is known to be gone, a workflow job waiting on one of its approval nodes). It
// never matches on abort_requested alone : that flag outlives the job when the abort came too
// late (an aborted workflow, an RTE, AWX or Semaphore job that succeeded before the cancel
// reached it, an approval gate aborted and then rejected), and matching on it turned those
// finished jobs into 'abandoned' after the fact.

// a workflow job waiting on an approval node : under way, but only while its loop lives
const WAITING_WORKFLOW = "(status='approve' AND job_type='workflow')";

/**
 * The hourly sweep : running jobs that showed no sign of life for a day.
 *
 * The age is measured from the job's last activity, not from its start : the latest of its
 * start and its last output line. A workflow or a job that waited more than a day for its
 * approval and was approved just now prints its "approved by" line when it runs on, so it is
 * not abandoned while it runs. Only jobs no runner claimed : one running on an RTE (jobs.host
 * = its name) carries on when the app restarts, and that RTE cleans up its own jobs when it
 * restarts.
 *
 * Args:
 *   all (boolean): every running job, whatever its age (no caller today).
 *
 * Returns:
 *   Promise<number>: the jobs abandoned.
 */
Job.abandon = async function (all = false) {
  logger.notice(`Abandoning jobs`);
  // step 1 : only running jobs, the abort flag answered with the status
  var sql =
    "UPDATE AnsibleForms.`jobs` j set j.status='abandoned',j.abort_requested=0 where j.status='running' and j.host IS NULL ";
  if (!all) {
    // step 2 : a day old, and quiet for a day (no output line since)
    sql = sql +
      "and (j.start < (NOW() - INTERVAL 1 DAY)) " +
      "and NOT EXISTS (SELECT 1 FROM AnsibleForms.`job_output` o WHERE o.job_id=j.id AND o.`timestamp` > (NOW() - INTERVAL 1 DAY))";
  }
  const res = await mysql.do(sql);
  return res.changedRows;
};

/**
 * At a process start : the jobs this node followed died with its previous run - the running
 * ones, and the workflow jobs waiting on an approval node (their loop lived in this process
 * too : approved, nothing would run them on). `untracked` adds the jobs no node follows
 * (started before 7) ; only the worker's start passes it, so they are swept once per database,
 * not by every app node that starts.
 *
 * Args:
 *   tracker (string|null): the node whose jobs end (null : none, with untracked only).
 *   options (object):
 *     untracked (boolean): also the jobs no node follows.
 *
 * Returns:
 *   Promise<number>: the jobs abandoned.
 */
Job.abandonOwn = async function (tracker, { untracked = false } = {}) {
  const res = await mysql.do(
    `UPDATE AnsibleForms.\`jobs\` set status='abandoned',abort_requested=0 where (status='running' or ${WAITING_WORKFLOW}) and host IS NULL and (tracker=?` +
      (untracked ? " or tracker IS NULL" : "") + ")",
    [tracker]);
  return res.changedRows;
};

/**
 * The worker, every minute : the jobs of a node that stopped answering (its row in `nodes` is
 * older than NODE_DEAD_SECONDS, or gone) - a container that was replaced and will never come
 * back under the same name to clean up after itself. A job belongs to the RTE running it
 * (jobs.host) when there is one - it carries on when the app node that started it goes - and
 * otherwise to the node following it (jobs.tracker). A workflow job waiting on an approval
 * node goes too : its loop died with that node.
 *
 * A job running on a socket-mode RTE (its runner's rte_mode is outbound or inbound) is given
 * RTE_QUEUE_MINUTES instead (0 : for ever). Its row in `nodes` is written by the app node
 * holding the RTE's socket, so it ages while the connection is down, while the playbook runs on
 * and the RTE spools its output : back within that time, it sends what it kept and the job goes
 * on ; back without the job, the hub abandons it (runners/rteHub.js abandonLost). A
 * database-mode RTE writes its own row, and an app or a worker node too : NODE_DEAD_SECONDS.
 *
 * Args:
 *   self (string): this node, whose own jobs are never swept here.
 *
 * Returns:
 *   Promise<number>: the jobs abandoned.
 */
Job.abandonDeadNodes = async function (self = nodeId) {
  const owner = "COALESCE(j.host, j.tracker)";
  // step 1 : a job a socket-mode RTE claimed (jobs.host), on a runner in a socket mode now
  const onSocketRte =
    "j.host IS NOT NULL AND EXISTS (SELECT 1 FROM AnsibleForms.`runners` r WHERE r.name=j.runner AND r.type='rte' " +
    "AND r.rte_mode IN (?))";
  // step 2 : that RTE's row seen within RTE_QUEUE_MINUTES (0 : kept for ever, its row or not)
  const minutes = queueMinutes();
  const rteRecent = minutes
    ? " AND EXISTS (SELECT 1 FROM AnsibleForms.`nodes` rn WHERE rn.id=j.host AND rn.role='rte' AND rn.last_seen > (NOW() - INTERVAL ? SECOND))"
    : "";
  // step 3 : the dead-node rule, but for the jobs of a socket-mode RTE still in its window
  const res = await mysql.do(
    "UPDATE AnsibleForms.`jobs` j set j.status='abandoned',j.abort_requested=0 " +
    `where (j.status='running' or (j.status='approve' and j.job_type='workflow')) and ${owner} IS NOT NULL and ${owner}<>? ` +
    `and NOT EXISTS (SELECT 1 FROM AnsibleForms.\`nodes\` n WHERE n.id=${owner} AND n.last_seen > (NOW() - INTERVAL ? SECOND)) ` +
    `and NOT (${onSocketRte}${rteRecent})`,
    [self, NODE_DEAD_SECONDS, SOCKET_MODES, ...(minutes ? [minutes * 60] : [])], true);
  return res.changedRows;
};

/**
 * Whether another node follows a job now : it was taken over (lib/jobResume.js claim) while
 * this node's heartbeat had lapsed. The node that lost it stops following it - no more output
 * lines, no end of its own - so the job is written by one follower only.
 *
 * A job no node names (from before 7) or one an RTE runs (jobs.host) is nobody else's.
 *
 * Args:
 *   id (number): the job.
 *   self (string): this node.
 *
 * Returns:
 *   Promise<boolean>: true when jobs.tracker names another node.
 */
/**
 * A multistep moves on to its next step : the step written, in one statement that matches only
 * a multistep still running and still followed by this node. A sweep that abandoned it, an end
 * written meanwhile, or a take-over by another node leaves it as it is.
 *
 * Args:
 *   id (number): the multistep job.
 *   step (string): the step's name.
 *   self (string): this node.
 *
 * Returns:
 *   Promise<boolean>: true when this loop may run the step.
 */
Job.claimNextStep = async function (id, step, self = nodeId) {
  const res = await mysql.do(
    "UPDATE AnsibleForms.`jobs` SET step=? WHERE id=? AND status='running' AND (tracker IS NULL OR tracker=?)",
    [step, id, self]);
  return (res?.affectedRows || 0) > 0;
};

Job.followedElsewhere = async function (id, self = nodeId) {
  const rows = await mysql.do("SELECT tracker, host FROM AnsibleForms.`jobs` WHERE id=?", [id], true);
  const row = rows?.[0];
  if (!row) return false;
  if (row.host) return false;
  return row.tracker != null && row.tracker !== self;
};
Job.resetAbortRequested = async function (id) {
  logger.debug(`Resetting abort requested for job ${id}`);
  await mysql.do(
    "UPDATE AnsibleForms.`jobs` set abort_requested=0 WHERE id=?",
    [id]
  );
};

Job.update = async function (record, id) {
  logger.notice(`Updating job ${id} -> status=${record.status}`);
  try {
    await mysql.do("UPDATE AnsibleForms.`jobs` set ? WHERE id=?", [record, id]);
  } catch (error) {
    logger.error("Failed to update job", error);
  }
};
/**
 * Moves a job to another status only from the ones given : one statement, so of two writers
 * racing for the same job (the RTE's own end, a sweep that gave it up, the app failing it) only
 * the first one wins.
 *
 * Args:
 *   id (number): the job.
 *   from (string[]): the statuses it may move from.
 *   fields (object): what to write, the new status included.
 *
 * Returns:
 *   Promise<boolean>: true when this call moved it.
 */
Job.transitionStatus = async function (id, from, fields) {
  // a job that ends answers its abort in the same statement : the flag must not outlive the
  // job (a sweep, a relaunch and a second abort all read it). A rejected workflow job is the
  // exception : only its approval node was rejected, its loop runs on, and an abort that came
  // in while it waited must still stop it.
  const write = { ...fields };
  if (TERMINAL_STATUS.includes(write.status) && !("abort_requested" in write)) {
    write.abort_requested = write.status === "rejected" ? KEEP_WORKFLOW_ABORT : 0;
  }
  const res = await mysql.do("UPDATE AnsibleForms.`jobs` SET ? WHERE id=? AND status IN (?)", [write, id, from]);
  return (res?.affectedRows || 0) > 0;
};

// the abort flag of a job moved to 'rejected' : kept for a workflow job (its loop reads it),
// cleared for any other (written as SQL, so one statement decides on the row's own job type)
const KEEP_WORKFLOW_ABORT = { toSqlString: () => "IF(job_type='workflow', abort_requested, 0)" };

// the statuses a job ends from : running, and abandoned - a job the app gave up on (its node
// stopped answering) that its runner finished after all ends with what really happened
const ENDS_FROM = ["running", "abandoned"];

// opts.rethrow : a failure is thrown to the caller, not only logged - the RTE hub then does not
// ack the end, and the RTE sends it again (runners/rteHub.js onItem)
Job.endJobStatus = async (
  jobid,
  counter,
  stream,
  status,
  message,
  awx_artifacts = {},
  opts = {}
) => {
  try {
    // the end is written once : a second writer (a late RTE, a sweep, the app failing it) finds
    // the job ended and leaves it - no second last line, no second mail
    // the abort flag is answered in the same statement : an ended job never carries it
    const moved = await Job.transitionStatus(jobid, ENDS_FROM, {
      status: status,
      end: getTimestamp(),
      awx_artifacts: JSON.stringify(awx_artifacts),
      abort_requested: 0,
    });
    if (!moved) {
      logger.debug(`Job ${jobid} has ended already: not ending it again as ${status}`);
      return;
    }
    await Job.createOutput({
      output: message,
      output_type: stream,
      job_id: jobid,
      order: counter,
    });
    return await Job.sendStatusNotification(jobid);
  } catch (error) {
    logger.error("Failed to end the job.", error);
    if (opts.rethrow) throw error;
  }
};
Job.printJobOutput = async (data, type, jobid, counter, incrementIssue) => {
  if (incrementIssue) {
    await Job.deleteOutput({ job_id: jobid });
  }
  return await Job.createOutput({
    output: data,
    output_type: type,
    job_id: jobid,
    order: counter,
  });
};
// the last output line written for a job ; the next one is this + 1. Every writer (the
// app, an RTE) continues from the database, so two of them never collide.
Job.lastOrder = async function (jobId) {
  const res = await mysql.do("SELECT COALESCE(MAX(`order`),0) AS last FROM AnsibleForms.`job_output` WHERE job_id=?", [jobId]);
  return Number(res?.[0]?.last) || 0;
};
/**
 * A job's output rows, in order : what a runner reads back when it follows the job again
 * (runners/awx/api.js Awx.resume).
 *
 * Args:
 *   jobId (number): the job.
 *
 * Returns:
 *   Promise<object[]>: [{ order, output_type, output }].
 */
Job.outputRows = async function (jobId) {
  return mysql.do("SELECT `order`, output_type, output FROM AnsibleForms.`job_output` WHERE job_id=? ORDER BY `order`", [jobId]);
};
/**
 * Drops the stdout a tracker stored after it launched a job (after the "Launched template" line,
 * or the last "Following job ... again" line) : the tracker that follows the job again reads
 * the remote job's full stdout, which replaces it. The other lines (the launch, an abort
 * request, an error) stay.
 *
 * Args:
 *   jobId (number): the job.
 *   rows (object[]): its output rows (Job.outputRows).
 *
 * Returns:
 *   Promise<number>: the rows dropped.
 */
Job.dropTrackedStdout = async function (jobId, rows) {
  const mark = (rows || [])
    .filter((r) => /^ok: \[(Launched template |Following job )/.test(String(r.output || "")))
    .reduce((max, r) => Math.max(max, Number(r.order)), -1);
  if (mark < 0) return 0;
  const res = await mysql.do(
    "DELETE FROM AnsibleForms.`job_output` WHERE job_id=? AND output_type='stdout' AND `order`>?",
    [jobId, mark]
  );
  return res?.affectedRows || 0;
};
Job.isAbortRequested = async function (id) {
  const res = await mysql.do(
    "SELECT abort_requested FROM AnsibleForms.`jobs` WHERE id=?;",
    [id]
  );
  return !!res[0].abort_requested;
};
/**
 * Whether a user acts on every user's jobs (abort, delete, relaunch) : an admin, or a role with
 * manageAllJobs.
 *
 * Args:
 *   user (object): the user.
 *
 * Returns:
 *   boolean: true when they may.
 */
export function managesAllJobs(user) {
  return (user?.roles || []).includes("admin") || !!user?.options?.manageAllJobs;
}

/**
 * Whether a user sees every user's jobs : an admin, showAllJobLogs, or manageAllJobs (acting on
 * a job means seeing it).
 *
 * Args:
 *   user (object): the user.
 *
 * Returns:
 *   boolean: true when they may.
 */
export function seesAllJobs(user) {
  return managesAllJobs(user) || !!user?.options?.showAllJobLogs;
}

/**
 * @param {object} user The caller. REQUIRED - this had no authorization at all, so any
 *   authenticated user could abort any other user's running playbook by id. Every sibling
 *   (delete, findById) filters on j.user/j.user_type; this one did not, which also made
 *   the AccessDeniedError branch in both job controllers dead code.
 *   Aborting is a mutation of somebody else's run, so it uses the OWNER rule rather than
 *   the read rule - showAllJobLogs lets you watch a job, not kill it.
 */
Job.abort = async function (user, id) {
  logger.notice(`Aborting job ${id}`);
  await Job.checkExists(id);
  if (!user || !user.username) {
    throw new Errors.AccessDeniedError(`You do not have access to job ${id}`);
  }
  // the owner, an admin, or a role with manageAllJobs
  if (!managesAllJobs(user)) {
    const owned = await mysql.do(
      "SELECT id FROM AnsibleForms.`jobs` WHERE id=? AND user=? AND user_type=?",
      [id, user.username, user.type]
    );
    if (owned.length !== 1) {
      throw new Errors.AccessDeniedError(`You do not have access to job ${id}`);
    }
  }
  const abort_requested = await Job.isAbortRequested(id);
  if (abort_requested) {
    throw new Errors.ConflictError("Abort already requested for this job");
  }

  const res = await Job.requestAbort(id);
  if (res.changedRows != 1) {
    throw new Errors.ConflictError("This job was not running");
  }

  // A multistep runs each step as a job of its own (jobs.parent_id = the multistep), and
  // that step's runner - Exec.executeCommand for a playbook, Awx.trackJob(Workflow
  // Job) for AWX - only watches the flag of its OWN row. Flagging just the multistep made it
  // skip the steps that had not started yet, while the step already running carried on to
  // the end : a playbook kept running for as long as it took, and an AWX job was never
  // cancelled. So the running step gets the same abort as a single job would.
  // Ownership was checked on the multistep above, and its steps run as the same user.
  const runningSteps = await mysql.do(
    "SELECT id FROM AnsibleForms.`jobs` WHERE parent_id=? AND status='running'",
    [id]
  );
  for (const step of runningSteps || []) {
    logger.notice(`Aborting step ${step.id} of multistep job ${id}`);
    try {
      await Job.requestAbort(step.id);
    } catch (err) {
      // the multistep itself is flagged already, so it still stops after this step
      logger.error(`[Job ${step.id}] Failed to abort step of job ${id}: ${err.message}`);
    }
  }
  return res;
};
/**
 * Flags one running job for abort and asks its runner to cancel it right away (an RTE stops
 * the playbook, AWX cancels its job). The flag is what actually counts : the runner polls it
 * and stops the job itself if the direct cancel did not reach it.
 * No access check here - callers do that (Job.abort, and the multistep runner for its
 * own steps).
 *
 * @param {number|string} id The job to abort.
 * @returns {Promise<object>} The result of the flag update ; changedRows is 1 when the
 *   job was running and is now flagged, 0 when it was not running (or already flagged).
 */
Job.requestAbort = async function (id) {
  // Set the abort_requested flag first (database as source of truth)
  const res = await mysql.do(
    // a workflow job waiting for an approval node is still under way : its run ends it
    "UPDATE AnsibleForms.`jobs` set abort_requested=1 WHERE id=? AND (status='running' OR (status='approve' AND job_type='workflow'))",
    [id]
  );
  
  if (res.changedRows == 1) {
    // The runner running the job sees the flag within seconds and stops it ; a direct
    // cancel on the runner (an RTE, AWX) stops it at once.
    cancelOnRunner(id).catch((e) => logger.debug(`[Job ${id}] cancel on the runner failed: ${e.message}`));
  }
  return res;
};
// the runner a job was handed to, from jobs.runner (set by the orchestrator)
async function cancelOnRunner(id) {
  const rows = await mysql.do("SELECT runner FROM AnsibleForms.`jobs` WHERE id=?", [id]);
  const name = rows?.[0]?.runner;
  if (!name) return;
  const row = await Runner.findByName(name);
  if (!row) return;
  const impl = getRunner(row.type);
  if (impl.cancel) await impl.cancel({ jobId: id, runner: row });
}
/**
 * Replaces the stdout a tracker stored while a job ran with the job's final, complete stdout.
 *
 * The final stdout is written first, at the order of the first tracked row, and only then
 * are the chunks it replaces deleted, so the job never shows an empty log in between. Only
 * stdout rows are replaced : the error lines written meanwhile (an abort request, a notice)
 * stay.
 *
 * Args:
 *   jobId (number): the job.
 *   fromOrder (number): the order of the first row the tracker could have written.
 *   output (string): the final stdout.
 *
 * Returns:
 *   Promise<void>: settles once the stdout is replaced.
 */
Job.replaceTrackedOutput = async function (jobId, fromOrder, output) {
  if (!output) return;
  output = maskOutput(jobId, output);
  const res = await mysql.do("INSERT INTO AnsibleForms.`job_output` set ?;", [
    { output, output_type: "stdout", job_id: jobId, order: fromOrder },
  ]);
  await mysql.do(
    "DELETE FROM AnsibleForms.`job_output` WHERE job_id=? AND output_type='stdout' AND `order`>=? AND id<>?",
    [jobId, fromOrder, res.insertId]
  );
};
Job.deleteOutput = async function (record) {
  // delete last output
  await mysql.do(
    "DELETE FROM AnsibleForms.`job_output` WHERE job_id=? ORDER BY `order` DESC LIMIT 1",
    [record.job_id]
  );
};
Job.createOutput = async function (record) {
  // logger.debug(`Creating job output`)
  if (record.output) {
    // the secrets the runner registered for this job never reach the table
    record = { ...record, output: maskOutput(record.job_id, record.output) };
    // insert output and return status in 1 go
    await Job.checkExists(record.job_id);
    await mysql.do(
      "INSERT INTO AnsibleForms.`job_output` set ?;",
      [record]
    );
  }
  return await Job.isAbortRequested(record.job_id);
};
/**
 * Stores an output row of a socket-mode RTE once : a row the app stored already (the same job
 * and order, resent after a reconnect) is skipped, so each line is stored exactly once. Masked as
 * every output.
 *
 * Args:
 *   record (object): { output, output_type, job_id, order }.
 *
 * Returns:
 *   Promise<boolean>: true when stored, false when it was there already (or empty).
 */
Job.createOutputOnce = async function (record) {
  if (!record?.output) return false;
  const res = await mysql.do(
    "INSERT INTO AnsibleForms.`job_output` (output, output_type, job_id, `order`) " +
      "SELECT ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM AnsibleForms.`job_output` WHERE job_id=? AND `order`=?)",
    [maskOutput(record.job_id, record.output), record.output_type, record.job_id, record.order, record.job_id, record.order]
  );
  return (res?.affectedRows || 0) > 0;
};
Job.delete = async function (user, id) {
  logger.notice(`Deleting job ${id}`);
  // a role option : on unless a role turns it off (allowJobDeletion), then no job is deleted by
  // this user, theirs included - the job history stays whole
  if (user?.options?.allowJobDeletion === false) {
    throw new Errors.AccessDeniedError(`You may not delete jobs`);
  }

  var query;
  var params;
  await Job.checkExists(id);
  // every user's job : an admin, or manageAllJobs ; seeing them (showAllJobLogs) is not deleting them
  if (managesAllJobs(user)) {
    query =
      "SELECT j.*,sj.subjobs,j2.no_of_records,o.counter FROM AnsibleForms.jobs j LEFT JOIN (SELECT parent_id,GROUP_CONCAT(id separator ',') subjobs FROM AnsibleForms.jobs GROUP BY parent_id) sj ON sj.parent_id=j.id,(SELECT COUNT(id) no_of_records FROM AnsibleForms.jobs)j2,(SELECT max(`order`)+1 counter FROM AnsibleForms.job_output WHERE job_output.job_id=?)o WHERE j.id=?;";
    params = [id, id];
  } else {
    // Owner only. This query was copied from Job.findById, which also lets a non-owner
    // see every job waiting for approval (`OR j.status='approve'`) so an approver can open
    // and approve it. Reading is not deleting : with that clause any signed-in user could
    // delete another user's pending job - and with it the approval that was mailed out -
    // through the API ; only the button was hidden in the UI. Approving and rejecting
    // check the approval roles themselves, so nothing an approver needs goes through here.
    query =
      "SELECT j.*,sj.subjobs,j2.no_of_records,o.counter FROM AnsibleForms.jobs j LEFT JOIN (SELECT parent_id,GROUP_CONCAT(id separator ',') subjobs FROM AnsibleForms.jobs GROUP BY parent_id) sj ON sj.parent_id=j.id,(SELECT COUNT(id) no_of_records FROM AnsibleForms.jobs WHERE user=? AND user_type=?)j2,(SELECT max(`order`)+1 counter FROM AnsibleForms.job_output WHERE job_output.job_id=?)o WHERE j.id=? AND j.user=? AND j.user_type=?;";
    params = [user.username, user.type, id, id, user.username, user.type];
  }
  // get normal data
  var res = await mysql.do(query, params, true);
  if (res.length != 1) {
    throw new Errors.AccessDeniedError(`You do not have access to job ${id}`);
  }
  // Send delete notification BEFORE deleting the job
  await Job.sendEventNotification(id, 'delete', user);
  const result = await mysql.do(
    "DELETE FROM AnsibleForms.`jobs` WHERE id = ? OR parent_id = ?",
    [id, id]
  );
  return result;
};
// Retention. `job_output.job_id` is ON DELETE CASCADE, so output rows follow their
// job automatically - but `parent_id` has NO foreign key, so a multistep parent has
// to take its children with it explicitly or they are orphaned (the same reason
// Job.delete above matches `id = ? OR parent_id = ?`).
//
// Only FINISHED jobs are eligible : `end IS NOT NULL` plus an explicit exclusion of
// 'running', so a long-running or awaiting-approval job is never removed however old
// it is. Parents are selected first and deleted with their children, which also means
// a child is never deleted out from under a parent that is still running.
//
// Deleted in batches : the first run on an instance that has never pruned could
// otherwise lock the table for minutes.
// The statuses a job can never leave. WHITELISTED on purpose : blacklisting 'running'
// looked equivalent and was not, because all four approval paths write status 'approve'
// TOGETHER WITH an `end` timestamp (see the Job.update calls around the approval
// handling). A job awaiting approval therefore looks finished, and pruning it destroys
// un-executed work plus the approval link that was mailed out - not history.
// 'abandoned' has no `end` at all (Job.abandon only sets the status), so age is measured
// on COALESCE(end, start) or those rows would never be prunable.
// 'warning' belongs here : Multistep.launch writes it as a FINAL status when a step failed
// with continue:true. Leaving it out meant the retention sweep never selected those parents,
// and because children are only removed via `OR parent_id IN (?)`, every step row and all
// their job_output survived too - for exactly the jobs that tend to be the largest.
const TERMINAL_STATUS = ['success', 'failed', 'aborted', 'rejected', 'abandoned', 'warning'];

Job.removeOlderThan = async function (days, batchSize = 500) {
  const keep = parseInt(days, 10);
  // 0 / absent / negative means keep for ever - never turn that into a delete
  if (!keep || keep < 1) return 0;
  var removed = 0;
  for (;;) {
    const candidates = await mysql.do(
      "SELECT id FROM AnsibleForms.`jobs` " +
      "WHERE parent_id IS NULL AND status IN (?) " +
      "AND COALESCE(`end`, `start`) < (NOW() - INTERVAL ? DAY) LIMIT ?",
      [TERMINAL_STATUS, keep, batchSize]
    );
    if (candidates.length === 0) break;
    const ids = candidates.map((r) => r.id);
    const res = await mysql.do(
      "DELETE FROM AnsibleForms.`jobs` WHERE id IN (?) OR parent_id IN (?)",
      [ids, ids]
    );
    removed += res?.affectedRows || 0;
    // a batch that deleted nothing would loop for ever
    if (!res?.affectedRows) break;
  }
  return removed;
};
Job.checkExists = async function (id) {
  const res = await mysql.do(
    "SELECT id FROM AnsibleForms.`jobs` WHERE id = ?",
    [id]
  );
  if (res.length == 1) {
    return;
  } else {
    throw new Errors.NotFoundError(`Job ${id} not found`);
  }
};
/**
 * The SQL condition that lets an approver read a job someone else launched : it waits for an
 * approval (status approve) and one of the user's roles is among its approval's roles - the rule
 * Job.findApprovals counts with, and Job.approve and Job.reject check. A job waiting for an
 * approval used to be readable by every signed-in user, its extra vars and output included.
 *
 * Args:
 *   user (object): the caller (its roles).
 *   alias (string): the jobs table's alias with its dot ('j.'), or '' for none.
 *
 * Returns:
 *   {sql: string, params: string[]}: the condition, and the values of its placeholders ; a
 *     condition that is never true for a user without roles.
 */
function approverCondition(user, alias = "") {
  const roles = [...new Set((user?.roles || []).filter((r) => typeof r === "string" && r))];
  if (!roles.length) return { sql: "0", params: [] };
  const contains = roles.map(() => `JSON_CONTAINS(${alias}approval, JSON_QUOTE(?), '$.roles')`).join(" OR ");
  return {
    sql: `(${alias}status='approve' AND JSON_VALID(${alias}approval) AND (${contains}))`,
    params: roles,
  };
}
/**
 * Checks that a user may read a job, without reading it : the same rule as Job.findById (who
 * sees every job, the job's owner, or an approver while it waits for their approval), for the
 * endpoints that only need the answer (its events). findById reads the whole output for it.
 *
 * Args:
 *   user (object): the caller.
 *   id (number|string): the job.
 *
 * Returns:
 *   Promise<void>: settles when the user may read it.
 *
 * Raises:
 *   Errors.NotFoundError: no such job.
 *   Errors.AccessDeniedError: the user may not read it.
 */
Job.assertReadable = async function (user, id) {
  await Job.checkExists(id);
  if (seesAllJobs(user)) return;
  if (!user?.username) throw new Errors.AccessDeniedError(`You do not have access to job ${id}`);
  // the owner, or an approver of the job's approval while it waits for it
  const approver = approverCondition(user);
  const res = await mysql.do(
    "SELECT id FROM AnsibleForms.`jobs` WHERE id=? AND ((user=? AND user_type=?) OR " + approver.sql + ")",
    [id, user.username, user.type, ...approver.params]
  );
  if (res.length != 1) throw new Errors.AccessDeniedError(`You do not have access to job ${id}`);
};
Job.findAll = async function (user, records, filter = {}) {
  logger.info("Finding all jobs");
  // narrowed to one user's jobs (user and user_type) or one runner's (a settings page's Jobs
  // tab) ; within what the caller may see either way
  const where = [];
  const vars = [];
  if (filter.user) { where.push("user=? AND user_type=?"); vars.push(String(filter.user), String(filter.userType || "local")); }
  if (filter.runner) { where.push("runner=?"); vars.push(String(filter.runner)); }
  const narrowed = where.length ? where.join(" AND ") : "1=1";
  var query;
  if (seesAllJobs(user)) {
    query =
      "SELECT id,form,target,status,CONVERT_TZ(start, 'UTC', ?) AS start,CONVERT_TZ(end, 'UTC', ?) AS end,user,user_type,job_type,parent_id,approval,runner,runner_kind FROM AnsibleForms.`jobs` WHERE " + narrowed + " ORDER BY id DESC LIMIT ?";
    return await mysql.do(query, [loggerConfig.tz, loggerConfig.tz, ...vars, records], true);
  } else {
    // their own jobs, and the ones waiting for an approval one of their roles may give
    const approver = approverCondition(user);
    query =
      "SELECT id,form,target,status,CONVERT_TZ(start, 'UTC', ?) AS start,CONVERT_TZ(end, 'UTC', ?) AS end,user,user_type,job_type,parent_id,approval,runner,runner_kind FROM AnsibleForms.`jobs` WHERE ((user=? AND user_type=?) OR " + approver.sql + ") AND " + narrowed + " ORDER BY id DESC LIMIT ?";
    return await mysql.do(query, [loggerConfig.tz, loggerConfig.tz, user.username, user.type, ...approver.params, ...vars, records], true);
  }
};
Job.findApprovals = async function (user) {
  logger.debug("Finding all approval jobs");
  var count = 0;
  var query =
    "SELECT approval FROM AnsibleForms.`jobs` WHERE status='approve' AND approval IS NOT NULL;";
  const res = await mysql.do(query, undefined, true);

  if (user.roles.includes("admin")) {
    return res.length;
  } else {
    res.forEach((item) => {
      //
      var matches = item.approval
        .match(/"roles":\[([^\]]*)\]/)[1]
        .replaceAll('"', "")
        .split(",")
        .filter((x) => user.roles.includes(x));
      if (matches.length > 0) count++;
    });
    return count;
  }
};
// form name -> { at, fields, subforms } : the definitions masking needs, kept for a minute -
// a job being followed is read every few seconds, and Form.load reads the whole config
const PASSWORD_FIELDS_TTL_MS = 60 * 1000;
const passwordFieldsCache = new Map();

// a launch hands over the exact definition its job runs with : a password field added a
// moment ago is then masked on that job's very first read, whatever was cached before
function rememberFormFields(formName, formObj) {
  if (!formName || !formObj) return;
  if (passwordFieldsCache.size > 500) passwordFieldsCache.clear();
  passwordFieldsCache.set(formName, { at: Date.now(), fields: maskableFields(formObj), subforms: formObj.subforms || [] });
}

/**
 * The fields whose values land in a form's extravars, for masking : the form's own, and for
 * a wizard every step's subform fields under the model the step writes them to.
 *
 * Args:
 *   formObj (object): the form, its subforms inlined.
 *
 * Returns:
 *   object[]: the fields.
 */
function maskableFields(formObj) {
  const fields = [...(formObj?.fields || [])];
  for (const step of Array.isArray(formObj?.wizard) ? formObj.wizard : []) {
    if (!step || step.summary) continue;
    const sub = (formObj.subforms || []).find((s) => s?.name === step.subform);
    const prefix = typeof step.defaultModel === "string" ? step.defaultModel.trim().replace(/^\.+|\.+$/g, "") : "";
    for (const f of sub?.fields || []) if (f?.name) fields.push({ ...f, model: stepModel(f, prefix) });
  }
  return fields;
}

async function formFieldsFor(formName) {
  const hit = passwordFieldsCache.get(formName);
  if (hit && Date.now() - hit.at < PASSWORD_FIELDS_TTL_MS) return hit;
  // the definition is only read to know which fields are passwords, never returned : load
  // it regardless of the reader's roles (an approver may not have the form's role)
  const formObj = (await Form.load(["admin"], formName))?.forms?.[0];
  const entry = { at: Date.now(), fields: maskableFields(formObj), subforms: formObj?.subforms || [] };
  if (passwordFieldsCache.size > 500) passwordFieldsCache.clear();
  passwordFieldsCache.set(formName, entry);
  return entry;
}

/**
 * Stored extravars (JSON text) with the value of every password field of the form masked,
 * at its model path, list rows and yaml subforms included. Anything that goes wrong leaves
 * the text as it was - it has been through the key-name regex already.
 */
async function maskPasswordFields(formName, extravarsText) {
  if (!formName || !extravarsText) return extravarsText;
  try {
    const { fields, subforms } = await formFieldsFor(formName);
    const hasPassword = [{ fields }, ...subforms].some((f) => (f?.fields || []).some((x) => x?.type === 'password'));
    if (!hasPassword) return extravarsText;
    const data = JSON.parse(extravarsText);
    return JSON.stringify(maskPasswords(data, fields, subforms));
  } catch (err) {
    logger.debug(`Could not mask the password fields of form '${formName}': ${err.message}`);
    return extravarsText;
  }
}

/**
 * Stored extravars (JSON text) as they may leave the server : the keys that look like a
 * secret masked (Helpers.logSafe), then the form's password fields at their model path. What
 * Job.findById does for a job read logSafe ; a workflow node's child job goes through it too.
 *
 * Args:
 *   formName (string): the form the job ran, whose password fields are masked.
 *   extravarsText (string): the extravars as stored.
 *
 * Returns:
 *   Promise<string>: the masked JSON text ('' for none).
 */
Job.maskExtravars = async function (formName, extravarsText) {
  return maskPasswordFields(formName, Helpers.logSafe(extravarsText));
};

/**
 * The strings of `original` that `masked` replaced, at any depth : the values maskPasswords
 * hid.
 *
 * Args:
 *   original (any): the extravars as they are.
 *   masked (any): the same, with the password fields masked.
 *
 * Returns:
 *   string[]: the original strings that were masked.
 */
function maskedValues(original, masked) {
  if (typeof original === "string") return original !== masked ? [original] : [];
  if (Array.isArray(original)) return original.flatMap((v, i) => maskedValues(v, masked?.[i]));
  if (original && typeof original === "object") {
    return Object.entries(original).flatMap(([k, v]) => maskedValues(v, masked?.[k]));
  }
  return [];
}

/**
 * Registers what a running job's output must not show (lib/outputMask.js) : the secrets of
 * its resolved credentials, any other secret the runner holds (the ansible and vault
 * passwords), and the values of the form's password fields. Called by the runner that
 * resolves them, in its own process, before the job writes any output.
 *
 * Args:
 *   jobId (number): the job.
 *   form (string): the job's form, for its password fields.
 *   extravars (object): the job's extravars.
 *   credentials (object): the resolved credential map.
 *   extra (string[]): other secret values.
 *
 * Returns:
 *   Promise<void>: settles once registered ; a form that cannot be read registers the rest.
 */
Job.registerOutputSecrets = async function (jobId, { form = "", extravars = {}, credentials = {}, extra = [] } = {}) {
  const secrets = [...collectSecrets(credentials), ...extra];
  if (form) {
    try {
      const { fields, subforms } = await formFieldsFor(form);
      const data = JSON.parse(JSON.stringify(extravars || {}));
      secrets.push(...maskedValues(data, maskPasswords(JSON.parse(JSON.stringify(data)), fields, subforms)));
    } catch (err) {
      logger.debug(`[Job ${jobId}] Could not read the password fields of form '${form}': ${err.message}`);
    }
  }
  registerJobSecrets(jobId, secrets);
};

Job.findById = async function (user, id, asText, logSafe = false) {
  logger.info(`Finding job ${id}`);
  var query;
  var params;
  await Job.checkExists(id);
  // Sanitize timezone to prevent SQL injection - only allow valid timezone format
  // Sanitize timezone to prevent SQL injection - only allow valid timezone format
  const safeTimezone = loggerConfig.tz.match(/^[A-Za-z/_+-]+$/) ? loggerConfig.tz : 'UTC';
  
  if (seesAllJobs(user)) {
    query =
      "SELECT j.id,j.form,j.target,j.status,CONVERT_TZ(j.start, 'UTC', ?) AS start,CONVERT_TZ(j.end, 'UTC', ?) AS end,j.user,j.user_type,j.job_type,j.runner,j.runner_kind,j.extravars,j.credentials,j.notifications,j.approval,j.step,j.parent_id,j.awx_id,j.awx_artifacts,j.awx_workflow,j.runner_job_url,j.job_log,j.abort_requested,j.raw_form_data,sj.subjobs,j2.no_of_records,o.counter FROM AnsibleForms.jobs j LEFT JOIN (SELECT parent_id,GROUP_CONCAT(id separator ',') subjobs FROM AnsibleForms.jobs GROUP BY parent_id) sj ON sj.parent_id=j.id,(SELECT COUNT(id) no_of_records FROM AnsibleForms.jobs)j2,(SELECT max(`order`)+1 counter FROM AnsibleForms.job_output WHERE job_output.job_id=?)o WHERE j.id=?;";
    params = [safeTimezone, safeTimezone, id, id];
  } else {
    // the owner, or an approver of the job's approval while it waits for it (approverCondition)
    const approver = approverCondition(user, "j.");
    query =
      "SELECT j.id,j.form,j.target,j.status,CONVERT_TZ(j.start, 'UTC', ?) AS start,CONVERT_TZ(j.end, 'UTC', ?) AS end,j.user,j.user_type,j.job_type,j.runner,j.runner_kind,j.extravars,j.credentials,j.notifications,j.approval,j.step,j.parent_id,j.awx_id,j.awx_artifacts,j.awx_workflow,j.runner_job_url,j.job_log,j.abort_requested,j.raw_form_data,sj.subjobs,j2.no_of_records,o.counter FROM AnsibleForms.jobs j LEFT JOIN (SELECT parent_id,GROUP_CONCAT(id separator ',') subjobs FROM AnsibleForms.jobs GROUP BY parent_id) sj ON sj.parent_id=j.id,(SELECT COUNT(id) no_of_records FROM AnsibleForms.jobs WHERE user=? AND user_type=?)j2,(SELECT max(`order`)+1 counter FROM AnsibleForms.job_output WHERE job_output.job_id=?)o WHERE j.id=? AND ((j.user=? AND j.user_type=?) OR " + approver.sql + ");";
    params = [safeTimezone, safeTimezone, user.username, user.type, id, id, user.username, user.type, ...approver.params];
  }
  try {
    var res = await mysql.do(query, params, true);

    if (res.length != 1) {
      throw new Errors.AccessDeniedError(`You do not have access to job ${id}`);
    }
    var job = res[0];
    // convert artifacts
    job.awx_artifacts = safeParse(job.awx_artifacts, {}, `job.awx_artifacts id=${id}`);
    // convert awx workflow info (null when not a workflow job)
    job.awx_workflow = safeParse(job.awx_workflow, null, `job.awx_workflow id=${id}`);
    // mask passwords : by key name (MASK_EXTRAVARS_REGEX), and every password field of the
    // form by its definition - a password field whose key the regex does not catch (`pw`)
    // was returned readable
    if (logSafe) job.extravars = await maskPasswordFields(job.form, Helpers.logSafe(job.extravars));
    // get output summary
    res = await mysql.do(
      `SELECT 
        COALESCE(output,'') output,
        COALESCE(CONVERT_TZ(\`timestamp\`, 'UTC', ?), '') \`timestamp\`,
        COALESCE(output_type,'stdout') output_type 
      FROM AnsibleForms.\`job_output\` 
      WHERE job_id=? 
      ORDER BY job_output.order;`,
      [safeTimezone, id],
      true
    );

    // the job log file a playbook writes is stored on the job by the runner (jobs.job_log)
    return { ...job, ...{ output: Helpers.formatOutput(res, asText), job_log: job.job_log ?? null } };
  } catch (err) {
    // Rethrow. This used to `return []`, which swallowed the AccessDeniedError thrown a
    // few lines up - the comment above already described the symptom while the cause was
    // still here. Every caller then read [] as a job:
    //
    //   GET /api/v2/job/<someone else's id>  answered 200 with an empty body instead of
    //     403, and the controller's AccessDeniedError branch could never run;
    //   the download route produced an empty attachment named ...job-undefined.txt;
    //   worst, approve/reject read `job.approval` off [] as undefined, so the block that
    //     checks the caller against the job's approval roles was skipped entirely - the
    //     check only failed to be a hole because the status test after it threw.
    //
    // The controllers already map AccessDeniedError to 403 and NotFoundError to 404, and
    // a genuine database fault deserves a 500 rather than a plausible empty job.
    logger.error("Error: ", err);
    throw err;
  }
};
Job.getRawFormData = async function (user, id) {
  logger.info(`Getting raw form data for job ${id}`);
  
  try {
    // Check if user has access to this job
    const job = await Job.findById(user, id, false, false);
    logger.info(`Job found: ${job.form}`);
    
    // Get form to check relaunch permissions
    logger.info(`Loading form: ${job.form}`);
    const formConfig = await Form.load(user?.roles, job.form);
    const formObj = formConfig.forms?.[0];
    if (!formObj) {
      throw new Errors.NotFoundError(`Form '${job.form}' not found or you don't have access to it`);
    }
    logger.info(`Form loaded, checking allowRelaunch: ${formObj.allowRelaunch}`);
    
    assertRelaunchable(job, formObj, user);
    
    // Read raw form data from database
    logger.info(`Loading raw form data from database for job ${id}`);
    
    const result = await mysql.do(
      `SELECT raw_form_data FROM AnsibleForms.jobs WHERE id = ?`,
      [id]
    );
    
    if (!result || result.length === 0 || !result[0].raw_form_data) {
      throw new Errors.NotFoundError(`No saved form data found for job ${id}. This job may have been created before the relaunch feature was enabled.`);
    }
    
    const parsedData = safeParse(result[0].raw_form_data, null, `raw_form_data id=${id}`);
    if (!parsedData) {
      throw new Errors.BadRequestError(`Saved form data for job ${id} is corrupted and cannot be parsed.`);
    }
    
    // Validate form name matches
    if (parsedData.__form__ && parsedData.__form__ !== job.form) {
      throw new Errors.BadRequestError(`Cannot relaunch: saved data is from form '${parsedData.__form__}' but you're trying to load it into form '${job.form}'. Form names must match.`);
    }
    
    // Remove __form__ before returning to client
    // eslint-disable-next-line no-unused-vars -- destructured only to omit __form__ from cleanData
    const { __form__, ...cleanData } = parsedData;
    logger.info(`Successfully loaded raw form data for job ${id} with ${Object.keys(cleanData).length} fields`);
    return cleanData;
  } catch (err) {
    logger.error(`Error in getRawFormData: ${err.message}`, err);
    throw err;
  }
};


/**
 * LAUNCH_VALIDATION (or the form's `launchValidation`, the stricter wins) : validate the raw
 * field values of a REST launch with the form engine the browser and the MCP server use.
 *   - `off` (default) does nothing - the check re-runs the form's expressions and queries,
 *     so an upgrade must not start doing that unasked ;
 *   - `log` logs what would be refused, and where the client's extravars differ from the
 *     ones the server builds, so an operator can see what enforcing would do ;
 *   - `enforce` refuses an invalid launch with a ValidationError (422) carrying the failing
 *     fields, and for a valid one RETURNS the extravars and credentials the server built
 *     from the validated values : Job.launch runs those, not the client's. Otherwise valid
 *     rawFormData next to arbitrary extravars would pass. Computed fields are the server's
 *     evaluation. A wizard form is checked step by step from the step drafts it sends
 *     (lib/launchValidation.js validateWizardLaunch) ; a wizard launch without them is refused.
 *
 * A launch without rawFormData (a raw REST call leaving it out) cannot be
 * validated, and with enforcement on that is itself a refusal : otherwise leaving it out
 * would be the way around the check.
 *
 * @returns {Promise<{extravars: object, credentials: object}|undefined>} enforce only
 */
const LAUNCH_VALIDATION_LEVELS = ['off', 'log', 'enforce'];

/**
 * The launch validation of a form : the stricter of the form's `launchValidation` and the
 * LAUNCH_VALIDATION environment variable. An architect can make a form stricter than the
 * instance (a form that is launched over REST : enforce), never looser.
 */
function launchValidationMode(formObj) {
  const level = (v) => Math.max(0, LAUNCH_VALIDATION_LEVELS.indexOf(String(v || 'off').toLowerCase()));
  return LAUNCH_VALIDATION_LEVELS[Math.max(level(formObj?.launchValidation), level(appConfig.launchValidation))];
}

async function guardLaunch({ form, formConfig, formObj, user, rawFormData, extravars, files = {} }) {
  const mode = launchValidationMode(formObj);
  if (mode !== 'log' && mode !== 'enforce') return;
  const enforce = mode === 'enforce';
  const hasRaw = !!rawFormData && typeof rawFormData === 'object' && Object.keys(rawFormData).length > 0;
  const hasFields = (formObj?.fields || []).length > 0;
  let result;
  if (!hasRaw && hasFields) {
    result = { ok: false, reason: 'no rawFormData was sent (a raw REST call), so the field values cannot be validated' };
  } else {
    try {
      result = await validateLaunch({
        formConfig, formObj, user, rawFormData, extravars, files,
        uploadPath: appConfig.uploadPath,
        services: createFormServices({ user, formConfig, formObj, deps: { Expression, Query, resolveFormQuery } }),
        // an untouched list row passes only when the list's own source produces it : a
        // REST caller cannot slip a plain row past the row checks
        verifyUntouched: true,
      });
    } catch (err) {
      if (enforce) throw new Errors.ValidationError(`Launch validation of form '${form}' failed: ${err.message}`);
      logger.error(`Launch validation of form '${form}' failed, launching anyway (launch validation 'log'): ${err.message}`);
      return;
    }
  }
  if (result.skipped) {
    if (enforce) {
      const err = new Errors.ValidationError(`Form '${form}' cannot be launched with launch validation 'enforce' yet: ${result.skipped}`);
      err.details = { reason: result.skipped };
      throw err;
    }
    logger.debug(`Launch validation of form '${form}' skipped: ${result.skipped}`);
    return;
  }
  if (result.ok) {
    if (enforce) return result.payload;
    const differ = compareExtravars(extravars, result.payload.extravars, result.uploadKeys || []);
    if (differ.length) {
      logger.warning(`Launch of form '${form}': the extravars differ from the ones the server builds for ${differ.join(', ')} (launch validation 'log' ; 'enforce' would run the server's)`);
    }
    return;
  }
  const why = result.reason || describeLaunchErrors(result.errors);
  if (enforce) {
    const err = new Errors.ValidationError(`The form data of '${form}' is not valid - ${why}`);
    err.details = result.errors || { reason: result.reason };
    throw err;
  }
  logger.warning(`Launch validation would refuse form '${form}' for ${user?.username || 'unknown'} (launch validation 'log'): ${why}`);
}

Job.launch = async function ({
  form,
  formObj = null,
  user,
  credentials = {},
  extravars = {},
  parentId = null,
  rawFormData = {},
  waitForCompletion = false,
  // Set ONLY by the two launch controllers : it means `extravars` came from a request body
  // and must be stripped of reserved keys the form did not declare. The other callers
  // (datasource, schedule, and a multistep launching its own steps) build extravars server
  // side from stored configuration, where a `__x__` key is legitimate and stripping it
  // would break the run.
  fromClient = false,
  // Set ONLY by Job.relaunch : keep the submitter stored in the replayed extravars instead
  // of putting `user` there (see setUserExtravars).
  replay = false,
  // Set ONLY by the MCP server, which resolved and validated the form with the same engine
  // just before : the launch validation below need not run it a second time.
  validated = false,
  // the uploads of the form's file fields (POST /api/v2/job/upload results), keyed by field
  files = {},
  // Set ONLY by the schedule : extravars the SERVER adds (the schedule's own record), merged
  // after the launch validation, so they are neither checked as form output nor replaced
  // by the extravars the server builds under 'enforce'.
  serverExtravars = {}
}) {
  let creds = credentials; // Alias for backward compatibility internally

  // A step of a multistep arrives with its formObj already built; a real form arrives with
  // a name and is loaded below. The difference matters for the user trim further down, so
  // record it before the load overwrites the distinction.
  const isStep = !!formObj;

  // a formobj can be a full step pushed
  let formConfig = null;
  if (!formObj) {
    // we load it, it's an actual form
    formConfig = await Form.load(user?.roles, form);
    if (formConfig.forms.length == 0) {
      throw new Errors.NotFoundError(`No such form '${form}'`);
    }
    formObj = formConfig.forms[0]; // we take the first one, as it should be the only one
  }

  if (!isStep) rememberFormFields(form, formObj);

  // Here rather than in the controller : this is the first point where the FORM is known,
  // and the form is what says which reserved keys it declares as fields. It must run BEFORE
  // pushForminfoToExtravars, which fills a reserved key from the static form property only
  // when the key is absent - so stripping afterwards would be indistinguishable from the
  // form's own value. formObj comes from Form.load(user.roles, ...), so the declarations are
  // read from a form this user is allowed to run.
  if (fromClient) stripReservedExtravars(extravars, formObj);
  // the same gate for the credentials map : only the form's own credential fields
  if (fromClient) creds = stripUndeclaredCredentials(creds, formObj);

  // the field values of a REST launch against the form's rules, as the browser checks them
  if (fromClient && !validated && !isStep) {
    const built = await guardLaunch({ form, formConfig, formObj, user, rawFormData, extravars, files });
    // LAUNCH_VALIDATION=enforce : the job runs what the server built from the validated values
    if (built) {
      extravars = built.extravars;
      creds = built.credentials;
    }
  }

  if (serverExtravars && typeof serverExtravars === "object") Object.assign(extravars, serverExtravars);

  if (!isStep) setUserExtravars(extravars, user, formObj, replay);

  pushForminfoToExtravars(formObj, extravars, creds);

  // the credentials and the runner this job would use, as the user's roles allow them
  await assertLaunchScope(user, jobTypeOf(formObj.type), extravars, creds, formObj.type);

  // we have form and we have access
  var notifications = formObj.notifications || {};
  // a template form (or awx, its old name) runs an awx job
  var jobtype = jobTypeOf(formObj.type);
  var target = formObj.name;

  if (!target) {
    throw new Errors.ConflictError("Invalid form or step info");
  }

  // create a new job in the database
  // if reuseId is passed, we don't create a new job and continue the existing one (for approve)
  logger.notice(`Launching form ${form}`);
  var jobid;
  try {
    jobid = await Job.create(
      new Job({
        form: form,
        target: target,
        user: user.username,
        user_type: user.type,
        status: "running",
        job_type: jobtype,
        parent_id: parentId,
        extravars: JSON.stringify(extravars),
        credentials: JSON.stringify(creds),
        notifications: JSON.stringify(notifications),
      })
    );
  } catch (err) {
    logger.error("Failed to create job", err);
    throw new Errors.ApiError(
      `Failed to create job for form ${form}: ${err.message}`
    );
  }

  logger.debug(`Job id ${jobid} is created`);
  extravars["__jobid__"] = jobid;
  
  // Store raw form data in database if provided (exclude sensitive/irrelevant fields)
  if (rawFormData && Object.keys(rawFormData).length > 0) {
    try {
      const filteredRawFormData = {};
      
      // Add form name for validation on reload
      filteredRawFormData.__form__ = form;
      
      // Only the user's input : no constants, no passwords (list rows included), no
      // system fields - the same filter the browser applies before it sends them
      Object.assign(filteredRawFormData, filterRawFormDataOf(formObj, rawFormData));

      // Store in database
      const rawFormDataJson = JSON.stringify(filteredRawFormData);
      await mysql.do(
        `UPDATE AnsibleForms.jobs SET raw_form_data = ? WHERE id = ?`,
        [rawFormDataJson, jobid]
      );
      logger.debug(`Raw form data stored to database for job ${jobid} (filtered: constants, passwords, system fields excluded)`);
    } catch (err) {
      logger.error(`Failed to store raw form data for job ${jobid}:`, err);
    }
  }
  
  // Define the execution function
  const executeJob = async () => {
    // Send launch notification
    await Job.sendEventNotification(jobid, 'launch', user);
    
    // the rest is now happening in the background : the approval gate, then the runner,
    // which resolves the credentials itself
    if (jobtype == "ansible" || jobtype == "awx") {
      // outside the request's scope : assertLaunchScope checked the launching user already,
      // and the runner resolves the credentials for the job, whoever's request this is
      return await runWithScope(null, () => dispatch({
        jobId: jobid,
        jobType: jobtype,
        formType: formObj.type,
        extravars,
        credentialMap: creds,
        approval: parentId ? null : formObj.approval, // if multistep: no individual approvals checks
      }));
    }
    if (jobtype == "workflow") {
      // one of the designer's workflows, run as AWX runs it : its nodes jobs of their own
      return await runWorkflow({ Job, form, formObj, user, extravars, credentials: creds, jobid });
    }
    if (jobtype == "multistep") {
      return await Multistep.launch({
        form,
        steps: formObj.steps,
        user,
        extravars,
        credentials: creds,
        jobid,
        counter: null,
        approval: formObj.approval
      });
    }
  };

  // If waitForCompletion is true (multistep), return jobid immediately with a promise to await
  // Otherwise fire and forget - start execution in background and return job ID immediately
  if (waitForCompletion) {
    // the caller (a multistep's step, a workflow's node) waits on it and sees the error, but
    // only this job's own row can say it failed : ended here too, then passed on
    const completionPromise = executeJob().catch(async (err) => {
      await failJobOnError(jobid, err, "Step job");
      throw err;
    });
    return { id: jobid, completionPromise };
  } else {
    executeJob().catch((err) => failJobOnError(jobid, err, "Background job"));
    return { id: jobid };
  }
};

/**
 * Ends a job whose run threw : nothing else ends it, so it would stay running for ever, with
 * nothing in its output to say why. Ended once (endJobStatus leaves a job that has ended
 * already, an RTE's own end or an abort included) ; never throws.
 *
 * Args:
 *   jobid (number): the job.
 *   err (Error): what its run threw.
 *   what (string): how the log names it (Background job, Step job, Approved job).
 *
 * Returns:
 *   Promise<void>: once the job is ended (or the attempt failed, logged).
 */
async function failJobOnError(jobid, err, what) {
  logger.error(`${what} ${jobid} failed:`, err);
  try {
    const order = (await Job.lastOrder(jobid).catch(() => 0)) + 1;
    await Job.endJobStatus(jobid, order, "stderr", "failed", `[ERROR]: ${err?.message || err}`);
  } catch (e) {
    logger.error(`Could not end job ${jobid} as failed: ${e?.message || e}`);
  }
}


Job.continue = async function ({ form, user, credentials = {}, extravars = {}, jobid }) {
  const creds = credentials; // Alias for backward compatibility internally
  var formObj;
  // we load it, it's an actual form
  await Job.checkExists(jobid);
  const formConfig = await Form.load(user?.roles, form);
  if (formConfig.forms.length == 0) {
    throw new Errors.NotFoundError(`No such form '${form}'`);
  }
  formObj = formConfig.forms[0]; // we take the first one, as it should be the only one

  pushForminfoToExtravars(formObj, extravars, creds);
  extravars["__jobid__"] = jobid;

  // console.log(formObj)
  // we have form and we have access
  var jobtype = jobTypeOf(formObj.type);
  var target;
  if (jobtype == "ansible") {
    target = formObj.playbook;
  }
  if (jobtype == "awx") {
    target = formObj.template ?? formObj.job;
  }
  if (jobtype == "multistep") {
    target = formObj.name;
  }
  if (!target) {
    // throw "Invalid form or step info"
    throw new Errors.ConflictError("Invalid form or step info");
  }
  const job = await Job.findById(user, jobid, true);

  var step = job.step;
  var counter = job.counter;
  await Job.printJobOutput(
    `changed: [approved by ${user.username}]`,
    "stdout",
    jobid,
    ++counter
  );
  // Conditional claim, not a blind update. Job.approve reads the row, sees 'approve' and
  // calls this - so two approvers clicking within the same second (or one double click)
  // both got here and both launched the SAME job: two ansible-playbook processes,
  // interleaved output, and jobs.pid overwritten by whichever started second, so a later
  // abort killed only one of them. Job.abort already uses this pattern.
  const claimed = await mysql.do(
    // and the node continuing it follows it from here
    "UPDATE AnsibleForms.`jobs` SET status='running', tracker=? WHERE id=? AND status='approve'",
    [nodeId, jobid]
  );
  if (!claimed.affectedRows) {
    logger.warning(`Job ${jobid} is no longer awaiting approval, not continuing`);
    return;
  }

  // A runner reads the job row, so the row holds the extravars this run continues with :
  // pushForminfoToExtravars above may have added what the form gained since the launch.
  const storedExtravars = { ...extravars };
  delete storedExtravars.__jobid__;
  await mysql.do("UPDATE AnsibleForms.`jobs` SET extravars=? WHERE id=?", [JSON.stringify(storedExtravars), jobid]);

  // Launch job in background and return immediately
  const executeApprovedJob = async () => {
    if (jobtype == "ansible" || jobtype == "awx") {
      // outside the approver's scope : the job was checked against its submitter's roles
      return await runWithScope(null, () => dispatch({
        jobId: jobid,
        jobType: jobtype,
        formType: formObj.type,
        extravars,
        credentialMap: creds,
        approval: formObj.approval,
        approved: true,
      }));
    }
    if (jobtype == "multistep") {
      return await Multistep.launch({
        form,
        steps: formObj.steps,
        user,
        extravars,
        credentials: creds,
        jobid,
        counter: ++counter,
        approval: formObj.approval,
        fromStep: step,
        approved: true
      });
    }
  };

  // Fire and forget - execute in background ; a run that throws ends the job as failed, or it
  // would stay running (approved, claimed by this node) with no word in its output
  executeApprovedJob().catch((err) => failJobOnError(jobid, err, "Approved job"));

  return { id: jobid };
};
/**
 * Whether this user may relaunch this job of this form : the form allows it
 * (allowRelaunch) and the user's roles grant
 * allowJobRelaunch. Shared by the plain replay, the raw form data read and the relaunch
 * with changes, so they can never disagree.
 */
function assertRelaunchable(job, formObj, user) {
  // Job.findById also hands a non-owner every job waiting for approval (so it can be
  // approved) : that is not a licence to read its form data or launch it again under
  // another name. Only the owner, an admin, or a role with manageAllJobs may ; seeing every
  // job (showAllJobLogs) is watching them, not launching them again.
  const managesAll = managesAllJobs(user);
  if (!managesAll && !(job.user === user?.username && (job.user_type ?? user?.type) === user?.type)) {
    throw new Errors.AccessDeniedError(`You can only relaunch your own jobs`);
  }
  if (formObj.allowRelaunch === false) {
    throw new Errors.AccessDeniedError(`Form '${job.form}' has job relaunch disabled`);
  }
  if (!user?.options?.allowJobRelaunch) {
    throw new Errors.AccessDeniedError(`You do not have permission to relaunch jobs. Contact your administrator to enable the 'allowJobRelaunch' role option.`);
  }
}

/** Launched by an admin-level schedule, as the Schedule Service : no form values of its own. */
function launchedBySchedule(job) {
  return job?.user_type === 'schedule' && !job?.raw_form_data;
}

/**
 * A schedule's job replayed as it ran, under 'enforce' too : only for who may manage schedules
 * (an admin, or allowScheduledJobs). The replay keeps the schedule's own extravars, reserved keys
 * included, which 'enforce' would otherwise keep from anyone else who sees every job.
 */
function replaysSchedule(job, user) {
  return launchedBySchedule(job) && ((user?.roles || []).includes("admin") || !!user?.options?.allowScheduledJobs);
}

/** An error the MCP server passes on with its own code (tools.js wrap) and the details. */
function codedError(ErrorClass, message, code, details = {}) {
  const err = new ErrorClass(message);
  err.code = code;
  err.details = details;
  return err;
}

/**
 * A wizard job's stored step drafts with the changes laid over them, for a relaunch : the
 * changes are given per step, as the browser's drafts are, and a step changed is walked again
 * even when the job skipped it.
 *
 * Args:
 *   formObj (object): the wizard form.
 *   stored (object): the job's raw form data ({ __wizard__: true, drafts, skipped }).
 *   values (object): the changes, { <step>: { <field>: value } }.
 *
 * Returns:
 *   object: the raw form data to validate.
 */
function wizardRelaunchData(formObj, stored, values) {
  const plain = (o) => o && typeof o === "object" && !Array.isArray(o);
  const steps = formObj.wizard.filter((s) => s && !s.summary && s.subform).map((s) => s.name || s.subform);
  if (values != null && !plain(values)) {
    throw codedError(Errors.BadRequestError, `'${formObj.name}' is a wizard form ; its changes are given per step (${steps.join(", ")})`, 'invalid_request');
  }
  const drafts = { ...(plain(stored.drafts) ? stored.drafts : {}) };
  const skipped = { ...(plain(stored.skipped) ? stored.skipped : {}) };
  for (const [name, v] of Object.entries(values || {})) {
    if (!steps.includes(name)) {
      throw codedError(Errors.BadRequestError, `'${formObj.name}' is a wizard form ; its changes are given per step (${steps.join(", ")}), not: ${name}`, 'invalid_request', { steps });
    }
    if (!plain(v)) throw codedError(Errors.BadRequestError, `The changes of step '${name}' are an object of its fields`, 'invalid_request');
    drafts[name] = { ...(plain(drafts[name]) ? drafts[name] : {}), ...v };
    delete skipped[name];
  }
  return { __wizard__: true, drafts, skipped };
}

/**
 * Relaunch a job with some fields changed : the stored raw form data, with `values` laid
 * over it, goes through the form engine again - resolved, validated, the extravars built
 * by the server - as a NEW launch by `user` (ansibleforms_user is the caller, not the
 * original submitter ; a plain Job.relaunch replays the stored extravars instead).
 *
 * Passwords are never stored and never reused, so a form with a password field anywhere -
 * its subforms included - cannot be relaunched this way : the data lost the password. The uploads of file fields are reused (verified
 * again). A wizard form goes through the engine step by step from the step drafts the job
 * stored, the changes given per step (`{ <step>: { <field>: value } }`) laid over them, a step
 * changed no longer skipped ; a wizard job that did not store its drafts (launched before 7)
 * is refused. Neither can a job from before raw form data was stored be relaunched with
 * changes.
 *
 * @param {object} args
 * @param {boolean} [args.preview]  resolve and build only : { form, extravars (passwords
 *   masked), credentials, payloadHash, warnings } - nothing is launched
 * @param {string} [args.expectedPayloadHash]  refuse when the payload differs (payload_mismatch)
 */
Job.relaunchWithValues = async function ({ user, id, values = {}, verbose = false, preview = false, expectedPayloadHash }) {
  const job = await Job.findById(user, id, true); // not log-safe : the stored passwords are needed
  const formConfig = await Form.load(user?.roles, job.form);
  const formObj = formConfig.forms?.[0];
  if (!formObj) {
    throw new Errors.NotFoundError(`Form '${job.form}' not found or you don't have access to it`);
  }
  assertRelaunchable(job, formObj, user);
  if (verbose && !user?.options?.allowVerboseMode) {
    throw new Errors.AccessDeniedError(`You do not have permission to run jobs in verbose mode.`);
  }
  const changed = !!values && Object.keys(values).length > 0;

  // no changes, and the form is not enforced : a replay of the job as it ran - its stored
  // extravars, on the server, as a relaunch always was (passwords included, they never leave
  // the server ; the preview masks them). The same for a job an admin-level schedule launched,
  // even under 'enforce' : its extravars are the schedule's own, set in the settings and built
  // on the server, never a client's, and it has no form values to validate (#1063)
  if (!changed && (launchValidationMode(formObj) !== 'enforce' || replaysSchedule(job, user))) {
    const storedExtravars = safeParse(job.extravars, {}, `job.extravars id=${id}`) || {};
    delete storedExtravars.__verbose__;
    const credentials = safeParse(job.credentials, {}, `job.credentials id=${id}`) || {};
    const payloadHash = sha256({ form: job.form, extravars: storedExtravars, credentials });
    if (expectedPayloadHash && expectedPayloadHash !== payloadHash) {
      throw codedError(Errors.ConflictError, 'The payload differs from the one that was previewed - preview again and have it confirmed.',
        'payload_mismatch', { expectedPayloadHash, payloadHash });
    }
    if (preview) {
      // masked with the form just loaded - by definition - and then by key name
      const byDefinition = maskPasswords(storedExtravars, maskableFields(formObj), formObj.subforms || []);
      const masked = safeParse(Helpers.logSafe(JSON.stringify(byDefinition)), {}, `masked extravars id=${id}`);
      return { form: job.form, replayed: true, extravars: masked, credentials, payloadHash, warnings: [] };
    }
    const replayed = await replayJob(user, job, verbose);
    return { ...replayed, replayed: true, payloadHash, warnings: [] };
  }

  // otherwise through the form engine : resolved, validated, the extravars built here
  const stored = job.raw_form_data ? safeParse(job.raw_form_data, null, `job.raw_form_data id=${id}`) : null;
  // a wizard is checked from its stored step drafts, and only when the job stored them (a
  // wizard job launched before 7 stored its merged output)
  const wizard = Array.isArray(formObj.wizard) && formObj.wizard.length > 0;
  if (wizard && stored && stored.__wizard__ !== true) {
    throw codedError(Errors.BadRequestError, `'${job.form}' is a wizard form ; this job did not store its step drafts, so it cannot be ${changed ? 'relaunched with changes' : 'checked under launch validation \'enforce\''}`, 'unsupported');
  }
  if (!stored) {
    const why = launchedBySchedule(job)
      ? 'it was launched by a schedule, which runs with its own extra vars and no form values'
      : 'it was launched before form values were stored with a job';
    throw codedError(Errors.BadRequestError, `Job ${id} cannot be relaunched with changes: ${why}. Relaunch it without changes instead.`, 'no_form_data');
  }
  if (stored.__form__ && stored.__form__ !== job.form) {
    throw new Errors.BadRequestError(`Cannot relaunch: saved data is from form '${stored.__form__}', not '${job.form}'.`);
  }
  const { __form__, ...raw } = stored; // eslint-disable-line no-unused-vars
  // read for the uploads only - never for a password
  const storedExtravars = safeParse(job.extravars, {}, `job.extravars id=${id}`) || {};
  const files = {};
  for (const f of formObj.fields || []) {
    if (f?.type !== 'file' || !f.name) continue;
    const upload = readModelPath(storedExtravars, [].concat(f.model || f.name)[0]);
    if (upload && typeof upload === 'object') files[f.name] = upload;
  }
  const rawFormData = wizard ? wizardRelaunchData(formObj, raw, values) : { ...raw, ...(values || {}) };
  const result = await validateLaunch({
    // no extravars : a password is never taken from the stored data here
    formConfig, formObj, user, rawFormData, extravars: {}, files,
    uploadPath: appConfig.uploadPath,
    services: createFormServices({ user, formConfig, formObj, deps: { Expression, Query, resolveFormQuery } }),
    allRows: true,
  });
  // a password is never stored in the form data, so a password field the form SHOWS - at the
  // top or in a row - lost its value : that cannot be relaunched from the data. One its
  // dependencies hide is not needed, and does not stand in the way.
  if (result.passwordsVisible?.length) {
    throw codedError(Errors.BadRequestError,
      `Job ${id} cannot be relaunched ${changed ? 'with changes' : 'under launch validation \'enforce\''}: its password field(s) ${result.passwordsVisible.join(', ')} are shown and passwords are never stored ; launch the form again and enter them`,
      'unsupported', { passwordFields: result.passwordsVisible });
  }
  if (!result.ok) {
    throw codedError(Errors.ValidationError,
      `Job ${id} cannot be relaunched with these values - ${describeLaunchErrors(result.errors)}`,
      'form_incomplete', result.errors);
  }
  const { extravars, credentials } = result.payload;
  delete extravars.__verbose__;
  const payloadHash = sha256({ form: job.form, extravars, credentials });
  if (expectedPayloadHash && expectedPayloadHash !== payloadHash) {
    throw codedError(Errors.ConflictError, 'The payload differs from the one that was previewed - preview again and have it confirmed.',
      'payload_mismatch', { expectedPayloadHash, payloadHash });
  }
  if (preview) {
    return {
      form: job.form,
      extravars: maskPasswords(extravars, maskableFields(formObj), formObj.subforms || []),
      credentials,
      payloadHash,
      warnings: result.warnings,
    };
  }
  if (job.status == "running" || job.abort_requested) {
    throw new Errors.ConflictError(`Job ${id} is not in a status to be relaunched (status=${job.status})`);
  }
  if (verbose) extravars.__verbose__ = true;
  logger.notice(`Relaunching job ${id} with form ${job.form}, with ${Object.keys(values || {}).length} changed field(s)`);
  const launched = await Job.launch({
    form: job.form, user, credentials, extravars, rawFormData, fromClient: true, validated: true,
  });
  await Job.sendEventNotification(id, 'relaunch', user);
  return { ...launched, payloadHash, warnings: result.warnings };
};

/**
 * Relaunch a job as it ran. A form under launch validation 'enforce' goes through the form
 * engine instead (relaunchWithValues without changes) : its stored extravars are not
 * trusted as they are, and a password field it shows makes it refuse.
 */
Job.relaunch = async function (user, id, verbose) {
  const job = await Job.findById(user, id, true);
  const formConfig = await Form.load(user?.roles, job.form);
  const formObj = formConfig.forms?.[0];
  if (!formObj) {
    throw new Errors.NotFoundError(`Form '${job.form}' not found or you don't have access to it`);
  }
  assertRelaunchable(job, formObj, user);
  if (launchValidationMode(formObj) === 'enforce') {
    return Job.relaunchWithValues({ user, id, values: {}, verbose });
  }
  return replayJob(user, job, verbose);
};

/** the replay itself : the stored extravars, credentials and raw form data, launched again */
async function replayJob(user, job, verbose) {
  const id = job.id;
  var extravars = {};
  var credentials = {};
  var rawFormData = {};
  if (job.extravars) {
    extravars = safeParse(job.extravars, {}, `job.extravars id=${id}`);
  }
  // The stored extravars carry whatever the ORIGINAL launch used, __verbose__ included, so
  // a user without allowVerboseMode could relaunch a verbose job (or any job in 'approve',
  // which findById exposes to everyone) and get -vvv output. The controller checks the
  // ?verbose= query parameter; it never looked at what was already in the row.
  delete extravars["__verbose__"];
  if (verbose) {
    if (!user.options?.allowVerboseMode) {
      throw new Errors.AccessDeniedError(`You do not have permission to run jobs in verbose mode.`);
    }
    extravars["__verbose__"] = true;
  }
  if (job.credentials) {
    credentials = safeParse(job.credentials, {}, `job.credentials id=${id}`);
  }
  if (job.raw_form_data) {
    rawFormData = safeParse(job.raw_form_data, {}, `job.raw_form_data id=${id}`);
    logger.debug(`Retrieved raw form data for relaunch with ${Object.keys(rawFormData).length} fields`);
  }
  if (job.status != "running" && !job.abort_requested) {
    logger.notice(`Relaunching job ${id} with form ${job.form}`);
    const result = await Job.launch({
      form: job.form,
      user,
      credentials,
      extravars,
      rawFormData,
      replay: true
    });
    // Send relaunch notification
    await Job.sendEventNotification(id, 'relaunch', user);
    return result;
  } else {
    throw new Errors.ConflictError(
      `Job ${id} is not in a status to be relaunched (status=${job.status})`
    );
  }
}
Job.approve = async function (user, id) {
  const job = await Job.findById(user, id, true);

  var approval = safeParse(job.approval, null, `job.approval id=${id}`);
  if (approval) {
    var access = approval?.roles.filter((role) => user?.roles?.includes(role));
    if (access?.length > 0 || user?.roles?.includes("admin")) {
      logger.notice(`Approve allowed for user ${user.username}`);
    } else {
      logger.warning(`Approve denied for user ${user.username}`);
      throw new Errors.AccessDeniedError(
        `Approve denied for user ${user.username}`
      );
    }
    // four eyes : who launched the job does not approve it themselves, unless the form's approval
    // allows it (allowSelf: true). An admin approves any job, their own included. Rejecting one's
    // own job (withdrawing it) stays allowed.
    const ownJob = job.user === user?.username && (job.user_type || "local") === (user?.type || "local");
    if (ownJob && approval.allowSelf !== true && !user?.roles?.includes("admin")) {
      logger.warning(`Approve denied for user ${user.username}: the job is their own`);
      // its code lets the controller say it in the approver's language
      throw Object.assign(new Errors.AccessDeniedError(i18n.t(null, "jobs.cantApproveOwnJob")), { code: "OWN_JOB" });
    }
  }
  var extravars = {};
  var credentials = {};
  if (job.extravars) {
    extravars = safeParse(job.extravars, {}, `job.extravars id=${id}`);
  }
  if (job.credentials) {
    credentials = safeParse(job.credentials, {}, `job.credentials id=${id}`);
  }
  // a workflow job waits on one of its approval nodes : approved, it runs on (its run sees it) -
  // the form is not launched again
  if (job.status == "approve" && job.job_type == "workflow") {
    logger.notice(`Approving workflow job ${id}`);
    await Job.printJobOutput(`changed: [approved by ${user.username}]`, "stdout", id, (await Job.lastOrder(id)) + 1);
    const moved = await Job.transitionStatus(id, ["approve"], { status: "running", end: null });
    if (!moved) throw new Errors.ConflictError(`Job ${id} is no longer awaiting approval`);
    await Job.sendEventNotification(id, 'approve', user);
    return { id };
  }
  if (job.status == "approve") {
    logger.notice(`Approving job ${id} with form ${job.form}`);
    try {
      const result = await Job.continue({
        form: job.form,
        user,
        credentials,
        extravars,
        jobid: id
      });
      // Send approve notification
      await Job.sendEventNotification(id, 'approve', user);
      return result;
    } catch (err) {
      logger.error("Failed to continue the job: ", err);
      throw err;
    }
  } else {
    throw new Errors.ConflictError(
      `Job ${id} is not in approval status (status=${job.status})`
    );
  }
};
/**
 * Helper method to build and send email notifications
 * @private
 */
Job._buildAndSendEmail = async function ({
  recipients,
  subject,
  templatePath,
  replacements = {},
  logContext = 'notification',
  server = null
}) {
  try {
    const config = await Settings.findUrl();
    const url = config.url ? stripTrailingSlashes(config.url) : config.url;

    if (!url) {
      logger.warning(
        `Host URL is not set, no ${logContext} can be sent. Go to 'settings' to correct this.`
      );
      return false;
    }

    // Read template : the bundled ones live in templates/email, but a copy mounted
    // where they used to be (src/templates, documented before 7) still overrides it
    var legacyTemplate = `${__dirname}/../templates/${templatePath}`;
    var templateFile = fs.existsSync(legacyTemplate) ? legacyTemplate : `${__dirname}/../../templates/email/${templatePath}`;
    var buffer = fs.readFileSync(templateFile);
    var message = buffer.toString();
    
    // Default replacements
    var color = "#158cba";
    var color2 = "#ffa73b";
    var logo = `${url}/assets/img/logo.png`;
    
    // Apply all replacements.
    // Every value goes in through a FUNCTION replacement so it is inserted verbatim. As a
    // plain string it is read for the special replacement patterns, so a job carrying $&
    // in its name, its message or its run details had the placeholder text itself pasted
    // back in ($&), or the whole surrounding template ($` / $'), into the mail body.
    const lit = (v) => () => (v ?? "");
    message = message
      .replace("${message}", lit(replacements.message))
      .replaceAll("${url}", lit(url))
      .replaceAll("${jobid}", lit(replacements.jobid))
      .replaceAll("${title}", lit(subject))
      .replaceAll("${logo}", lit(logo))
      .replaceAll("${color}", lit(color))
      .replaceAll("${color2}", lit(color2))
      .replaceAll("${heading}", lit(replacements.heading))
      .replaceAll("${subtitle}", lit(replacements.subtitle))
      .replaceAll("${buttonLabel}", lit(replacements.buttonLabel))
      .replaceAll("${regards}", lit(replacements.regards))
      .replaceAll("${runDetails}", lit(replacements.runDetails));
    
    // through the mail channel a form names (channels: [...]), else the active one
    const messageid = server
      ? await Settings.maildo(await NotificationChannel.toMailConfig(server), recipients.join(","), subject, message)
      : await Settings.mailsend(recipients.join(","), subject, message);
    
    if (!messageid) {
      logger.notice(`No ${logContext} sent`);
      return false;
    } else {
      logger.notice(`${logContext} sent to ${recipients.join(",")} with id ${messageid}`);
      return true;
    }
  } catch (err) {
    logger.error(`Failed to send ${logContext}: `, err);
    return false;
  }
};
/**
 * The channels a form names, split : its mail channels (turned on), which send the usual mail
 * through their own server instead of the active one, and the others by name (Slack, Teams,
 * Telegram, webhooks - and the names not found, which sendToChannels says in the log).
 *
 * Args:
 *   names (string[]): the channels' names.
 *
 * Returns:
 *   Promise<object>: { mail (the mail channels), others (the other names) }.
 */
Job._splitChannels = async function (names) {
  const mail = [];
  const others = [];
  for (const name of [...new Set((Array.isArray(names) ? names : []).filter(Boolean).map(String))]) {
    const channel = await NotificationChannel.findByName(name).catch(() => null);
    if (channel?.type === "mail") {
      if (channel.enabled) mail.push(channel);
      else logger.notice(`The mail channel '${name}' is turned off: the mail goes through the active one`);
    } else {
      others.push(name);
    }
  }
  return { mail, others };
};
/**
 * Sends the usual mail (its template) to the recipients : through each mail channel a form names,
 * else through the active one.
 *
 * Args:
 *   mailChannels (object[]): the mail channels named (none : the active one).
 *   options (object): what Job._buildAndSendEmail takes.
 *
 * Returns:
 *   Promise<boolean>: true when one mail at least was sent.
 */
Job._sendMails = async function (mailChannels, options) {
  if (!mailChannels.length) return Job._buildAndSendEmail(options);
  let sent = false;
  for (const server of mailChannels) {
    if (await Job._buildAndSendEmail({ ...options, server, logContext: `${options.logContext} (${server.name})` })) sent = true;
  }
  return sent;
};
/**
 * Sends a notification to the channels a form names (Connections > Notifications : Slack, Teams,
 * Telegram, a webhook, or a mail channel to the recipients) : the title, a short text and a
 * link to the job. Never throws : a notification never fails a job.
 *
 * Args:
 *   options (object): { channels (their names), recipients (a mail channel's addresses), title,
 *     text, status, event, job (the job, for its form and user), jobid, buttonLabel, context
 *     (for the log) }.
 *
 * Returns:
 *   Promise<boolean>: true when one channel at least got it.
 */
Job._notifyChannels = async function ({ channels, recipients = [], title, text, status = "", event = "", job = {}, jobid, buttonLabel, context }) {
  if (!Array.isArray(channels) || !channels.length) return false;
  try {
    const config = await Settings.findUrl().catch(() => ({}));
    const url = config?.url ? stripTrailingSlashes(config.url) : "";
    const { sendToChannels } = await import("../lib/notifiers.js");
    const results = await sendToChannels(
      channels,
      {
        title,
        text,
        status,
        event,
        job: { id: jobid, form: job.form || "", user: job.user || "" },
        link: url ? `${url}/jobs/${jobid}` : "",
        buttonLabel: buttonLabel || i18n.t(null, "notifications.openJob"),
      },
      recipients,
      context,
    );
    return results.some((r) => r.ok);
  } catch (err) {
    logger.error(`${context} could not be sent to its channels: `, err);
    return false;
  }
};
Job.sendApprovalNotification = async function (approval, extravars, jobid) {
  const hasMail = approval?.notifications?.length > 0;
  const hasChannels = Array.isArray(approval?.channels) && approval.channels.length > 0;
  if (!hasMail && !hasChannels) return false;
  
  var subject =
    Helpers.replacePlaceholders(approval.title, extravars) ||
    i18n.t(null, 'email.subject.approval');
  var approvalMessage = Helpers.replacePlaceholders(
    approval.message,
    extravars
  );
  
  // the approval's channels : the message, and the link to approve or reject on the job's page ;
  // the job's form and user for a webhook's payload
  const { mail: mailChannels, others } = hasChannels ? await Job._splitChannels(approval.channels) : { mail: [], others: [] };
  const asked = hasChannels
    ? (await mysql.do("SELECT form, user FROM AnsibleForms.`jobs` WHERE id = ?", [jobid]).catch(() => []))?.[0] || {}
    : {};
  const viaChannels = others.length
    ? await Job._notifyChannels({
        job: asked,
        channels: others,
        recipients: approval.notifications || [],
        title: subject,
        text: approvalMessage || i18n.t(null, 'email.approval.subtitle'),
        status: "approve",
        event: "approval",
        jobid,
        buttonLabel: i18n.t(null, 'email.approval.button'),
        context: "Approval",
      })
    : false;
  if (!hasMail) return viaChannels;
  const viaMail = await Job._sendMails(mailChannels, {
    recipients: approval.notifications,
    subject: subject,
    templatePath: "approval.html",
    replacements: {
      message: approvalMessage,
      jobid: jobid,
      heading: i18n.t(null, 'email.approval.heading'),
      subtitle: i18n.t(null, 'email.approval.subtitle'),
      buttonLabel: i18n.t(null, 'email.approval.button'),
      regards: i18n.t(null, 'email.approval.regards'),
    },
    logContext: "Approval mail"
  });
  return viaMail || viaChannels;
};
Job.sendStatusNotification = async function (jobid) {
  try {
    logger.notice(`Sending status mail for jobid ${jobid}`);
    var user = {
      roles: ["admin"],
    };

    const job = await Job.findById(user, jobid, false, true);
    var notifications = safeParse(job.notifications, null, `job.notifications id=${jobid}`);
    
    // Default to 'any' if onStatus not specified
    if (notifications && !notifications.onStatus) {
      notifications.onStatus = ["any"];
    }
    
    const channels = Array.isArray(notifications?.channels) ? notifications.channels : [];
    if (!notifications?.recipients && !channels.length) {
      logger.notice("No notifications set");
      return false;
    }
    
    if (
      !notifications.onStatus?.includes(job.status) &&
      !notifications.onStatus?.includes("any")
    ) {
      logger.notice(`Skipping notification for status ${job.status}`);
      return false;
    }
    
    var subject = Job.mailSubject(job, jobid, Job.mailWord('status', job.status));
    const { mail: mailChannels, others } = await Job._splitChannels(channels);
    // the channels : a short text and the link to the job (its output is on its page)
    const viaChannels = await Job._notifyChannels({
      channels: others,
      recipients: notifications.recipients || [],
      title: subject,
      text: i18n.t(null, 'notifications.statusText', { jobid, form: job.form, status: Job.mailWord('status', job.status) }),
      status: job.status,
      event: "status",
      job,
      jobid,
      context: "Status notification",
    });
    if (!notifications.recipients) return viaChannels;
    
    // Send the mail : through the mail channels named, else the active one
    const viaMail = await Job._sendMails(mailChannels, {
      recipients: notifications.recipients,
      subject: subject,
      templatePath: "jobstatus.html",
      replacements: {
        message: job.output.replaceAll("\r\n", "<br>"),
        jobid: jobid,
        heading: i18n.t(null, 'email.jobstatus.heading'),
        subtitle: i18n.t(null, 'email.jobstatus.subtitle'),
        buttonLabel: i18n.t(null, 'email.jobstatus.button'),
        runDetails: i18n.t(null, 'email.jobstatus.runDetails'),
        regards: i18n.t(null, 'email.jobstatus.regards'),
      },
      logContext: "Status mail"
    });
    return viaMail || viaChannels;
  } catch (err) {
    logger.error("Failed to send status notification: ", err);
    return false;
  }
};
Job.sendEventNotification = async function (jobid, eventType, user = null) {
  try {
    logger.notice(`Sending ${eventType} notification for jobid ${jobid}`);
    var adminUser = {
      roles: ["admin"],
    };

    const job = await Job.findById(adminUser, jobid, false, true);
    var notifications = safeParse(job.notifications, null, `job.notifications id=${jobid}`);
    
    // Check if this event type is in the onEvent array
    if (!notifications || !notifications.onEvent || !Array.isArray(notifications.onEvent)) {
      logger.notice(`No event notifications configured`);
      return false;
    }
    
    if (!notifications.onEvent.includes(eventType) && !notifications.onEvent.includes('any')) {
      logger.notice(`Event '${eventType}' not in notification list`);
      return false;
    }
    
    const channels = Array.isArray(notifications.channels) ? notifications.channels : [];
    if ((!notifications.recipients || notifications.recipients.length === 0) && !channels.length) {
      logger.notice("No notification recipients set");
      return false;
    }

    // Event-specific subject and message content, in the server's language
    const eventMessage = Job.eventMessage(eventType, user);

    var subject = Job.mailSubject(job, jobid, Job.mailWord('event', eventType));
    const { mail: mailChannels, others } = await Job._splitChannels(channels);
    // the channels : the event's sentence and the link to the job
    const viaChannels = await Job._notifyChannels({
      channels: others,
      recipients: notifications.recipients || [],
      title: subject,
      text: eventMessage,
      status: job.status,
      event: eventType,
      job,
      jobid,
      buttonLabel: i18n.t(null, 'email.jobevent.button'),
      context: `${eventType} notification`,
    });
    if (!notifications.recipients || notifications.recipients.length === 0) return viaChannels;
    
    const viaMail = await Job._sendMails(mailChannels, {
      recipients: notifications.recipients,
      subject: subject,
      templatePath: "jobevent.html",
      replacements: {
        message: eventMessage,
        jobid: jobid,
        buttonLabel: i18n.t(null, 'email.jobevent.button'),
        regards: i18n.t(null, 'email.jobevent.regards'),
      },
      logContext: `${eventType} notification`
    });
    return viaMail || viaChannels;
  } catch (err) {
    logger.error(`Failed to send ${eventType} notification: `, err);
    return false;
  }
};
/**
 * The subject of a job mail : "AnsibleForms '<form>' [<type>] (<id>) - <word>".
 *
 * Args:
 *   job (object): the job, for its form name and job type.
 *   jobid (number): the job id.
 *   word (string): what happened, already translated (see Job.mailWord).
 *
 * Returns:
 *   string: the subject line.
 */
Job.mailSubject = function (job, jobid, word) {
  return `AnsibleForms '${job.form}' [${job.job_type}] (${jobid}) - ${word}`;
};

/**
 * The translated word a job mail subject ends with, in the server's language.
 *
 * Args:
 *   kind (string): 'event' (launch, relaunch, ...) or 'status' (success, failed, ...).
 *   value (string): the event or the job status.
 *
 * Returns:
 *   string: the translation, or the value itself when it has none (a status added later
 *     still reads, untranslated, rather than as a translation key).
 */
Job.mailWord = function (kind, value) {
  const key = `email.subject.${kind}.${value}`;
  const word = i18n.t(null, key);
  return word === key ? value : word;
};

/**
 * The sentence of a job event mail, in the server's language.
 *
 * With a user it is a whole translated sentence naming them ("Job has been launched by
 * admin."), not an English " by admin" pasted into one : the word order differs per
 * language, and Japanese and Catalan put the name before the verb. The name is escaped,
 * because the message goes into the html mail as it is.
 *
 * Args:
 *   eventType (string): launch, relaunch, delete, approve or reject.
 *   user (object): the user who did it, or nothing when no one is known.
 *
 * Returns:
 *   string: the translated sentence.
 */
Job.eventMessage = function (eventType, user) {
  const username = user?.username;
  if (!username) return i18n.t(null, `email.jobevent.${eventType}`);
  return i18n.t(null, `email.jobevent.${eventType}By`, { user: Helpers.htmlEscape(String(username)) });
};
Job.reject = async function (user, id) {
  const job = await Job.findById(user, id, true);

  var approval = safeParse(job.approval, null, `job.approval id=${id}`);
  if (approval) {
    var access = approval?.roles.filter((role) => user?.roles?.includes(role));
    if (access?.length > 0 || user?.roles?.includes("admin")) {
      logger.notice(`Reject allowed for user ${user.username}`);
    } else {
      logger.warning(`Reject denied for user ${user.username}`);
      throw new Errors.AccessDeniedError(
        `Reject denied for user ${user.username}`
      );
    }
  }
  var counter = job.counter;
  if (job.status == "approve") {
    logger.notice(`Rejecting job ${id} with form ${job.form}`);
    await Job.printJobOutput(
      `changed: [rejected by ${user.username}]`,
      "stderr",
      id,
      counter + 1
    );
    // only from approve : an approval racing the rejection wins or loses as a whole
    const result = await Job.transitionStatus(id, ["approve"], { status: "rejected", end: getTimestamp() });
    if (!result) throw new Errors.ConflictError(`Job ${id} is no longer awaiting approval`);
    // Send reject notification
    await Job.sendEventNotification(id, 'reject', user);
    return result;
  } else {
    throw new Errors.ConflictError(
      `Job ${id} is not in rejectable status (status=${job.status})`
    );
  }
};
// Multistep stuff
var Multistep = function () {};


Multistep.launch = async function ({
  form,
  steps,
  user,
  extravars = {},
  credentials = {},
  jobid,
  counter = null,
  approval = null,
  fromStep = null,
  approved = false
}) {
  const creds = credentials; // Alias for backward compatibility internally
  // create a new job in the database
  if (!counter) {
    counter = 0;
  } else {
    counter++;
  }
  // global approval
  if (!fromStep && approval) {
    if (!approved) {
      await Job.sendApprovalNotification(approval, extravars, jobid);
      await Job.printJobOutput(
        `APPROVE [${form}] ${"*".repeat(Math.max(0, 69 - String(form).length))}`,
        "stdout",
        jobid,
        counter + 1
      );
      // only a multistep still running waits for approval : one aborted or abandoned
      // meanwhile keeps the status it has
      await Job.transitionStatus(jobid, ["running"], {
        status: "approve",
        approval: JSON.stringify(approval),
        end: getTimestamp(),
      });
      return true;
    } else {
      logger.notice("Continuing multistep " + form + " it has been approved");
      // reset flag for steps
      approved = false;
    }
  }
  var ok = 0;
  var failed = 0;
  var skipped = 0;
  var abort_requested; // set per step, and re-read once all steps are done

  try {
    var finalSuccessStatus = true; // multistep success from start to end ?
    var partialstatus = false; // was there a step that failed and had continue ?
    var approve = false; // flag to halt at approval
    for await (const step of steps) {
      try {
        // HANDLE SKIPPING --------------------------------
        // console.log("fromstep : " + fromStep)
        if (fromStep && fromStep != step.name) {
          // Job.printJobOutput(`STEP [${step.name}] ${'*'.repeat(72-step.name.length)}`,"stdout",jobid,++counter)
          // Job.printJobOutput(`skipped: due to continue`,"stdout",jobid,++counter)
          logger.info("Skipping step " + step.name + " - in continue phase");
          // skipped++
          continue; // next step
        }
        // reset from step
        fromStep = undefined;
        if (approve && !approved) {
          // Job.printJobOutput(`STEP [${step.name}] ${'*'.repeat(72-step.name.length)}`,"stdout",jobid,++counter)
          // Job.printJobOutput(`skipped: due to approval`,"stdout",jobid,++counter)
          logger.info("Skipping step " + step.name + " due to approval");
          // skipped++
          continue;
        }
        if (step.ifExtraVar && extravars[step.ifExtraVar] !== true) {
          await Job.printJobOutput(
            `STEP [${step.name}] ${"*".repeat(72 - step.name.length)}`,
            "stdout",
            jobid,
            ++counter
          );
          await Job.printJobOutput(
            `skipped: due to condition`,
            "stdout",
            jobid,
            ++counter
          );
          logger.info("Skipping step " + step.name + " due to condition");
          skipped++;
          continue;
        }
        // ------- SKIPPING HANDLED -----------------------
        logger.notice("Running step " + step.name);
        // conditional : only a multistep still running moves on to its next step. One the
        // app gave up on (abandoned by a sweep), ended, or taken over by another node is not
        // this loop's any more - writing 'running' over it would bring it back to life
        if (!(await Job.claimNextStep(jobid, step.name))) {
          logger.warning(`Multistep job ${jobid} is no longer running on this node: not starting step ${step.name}`);
          return false;
        }

        // set step in parent
        // if this step has an approval
        if (step.approval) {
          if (!approved) {
            logger.notice("Approve needed for " + step.name);
            await Job.sendApprovalNotification(step.approval, extravars, jobid);
            await Job.printJobOutput(
              `APPROVE [${step.name}] ${"*".repeat(Math.max(0, 69 - String(step.name).length))}`,
              "stdout",
              jobid,
              ++counter
            );
            try {
              // conditional, as the step's own claim above
              await Job.transitionStatus(jobid, ["running"], {
                status: "approve",
                approval: JSON.stringify(step.approval),
                end: getTimestamp(),
              });
            } catch (error) {
              logger.error("Failed to update job", error);
            }
            approve = true; // set approve flag
            continue; // complete this step
          } else {
            approved = false; // approved is done, reset approved flag
          }
        }
        // print title of new step and check abort
        abort_requested = await Job.printJobOutput(
          `STEP [${step.name}] ${"*".repeat(72 - step.name.length)}`,
          "stdout",
          jobid,
          ++counter
        );

        // if aborted is requested, stop the flow
        if (abort_requested) {
          skipped++;
          logger.debug("skipping: step " + step.name);
          finalSuccessStatus = false;
          await Job.printJobOutput(
            "skipping: [Abort is requested]",
            "stdout",
            jobid,
            ++counter
          );
          // fail this step
          continue;
        } // fail step due to abort
        else {
          // if the previous steps were ok (or failed with continue) OR step has always:true
          if (finalSuccessStatus || step.always) {
            // filter the extravars with "key"
            var ev = { ...extravars };
            // steps can have a key, we then take a partial piece of the extravars to send to the step
            if (step.key && ev[step.key]) {
              // logger.warning(step.key + " exists using it")
              ev = ev[step.key];
              // we copy the user profile in the step data - unless the form asked for no
              // user at all, in which case there is nothing to copy and assigning undefined
              // would put a key back that the setting just removed
              // the slice is client data, so one it carries itself is dropped either way
              if (extravars.ansibleforms_user !== undefined) {
                ev.ansibleforms_user = extravars.ansibleforms_user;
              } else {
                delete ev.ansibleforms_user;
              }
            }
            // wait the promise of step
            if (!finalSuccessStatus) {
              await Job.printJobOutput(
                `ALWAYS step ${step.name}`,
                "stdout",
                jobid,
                ++counter
              );
            }
            var jobSuccess = await Job.launch({
              form,
              formObj: step,
              user,
              credentials: creds,
              extravars: ev,
              parentId: jobid,
              waitForCompletion: true
            });
            if (jobSuccess && jobSuccess.id) {
              await Job.printJobOutput(
                `ok: [Launched step ${step.name} with jobid '${jobSuccess.id}']`,
                "stdout",
                jobid,
                ++counter
              );
              // an abort that came in after the check above but before this step's row
              // existed only flagged the multistep (Job.abort aborts the steps it finds
              // running) - pass it on, or this step would still run to the end
              // (a failure here must not skip the wait below : the step would carry on
              // unwatched while the multistep moved on as if it had failed)
              try {
                if (await Job.isAbortRequested(jobid)) {
                  await Job.requestAbort(jobSuccess.id);
                }
              } catch (err) {
                logger.error(`[Job ${jobSuccess.id}] Failed to pass the abort of job ${jobid} on to its step: ${err.message}`);
              }
              
              // Now wait for the step to complete
              if (jobSuccess.completionPromise) {
                await jobSuccess.completionPromise;
                
                // Check the actual status of the child job
                const childJob = await Job.findById(user, jobSuccess.id, false);
                // A step counts as passed only when it can be READ and says so. findById
                // returns [] on any internal error, and `[].status` is undefined - which
                // used to skip this throw entirely, so the multistep carried on to the next
                // step and reported success for a step whose outcome was never established.
                // Treat unreadable as a failure: a step you cannot check has not passed.
                const childStatus = Array.isArray(childJob) ? undefined : childJob?.status;
                if (!childStatus) {
                  throw new Errors.ApiError(
                    `Step ${step.name} (jobid ${jobSuccess.id}): could not read the step status, treating it as failed`
                  );
                }
                // only success or warning passes : abandoned (a runner restarted mid-step),
                // rejected and anything unknown did not complete the step
                if (childStatus !== 'success' && childStatus !== 'warning') {
                  throw new Errors.ApiError(
                    `Step ${step.name} (jobid ${jobSuccess.id}) ${childStatus}`
                  );
                }
                
                await Job.printJobOutput(
                  `ok: [Completed step ${step.name} with jobid '${jobSuccess.id}']`,
                  "stdout",
                  jobid,
                  ++counter
                );
              }
            }
            if (!jobSuccess) {
              throw new Errors.ApiError(
                `Check the step-logs for jobid '${jobid}' for more information`
              );
            }
            // job was success
            ok++;
            continue;
          } else {
            // previous was not success or there was fail in other steps
            // skip this step
            skipped++;
            logger.debug("skipping: step " + step.name);
            finalSuccessStatus = false;
            await Job.printJobOutput(
              "skipping: [due to previous failure]",
              "stdout",
              jobid,
              ++counter
            );
            // fail this step
            continue;
          }
        }
      } catch (error) {
        // step failed - something was wrong
        failed++;
        logger.error("Failed step " + step.name + ": ", error);
        await Job.printJobOutput(
          "[ERROR]: Failed step " + step.name + ": " + error.message,
          "stderr",
          jobid,
          ++counter
        );
        // if continue, we mark partial and mark as success - unless the multistep was
        // aborted : then this step failed because the abort stopped it, and continuing
        // would end an aborted run as warning (the last step) instead of aborted
        const abortedRun = step.continue
          ? await Job.isAbortRequested(jobid).catch(() => false)
          : false;
        if (step.continue && !abortedRun) {
          await Job.printJobOutput(
            `CONTINUE on failure`,
            "stdout",
            jobid,
            ++counter
          );
          partialstatus = true;
          continue;
        } else {
          // no continue, we fail the multistep
          finalSuccessStatus = false;
          continue;
        }
      }
    }

    // create recap
    if (!approve) {
      // re-read the flag : an abort during the LAST step stopped that step (Job.abort
      // aborts the running step too) but never reached the check at the top of the loop,
      // so the multistep ended as failed - or, if the step finished anyway, as success
      // with the flag left set, which then refused every later abort of this job
      abort_requested = await Job.isAbortRequested(jobid);
      await Job.printJobOutput(
        `MULTISTEP RECAP ${"*".repeat(64)}`,
        "stdout",
        jobid,
        ++counter
      );
      await Job.printJobOutput(
        `localhost   : ok=${ok}    failed=${failed}    skipped=${skipped}`,
        "stdout",
        jobid,
        ++counter
      );
      if (finalSuccessStatus) {
        // if multistep was success
        // (an abort that came too late, after every step had finished, is cleared)
        if (abort_requested) await Job.resetAbortRequested(jobid);
        if (partialstatus) {
          // but a step failed with continue => mark as warning
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stdout",
            "warning",
            "[WARNING]: Finished multistep with warnings"
          );
        } else {
          // mark as full success
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stdout",
            "success",
            "ok: [Finished multistep successfully]"
          );
        }
      } else {
        // no multistep success
        if (abort_requested) {
          // if aborted mark as such
          await Job.resetAbortRequested(jobid);
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stderr",
            "aborted",
            "multistep was aborted"
          );
        } else {
          // else, mark failed
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stderr",
            "failed",
            "[ERROR]: Finished multistep with errors"
          );
        }
      }
    }
    return true
  } catch (err) {
    logger.error("Error in multistep, this should not happen: ", err);
  }
};
// ─── live events ──────────────────────────────────────────────────────────────
// Every change of a job - created, its status, its output, aborted, approved, deleted,
// abandoned, cleaned up - tells the browsers (lib/liveEvents.js) : the jobs list, a job's
// page, the approvals bell and the jobs menu's counts re-read. Here, in the one model every
// process writes jobs through (the app, the worker, the RTE), rather than at each caller :
// a write path added later is covered as long as it goes through these functions.
const CHANGES_A_JOB = [
  "create", "update", "endJobStatus", "printJobOutput", "createOutput", "replaceTrackedOutput",
  "deleteOutput", "delete", "abort", "requestAbort", "resetAbortRequested", "abandon",
  "abandonOwn", "abandonDeadNodes", "removeOlderThan", "approve", "reject", "continue",
  // the conditional writes : a status moved (an approval gate, a step's approval), a step begun
  "transitionStatus", "claimNextStep",
];
for (const fn of CHANGES_A_JOB) {
  const original = Job[fn];
  if (typeof original !== "function") continue;
  Job[fn] = async function (...args) {
    try {
      return await original.apply(this, args);
    } finally {
      publish("jobs");
    }
  };
}

// Ansible stuff
export default Job;
// named export for the tests
export { Multistep, scopeOfUser, assertLaunchScope, stripReservedExtravars, stripUndeclaredCredentials, filterRawFormDataOf, setUserExtravars, guardLaunch, launchValidationMode, pushForminfoToExtravars };
