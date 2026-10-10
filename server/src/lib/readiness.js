/******************************************************************/
/*                                                                */
/*  Liveness and readiness, for a load balancer or Kubernetes :   */
/*    live  - the process answers ;                               */
/*    ready - it can serve : the database answers, the schema is  */
/*            there, and the process is not stopping.             */
/*  No login, and no detail beyond a reason a probe log can show  */
/*  - nothing about the setup.                                    */
/*                                                                */
/******************************************************************/
import { isStopping } from "./shutdown.js";

/**
 * Whether this process can serve.
 *
 * Args:
 *   mysql (object): the database layer (do(sql)).
 *
 * Returns:
 *   Promise<{ready: boolean, reason?: string}>: ready, or why not.
 */
export async function readiness(mysql) {
  if (isStopping()) return { ready: false, reason: "stopping" };
  try {
    await mysql.do("SELECT 1");
  } catch {
    return { ready: false, reason: "database unreachable" };
  }
  try {
    const rows = await mysql.do("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='AnsibleForms' AND table_name IN ('jobs','users','settings')");
    if (Number(rows?.[0]?.n) < 3) return { ready: false, reason: "schema not provisioned" };
  } catch {
    return { ready: false, reason: "schema unreadable" };
  }
  return { ready: true };
}

/**
 * The express handlers : live answers 200 ; ready 200 or 503 with its reason.
 *
 * Args:
 *   mysql (object): the database layer.
 *
 * Returns:
 *   {live: function, ready: function}: the handlers.
 */
export function readinessHandlers(mysql) {
  return {
    live: (req, res) => res.status(200).json({ status: "live" }),
    ready: async (req, res) => {
      const r = await readiness(mysql);
      res.status(r.ready ? 200 : 503).json(r.ready ? { status: "ready" } : { status: "not ready", reason: r.reason });
    },
  };
}

export default { readiness, readinessHandlers };
