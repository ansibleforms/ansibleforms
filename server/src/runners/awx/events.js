/******************************************************************/
/*                                                                */
/*  A job's structured events, read from AWX (and AAP, Ascender : */
/*  the same API) while the app follows the job : AWX's job       */
/*  events (/jobs/<id>/job_events/) turned into the events the    */
/*  af_events callback plugin writes on an RTE (a play starts, a  */
/*  task starts, a host's result, a loop's item, the recap), and  */
/*  stored in job_events as the RTE's are. The job page's Hosts   */
/*  and tasks panel, its recap and its clickable result lines     */
/*  then work for a job run on AWX as for one run on an RTE.      */
/*                                                                */
/*  Reading them never fails nor holds up the job : a read that   */
/*  fails is logged, and the job goes on.                         */
/*                                                                */
/******************************************************************/
import logger from "../../lib/logger.js";
import JobEvent, { redactResult } from "../../models/jobEvent.model.js";

// ---------------------------------------------------------------------------------------------
// What af_events.py keeps of a result : the same fields and the same caps
// ---------------------------------------------------------------------------------------------

// the fields of a result kept on its event : enough to say what happened, never the whole return
const RESULT_FIELDS = ["msg", "rc", "stderr", "changed", "skip_reason", "failed_when_result", "attempts"];
// a text field cut at this length : the full text is in the output
const MAX_TEXT = 2000;
// the whole result, as a task's details show it : at most this many characters of JSON ; past
// it, its long texts and lists are cut
const MAX_RESULT = 65536;
const MAX_RESULT_TEXT = 8000;
const MAX_RESULT_ITEMS = 200;

// ---------------------------------------------------------------------------------------------
// How they are read
// ---------------------------------------------------------------------------------------------

// AWX's events asked for at once (its largest page)
export const PAGE_SIZE = 200;
// while the job runs : a read at most this often, and at most this many pages each time (the
// next read goes on from there) ; the read when the job has ended takes all that is left
const POLL_MS = 3000;
const POLL_PAGES = 10;
// AWX stores a running job's events slightly out of order : a counter missing in the middle
// may still come. A read stops before it, and only goes past it after this long
const GAP_WAIT_MS = 10000;
// the events stored at once at most, in characters of JSON (a host's whole result is up to
// 64 KB) : as the RTE sends them (rte/events.js)
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
// AWX reports a job as ended before it has saved all its events (and the output it assembles
// from them) : the last ones can come a second or more later. The final read waits until the
// job says so (its event_processing_finished), asking at most every pollMs and at most waitMs
// in all ; past that, what AWX has saved is read. Kept in an object : a test shortens them
export const EVENT_PROCESSING_WAIT = { waitMs: 60000, pollMs: 1000 };

/**
 * A value as JSON the way Python's json.dumps writes it (", " and ": " between the parts, non
 * ASCII kept as it is) : a loop's item the af_events plugin stores reads the same.
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   string: its JSON.
 */
export function pyJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`)
      .join(", ")}}`;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/**
 * Cuts a long text, leaves anything else as it is (af_events.py _short).
 *
 * Args:
 *   value (any): a field's value.
 *
 * Returns:
 *   any: the value, a text cut at MAX_TEXT characters.
 */
function short(value) {
  return typeof value === "string" && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + "..." : value;
}

/**
 * Cuts a result's long texts and lists, recursively (af_events.py _trim).
 *
 * Args:
 *   value (any): a result or one of its values.
 *
 * Returns:
 *   any: the value, its texts at most MAX_RESULT_TEXT characters and its lists MAX_RESULT_ITEMS long.
 */
function trim(value) {
  if (typeof value === "string") return value.length <= MAX_RESULT_TEXT ? value : value.slice(0, MAX_RESULT_TEXT) + "...";
  if (Array.isArray(value)) {
    const cut = value.slice(0, MAX_RESULT_ITEMS).map(trim);
    if (value.length > MAX_RESULT_ITEMS) cut.push(`... ${value.length - MAX_RESULT_ITEMS} more`);
    return cut;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
  return value;
}

/**
 * A host's whole result, as its details show it (af_events.py _full) : Ansible's own keys
 * (_ansible_*) and its invocation left out, the values of its secret keys masked, cut when its
 * JSON is longer than MAX_RESULT. Kept only when the job runs verbose : else null, its summary
 * alone is stored. A task with no_log has its result censored by Ansible before AWX gets it.
 *
 * Args:
 *   res (object): the result (AWX's event_data.res).
 *   full (boolean): the job runs verbose.
 *
 * Returns:
 *   object|null: the result to keep, or null.
 */
function fullResult(res, full) {
  if (!full) return null;
  const own = Object.fromEntries(Object.entries(res || {}).filter(([k]) => !k.startsWith("_ansible")));
  let kept = redactResult(own);
  if (!Object.keys(kept).length) return null;
  if (pyJson(kept).length > MAX_RESULT) {
    kept = trim(kept);
    if (pyJson(kept).length > MAX_RESULT) kept = { msg: "The result is too large to keep", keys: Object.keys(kept).sort() };
  }
  return kept;
}

/**
 * A time as unix seconds, to the millisecond : AWX's times are ISO texts, a time without its
 * zone is UTC (ansible-runner's older events).
 *
 * Args:
 *   value (string): the time.
 *
 * Returns:
 *   number|null: the seconds, or null for none.
 */
function seconds(value) {
  if (!value || typeof value !== "string") return null;
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? Math.round(ms) / 1000 : null;
}

/**
 * A number rounded to the millisecond, as af_events.py rounds its times.
 *
 * Args:
 *   value (any): the number.
 *
 * Returns:
 *   number|null
 */
const round3 = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

/**
 * The name a head line of the output gives (PLAY [name], TASK [role : name], RUNNING HANDLER
 * [name]) : the job's output pairs its lines with the events by it, so the name is the one the
 * output shows, a role's task with its role.
 *
 * Args:
 *   stdout (string): the event's text (AWX's event stdout).
 *   heads (string): the words before the name, as a pattern (PLAY, TASK|RUNNING HANDLER).
 *
 * Returns:
 *   string|null: the name, or null when the text has no such line.
 */
function headName(stdout, heads) {
  // eslint-disable-next-line no-control-regex
  const text = String(stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
  const m = new RegExp(`^(?:${heads}) \\[(.*)\\]\\s*\\**\\s*$`, "m").exec(text);
  return m ? m[1].trim() : null;
}

/**
 * A skipped host's result, as its line of the output shows it (skipping: [host] => {...}) : AWX's
 * event of a skipped host carries no result of its own (ansible-runner leaves it out), its text
 * does when the job runs verbose.
 *
 * Args:
 *   stdout (string): the event's text.
 *
 * Returns:
 *   object: the result, {} when the text has none (or it is cut, as AWX cuts a long one).
 */
function stdoutResult(stdout) {
  // eslint-disable-next-line no-control-regex
  const text = String(stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
  const m = /=>\s*(\{[\s\S]*\})\s*$/.exec(text);
  if (!m) return {};
  try {
    const value = JSON.parse(m[1]);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The events (as the af_events plugin writes them) an AWX job event gives : none, one, or two
 * (a failure the task ignores is followed by an ignored event).
 *
 * Args:
 *   ev (object): AWX's job event ({ counter, event, event_data, stdout, created, ... }).
 *   state (object): the play and the task the events so far are in ({ play, task }), carried
 *     from one call to the next.
 *   full (boolean): the job runs verbose : a host's whole result is kept.
 *
 * Returns:
 *   object[]: the events, without their order.
 */
export function mapAwxEvent(ev, state, full = false) {
  const kind = ev?.event;
  const raw = ev?.event_data || {};
  // a skipped host's result : from its text, AWX's event has none
  const ed = kind === "runner_on_skipped" && !raw.res ? { ...raw, res: stdoutResult(ev.stdout) } : raw;
  const time = seconds(ed.end) ?? seconds(ev?.created);
  // an event as _emit writes it : what it is, when, where, then its own fields (none left empty)
  const emit = (type, fields = {}) => {
    const out = { type, time, play: state.play, task: state.task };
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined) out[k] = v;
    return out;
  };
  // a result's or a loop item's fields (af_events.py _fields)
  const fields = () => {
    const res = ed.res && typeof ed.res === "object" ? ed.res : {};
    const data = Object.fromEntries(RESULT_FIELDS.filter((k) => k in res).map((k) => [k, short(res[k])]));
    let item = "item" in res ? res.item : null;
    if (item !== null && item !== undefined && !["string", "number", "boolean"].includes(typeof item)) item = pyJson(redactResult(item));
    return {
      item: item === null || item === undefined ? null : short(item),
      data: Object.keys(data).length ? data : null,
      action: ed.task_action || null,
      result: fullResult(res, full),
    };
  };
  const host = ed.host || ev?.host_name || null;
  const res = ed.res && typeof ed.res === "object" ? ed.res : {};
  // a host's result : how long it took, from when it started
  const result = (type) => {
    const start = seconds(ed.start);
    return emit(type, { host, duration: round3(ed.duration), start: round3(start), ...fields() });
  };
  const item = (status) => emit("item", { host, status, ...fields() });
  switch (kind) {
    case "playbook_on_play_start":
      state.play = headName(ev.stdout, "PLAY") ?? String(ed.name || ed.play || ev.play || "").trim();
      state.task = "";
      return [emit("play")];
    case "playbook_on_task_start":
    case "playbook_on_handler_task_start": {
      // AWX's own name has no role : the output's head line has, else event_data.name
      const bare = String(ed.task || ev.task || "").trim();
      state.task = headName(ev.stdout, "TASK|RUNNING HANDLER") ?? String(ed.name || (ed.role ? `${ed.role} : ${bare}` : bare)).trim();
      return [emit("task", { action: ed.task_action || null })];
    }
    case "runner_on_ok":
      return [result(res.changed ? "changed" : "ok")];
    case "runner_on_failed": {
      const out = [result("failed")];
      if (ed.ignore_errors) out.push(emit("ignored", { host }));
      return out;
    }
    case "runner_on_skipped":
      return [result("skipped")];
    case "runner_on_unreachable":
      return [result("unreachable")];
    case "runner_item_on_ok":
      return [item(res.changed ? "changed" : "ok")];
    case "runner_item_on_failed":
      return [item("failed")];
    case "runner_item_on_skipped":
      return [item("skipped")];
    case "playbook_on_stats": {
      // per host, as the recap counts : AWX names unreachable dark
      const count = (key, h) => Number(ed[key]?.[h]) || 0;
      const names = Object.keys(ed.processed || {}).length
        ? Object.keys(ed.processed)
        : [...new Set(["ok", "changed", "dark", "failures", "skipped", "rescued", "ignored"].flatMap((k) => Object.keys(ed[k] || {})))];
      const hosts = {};
      for (const h of names.sort()) {
        hosts[h] = {
          ok: count("ok", h),
          changed: count("changed", h),
          unreachable: count("dark", h),
          failures: count("failures", h),
          skipped: count("skipped", h),
          rescued: count("rescued", h),
          ignored: count("ignored", h),
        };
      }
      state.task = "";
      return [emit("stats", { data: hosts })];
    }
    default:
      // the others (verbose lines, a host starting a task, an include, a notify...) : the
      // af_events plugin writes none of them
      return [];
  }
}

/**
 * Follows a job's events on AWX and stores them. poll() reads the new ones while the job runs,
 * at most every POLL_MS and in the background (the job is never held up by it) ; finish() reads
 * what is left once the job has ended. A read that fails is logged and the job goes on : the
 * next read starts where the last one stopped.
 *
 * The events are read by AWX's counter, in order, from the first one after the last read : none
 * is stored twice. While the job runs, a read stops before a counter that is missing (AWX stores
 * the events slightly out of order), and only goes past it after GAP_WAIT_MS.
 *
 * Args:
 *   jobid (number): the job (its events, masked as its output : JobEvent.create).
 *   fetchPage (function): (afterCounter, pageSize) => Promise<{ results, next }> : AWX's events
 *     after that counter, in order (Awx.getJobEvents).
 *   full (boolean): the job runs verbose : a host's whole result is kept (as on an RTE).
 *   startOrder (number): the order the stored events go on from (0 for a job of its own).
 *
 * Returns:
 *   {poll: function, finish: function, stop: function, full: boolean}: full may be set later
 *     (the job's verbosity, once known).
 */
export function createAwxEventReader({ jobid, fetchPage, full = false, startOrder = 0 }) {
  const state = { play: "", task: "" };
  let lastCounter = 0;
  let order = Number(startOrder) || 0;
  let running = null;
  let lastRead = 0;
  let gapSince = 0;
  let stopped = false;
  let warned = false;
  const reader = { full };

  /**
   * Stores events, in batches of at most MAX_BATCH_BYTES.
   *
   * Args:
   *   list (object[]): the events, in order, without their order.
   */
  async function store(list) {
    let batch = [];
    let bytes = 0;
    for (const e of list) {
      const event = { ...e, order: ++order };
      const size = JSON.stringify(event).length;
      if (batch.length && bytes + size > MAX_BATCH_BYTES) {
        await JobEvent.create(jobid, batch);
        batch = [];
        bytes = 0;
      }
      batch.push(event);
      bytes += size;
    }
    if (batch.length) await JobEvent.create(jobid, batch);
  }

  /**
   * Reads the events after the last one read, and stores them.
   *
   * Args:
   *   final (boolean): the job has ended : every event left, past any gap.
   */
  async function read(final) {
    for (let pages = 0; final || pages < POLL_PAGES; pages++) {
      const page = await fetchPage(lastCounter, PAGE_SIZE);
      const results = (Array.isArray(page?.results) ? page.results : [])
        .filter((e) => Number(e?.counter) > lastCounter)
        .sort((a, b) => Number(a.counter) - Number(b.counter));
      const mapped = [];
      let blocked = false;
      for (const ev of results) {
        const counter = Number(ev.counter);
        if (!final && counter !== lastCounter + 1) {
          // a counter missing : it may still come, the read waits for it a while
          gapSince ||= Date.now();
          if (Date.now() - gapSince < GAP_WAIT_MS) {
            blocked = true;
            break;
          }
        }
        gapSince = 0;
        lastCounter = counter;
        mapped.push(...mapAwxEvent(ev, state, reader.full));
      }
      // stopped meanwhile (another node follows the job now) : nothing more is stored
      if (stopped) return;
      await store(mapped);
      if (blocked || !page?.next || !results.length) return;
    }
  }

  /**
   * A read, its failure logged : never thrown.
   *
   * Args:
   *   final (boolean): the job has ended.
   */
  async function safeRead(final) {
    try {
      await read(final);
    } catch (e) {
      const message = `Job ${jobid}: the job's events could not be read from AWX (${e?.message || e}) ; the job goes on without them`;
      // once as a warning, then quietly : the job is polled every second
      if (warned) logger.debug(message);
      else logger.warning(message);
      warned = true;
    }
  }

  /**
   * Reads the new events in the background, when the last read is done and old enough.
   */
  reader.poll = function () {
    if (stopped || running || Date.now() - lastRead < POLL_MS) return;
    lastRead = Date.now();
    running = safeRead(false).finally(() => {
      running = null;
    });
  };

  /**
   * Reads what is left, once the job has ended : the read under way first.
   *
   * Returns:
   *   Promise<void>: never rejected.
   */
  reader.finish = async function () {
    if (stopped) return;
    if (running) await running;
    await safeRead(true);
  };

  /**
   * Stops : nothing more is read nor stored (the job is followed elsewhere, or contact is lost).
   */
  reader.stop = function () {
    stopped = true;
  };

  return reader;
}

/**
 * Waits until AWX has saved all of an ended job's events (its event_processing_finished is
 * true), so the final read of its events and its output finds them all : AWX reports a job as
 * ended a moment before it has saved its last events. The job is asked for again every
 * EVENT_PROCESSING_WAIT.pollMs, for at most EVENT_PROCESSING_WAIT.waitMs ; past that (or when
 * AWX stops answering), a warning is logged once and the job as last read is returned : what
 * AWX has saved is read. A job that does not say (an older or another API, the field absent)
 * is returned at once, as before.
 *
 * Args:
 *   jobid (number): the job in AnsibleForms (the warning names it).
 *   job (object): the AWX job, as last read.
 *   fetchJob (function): () => Promise<object> : the AWX job, read again.
 *
 * Returns:
 *   Promise<{job: object, waited: boolean}>: the AWX job as last read, and whether it was read
 *     again (anything read before from it, its output, may lack its end then). Never rejected.
 */
export async function waitForEventProcessing({ jobid, job, fetchJob }) {
  // step 1 : nothing to wait for, the job does not say or has all its events saved
  if (typeof job?.event_processing_finished !== "boolean" || job.event_processing_finished) return { job, waited: false };
  // step 2 : ask again, until it says so or the time is up
  const { waitMs, pollMs } = EVENT_PROCESSING_WAIT;
  const deadline = Date.now() + waitMs;
  let last = job;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      const again = await fetchJob();
      if (again && typeof again === "object") last = again;
      if (last.event_processing_finished !== false) return { job: last, waited: true };
    }
    // step 3 : the time is up, read what there is
    logger.warning(
      `Job ${jobid}: AWX job ${job.id} was still saving its events after ${waitMs / 1000}s (event_processing_finished is false) ; its events and output are read as they are`,
    );
  } catch (e) {
    logger.warning(`Job ${jobid}: AWX job ${job.id} could not be read again while saving its events (${e?.message || e}) ; its events and output are read as they are`);
  }
  return { job: last, waited: true };
}

/**
 * Whether an AWX job runs verbose (its verbosity, 1 and up) : a host's whole result is kept on
 * its events then, as an RTE keeps it for a playbook run with -v.
 *
 * Args:
 *   job (object): the AWX job.
 *
 * Returns:
 *   boolean
 */
export function runsVerbose(job) {
  return Number(job?.verbosity) > 0;
}

export default { mapAwxEvent, createAwxEventReader, waitForEventProcessing, runsVerbose, pyJson, PAGE_SIZE };
