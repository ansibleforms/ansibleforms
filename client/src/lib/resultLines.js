/******************************************************************/
/*                                                                */
/*  A job's output lines paired with its structured events : the  */
/*  TASKs in order by their name, then within a task each host's  */
/*  result lines (ok, changed, fatal, skipping, unreachable) and  */
/*  loop item lines in order. A paired line opens its event's     */
/*  details (components/AppAnsibleOutput.vue). The same for a     */
/*  playbook run on an RTE and a job run on AWX, AAP or Ascender  */
/*  (their output is ansible's, their events the same shape).     */
/*                                                                */
/******************************************************************/

// the event types of a host's result
const RESULT_TYPES = new Set(['ok', 'changed', 'failed', 'skipped', 'unreachable']);
// a host's result line : its status word, then its host (and where it delegates : host -> other)
const RESULT_LINE = /^(ok|changed|failed|fatal|skipping|unreachable):\s+\[([^\]]+)\]/;

/**
 * The level of a line that starts a section : 1 an AWX workflow's node (or its summary), 2 a PLAY (or the
 * recap), 3 a TASK (or a handler), 0 for any other line.
 *
 * Args:
 *   text (string): the line's text, its tags left out.
 *
 * Returns:
 *   number: its level.
 */
export function lineLevel(text) {
  // a workflow's banners (a node's output, the summary at the end) carry a row of stars ; the
  // summary's own line per node does not, and stays a plain line
  // a workflow's node or summary : its banner (its node's id after its status, #42, since the
  // graph opens a node by it)
  if (/^WORKFLOW( NODE)? \[.*\] \([^)]*\)( #\d+)? \*{5,}/.test(text)) return 1;
  if (/^(PLAY \[|PLAY RECAP)/.test(text)) return 2;
  if (/^(TASK|RUNNING HANDLER) \[/.test(text)) return 3;
  return 0;
}

/**
 * Pairs the output's lines with the events that have details : a host's result line, the body
 * printed with it (ok: [host] => { ... }), and the error ansible prints before a failed result.
 *
 * Args:
 *   lines (object[]): the output's lines, in order : [{ text, level }] (lineLevel).
 *   events (object[]): the job's events, in order (GET /api/v2/job/:id/events).
 *
 * Returns:
 *   Map<number, number>: a line's index -> the order of its event.
 */
export function pairResultLines(lines, events) {
  const map = new Map();
  if (!events?.length) return map;
  // the tasks in order : each its hosts' results and loop items, in order
  const tasks = [];
  for (const e of events) {
    if (e.type === 'task') tasks.push({ name: e.task, results: {}, items: {} });
    else if (tasks.length && e.host && (RESULT_TYPES.has(e.type) || e.type === 'item')) {
      const bucket = e.type === 'item' ? tasks[tasks.length - 1].items : tasks[tasks.length - 1].results;
      (bucket[e.host] ||= []).push(e);
    }
  }
  let next = 0;
  let task = null;
  let seen = {};
  // a result printed with its body (ok: [host] => { ... }) : its lines up to the closing brace
  let body = null;
  // the error ansible prints before a failed result ([ERROR]: Task failed ..., its origin and
  // the playbook's lines) : the lines from it to the result, the same failure
  let preamble = null;
  lines.forEach((line, index) => {
    const text = line.text;
    if (body !== null && !line.level && !RESULT_LINE.test(text)) {
      map.set(index, body);
      if (text.trimEnd() === '}') body = null;
      return;
    }
    body = null;
    if (!line.level && task && !RESULT_LINE.test(text)) {
      if (text.startsWith('[ERROR]:')) preamble = [];
      if (preamble) preamble.push(index);
      return;
    }
    const before = preamble || [];
    preamble = null;
    if (line.level === 3) {
      // TASK [name] or RUNNING HANDLER [name] : the next task of that name
      const name = text.replace(/^(TASK|RUNNING HANDLER) \[/, '').replace(/\]\s*\**\s*$/, '');
      const at = tasks.findIndex((x, i) => i >= next && x.name === name);
      task = at >= 0 ? tasks[at] : null;
      if (at >= 0) next = at + 1;
      seen = {};
      return;
    }
    if (line.level || !task) return;
    const m = RESULT_LINE.exec(text);
    if (!m) return;
    const host = m[2].split(' -> ')[0].trim();
    const item = /\(item=/.test(text);
    const key = `${item ? 'i' : 'r'}:${host}`;
    const k = (seen[key] = (seen[key] ?? -1) + 1);
    const event = (item ? task.items : task.results)[host]?.[k];
    if (!event?.detailed) return;
    map.set(index, event.order);
    if (m[1] === 'failed' || m[1] === 'fatal') for (const i of before) map.set(i, event.order);
    if (text.trimEnd().endsWith('{')) body = event.order;
  });
  return map;
}

export default { lineLevel, pairResultLines };
