<script setup>
import { computed, ref, watch, nextTick, onMounted, onUpdated, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { jobLogLines } from '@/lib/jobLog';
import { lineLevel, pairResultLines } from '@/lib/resultLines';
import axios from 'axios';

/******************************************************************/
/*                                                                */
/*  Ansible Output component                                      */
/*  Pretty print Ansible output                                   */
/*  Classes are old bulma classes                                 */
/*  But restyled to match the new bootstrap 5 design              */
/*                                                                */
/*  @props:                                                       */
/*      output: String                                            */
/*      jobLog: String (may contain ANSI color codes)             */
/*      numbered: Boolean - a line number on the left of each    */
/*                line, and a caret on each PLAY and TASK that   */
/*                folds its lines away (a job's page) ; an AWX   */
/*                workflow's nodes each their own card           */
/*      workflow: Object - the workflow's graph, for the cards'  */
/*                run times                                       */
/*                                                                */
/******************************************************************/

const props = defineProps({
  output: {
    type: String,
    required: true,
  },
  jobLog: {
    type: String,
    required: false,
  },
  numbered: {
    type: Boolean,
    default: false,
  },
  // the sections' copy button's tooltip (numbered)
  copyLabel: {
    type: String,
    default: 'Copy',
  },
  // the job's own card's title (numbered) : the playbook, or the AWX job template
  title: {
    type: String,
    default: '',
  },
  // an AWX workflow's graph (job.awx_workflow) : each node's run time on its card
  workflow: {
    type: Object,
    default: null,
  },
  // the workflow job (a workflow's output) : each node's card offers its extravars and its
  // artifacts (AppNodeData), as the user's options allow
  jobId: {
    type: [Number, String],
    default: null,
  },
  // its line numbers link to their line (#L45 in the address) : the job page's own output, not a
  // step's (each numbered from 1) nor a node's dialog
  lineLinks: {
    type: Boolean,
    default: false,
  },
  // the job's events, when the page already reads them (useJobEvents) : handed down so they are
  // read once, not by the page and again here. Left out (a multistep job's step, the form's
  // current step) : this output reads its own job's events itself
  events: {
    type: Array,
    default: null,
  },
});
const store = useAppStore();
const { t } = useI18n();
// a node's card's extravars or artifacts, open : its head line's index -> 'extravars' or 'artifacts'
const nodeData = ref({});

/**
 * Shows a node's extravars or artifacts under its header, or hides them when they show.
 *
 * Args:
 *   index (number): the node's head line.
 *   kind (string): 'extravars' or 'artifacts'.
 */
function toggleNodeData(index, kind) {
  nodeData.value = { ...nodeData.value, [index]: nodeData.value[index] === kind ? null : kind };
}

// ─── numbered : the output as lines, the PLAYs and TASKs foldable ────────────

/**
 * The span tags a line leaves open : carried into the next line (a colour that runs over
 * several lines), each line its own well-formed HTML.
 *
 * Args:
 *   html (string): the line, with the tags carried from the lines before it.
 *   open (string[]): the opening tags still open before it.
 *
 * Returns:
 *   string[]: the opening tags still open after it.
 */
function openSpans(html, open) {
  const stack = [...open];
  for (const m of html.matchAll(/<span\b[^>]*>|<\/span>/gi)) {
    if (m[0][1] === '/') stack.pop();
    else stack.push(m[0]);
  }
  return stack;
}

// parsed in an inert template : nothing in it runs or loads, its text read as the browser does
const parser = typeof document !== 'undefined' ? document.createElement('template') : null;

/**
 * A line's text, its tags left out.
 *
 * Args:
 *   html (string): the line.
 *
 * Returns:
 *   string: its text, trimmed.
 */
function plain(html) {
  if (!parser) return '';
  parser.innerHTML = html;
  return (parser.content.textContent || '').trim();
}

/**
 * The level of a line that starts a section : 1 an AWX workflow's node (or its summary), 2 a PLAY (or the
 * recap), 3 a TASK (or a handler), 0 for any other line.
 *
 * Args:
 *   html (string): the line.
 *
 * Returns:
 *   number: its level.
 */
function headLevel(html) {
  return lineLevel(plain(html));
}

// the lines : their HTML (each one well formed), their level, and the end of their section
const lines = computed(() => {
  if (!props.numbered) return [];
  const raw = (props.output || '').split(/<br\s*\/?>|\r?\n/i);
  while (raw.length && !plain(raw[raw.length - 1])) raw.pop();
  let open = [];
  const out = raw.map((line) => {
    const html = open.join('') + line;
    open = openSpans(line, open);
    return { html: html + '</span>'.repeat(open.length), level: headLevel(line), end: 0 };
  });
  // each section ends before the next head of its level or above
  out.forEach((line, i) => {
    if (!line.level) return;
    let j = i + 1;
    while (j < out.length && !(out[j].level && out[j].level <= line.level)) j++;
    line.end = j;
  });
  // a summary (a PLAY RECAP, a workflow's summary) holds its own lines only - a host's counts,
  // a node's status : the line after them (the job's closing line) is not the summary's
  out.forEach((line, i) => {
    const text = plain(line.html);
    const own = /^PLAY RECAP/.test(text)
      ? /^\S.*\s:\s+ok=\d+/
      : /^WORKFLOW \[/.test(text) && line.level === 1
        ? // a node's line : WORKFLOW NODE #1 [build] : successful (lib/workflowSummary.js), or
          // WORKFLOW NODE [build] (successful) in a job from before it
          /^WORKFLOW NODE (\[|#\d)/
        : null;
    if (!own) return;
    let j = i + 1;
    while (j < line.end && (!plain(out[j].html) || own.test(plain(out[j].html)))) j++;
    line.end = j;
  });
  return out;
});

// ─── a host's result, clicked : its details (AppTaskResult) ─────────────────────
// The job's events (the af_events callback plugin) pair with the output's lines : the TASKs in
// order by their name, then within a task each host's result lines (ok, changed, fatal,
// skipping, unreachable) and loop item lines in order. A paired line opens its event's details.
// the events read here, when the page hands none down (the events prop)
const ownEvents = ref([]);
// the events the lines pair with : the page's when it reads them, else this output's own
const events = computed(() => props.events ?? ownEvents.value);
// the event shown in the dialog (its order), null : none
const detailOrder = ref(null);

/**
 * Reads the job's events (their summary : the details are read when one opens), only when the
 * page hands none down. An answer for a job no longer shown is dropped : the job changed while
 * it was read.
 */
async function loadEvents() {
  if (props.events !== null || !props.jobId || !props.numbered) return;
  const id = props.jobId;
  const res = await axios.get(`/api/v2/job/${encodeURIComponent(id)}/events`).catch(() => null);
  if (id !== props.jobId) return;
  ownEvents.value = res?.data?.records || [];
}
onMounted(loadEvents);
// a running job's output grows : its new results' events read too, at most every 3 seconds
let eventsTimer = null;
/**
 * Drops the pending read of the events, when one waits.
 */
function stopEventsTimer() {
  if (eventsTimer) clearTimeout(eventsTimer);
  eventsTimer = null;
}
watch(
  () => props.output,
  () => {
    if (eventsTimer || props.events !== null) return;
    eventsTimer = setTimeout(() => {
      eventsTimer = null;
      loadEvents();
    }, 3000);
  },
);
// another job shown in the same output : the events of the one before go at once (its lines
// would pair with them), its details dialog closes, and the new job's events are read
watch(
  () => props.jobId,
  () => {
    stopEventsTimer();
    ownEvents.value = [];
    detailOrder.value = null;
    loadEvents();
  },
);
// gone : a pending read of the events with it
onBeforeUnmount(stopEventsTimer);

// line index -> the order of its event, for the lines that pair with one that has details
const resultOf = computed(() =>
  pairResultLines(
    lines.value.map((line) => ({ text: plain(line.html), level: line.level })),
    events.value,
  ),
);

/**
 * Opens a host's result's details, when the line clicked is one (and no text is being selected).
 *
 * Args:
 *   index (number): the line's index.
 */
function openResult(index) {
  if (window.getSelection?.()?.toString()) return;
  const order = resultOf.value.get(index);
  if (order !== undefined) detailOrder.value = order;
}

// the result under the mouse : all its lines (its body too) highlighted as one
const hoverOrder = ref(null);

// the folded sections, by their head line's index
const folded = ref(new Set());

/**
 * Folds or unfolds a section.
 *
 * Args:
 *   i (number): its head line's index.
 */
function toggle(i) {
  const next = new Set(folded.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  folded.value = next;
}

/**
 * A workflow card's header, read from its head line : an AWX workflow's node (WORKFLOW NODE
 * [name] (status)) or its summary (WORKFLOW [name] (status)).
 *
 * Args:
 *   line (object): the head line, with its index and its section's end.
 *
 * Returns:
 *   object: { name, kind, status, elapsed } - kind 'node' or 'summary' ; elapsed in
 *   seconds from the workflow's graph, or null.
 */
function headerOf(line) {
  const text = plain(line.html);
  const m = text.match(/^WORKFLOW( NODE)? \[(.*)\] \(([^)]*)\)(?: #(\d+))?/);
  if (m) {
    // the summary at the end (WORKFLOW, not WORKFLOW NODE) : the whole workflow
    const summary = !m[1];
    // by its id (#42) : two nodes may share a name ; by name for a job from before 7.0.0
    const id = m[4] ? Number(m[4]) : null;
    const graphNode = summary
      ? null
      : props.workflow?.nodes?.find((n) => (id !== null ? Number(n.id) === id : n.name === m[2]));
    return {
      id,
      // the node's id in the graph : what its extravars and artifacts are read by
      graphId: graphNode?.id ?? null,
      name: m[2],
      kind: summary ? 'summary' : 'node',
      // AWX's words as the app's own (its pills' labels) : successful a success, canceled aborted
      status: { successful: 'success', canceled: 'aborted' }[m[3]] ?? m[3],
      elapsed: graphNode?.elapsed > 0 ? graphNode.elapsed : null,
    };
  }
  return { id: null, name: text, kind: 'node', status: '', elapsed: null };
}

/**
 * A run time in seconds, short : 12s, 3m 04s.
 *
 * Args:
 *   seconds (number): the seconds.
 *
 * Returns:
 *   string: the run time.
 */
function shortDuration(seconds) {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// a section's lines copied : handed to the page, which copies them as its Copy Output does
const emit = defineEmits(['copy']);

/**
 * Hands a section's lines to the page as plain text : no colours, no line numbers.
 *
 * Args:
 *   node (object): the section's header - its first line's index (-1 : the job's own card,
 *     from its start) and its end.
 */
function copySection(node) {
  const from = node.index < 0 ? run.value.start : node.index + 1;
  const html = lines.value
    .slice(from, node.end)
    .map((l) => l.html)
    .join('<br>');
  const text = new DOMParser().parseFromString(html.replace(/<br>/g, '\n'), 'text/html').body.textContent || '';
  emit('copy', text);
}

// every foldable head : the sections with lines under them, and the job's own card (-1)
const foldable = computed(() => {
  const heads = lines.value.flatMap((l, i) => (l.level && l.end > i + 1 ? [i] : []));
  return run.value ? [-1, ...heads] : heads;
});
// all folded : the toolbar's toggle then expands
const allFolded = computed(() => foldable.value.length > 0 && foldable.value.every((i) => folded.value.has(i)));

/**
 * Folds every section, PLAY and TASK : an overview of the run.
 */
function collapseAll() {
  folded.value = new Set(foldable.value);
}

/**
 * Unfolds everything.
 */
function expandAll() {
  folded.value = new Set();
}

/**
 * A workflow node's output, as the HTML its section holds : its banner and its lines.
 *
 * Args:
 *   node (object|string): the graph's node ({ id, name }), or a name.
 *
 * Returns:
 *   string|null: its lines (joined by <br>), or null when it has none.
 */
function nodeOutput(node) {
  // a node of the graph ({ id, name }) : by its id when the output carries ids, else by name
  const wanted = typeof node === 'object' && node ? node : { id: null, name: node };
  const head = lines.value.find((l) => {
    if (l.level !== 1 || !/^WORKFLOW NODE \[/.test(plain(l.html))) return false;
    const h = headerOf(l);
    return h.id !== null && wanted.id != null ? h.id === Number(wanted.id) : h.name === wanted.name;
  });
  if (!head) return null;
  const i = lines.value.indexOf(head);
  return lines.value
    .slice(i, head.end)
    .map((l) => l.html)
    .join('<br>');
}

// ─── sticky headers, failed tasks ─────────────────────────────────────────────

// the output's element : its node headers measured, a failed task looked up by its line
const rootEl = ref(null);

// a workflow's node header sticks at the top, its PLAY and TASK under it : its height, for them
function measureStickyTop() {
  const head = rootEl.value?.querySelector('.af-node-head');
  rootEl.value?.style.setProperty('--af-sticky-node', head ? `${head.offsetHeight}px` : '0px');
}
onMounted(measureStickyTop);
onUpdated(measureStickyTop);

// what went wrong : the tasks that failed (a fatal: or failed: line under the TASK, unless ansible
// ignored it - ...ignoring : the run went on), each its head line and its name ; with none (a job
// with no ansible tasks - Jenkins, a multistep's summary - or a playbook that failed outside its
// tasks), the error lines : AnsibleForms' own [ERROR]:, a fatal: or a failed:
const failureKind = computed(() => (failedTasks.value.length ? 'task' : 'error'));
const failures = computed(() => (failedTasks.value.length ? failedTasks.value : errorLines.value));
const failedTasks = computed(() => {
  const all = lines.value;
  const found = [];
  all.forEach((l, index) => {
    if (l.level !== 3) return;
    let failed = false;
    for (let j = index + 1; j < l.end; j++) {
      const text = plain(all[j].html);
      if (/^(fatal|failed):/.test(text)) failed = true;
      else if (/^\.\.\.ignoring/.test(text)) failed = false;
    }
    if (failed) found.push({ index, name: (plain(l.html).match(/\[(.*)\]/) || [])[1] || '' });
  });
  return found;
});
const errorLines = computed(() => {
  const all = lines.value;
  // the lines of a task ansible ignored the failure of (...ignoring under it) : not errors
  const ignored = new Set();
  all.forEach((l, index) => {
    if (l.level !== 3) return;
    let hit = false;
    for (let j = index + 1; j < l.end && !hit; j++) hit = /^\.\.\.ignoring/.test(plain(all[j].html));
    if (hit) for (let j = index; j < l.end; j++) ignored.add(j);
  });
  const found = [];
  all.forEach((l, index) => {
    if (ignored.has(index)) return;
    const text = plain(l.html);
    if (/^(\[ERROR\]:|fatal:|failed:)/.test(text)) found.push({ index, name: text.replace(/^\[ERROR\]:\s*/, '') });
  });
  return found;
});

// the failed task just jumped to : highlighted for a moment
const flashed = ref(-1);
let flashTimer = 0;

/**
 * Shows a failed task : the sections around it unfolded, its TASK line at the top (under the
 * sticky headers), highlighted for a moment.
 *
 * Args:
 *   n (number): its place among the failures.
 */
async function goToFailure(n) {
  const failure = failures.value[n];
  if (!failure) return;
  // the sections that hold it, unfolded (and itself)
  const next = new Set(folded.value);
  lines.value.forEach((l, i) => {
    if (l.level && i <= failure.index && l.end > failure.index) next.delete(i);
  });
  if (run.value && failure.index >= run.value.start && failure.index < run.value.end) next.delete(-1);
  folded.value = next;
  await nextTick();
  const el = rootEl.value?.querySelector(`[data-line="${failure.index}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  flashed.value = failure.index;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flashed.value = -1), 1600);
}

// ─── links to a line : #L45 in the address ───────────────────────────────────

const route = useRoute();
const router = useRouter();
// the line the address names, highlighted ; the address already shown (not scrolled to again as
// a running job's output grows)
const targetLine = ref(-1);
let shownHash = '';

/**
 * A line's address : this page with #L<its number>.
 *
 * Args:
 *   index (number): the line.
 *
 * Returns:
 *   string: the address.
 */
function lineHref(index) {
  return router.resolve({ path: route.path, query: route.query, hash: `#L${index + 1}` }).href;
}

/**
 * A line number clicked : the address names it, the line highlighted (it is in sight : no scroll).
 *
 * Args:
 *   index (number): the line.
 */
function linkLine(index) {
  shownHash = `#L${index + 1}`;
  targetLine.value = index;
  router.replace({ path: route.path, query: route.query, hash: shownHash }).catch(() => {});
}

// the address names a line : once it is in the output, the sections around it unfolded, scrolled to
// the middle of the window, highlighted
async function showHashLine() {
  {
    if (!props.lineLinks) return;
    const m = /^#L(\d+)$/.exec(route.hash || '');
    if (!m) {
      targetLine.value = -1;
      shownHash = '';
      return;
    }
    if (route.hash === shownHash) return;
    const index = Number(m[1]) - 1;
    if (index < 0 || index >= lines.value.length) return;
    shownHash = route.hash;
    const next = new Set(folded.value);
    lines.value.forEach((l, i) => {
      if (l.level && i < index && l.end > index) next.delete(i);
    });
    if (run.value && index >= run.value.start && index < run.value.end) next.delete(-1);
    folded.value = next;
    targetLine.value = index;
    await nextTick();
    rootEl.value?.querySelector(`[data-line="${index}"]`)?.scrollIntoView({ block: 'center' });
  }
}
// once mounted (all of this component set up), then each time the address or the output changes
onMounted(showHashLine);
watch(() => [route.hash, lines.value.length], showHashLine);

// the job page's toolbar folds and unfolds it all, and goes from failure to failure ; the
// workflow's graph shows a node's output
defineExpose({ collapseAll, expandAll, allFolded, nodeOutput, failures, failureKind, goToFailure });

// the lines shown : those inside a folded section left out
const shown = computed(() => {
  const result = [];
  for (let i = 0; i < lines.value.length; i++) {
    const line = lines.value[i];
    result.push({ ...line, index: i });
    if (line.level && folded.value.has(i)) i = line.end - 1;
  }
  return result;
});

/**
 * Whether a line is AnsibleForms' own (the run's start and end : ok: [Running on RTE ...],
 * ok: [AWX job 4821 created, tracking]) rather than the playbook's - its brackets hold words,
 * where a playbook's ok: [host] holds a host.
 *
 * Args:
 *   line (object): the line.
 *
 * Returns:
 *   boolean: true when it is AnsibleForms' own.
 */
function ownLine(line) {
  return /^ok: \[[^\]]*\s[^\]]*\]/.test(plain(line.html));
}

// the job's own card (a playbook, an AWX job template) : its lines, its header and its status
const run = computed(() => {
  const all = lines.value;
  if (!all.length || all.some((l) => l.level === 1)) return null;
  // its start : after AnsibleForms' own lines (and the blank ones among them)
  let start = 0;
  while (start < all.length && (ownLine(all[start]) || !plain(all[start].html))) start++;
  // its end : after the recap's own lines, else the output's end
  const recap = all.findIndex((l) => /^PLAY RECAP/.test(plain(l.html)));
  const end = recap >= 0 ? all[recap].end : all.length;
  if (start >= end) return null;
  // its status : failed when a host failed or was unreachable in the recap
  let status = '';
  if (recap >= 0) {
    const counts = all.slice(recap + 1, end).map((l) => plain(l.html));
    status = counts.some((c) => /(failed|unreachable)=[1-9]/.test(c)) ? 'failed' : 'success';
  }
  return { start, end, status };
});

// the shown lines in cards : an AWX workflow's nodes (and its summary) each a card, its head
// line the card's header ; else the job's own card (its PLAYs, TASKs and recap folding inside).
// The lines before the first card, and those after the last (the job's closing line), a framed
// group of their own
const groups = computed(() => {
  if (run.value) {
    const { start, end, status } = run.value;
    const before = shown.value.filter((l) => l.index < start);
    const inside = folded.value.has(-1) ? [] : shown.value.filter((l) => l.index >= start && l.index < end);
    const after = shown.value.filter((l) => l.index >= end);
    const node = { name: props.title, kind: 'job', status, elapsed: null, index: -1, end, count: end - start };
    return [
      { node: null, lines: before },
      { node, lines: inside },
      { node: null, lines: after },
    ].filter((g) => g.node || g.lines.length);
  }
  const result = [{ node: null, lines: [] }];
  for (const line of shown.value) {
    const current = result[result.length - 1];
    if (line.level === 1) {
      result.push({
        node: { ...headerOf(line), index: line.index, end: line.end, count: line.end - line.index - 1 },
        lines: [],
      });
    } else if (current.node && line.index >= current.node.end) {
      result.push({ node: null, lines: [line] });
    } else {
      current.lines.push(line);
    }
  }
  return result.filter((g) => g.node || g.lines.length);
});

// ─── the job's log file : a card of its own, in the output's look ────────────

// its lines (lib/jobLog.js : a log line's timestamp quiet, its level in the output's colours)
const logLines = computed(() => jobLogLines(props.jobLog));
// folded by its header, as a section of the output
const logFolded = ref(false);

/**
 * Hands the log file to the page as plain text, as a section's copy does.
 */
function copyLog() {
  // eslint-disable-next-line no-control-regex -- \x1B is the ANSI escape byte we strip
  emit('copy', String(props.jobLog || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''));
}
</script>
<template>
  <slot name="title"></slot>
  <!-- numbered : each line its number, each PLAY and TASK a caret that folds it ; an AWX
       workflow's nodes each a card, its header folding it -->
  <div
    v-if="numbered"
    ref="rootEl"
    class="af-ansible-groups"
    :class="{ 'af-ansible-has-nodes': groups.some((g) => g.node) }"
  >
    <div
      v-for="group in groups"
      :key="group.node ? group.node.index : 'lines' + group.lines[0].index"
      :class="{ 'af-node-card': group.node }"
    >
      <!-- a section's header : folds it (click, Enter, Space) ; its copy button copies its lines -->
      <div
        v-if="group.node"
        class="af-node-head"
        role="button"
        tabindex="0"
        :aria-expanded="!folded.has(group.node.index)"
        @click="toggle(group.node.index)"
        @keydown.enter.self.prevent="toggle(group.node.index)"
        @keydown.space.self.prevent="toggle(group.node.index)"
      >
        <FaIcon :icon="folded.has(group.node.index) ? 'chevron-right' : 'chevron-down'" class="af-node-chevron" />
        <FaIcon v-if="group.node.kind == 'summary'" icon="flag-checkered" class="af-node-flag" />
        <FaIcon v-else-if="group.node.kind == 'job'" icon="scroll" class="af-node-flag" />
        <span class="af-node-name">{{ group.node.name }}</span>
        <AppStatusPill v-if="group.node.status" :status="group.node.status" />
        <span class="af-node-meta">
          <!-- a workflow node : its extravars and its artifacts (always offered, {} when none),
               then a bar, then its numbers -->
          <template v-if="jobId && group.node.kind === 'node' && group.node.graphId != null">
            <span class="af-node-tools">
              <button
                v-if="store.profile.options?.showExtraVars"
                type="button"
                class="af-node-tool"
                :class="{ active: nodeData[group.node.index] === 'extravars' }"
                @click.stop="toggleNodeData(group.node.index, 'extravars')"
              >
                <FaIcon :icon="nodeData[group.node.index] === 'extravars' ? 'eye-slash' : 'eye'" />{{
                  nodeData[group.node.index] === 'extravars' ? t('jobs.hideExtravars') : t('jobs.showExtravars')
                }}
              </button>
              <button
                v-if="store.profile.options?.showArtifacts"
                type="button"
                class="af-node-tool"
                :class="{ active: nodeData[group.node.index] === 'artifacts' }"
                @click.stop="toggleNodeData(group.node.index, 'artifacts')"
              >
                <FaIcon
                  :icon="nodeData[group.node.index] === 'artifacts' ? 'square-poll-horizontal' : 'square-poll-vertical'"
                />{{ nodeData[group.node.index] === 'artifacts' ? t('jobs.hideArtifacts') : t('jobs.showArtifacts') }}
              </button>
            </span>
            <span
              v-if="store.profile.options?.showExtraVars || store.profile.options?.showArtifacts"
              class="af-node-sep"
              aria-hidden="true"
            ></span>
          </template>
          <span v-if="group.node.elapsed"><FaIcon icon="stopwatch" />{{ shortDuration(group.node.elapsed) }}</span>
          <span><FaIcon icon="list-ol" />{{ group.node.count }}</span>
          <button
            type="button"
            class="af-node-copy"
            :title="copyLabel"
            :aria-label="copyLabel"
            @click.stop="copySection(group.node)"
          >
            <FaIcon icon="copy" />
          </button>
        </span>
      </div>
      <!-- under the header : its extravars or artifacts, and its lines (a node's dialog scrolls
           this part only, the header staying in place) -->
      <div v-if="(group.node && nodeData[group.node.index]) || group.lines.length" class="af-node-body">
        <AppNodeData
          v-if="group.node && nodeData[group.node.index]"
          :jobId="jobId"
          :nodeId="group.node.graphId"
          :kind="nodeData[group.node.index]"
          @close="toggleNodeData(group.node.index, nodeData[group.node.index])"
          @copy="(text) => emit('copy', text)"
        />
        <div v-if="group.lines.length" class="ansible af-ansible-lines">
          <div
            v-for="line in group.lines"
            :key="line.index"
            class="af-ansible-line"
            :class="[
              {
                'af-ansible-head': line.level,
                'af-ansible-flash': flashed === line.index,
                'af-ansible-target': targetLine === line.index,
              },
              line.level ? `af-ansible-l${line.level}` : '',
            ]"
            :data-line="line.index"
          >
            <a
              v-if="lineLinks"
              class="af-ansible-no af-ansible-anchor"
              :href="lineHref(line.index)"
              @click.prevent="linkLine(line.index)"
              >{{ line.index + 1 }}</a
            >
            <span v-else class="af-ansible-no">{{ line.index + 1 }}</span>
            <span class="af-ansible-fold">
              <button
                v-if="line.level && line.end > line.index + 1"
                type="button"
                class="af-ansible-caret"
                :aria-expanded="!folded.has(line.index)"
                @click="toggle(line.index)"
              >
                <FaIcon :icon="folded.has(line.index) ? 'caret-right' : 'caret-down'" />
              </button>
            </span>
            <span
              class="af-ansible-text"
              :class="{
                'af-ansible-result': resultOf.has(line.index),
                'af-ansible-result-hover': hoverOrder !== null && resultOf.get(line.index) === hoverOrder,
              }"
              :title="resultOf.has(line.index) ? t('jobs.taskResult.open') : undefined"
              @click="openResult(line.index)"
              @mouseenter="hoverOrder = resultOf.get(line.index) ?? null"
              @mouseleave="hoverOrder = null"
              ><span v-html="line.html"></span
              ><span v-if="folded.has(line.index)" class="af-ansible-more" @click="toggle(line.index)">{{
                line.end - line.index - 1
              }}</span></span
            >
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="ansible" v-html="output"></div>
  <AppTaskResult v-if="detailOrder !== null" :jobId="jobId" :order="detailOrder" @close="detailOrder = null" />
  <!-- the job's log file : a section with its header, as the output's own, its lines numbered -->
  <div v-if="logLines.length" class="af-logfile af-node-card">
    <div
      class="af-node-head"
      role="button"
      tabindex="0"
      :aria-expanded="!logFolded"
      @click="logFolded = !logFolded"
      @keydown.enter.self.prevent="logFolded = !logFolded"
      @keydown.space.self.prevent="logFolded = !logFolded"
    >
      <FaIcon :icon="logFolded ? 'chevron-right' : 'chevron-down'" class="af-node-chevron" />
      <FaIcon icon="file-lines" class="af-node-flag" />
      <span class="af-node-name">{{ t('jobs.logFile') }}</span>
      <span class="af-node-meta">
        <span><FaIcon icon="list-ol" />{{ logLines.length }}</span>
        <button type="button" class="af-node-copy" :title="copyLabel" :aria-label="copyLabel" @click.stop="copyLog">
          <FaIcon icon="copy" />
        </button>
      </span>
    </div>
    <div v-if="!logFolded" class="ansible af-ansible-lines">
      <div v-for="(line, i) in logLines" :key="i" class="af-ansible-line" :class="line.level && `af-log-${line.level}`">
        <span class="af-ansible-no">{{ i + 1 }}</span>
        <span class="af-ansible-fold"></span>
        <span class="af-ansible-text" v-html="line.html"></span>
      </div>
    </div>
  </div>
</template>
<style lang="scss">
/* a host's result line with details : a click opens them (AppTaskResult), as in AWX */
.af-ansible-result {
  cursor: pointer;
}
.af-ansible-result-hover {
  background: color-mix(in srgb, var(--bs-primary) 12%, transparent);
}
.has-text-weight-bold {
  font-weight: bold;
}

.ansible {
  font-family: monospace;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 0.8rem;
  padding: 1rem;
  margin-bottom: 1rem;
  /* the fields' darker border, as the inputs and a repository's output */
  border: 1px solid var(--af-field-border);
  border-radius: 5px;
  background-color: var(--af-output-bg);

  span {
    &.tag {
      display: inline-block !important;
      padding: 0 0.2rem;
      border-radius: 3px;
      &.is-info {
        background-color: var(--af-ansible-output-bg-timestamp) !important;
        color: var(--af-ansible-output-timestamp) !important;
      }
      &.is-warning {
        background-color: var(--af-ansible-output-warning) !important;
        color: var(--bs-light) !important;
      }
      &.is-danger {
        background-color: var(--af-ansible-output-danger) !important;
        color: var(--bs-light) !important;
      }
      &.is-purple {
        background-color: var(--af-ansible-output-purple) !important;
        color: var(--bs-light) !important;
      }
      &.is-success {
        background-color: var(--af-ansible-output-success) !important;
        color: var(--bs-light) !important;
      }
    }
  }

  .has-text-danger {
    color: var(--af-ansible-output-danger) !important;
  }

  /* the -text-* variants, not the saturated ones used for the tag backgrounds :
           #198754 / #ff8800 as text on the pane background fail WCAG AA */
  .has-text-success {
    color: var(--af-ansible-output-text-success) !important;
  }

  .has-text-warning {
    color: var(--af-ansible-output-text-warning) !important;
  }

  /* a skipping, included or ignoring line : blue, as ansible prints it (its cyan) */
  .has-text-info {
    color: var(--af-ansible-output-text-info) !important;
  }

  /* a warning or deprecation : ansible's purple */
  .has-text-purple {
    color: var(--af-ansible-output-text-purple) !important;
  }

  /* a retry : ansible's grey */
  .has-text-muted {
    color: var(--bs-secondary-color) !important;
  }
}
/* a section's header (a workflow's node, the job's own card) sticks at the top while its lines
   scroll by ; the next section's header takes its place */
.af-ansible-groups {
  --af-sticky-node: 0px;
}
.af-ansible-has-nodes .af-node-head {
  position: sticky;
  /* under a multistep job's step title when there is one (pages/jobs.vue) */
  top: var(--af-step-title, 0px);
  z-index: 3;
}
.af-ansible-lines.ansible .af-ansible-line {
  /* a failed task or an error line jumped to : under the pinned headers, not hidden by them */
  scroll-margin-top: calc(var(--af-step-title, 0px) + var(--af-sticky-node));
}
/* a line number : a link to its line, quiet until pointed at */
.af-ansible-lines.ansible .af-ansible-anchor {
  color: var(--bs-tertiary-color);
  text-decoration: none;
  cursor: pointer;
  &:hover {
    color: var(--bs-link-color);
    text-decoration: underline;
  }
}
/* the line the address names (#L45) : marked until another is picked */
.af-ansible-lines.ansible .af-ansible-target {
  background: var(--bs-warning-bg-subtle);
  .af-ansible-anchor {
    color: var(--bs-body-color);
    font-weight: 600;
  }
}
/* a failed task jumped to : highlighted for a moment */
.af-ansible-lines.ansible .af-ansible-flash {
  animation: af-flash 1.6s ease-out;
}
@keyframes af-flash {
  0%,
  40% {
    background: var(--bs-danger-bg-subtle);
  }
}
@media (prefers-reduced-motion: reduce) {
  .af-ansible-lines.ansible .af-ansible-flash {
    animation: none;
    background: var(--bs-danger-bg-subtle);
  }
}
.af-ansible-lines.ansible {
  /* the gutter from the panel's left edge : the numbers and carets in the server log's grey
     column, the whole height */
  padding: 0.5rem 0;
  font-size: 0.875rem;
  background: linear-gradient(
    to right,
    var(--af-output-gutter-bg) 4rem,
    var(--af-field-border) 4rem,
    var(--af-field-border) calc(4rem + 1px),
    var(--af-output-bg) calc(4rem + 1px)
  );
  .af-ansible-line {
    display: flex;
    align-items: flex-start;
    min-height: 1.2em;
    &:hover {
      background: var(--af-row-hover-bg);
    }
  }
  .af-ansible-no {
    flex: 0 0 2.75rem;
    padding-right: 0.5rem;
    text-align: right;
    color: var(--bs-tertiary-color);
    user-select: none;
  }
  .af-ansible-fold {
    flex: 0 0 1.25rem;
    display: flex;
    justify-content: center;
  }
  .af-ansible-caret {
    padding: 0;
    border: 0;
    background: none;
    line-height: 1.2;
    color: var(--bs-secondary-color);
    cursor: pointer;
    &:hover {
      color: var(--bs-body-color);
    }
  }
  .af-ansible-text {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0 1rem 0 0.75rem;
  }
  /* a folded section : how many lines it hides, a click unfolds it */
  .af-ansible-more {
    margin-left: 0.5rem;
    padding: 0 0.4rem;
    border-radius: 0.25rem;
    background: var(--bs-secondary-bg);
    color: var(--bs-secondary-color);
    cursor: pointer;
    &::before {
      content: '+';
    }
  }
}
/* the output in sections, flat inside the panel's one frame (as a CI run's steps) : the lines
   before the first section, each section (the job, a workflow's node, its summary) and the
   closing line one under the other, a hairline between them, no frame of their own ; the
   line numbers' grey column runs through them all */
.af-ansible-groups.af-ansible-has-nodes {
  display: flex;
  flex-direction: column;
  > * + * {
    border-top: 1px solid var(--af-field-border);
  }
  .ansible {
    margin: 0;
    border: 0;
    border-radius: 0;
  }
}
.af-node-card {
  /* the header and the lines under it : the frame's darker grey, as between the sections */
  .af-node-head:not(:last-child) {
    border-bottom: 1px solid var(--af-field-border);
  }
}
.af-node-head {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 0.625rem 1rem;
  border: 0;
  background: var(--bs-tertiary-bg);
  text-align: left;
  color: var(--bs-body-color);
  &:hover {
    background: var(--af-row-hover-bg);
  }
  &:focus-visible {
    outline: 0;
    box-shadow: inset 0 0 0 0.2rem var(--bs-focus-ring-color);
  }
}
.af-node-head {
  cursor: pointer;
  user-select: none;
}
/* a section's copy : quiet, its colour the meta's, a soft background on hover */
.af-node-copy {
  /* closer to the line count than the meta's own gap */
  margin-left: -0.5rem;
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.4rem;
  border: 0;
  border-radius: 0.25rem;
  background: none;
  color: inherit;
  svg {
    margin: 0 !important;
  }
  &:hover {
    background: var(--bs-secondary-bg);
    color: var(--bs-body-color);
  }
  &:focus-visible {
    outline: 0;
    box-shadow: 0 0 0 0.2rem var(--bs-focus-ring-color);
  }
}
/* a node's Show extravars and Show artifacts : text buttons, the copy button's look */
.af-node-tools {
  display: inline-flex;
  gap: 0.25rem;
}
.af-node-tool {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.45rem;
  border: 0;
  border-radius: 0.25rem;
  background: none;
  color: inherit;
  white-space: nowrap;
  &:hover,
  &.active {
    background: var(--bs-secondary-bg);
    color: var(--bs-body-color);
  }
  &:focus-visible {
    outline: 0;
    box-shadow: 0 0 0 0.2rem var(--bs-focus-ring-color);
  }
}
/* the bar between them and the node's numbers */
.af-node-sep {
  align-self: stretch;
  width: 1px;
  margin: 0.15rem 0;
  background: var(--af-field-border, var(--bs-border-color));
}
.af-node-chevron {
  width: 0.75rem;
  color: var(--bs-secondary-color);
}
.af-node-name {
  font-weight: 600;
}
/* the workflow's summary at the end : a flag before its name */
.af-node-flag {
  color: var(--bs-secondary-color);
}
.af-node-meta {
  display: inline-flex;
  align-items: center;
  gap: 1rem;
  margin-left: auto;
  font-size: 0.8rem;
  color: var(--bs-secondary-color);
  font-variant-numeric: tabular-nums;
  svg {
    margin-right: 0.3rem;
  }
}
.af-logfile {
  /* on its own : framed as the output ; inside a job's panel the panel frames it (jobOutput.scss) */
  margin-top: 1rem;
  border: 1px solid var(--af-field-border);
  border-radius: 5px;
  overflow: hidden;
  .ansible {
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  .af-ansible-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* a log line's timestamp quiet, its level word bold in its colour (lib/jobLog.js) */
  .af-log-time {
    color: var(--bs-secondary-color);
  }
  .af-log-level {
    font-weight: 600;
  }
  /* an error or a warning line : a mark in the line numbers' column, as an annotation */
  .af-log-error .af-ansible-no {
    box-shadow: inset -3px 0 0 var(--af-ansible-output-danger);
  }
  .af-log-warning .af-ansible-no {
    box-shadow: inset -3px 0 0 var(--af-ansible-output-warning);
  }
}
</style>
