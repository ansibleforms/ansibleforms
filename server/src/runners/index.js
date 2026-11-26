// Where a job runs. A runner is
//   { type, capabilities: { playbook, template }, launch(ctx), cancel(ctx), resume?(ctx) }
// resume(ctx) follows again a job its node stopped following (lib/jobResume.js), resolving
// once it ended, null when the runner no longer knows it ; ctx = { jobId, runner, job }.
// launch(ctx) resolves when the job has ended (a multistep waits for its steps on it) ;
// ctx = { jobId, extravars, credentialMap, ... }. The approval gate is not a runner's
// business : runners/orchestrator.js passes a job on only once it may run.
import awx from "./awx/index.js";
import rte from "./rte.js";
import semaphore from "./semaphore.js";
import rundeck from "./rundeck.js";
import jenkins from "./jenkins.js";
import builder from "./builder.js";

export const RUNNERS = { awx, rte, semaphore, rundeck, jenkins, builder };
export const RUNNER_TYPES = Object.keys(RUNNERS);

export function getRunner(type) {
  const runner = RUNNERS[type];
  if (!runner) throw new Error(`Unknown runner type '${type}'`);
  return runner;
}
