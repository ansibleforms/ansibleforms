// The job's I/O in database mode (RTE_MODE=database, deprecated) : the RTE reads the job and
// writes its output, log, events and end status in the controller's database itself, as every RTE
// did up to 7.2. The socket modes do the same through the controller (socketJobIO in rte/socket/rte-socket.js).
//
// Loaded only in database mode : the database modules it imports need DB_* at import, which a
// socket-mode RTE does not have (rte/ansible-core.js imports none of them).
import path from "path";
import mysql from "../models/db.model.js";
import Job from "../models/job.model.js";
import JobEvent from "../models/jobEvent.model.js";
import Repository from "../models/repository.model.js";
import ansibleConfig from "../../config/ansible.config.js";
import { maskOutput } from "../lib/outputMask.js";

/**
 * The job's I/O in database mode.
 *
 * Every function takes the job's id first ; see rte/ansible-core.js for when each is called.
 */
const dbJobIO = {
  mode: "database",

  /**
   * The job as the RTE runs it : its form, its extravars and the order its output goes on from.
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<object|null>: { form, extravars (text), lastOrder }, null when it does not exist.
   */
  async load(jobId) {
    const rows = await mysql.do("SELECT form, extravars FROM AnsibleForms.`jobs` WHERE id=?", [jobId]);
    if (!rows?.length) return null;
    return { form: rows[0].form, extravars: rows[0].extravars, lastOrder: await Job.lastOrder(jobId) };
  },

  /**
   * Registers what the output must not show (the form's password fields, the credentials).
   *
   * Args:
   *   jobId (number): the job.
   *   what (object): { form, extravars, credentials } (Job.registerOutputSecrets).
   *
   * Returns:
   *   Promise<void>
   */
  registerOutputSecrets: (jobId, what) => Job.registerOutputSecrets(jobId, what),

  /**
   * The folder the playbook runs from : the playbooks repository, else ANSIBLE_PATH, plus the
   * form's sub path. A form naming its repository (playbookRepository) runs from its root.
   *
   * Args:
   *   jobId (number): the job.
   *   playbookSubPath (string): the form's playbookSubPath.
   *   playbookRepository (string): the form's playbookRepository, if any.
   *
   * Returns:
   *   Promise<string>: the folder.
   *
   * Raises:
   *   Error: the repository named is not one used for playbooks.
   */
  async playbookDirectory(jobId, playbookSubPath = "", playbookRepository = "") {
    const directory = playbookRepository
      ? await Repository.playbookRepositoryRoot(playbookRepository)
      : (await Repository.getAnsiblePath()) || ansibleConfig.path;
    return playbookSubPath ? path.join(directory, playbookSubPath) : directory;
  },

  /**
   * Where the inventories a form names are (lib/inventories.js).
   *
   * Returns:
   *   Promise<object[]>: [{ repository, root }].
   */
  inventoryRoots: () => Repository.getInventoryRoots(),

  /**
   * Stores an output row, masked (Job.createOutput).
   *
   * Args:
   *   jobId (number): the job.
   *   record (object): { output, output_type, job_id, order }.
   *
   * Returns:
   *   Promise<void>
   */
  async writeOutput(jobId, record) {
    await Job.createOutput(record);
  },

  /**
   * Stores structured events (the af_events callback plugin), masked.
   *
   * Args:
   *   jobId (number): the job.
   *   events (object[]): the events.
   *
   * Returns:
   *   Promise<void>
   */
  writeEvents: (jobId, events) => JobEvent.create(jobId, events),

  /**
   * Stores the log a playbook writes of its own (.joblogs/job_log_<id>.log), masked.
   *
   * Args:
   *   jobId (number): the job.
   *   content (string): the log.
   *
   * Returns:
   *   Promise<void>
   */
  async setJobLog(jobId, content) {
    await mysql.do("UPDATE AnsibleForms.`jobs` SET job_log=? WHERE id=?", [maskOutput(jobId, content), jobId]);
  },

  /**
   * The playbook's process started : its pid and this RTE, for an abort from anywhere.
   *
   * Args:
   *   jobId (number): the job.
   *   pid (number): the process.
   *   host (string): this RTE's name.
   *
   * Returns:
   *   Promise<void>
   */
  async started(jobId, pid, host) {
    await mysql.do("UPDATE AnsibleForms.`jobs` SET pid=?, host=? WHERE id=?", [pid, host, jobId]);
  },

  /**
   * The playbook's process is gone.
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<void>
   */
  async exited(jobId) {
    await mysql.do("UPDATE AnsibleForms.`jobs` SET pid=NULL, host=NULL WHERE id=?", [jobId]);
  },

  /**
   * Whether someone asked to abort the job (its flag in the database).
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<boolean>
   */
  isAbortRequested: (jobId) => Job.isAbortRequested(jobId),

  /**
   * Clears the abort flag once the abort is done.
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<void>
   */
  resetAbortRequested: (jobId) => Job.resetAbortRequested(jobId),

  /**
   * Ends the job : its status, its last line, its artifacts, and its notifications.
   *
   * Args:
   *   jobId (number): the job.
   *   order (number): the last line's order.
   *   stream (string): stdout or stderr.
   *   status (string): success, failed or aborted.
   *   message (string): the last line.
   *   artifacts (object): what set_stats gathered.
   *
   * Returns:
   *   Promise<void>
   */
  async end(jobId, order, stream, status, message, artifacts = {}) {
    await Job.endJobStatus(jobId, order, stream, status, message, artifacts);
  },
};

export default dbJobIO;
