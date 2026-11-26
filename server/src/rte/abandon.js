// A job an RTE can no longer finish ends as abandoned : the RTE restarted while it ran (its own
// start in database mode, rte/server.js), came back without it (runners/rteHub.js abandonLost),
// or said so itself (an abandon item, rteHub.js storeItem). One statement for all of them, so
// they leave the job alike : abandoned, its abort answered, no process and no RTE on it.
//
// A database module : the controller and a database-mode RTE load it, never a socket-mode RTE.
import mysql from "../models/db.model.js";

/**
 * Ends running jobs as abandoned : one job (id), or every job an RTE holds (host), or both.
 *
 * Args:
 *   where (object): { id : the job, host : the RTE's node id (jobs.host), runner : the runner
 *     the job runs on } ; at least id or host.
 *
 * Returns:
 *   Promise<number>: the jobs abandoned (0 when they had ended already).
 *
 * Raises:
 *   Error: neither id nor host given (it would abandon every running job).
 */
export async function abandonJobs({ id, host, runner } = {}) {
  if (id == null && !host) throw new Error("abandonJobs needs a job id or a runner's host");
  // step 1 : only running jobs, narrowed by what was given
  const where = ["status='running'"];
  const params = [];
  if (id != null) {
    where.push("id=?");
    params.push(id);
  }
  if (host) {
    where.push("host=?");
    params.push(host);
  }
  if (runner) {
    where.push("runner=?");
    params.push(runner);
  }
  // step 2 : abandoned, the abort flag answered, the process and the RTE let go
  const res = await mysql.do(
    "UPDATE AnsibleForms.`jobs` SET status='abandoned', abort_requested=0, host=NULL, pid=NULL WHERE " + where.join(" AND "),
    params
  );
  return res?.changedRows || 0;
}

export default { abandonJobs };
