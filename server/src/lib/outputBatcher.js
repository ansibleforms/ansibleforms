/******************************************************************/
/*                                                                */
/*  A running playbook's output, written in batches : the chunks  */
/*  of a stream are kept for half a second (or 64 KB) and stored  */
/*  as one row, in order, through Job.createOutput (masked like   */
/*  every output). A chatty playbook used to cost three queries   */
/*  per chunk - hundreds a second.                                */
/*                                                                */
/*  Past PROCESS_MAX_BUFFER bytes on a stream the output is no    */
/*  longer stored - one line says so - and the playbook goes on : */
/*  it used to be killed there.                                   */
/*                                                                */
/******************************************************************/

const FLUSH_MS = 500;
const FLUSH_BYTES = 64 * 1024;

/**
 * A batcher for one job's output.
 *
 * Args:
 *   write (function): (record) => Promise : stores one row ({ output, output_type, job_id, order }).
 *   jobId (number): the job.
 *   nextOrder (function): () => number : the order of the next row (counted by the caller, which
 *     writes its own lines too).
 *   maxBytes (number): the bytes stored per stream at most ; 0 : no limit.
 *
 * Returns:
 *   {add: function, flush: function, stored: function}: add(stream, text) keeps a chunk ;
 *     flush() writes what is kept and resolves once written ; stored(stream) the bytes stored.
 */
export function createOutputBatcher({ write, jobId, nextOrder, maxBytes = 0 }) {
  let pending = []; // [{ stream, text }] in arrival order
  let pendingBytes = 0;
  let timer = null;
  let writing = Promise.resolve();
  const stored = { stdout: 0, stderr: 0 };
  const capped = { stdout: false, stderr: false };

  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    if (!batch.length) return writing;
    // consecutive chunks of one stream become one row : the order between the streams is kept
    const rows = [];
    for (const c of batch) {
      const last = rows[rows.length - 1];
      if (last && last.stream === c.stream) last.text += c.text;
      else rows.push({ stream: c.stream, text: c.text });
    }
    writing = writing.then(async () => {
      for (const r of rows) {
        await write({ output: r.text, output_type: r.stream, job_id: jobId, order: nextOrder() });
      }
    });
    return writing;
  };

  return {
    add(stream, text) {
      const s = stream === "stderr" ? "stderr" : "stdout";
      if (capped[s]) return;
      let chunk = String(text ?? "");
      if (maxBytes && stored[s] + Buffer.byteLength(chunk) > maxBytes) {
        // what still fits, then one line : the rest is not stored, the playbook goes on
        const room = Math.max(0, maxBytes - stored[s]);
        chunk = Buffer.from(chunk).subarray(0, room).toString("utf8");
        capped[s] = true;
        chunk += `\n[WARNING]: the ${s} of this job passed PROCESS_MAX_BUFFER (${maxBytes} bytes) : the rest is not stored, the playbook goes on\n`;
      }
      stored[s] += Buffer.byteLength(chunk);
      pending.push({ stream: s, text: chunk });
      pendingBytes += Buffer.byteLength(chunk);
      if (pendingBytes >= FLUSH_BYTES) flushNow();
      else if (!timer) timer = setTimeout(flushNow, FLUSH_MS);
    },
    flush: flushNow,
    stored: (stream) => stored[stream === "stderr" ? "stderr" : "stdout"],
  };
}

export default { createOutputBatcher };
