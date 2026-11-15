<script setup>
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
// the node's link : Font Awesome's external link (a square with an arrow), drawn as a path in the graph
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import { workflowEdges, conditionText } from '@/lib/workflowEdges';

/******************************************************************/
/*                                                                */
/*  Awx Workflow component                                        */
/*  Visualize an awx workflow job as a graph, similar to the      */
/*  awx workflow output view.  Nodes are painted by status        */
/*  (green=successful, red=failed, ...) and the links are         */
/*  painted by relation (success, failure, always) ; Ascender's   */
/*  conditional links are dashed, in their trigger's color, a     */
/*  diamond on them showing their condition when hovered. A node  */
/*  carried over from the run a relaunch from the failed node     */
/*  relaunched is greyed, "from the previous run" ; one forced as */
/*  successful (Ascender) says so, its reason in its hover card ; */
/*  a node with retries (Ascender) shows how many it made, and    */
/*  one waiting for its retry is retrying, not failed (#1082)     */
/*                                                                */
/*  @props:                                                       */
/*      workflow: Object                                          */
/*        { id, name, status, nodes: [                            */
/*            { id, name, type, status, elapsed,                  */
/*              success_nodes, failure_nodes, always_nodes,       */
/*              condition_edges, carried, forced_success,         */
/*              forced_success_reason, max_retries,               */
/*              retry_attempts } ] }                              */
/*                                                                */
/******************************************************************/

// its path, in a 512 x 512 box (the icon's own)
const LINK_ICON = faArrowUpRightFromSquare.icon[4];
const props = defineProps({
  workflow: {
    type: Object,
    required: true,
  },
  // the product the workflow ran on (AWX, AAP, Ascender) : a node's link opens its job there
  product: { type: String, default: 'AWX' },
});

const { t } = useI18n();

// the graph at its size (scrolled sideways when wider than the panel), or shrunk to its width
const fit = ref(false);

// ─── full screen : zoom and pan ───────────────────────────────────────────────
// the graph's place and zoom in the window : moved by x, y and scaled by k
const stage = ref(null);
const view = ref({ x: 0, y: 0, k: 1 });
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const clampZoom = (k) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/**
 * Zooms around a point of the window, which stays where it is (the pointer, or the middle).
 *
 * Args:
 *   k (number): the new zoom.
 *   px (number): the point's x in the svg, by default its middle.
 *   py (number): the point's y in the svg, by default its middle.
 */
function zoomTo(k, px, py) {
  const r = stage.value?.getBoundingClientRect();
  if (!r) return;
  const x0 = px ?? r.width / 2;
  const y0 = py ?? r.height / 2;
  const { x, y, k: k0 } = view.value;
  const k1 = clampZoom(k);
  view.value = { k: k1, x: x0 - ((x0 - x) * k1) / k0, y: y0 - ((y0 - y) * k1) / k0 };
}

/**
 * Zooms in or out by a factor, around the middle.
 *
 * Args:
 *   factor (number): more than 1 zooms in.
 */
function zoomBy(factor) {
  zoomTo(view.value.k * factor);
}

/**
 * The whole graph in the window, in its middle : at actual size, or smaller when it is larger.
 */
function fitView() {
  const r = stage.value?.getBoundingClientRect();
  if (!r) return;
  const k = clampZoom(Math.min(1, (r.width - 48) / graph.value.width, (r.height - 48) / graph.value.height));
  view.value = { k, x: (r.width - graph.value.width * k) / 2, y: (r.height - graph.value.height * k) / 2 };
}

/**
 * The wheel zooms, around the pointer (full screen only : the page scrolls otherwise).
 *
 * Args:
 *   e (WheelEvent): the wheel turned.
 */
function onWheel(e) {
  if (!fullscreen.value) return;
  e.preventDefault();
  const r = stage.value.getBoundingClientRect();
  zoomTo(view.value.k * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}

// a drag moves the graph : where it started, and where the graph was then
const dragging = ref(false);
let dragStart = null;

/**
 * Starts a drag (full screen only).
 *
 * Args:
 *   e (PointerEvent): the button pressed.
 */
function onPointerDown(e) {
  if (!fullscreen.value || e.button !== 0) return;
  dragStart = { px: e.clientX, py: e.clientY, x: view.value.x, y: view.value.y };
}

/**
 * Moves the graph with the pointer : a drag once it went a few pixels (less is a click, on a
 * node it opens the node's output).
 *
 * Args:
 *   e (PointerEvent): the pointer moved.
 */
function onPointerMove(e) {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.px;
  const dy = e.clientY - dragStart.py;
  if (!dragging.value) {
    if (Math.hypot(dx, dy) < 4) return;
    dragging.value = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  view.value = { ...view.value, x: dragStart.x + dx, y: dragStart.y + dy };
}

// the click a drag ends with : not a click on a node
let justDragged = false;

/**
 * Ends a drag.
 */
function onPointerUp() {
  justDragged = dragging.value;
  setTimeout(() => (justDragged = false));
  dragging.value = false;
  dragStart = null;
}

// ─── a node's output ──────────────────────────────────────────────────────────
const emit = defineEmits(['node']);

/**
 * Whether a node has output to show : it ran (an AWX job of its own).
 *
 * Args:
 *   n (object): the node.
 *
 * Returns:
 *   boolean: true when it ran.
 */
function hasOutput(n) {
  return !!n.job && n.status !== 'skipped' && !n.do_not_run;
}

/**
 * A click on a node that ran : the page opens its output (not the click a drag ends with).
 *
 * Args:
 *   n (object): the node clicked.
 */
function openNode(n) {
  if (justDragged || !hasOutput(n)) return;
  emit('node', n);
}

// the panel over the whole window (its toolbar, the graph at full size), and back : Esc, the
// button or a click beside it closes it ; the page under it does not scroll meanwhile
const fullscreen = ref(false);
// the graph hidden under its toolbar (the collapse at the toolbar's left), the page's output closer
const collapsed = ref(false);
/**
 * Closes the full screen on Esc.
 *
 * Args:
 *   e (KeyboardEvent): the key pressed.
 */
function onKey(e) {
  // a dialog over the full screen (a node's output) closes first
  if (e.key === 'Escape' && !e.defaultPrevented) fullscreen.value = false;
}
watch(fullscreen, (on) => {
  // opened : the whole graph in the middle of the window
  if (on) nextTick(fitView);
  document.body.style.overflow = on ? 'hidden' : '';
  if (on) document.addEventListener('keydown', onKey);
  else document.removeEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});

// layout constants
const NODE_W = 170;
const NODE_H = 52;
const GAP_X = 60;
const GAP_Y = 24;
const MARGIN = 15;
const START_W = 70;
const START_H = 32;

// node colors by awx job status
const statusColors = {
  successful: 'var(--bs-success)',
  failed: 'var(--bs-danger)',
  error: 'var(--bs-danger)',
  unreachable: 'var(--bs-danger)',
  running: 'var(--bs-primary)',
  // a failed attempt waiting for its retry (Ascender) : still under way
  retrying: 'var(--bs-primary)',
  canceled: 'var(--bs-warning)',
};
// link colors by relation type
const edgeColors = {
  success: 'var(--bs-success)',
  failure: 'var(--bs-danger)',
  always: 'var(--bs-info)',
  start: 'var(--bs-secondary)',
};

function statusColor(status) {
  return statusColors[status] || 'var(--bs-secondary)';
}

/**
 * A node's color : its status's, grey for a node carried over from the previous run (it did not
 * run in this one).
 *
 * Args:
 *   n (object): the node.
 *
 * Returns:
 *   string: a CSS color.
 */
function nodeColor(n) {
  return n?.carried ? 'var(--bs-secondary)' : statusColor(n?.status);
}

/**
 * What a node's second line says before its time : its status ; forced as successful, or carried
 * over from the previous run, that instead (one line, the node's width).
 *
 * Args:
 *   n (object): the node.
 *
 * Returns:
 *   string: the text.
 */
function nodeStatusText(n) {
  if (n?.forced_success) return t('workflow.forcedSuccess');
  if (n?.carried) return t('workflow.fromPreviousRun');
  return n?.status || '';
}

/**
 * A node's status line under its name : its status and its time, joined by " · " as one text
 * (separate template parts lost the space before the dot). Its retries are drawn apart, at the
 * right (retriesX).
 *
 * Args:
 *   n (object): the node.
 *
 * Returns:
 *   string: e.g. "failed · 5s".
 */
function statusLine(n) {
  return [nodeStatusText(n), n?.elapsed > 0 ? `${Math.round(n.elapsed)}s` : ''].filter(Boolean).join(' · ');
}

/**
 * Where a node's retries (↻ 2/2) end, on its status line : at its right, before its link to the
 * product when it has one.
 *
 * Args:
 *   n (object): the node.
 *   x (number): the node's left edge.
 *
 * Returns:
 *   number: the x the text ends at (text-anchor end).
 */
function retriesX(n, x) {
  return x + NODE_W - (n?.ui_url ? 34 : 10);
}

/**
 * How many retries a node with retries made, of how many it may (Ascender's retry_attempts and
 * max_retries) : ↻ 1/2 ; '' for a node without retries, or one not retried (it succeeded at once).
 *
 * Args:
 *   n (object): the node.
 *
 * Returns:
 *   string: the text.
 */
function retriesText(n) {
  return n?.max_retries > 0 && n.retry_attempts > 0 ? `↻ ${n.retry_attempts}/${n.max_retries}` : '';
}

// a smooth bezier link between 2 points
function linkPath(x1, y1, x2, y2) {
  const dx = Math.max(30, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function truncate(s, len = 20) {
  return s && s.length > len ? s.slice(0, len - 1) + '…' : s;
}

// ─── the node under the pointer : its card, the full name ─────────────────────
// A node shows its name cut to its width ; hovered, a card over it shows the whole name, as
// wide as the name needs (at least the node's), measured in the node's own font. It ignores
// the pointer, so the node under it keeps its hover and its click.
const hovered = ref(null);
// the node in focus : the hovered one ; it and its links stand out, the rest fades
const focused = hovered;
// the focused node's own links ; every other node faded, the ones it links to too
const related = computed(() => {
  const id = focused.value?.id;
  if (id == null) return null;
  const links = new Set();
  const nodes = new Set([id]);
  graph.value.links.forEach((l, i) => {
    if (l.from === id || l.to === id) {
      links.add(i);
    }
  });
  return { links, nodes };
});
// the hidden text the name is measured with, and the card's width
const measure = ref(null);
// and the reason a node was forced as successful, on a line of its own under its status
const reasonMeasure = ref(null);
const cardWidth = ref(NODE_W);
const CARD_PAD = 26 + 14; // the name's left offset (the status dot before it), and room after it
// the card's height : a line more for a forced node's reason
const REASON_H = 18;
watch(focused, async (n) => {
  if (!n) return;
  await nextTick();
  const nameWidth = measure.value?.getComputedTextLength?.() || 0;
  const reasonWidth = n.forced_success ? reasonMeasure.value?.getComputedTextLength?.() || 0 : 0;
  cardWidth.value = Math.max(NODE_W, Math.ceil(Math.max(nameWidth, reasonWidth)) + CARD_PAD);
});
/**
 * The reason line of a forced node's card.
 *
 * Args:
 *   n (object): the node.
 *
 * Returns:
 *   string: the reason, '' for a node not forced.
 */
function reasonText(n) {
  return n?.forced_success ? t('workflow.forcedReason', { reason: n.forced_success_reason || '–' }) : '';
}
// the card where the node is, moved left as far as it must to stay inside the graph
const card = computed(() => {
  const n = focused.value;
  if (!n) return null;
  const right = graph.value.width - MARGIN;
  const x = Math.max(MARGIN, Math.min(n.x, right - cardWidth.value));
  return { ...n, cx: x, w: cardWidth.value };
});

// ─── a conditional link (Ascender) under the pointer : its condition ──────────
// Its diamond hovered, a card over it says when the link is taken : on failure, if deploy = true.
// It ignores the pointer, as the node's card does.
const hoveredLink = ref(null);
// the hidden text the condition is measured with, and the card's width
const linkMeasure = ref(null);
const linkCardWidth = ref(0);
const LINK_CARD_H = 24;
const LINK_CARD_PAD = 16;

/**
 * When a conditional link is taken, as its card says it.
 *
 * Args:
 *   l (object): the link ({ trigger, condition }).
 *
 * Returns:
 *   string: its parent's outcome and its condition (or that it is not known).
 */
function linkText(l) {
  if (!l) return '';
  const when = { success: t('workflow.onSuccess'), failure: t('workflow.onFailure'), always: t('workflow.always') }[
    l.trigger
  ];
  return l.condition
    ? t('workflow.conditionIf', { trigger: when, condition: conditionText(l.condition) })
    : t('workflow.conditionUnknown', { trigger: when });
}
watch(hoveredLink, async (l) => {
  // not drawn until measured : no card of the last condition's width, nor of none
  linkCardWidth.value = 0;
  if (!l) return;
  await nextTick();
  linkCardWidth.value = Math.ceil(linkMeasure.value?.getComputedTextLength?.() || 0) + LINK_CARD_PAD;
});
// the card above the diamond (under it when there is no room above), inside the graph
const linkCard = computed(() => {
  const l = hoveredLink.value;
  if (!l || !linkCardWidth.value) return null;
  const w = linkCardWidth.value;
  const x = Math.max(MARGIN, Math.min(l.mx - w / 2, graph.value.width - MARGIN - w));
  const above = l.my - 10 - LINK_CARD_H;
  return { x, y: above >= 0 ? above : l.my + 10, w, text: linkText(l) };
});
// the conditional links, each with its diamond ; the legend shows them only when there are some
const conditionLinks = computed(() => graph.value.links.filter((l) => l.type === 'condition'));

// compute the graph layout (layered DAG, like the awx workflow visualizer)
const graph = computed(() => {
  const nodes = props.workflow?.nodes || [];
  const byId = {};
  nodes.forEach((n) => {
    byId[n.id] = n;
  });
  // collect the links
  const edges = workflowEdges(nodes);
  // roots are nodes without incoming links
  const hasParent = new Set(edges.map((e) => e.to));
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  // depth = longest path from a root (relaxation, awx guarantees a DAG)
  const depth = {};
  nodes.forEach((n) => {
    depth[n.id] = 0;
  });
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    edges.forEach((e) => {
      if (depth[e.from] + 1 > depth[e.to]) {
        depth[e.to] = depth[e.from] + 1;
        changed = true;
      }
    });
    if (!changed) break;
  }
  // group the nodes in columns by depth
  const columns = {};
  nodes.forEach((n) => {
    (columns[depth[n.id]] = columns[depth[n.id]] || []).push(n);
  });
  const maxDepth = Math.max(0, ...Object.keys(columns).map(Number));
  const maxRows = Math.max(1, ...Object.values(columns).map((c) => c.length));
  const height = MARGIN * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;
  const width = MARGIN * 2 + START_W + GAP_X + (maxDepth + 1) * NODE_W + maxDepth * GAP_X;
  // position the nodes, each column vertically centered
  const pos = {};
  Object.entries(columns).forEach(([d, list]) => {
    list.sort((a, b) => a.id - b.id);
    const colH = list.length * NODE_H + (list.length - 1) * GAP_Y;
    const y0 = (height - colH) / 2;
    list.forEach((n, i) => {
      pos[n.id] = {
        x: MARGIN + START_W + GAP_X + Number(d) * (NODE_W + GAP_X),
        y: y0 + i * (NODE_H + GAP_Y),
      };
    });
  });
  const start = { x: MARGIN, y: height / 2 - START_H / 2 };
  // build the link paths : a link over the columns between its nodes arcs above them, higher the
  // more it skips, so it never runs through a node and hides the links that end there (the
  // graph moved down by the room the arcs take above the top row)
  const arcTop = (e) => Math.min(pos[e.from].y, pos[e.to].y) - 16 - 10 * (depth[e.to] - depth[e.from] - 2);
  const skipping = edges.filter((e) => depth[e.to] - depth[e.from] > 1);
  const lift = Math.max(0, ...skipping.map((e) => MARGIN - arcTop(e)));
  if (lift) {
    Object.values(pos).forEach((p) => (p.y += lift));
    start.y += lift;
  }
  const links = edges.map((e) => {
    const x1 = pos[e.from].x + NODE_W;
    const y1 = pos[e.from].y + NODE_H / 2;
    const x2 = pos[e.to].x;
    const y2 = pos[e.to].y + NODE_H / 2;
    // a conditional link : its trigger and condition, and its middle (where its diamond is)
    const extra = { type: e.type, trigger: e.trigger, condition: e.condition, from: e.from, to: e.to };
    if (depth[e.to] - depth[e.from] <= 1)
      return { ...extra, d: linkPath(x1, y1, x2, y2), mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
    const top = arcTop(e);
    return {
      ...extra,
      mx: (x1 + x2) / 2,
      my: top,
      d:
        `M ${x1} ${y1} C ${x1 + GAP_X * 0.6} ${y1}, ${x1 + GAP_X * 0.4} ${top}, ${x1 + GAP_X} ${top} ` +
        `L ${x2 - GAP_X} ${top} C ${x2 - GAP_X * 0.4} ${top}, ${x2 - GAP_X * 0.6} ${y2}, ${x2} ${y2}`,
    };
  });
  roots.forEach((r) => {
    links.push({
      type: 'start',
      from: 'start',
      to: r.id,
      d: linkPath(start.x + START_W, start.y + START_H / 2, pos[r.id].x, pos[r.id].y + NODE_H / 2),
    });
  });
  return {
    nodes: nodes.map((n) => ({ ...n, ...pos[n.id] })),
    links,
    width,
    height: height + lift,
    start,
  };
});

// ─── a running workflow : the graph follows its work ──────────────────────────
// While the workflow runs, the graph slides sideways to keep the node running now in sight (the
// rightmost one, when several run at once) : the run reads left to right on its own. Scrolled
// away from it by the reader, it stays where it is put, a button at its right to follow again
// (as the server log's while scrolled up) ; scrolled back to it, it follows again. An ended
// workflow stays where the reader left it ; at its width (Fit to screen) or full screen, nothing
// to slide.
const scrollBox = ref(null);
const following = ref(true);
const isRunning = computed(() => props.workflow?.status === 'running');
const runningRight = computed(() => {
  if (!isRunning.value) return null;
  const running = graph.value.nodes.filter((n) => n.status === 'running' || n.status === 'retrying');
  return running.length ? Math.max(...running.map((n) => n.x)) : null;
});
// a slide the graph makes itself : its scroll events are not the reader's
let sliding = false;
let slideTimer = 0;

/**
 * Whether the running node is in sight in the panel, with room around it.
 *
 * Returns:
 *   boolean: true when it is (or when none runs).
 */
function runningInSight() {
  const box = scrollBox.value;
  const x = runningRight.value;
  if (!box || x == null) return true;
  return x >= box.scrollLeft + MARGIN && x + NODE_W <= box.scrollLeft + box.clientWidth - MARGIN;
}

/**
 * Brings the running node to the middle of the panel.
 */
function slideToRunning() {
  const box = scrollBox.value;
  const x = runningRight.value;
  if (!box || x == null) return;
  sliding = true;
  clearTimeout(slideTimer);
  slideTimer = setTimeout(() => (sliding = false), 700);
  box.scrollTo({ left: Math.max(0, x + NODE_W / 2 - box.clientWidth / 2), behavior: 'smooth' });
}

// the reader scrolled the graph : away from the running node, it stays put ; back to it, it follows
function onGraphScroll() {
  if (sliding || !isRunning.value) return;
  following.value = runningInSight();
}

// the button : follows the running node again
function followRunning() {
  following.value = true;
  slideToRunning();
}

watch(runningRight, async (x) => {
  if (x == null || fit.value || fullscreen.value || !following.value) return;
  await nextTick();
  if (!runningInSight()) slideToRunning();
});
// a new run (relaunched) : followed again
watch(isRunning, (now) => {
  if (now) following.value = true;
});
onBeforeUnmount(() => clearTimeout(slideTimer));
</script>
<template>
  <!-- a panel as the job's output : its toolbar on top - what it is at the left, the legend and
       the fit at the right - and the graph under it, scrolled sideways when it is wider -->
  <!-- full screen : the panel lifted over the page (teleported, so no card clips it), a dimmed
       backdrop under it -->
  <Teleport to="body" :disabled="!fullscreen">
    <div v-if="fullscreen" class="awx-workflow-backdrop" @click="fullscreen = false" />
    <div
      class="awx-workflow"
      :class="{ 'awx-fullscreen': fullscreen, 'awx-collapsed': collapsed && !fullscreen }"
      :role="fullscreen ? 'dialog' : null"
    >
      <div class="awx-workflow-toolbar">
        <div class="awx-workflow-label">
          <!-- hide or show the graph, as the output's collapse : the toolbar stays -->
          <button
            v-if="!fullscreen"
            type="button"
            class="af-tool-btn af-tool-icon awx-collapse"
            :title="collapsed ? t('workflow.expand') : t('workflow.collapse')"
            :aria-label="collapsed ? t('workflow.expand') : t('workflow.collapse')"
            :aria-expanded="!collapsed"
            @click="collapsed = !collapsed"
          >
            <FaIcon :icon="collapsed ? 'angles-down' : 'angles-up'" />
          </button>
          <FaIcon icon="diagram-project" />
          <span>{{ t('workflow.title') }}</span>
          <span class="awx-workflow-count">{{ t('workflow.nodes', { count: workflow.nodes?.length || 0 }) }}</span>
        </div>
        <div class="awx-workflow-tools">
          <span class="awx-workflow-legend"
            ><span class="legend-line" :style="{ background: edgeColors.success }"></span
            >{{ t('workflow.onSuccess') }}</span
          >
          <span class="awx-workflow-legend"
            ><span class="legend-line" :style="{ background: edgeColors.failure }"></span
            >{{ t('workflow.onFailure') }}</span
          >
          <span class="awx-workflow-legend"
            ><span class="legend-line" :style="{ background: edgeColors.always }"></span
            >{{ t('workflow.always') }}</span
          >
          <span v-if="conditionLinks.length" class="awx-workflow-legend"
            ><span class="legend-line legend-dashed"></span>{{ t('workflow.conditional') }}</span
          >
          <span class="awx-tool-sep" />
          <!-- full screen : zoom out, the zoom (a click : actual size), zoom in, the whole graph -->
          <template v-if="fullscreen">
            <button
              type="button"
              class="awx-tool-btn awx-tool-icon"
              :aria-label="t('workflow.zoomOut')"
              :title="t('workflow.zoomOut')"
              @click="zoomBy(1 / 1.25)"
            >
              <FaIcon icon="minus" />
            </button>
            <button type="button" class="awx-tool-btn awx-zoom" :title="t('workflow.actualSize')" @click="zoomTo(1)">
              {{ Math.round(view.k * 100) }}%
            </button>
            <button
              type="button"
              class="awx-tool-btn awx-tool-icon"
              :aria-label="t('workflow.zoomIn')"
              :title="t('workflow.zoomIn')"
              @click="zoomBy(1.25)"
            >
              <FaIcon icon="plus" />
            </button>
            <button type="button" class="awx-tool-btn" @click="fitView()">
              <FaIcon icon="arrows-left-right-to-line" />{{ t('workflow.fitScreen') }}
            </button>
          </template>
          <button
            v-else
            type="button"
            class="awx-tool-btn"
            :class="{ active: fit }"
            :aria-pressed="fit"
            @click="fit = !fit"
          >
            <FaIcon icon="arrows-left-right-to-line" />{{ t('workflow.fitScreen') }}
          </button>
          <!-- full screen : its icon and its words, as Fit to width -->
          <button type="button" class="awx-tool-btn" @click="fullscreen = !fullscreen">
            <FaIcon :icon="fullscreen ? 'compress' : 'expand'" />{{
              fullscreen ? t('workflow.exitFullscreen') : t('workflow.fullscreen')
            }}
          </button>
        </div>
      </div>
      <!-- the room around the graph, outside its scrolling box : the scrollbar (when it shows)
         as far from the panel's edge as the graph is from its top -->
      <div v-show="!collapsed || fullscreen" class="awx-workflow-body">
        <!-- scrolled away from the running node : a button to follow it again -->
        <div v-if="isRunning && !following && !fit && !fullscreen" class="awx-follow">
          <!-- its arrow after the words : it points where the running node is -->
          <BsButton colorClass="primary" @click="followRunning"
            >{{ t('workflow.followRunning') }}<FaIcon icon="arrow-right" class="ms-2"
          /></BsButton>
        </div>
        <div ref="scrollBox" class="awx-workflow-scroll" :class="{ 'awx-fit': fit }" @scroll="onGraphScroll">
          <!-- full screen : the svg the window's size, the graph in it moved and zoomed (a
               group's transform) - the wheel zooms around the pointer, a drag moves it -->
          <svg
            ref="stage"
            :class="{ 'awx-stage': fullscreen, 'awx-dragging': dragging }"
            :width="fullscreen || fit ? '100%' : graph.width"
            :height="fullscreen ? '100%' : fit ? null : graph.height"
            :viewBox="fullscreen ? null : `0 0 ${graph.width} ${graph.height}`"
            preserveAspectRatio="xMinYMid meet"
            @wheel="onWheel"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <g :transform="fullscreen ? `translate(${view.x} ${view.y}) scale(${view.k})` : null">
              <!-- links -->
              <path
                v-for="(l, i) in graph.links"
                :key="'link' + i"
                :d="l.d"
                fill="none"
                :stroke="edgeColors[l.type === 'condition' ? l.trigger : l.type]"
                :stroke-dasharray="l.type === 'condition' ? '6 4' : null"
                stroke-width="2"
                opacity="0.8"
                class="awx-link"
                :class="related ? (related.links.has(i) ? 'awx-link-focus' : 'awx-link-faded') : null"
              />
              <!-- a conditional link's diamond, in its middle : hovered, its condition -->
              <rect
                v-for="(l, i) in conditionLinks"
                :key="'cond' + i"
                :x="l.mx - 6"
                :y="l.my - 6"
                width="12"
                height="12"
                :transform="`rotate(45 ${l.mx} ${l.my})`"
                class="awx-cond"
                :style="{ stroke: edgeColors[l.trigger] }"
                @mouseenter="hoveredLink = l"
                @mouseleave="hoveredLink = null"
              >
                <!-- the same, where there is no pointer (touch, a screen reader) -->
                <title>{{ linkText(l) }}</title>
              </rect>
              <!-- start node -->
              <g :class="{ 'awx-node-faded': related && !related.nodes.has('start') }">
                <rect
                  :x="graph.start.x"
                  :y="graph.start.y"
                  :width="START_W"
                  :height="START_H"
                  :rx="START_H / 2"
                  class="awx-start"
                />
                <text
                  :x="graph.start.x + START_W / 2"
                  :y="graph.start.y + START_H / 2 + 4"
                  text-anchor="middle"
                  class="awx-start-text"
                >
                  START
                </text>
              </g>
              <!-- workflow nodes -->
              <g
                v-for="n in graph.nodes"
                :key="n.id"
                class="awx-node"
                :class="{
                  'awx-node-open': hasOutput(n),
                  'awx-node-faded': related && !related.nodes.has(n.id),
                  'awx-node-carried': n.carried,
                }"
                @click="openNode(n)"
                @mouseenter="hovered = n"
                @mouseleave="hovered = null"
              >
                <rect
                  :x="n.x"
                  :y="n.y"
                  :width="NODE_W"
                  :height="NODE_H"
                  rx="6"
                  class="awx-node-rect"
                  :style="{ stroke: nodeColor(n) }"
                  :stroke-dasharray="n.status == 'skipped' || n.do_not_run ? '4 3' : null"
                />
                <circle
                  :cx="n.x + 14"
                  :cy="n.y + NODE_H / 2"
                  r="5"
                  :fill="nodeColor(n)"
                  :class="{ 'awx-pulse': n.status == 'running' || n.status == 'retrying' }"
                />
                <text :x="n.x + 26" :y="n.y + 22" class="awx-node-name">{{ truncate(n.name) }}</text>
                <!-- its status (or that it comes from the previous run, or was forced), its time, and
                     the retries it made of the ones it may -->
                <text :x="n.x + 26" :y="n.y + 40" class="awx-node-status" :style="{ fill: nodeColor(n) }">
                  {{ statusLine(n) }}
                </text>
                <!-- the retries it made of the ones it may : at the right of its status line -->
                <text
                  v-if="retriesText(n)"
                  :x="retriesX(n, n.x)"
                  :y="n.y + 40"
                  text-anchor="end"
                  class="awx-node-status"
                  :style="{ fill: nodeColor(n) }"
                >
                  {{ retriesText(n) }}
                </text>
                <!-- its job in the product it ran on (a click on the node opens its output here) -->
                <a
                  v-if="n.ui_url"
                  :href="n.ui_url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="awx-node-link"
                  @click.stop
                >
                  <title>{{ t('jobs.openInRunner', { id: n.job, product }) }}</title>
                  <rect :x="n.x + NODE_W - 26" :y="n.y + NODE_H - 24" width="20" height="20" fill="transparent" />
                  <svg
                    :x="n.x + NODE_W - 22"
                    :y="n.y + NODE_H - 20"
                    width="12"
                    height="12"
                    viewBox="0 0 512 512"
                    class="awx-node-link-text"
                  >
                    <path :d="LINK_ICON" />
                  </svg>
                </a>
              </g>
              <!-- the hovered node's card : its whole name, over it (the last drawn, so on top) -->
              <text ref="measure" class="awx-node-name awx-measure" x="0" y="0">{{ focused?.name }}</text>
              <text ref="reasonMeasure" class="awx-node-status awx-measure" x="0" y="0">{{ reasonText(focused) }}</text>
              <g v-if="card" class="awx-node-card">
                <rect
                  :x="card.cx"
                  :y="card.y"
                  :width="card.w"
                  :height="NODE_H + (card.forced_success ? REASON_H : 0)"
                  rx="6"
                  class="awx-node-rect"
                  :style="{ stroke: nodeColor(card) }"
                  :stroke-dasharray="card.status == 'skipped' || card.do_not_run ? '4 3' : null"
                />
                <circle :cx="card.cx + 14" :cy="card.y + NODE_H / 2" r="5" :fill="nodeColor(card)" />
                <text :x="card.cx + 26" :y="card.y + 22" class="awx-node-name">{{ card.name }}</text>
                <text :x="card.cx + 26" :y="card.y + 40" class="awx-node-status" :style="{ fill: nodeColor(card) }">
                  {{ statusLine(card) }}
                </text>
                <!-- the retries it made of the ones it may : at the right of its status line -->
                <text
                  v-if="retriesText(card)"
                  :x="retriesX(card, card.x)"
                  :y="card.y + 40"
                  text-anchor="end"
                  class="awx-node-status"
                  :style="{ fill: nodeColor(card) }"
                >
                  {{ retriesText(card) }}
                </text>
                <!-- forced as successful : why, as whoever relaunched it said -->
                <text v-if="card.forced_success" :x="card.cx + 26" :y="card.y + 40 + REASON_H" class="awx-node-status">
                  {{ reasonText(card) }}
                </text>
                <!-- the node's link, drawn where it is under the card : the click passes through to it -->
                <svg
                  v-if="card.ui_url"
                  :x="card.x + NODE_W - 22"
                  :y="card.y + NODE_H - 20"
                  width="12"
                  height="12"
                  viewBox="0 0 512 512"
                  class="awx-node-link-text"
                >
                  <path :d="LINK_ICON" />
                </svg>
              </g>
              <!-- the hovered conditional link's card : when it is taken -->
              <text ref="linkMeasure" class="awx-cond-text awx-measure" x="0" y="0">{{ linkText(hoveredLink) }}</text>
              <g v-if="linkCard" class="awx-node-card">
                <rect
                  :x="linkCard.x"
                  :y="linkCard.y"
                  :width="linkCard.w"
                  :height="LINK_CARD_H"
                  rx="4"
                  class="awx-cond-card"
                />
                <text :x="linkCard.x + LINK_CARD_PAD / 2" :y="linkCard.y + 16" class="awx-cond-text">
                  {{ linkCard.text }}
                </text>
              </g>
            </g>
          </svg>
        </div>
      </div>
    </div>
  </Teleport>
</template>
<style lang="scss" scoped>
/* a hovered node's card : over the graph, lifted by a shadow, the pointer passing through it to
   the node under it */
.awx-node-card {
  pointer-events: none;
  filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.18));
}
/* a node in focus : its links drawn stronger, the other links and nodes faded */
.awx-link,
.awx-node,
.awx-node-faded {
  transition: opacity 0.15s;
}
.awx-link-focus {
  opacity: 1;
  stroke-width: 3;
}
.awx-link-faded {
  opacity: 0.2;
}
.awx-node-faded {
  opacity: 0.45;
}
/* a node carried over from the previous run : greyed, it did not run in this one */
.awx-node-carried {
  opacity: 0.6;
}
/* and faded as the others when another node is in focus */
.awx-node-carried.awx-node-faded {
  opacity: 0.3;
}
@media (prefers-reduced-motion: reduce) {
  .awx-link,
  .awx-node,
  .awx-node-faded {
    transition: none;
  }
}
/* a node's link to its job in the product */
.awx-node-link {
  cursor: pointer;
  text-decoration: none;
}
.awx-node-link-text {
  font-size: 14px;
  text-decoration: none;
  fill: var(--bs-link-color);
}
.awx-node-link:hover .awx-node-link-text {
  fill: var(--bs-link-hover-color);
}
/* the text a name is measured with : laid out, never seen */
.awx-measure {
  visibility: hidden;
  pointer-events: none;
}
/* full screen : the window's width and height but a margin, over a dimmed page */
.awx-workflow-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1055;
  background: rgba(0, 0, 0, 0.5);
}
.awx-workflow.awx-fullscreen {
  position: fixed;
  inset: 1.5rem;
  z-index: 1056;
  display: flex;
  flex-direction: column;
  margin: 0;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.3);
  .awx-workflow-body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  /* the graph : the whole of the panel's body, moved by a drag and zoomed by the wheel */
  .awx-workflow-body {
    padding: 0;
  }
  .awx-workflow-scroll {
    flex: 1 1 auto;
    overflow: hidden;
    padding: 0;
    background: none;
  }
  .awx-stage {
    display: block;
    cursor: grab;
    touch-action: none;
    user-select: none;
    &.awx-dragging {
      cursor: grabbing;
    }
  }
  /* its header : a dialog's, larger than the panel's on the page */
  .awx-workflow-toolbar {
    padding: 0.625rem 0.75rem 0.625rem 1.25rem;
  }
  .awx-workflow-label {
    font-size: 1.125rem;
    gap: 0.625rem;
  }
  .awx-workflow-count {
    font-size: 0.9375rem;
  }
  /* its buttons the size of the page's toolbars (the job output's) */
  .awx-workflow-tools {
    font-size: 0.8125rem;
  }
  .awx-zoom {
    min-width: 3.5rem;
    justify-content: center;
    font-variant-numeric: tabular-nums;
  }
}
.awx-workflow {
  margin-bottom: 1.25rem;
  border: 1px solid var(--af-field-border);
  border-radius: 0.5rem;
  overflow: hidden;
  /* the page's own background, in every theme : no grey of its own */
  background-color: var(--bs-body-bg);

  /* the toolbar : as the job output's */
  .awx-workflow-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem 0.375rem 1rem;
    border-bottom: 1px solid var(--af-field-border);
    background: var(--bs-tertiary-bg);
  }
  /* the collapse : as far in as the output's, as wide */
  .awx-collapse {
    margin-left: calc(-0.5rem - 1px);
    svg {
      width: 0.75rem;
    }
  }
  &.awx-collapsed .awx-workflow-toolbar {
    border-bottom: 0;
  }
  .awx-workflow-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    font-size: 0.875rem;
  }
  .awx-workflow-count {
    font-weight: 400;
    font-size: 0.8rem;
    color: var(--bs-secondary-color);
  }
  .awx-workflow-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* as the output's toolbar : its buttons 0.125rem apart (their own padding does the rest), the
       legend's colours a little room of their own */
    gap: 0.125rem;
    font-size: 0.8125rem;
    color: var(--bs-secondary-color);
  }
  .awx-workflow-legend {
    margin-right: 0.5rem;
  }
  .awx-tool-sep {
    width: 1px;
    height: 1.25rem;
    margin: 0 0.25rem;
    background: var(--af-field-border);
  }
  .awx-tool-icon {
    padding: 0.3rem 0.5rem;
  }
  .awx-tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--bs-body-color);
    &:hover {
      background: var(--bs-secondary-bg);
    }
    &.active {
      border-color: var(--bs-primary-border-subtle);
      background: var(--bs-primary-bg-subtle);
      color: var(--bs-primary-text-emphasis);
    }
  }

  /* the graph : scrolled sideways, a soft shade at an edge with more of it beyond (the shades
     ride on the content's edges : they show only where it is cut) */
  /* the room around the graph : as much under it (above the scrollbar) as over it, and the
     scrollbar, when it shows, as far again from the panel's edge */
  .awx-workflow-body {
    padding: 1rem;
  }
  /* the button to follow the running node again : at the graph's right, over it, as the server
     log's while it is scrolled up */
  .awx-workflow-body {
    position: relative;
  }
  .awx-follow {
    position: absolute;
    right: 1rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 3;
    :deep(.btn) {
      background-color: var(--bs-body-bg);
      box-shadow: var(--bs-box-shadow-sm);
    }
  }
  .awx-workflow-scroll {
    overflow-x: auto;
    padding-bottom: 1rem;
    background:
      linear-gradient(to right, var(--bs-body-bg), transparent) left / 2.5rem 100% no-repeat local,
      linear-gradient(to left, var(--bs-body-bg), transparent) right / 2.5rem 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.14), transparent) left / 0.75rem 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.14), transparent) right / 0.75rem 100% no-repeat scroll;
    svg {
      display: block;
    }
    &.awx-fit {
      overflow-x: hidden;
    }
  }

  /* the conditional links : dashed */
  .legend-dashed {
    background: repeating-linear-gradient(90deg, var(--bs-secondary) 0 6px, transparent 6px 9px);
  }
  .legend-line {
    display: inline-block;
    width: 18px;
    height: 3px;
    border-radius: 2px;
    vertical-align: middle;
    margin-right: 5px;
  }

  .awx-start {
    fill: var(--bs-secondary);
  }

  .awx-start-text {
    fill: var(--bs-light);
    font-size: 0.7rem;
    font-weight: bold;
    letter-spacing: 1px;
  }

  /* a node that ran : a click opens its output */
  .awx-node-open {
    cursor: pointer;
    &:hover .awx-node-rect {
      fill: var(--af-row-hover-bg);
    }
  }
  .awx-node-rect {
    fill: var(--bs-body-bg);
    stroke-width: 2;
  }
  /* a conditional link (Ascender) : its diamond, and the card with its condition */
  .awx-cond {
    fill: var(--bs-body-bg);
    stroke-width: 2;
    cursor: help;
    &:hover {
      fill: var(--af-row-hover-bg);
    }
  }
  .awx-cond-card {
    fill: var(--bs-body-bg);
    stroke: var(--bs-border-color);
  }
  .awx-cond-text {
    fill: var(--bs-body-color);
    font-size: 0.75rem;
  }

  .awx-node-name {
    fill: var(--bs-body-color);
    font-size: 0.8rem;
    font-weight: 600;
  }

  .awx-node-status {
    font-size: 0.7rem;
  }

  .awx-pulse {
    animation: awx-pulse 1.5s ease-in-out infinite;
  }

  @keyframes awx-pulse {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
    100% {
      opacity: 1;
    }
  }
}
</style>
