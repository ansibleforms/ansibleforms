'use strict';
// The runner hub's own loops on this node (lib/systemTasks.js HUB_LOOPS : dispatch every 2 seconds,
// inbound dial every 10, ended jobs prune every 60 by default), their timers and what they did, for
// Jobs > System.
//
// Each loop's timer runs it every so many seconds, its setting's (RUNNER_DISPATCH_SECONDS and the
// like, lib/systemTasks.js loopSeconds) : the hub starts them (startLoops), and a setting changed
// re-arms its loop's timer at once (rearmLoop, from lib/envSettings.js applyLive, on the node that
// saved it and on every other through the env change notice), the old timer cleared, the new one at
// the new pace from now.
//
// A loop runs far too often for a row a run : what it did is kept here, in memory, per node -
// its runs and failures since this process started, its last success, and its last error with
// its time - and the API (models/systemTask.model.js) answers it with the node's name.
//
// Its Runs tab lists three kinds of rows of system_task_runs, each with the node that wrote it :
//   - an hourly summary : every hour, at the top of the clock's hour, the node whose hub runs
//     writes a row per loop of the passes of that hour ("1,800 passes, 0 failed" ; failed when
//     one of them failed), started_at the window's start (the hour's, or the hub's start for the
//     first one), ended_at its end ; then the hour's counts start again from nothing. No row for
//     an hour without a pass (the hub stopped). Its own timer (SUMMARY_EVERY_MS), apart from the
//     loops' : a loop's seconds changed (rearmLoop) leave it as it is, stopLoops clears it. A
//     row that cannot be written is logged once a window, never thrown into the loop ;
//   - a Run now pass : its own row, success ("Run now: done") or failed (the error) ;
//   - a timed pass's failure, said as the loops never said one above debug before : a warning in
//     the log once per distinct error of a loop (the same error every 2 seconds would fill it),
//     and a failed row once a minute at most per distinct error of a loop.
//
// Run now (POST /api/v2/system/tasks/:key/run) runs one pass of a loop at once on the node that
// received it (runLoopNow), through the same pass as its timer : counted (in the hour's summary
// too), its failure warned of as a timed one's but written once, as its own row. Never while a
// pass of that loop goes, nor on a node whose hub does not run.
import logger from './logger.js';
import { nodeId } from './role.js';
import { HUB_LOOPS, hubLoop, recordRun, loopSeconds } from './systemTasks.js';

// one row per distinct error of a loop this often at most
export const FAILURE_ROW_EVERY_MS = 60 * 1000;
// the distinct errors kept per loop, to warn once and throttle the rows : the oldest go
const ERRORS_KEPT = 100;
// the longest error kept
const ERROR_MAX = 1000;
// a loop's summary row this often : at the top of each hour of the clock
export const SUMMARY_EVERY_MS = 60 * 60 * 1000;
// a Run now pass's result when it succeeded
export const RUN_NOW_DONE = 'Run now: done';

/**
 * A loop's state, empty : started now, no run yet.
 *
 * Returns:
 *   object: { since, runs, failures, lastRunAt, lastOutcome, lastSuccessAt, lastError, active,
 *     warned, recorded, hourFrom, hourPasses, hourFailures }.
 */
function emptyState() {
  const now = new Date();
  return {
    since: now,
    runs: 0,
    failures: 0,
    lastRunAt: null,
    lastOutcome: null,
    lastSuccessAt: null,
    lastError: null,
    // the passes of the loop going now (a slow one may still go at the next tick)
    active: 0,
    // the errors warned of : message -> true (once each)
    warned: new Map(),
    // when each error was last written as a row : message -> ms
    recorded: new Map(),
    // the window of its next summary row : since when, its passes ended and the failed ones
    hourFrom: now,
    hourPasses: 0,
    hourFailures: 0,
  };
}

// each loop's state, by its key
const states = new Map(HUB_LOOPS.map((loop) => [loop.key, emptyState()]));
// whether the hub runs its loops on this node (runners/rteHub.js startRteHub) : a node that
// serves no runner sockets has none running
let started = false;
// each loop's work, by its key, as the hub's timers run it : Run now runs the same
let works = new Map();
// each loop's timer on this node, by its key : { timer, seconds, armedAt }
const timers = new Map();
// the summary rows' timer on this node (null : none, the hub does not run here)
let summaryTimer = null;

/**
 * Marks the loops as running on this node : the hub started them (startRteHub), with the work
 * of each, which Run now runs too.
 *
 * Args:
 *   fns (object): each loop's work by its key ({ runnerDispatch: dispatch, ... }), async.
 */
export function markLoopsStarted(fns = {}) {
  works = new Map(Object.entries(fns));
  started = true;
}

/**
 * Arms a loop's timer, at the seconds its setting says now (loopSeconds) : the timer it had is
 * cleared first, so the loop runs at the new pace from now on, never at both.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   object|null: its timer ({ timer, seconds, armedAt }), or null when the hub does not run its
 *     loops on this node or the loop has no work.
 */
function armLoop(key) {
  const fn = works.get(key);
  if (!started || !fn) return null;
  clearInterval(timers.get(key)?.timer);
  const seconds = loopSeconds(key);
  const timer = setInterval(() => loopRun(key, fn), seconds * 1000);
  // a loop's timer never keeps the process alive
  timer.unref?.();
  const armed = { timer, seconds, armedAt: new Date() };
  timers.set(key, armed);
  return armed;
}

/**
 * Starts the hub's loops on this node (runners/rteHub.js startRteHub) : each one's work kept for
 * Run now, and its timer armed at its setting's seconds.
 *
 * Args:
 *   fns (object): each loop's work by its key ({ runnerDispatch: dispatch, ... }), async.
 */
export function startLoops(fns = {}) {
  markLoopsStarted(fns);
  // the first summary window starts now, the hub's start
  const now = new Date();
  for (const loop of HUB_LOOPS) {
    const state = states.get(loop.key);
    state.hourFrom = now;
    state.hourPasses = 0;
    state.hourFailures = 0;
    armLoop(loop.key);
  }
  armSummary();
}

/**
 * Stops the hub's loops on this node : every timer cleared, the summary rows' too (the process
 * stops).
 */
export function stopLoops() {
  for (const { timer } of timers.values()) clearInterval(timer);
  timers.clear();
  clearTimeout(summaryTimer);
  summaryTimer = null;
  started = false;
}

// ─── the hourly summary ──────────────────────────────────────────────────────

/**
 * A summary row's result : its passes and the failed ones, counted in en-US ("1,800 passes,
 * 0 failed").
 *
 * Args:
 *   passes (number): the passes of the window.
 *   failures (number): the failed ones.
 *
 * Returns:
 *   string: the result.
 */
export function summaryText(passes, failures) {
  const n = (x) => x.toLocaleString('en-US');
  return `${n(passes)} ${passes === 1 ? 'pass' : 'passes'}, ${n(failures)} failed`;
}

/**
 * Arms the summary rows' timer : once, at the next top of the clock's hour, it writes them
 * (writeSummaries) then arms itself again. Its own timer, never the loops' : a loop armed again
 * (rearmLoop) leaves it as it is. Unref'd : it never keeps the process alive.
 */
function armSummary() {
  clearTimeout(summaryTimer);
  const now = Date.now();
  const next = Math.floor(now / SUMMARY_EVERY_MS) * SUMMARY_EVERY_MS + SUMMARY_EVERY_MS;
  summaryTimer = setTimeout(() => {
    writeSummaries()
      .catch(() => {})
      .finally(() => {
        // stopped meanwhile : no timer again
        if (started && summaryTimer) armSummary();
      });
  }, next - now);
  summaryTimer.unref?.();
}

/**
 * Writes each loop's summary row of the window that ends now : its passes and failed ones since
 * the window started, success when none failed ; then its counts start again from nothing, the
 * next window from now. A loop without a pass in the window writes none. Never throws : a row
 * that cannot be written is logged, once for the window whatever the loops.
 *
 * Args:
 *   endedAt (Date): the window's end (now).
 *
 * Returns:
 *   Promise<number>: the rows written.
 */
export async function writeSummaries(endedAt = new Date()) {
  let written = 0;
  let problem = null;
  try {
    // step 1 : every loop's window counts taken at once, and started again from nothing
    const windows = HUB_LOOPS.map((loop) => {
      const state = states.get(loop.key);
      const window = { loop, from: state.hourFrom, passes: state.hourPasses, failures: state.hourFailures };
      state.hourFrom = endedAt;
      state.hourPasses = 0;
      state.hourFailures = 0;
      return window;
    });
    // step 2 : a row each, for a loop that made a pass
    for (const window of windows) {
      if (window.passes === 0) continue;
      const ok = await recordRun(
        window.loop,
        {
          startedAt: window.from,
          endedAt,
          outcome: window.failures === 0 ? 'success' : 'failed',
          result: summaryText(window.passes, window.failures),
          changed: 0,
        },
        { onError: (err) => (problem ||= err) },
      );
      if (ok) written += 1;
    }
  } catch (err) {
    problem ||= err;
  }
  // step 3 : a problem said once for the window
  if (problem) logger.warning(`Could not record the hourly summary of the runner hub loops: ${problem?.message || problem}`);
  return written;
}

/**
 * Its setting of seconds changed (lib/envSettings.js, on this node or on another through the env
 * change notice) : the loop's timer is armed again at once at the new seconds, the old one cleared.
 * Nothing on a node whose hub does not run : its loops have no timer.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   boolean: whether a timer was armed again.
 */
export function rearmLoop(key) {
  if (!timers.has(key)) return false;
  const armed = armLoop(key);
  if (armed) logger.notice(`The runner hub loop ${key} runs every ${armed.seconds} seconds now`);
  return !!armed;
}

/**
 * A loop's timer on this node, for a check : its seconds and when it was armed.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   object|null: { timer, seconds, armedAt }, or null when it has none.
 */
export function loopTimer(key) {
  return timers.get(key) || null;
}

/**
 * Keeps a bounded map of errors : the oldest goes when it is full.
 *
 * Args:
 *   map (Map): the map, oldest first.
 *   key (string): the error.
 *   value (any): what is kept for it.
 */
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > ERRORS_KEPT) map.delete(map.keys().next().value);
}

/**
 * A loop's failure : counted, kept as its last error, warned of once per distinct error, and
 * written as a failed row once a minute at most per distinct error. Never throws.
 *
 * Args:
 *   key (string): the loop's key.
 *   err (Error|string): what failed.
 *   startedAt (Date): when the run started.
 *   manual (boolean): a Run now pass : no throttled row, Run now writes its own (runLoopNow).
 *
 * Returns:
 *   Promise<object>: { written (whether a row was written), message (the error, as kept) }.
 */
async function failed(key, err, startedAt, manual = false) {
  const state = states.get(key);
  const loop = hubLoop(key);
  const message = String(err?.message || err || 'failed').slice(0, ERROR_MAX);
  const now = new Date();
  // step 1 : counted and kept
  state.failures += 1;
  state.lastOutcome = 'failed';
  state.lastError = { at: now, message };
  // step 2 : the log, once per distinct error
  if (!state.warned.has(message)) {
    remember(state.warned, message, true);
    logger.warning(`${loop.name} failed: ${message}`);
  }
  // step 3 : a row, once a minute at most per distinct error ; a Run now pass writes its own
  if (manual) return { written: false, message };
  const last = state.recorded.get(message);
  if (last !== undefined && now.getTime() - last < FAILURE_ROW_EVERY_MS) return { written: false, message };
  remember(state.recorded, message, now.getTime());
  const written = await recordRun(loop, { startedAt, endedAt: now, outcome: 'failed', result: message, changed: 0 });
  return { written, message };
}

/**
 * One pass of a loop, kept : its work, then its outcome in the loop's state and in the hour's
 * counts ; a failure is said (failed). Never throws.
 *
 * Args:
 *   key (string): the loop's key (runnerDispatch).
 *   fn (function): the pass's work, async.
 *   manual (boolean): a Run now pass (its failure gets no throttled row).
 *
 * Returns:
 *   Promise<object>: { ok, startedAt, endedAt, message (the error ; null on success) }.
 */
async function pass(key, fn, manual = false) {
  const state = states.get(key);
  const startedAt = new Date();
  // counted at once, before any wait : a pass asked now sees this one going (runLoopNow)
  state.runs += 1;
  state.lastRunAt = startedAt;
  state.active += 1;
  try {
    await fn();
    state.lastOutcome = 'success';
    state.lastSuccessAt = new Date();
    state.hourPasses += 1;
    return { ok: true, startedAt, endedAt: state.lastSuccessAt, message: null };
  } catch (err) {
    state.hourPasses += 1;
    state.hourFailures += 1;
    const said = await failed(key, err, startedAt, manual).catch(() => null);
    return { ok: false, startedAt, endedAt: new Date(), message: said?.message || String(err?.message || err || 'failed') };
  } finally {
    state.active -= 1;
  }
}

/**
 * One run of a loop, kept : its work, then its outcome in the loop's state ; a failure is said
 * (failed). Never throws, so a timer can call it as it is.
 *
 * Args:
 *   key (string): the loop's key (runnerDispatch).
 *   fn (function): the run's work, async.
 *
 * Returns:
 *   Promise<boolean>: true when the run succeeded.
 *
 * Raises:
 *   Error: when no loop has that key (at the hub's start).
 */
export function loopRun(key, fn) {
  if (!states.has(key)) throw new Error(`No runner hub loop is named ${key}`);
  return pass(key, fn).then((done) => done.ok);
}

/**
 * Whether a pass of a loop goes now on this node.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   boolean: false for a key no loop has.
 */
export function loopBusy(key) {
  return (states.get(key)?.active || 0) > 0;
}

/**
 * Runs one pass of a loop now on this node (Run now), as its timer runs it : counted (in the
 * hour's summary too), its failure warned of as a timed one's ; then its own row, success
 * (RUN_NOW_DONE) or failed (the error), its failure written there only, never also as a
 * throttled timed one's. Refused while a pass of that loop goes : a second one at the same time
 * would hand the same jobs over twice, and the pass going is the one the timer just started, so a
 * few milliseconds later Run now runs a fresh one.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   Promise<object>: { status } : 'done' (with ok, whether the pass succeeded), 'noHub' when the
 *     hub does not run on this node, 'busy' while a pass of it goes, 'unknown' for a key no loop
 *     has.
 */
export async function runLoopNow(key) {
  if (!states.has(key)) return { status: 'unknown' };
  const fn = works.get(key);
  if (!started || !fn) return { status: 'noHub' };
  if (loopBusy(key)) return { status: 'busy' };
  // step 1 : the pass (counted before its first wait : a second Run now sees it busy)
  const done = await pass(key, fn, true);
  // step 2 : its row (recordRun never throws)
  await recordRun(hubLoop(key), {
    startedAt: done.startedAt,
    endedAt: done.endedAt,
    outcome: done.ok ? 'success' : 'failed',
    result: done.ok ? RUN_NOW_DONE : done.message,
    changed: 0,
  });
  return { status: 'done', ok: done.ok };
}

/**
 * What a loop did on this node, as the API answers it.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   object|null: { node, running, since, armed_at (when its timer was last armed, its pace
 *     since then ; null for none), runs, failures, last_run_at, last_outcome, last_success_at,
 *     last_error ({ at, message } or null) } ; null for a key no loop has.
 */
export function loopState(key) {
  const state = states.get(key);
  if (!state) return null;
  const iso = (d) => (d ? d.toISOString() : null);
  return {
    node: nodeId,
    running: started,
    since: iso(state.since),
    armed_at: iso(timers.get(key)?.armedAt),
    runs: state.runs,
    failures: state.failures,
    last_run_at: iso(state.lastRunAt),
    last_outcome: state.lastOutcome,
    last_success_at: iso(state.lastSuccessAt),
    last_error: state.lastError ? { at: iso(state.lastError.at), message: state.lastError.message } : null,
  };
}

// tests only : the summary rows' timer (null : none)
export function summaryTimerForTests() {
  return summaryTimer;
}

// tests only : every loop as at start, its timer cleared (the summary rows' too), the hub running here or not, with each
// loop's work
export function resetLoopsForTests(running = false, fns = {}) {
  for (const { timer } of timers.values()) clearInterval(timer);
  timers.clear();
  clearTimeout(summaryTimer);
  summaryTimer = null;
  for (const loop of HUB_LOOPS) states.set(loop.key, emptyState());
  works = new Map(Object.entries(fns));
  started = running;
}

export default { FAILURE_ROW_EVERY_MS, SUMMARY_EVERY_MS, RUN_NOW_DONE, summaryText, writeSummaries, markLoopsStarted, startLoops, stopLoops, rearmLoop, loopTimer, loopRun, loopBusy, runLoopNow, loopState };
