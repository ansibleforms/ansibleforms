// The thread the runs of a rrule are worked out in (lib/scheduleRrule.js nextRuns and
// nextRunsAsync) : a rule that takes too long only keeps this thread busy, which the caller stops
// after its time. Each request is answered on the port it was given, and a shared flag wakes a
// caller waiting for it.
import { parentPort, workerData } from "node:worker_threads";
import { walkRuns } from "./scheduleRrule.js";

const { flag, port } = workerData;

// loaded : a caller waiting for the thread to start is woken, one awaiting it is told
port.postMessage({ ready: true });
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);

parentPort.on("message", ({ id, rrule, after, count, fromStart }) => {
  let reply;
  try {
    reply = { id, runs: walkRuns(rrule, { after: new Date(after), count, fromStart }).map((d) => d.getTime()) };
  } catch (e) {
    reply = { id, error: e.message || String(e) };
  }
  port.postMessage(reply);
  // the caller waits on the flag : set, and woken
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
