'use strict';
import Job from '../../models/job.model.js';
import JobEvent from '../../models/jobEvent.model.js';
import { workflowNodeData } from '../../lib/workflowNodeData.js';
import { addRunnerJobLinks } from '../../lib/runnerJobLinks.js';
import { storedJobOfJob } from '../../lib/storedJobUse.js';
import RestResultv2 from '../../models/restResult.model.v2.js';
import logger from "../../lib/logger.js";
import stream from 'stream';
import Audit from "../../models/audit.model.js";
import i18n from '../../lib/i18n.js';
import { publicMessage } from './publicError.js';
import appConfig from '../../../config/app.config.js';

const abortJob = async function(req, res) {
  var jobid = req.params.id;
  if(!jobid){
    res.status(409).json(RestResultv2.error(i18n.t(req, 'jobs.mustProvideJobId')));
    return false
  }
  try {
    await Job.abort(req.user.user, jobid);
    res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'jobs.abortRequested') }));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'ConflictError') {
      res.status(409).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedAbort'), publicMessage(req, err)));
    }
  }
};
const getJob = async function(req, res) {
  var user = req.user.user
  try {
    const job = await Job.findById(user, req.params.id, (req.query.text == "true"), true)
    var restData = job
    restData.extravars = JSON.parse(job.extravars || "{}")
    // `payload` : the same, the word a Rundeck job uses
    restData.payload = restData.extravars
    restData.credentials = JSON.parse(job.credentials || "{}")
    restData.approval = JSON.parse(job.approval || "{}")
    restData.notifications = JSON.parse(job.notifications || "{}")
    restData.subjobs = (job.subjobs || "").split(",").filter(x => x != "").map(x => parseInt(x))
    // the stored job it was launched from : its id and name when this user sees it, else none
    // (one deleted since included) ; its bare id is not handed out (lib/storedJobUse.js)
    restData.storedJob = await storedJobOfJob(user, job.stored_job_id)
    delete restData.stored_job_id
    // on an AWX, AAP or Ascender : the job's address there, and its workflow nodes'
    await addRunnerJobLinks(restData)
    // an ended job : what its Relaunch offers besides a full relaunch (as GET .../relaunch-options),
    // read with it, so the job page draws its Relaunch with its other buttons ; null when this user
    // may not relaunch it or the choices cannot be read
    if (!['running', 'approve'].includes(restData.status)) {
      restData.relaunchOptions = await Promise.resolve().then(() => Job.relaunchOptions(user, req.params.id)).catch(() => null)
    }
    res.status(200).json(RestResultv2.single(restData));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieve'), publicMessage(req, err)));
    }
  }
};
// a job's structured events (the af_events callback plugin on an RTE, AWX's job events for a job on
// AWX, AAP or Ascender) : the job page's host-by-task grid, timeline and recap ; only who may see
// the job (as getJob) sees them
const getJobEvents = async function(req, res) {
  try {
    // who may see the job (Job.assertReadable : findById's rule, without reading its output)
    await Job.assertReadable(req.user.user, req.params.id)
    res.status(200).json(RestResultv2.list(await JobEvent.findByJob(req.params.id)));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieve'), publicMessage(req, err)));
    }
  }
};
// one event with its whole result : a host's line of the output clicked (its details), for who may
// see the job
const getJobEvent = async function(req, res) {
  try {
    // an event's place among the job's events : a whole number from 0, nothing else
    const order = String(req.params.order ?? '');
    if (!/^\d+$/.test(order) || !Number.isSafeInteger(Number(order))) {
      return res.status(400).json(RestResultv2.error(i18n.t(req, 'jobs.invalidEventOrder', { order })));
    }
    await Job.assertReadable(req.user.user, req.params.id)
    const event = await JobEvent.findOne(req.params.id, Number(order));
    if (!event) return res.status(404).json(RestResultv2.error(`No event ${req.params.order} in job ${req.params.id}`));
    res.status(200).json(RestResultv2.single(event));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieve'), publicMessage(req, err)));
    }
  }
};
// a workflow node's variables and artifacts (the job page's node : Show variables, Show
// artifacts) : the job read as getJob reads it, so only who may see the job sees them
const getWorkflowNode = async function(req, res) {
  var user = req.user.user
  try {
    const job = await Job.findById(user, req.params.id, false, true)
    res.status(200).json(RestResultv2.single(await workflowNodeData(job, req.params.nodeId)));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieve'), publicMessage(req, err)));
    }
  }
};
// the most jobs one list request returns, unless JOBS_LIST_SIZE asks for more
const MAX_JOBS_LIST = 5000;
const findAllJobs = async function(req, res) {
    var user = req?.user?.user || {}
    // how many of the newest jobs : the page may ask, else Settings > Jobs (JOBS_LIST_SIZE) - never
    // more than MAX_JOBS_LIST, or ?records=10000000 read the whole table with its aggregates
    var records = Math.min(Math.max(parseInt(req.query.records, 10) || appConfig.jobsListSize || 1000, 1), Math.max(MAX_JOBS_LIST, Number(appConfig.jobsListSize) || 0))
    try{
      // ?user=<name>&user_type=<type>, ?runner=<name>, ?stored_job=<id> : one user's, one runner's
      // or one stored job's jobs (the ones launched from it)
      const jobs = await Job.findAll(user,records,{ user: req.query.user, userType: req.query.user_type, runner: req.query.runner, storedJob: req.query.stored_job })
      res.status(200).json(RestResultv2.list(jobs));
    }catch(err){
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieveJobs'), publicMessage(req, err)));
    }
};
const findApprovals = async function(req, res) {
    var user = req.user.user
    try{
      const count = await Job.findApprovals(user)
      res.status(200).json(RestResultv2.single(count));
    }catch(err){
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieveApprovals'), publicMessage(req, err)));
    }
};
const download = async function(req,res){
  try{
    var user = req.user.user
    var job = await Job.findById(user,req.params.id,true,true)

    var fileName = `ansibleforms-job-${job.id}.txt`;
    var joboutput = job.output || ""
    // convert output string to stream

    var readStream = new stream.PassThrough();
    readStream.write(joboutput);
    readStream.end();
  
    res.set('Content-disposition', 'attachment; filename="' + fileName + '"');
    res.set('Content-Type', 'text/plain');

    readStream.on('error', (err) => {
      logger.error(`Job download stream error: ${err.message}`)
      if (!res.headersSent) {
        res.status(500).json(RestResultv2.error('stream error'))
      } else {
        res.destroy(err)
      }
    });

    readStream.pipe(res);

  }catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieve'), publicMessage(req, err)));
    }
  }
}
const getRawFormData = async function(req, res) {
  try {
    var user = req.user.user;
    const rawFormData = await Job.getRawFormData(user, req.params.id);
    res.status(200).json(RestResultv2.single(rawFormData));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError' || err.name === 'ForbiddenError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else if (err.name === 'BadRequestError') {
      res.status(400).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieveRawData'), publicMessage(req, err)));
    }
  }
};
const deleteJob = async function(req, res) {
  try {
    var user = req?.user?.user || {};
    await Job.delete(user, req.params.id);
    res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'jobs.deleted') }));
  } catch (err) {
    if (err.name === 'NotFoundError') {
      res.status(404).json(RestResultv2.error(err.message));
    } else if (err.name === 'AccessDeniedError') {
      res.status(403).json(RestResultv2.error(err.message));
    } else {
      res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedDelete'), publicMessage(req, err)));
    }
  }
};
// this is the main launch code for everything
const launch = async function(req, res) {
    //handles null error
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        // wrong implementation -> send 409 error
        res.status(409).json(RestResultv2.error(i18n.t(req, 'errors.noDataSent')));
    }else{
        // get the form data
        var form = req.body.formName || "";
        // the client may not choose the playbook, credentials or working directory unless
        // the form declares a field of that name - stripped inside Job.launch, which is the
        // first place the form definition is known (see stripReservedExtravars)
        // `payload` says the same : the word a Rundeck job uses
        var extravars = req.body.extravars ?? req.body.payload ?? {}
        var creds = req.body.credentials || {}
        var rawFormData = req.body.rawFormData || {}
        // the uploads of the form's file fields, as POST /api/v2/job/upload returned them
        var files = (req.body.files && typeof req.body.files === 'object') ? req.body.files : {}
        // the stored job the form was filled from (opened with ?storedJob=<id>, or Load) : checked
        // by Job.launch, which records its last use (lib/storedJobUse.js)
        var storedJobId = req.body.storedJobId ?? null
        // new in 4.0.16, awxCreds are extracted from form and extravars
        var user = req?.user?.user || {}
        // check permission for verbose mode
        if (extravars.__verbose__ && !user.options.allowVerboseMode) {
          res.status(403).json(RestResultv2.error(i18n.t(req, 'errors.noVerbosePermission')));
          return false;
        }
        try{
          const job = await Job.launch({ form, user, credentials: creds, extravars, rawFormData, files, fromClient: true, storedJobId });
          res.status(200).json(RestResultv2.single(job));
        }catch(err){
          // LAUNCH_VALIDATION=enforce : the field values break the form's rules
          if (err?.name === 'ValidationError') {
            logger.warning(err.message);
            res.status(422).json(RestResultv2.error(i18n.t(req, 'jobs.invalidFormData'), err.details || err.message));
            return;
          }
          logger.error("Errors in job launch: ", err)
          try{
            res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedLaunch'), publicMessage(req, err)));
          }catch(e){}
        }
    }
};
const relaunchJob = async function(req, res) {

    // get the form data
    var jobid = req.params.id;
    var verbose = (req.query.verbose || "false")=="true"
    if(!jobid){
      res.status(409).json(RestResultv2.error(i18n.t(req, 'jobs.mustProvideJobId')));
      return false
    }
    var user = req?.user?.user || {}
    // check permission for verbose mode
    if (verbose && !user.options.allowVerboseMode) {
      res.status(403).json(RestResultv2.error(i18n.t(req, 'errors.noVerbosePermission')));
      return false;
    }
    // a body with `values` : relaunch with those fields changed, through the form engine ;
    // without one : replay the job as it ran
    const values = (req.body && typeof req.body.values === 'object' && req.body.values !== null && !Array.isArray(req.body.values))
      ? req.body.values : null;
    // `failedHostsOnly: true` : the same relaunch, on the hosts the job failed on only
    const failedHostsOnly = req.body?.failedHostsOnly === true;
    // `fromFailedNode: true` : a failed workflow job from its failed node, the nodes that
    // succeeded carried over
    const fromFailedNode = req.body?.fromFailedNode === true;
    try{
      const job = values
        ? await Job.relaunchWithValues({ user, id: jobid, values, verbose, failedHostsOnly, fromFailedNode })
        : await Job.relaunch(user, jobid, verbose, { failedHostsOnly, fromFailedNode });
      const message = job.failedHosts
        ? i18n.t(req, 'jobs.relaunchedFailedHosts', { id: job.id, count: job.failedHosts.length })
        : job.fromFailedNode
          ? i18n.t(req, 'jobs.relaunchedFromFailedNode', { id: job.id })
          : i18n.t(req, 'jobs.relaunched', { id: job.id });
      res.status(200).json(RestResultv2.single({ message, id: job.id, ...(job.failedHosts ? { failedHosts: job.failedHosts } : {}) }));
    } catch(err) {
      if (err.name === 'ValidationError') {
        res.status(422).json(RestResultv2.error(i18n.t(req, 'jobs.invalidFormData'), err.details || err.message));
      } else if (err.code === 'NO_FAILED_HOSTS') {
        // said in the caller's language, the model's reason as the details
        res.status(400).json(RestResultv2.error(i18n.t(req, 'jobs.noFailedHosts'), err.message));
      } else if (err.code === 'NOT_FROM_FAILED_NODE') {
        // the workflow changed since, it did not fail, it kept no nodes ... : the reason as the details
        res.status(400).json(RestResultv2.error(i18n.t(req, err.reason === 'changed' ? 'jobs.workflowChanged' : 'jobs.cannotRelaunchFromFailedNode'), err.message));
      } else if (err.name === 'BadRequestError') {
        res.status(400).json(RestResultv2.error(err.message));
      } else if (err.name === 'NotFoundError') {
        res.status(404).json(RestResultv2.error(err.message));
      } else if (err.name === 'AccessDeniedError' || err.name === 'ForbiddenError') {
        res.status(403).json(RestResultv2.error(err.message));
      } else if (err.name === 'ConflictError') {
        res.status(409).json(RestResultv2.error(err.message));
      } else {
        logger.error(`Error relaunching job: ${err.toString()}`);
        res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRelaunch'), publicMessage(req, err)));
      }
    }
};
/**
 * GET /api/v2/job/:id/relaunch-options : what the job page's Relaunch offers besides a full
 * relaunch - the hosts an ended job failed on, when it can be re-run on them ; whether a failed
 * workflow job can be relaunched from its failed node.
 *
 * Args:
 *   req (object): the request (params.id, the user).
 *   res (object): the response : { failedHosts: string[]|null, fromFailedNode: boolean }.
 *
 * Returns:
 *   Promise<void>
 */
const getRelaunchOptions = async function(req, res) {
    const user = req?.user?.user || {};
    try {
      res.status(200).json(RestResultv2.single(await Job.relaunchOptions(user, req.params.id)));
    } catch (err) {
      if (err.name === 'NotFoundError') {
        res.status(404).json(RestResultv2.error(err.message));
      } else if (err.name === 'AccessDeniedError' || err.name === 'ForbiddenError') {
        res.status(403).json(RestResultv2.error(err.message));
      } else {
        logger.error(`Error reading the relaunch options of job ${req.params.id}: ${err.toString()}`);
        res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedRetrieve'), publicMessage(req, err)));
      }
    }
};
const approveJob = async function(req, res) {

    // get the form data
    var jobid = req.params.id;
    if(!jobid){
      res.status(409).json(RestResultv2.error(i18n.t(req, 'jobs.mustProvideJobId')));
      return false
    }
    var user = req?.user?.user || {}
    try{
      await Job.approve(user,jobid);
      // an approval is a human decision to let privileged automation run : worth its
      // own entry beyond the generic 'someone POSTed here' the middleware records
      Audit.log({ user, ip: req.ip, action: 'job.approve', targetType: 'job', target: jobid });
      res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'jobs.approved', { id: jobid }) }));
    }catch(err){
      // Mapped like every sibling in this file. A bare 500 for a permission refusal is
      // wrong twice over: the caller is told the server broke, and auditMiddleware only
      // files 401/403 as outcome='denied' - so a refused approval was recorded as a
      // 'failure' and vanished from the very filter the audit log exists to provide.
      // (Audit.log above only runs on success, so the middleware row is the only trace.)
      if (err.name === 'NotFoundError') {
        res.status(404).json(RestResultv2.error(err.message));
      } else if (err.name === 'AccessDeniedError' || err.name === 'ForbiddenError') {
        // one's own job (four eyes) : said in the approver's language
        res.status(403).json(RestResultv2.error(err.code === 'OWN_JOB' ? i18n.t(req, 'jobs.cantApproveOwnJob') : err.message));
      } else if (err.name === 'ConflictError') {
        res.status(409).json(RestResultv2.error(err.message));
      } else {
        logger.error(`Error: ${err.toString()}`)
        res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedApprove'), publicMessage(req, err)));
      }
    }    
};
const rejectJob = async function(req, res) {

    // get the form data
    var jobid = req.params.id;
    if(!jobid){
      res.status(409).json(RestResultv2.error(i18n.t(req, 'jobs.mustProvideJobId')));
      return false
    }
    var user = req?.user?.user || {}
    try{
      await Job.reject(user,jobid)
      Audit.log({ user, ip: req.ip, action: 'job.reject', targetType: 'job', target: jobid });
      res.status(200).json(RestResultv2.single({ message: i18n.t(req, 'jobs.rejected', { id: jobid }) }));
    }catch(err){
      // Mapped like every sibling in this file. A bare 500 for a permission refusal is
      // wrong twice over: the caller is told the server broke, and auditMiddleware only
      // files 401/403 as outcome='denied' - so a refused approval was recorded as a
      // 'failure' and vanished from the very filter the audit log exists to provide.
      // (Audit.log above only runs on success, so the middleware row is the only trace.)
      if (err.name === 'NotFoundError') {
        res.status(404).json(RestResultv2.error(err.message));
      } else if (err.name === 'AccessDeniedError' || err.name === 'ForbiddenError') {
        res.status(403).json(RestResultv2.error(err.message));
      } else if (err.name === 'ConflictError') {
        res.status(409).json(RestResultv2.error(err.message));
      } else {
        logger.error(`Error: ${err.toString()}`)
        res.status(500).json(RestResultv2.error(i18n.t(req, 'jobs.failedReject'), publicMessage(req, err)));
      }
    }    

};

export { MAX_JOBS_LIST };
export default {
  getJobEvents,
  getJobEvent,
  abortJob,
  getJob,
  getWorkflowNode,
  findAllJobs,
  findApprovals,
  download,
  getRawFormData,
  deleteJob,
  launch,
  relaunchJob,
  getRelaunchOptions,
  approveJob,
  rejectJob
};