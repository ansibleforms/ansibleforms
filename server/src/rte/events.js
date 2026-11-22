/******************************************************************/
/*                                                                */
/*  A running playbook's structured events : the af_events        */
/*  callback plugin writes one JSON line per play, task and host  */
/*  result to a file ; this reads the file as it grows, every     */
/*  half second, and hands the new events on in order - to the    */
/*  database (database mode) or the controller (socket modes).           */
/*                                                                */
/******************************************************************/
import fs from "fs";
import { StringDecoder } from "string_decoder";
import logger from "../lib/logger.js";

const POLL_MS = 500;
// events handed on at once at most : a playbook over hundreds of hosts writes thousands
const MAX_BATCH = 500;
// and at most this many characters of JSON : an event carries a host's whole result (up to 64 KB,
// af_events.py), and a batch goes in one socket message (MAX_PAYLOAD, 8 MB)
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * Follows an events file.
 *
 * Args:
 *   file (string): the file the plugin writes (AF_EVENTS_FILE).
 *   dir (string): the private folder the file is in (rte/ansible-core.js makeEventsFile), removed
 *     with it ; none for a file on its own.
 *   write (function): (events[]) => Promise : stores a batch, in order.
 *
 * Returns:
 *   {stop: function}: stop() reads what is left, hands it on, removes the file (and its folder),
 *     and resolves once the last batch is stored.
 */
export function createEventTail({ file, dir = "", write }) {
  let offset = 0;
  // a line the plugin is still writing : kept until its end comes
  let partial = "";
  // a character cut between two reads (UTF-8 takes up to 4 bytes) : its first bytes kept until
  // the rest comes, never decoded on their own as a replacement character
  const decoder = new StringDecoder("utf8");
  let order = 0;
  let writing = Promise.resolve();
  let stopped = false;

  const read = () => {
    let fd;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return; // not written yet
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (partial + decoder.write(buf)).split("\n");
      partial = lines.pop();
      const events = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push({ ...JSON.parse(line), order: ++order });
        } catch {
          logger.debug(`An event line could not be read: ${line.slice(0, 120)}`);
        }
      }
      // in order, cut by count and by size
      let batch = [];
      let bytes = 0;
      const send = (list) => {
        writing = writing.then(() => write(list)).catch((e) => logger.error(`The playbook's events could not be stored: ${e.message}`));
      };
      for (const e of events) {
        const size = JSON.stringify(e).length;
        if (batch.length && (batch.length >= MAX_BATCH || bytes + size > MAX_BATCH_BYTES)) {
          send(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(e);
        bytes += size;
      }
      if (batch.length) send(batch);
    } finally {
      fs.closeSync(fd);
    }
  };

  const timer = setInterval(read, POLL_MS);
  return {
    async stop() {
      if (stopped) return writing;
      stopped = true;
      clearInterval(timer);
      read();
      try {
        fs.unlinkSync(file);
      } catch {
        // never written
      }
      // and its private folder, once empty (what else is in it is not this tail's to remove)
      if (dir) {
        try {
          fs.rmdirSync(dir);
        } catch {
          // gone already, or not empty
        }
      }
      return writing;
    },
  };
}

export default { createEventTail };
