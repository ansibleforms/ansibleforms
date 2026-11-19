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
// A failure is said, as the loops never said one above debug before :
//   - in the log, a warning once per distinct error of a loop (the same error every 2 seconds
//     would fill it) ;
//   - as a failed row of system_task_runs, so the loop's Runs tab lists its failures : one per
//     distinct error of a loop a minute at most.
//
// Run now (POST /api/v2/system/tasks/:key/run) runs one pass of a loop at once on the node that
// received it (runLoopNow), through the same loopRun as its timer : counted, its failure said as
// a timed one's. Never while a pass of that loop goes, nor on a node whose hub does not run.
import logger from './logger.js';
import { nodeId } from './role.js';
import { HUB_LOOPS, hubLoop, recordRun, loopSeconds } from './systemTasks.js';

// one row per distinct error of a loop this often at most
export const FAILURE_ROW_EVERY_MS = 60 * 1000;
// the distinct errors kept per loop, to warn once and throttle the rows : the oldest go
const ERRORS_KEPT = 100;
// the longest error kept
const ERROR_MAX = 1000;

/**
 * A loop's state, empty : started now, no run yet.
 *
 * Returns:
 *   object: { since, runs, failures, lastRunAt, lastOutcome, lastSuccessAt, lastError, warned,
 *     recorded }.
 */
function emptyState() {
  return {
    since: new Date(),
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
  for (const loop of HUB_LOOPS) armLoop(loop.key);
}

/**
 * Stops the hub's loops on this node : every timer cleared (the process stops).
 */
export function stopLoops() {
  for (const { timer } of timers.values()) clearInterval(timer);
  timers.clear();
  started = false;
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
 *
 * Returns:
 *   Promise<boolean>: whether a row was written.
 */
async function failed(key, err, startedAt) {
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
  // step 3 : a row, once a minute at most per distinct error
  const last = state.recorded.get(message);
  if (last !== undefined && now.getTime() - last < FAILURE_ROW_EVERY_MS) return false;
  remember(state.recorded, message, now.getTime());
  return recordRun(loop, { startedAt, endedAt: now, outcome: 'failed', result: message, changed: 0 });
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
  return (async () => {
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
      return true;
    } catch (err) {
      await failed(key, err, startedAt).catch(() => false);
      return false;
    } finally {
      state.active -= 1;
    }
  })();
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
 * Runs one pass of a loop now on this node (Run now), through loopRun as its timer runs it :
 * counted, its failure said as a timed one's. Refused while a pass of that loop goes : a second
 * one at the same time would hand the same jobs over twice, and the pass going is the one the
 * timer just started, so a few milliseconds later Run now runs a fresh one.
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
  // loopRun counts the pass before its first wait : a second Run now sees it busy
  return { status: 'done', ok: await loopRun(key, fn) };
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

// tests only : every loop as at start, its timer cleared, the hub running here or not, with each
// loop's work
export function resetLoopsForTests(running = false, fns = {}) {
  for (const { timer } of timers.values()) clearInterval(timer);
  timers.clear();
  for (const loop of HUB_LOOPS) states.set(loop.key, emptyState());
  works = new Map(Object.entries(fns));
  started = running;
}

export default { FAILURE_ROW_EVERY_MS, markLoopsStarted, startLoops, stopLoops, rearmLoop, loopTimer, loopRun, loopBusy, runLoopNow, loopState };
