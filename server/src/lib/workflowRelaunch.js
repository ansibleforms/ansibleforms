/******************************************************************/
/*                                                                */
/*  A workflow job relaunched from its failed node (POST          */
/*  /api/v2/job/:id/relaunch with fromFailedNode) : the nodes     */
/*  that succeeded are carried over - they run no job, and pass   */
/*  on what they passed on then (their set_stats artifacts) - and */
/*  the others run again, from the failed one(s), by the usual    */
/*  rules (lib/workflowDefs.js nextStep).                         */
/*                                                                */
/*  As Ascender does it (its create_relaunch_workflow_job) : a    */
/*  node is carried when it succeeded, or when it was carried in  */
/*  the run before. Only while the workflow is the same : the     */
/*  job keeps the hash of the workflow it ran (jobs.workflow_hash)*/
/*  and a relaunch compares it with the workflow as it is now.    */
/*                                                                */
/******************************************************************/
import { sha256 } from "./formEngine/node/hash.js";

// the statuses of a node that failed the run (a node rejected or timed out is failed too)
const FAILED = new Set(["failed", "error", "canceled"]);

/**
 * The hash of a workflow, as a job keeps it : of the workflow as it is read (workflowsOf), its
 * keys in a stable order - a change to a node, a link, its extra vars or its name changes it.
 *
 * Args:
 *   workflow (object): the workflow (lib/workflowDefs.js workflowsOf).
 *
 * Returns:
 *   string: sha256:<hex>.
 */
export function workflowHash(workflow) {
  return sha256(workflow || {});
}

/**
 * A stored node's artifacts, parsed.
 *
 * Args:
 *   value (any): the column's value (JSON text) or an object.
 *
 * Returns:
 *   object: the artifacts, {} when none or not a map.
 */
function artifactsOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The nodes a relaunch from the failed node carries over : the ones that succeeded in the run
 * relaunched (or were carried in it already), each as the new run starts it.
 *
 * Args:
 *   rows (object[]): the run's nodes (workflow_node_runs : node, status, elapsed, node_job_id,
 *     carried, artifacts).
 *
 * Returns:
 *   Map: identifier -> { status: 'successful', elapsed, artifacts, job (the job that ran it) }.
 */
export function carriedNodes(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r?.node || r.status !== "successful") continue;
    out.set(String(r.node), {
      status: "successful",
      elapsed: Number(r.elapsed) || 0,
      artifacts: artifactsOf(r.artifacts),
      job: r.node_job_id ? Number(r.node_job_id) : null,
    });
  }
  return out;
}

/**
 * Whether a workflow job can be relaunched from its failed node, and why not : it failed, it
 * kept its nodes (a job from before 7.7.0 did not), one of them failed and one succeeded (else
 * it is a full relaunch), and the workflow is the one it ran.
 *
 * Args:
 *   facts (object): { status (the job's), rows (its nodes, workflow_node_runs), hashThen (the
 *     hash it kept), hashNow (the workflow's now, workflowHash ; null when it cannot be read) }.
 *
 * Returns:
 *   object: { ok (boolean), reason ('' ; or not_failed, no_nodes, no_failed_node,
 *     nothing_carried, changed) }.
 */
export function fromFailedNodeCheck({ status, rows, hashThen, hashNow }) {
  if (status !== "failed") return { ok: false, reason: "not_failed" };
  if (!Array.isArray(rows) || !rows.length || !hashThen) return { ok: false, reason: "no_nodes" };
  if (!rows.some((r) => FAILED.has(r.status))) return { ok: false, reason: "no_failed_node" };
  if (!carriedNodes(rows).size) return { ok: false, reason: "nothing_carried" };
  if (!hashNow || hashNow !== hashThen) return { ok: false, reason: "changed" };
  return { ok: true, reason: "" };
}

export default { workflowHash, carriedNodes, fromFailedNodeCheck };
