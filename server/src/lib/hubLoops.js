'use strict';
// What the runner hub's own loops did on this node (lib/systemTasks.js HUB_LOOPS : dispatch every
// 2 seconds, inbound dial every 10, ended jobs prune every 60), for Jobs > System.
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
import logger from './logger.js';
import { nodeId } from './role.js';
import { HUB_LOOPS, hubLoop, recordRun } from './systemTasks.js';

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

/**
 * Marks the loops as running on this node : the hub started them (startRteHub).
 */
export function markLoopsStarted() {
  started = true;
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
    state.runs += 1;
    state.lastRunAt = startedAt;
    try {
      await fn();
      state.lastOutcome = 'success';
      state.lastSuccessAt = new Date();
      return true;
    } catch (err) {
      await failed(key, err, startedAt).catch(() => false);
      return false;
    }
  })();
}

/**
 * What a loop did on this node, as the API answers it.
 *
 * Args:
 *   key (string): the loop's key.
 *
 * Returns:
 *   object|null: { node, running, since, runs, failures, last_run_at, last_outcome,
 *     last_success_at, last_error ({ at, message } or null) } ; null for a key no loop has.
 */
export function loopState(key) {
  const state = states.get(key);
  if (!state) return null;
  const iso = (d) => (d ? d.toISOString() : null);
  return {
    node: nodeId,
    running: started,
    since: iso(state.since),
    runs: state.runs,
    failures: state.failures,
    last_run_at: iso(state.lastRunAt),
    last_outcome: state.lastOutcome,
    last_success_at: iso(state.lastSuccessAt),
    last_error: state.lastError ? { at: iso(state.lastError.at), message: state.lastError.message } : null,
  };
}

// tests only : every loop as at start
export function resetLoopsForTests(running = false) {
  for (const loop of HUB_LOOPS) states.set(loop.key, emptyState());
  started = running;
}

export default { FAILURE_ROW_EVERY_MS, markLoopsStarted, loopRun, loopState };
