/******************************************************************/
/*                                                                */
/*  One RTE socket, as both sides use it whoever dialed : JSON    */
/*  messages in and out, a ping every 20 s that keeps proxies     */
/*  from closing it, and the socket dropped when nothing was      */
/*  heard for 60 s (a peer gone without a word).                  */
/*                                                                */
/******************************************************************/
import { EventEmitter } from "events";
import WebSocket from "ws";
import logger from "../../lib/logger.js";
import { encode, decode, PING_MS, DEAD_MS, CLOSE } from "./protocol.js";

/**
 * A socket's session. Emits:
 *   message (msg)   every message read ; and "m:<type>" (msg) for its type
 *   close (code, reason)  once, when the socket is gone
 */
export class Session extends EventEmitter {
  /**
   * Args:
   *   ws (WebSocket): the open socket.
   *   label (string): who is on the other side, for the log (rte 'dmz-1', controller node 'app-x-443').
   */
  constructor(ws, label) {
    super();
    this.ws = ws;
    this.label = label;
    this.lastHeard = Date.now();
    this.closed = false;
    // what the other side said in its hello (the RTE's) or welcome (the controller's)
    this.peer = {};
    ws.on("message", (data) => {
      this.lastHeard = Date.now();
      const msg = decode(data);
      if (!msg) {
        logger.warning(`RTE socket (${this.label}): a message that is not one, closing`);
        this.close(CLOSE.PROTOCOL, "unreadable message");
        return;
      }
      this.emit("message", msg);
      this.emit(`m:${msg.t}`, msg);
    });
    ws.on("pong", () => {
      this.lastHeard = Date.now();
    });
    ws.on("ping", () => {
      this.lastHeard = Date.now();
    });
    ws.on("close", (code, reason) => this._closed(code, String(reason || "")));
    ws.on("error", (err) => logger.debug(`RTE socket (${this.label}): ${err.message}`));
    this.timer = setInterval(() => {
      if (Date.now() - this.lastHeard > DEAD_MS) {
        logger.warning(`RTE socket (${this.label}): nothing heard for ${DEAD_MS / 1000} seconds, dropping it`);
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_MS);
    this.timer.unref?.();
  }

  /** whether messages can be sent */
  get open() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a message.
   *
   * Args:
   *   msg (object): the message, its type in t.
   *
   * Returns:
   *   boolean: true when sent, false when the socket is not open (it will be resent or dropped
   *     by the caller's own logic).
   */
  send(msg) {
    if (!this.open) return false;
    this.ws.send(encode(msg));
    return true;
  }

  /**
   * Closes the socket.
   *
   * Args:
   *   code (number): the close code (protocol.js CLOSE).
   *   reason (string): why, for the log on the other side.
   */
  close(code = 1000, reason = "") {
    if (this.closed) return;
    try {
      this.ws.close(code, String(reason).slice(0, 120));
    } catch {
      this.ws.terminate();
    }
    // a peer that does not answer the close : gone anyway after a moment
    setTimeout(() => this.ws.terminate(), 5000).unref?.();
  }

  _closed(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.emit("close", code, reason);
  }
}

export default Session;
