// AWX / Ansible Automation Platform / Ascender : launching a job or workflow template and
// tracking its output back into the job. Every function takes the runner ROW (a runner of
// type awx, its secrets decrypted) - the connection the form named, or the default one.
import axios from "axios";
import yaml from "yaml";
import logger from "../../lib/logger.js";
import Errors from "../../lib/errors.js";
import appConfig from "../../../config/app.config.js";
import { safeParse } from "../../lib/safejson.js";
import { delay, getHttpsAgent, contactTolerance, jobEnded, lostContact as endLost, REMOTE_TIMEOUT_MS } from "../common.js";
// a cycle (job.model imports the orchestrator, which reaches this module) ; Job is only
// used when a job runs, long after both modules have loaded
import Job from "../../models/job.model.js";
import { rememberRunnerJobUrl } from "../../lib/runnerJobLinks.js";
import { workflowSummaryLines } from "../../lib/workflowSummary.js";
import JobEvent from "../../models/jobEvent.model.js";
import { createAwxEventReader, runsVerbose } from "./events.js";

/**
 * The API path a runner's uri lacks : none when the uri carries it
 * (https://aap.example.com/api/controller/v2) ; a uri without an /api/ path - a runner made
 * before, a seed that declares one - gets AWX_API_PREFIX, as it always did.
 *
 * Args:
 *   runner (object): the runner (its `uri`).
 *
 * Returns:
 *   string: the prefix to add after the uri, '' when it has its own.
 */
export function apiPrefix(runner) {
  try {
    if (new URL(runner?.uri).pathname.includes("/api/")) return "";
  } catch (e) {
    // not a url : the prefix, and the request says what is wrong with it
  }
  return appConfig.awxApiPrefix;
}

/**
 * The server a runner's uri points at, without its API path : what the links AWX returns
 * (a template's related.launch, a job's url, all root-relative such as /api/v2/jobs/12/) are
 * added to. A uri carrying its API path (https://aap.example.com/api/controller/v2) would
 * otherwise double it.
 *
 * Args:
 *   runner (object): the runner (its `uri`).
 *
 * Returns:
 *   string: the uri's origin when it carries an API path, else the uri itself (as before).
 */
export function serverOf(runner) {
  const uri = String(runner?.uri || "");
  try {
    // AWX's links are root-relative, a path before /api/ included (/tower/api/v2/jobs/12/)
    const url = new URL(uri);
    if (url.pathname.includes("/api/")) return url.origin;
  } catch (e) {
    // not a url : as it is, and the request says what is wrong with it
  }
  return uri;
}

// the helpers every runner that follows a remote job shares (runners/common.js), re-exported
// where the tests and callers have always found them
export { contactTolerance, getHttpsAgent };

// basic auth with a user and password, or a bearer token
// every AWX call : a connection that hangs must fail and reach the retries, not wait for ever
const AWX_TIMEOUT_MS = REMOTE_TIMEOUT_MS;

// Above STDOUT_MAX_BYTES_DISPLAY (1 MB by default), AWX refuses the display formats of a
// job's stdout : it answers 200 with this placeholder instead of the log (issue #733). The
// stdout is read in a download format, which has no such limit ; the placeholder is still
// recognized, so it can never be taken for the log.
const AWX_STDOUT_TOO_LARGE = /^Standard Output too large to display \(\d+ bytes\)/;

/**
 * Tells whether a stdout answer is AWX's "too large to display" placeholder.
 *
 * Args:
 *   text (string): what AWX returned for the stdout.
 *
 * Returns:
 *   boolean: true for the placeholder.
 */
export function isStdoutTooLarge(text) {
  return typeof text === "string" && AWX_STDOUT_TOO_LARGE.test(text);
}

export function getAuthorization(awx) {
  const headers = awx.use_credentials
    ? { Authorization: `Basic ${Buffer.from(`${awx.username}:${awx.password}`).toString("base64")}` }
    : { Authorization: `Bearer ${awx.token}` };
  return { headers, httpsAgent: getHttpsAgent(awx), timeout: AWX_TIMEOUT_MS };
}

// AWX stopped answering while a job was followed : end ours, rather than leave it 'running'
// until the daily sweep. The job in AWX may well go on.
function lostContact(jobid, counter, job, message) {
  return endLost(jobid, counter, `[ERROR]: lost contact with AWX while following AWX job ${job?.id} (${message}): it may still be running, check it in AWX`);
}

/** proves the connection works : it lists the job templates the credentials can see */
export async function check(awx) {
  const uri = `${awx.uri}${apiPrefix(awx)}`;
  logger.info(`Checking AWX connection at ${uri}`);
  let data;
  try {
    ({ data } = await axios.get(`${uri}/job_templates/`, { ...getAuthorization(awx), timeout: 10000 }));
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) throw new Errors.BadRequestError(`AWX at ${awx.uri} refused the credentials (${status})`);
    // an Ansible Automation Platform 2.5 gateway serves the controller under /api/controller/v2 :
    // say so, rather than a bare 404
    if (status === 404 && apiPrefix(awx)) {
      const controller = await axios.get(`${awx.uri}/api/controller/v2/ping/`, { ...getAuthorization(awx), timeout: 10000 }).then(() => true, () => false);
      if (controller) throw new Errors.BadRequestError(`${awx.uri} is an Ansible Automation Platform 2.5+ gateway: set the uri to ${String(awx.uri).replace(/\/+$/, "")}/api/controller/v2`);
    }
    if (status) throw new Errors.BadRequestError(`AWX at ${awx.uri} answered ${status}: ${err.message}`);
    throw new Errors.BadRequestError(`AWX at ${awx.uri} is unreachable: ${err.code || err.message}`);
  }
  if (!data?.results) throw new Errors.BadRequestError(`AWX at ${awx.uri} did not answer like AWX (no job templates list)`);
  return { templates: data.count ?? data.results.length };
}

const Awx = {};
Awx.abortJob = async function (awx, id, isWorkflow = false) {
  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  logger.info(`aborting awx ${isWorkflow ? "workflow " : ""}job ${id}`);
  const axiosConfig = getAuthorization(awxConfig);
  // workflow jobs have their own cancel endpoint
  const jobsPath = isWorkflow ? "/workflow_jobs/" : "/jobs/";
  const cancel = (path) => axios.post(awxConfig.uri + apiPrefix(awxConfig) + path + id + "/cancel/", {}, axiosConfig);
  try {
    let axiosResult;
    try {
      axiosResult = await cancel(jobsPath);
    } catch (err) {
      // a workflow cancelled before its first poll is not known as one yet (jobs.awx_workflow is
      // written by the tracker) : the jobs endpoint does not know its id, the workflow one does
      if (isWorkflow || err?.response?.status !== 404) throw err;
      axiosResult = await cancel("/workflow_jobs/");
    }
    const job = axiosResult.data;
    return job;
  } catch (error) {
    if (error.response && error.response.status === 405) {
      const message = `cannot cancel job id ${id}`;
      logger.error(message);
      throw new Errors.ConflictError(message);
    } else {
      logger.error("Failed to abort awx job: ", error);
      throw new Errors.ApiError(
        `Failed to abort awx job ${id}: ${error.message}`
      );
    }
  }
};
Awx.launch = async function (
  awx,
  ev,
  credentials,
  jobid,
  counter
) {
  var message;
  // the last output line written so far ; the next ones follow it
  counter = counter || 0;

  // we make a copy, we don't mutate the original
  var extravars = { ...ev };

  // get awx data from the extravars
  var invent = extravars?.__inventory__;
  var execenv = extravars?.__executionEnvironment__;
  var instanceGroups = [].concat(extravars?.__instanceGroups__ || []); // always array ! force to array
  var tags = extravars?.__tags__ || "";
  var scmBranch = extravars?.__scmBranch__ || "";
  var check = extravars?.__check__ || false;
  var verbose = extravars?.__verbose__ || false;
  var limit = extravars?.__limit__ || "";
  var diff = extravars?.__diff__ || false;
  var template = extravars?.__template__;

  var awxCredentials = extravars?.__awxCredentials__ || [];
  try {
    const jobTemplate = await Awx.findJobTemplateByName(awx, template);
    logger.debug("Found jobtemplate, id = " + jobTemplate.id);
    await Awx.launchTemplate(
      awx,
      jobTemplate,
      ev,
      invent,
      tags,
      limit,
      check,
      diff,
      verbose,
      credentials,
      awxCredentials,
      execenv,
      instanceGroups,
      scmBranch,
      jobid,
      ++counter
    );
    return true;
  } catch (err) {
    message = "failed to launch awx template " + template + "\n" + err.message;
    // ended once : launchTemplate ends the job itself before it throws, and a second end wrote
    // a second last line and sent a second "failed" mail
    if (!err.jobEnded) await Job.endJobStatus(jobid, counter + 1, "stdout", "failed", message);
    throw jobEnded(new Errors.ApiError(message));
  }
};
Awx.launchTemplate = async function (
  awx,
  template,
  ev,
  invent,
  tags,
  limit,
  check,
  diff,
  verbose,
  credentials,
  awxCredentials,
  execenv,
  instanceGroups,
  scmBranch,
  jobid,
  counter
) {
  var message;
  if (!counter) {
    counter = 0;
  }
  // get existing credentials in the template, and then add the external ones.
  var awxCredentialList = [];
  try {
    awxCredentialList = await Awx.findCredentialsByTemplate(
      awx,
      template.id
    );
    logger.notice(`Found ${awxCredentialList.length} existing creds`);
  } catch (e) {
    logger.warning("No credentials available... could be workflow template");
  }
  // add external ones
  for (let i = 0; i < awxCredentials.length; i++) {
    var ac = awxCredentials[i];
    var credId = await Awx.findCredentialByName(awx, ac);
    logger.debug(`Found awx credential '${ac}'; id = ${credId}`);
    awxCredentialList.push(credId);
  }
  awxCredentialList = [...new Set(awxCredentialList)];

  // get inventory
  var inventory = await Awx.findInventoryByName(awx, invent);
  // get execution environment
  var executionEnvironment = await Awx.findExecutionEnvironmentByName(
    awx,
    execenv
  );

  // get instance groups
  var instanceGroupIds = [];
  for (let index = 0; index < instanceGroups.length; index++) {
    instanceGroupIds.push(
      await Awx.findInstanceGroupByName(awx, instanceGroups[index])
    );
  }

  // get config and go

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");

  var extravars = { ...ev }; // we make a copy of the main extravars
  // merge credentials now
  extravars = { ...extravars, ...credentials };
  extravars = JSON.stringify(extravars);
  // prep the post data
  var postdata = {
    extra_vars: extravars,
  };
  if (awxCredentialList.length > 0) {
    postdata.credentials = awxCredentialList;
  }
  if (executionEnvironment) {
    postdata.execution_environment = executionEnvironment.id;
  }
  // only when the form names some : an empty list overrode the template's own instance groups
  // (prompt on launch) with none
  if (instanceGroupIds.length) {
    postdata.instance_groups = instanceGroupIds.map((x) => x.id);
  }
  if (inventory) {
    postdata.inventory = inventory.id;
  }
  if (check) {
    postdata.job_type = "check";
  } else {
    postdata.job_type = "run";
  }
  if (diff) {
    postdata.diff_mode = true;
  } else {
    postdata.diff_mode = false;
  }
  if (verbose) {
    postdata.verbosity = 3;
  }
  if (limit) {
    postdata.limit = limit;
  }
  if (scmBranch) {
    postdata.scm_branch = scmBranch;
  }
  if (tags) {
    postdata.job_tags = tags;
  }

  logger.notice("Running template: " + template.name);
  // the names only : the values hold the credentials mapped into the template
  logger.info("extravars: " + Object.keys(safeParse(extravars) || {}).join(", "));
  logger.info("inventory: " + inventory);
  logger.info("execution_environment: " + executionEnvironment);
  logger.info("instance_groups: " + instanceGroups);
  logger.info("credentials: " + awxCredentialList);
  logger.info("check: " + check);
  logger.info("diff: " + diff);
  logger.info("verbose: " + verbose);
  logger.info("tags: " + tags);
  logger.info("limit: " + limit);
  logger.info("scm_branch: " + scmBranch);
  // post
  if (template.related === undefined) {
    message = `Failed to launch, no launch attribute found for template ${template.name}`;
    logger.error(message);
    await Job.endJobStatus(jobid, counter + 1, "stderr", "failed", message);
    throw jobEnded(new Errors.ConflictError(message));
  } else {
    // prepare axiosConfig
    const axiosConfig = getAuthorization(awxConfig);
    // logger.debug("Lauching awx with data : " + JSON.stringify(postdata))
    logger.debug("Launching awx template");
    // launch awx job
    var axiosResult;
    try {
      axiosResult = await axios.post(
        serverOf(awxConfig) + template.related.launch,
        postdata,
        axiosConfig
      );
    } catch (error) {
      message = `failed to launch ${template.name}`;
      if (error.response) {
        logger.error("", error.response.data);
        message += "\r\n" + yaml.stringify(error.response.data);
        await Job.endJobStatus(
          jobid,
          counter + 1,
          "stderr",
          // "failed", not "success". endJobStatus writes the status AND sends the status
          // notification built from it, so a template AWX refused to launch (a missing
          // survey variable, a credential that is not prompt-on-launch) mailed everyone
          // "- success" and then a second mail "- failed" once Awx.launch's own catch
          // corrected the row.
          "failed",
          `Failed to launch template ${template.name}. ${message}`
        );
      } else {
        logger.error("Failed to launch: ", error);
        await Job.endJobStatus(
          jobid,
          counter + 1,
          "stderr",
          // "failed", not "success". endJobStatus writes the status AND sends the status
          // notification built from it, so a template AWX refused to launch (a missing
          // survey variable, a credential that is not prompt-on-launch) mailed everyone
          // "- success" and then a second mail "- failed" once Awx.launch's own catch
          // corrected the row.
          "failed",
          `Failed to launch template ${template.name}. ${error}`
        );
      }
      throw jobEnded(new Errors.ApiError(message));
    }

    // get awx job (= remote job !!)
    var job = axiosResult.data;
    if (job) {
      logger.info(`awx job id = ${job.id}`);
      // log launch ; a workflow is known as one from here (its empty graph, filled by the
      // tracker) : its link and its abort go to the workflow endpoints before the first poll
      const launched = { awx_id: job.id };
      if (job.type === "workflow_job" || job.related?.workflow_nodes) {
        launched.awx_workflow = JSON.stringify({ id: job.id, name: job.name || template.name, status: job.status, nodes: [] });
      }
      await Job.update(launched, jobid);
      // its address in the product's UI, kept on the job (lib/runnerJobLinks.js)
      await rememberRunnerJobUrl(jobid);
      await Job.printJobOutput(
        // as the RTE's own lines (ok: [Running on RTE ...]) : AnsibleForms' word, not AWX's
        `ok: [Launched template ${template.name} with jobid ${job.id}]`,
        "stdout",
        jobid,
        ++counter
      );
      // track the job in the background
      return Awx.trackJob(awx, job, jobid, counter + 1);
    } else {
      // no awx job, end failed
      message = `could not launch job template ${template.name}`;
      await Job.endJobStatus(
        jobid,
        counter,
        "stderr",
        "failed",
        `Failed to launch template ${template.name}`
      );
      logger.error(message);
      throw new Errors.ApiError(message);
    }
  }
};

// what a tracker returns when it stopped because another node follows the job now
export const TAKEN_OVER = "Followed by another node";

/**
 * Whether the job a tracker follows was taken over by another node (lib/jobResume.js) while
 * this node's heartbeat had lapsed : this tracker then stops, writing nothing more, so the job
 * gets one set of output lines and one end. A database that does not answer is not a take-over :
 * the poll goes on and finds out on its next turn.
 *
 * Args:
 *   jobid (number): the job.
 *
 * Returns:
 *   Promise<boolean>: true when this tracker must stop.
 */
async function takenOver(jobid) {
  const elsewhere = await Promise.resolve().then(() => Job.followedElsewhere(jobid)).catch(() => false);
  if (elsewhere) logger.warning(`Job ${jobid} is followed by another node now: this node stops following it`);
  return elsewhere;
}

/**
 * Poll an AWX job to completion.
 *
 * This is a LOOP, and must stay one. It used to call itself for the next poll, once a
 * second, for as long as the job ran - so an hour-long template built up ~3600 nested
 * async frames, and every one of them held its own `o` / `previousoutput` alive: AWX has
 * no incremental output, so those are each a full copy of the job's stdout so far. A job
 * with a few MB of output therefore retained hundreds of MB until it finished and the
 * whole chain finally unwound, on top of a real risk of exhausting the stack.
 *
 * Each place that used to recurse now assigns the next iteration's parameters and
 * `continue`s, so only the current poll's output is reachable.
 */
Awx.trackJob = async function (
  awx,
  job,
  jobid,
  counter,
  previousoutput,
  previousoutput2 = undefined,
  lastrun = false,
  _retryCount = 0
) {
  // workflow jobs have no stdout of their own, we track them node by node
  if (job.type === "workflow_job" || job.related?.workflow_nodes) {
    return Awx.trackWorkflowJob(awx, job, jobid, counter);
  }
  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  var message;
  // the order of the first row this tracking can write : the rows from here on are the
  // stdout chunks that the final stdout replaces when the job has ended
  const firstOrder = counter;
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  // the stdout of this job was too large to display : told the user once already
  var toldTooLarge = false;
  // AWX failing to answer, in a row (contactTolerance)
  const contact = contactTolerance();
  // the job's events (AWX's job events, as an RTE's af_events plugin writes them) : read in the
  // background while the job runs, the rest once it has ended ; never a reason to fail the job
  let followed = job;
  const events = createAwxEventReader({
    jobid,
    fetchPage: (after, size) => Awx.getJobEvents(awx, followed, after, size),
    full: runsVerbose(job),
  });
  for (;;) {
  // taken over by another node (this one's heartbeat lapsed) : that node follows it now
  if (await takenOver(jobid)) {
    events.stop();
    return TAKEN_OVER;
  }
  logger.info(`searching for job with id ${job.id}`);
  try {
    // get job info
    const axiosResult = await axios.get(serverOf(awxConfig) + job.url, axiosConfig);
    var j = axiosResult.data;
    if (j) {
      // its new events, in the background
      followed = j;
      events.full = runsVerbose(j);
      events.poll();
      // logger.debug(inspect(j))
      logger.debug(`awx job status: ` + j.status);
      try {
        // get text output
        const o = await Awx.getJobTextOutput(awx, job);

        var incrementIssue = false;
        var output = o;
        // AWX's "too large to display" placeholder (issue #733). The download format that
        // getJobTextOutput reads is not limited, so AWX should never send it ; should one
        // still do, it is no log and is never diffed - as the display format's answer it took
        // the increment-issue path, deleted the last stored chunk and wrote nothing from then
        // on. Say once why the log stops, keep what is stored, and keep polling.
        const tooLarge = isStdoutTooLarge(o);
        if (tooLarge) {
          output = "";
          if (!toldTooLarge) {
            await Job.printJobOutput(o, "stderr", jobid, ++counter);
            toldTooLarge = true;
          }
        } else if (output && previousoutput) {
          // does the previous output fit in the new
          if (output.includes(previousoutput)) {
            output = output.substring(previousoutput.length);
          } else {
            if (output && previousoutput2) {
              // here we have an output problem, the incremental of AWX can sometimes deviate
              // and the last output was wrong, in this case we remove the last output from the db and take the second last output
              // as last reference.
              incrementIssue = true;
              // logger.error("Incremental problem")
              output = output.substring(previousoutput2.length);
            }
          }
        }
        // the increment issue (if true) will remove the last entry before add the new (corrected) one.
        const abort_requested = await Job.printJobOutput(
          output,
          "stdout",
          jobid,
          ++counter,
          incrementIssue
        );
        if (abort_requested) {
          await Job.printJobOutput(
            "Abort requested",
            "stderr",
            jobid,
            ++counter
          );
          try {
            // we try to abort the job
            await Awx.abortJob(awx, j.id);
            await Job.resetAbortRequested(jobid);
            await events.finish();
            await Job.endJobStatus(
              jobid,
              ++counter,
              "stderr",
              "aborted",
              "Aborted job",
              j.artifacts
            );
            return "Aborted job";
          } catch (error) {
            // 405 : AWX is cancelling already (the abort sent the cancel straight away)
            if (error instanceof Errors.ConflictError) {
              await Job.resetAbortRequested(jobid);
              await events.finish();
              await Job.endJobStatus(jobid, ++counter, "stderr", "aborted", "Aborted job", j.artifacts);
              return "Aborted job";
            }
            // abort failed... , revert abort request
            await Job.printJobOutput(
              "Abort request denied, reverting abort request",
              "stderr",
              jobid,
              ++counter
            );
            await Job.resetAbortRequested(jobid);
            // next poll (was: recurse) - previousoutput becomes the second last
            job = j;
            ++counter;
            if (!tooLarge) {
              previousoutput2 = previousoutput;
              previousoutput = o;
            }
            lastrun = j.finished;
            contact.ok();
            continue;
          }
        } else {
          if (j.finished && lastrun) {
            // the job has ended, so its stdout is final. AWX assembles a running job's
            // stdout from its events, which land slightly out of order, so the chunks cut
            // from it while it ran can miss or repeat a line (issue #735) : store the final
            // stdout once, in their place - never the too-large placeholder
            if (o && !isStdoutTooLarge(o)) {
              await Job.replaceTrackedOutput(jobid, firstOrder, o);
            }
            // and its last events, before it ends : the job page has them all once it has ended
            await events.finish();
            if (j.status === "successful") {
              await Job.endJobStatus(
                jobid,
                ++counter,
                "stdout",
                "success",
                `ok: [Successfully completed template ${j.name}]`,
                j.artifacts
              );
              return true;
            } else {
              // if error, end with status (aborted or failed)
              var status = "failed";
              message = `Template ${j.name} completed with status ${j.status}`;
              if (j.status == "canceled") {
                status = "aborted";
                message = `Template ${j.name} was aborted`;
                await Job.resetAbortRequested(jobid);
              }
              // the line written : a failure as the RTE's ([ERROR]: ...), an abort as it is
              await Job.endJobStatus(
                jobid,
                ++counter,
                "stderr",
                status,
                status == "failed" ? `[ERROR]: ${message}` : message,
                j.artifacts
              );
              return message;
            }
          } else {
            // not finished, try again
            await delay(1000);
            if (j.finished) {
              logger.debug("Getting final stdout");
            }
            // next poll (was: recurse). After an increment issue the SECOND last output
            // is the reliable reference, so it is the one carried forward.
            job = j;
            ++counter;
            // a placeholder poll changes nothing : the next real output is diffed against
            // the last real one
            if (!tooLarge) {
              previousoutput2 = incrementIssue ? previousoutput2 : previousoutput;
              previousoutput = o;
            }
            lastrun = j.finished;
            contact.ok();
            continue;
          }
        }
      } catch (err) {
        message = err.toString();
        logger.error(message);
        const r = contact.failed();
        if (r.giveUp) {
          events.stop();
          return lostContact(jobid, counter + 1, job, message);
        }
        logger.warning(`Retrying jobid ${jobid} [${r.failures}] in ${r.waitMs / 1000}s`);
        await delay(r.waitMs);
        // retry the SAME poll : job, counter and both outputs stay as they were
        continue;
      }
    } else {
      message = `could not find job with id ${job.id}`;
      logger.error(message);
      const r = contact.failed();
      if (r.giveUp) {
        events.stop();
        return lostContact(jobid, counter + 1, job, message);
      }
      logger.warning(`Retrying jobid ${jobid} [${r.failures}] in ${r.waitMs / 1000}s`);
      await delay(r.waitMs);
      // retry the SAME poll, as above
      continue;
    }
  } catch (e) {
    // the status itself did not come : the same tolerance - one failed request used to end a
    // job that was running fine in AWX
    logger.error("Failed to track job: ", e);
    const r = contact.failed();
    if (r.giveUp) {
      events.stop();
      return lostContact(jobid, counter + 1, job, e.message);
    }
    logger.warning(`AWX did not answer for jobid ${jobid} [${r.failures}], retrying in ${r.waitMs / 1000}s`);
    await delay(r.waitMs);
    continue;
  }
  }
};
// format a workflow (node) status line ; Helpers.formatOutput() colors these by status
// a node's line carries its id (#42) : two nodes of one name (one template run twice) stay apart
function workflowStatusLine(prefix, name, status, banner = false, id = null) {
  var line = `${prefix} [${name}] (${status})${id ? ` #${id}` : ""}`;
  if (banner) line += " " + "*".repeat(Math.max(5, 79 - line.length));
  return line;
}
// get the nodes of an awx workflow job, simplified to what we need for output and visualization
Awx.getWorkflowNodes = async function (awx, job) {
  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  if (!job.related?.workflow_nodes) return [];
  const axiosConfig = getAuthorization(awxConfig);
  var results = [];
  var url = job.related.workflow_nodes;
  // the node list is paginated, follow the next links
  while (url) {
    const axiosResult = await axios.get(serverOf(awxConfig) + url, axiosConfig);
    results = results.concat(axiosResult.data?.results || []);
    url = axiosResult.data?.next;
  }
  return results.map((n) => ({
    id: n.id,
    name:
      n.summary_fields?.job?.name ||
      n.summary_fields?.unified_job_template?.name ||
      `node ${n.id}`,
    type:
      n.summary_fields?.job?.type ||
      n.summary_fields?.unified_job_template?.unified_job_type ||
      "job",
    status:
      n.summary_fields?.job?.status || (n.do_not_run ? "skipped" : "pending"),
    elapsed: n.summary_fields?.job?.elapsed || 0,
    job: n.job,
    job_url: n.related?.job,
    success_nodes: n.success_nodes || [],
    failure_nodes: n.failure_nodes || [],
    always_nodes: n.always_nodes || [],
    // Ascender's conditional links : taken on the parent's outcome (trigger) when an artifact of
    // it matches ; AWX and AAP have none
    condition_edges: conditionEdges(n),
    do_not_run: n.do_not_run || false,
  }));
};
/**
 * The conditional links of an Ascender workflow node : one per child, with what takes it. A
 * child listed in condition_nodes but not in condition_edges (an older Ascender) is taken on
 * success, its condition unknown.
 *
 * Args:
 *   n (object): the node, as the api returned it.
 *
 * Returns:
 *   object[]: [{ id, trigger, artifact_key, operator, expected_value }], [] on AWX and AAP.
 */
function conditionEdges(n) {
  const edges = (Array.isArray(n.condition_edges) ? n.condition_edges : [])
    .filter((e) => e && e.id != null)
    .map((e) => ({
      id: e.id,
      trigger: ["success", "failure", "always"].includes(e.trigger) ? e.trigger : "success",
      artifact_key: e.artifact_key || "",
      operator: e.operator === "ne" ? "ne" : "eq",
      expected_value: e.expected_value ?? "",
    }));
  const known = new Set(edges.map((e) => e.id));
  (Array.isArray(n.condition_nodes) ? n.condition_nodes : [])
    .filter((id) => !known.has(id))
    .forEach((id) => edges.push({ id, trigger: "success", artifact_key: "", operator: "eq", expected_value: "" }));
  return edges;
}
/**
 * The extra vars and the artifacts of one node's job of an AWX workflow : what the job page's
 * node shows (Show variables, Show artifacts). An approval or a project update has neither : {}.
 *
 * Args:
 *   awx (object): the runner.
 *   node (object): the node, as getWorkflowNodes stored it ({ job, job_url, type }).
 *
 * Returns:
 *   Promise<object>: { extravars, artifacts } - both objects, {} when there are none.
 */
Awx.getNodeJobData = async function (awx, node) {
  if (!awx) throw new Errors.ApiError("No AWX runner given");
  if (!node?.job) return { extravars: {}, artifacts: {} };
  // its own link, else the job's (a graph stored before the link was kept)
  const url = node.job_url ? serverOf(awx) + node.job_url : awx.uri + apiPrefix(awx) + "/jobs/" + node.job + "/";
  const { data } = await axios.get(url, getAuthorization(awx));
  const asObject = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // AWX keeps a job's extra_vars as JSON ; anything else is not shown
      return {};
    }
  };
  return { extravars: asObject(data?.extra_vars), artifacts: asObject(data?.artifacts) };
};
// track an awx workflow job ; poll the workflow nodes, dump the output of every
// finished node and store the workflow graph as json for visualization
Awx.trackWorkflowJob = async function (
  awx,
  job,
  jobid,
  counter,
  printedNodeIds = [],
  previousWorkflowJson = "",
  _retryCount = 0
) {
  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  const axiosConfig = getAuthorization(awxConfig);
  // AWX failing to answer, in a row (contactTolerance)
  const contact = contactTolerance();
  for (;;) {
    // taken over by another node (this one's heartbeat lapsed) : that node follows it now
    if (await takenOver(jobid)) return TAKEN_OVER;
    try {
      // get workflow job info
      const axiosResult = await axios.get(serverOf(awxConfig) + job.url, axiosConfig);
      var j = axiosResult.data;
      if (!j) throw new Error(`could not find workflow job with id ${job.id}`);
      logger.debug(`awx workflow job status: ` + j.status);
      // get the workflow nodes
      const nodes = await Awx.getWorkflowNodes(awx, j);
      // store the workflow graph json, the client uses this to visualize the workflow
      const workflowJson = JSON.stringify({
        id: j.id,
        name: j.name,
        status: j.status,
        nodes,
      });
      if (workflowJson != previousWorkflowJson) {
        await Job.update({ awx_workflow: workflowJson }, jobid);
      }
      // dump the output of the nodes that just finished (in completion order)
      const finishedStatuses = ["successful", "failed", "error", "canceled"];
      const finishedNodes = nodes.filter(
        (n) =>
          n.job &&
          finishedStatuses.includes(n.status) &&
          !printedNodeIds.includes(n.id)
      );
      for (const node of finishedNodes) {
        var nodeOutput = "";
        // the node's job, once read : its events are stored after its output
        var child = null;
        try {
          // get the child job (job, project_update, workflow_approval, ...) and grab its output
          const childResult = await axios.get(
            serverOf(awxConfig) + node.job_url,
            axiosConfig
          );
          child = childResult.data;
          nodeOutput =
            (await Awx.getJobTextOutput(awx, childResult.data)) || "";
        } catch (e) {
          logger.warning(
            `Failed to get output of workflow node ${node.name}: ${e.message}`
          );
        }
        const banner = workflowStatusLine(
          "WORKFLOW NODE",
          node.name,
          node.status,
          true,
          node.id
        );
        await Job.printJobOutput(
          `${banner}\n${nodeOutput}`.trim(),
          "stdout",
          jobid,
          ++counter
        );
        printedNodeIds.push(node.id);
        // its events, after the nodes' before it : in the order of the output, so its lines
        // pair with them
        await Awx.storeNodeEvents(awx, jobid, child);
      }
      // check for abort request
      const abort_requested = await Job.isAbortRequested(jobid);
      if (abort_requested) {
        await Job.printJobOutput("Abort requested", "stderr", jobid, ++counter);
        try {
          // we try to abort the workflow job
          await Awx.abortJob(awx, j.id, true);
          await Job.resetAbortRequested(jobid);
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stderr",
            "aborted",
            "Aborted workflow job"
          );
          return "Aborted workflow job";
        } catch (error) {
          // 405 : AWX is cancelling already (the abort sent the cancel straight away)
          if (error instanceof Errors.ConflictError) {
            await Job.resetAbortRequested(jobid);
            await Job.endJobStatus(jobid, ++counter, "stderr", "aborted", "Aborted workflow job");
            return "Aborted workflow job";
          }
          // abort failed... , revert abort request
          await Job.printJobOutput(
            "Abort request denied, reverting abort request",
            "stderr",
            jobid,
            ++counter
          );
          await Job.resetAbortRequested(jobid);
        }
      }
      if (j.finished) {
        // print a summary of all the nodes with their status
        // the workflow's banner, then a line per node, its status in one column
        // (lib/workflowSummary.js : the same as a workflow on the RTE)
        var summary = [workflowStatusLine("WORKFLOW", j.name, j.status, true)];
        summary.push(...workflowSummaryLines(nodes.map((node) => ({ id: node.id, name: node.name, status: node.status }))));
        await Job.printJobOutput(summary.join("\n"), "stdout", jobid, ++counter);
        if (j.status === "successful") {
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stdout",
            "success",
            `ok: [Successfully completed workflow ${j.name}]`
          );
          return true;
        } else {
          // if error, end with status (aborted or failed)
          var status = "failed";
          var message = `Workflow ${j.name} completed with status ${j.status}`;
          if (j.status == "canceled") {
            status = "aborted";
            message = `Workflow ${j.name} was aborted`;
            await Job.resetAbortRequested(jobid);
          }
          // the line written : a failure as the RTE's ([ERROR]: ...), an abort as it is
          await Job.endJobStatus(
            jobid,
            ++counter,
            "stderr",
            status,
            status == "failed" ? `[ERROR]: ${message}` : message
          );
          return message;
        }
      }
      // not finished, try again : a loop, not a call per second, so a workflow that runs for
      // hours does not hold one stack frame (and its node list) for every poll
      await delay(1000);
      job = j;
      counter++;
      previousWorkflowJson = workflowJson;
      contact.ok();
    } catch (err) {
      const message = err.toString();
      logger.error(message);
      const r = contact.failed();
      if (r.giveUp) return lostContact(jobid, counter + 1, job, message);
      logger.warning(`Retrying jobid ${jobid} [${r.failures}] in ${r.waitMs / 1000}s`);
      await delay(r.waitMs);
    }
  }
};
/**
 * The AWX job (or workflow job) a job launched, as AWX knows it now : for following it again
 * after the node that followed it stopped (Awx.resume).
 *
 * Args:
 *   awx (object): the runner.
 *   awxId (number): the AWX job id (jobs.awx_id).
 *   isWorkflow (boolean): a workflow job (jobs.awx_workflow is set).
 *
 * Returns:
 *   Promise<object|null>: the AWX job, or null when AWX no longer knows it (404).
 *
 * Raises:
 *   Error: AWX did not answer, or answered another error.
 */
Awx.findRemoteJob = async function (awx, awxId, isWorkflow = false) {
  if (!awx) throw new Errors.ApiError("No AWX runner given");
  const get = (path) => axios.get(awx.uri + apiPrefix(awx) + path + awxId + "/", getAuthorization(awx));
  try {
    return (await get(isWorkflow ? "/workflow_jobs/" : "/jobs/")).data || null;
  } catch (err) {
    if (err?.response?.status !== 404) throw err;
    // a workflow stopped before its first poll is not known as one yet (jobs.awx_workflow is
    // written by the tracker) : the workflow endpoint may still know its id
    if (isWorkflow) return null;
    try {
      return (await get("/workflow_jobs/")).data || null;
    } catch (err2) {
      if (err2?.response?.status === 404) return null;
      throw err2;
    }
  }
};

/**
 * The ids of the workflow nodes whose output a job holds already : their banner, written once
 * per finished node by trackWorkflowJob (WORKFLOW NODE [name] (status) #id ****).
 *
 * Args:
 *   rows (object[]): the job's output rows ({ output }).
 *
 * Returns:
 *   number[]: the node ids.
 */
export function printedWorkflowNodeIds(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    const re = /^WORKFLOW NODE \[.*\] \(\w+\) #(\d+) \*{5,}$/gm;
    let m;
    while ((m = re.exec(String(row?.output || ""))) !== null) ids.add(Number(m[1]));
  }
  return [...ids];
}

/**
 * Follows again an AWX job its node stopped following (a restart, a replaced pod) : the job
 * ends with what AWX reports, its notifications sent as usual. A job's stdout tracked so far is
 * dropped and read again in full (AWX keeps all of it), so the output has no gap ; a workflow
 * goes on from the nodes whose output it holds.
 *
 * Args:
 *   awx (object): the runner.
 *   row (object): the job ({ id, awx_id, awx_workflow }).
 *
 * Returns:
 *   Promise<any>: what the tracker returns, once the job has ended ; null when AWX no longer
 *     knows the job (it was not resumed).
 */
Awx.resume = async function (awx, row) {
  const jobid = row.id;
  const isWorkflow = !!row.awx_workflow;
  const remote = await Awx.findRemoteJob(awx, row.awx_id, isWorkflow);
  if (!remote) return null;
  const rows = await Job.outputRows(jobid);
  const workflow = isWorkflow || remote.type === "workflow_job" || !!remote.related?.workflow_nodes;
  // the stdout tracked before the restart : replaced by AWX's full stdout, read again below
  if (!workflow) await Job.dropTrackedStdout(jobid, rows);
  // and its events, read again in full with it (a workflow's nodes keep theirs)
  if (!workflow) {
    await JobEvent.removeByJob(jobid).catch((e) => logger.warning(`Job ${jobid}: its events could not be cleared (${e.message})`));
  }
  let counter = await Job.lastOrder(jobid);
  await Job.printJobOutput(
    `ok: [Following ${workflow ? "workflow job" : "job"} ${remote.id} again, after the server restarted]`,
    "stdout",
    jobid,
    ++counter
  );
  if (workflow) {
    return Awx.trackWorkflowJob(awx, remote, jobid, counter + 1, printedWorkflowNodeIds(rows), row.awx_workflow || "");
  }
  return Awx.trackJob(awx, remote, jobid, counter + 1);
};
/**
 * A page of an AWX job's events, in order : those after a counter. The request is built as
 * every other one to AWX : the job's own link (related.job_events) on the runner's server, else
 * the runner's uri and API prefix (AWX_API_PREFIX, or the path the uri carries : AAP 2.5's
 * /api/controller/v2), its credentials, its certificate settings and its timeout.
 *
 * Args:
 *   awx (object): the runner.
 *   job (object): the AWX job ({ id, related }).
 *   afterCounter (number): the last counter read (0 for the first page).
 *   pageSize (number): the events asked for at once.
 *
 * Returns:
 *   Promise<object>: AWX's answer, { count, next, results }.
 *
 * Raises:
 *   Error: AWX did not answer, or answered an error.
 */
Awx.getJobEvents = async function (awx, job, afterCounter = 0, pageSize = 200) {
  if (!awx) throw new Errors.ApiError("No AWX runner given");
  const url = job?.related?.job_events
    ? serverOf(awx) + job.related.job_events
    : awx.uri + apiPrefix(awx) + "/jobs/" + job?.id + "/job_events/";
  const { data } = await axios.get(url, {
    ...getAuthorization(awx),
    params: { counter__gt: afterCounter, order_by: "counter", page_size: pageSize },
  });
  return data;
};

/**
 * Stores the events of a workflow node's job, once it has ended : after the events stored
 * already (the nodes before it). A node that is no playbook job (an approval, a project update,
 * a nested workflow) has none. Never throws : the workflow goes on without them.
 *
 * Args:
 *   awx (object): the runner.
 *   jobid (number): the workflow's job in AnsibleForms.
 *   child (object|null): the node's AWX job, as AWX returned it.
 *
 * Returns:
 *   Promise<void>
 */
Awx.storeNodeEvents = async function (awx, jobid, child) {
  if (!child?.related?.job_events) return;
  try {
    const reader = createAwxEventReader({
      jobid,
      fetchPage: (after, size) => Awx.getJobEvents(awx, child, after, size),
      full: runsVerbose(child),
      startOrder: await JobEvent.lastOrder(jobid),
    });
    await reader.finish();
  } catch (e) {
    logger.warning(`Job ${jobid}: the events of AWX job ${child.id} could not be stored (${e.message})`);
  }
};
Awx.getJobTextOutput = async function (awx, job) {
  if (!job) return undefined;

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  if (job.related === undefined) {
    throw new Errors.ConflictError(
      "No related attribute found for job " + job.id
    );
  } else {
    if (!job.related.stdout) {
      // workflow job... just return status
      return job.status;
    }
    // prepare axiosConfig
    const axiosConfig = getAuthorization(awxConfig);
    // txt_download, not txt : the display formats are refused above AWX's
    // STDOUT_MAX_BYTES_DISPLAY (1 MB by default) with a placeholder instead of the log
    // (issue #733), the download formats are not limited. Below the limit both return the
    // same plain text, in the same time.
    const axiosResult = await axios.get(
      serverOf(awxConfig) + job.related.stdout + "?format=txt_download",
      { ...axiosConfig, responseType: "text" }
    );
    return axiosResult.data;
  }
};
Awx.findJobTemplateByName = async function (awx, name) {
  if (!name) return undefined;

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  var message;
  logger.info(`searching job template ${name}`);
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  var axiosResult = await axios.get(
    awxConfig.uri +
      apiPrefix(awxConfig) +
      "/job_templates/?name=" +
      encodeURIComponent(name),
    axiosConfig
  );
  var job_template = axiosResult.data.results.find(function (x) {
    return x.name == name;
  });
  if (job_template) {
    return job_template;
  } else {
    logger.info("Template not found, looking for workflow job template");
    // trying workflow job templates
    axiosResult = await axios.get(
      awxConfig.uri +
        apiPrefix(awxConfig) +
        "/workflow_job_templates/?name=" +
        encodeURIComponent(name),
      axiosConfig
    );
    job_template = axiosResult.data.results.find(function (x) {
      return x.name == name;
    });
    if (job_template) {
      return job_template;
    } else {
      message = `could not find job template ${name}`;
      logger.error(message);
      throw new Errors.NotFoundError(message);
    }
  }
};
Awx.findCredentialByName = async function (awx, name) {
  if (!name) return undefined;

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  var message;
  logger.info(`searching credential ${name}`);
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  const axiosResult = await axios.get(
    awxConfig.uri +
      apiPrefix(awxConfig) +
      "/credentials/?name=" +
      encodeURIComponent(name),
    axiosConfig
  );
  var credential = axiosResult.data.results.find(function (x) {
    return x.name == name;
  });
  if (credential) {
    return credential.id;
  } else {
    message = `could not find credential ${name}`;
    logger.error(message);
    throw new Errors.NotFoundError(message);
  }
};
Awx.findExecutionEnvironmentByName = async function (awx, name) {
  if (!name) return undefined;

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  var message;
  logger.info(`searching execution environment ${name}`);
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  message = `could not find execution environment ${name}`;
  var axiosResult;
  try {
    axiosResult = await axios.get(
      awxConfig.uri +
        apiPrefix(awxConfig) +
        "/execution_environments/?name=" +
        encodeURIComponent(name),
      axiosConfig
    );
  } catch (error) {
    throw new Errors.ApiError(`${message}, ${error.message}`);
  }
  var execution_environment = axiosResult.data.results.find(function (x) {
    return x.name == name;
  });
  if (execution_environment) {
    return execution_environment;
  } else {
    logger.error(message);
    throw new Errors.NotFoundError(message);
  }
};
Awx.findInstanceGroupByName = async function (awx, name) {
  if (!name) return undefined;

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  var message;
  logger.info(`searching instance group ${name}`);
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  message = `could not find instance group ${name}`;
  var axiosResult;
  try {
    axiosResult = await axios.get(
      awxConfig.uri +
        apiPrefix(awxConfig) +
        "/instance_groups/?name=" +
        encodeURIComponent(name),
      axiosConfig
    );
  } catch (error) {
    throw new Errors.ApiError(`${message}, ${error.message}`);
  }
  var instance_group = axiosResult.data.results.find(function (x) {
    return x.name == name;
  });
  if (instance_group) {
    return instance_group;
  } else {
    logger.error(message);
    throw new Errors.NotFoundError(message);
  }
};
Awx.findCredentialsByTemplate = async function (awx, id) {
  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  logger.info(`searching credentials for template id ${id}`);
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  const axiosResult = await axios.get(
    awxConfig.uri +
      apiPrefix(awxConfig) +
      "/job_templates/" +
      id +
      "/credentials/",
    axiosConfig
  );
  if (axiosResult.data?.results?.length) {
    return axiosResult.data.results.map((x) => x.id);
  }
  return [];
};
Awx.findInventoryByName = async function (awx, name) {
  if (!name) return undefined;

  const awxConfig = awx;
  if (!awxConfig) throw new Errors.ApiError("No AWX runner given");
  var message;
  logger.info(`searching inventory ${name}`);
  // prepare axiosConfig
  const axiosConfig = getAuthorization(awxConfig);
  message = `could not find inventory ${name}`;
  var axiosResult;
  try {
    axiosResult = await axios.get(
      awxConfig.uri +
        apiPrefix(awxConfig) +
        "/inventories/?name=" +
        encodeURIComponent(name),
      axiosConfig
    );
  } catch (error) {
    throw new Errors.ApiError(`${message}, ${error.message}`);
  }
  var inventory = axiosResult.data.results.find(function (x) {
    return x.name == name;
  });
  if (inventory) {
    return inventory;
  } else {
    logger.error(message);
    throw new Errors.NotFoundError(message);
  }
};

export { Awx };
export default Awx;
