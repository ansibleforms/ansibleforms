// The RTE's start : RTE_MODE picks how it talks to the controller, and only that mode's modules load.
//   outbound  it dials the controller (CONTROLLER_URL) over one WebSocket and keeps it (rte/socket)
//   inbound   it listens, and the controller dials it (RTE_URL) over one WebSocket (rte/socket)
//   database  it reads and writes the controller's database itself (rte/server.js) - deprecated in 7.3,
//             removed in 8.0 ; the mode of an RTE with no RTE_MODE all through 7.x
// The socket modes hold no database credentials : nothing of the database is imported.
import { MODES } from "./socket/protocol.js";

/**
 * Starts the RTE in its mode.
 *
 * Returns:
 *   Promise<void>
 */
export async function startRteInMode() {
  const raw = String(process.env.RTE_MODE ?? "").trim().toLowerCase();
  const mode = raw || "database";
  if (!MODES.includes(mode)) {
    console.error(`Runner: RTE_MODE='${process.env.RTE_MODE}' is not one of ${MODES.join(", ")} ; refusing to start`);
    process.exit(1);
  }
  if (mode === "database") {
    const { startRte } = await import("./server.js");
    const { default: logger } = await import("../lib/logger.js");
    logger.warning(
      `[DEPRECATED] This runner runs in database mode${raw ? "" : " (RTE_MODE is not set)"}: it holds the database's credentials and reads and writes it itself. ` +
        "Set RTE_MODE=outbound (it dials the controller, CONTROLLER_URL) or RTE_MODE=inbound (the controller dials it, RTE_URL), and drop DB_* from its environment. " +
        "Database mode is removed in 8.0.0."
    );
    return startRte();
  }
  // the names of before 7.8 still set : CONTROLLER_URL, CONTROLLER_TLS_VERIFY (lib/controllerEnv.js)
  const { controllerEnvWarnings } = await import("../lib/controllerEnv.js");
  const warnings = controllerEnvWarnings();
  if (warnings.length) {
    const { default: logger } = await import("../lib/logger.js");
    for (const warning of warnings) logger.warning(warning);
  }
  const { startSocketRte } = await import("./socket/rte-socket.js");
  return startSocketRte(mode);
}

export default { startRteInMode };
