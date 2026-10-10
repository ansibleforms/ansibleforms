/******************************************************************/
/*                                                                */
/*  An uncaught exception leaves the process in a state nobody    */
/*  can vouch for : a half-done write, a pool that lost a         */
/*  connection under it (mysql2 throws one when the database      */
/*  goes away), a timer that never fires again. It was logged and */
/*  the process went on serving. Now it is logged and the process */
/*  exits : the container's restart policy (or Kubernetes) starts */
/*  it again, clean, and the worker lock passes on.               */
/*  An unhandled promise rejection is logged, as before.          */
/*                                                                */
/******************************************************************/
import logger from "./logger.js";

let exiting = false;

/**
 * Installs the handlers of a process role.
 *
 * Args:
 *   role (string): app, worker or rte - in the log line.
 *   exit (function): how to leave, process.exit by default (the tests give their own).
 */
export function installFatalHandlers(role, exit = (code) => process.exit(code)) {
  process.on("uncaughtException", (err) => {
    logger.crit(`${role} : uncaught exception, exiting to restart clean : ${err?.stack || err}`);
    if (exiting) return;
    exiting = true;
    // a second for the log to reach its file and syslog
    setTimeout(() => exit(1), 1000).unref?.();
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`${role} : unhandled promise rejection : ${reason?.stack || reason}`);
  });
}

export default { installFatalHandlers };
