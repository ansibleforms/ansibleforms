/******************************************************************/
/*  A job that ends needing attention : the playbook finished as  */
/*  designed, but an operator still has to follow it up.          */
/*                                                                */
/*  A playbook says so in one of two ways, both read here :       */
/*   - a file next to it, .joblogs/job_status_<jobid>.yml (.yaml) */
/*     (the local runner and an RTE : they run in its folder)     */
/*   - set_stats with the key af_job_status (any runner that      */
/*     returns the artifacts : the local one, an RTE, AWX/AAP)    */
/*  with { status: attention, message: ..., detail: ... }.        */
/*                                                                */
/*  The RTE reads the file and hands it on as that artifact, so   */
/*  the controller decides in one place (Job.endJobStatus) and    */
/*  the RTE contract stays the same. It only ever turns a job     */
/*  that succeeded into a job with status 'warning' : a failed    */
/*  or aborted job stays what it is.                              */
/*                                                                */
/*  No database import : the RTE loads this module too.           */
/******************************************************************/
import fs from "fs";
import path from "path";
import YAML from "yaml";

// the artifact key, and the file's name
export const ATTENTION_KEY = "af_job_status";
const FILE_NAMES = (jobid) => [`job_status_${jobid}.yml`, `job_status_${jobid}.yaml`];

// what a playbook may ask for : attention (warning is its synonym), or success (nothing changes)
const ATTENTION_WORDS = new Set(["attention", "warning"]);
const SUCCESS_WORDS = new Set(["success", "ok"]);

// the message is shown in the jobs list : one line, a reasonable length
export const MESSAGE_MAX = 1000;
// the detail is stored as JSON : beyond this it is dropped (a playbook dumping a whole inventory)
export const DETAIL_MAX = 256 * 1024;

/**
 * Reads and removes a job's status file, .joblogs/job_status_<jobid>.yml (or .yaml), next to
 * the playbook.
 *
 * Args:
 *   directory (string): the folder the playbook ran from.
 *   jobid (number): the job.
 *
 * Returns:
 *   object: { value } the parsed file, { error } when it could not be read, or null when there is none.
 */
export function takeStatusFile(directory, jobid) {
  if (!directory) return null;
  let found = null;
  for (const name of FILE_NAMES(jobid)) {
    const file = path.join(directory, ".joblogs", name);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") found = found || { error: `${name}: ${e.message}` };
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // gone already
    }
    if (found) continue;
    try {
      found = { value: YAML.parse(text) };
    } catch (e) {
      found = { error: `${name}: ${e.message}` };
    }
  }
  return found;
}

/**
 * What a playbook asked for, from the artifacts of a job that ended.
 *
 * Args:
 *   artifacts (object): the job's artifacts (set_stats, plus the status file the RTE added).
 *
 * Returns:
 *   object|null: { attention: true, message, detail } to end the job as 'warning',
 *   { attention: false } when it asked for success, { error } when what it gave is not valid,
 *   null when it asked for nothing.
 */
export function attentionFromArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== "object" || !(ATTENTION_KEY in artifacts)) return null;
  const value = artifacts[ATTENTION_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: `${ATTENTION_KEY} must be an object with status and message` };
  }
  const word = String(value.status ?? "").trim().toLowerCase();
  if (SUCCESS_WORDS.has(word)) return { attention: false };
  if (!ATTENTION_WORDS.has(word)) {
    return { error: `${ATTENTION_KEY}.status must be attention or success, not '${value.status ?? ""}'` };
  }
  const raw = value.message == null ? "" : typeof value.message === "string" ? value.message : JSON.stringify(value.message);
  // folded YAML (>) ends with a newline : one trimmed line
  const message = raw.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
  if (!message) return { error: `${ATTENTION_KEY}.message is required` };
  let detail = null;
  if (value.detail !== undefined && value.detail !== null) {
    const json = JSON.stringify(value.detail);
    if (json.length <= DETAIL_MAX) detail = value.detail;
  }
  return { attention: true, message, detail, detailDropped: value.detail != null && detail === null };
}

/**
 * The artifacts as stored on the job : without the status, which has columns of its own.
 *
 * Args:
 *   artifacts (object): the job's artifacts.
 *
 * Returns:
 *   object: the same, without af_job_status.
 */
export function withoutAttention(artifacts) {
  if (!artifacts || typeof artifacts !== "object" || !(ATTENTION_KEY in artifacts)) return artifacts;
  const rest = { ...artifacts };
  delete rest[ATTENTION_KEY];
  return rest;
}
