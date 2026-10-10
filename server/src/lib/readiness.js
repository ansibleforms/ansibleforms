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
import { missingFromManifest } from "./schemaCompleteness.js";

/**
 * Whether this process can serve.
 *
 * Args:
 *   mysql (object): the database layer (do(sql)).
 *   manifest (object): the schema manifest (models/schema.model.js) : given, the whole schema
 *     must be there.
 *
 * Returns:
 *   Promise<{ready: boolean, reason?: string}>: ready, or why not.
 */
// the schema's completeness is read at most every 30 seconds : a probe every few seconds must not
// query information_schema each time
const SCHEMA_TTL_MS = 30000;
let schemaChecked = { at: 0, reason: null };

export async function readiness(mysql, manifest = null) {
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
  // all of the schema manifest : an upgrade that stopped halfway (its backup failed) is not ready
  if (manifest) {
    if (Date.now() - schemaChecked.at > SCHEMA_TTL_MS) {
      try {
        const { missingTables, missingColumns, missingIndexes } = await missingFromManifest(manifest, mysql);
        const missing = missingTables.length + missingColumns.length + missingIndexes.length;
        schemaChecked = { at: Date.now(), reason: missing ? "schema not upgraded" : null };
      } catch {
        schemaChecked = { at: Date.now(), reason: "schema unreadable" };
      }
    }
    if (schemaChecked.reason) return { ready: false, reason: schemaChecked.reason };
  }
  return { ready: true };
}

/**
 * The express handlers : live answers 200 ; ready 200 or 503 with its reason.
 *
 * Args:
 *   mysql (object): the database layer.
 *   manifest (object): the schema manifest, or null for the three core tables only.
 *
 * Returns:
 *   {live: function, ready: function}: the handlers.
 */
export function readinessHandlers(mysql, manifest = null) {
  return {
    live: (req, res) => res.status(200).json({ status: "live" }),
    ready: async (req, res) => {
      const r = await readiness(mysql, manifest);
      res.status(r.ready ? 200 : 503).json(r.ready ? { status: "ready" } : { status: "not ready", reason: r.reason });
    },
  };
}

export default { readiness, readinessHandlers };
