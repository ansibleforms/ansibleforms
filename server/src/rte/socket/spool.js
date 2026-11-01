/******************************************************************/
/*                                                                */
/*  A job's items on the RTE's disk until the controller stored them :   */
/*  every output batch, event batch, log, start, exit and end is  */
/*  numbered and written to the job's spool file before it is     */
/*  sent. The controller acks what it stored ; after a reconnect - to    */
/*  the same controller node or another - the RTE sends again what was   */
/*  not acked, and the controller skips what it had stored already :     */
/*  each item exactly once. Once the end is acked the file goes.  */
/*                                                                */
/*  As Receptor keeps a work unit's results on the execution      */
/*  node, so the controller reads them from where it stopped.     */
/*                                                                */
/******************************************************************/
import fs from "fs";
import path from "path";
import logger from "../../lib/logger.js";

// items kept in memory too, at most, per job : older ones are read back from the file
const MEMORY_ITEMS = 256;

/**
 * The spool of one job.
 */
export class JobSpool {
  /**
   * Opens (or makes) a job's spool.
   *
   * Args:
   *   dir (string): the spool folder (RTE_SPOOL_PATH).
   *   jobId (number): the job.
   */
  constructor(dir, jobId) {
    this.jobId = jobId;
    this.file = path.join(dir, `job-${jobId}.jsonl`);
    // the last item numbered, the last one the controller acked, the next one to send
    this.seq = 0;
    this.acked = 0;
    this.next = 1;
    this.ended = false;
    this.memory = new Map();
    this._load();
  }

  /** reads back an existing file (an RTE restarted with items not acked) */
  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.kind === "ack") {
          this.acked = Math.max(this.acked, item.seq);
          continue;
        }
        this.seq = Math.max(this.seq, item.seq);
        if (item.kind === "end" || item.kind === "abandon") this.ended = true;
      } catch {
        // a line cut by a crash : the items before it count
      }
    }
    this.next = this.acked + 1;
  }

  /**
   * Numbers an item and writes it to the file.
   *
   * Args:
   *   item (object): the item ({ kind, ... }).
   *
   * Returns:
   *   object: the item with its seq.
   */
  append(item) {
    const numbered = { ...item, seq: ++this.seq };
    fs.appendFileSync(this.file, JSON.stringify(numbered) + "\n", { mode: 0o600 });
    if (numbered.kind === "end" || numbered.kind === "abandon") this.ended = true;
    this.memory.set(numbered.seq, numbered);
    if (this.memory.size > MEMORY_ITEMS) this.memory.delete(this.memory.keys().next().value);
    return numbered;
  }

  /**
   * An item by its number, from memory or the file.
   *
   * Args:
   *   seq (number): its number.
   *
   * Returns:
   *   object|null: the item.
   */
  get(seq) {
    if (this.memory.has(seq)) return this.memory.get(seq);
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
    for (const line of text.split("\n")) {
      if (!line.includes(`"seq":${seq}`)) continue;
      try {
        const item = JSON.parse(line);
        if (item.seq === seq && item.kind !== "ack") return item;
      } catch {
        // cut line
      }
    }
    return null;
  }

  /**
   * The controller stored the items up to a number.
   *
   * Args:
   *   seq (number): the last item stored.
   *
   * Returns:
   *   boolean: true when every item is acked and the job ended (the spool can go).
   */
  ack(seq) {
    if (seq <= this.acked) return this.done;
    this.acked = Math.min(seq, this.seq);
    for (const k of [...this.memory.keys()]) if (k <= this.acked) this.memory.delete(k);
    // the ack on disk too : a restart then resends only what came after
    try {
      fs.appendFileSync(this.file, JSON.stringify({ kind: "ack", seq: this.acked }) + "\n");
    } catch (e) {
      logger.debug(`Spool of job ${this.jobId}: could not write the ack: ${e.message}`);
    }
    if (this.next <= this.acked) this.next = this.acked + 1;
    return this.done;
  }

  /** every item acked and the job ended */
  get done() {
    return this.ended && this.acked >= this.seq;
  }

  /** after a reconnect : everything not acked goes again */
  rewind() {
    this.next = this.acked + 1;
  }

  /** removes the file (the end acked) */
  remove() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      // gone already
    }
  }

  /**
   * The spools of the jobs an earlier start of this RTE left (job-<id>.jsonl).
   *
   * Args:
   *   dir (string): the spool folder.
   *
   * Returns:
   *   JobSpool[]: one per job.
   */
  static loadAll(dir) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((n) => /^job-(\d+)\.jsonl$/.exec(n))
      .filter(Boolean)
      .map((m) => new JobSpool(dir, Number(m[1])));
  }
}

export default JobSpool;
