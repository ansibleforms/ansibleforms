<script setup>
/******************************************************************/
/*                                                                */
/*  A workflow file as its graph : the workflow chosen drawn as   */
/*  AWX's visualizer draws it (START, a column per step, the      */
/*  links green on success, red on failure, blue always), its     */
/*  job templates under it. A click on a node, a link or a job    */
/*  template edits it in the panel on the right ; every edit is   */
/*  made on the file's own text (config/workflowFile.js), so its  */
/*  comments and the rest stay (saved with the designer's Save).  */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the file's YAML (the AWX export      */
/*         syntax : job_templates, workflow_job_templates)        */
/*      readOnly: Boolean - shown, not editable                   */
/*      preview: Boolean - a dry run : a click on a node that     */
/*         runs makes it fail (or succeed again), the graph shows */
/*         what runs then, and whether the workflow fails         */
/*  @emits:                                                       */
/*      update:modelValue - the file, changed                     */
/*      reveal: the line to open the YAML on                      */
/*                                                                */
/******************************************************************/
import { ref, computed, watch, onMounted } from 'vue';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import {
  LINK_KINDS,
  GRAPH,
  workflowFileOf,
  workflowProblems,
  workflowGraph,
  dryRun,
  editWorkflow,
  editRemoveWorkflow,
  editAddNode,
  editNode,
  editRemoveNode,
  editLink,
  editUnlink,
  freeName,
} from '@/config/workflowFile';
import { playbookChoices } from '@/lib/playbookChoices';

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  // the Preview tab : a dry run, nothing edited - a click makes a node fail or succeed
  preview: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'reveal']);
const { t } = useI18n();

// ─── the file ─────────────────────────────────────────────────────────────────
const file = computed(() => workflowFileOf(props.modelValue));
const workflows = computed(() => file.value.workflows || []);
// the workflow shown : its place in the file
const wfIndex = ref(0);
watch(workflows, (list) => {
  if (wfIndex.value >= list.length) wfIndex.value = Math.max(0, list.length - 1);
});
const workflow = computed(() => workflows.value[wfIndex.value] || null);
// every workflow of the file, each its graph : one under the other (an AWX export may hold several)
const graphs = computed(() => workflows.value.map((w) => workflowGraph(w.nodes)));
const graph = computed(() => graphs.value[wfIndex.value] || workflowGraph([]));

/**
 * Applies an edit : the file as the edit leaves it, or the edit's error.
 *
 * Args:
 *   fn (function): the edit, given the file's text, answering the new text (or { text }).
 *
 * Returns:
 *   any: what the edit answered (its text and what else it says), null when it failed.
 */
function apply(fn) {
  if (props.readOnly) return null;
  try {
    const out = fn(props.modelValue);
    emit('update:modelValue', typeof out === 'string' ? out : out.text);
    return out;
  } catch (err) {
    toast.error(err.message);
    return null;
  }
}

// ─── what the instance has : the names a job template, a node may use ─────────
// null : unknown (the list needs a permission the user lacks) - then nothing is checked
const refs = ref({
  playbooks: null,
  playbookFiles: null,
  playbookRepositories: null,
  inventories: null,
  credentials: null,
  repositories: null,
  runners: null,
});
/**
 * Reads a list the panel offers, null when it cannot.
 *
 * Args:
 *   url (string): the api.
 *   pick (function): the names, from its answer.
 *
 * Returns:
 *   Promise<string[]|null>: the names.
 */
async function names(url, pick) {
  try {
    return pick((await axios.get(url)).data);
  } catch {
    return null;
  }
}
onMounted(async () => {
  const [playbookList, inventories, credentials, repositories, runners] = await Promise.all([
    // the playbooks, and the repositories used for them (a node names one with playbook_repository)
    names('/api/v2/files/playbooks', (d) => ({
      files: (d?.files || []).map((f) => f.path).filter((p) => /\.ya?ml$/i.test(p)),
      repositories: d?.repositories || [],
    })),
    names('/api/v2/files/inventories', (d) => [
      ...new Set(
        (d?.files || [])
          .map((f) => String(f.path).split('/'))
          .filter((p) => p.length === 2 && /^(inventory|hosts)\.ya?ml$/i.test(p[1]))
          .map((p) => p[0]),
      ),
    ]),
    names('/api/v2/credential/', (d) => (d?.records || d || []).map((c) => c?.name).filter(Boolean)),
    names('/api/v2/repository/', (d) => (d?.records || d || []).map((r) => r?.name).filter(Boolean)),
    // the runners a node may run on : each with its type (an RTE runs a playbook, the others a
    // template or job)
    names('/api/v2/runner/', (d) =>
      (d?.records || d || [])
        .filter((r) => r?.name)
        .map((r) => ({ name: r.name, type: r.type, flavour: r.flavour || '', is_default: !!r.is_default })),
    ),
  ]);
  refs.value = {
    playbooks: playbookList ? playbookChoices(playbookList.files, playbookList.repositories) : null,
    playbookFiles: playbookList,
    playbookRepositories: playbookList ? playbookList.repositories.map((r) => r.name) : null,
    inventories,
    credentials,
    repositories,
    runners,
  };
});
const sorted = (list) => [...(list || [])].sort((a, b) => a.localeCompare(b));

// what is wrong, each with its line ; a node with a problem is drawn red
const problems = computed(() => workflowProblems(file.value, refs.value));
const badNodes = computed(() => new Set(problems.value.map((p) => p.values?.identifier).filter(Boolean)));

// ─── what is selected : a node, a link, a job template, or the workflow ───────
const selected = ref(null); // { type : 'node', id } | { type : 'link', from, to }
const node = computed(() =>
  selected.value?.type === 'node'
    ? workflow.value?.nodes.find((n) => n.identifier === selected.value.id) || null
    : null,
);
const link = computed(() =>
  selected.value?.type === 'link'
    ? graph.value.links.find((l) => l.from === selected.value.from && l.to === selected.value.to) || null
    : null,
);

// ─── the workflows ────────────────────────────────────────────────────────────
/**
 * Sets a workflow's name or description.
 *
 * Args:
 *   i (number): the workflow's place.
 *   key (string): 'name' or 'description'.
 *   value (string): the value.
 */
function setWorkflowAt(i, key, value) {
  apply((text) => editWorkflow(text, i, key, value));
}
/**
 * Removes a workflow of the file (one of several).
 *
 * Args:
 *   i (number): the workflow's place.
 */
function removeWorkflowAt(i) {
  apply((text) => editRemoveWorkflow(text, i));
  wfIndex.value = 0;
  selected.value = null;
}

// ─── the nodes ────────────────────────────────────────────────────────────────
// what a node runs, as the panel says it
const TYPE_ICONS = {
  job_template: 'rocket',
  workflow_job_template: 'diagram-project',
  workflow_approval_template: 'user-check',
  project: 'code-branch',
};
const TYPE_COLORS = {
  job_template: 'var(--bs-primary)',
  workflow_job_template: 'var(--bs-info)',
  workflow_approval_template: 'var(--bs-warning)',
  project: 'var(--bs-secondary)',
};
const LINK_COLORS = {
  success: 'var(--bs-success)',
  failure: 'var(--bs-danger)',
  always: 'var(--bs-info)',
  start: 'var(--bs-secondary)',
};

// ─── a new node : the wizard ──────────────────────────────────────────────────
// what it runs, how its playbook runs (a playbook only), where it goes - then created at once
const wizard = ref(null); // { wi, step, draft, parent, kind, idTouched }
const EMPTY_DRAFT = {
  identifier: '',
  type: 'job_template',
  name: '',
  timeout: 0,
  inventory: '',
  credentials: [],
  limit: '',
  job_tags: '',
  skip_tags: '',
  verbosity: '',
  job_type: '',
  diff_mode: false,
  converge: false,
  runner: '',
  playbook_repository: '',
  if_extra_var: '',
  extra_vars_key: '',
};
/**
 * Opens the new node wizard, the node to run after a node when one is given.
 *
 * Args:
 *   from (object): { identifier, kind } : the node it runs after, and on what (optional : at
 *     the start).
 *   wi (number): the workflow's place (the one selected by default).
 */
function addNode(from = null, wi = wfIndex.value) {
  if (props.readOnly) return;
  wfIndex.value = wi;
  selected.value = null;
  const taken = (workflows.value[wi]?.nodes || []).map((n) => n.identifier);
  wizard.value = {
    wi,
    step: 0,
    draft: { ...EMPTY_DRAFT, credentials: [], identifier: freeName('node', taken) },
    parent: from?.identifier || '',
    kind: from?.kind || 'success',
    idTouched: false,
  };
}
// its steps : a playbook's run asks how it runs, the others go on to where they go
const wizardSteps = computed(() =>
  wizard.value?.draft.type === 'job_template' ? ['runs', 'settings', 'where'] : ['runs', 'where'],
);
const wizardStep = computed(() => wizardSteps.value[wizard.value?.step] || 'runs');
/**
 * A field of the draft changed ; the identifier follows what it runs until it is typed.
 *
 * Args:
 *   key (string): the field.
 *   value (any): its value.
 */
function setDraft(key, value) {
  const w = wizard.value;
  if (key === 'identifier') w.idTouched = true;
  if (key === 'type') {
    w.draft.name = '';
    w.step = 0;
  }
  w.draft[key] = value;
  if (key === 'name' && !w.idTouched && value) {
    const base = String(value)
      .replace(/\.ya?ml$/i, '')
      .replace(/[^A-Za-z0-9_.:-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const taken = (workflows.value[w.wi]?.nodes || []).map((n) => n.identifier);
    if (base) w.draft.identifier = freeName(base, taken);
  }
}
// why the draft's identifier cannot be, '' when it can
const draftIdentifierError = computed(() => {
  const w = wizard.value;
  if (!w) return '';
  const id = w.draft.identifier;
  if (!/^[A-Za-z0-9_.:-]+$/.test(id || '')) return t('workflowEditor.badIdentifier');
  if ((workflows.value[w.wi]?.nodes || []).some((n) => n.identifier === id)) {
    return t('workflowEditor.identifierTaken', { identifier: id });
  }
  return '';
});
// a step may be left : what it runs is named, its identifier valid
const wizardStepValid = computed(() => {
  const w = wizard.value;
  if (!w) return false;
  if (wizardStep.value === 'runs') return !draftIdentifierError.value && !!w.draft.name;
  return true;
});
/** Creates the node the wizard holds, linked after its parent, and closes the wizard. */
function createNode() {
  const w = wizard.value;
  if (!w || !wizardStepValid.value || draftIdentifierError.value || !w.draft.name) return;
  const d = w.draft;
  const out = apply((text) => {
    const added = editAddNode(
      text,
      w.wi,
      { identifier: d.identifier, type: d.type, name: d.name, timeout: d.timeout },
      w.parent ? { identifier: w.parent, kind: w.kind } : null,
    );
    let next = added.text;
    // a condition and the values it gets : any node that runs something
    if (d.type !== 'workflow_approval_template') {
      for (const key of ['if_extra_var', 'extra_vars_key']) {
        if (d[key]) next = editNode(next, w.wi, added.identifier, key, d[key]);
      }
    }
    if (d.type === 'job_template') {
      for (const key of [
        'runner',
        'playbook_repository',
        'inventory',
        'credentials',
        'limit',
        'job_tags',
        'skip_tags',
        'verbosity',
        'job_type',
        'diff_mode',
      ]) {
        const v = d[key];
        if (v && (!Array.isArray(v) || v.length)) next = editNode(next, w.wi, added.identifier, key, v);
      }
    }
    if (d.converge) next = editNode(next, w.wi, added.identifier, 'converge', true);
    return { text: next, identifier: added.identifier };
  });
  if (out) wizard.value = null;
}

/**
 * Changes the selected node.
 *
 * Args:
 *   key (string): 'identifier', 'type', 'name', 'timeout', 'converge' or a run setting.
 *   value (any): the value.
 */
function setNode(key, value) {
  const id = node.value.identifier;
  if (key === 'identifier') {
    const v = String(value || '').trim();
    if (!v || v === id) return;
    if (!/^[A-Za-z0-9_.:-]+$/.test(v)) return toast.error(t('workflowEditor.badIdentifier'));
    if (workflow.value.nodes.some((n) => n.identifier === v))
      return toast.error(t('workflowEditor.identifierTaken', { identifier: v }));
    if (apply((text) => editNode(text, wfIndex.value, id, 'identifier', v))) selected.value = { type: 'node', id: v };
    return;
  }
  apply((text) => editNode(text, wfIndex.value, id, key, value));
}
function removeNode() {
  apply((text) => editRemoveNode(text, wfIndex.value, node.value.identifier));
  selected.value = null;
}
// the node a new link goes to, and on what
const linkTo = ref('');
const linkKind = ref('success');
watch(node, () => {
  linkTo.value = '';
  linkKind.value = 'success';
});
const linkTargets = computed(() =>
  node.value ? workflow.value.nodes.filter((n) => n.identifier !== node.value.identifier).map((n) => n.identifier) : [],
);
function addLink() {
  if (!linkTo.value) return;
  apply((text) => editLink(text, wfIndex.value, node.value.identifier, linkTo.value, linkKind.value));
  linkTo.value = '';
}
/**
 * The names a node may run, by what it runs : the designer's playbooks, the file's other
 * workflows, the repositories ; null (typed) for an approval, or a list that cannot be read.
 *
 * Args:
 *   type (string): what it runs.
 *
 * Returns:
 *   string[]|null: the names.
 */
function choicesFor(type, playbookRepository = '') {
  const wf = workflows.value[wizard.value ? wizard.value.wi : wfIndex.value];
  if (type === 'job_template') {
    const list = refs.value.playbookFiles;
    return list ? playbookChoices(list.files, list.repositories, playbookRepository) : null;
  }
  if (type === 'workflow_job_template') return workflows.value.map((w) => w.name).filter((n) => n && n !== wf?.name);
  if (type === 'project') return refs.value.repositories ? sorted(refs.value.repositories) : null;
  return null;
}
/**
 * The links into a node : the nodes it runs after, and on what.
 *
 * Args:
 *   id (string): the node's identifier.
 *
 * Returns:
 *   object[]: { from, kind }.
 */
function parentsOf(id) {
  const out = [];
  for (const n of workflow.value?.nodes || [])
    for (const kind of LINK_KINDS) if ((n[kind] || []).includes(id)) out.push({ from: n.identifier, kind });
  return out;
}
// the node dialog's tab : what it runs, how it runs (a playbook), where it goes
const nodeTab = ref('runs');
watch(
  () => selected.value?.type === 'node' && selected.value.id,
  (open, was) => {
    if (open && !was) nodeTab.value = 'runs';
  },
);
const nodeTabs = computed(() =>
  node.value?.type === 'job_template' ? ['runs', 'settings', 'after', 'next'] : ['runs', 'after', 'next'],
);

// ─── a link ───────────────────────────────────────────────────────────────────
function setLinkKind(kind) {
  const { from, to } = selected.value;
  apply((text) => editLink(text, wfIndex.value, from, to, kind));
}
function removeLink() {
  const { from, to } = selected.value;
  apply((text) => editUnlink(text, wfIndex.value, from, to));
  selected.value = null;
}

// ─── the graph's pieces ───────────────────────────────────────────────────────
function truncate(s, len = 22) {
  return s && s.length > len ? s.slice(0, len - 1) + '…' : s;
}
// ─── the Preview tab : a dry run ──────────────────────────────────────────────
// the nodes made to fail, per workflow (its place) ; every other node that runs succeeds
const failing = ref({});
const failingOf = (wi) => new Set(failing.value[wi] || []);
const runs = computed(() => workflows.value.map((w, wi) => dryRun(w.nodes, failingOf(wi))));
/**
 * A click on a node in the preview : one that ran fails, or succeeds again.
 *
 * Args:
 *   wi (number): the workflow's place.
 *   n (object): the node.
 */
function toggleFail(wi, n) {
  const status = runs.value[wi]?.status.get(n.identifier);
  if (status !== 'successful' && status !== 'failed') return;
  const set = failingOf(wi);
  if (set.has(n.identifier)) set.delete(n.identifier);
  else set.add(n.identifier);
  failing.value = { ...failing.value, [wi]: [...set] };
}
function resetRun(wi) {
  failing.value = { ...failing.value, [wi]: [] };
}
// a node's colour in the preview : by what it did
const RUN_COLORS = {
  successful: 'var(--bs-success)',
  failed: 'var(--bs-danger)',
  do_not_run: 'var(--bs-secondary)',
  pending: 'var(--bs-warning)',
};
/**
 * Whether a link fired in the dry run : its node ran and the link is the kind that follows.
 *
 * Args:
 *   wi (number): the workflow's place.
 *   l (object): the link.
 *
 * Returns:
 *   boolean: true when it fired (START's links : when their node ran).
 */
function fired(wi, l) {
  const status = runs.value[wi]?.status;
  if (!status) return true;
  if (l.kind === 'start') return status.get(l.to) === 'successful' || status.get(l.to) === 'failed';
  const from = status.get(l.from);
  if (l.kind === 'always') return from === 'successful' || from === 'failed';
  return l.kind === 'success' ? from === 'successful' : from === 'failed';
}

// a node or a link is the selected one only in the workflow selected
const isSelectedNode = (i, n) =>
  wfIndex.value === i && selected.value?.type === 'node' && selected.value.id === n.identifier;
const isSelectedLink = (i, l) =>
  wfIndex.value === i &&
  selected.value?.type === 'link' &&
  selected.value.from === l.from &&
  selected.value.to === l.to;
/**
 * Selects a node, a link or the workflow itself, in the workflow it is in.
 *
 * Args:
 *   i (number): the workflow's place.
 *   what (object|null): { type : 'node', id } | { type : 'link', from, to } ; null : the workflow.
 */
function select(i, what) {
  wfIndex.value = i;
  selected.value = what;
}
function selectLink(i, l) {
  if (l.kind !== 'start') select(i, { type: 'link', from: l.from, to: l.to });
}
/**
 * START of a workflow : a first node added there.
 *
 * Args:
 *   i (number): the workflow's place.
 */
function startAt(i) {
  addNode(null, i);
}
</script>
<template>
  <div class="af-wf">
    <!-- the YAML is not a workflow file : what is wrong, and where -->
    <div v-if="file.kind === 'invalid'" class="alert alert-warning d-flex align-items-center gap-2">
      <FaIcon icon="triangle-exclamation" />
      <span class="flex-grow-1">{{ t('designer.files.visualInvalid', { error: file.error }) }}</span>
      <BsButton icon="code" @click="emit('reveal', file.line)">{{ t('designer.files.showInYaml') }}</BsButton>
    </div>
    <template v-else>
      <!-- what AWX would refuse, or the instance lacks : each opens the YAML on its line -->
      <div v-if="problems.length" class="af-wf-problems">
        <div v-for="(p, i) in problems" :key="i" class="af-wf-problem">
          <FaIcon icon="triangle-exclamation" class="text-warning" />
          <span class="flex-grow-1">{{ t(`workflowEditor.problems.${p.key}`, p.values) }}</span>
          <a v-if="p.line" href="#" @click.prevent="emit('reveal', p.line)">{{
            t('workflowEditor.line', { line: p.line })
          }}</a>
        </div>
      </div>

      <!-- each workflow : its name and description, then its graph -->
      <div v-if="!workflows.length" class="af-wf-canvas af-wf-none text-muted">
        <FaIcon icon="diagram-project" class="mb-2 af-wf-none-icon" />
        <span>{{ t('workflowEditor.noWorkflowHint') }}</span>
      </div>
      <div v-for="(w, wi) in workflows" :key="wi" class="af-wf-block">
        <!-- the preview : the workflow, and how this run ends -->
        <div v-if="preview" class="af-wf-run mb-3">
          <span class="fw-bold"
            ><FaIcon icon="diagram-project" class="me-2" />{{ w.name || t('workflowEditor.unnamed') }}</span
          >
          <AppStatusPill :status="runs[wi].failed ? 'failed' : 'success'" />
          <span class="text-muted small flex-grow-1">{{ t('workflowEditor.previewHint') }}</span>
          <BsButton icon="rotate-left" :disabled="!(failing[wi] || []).length" @click="resetRun(wi)">{{
            t('workflowEditor.previewReset')
          }}</BsButton>
        </div>
        <!-- the graph : titled as a field is -->
        <label v-if="!preview" class="form-label fw-bold">{{ t('workflow.title') }}</label>
        <div class="af-wf-canvas">
          <!-- the links' colours, in the graph's corner -->
          <div class="af-wf-legends">
            <span class="af-wf-legend"
              ><span class="af-wf-line" :style="{ background: LINK_COLORS.success }"></span
              >{{ t('workflow.onSuccess') }}</span
            >
            <span class="af-wf-legend"
              ><span class="af-wf-line" :style="{ background: LINK_COLORS.failure }"></span
              >{{ t('workflow.onFailure') }}</span
            >
            <span class="af-wf-legend"
              ><span class="af-wf-line" :style="{ background: LINK_COLORS.always }"></span
              >{{ t('workflow.always') }}</span
            >
          </div>
          <svg :width="graphs[wi].width + 40" :height="graphs[wi].height" class="af-wf-svg">
            <path
              v-for="(l, i) in graphs[wi].links"
              :key="'l' + i"
              :d="l.d"
              fill="none"
              :stroke="LINK_COLORS[l.kind]"
              :stroke-width="isSelectedLink(wi, l) ? 4 : 2"
              :opacity="preview ? (fired(wi, l) ? 1 : 0.2) : isSelectedLink(wi, l) ? 1 : 0.8"
              :stroke-dasharray="preview && !fired(wi, l) ? '4 4' : null"
            />
            <!-- a link's wide invisible twin : easy to click -->
            <path
              v-for="(l, i) in graphs[wi].links"
              :key="'h' + i"
              :d="l.d"
              fill="none"
              stroke="transparent"
              stroke-width="12"
              :class="{ 'af-wf-link': !preview && l.kind !== 'start' }"
              @click="!preview && selectLink(wi, l)"
            />
            <!-- START : a click adds a first step -->
            <g
              class="af-wf-start"
              :class="{ 'af-wf-clickable': !readOnly && !preview }"
              @click="!preview && startAt(wi)"
            >
              <rect
                :x="graphs[wi].start.x"
                :y="graphs[wi].start.y"
                :width="GRAPH.startW"
                :height="GRAPH.startH"
                :rx="GRAPH.startH / 2"
              />
              <text
                :x="graphs[wi].start.x + GRAPH.startW / 2"
                :y="graphs[wi].start.y + GRAPH.startH / 2 + 4"
                text-anchor="middle"
              >
                START
              </text>
              <title>{{ t('workflowEditor.addFirst') }}</title>
            </g>
            <g
              v-for="n in graphs[wi].nodes"
              :key="n.identifier"
              class="af-wf-node"
              :class="{
                'af-wf-node-selected': !preview && isSelectedNode(wi, n),
                'af-wf-node-skipped': preview && runs[wi].status.get(n.identifier) === 'do_not_run',
              }"
              @click="preview ? toggleFail(wi, n) : select(wi, { type: 'node', id: n.identifier })"
            >
              <rect
                :x="n.x"
                :y="n.y"
                :width="GRAPH.nodeW"
                :height="GRAPH.nodeH"
                rx="6"
                class="af-wf-node-rect"
                :style="{
                  stroke: preview
                    ? RUN_COLORS[runs[wi].status.get(n.identifier)]
                    : badNodes.has(n.identifier)
                      ? 'var(--bs-danger)'
                      : TYPE_COLORS[n.type] || 'var(--bs-secondary)',
                }"
                :stroke-dasharray="
                  (preview && runs[wi].status.get(n.identifier) === 'do_not_run') ||
                  (!preview && badNodes.has(n.identifier))
                    ? '5 3'
                    : null
                "
              />
              <rect
                :x="n.x"
                :y="n.y"
                width="5"
                :height="GRAPH.nodeH"
                rx="2"
                :style="{ fill: TYPE_COLORS[n.type] || 'var(--bs-secondary)' }"
              />
              <text :x="n.x + 14" :y="n.y + 22" class="af-wf-node-name">{{ truncate(n.identifier) }}</text>
              <text
                :x="n.x + 14"
                :y="n.y + 41"
                class="af-wf-node-sub"
                :style="preview ? { fill: RUN_COLORS[runs[wi].status.get(n.identifier)] } : null"
              >
                {{
                  preview
                    ? `${t(`workflowEditor.run.${runs[wi].status.get(n.identifier)}`)}${runs[wi].order.includes(n.identifier) ? ` · ${runs[wi].order.indexOf(n.identifier) + 1}` : ''}`
                    : truncate(n.name || '?', 30)
                }}
              </text>
              <title>{{ n.identifier }} : {{ n.name }}</title>
            </g>
          </svg>
        </div>
        <!-- what to do with it -->
        <div v-if="!preview" class="form-text mt-1">{{ t('workflowEditor.selectHint') }}</div>
        <!-- its name and description, each a row of its own, as wide (as a form's) -->
        <div v-if="!preview" class="row g-3 mt-1 mb-3">
          <div class="col-lg-8">
            <label class="form-label fw-bold">{{ t('workflowEditor.name') }}</label>
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="heading" /></span>
              <input
                class="form-control"
                :class="{ 'is-invalid': !w.name }"
                :value="w.name"
                :disabled="readOnly"
                spellcheck="false"
                @change="setWorkflowAt(wi, 'name', $event.target.value.trim())"
              />
            </div>
          </div>
          <!-- one of several in the file (an AWX export) : it may go -->
          <div v-if="!readOnly && workflows.length > 1" class="col-auto d-flex align-items-end">
            <BsButton
              icon="trash"
              :isIconButton="true"
              :title="t('workflowEditor.removeWorkflow')"
              @click="removeWorkflowAt(wi)"
            />
          </div>
          <div class="w-100"></div>
          <div class="col-lg-8">
            <label class="form-label fw-bold">{{ t('workflowEditor.description') }}</label>
            <div class="input-group">
              <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="info-circle" /></span>
              <textarea
                class="form-control"
                rows="3"
                :value="w.description"
                :disabled="readOnly"
                @change="setWorkflowAt(wi, 'description', $event.target.value)"
              ></textarea>
            </div>
          </div>
        </div>
      </div>

      <!-- a new node : the wizard - what it runs, how it runs (a playbook), where it goes -->
      <BsModal v-if="wizard" size="lg" icon="plus" :footerClose="false" @close="wizard = null">
        <template #title>{{ t('workflowEditor.newNode') }}</template>
        <!-- its steps, above the fields and out of their scroll -->
        <template #top>
          <ol class="af-wizard-steps mb-0">
            <li
              v-for="(step, i) in wizardSteps"
              :key="step"
              :class="{ active: i === wizard.step, done: i < wizard.step, reachable: i < wizard.step }"
              @click="i < wizard.step && (wizard.step = i)"
            >
              <span class="af-wizard-n"
                ><FaIcon v-if="i < wizard.step" icon="check" /><template v-else>{{ i + 1 }}</template></span
              >
              <span class="af-wizard-label">{{ t(`workflowEditor.steps.${step}`) }}</span>
            </li>
          </ol>
        </template>
        <template #default>
          <AppWorkflowNodeFields
            v-if="wizardStep !== 'where'"
            :node="wizard.draft"
            :section="wizardStep"
            :choices="choicesFor"
            :refs="refs"
            :identifierError="wizardStep === 'runs' ? draftIdentifierError : ''"
            @set="setDraft"
          />
          <!-- where it goes : after a node (and on what), or at the start -->
          <div v-else class="row g-3">
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('workflowEditor.runsAfter') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="sitemap" /></span>
                <select v-model="wizard.parent" class="form-select">
                  <option value="">{{ t('workflowEditor.atStart') }}</option>
                  <option v-for="n in workflows[wizard.wi]?.nodes || []" :key="n.identifier" :value="n.identifier">
                    {{ n.identifier }}
                  </option>
                </select>
              </div>
            </div>
            <div class="col-md-6">
              <label class="form-label fw-bold">{{ t('workflowEditor.runsWhen') }}</label>
              <div class="input-group">
                <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="link" /></span>
                <select v-model="wizard.kind" class="form-select" :disabled="!wizard.parent">
                  <option v-for="kind in LINK_KINDS" :key="kind" :value="kind">
                    {{ t(`workflowEditor.kinds.${kind}`) }}
                  </option>
                </select>
              </div>
            </div>
            <div class="col-12">
              <label class="form-label fw-bold">{{ t('workflowEditor.parents') }}</label>
              <div class="form-check form-switch">
                <input id="wf-new-converge" v-model="wizard.draft.converge" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="wf-new-converge">{{ t('workflowEditor.converge') }}</label>
              </div>
            </div>
          </div>
        </template>
        <template #footer>
          <BsButton v-if="wizard.step > 0" icon="arrow-left" @click="wizard.step--">{{
            t('common.previousStep')
          }}</BsButton>
          <BsButton
            v-if="wizard.step < wizardSteps.length - 1"
            icon="arrow-right"
            :disabled="!wizardStepValid"
            @click="wizard.step++"
            >{{ t('common.nextStep') }}</BsButton
          >
          <BsButton v-else icon="check" :disabled="!wizardStepValid" @click="createNode()">{{
            t('workflowEditor.create')
          }}</BsButton>
          <BsButton icon="times" @click="wizard = null">{{ t('common.close') }}</BsButton>
        </template>
      </BsModal>

      <!-- a node : its dialog, a tab for what it runs, how it runs (a playbook), where it goes -->
      <BsModal
        v-if="!preview && node"
        size="lg"
        :icon="TYPE_ICONS[node.type] || 'circle'"
        :footerClose="false"
        @close="selected = null"
      >
        <template #title>{{ t('workflowEditor.nodeTitle', { identifier: node.identifier }) }}</template>
        <template #default>
          <ul class="nav nav-tabs">
            <li v-for="tab in nodeTabs" :key="tab" class="nav-item">
              <a class="nav-link" :class="{ active: nodeTab === tab }" href="#" @click.prevent="nodeTab = tab">{{
                t(`workflowEditor.steps.${tab}`)
              }}</a>
            </li>
          </ul>
          <!-- the tab's content : a card joined to its tabs -->
          <div class="af-wf-tab-card">
            <AppWorkflowNodeFields
              v-if="(nodeTab === 'runs' || nodeTab === 'settings') && nodeTabs.includes(nodeTab)"
              :node="node"
              :section="nodeTab"
              :choices="choicesFor"
              :refs="refs"
              :readOnly="readOnly"
              @set="setNode"
            />
            <!-- what it runs after, and whether all of it must -->
            <template v-else-if="nodeTab === 'after'">
              <div>
                <ul class="list-group mb-2">
                  <li v-for="p in parentsOf(node.identifier)" :key="p.from + p.kind" class="list-group-item af-wf-item">
                    <span class="af-wf-line" :style="{ background: LINK_COLORS[p.kind] }"></span>
                    <span class="flex-grow-1 fw-semibold">{{ p.from }}</span>
                    <span class="badge rounded-pill af-wf-kind-pill" :class="`af-wf-kind-${p.kind}`">{{
                      t(`workflowEditor.kinds.${p.kind}`)
                    }}</span>
                  </li>
                  <li v-if="!parentsOf(node.identifier).length" class="list-group-item text-muted">
                    {{ t('workflowEditor.atStart') }}
                  </li>
                </ul>
                <div class="form-check form-switch">
                  <input
                    id="wf-node-converge"
                    class="form-check-input"
                    type="checkbox"
                    :checked="node.converge"
                    :disabled="readOnly"
                    @change="setNode('converge', $event.target.checked)"
                  />
                  <label class="form-check-label" for="wf-node-converge">{{ t('workflowEditor.converge') }}</label>
                </div>
                <div class="form-text">{{ t('workflowEditor.convergeHint') }}</div>
              </div>
            </template>
            <!-- what runs after it : its links, a node there already linked, or a new one -->
            <template v-else>
              <div>
                <ul class="list-group mb-3">
                  <template v-for="kind in LINK_KINDS" :key="kind">
                    <li v-for="to in node[kind]" :key="kind + to" class="list-group-item af-wf-item">
                      <span class="af-wf-line" :style="{ background: LINK_COLORS[kind] }"></span>
                      <span class="flex-grow-1 fw-semibold">{{ to }}</span>
                      <span class="badge rounded-pill af-wf-kind-pill" :class="`af-wf-kind-${kind}`">{{
                        t(`workflowEditor.kinds.${kind}`)
                      }}</span>
                      <button
                        v-if="!readOnly"
                        type="button"
                        class="btn-close af-wf-unlink"
                        :title="t('workflowEditor.unlink')"
                        :aria-label="t('workflowEditor.unlink')"
                        @click="apply((text) => editUnlink(text, wfIndex, node.identifier, to))"
                      ></button>
                    </li>
                  </template>
                  <li
                    v-if="!node.success.length && !node.failure.length && !node.always.length"
                    class="list-group-item text-muted"
                  >
                    {{ t('workflowEditor.nothingNext') }}
                  </li>
                </ul>
                <template v-if="!readOnly">
                  <!-- a node there already : linked -->
                  <label class="form-label mb-2">{{ t('workflowEditor.linkExisting') }}</label>
                  <div class="d-flex align-items-center gap-2 mb-3">
                    <div class="input-group af-wf-kind">
                      <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="link" /></span>
                      <select v-model="linkKind" class="form-select">
                        <option v-for="kind in LINK_KINDS" :key="kind" :value="kind">
                          {{ t(`workflowEditor.kinds.${kind}`) }}
                        </option>
                      </select>
                    </div>
                    <div class="input-group">
                      <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="sitemap" /></span>
                      <select v-model="linkTo" class="form-select">
                        <option value="">{{ t('workflowEditor.linkTo') }}</option>
                        <option v-for="id in linkTargets" :key="id" :value="id">{{ id }}</option>
                      </select>
                    </div>
                    <BsButton icon="link" cssClass="text-nowrap" @click="addLink()">{{
                      t('workflowEditor.link')
                    }}</BsButton>
                  </div>
                  <!-- a new node : the wizard, linked after this one -->
                  <label class="form-label mb-2">{{ t('workflowEditor.newAfter') }}</label>
                  <div class="d-flex flex-wrap gap-2">
                    <BsButton
                      v-for="kind in LINK_KINDS"
                      :key="kind"
                      icon="plus"
                      :colorClass="{ success: 'success', failure: 'danger', always: 'info' }[kind]"
                      @click="addNode({ identifier: node.identifier, kind })"
                      >{{ t(`workflowEditor.kinds.${kind}`) }}</BsButton
                    >
                  </div>
                </template>
              </div>
            </template>
          </div>
        </template>
        <template #footer>
          <BsButton icon="code" @click="emit('reveal', node.line)">{{ t('designer.files.showInYaml') }}</BsButton>
          <BsButton v-if="!readOnly" icon="trash" @click="removeNode()">{{ t('workflowEditor.removeNode') }}</BsButton>
          <BsButton icon="times" @click="selected = null">{{ t('common.close') }}</BsButton>
        </template>
      </BsModal>

      <!-- a link : what makes it run, or gone -->
      <BsModal v-if="!preview && link" size="md" icon="link" :footerClose="false" @close="selected = null">
        <template #title>{{ t('workflowEditor.linkTitle', { from: link.from, to: link.to }) }}</template>
        <template #default>
          <label class="form-label fw-bold">{{ t('workflowEditor.runsWhen') }}</label>
          <div class="input-group">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="link" /></span>
            <select
              class="form-select"
              :value="link.kind"
              :disabled="readOnly"
              @change="setLinkKind($event.target.value)"
            >
              <option v-for="kind in LINK_KINDS" :key="kind" :value="kind">
                {{ t(`workflowEditor.kinds.${kind}`) }}
              </option>
            </select>
          </div>
        </template>
        <template #footer>
          <BsButton v-if="!readOnly" icon="trash" @click="removeLink()">{{ t('workflowEditor.unlink') }}</BsButton>
          <BsButton icon="times" @click="selected = null">{{ t('common.close') }}</BsButton>
        </template>
      </BsModal>
    </template>
  </div>
</template>
<style lang="scss" scoped>
.af-wf-block {
  margin-bottom: 1rem;
}
.af-wf-legends {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-bottom: -0.5rem;
}
.af-wf-legend {
  white-space: nowrap;
  font-size: 0.8125rem;
  color: var(--bs-secondary-color);
}
.af-wf-line {
  display: inline-block;
  width: 18px;
  height: 3px;
  border-radius: 2px;
  vertical-align: middle;
  margin-right: 6px;
}
.af-wf-problems {
  border: 1px solid var(--bs-warning-border-subtle);
  background: var(--bs-warning-bg-subtle);
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
}
.af-wf-problem {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.af-wf-canvas {
  border: 1px solid var(--af-field-border);
  border-radius: 0.5rem;
  background-color: var(--af-bg-light-subtle-color, var(--bs-body-bg));
  overflow: auto;
  padding: 0.5rem;
}
.af-wf-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 11rem;
}
.af-wf-none-icon {
  font-size: 2rem;
  opacity: 0.3;
}
.af-wf-svg {
  display: block;
}
.af-wf-link {
  cursor: pointer;
}
.af-wf-start {
  rect {
    fill: var(--bs-secondary);
  }
  text {
    fill: var(--bs-light);
    font-size: 0.7rem;
    font-weight: bold;
    letter-spacing: 1px;
  }
  &.af-wf-clickable {
    cursor: pointer;
    &:hover rect {
      fill: var(--bs-primary);
    }
  }
}
.af-wf-node {
  cursor: pointer;
  &:hover .af-wf-node-rect {
    fill: var(--af-row-hover-bg);
  }
}
.af-wf-node-rect {
  fill: var(--bs-body-bg);
  stroke-width: 2;
}
.af-wf-node-skipped {
  opacity: 0.55;
}
.af-wf-run {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}
.af-wf-node-selected .af-wf-node-rect {
  stroke-width: 3.5;
  fill: var(--bs-primary-bg-subtle);
}
.af-wf-node-name {
  fill: var(--bs-body-color);
  font-size: 0.8rem;
  font-weight: 600;
}
.af-wf-node-sub {
  fill: var(--bs-secondary-color);
  font-size: 0.7rem;
}
.af-wf-canvas {
  margin-bottom: 1rem;
}
.af-wf-out {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0;
}
.af-wf-kind {
  max-width: 13rem;
}
/* the wizard's steps : as the repositories' dialog's (AppAdminMulti) */
.af-wizard-steps {
  display: flex;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
  margin-left: 0;
}
.af-wizard-steps li {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.6rem;
  border-bottom: 3px solid var(--bs-border-color);
  color: var(--bs-secondary-color);
  white-space: nowrap;
  min-width: 0;
}
.af-wizard-steps li.reachable {
  cursor: pointer;
}
.af-wizard-steps li.done {
  border-bottom-color: rgba(var(--bs-primary-rgb), 0.45);
  color: var(--bs-body-color);
}
.af-wizard-steps li.active {
  border-bottom-color: var(--bs-primary);
  color: var(--bs-primary);
  font-weight: 600;
}
.af-wizard-n {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 0.8rem;
}
.af-wizard-steps li.active .af-wizard-n {
  background: var(--bs-primary);
  border-color: var(--bs-primary);
  color: #fff;
}
.af-wizard-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.af-wf-section + .af-wf-section {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--bs-border-color);
}
.af-wf-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.af-wf-unlink {
  font-size: 0.65rem;
  margin-left: 0.5rem;
}
/* a link's kind : its colour, soft */
.af-wf-kind-pill {
  font-weight: 600;
}
.af-wf-kind-success {
  background: var(--bs-success-bg-subtle);
  color: var(--bs-success-text-emphasis);
}
.af-wf-kind-failure {
  background: var(--bs-danger-bg-subtle);
  color: var(--bs-danger-text-emphasis);
}
.af-wf-kind-always {
  background: var(--bs-info-bg-subtle);
  color: var(--bs-info-text-emphasis);
}
.af-wf-tab-card {
  /* the tabs' grey : the card is what the tabs open on */
  border: 1px solid var(--af-field-border, var(--bs-border-color));
  border-top: 0;
  border-radius: 0 0 0.375rem 0.375rem;
  padding: 1rem;
}
</style>
