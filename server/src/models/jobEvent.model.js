/******************************************************************/
/*                                                                */
/*  A playbook's structured events (job_events) : what the        */
/*  af_events callback plugin writes - a play starts, a task      */
/*  starts, a host's result, the recap - stored as they come and  */
/*  read back by the job page for its host-by-task grid, its      */
/*  timeline and its recap. Masked as the output : a result's     */
/*  message may hold a secret.                                    */
/*                                                                */
/******************************************************************/
import mysql from "./db.model.js";
import { maskOutput } from "../lib/outputMask.js";
import appConfig from "../../config/app.config.js";
import Helpers from "../lib/common.js";

// the event types the plugin writes ; anything else is not stored
// item : one item of a loop, a line of the output of its own (its status in data.status)
const TYPES = new Set(["play", "task", "ok", "changed", "failed", "skipped", "unreachable", "ignored", "stats", "item"]);

/**
 * Cuts a text to a column's length.
 *
 * Args:
 *   value (any): the value.
 *   max (number): the length.
 *
 * Returns:
 *   string|null: the text, or null for none.
 */
const cut = (value, max) => (value === undefined || value === null || value === "" ? null : String(value).slice(0, max));

// ---------------------------------------------------------------------------------------------
// What a stored result never keeps
// ---------------------------------------------------------------------------------------------

// the keys left out of a result, at any depth : the module's arguments as the task passed them (a
// password, a token, a request's body and headers)
const DROPPED_KEYS = new Set(["invocation"]);
// the keys whose values are masked, at any depth, besides the app's MASK_EXTRAVARS_REGEX : a
// request's own (authorization, cookie) and keys, as the af_events plugin masks them
const SECRET_KEYS = "password|passwd|secret|token|key|authorization|cookie|credential";
const MASK = "********";

/**
 * The pattern a secret's key matches : the app's MASK_EXTRAVARS_REGEX (live-editable, so read on
 * each call ; Helpers.safeRegExp caches it and falls back to the default when it does not compile)
 * and the built-in keys.
 *
 * Returns:
 *   RegExp: matched case-insensitively anywhere in a key.
 */
function secretKeyPattern() {
  const app = appConfig.maskExtravarsRegex || "password|secret|token";
  return Helpers.safeRegExp(`(?:${app})|(?:${SECRET_KEYS})`, SECRET_KEYS, "i", "MASK_EXTRAVARS_REGEX");
}

/**
 * Leaves out of a result what is never stored, recursively : its invocation (the module's
 * arguments), and the value of every key that looks like a secret, masked. The af_events plugin
 * does so itself ; done again here for an RTE of an older version, or one that does not.
 *
 * Args:
 *   value (any): a result or one of its values.
 *   pattern (RegExp): the secret keys' pattern (secretKeyPattern).
 *
 * Returns:
 *   any: a copy, its secrets masked and its invocations left out.
 */
export function redactResult(value, pattern = secretKeyPattern()) {
  if (Array.isArray(value)) return value.map((v) => redactResult(v, pattern));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROPPED_KEYS.has(k)) continue;
    // a secret's value masked whatever it is ; an empty one or a flag left as it is
    const empty = v === null || v === undefined || v === "" || typeof v === "boolean"
      || (Array.isArray(v) && !v.length) || (typeof v === "object" && v && !Array.isArray(v) && !Object.keys(v).length);
    out[k] = pattern.test(k) && !empty ? MASK : redactResult(v, pattern);
  }
  return out;
}

/**
 * A number, or null.
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   number|null
 */
const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);

const JobEvent = {
  /**
   * Stores events of a job. An event already stored (the same order, resent after a reconnect)
   * is left as it is.
   *
   * Args:
   *   jobId (number): the job.
   *   events (object[]): [{ order, type, play, task, host, duration, time, start, item, status,
   *     action, data, result }] : data the result's summary, result the whole of it.
   *
   * Returns:
   *   Promise<number>: the events stored.
   */
  async create(jobId, events) {
    const rows = [];
    const pattern = secretKeyPattern();
    for (const e of events || []) {
      if (!e || !TYPES.has(e.type) || !Number.isInteger(Number(e.order))) continue;
      // the summary : the result's fields, and what the row has no column for (its item, a loop
      // item's status, its module, when the host started)
      const extra = Object.fromEntries(
        [["item", e.item], ["status", e.status], ["action", e.action], ["start", num(e.start)]].filter(([, v]) => v !== undefined && v !== null),
      );
      const data = e.data === undefined && !Object.keys(extra).length ? null : JSON.stringify({ ...(e.data || {}), ...extra });
      // its whole result (an RTE's and AWX's, whatever the job's verbosity) : its invocation left out, its
      // secret keys masked, then masked as the output
      const result = e.result === undefined || e.result === null ? null : JSON.stringify(redactResult(e.result, pattern));
      rows.push([
        jobId,
        Number(e.order),
        e.type,
        cut(e.play, 500),
        cut(e.task, 500),
        cut(e.host, 250),
        num(e.duration),
        num(e.time),
        data === null ? null : maskOutput(jobId, data),
        result === null ? null : maskOutput(jobId, result),
      ]);
    }
    if (!rows.length) return 0;
    const res = await mysql.do(
      "INSERT IGNORE INTO AnsibleForms.`job_events` (job_id, `order`, type, play, task, host, duration, time, data, result) VALUES ?",
      [rows]
    );
    return res?.affectedRows || 0;
  },

  /**
   * The order of a job's last event : the next events stored go on from it (an AWX workflow's
   * nodes, each its own job with its own events, one after the other).
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<number>: the last order, 0 when the job has none.
   */
  async lastOrder(jobId) {
    const rows = await mysql.do("SELECT MAX(`order`) AS last FROM AnsibleForms.`job_events` WHERE job_id=?", [jobId]);
    return Number(rows?.[0]?.last) || 0;
  },

  /**
   * Removes a job's events : they are read again in full (an AWX job followed again after a
   * restart, as its output).
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<number>: the events removed.
   */
  async removeByJob(jobId) {
    const res = await mysql.do("DELETE FROM AnsibleForms.`job_events` WHERE job_id=?", [jobId]);
    return res?.affectedRows || 0;
  },

  /**
   * A job's events, in order.
   *
   * Args:
   *   jobId (number): the job.
   *
   * Returns:
   *   Promise<object[]>: [{ order, type, play, task, host, duration, time, data }], data parsed.
   */
  async findByJob(jobId) {
    const rows = await mysql.do(
      "SELECT `order`, type, play, task, host, duration, time, data, (result IS NOT NULL) AS detailed FROM AnsibleForms.`job_events` WHERE job_id=? ORDER BY `order`",
      [jobId]
    );
    return (rows || []).map((r) => {
      let data = null;
      if (r.data) {
        try {
          data = JSON.parse(r.data);
        } catch {
          data = { msg: r.data };
        }
      }
      return {
        order: r.order,
        type: r.type,
        play: r.play,
        task: r.task,
        host: r.host,
        duration: r.duration === null ? null : Number(r.duration),
        time: r.time === null ? null : Number(r.time),
        data,
        // whether its details hold a whole result (read with findOne)
        detailed: !!r.detailed,
      };
    });
  },

  /**
   * One event of a job, with its whole result : a host's or a loop item's details.
   *
   * Args:
   *   jobId (number): the job.
   *   order (number): the event's place among the job's events.
   *
   * Returns:
   *   Promise<object|null>: the event as findByJob gives it, with result (parsed), or null.
   */
  async findOne(jobId, order) {
    const rows = await mysql.do(
      "SELECT `order`, type, play, task, host, duration, time, data, result FROM AnsibleForms.`job_events` WHERE job_id=? AND `order`=?",
      [jobId, order]
    );
    const r = rows?.[0];
    if (!r) return null;
    const parse = (text, fallback) => {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return fallback(text);
      }
    };
    // the task it belongs to : its module (the task event's action), when results have none
    const task = await mysql.do(
      "SELECT data FROM AnsibleForms.`job_events` WHERE job_id=? AND type='task' AND `order`<? ORDER BY `order` DESC LIMIT 1",
      [jobId, order]
    );
    return {
      order: r.order,
      type: r.type,
      play: r.play,
      task: r.task,
      host: r.host,
      duration: r.duration === null ? null : Number(r.duration),
      time: r.time === null ? null : Number(r.time),
      data: parse(r.data, (text) => ({ msg: text })),
      result: parse(r.result, (text) => ({ msg: text })),
      taskData: parse(task?.[0]?.data, () => null),
    };
  },
};

export default JobEvent;
