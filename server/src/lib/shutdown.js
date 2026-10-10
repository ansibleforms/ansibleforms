// A clean stop on SIGTERM (docker stop, a kubernetes pod ending) and SIGINT (ctrl-c).
//
// Without a handler node ignores SIGTERM as PID 1, so every stop waited out the grace period and
// ended in SIGKILL : a waiting worker only took over once the database noticed the dead socket,
// and in-flight requests were cut. Each role registers what to close ; they run last-registered
// first (the HTTP server before the database pool it uses), and a stop that hangs is cut short
// before the orchestrator's own SIGKILL.
import logger from "./logger.js";

let STOP_WITHIN_MS = 8000;
const closers = [];
let stopping = false;

/**
 * Gives the stop more time : an RTE draining its running playbooks needs longer than the
 * default 8 seconds (RTE_DRAIN_SECONDS).
 *
 * Args:
 *   ms (number): the most a stop may take.
 */
export function stopWithin(ms) {
  STOP_WITHIN_MS = Math.max(STOP_WITHIN_MS, Number(ms) || 0);
}

/**
 * Whether the process is stopping (SIGTERM or SIGINT received).
 *
 * Returns:
 *   boolean: true once a stop began.
 */
export function isStopping() {
  return stopping;
}

export function onShutdown(name, fn) {
  closers.push({ name, fn });
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.notice(`${signal} : stopping`);
  setTimeout(() => {
    logger.warning(`Did not stop within ${STOP_WITHIN_MS / 1000} seconds, exiting anyway`);
    process.exit(0);
  }, STOP_WITHIN_MS).unref();
  for (const { name, fn } of [...closers].reverse()) {
    try {
      await fn();
    } catch (e) {
      logger.warning(`Stopping ${name} failed : ${e.message || e}`);
    }
  }
  process.exit(0);
}

export function installShutdown() {
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => shutdown(signal));
}
