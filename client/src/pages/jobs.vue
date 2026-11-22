<script setup>
import { ref, onMounted, onBeforeUnmount, onUpdated, computed, watch, nextTick } from 'vue';
import { useJobEvents } from '@/composables/useJobEvents';
import { findRanges, showRanges, clearRanges } from '@/lib/findInText';
import { toast } from 'vue-sonner';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import axios from 'axios';
import State from '@/lib/State';
import Helpers from '@/lib/Helpers';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import YAML from 'yaml';
import Time from '@/lib/Time';
import { durationSeconds as runSeconds, formatDuration } from '@/lib/jobTime';
import { useLiveEvent } from '@/composables/useLiveEvent';
import { useFollowOutput } from '@/composables/useFollowOutput';
import BsColumnPicker from '@/components/BsColumnPicker.vue';
import { headerWidth, pillWidth, pxOf } from '@/lib/tableCells';
import { jobsPath, statusFromSlug } from '@/lib/jobsPath';
import { formPath } from '@/lib/formsPath';
import { jobTypeLabel, jobTypeName, hasArtifacts } from '@/lib/jobTypes';
import { useNodeOutput } from '@/composables/useNodeOutput';
import { mayApprove, mayDecide } from '@/lib/jobNotifications';
import { useRefreshing } from '@/composables/useRefreshing';
import { relaunchActions, relaunchBody } from '@/lib/relaunchMenu';

// INIT

const { t } = useI18n();

const router = useRouter();
const route = useRoute();
const store = useAppStore();
dayjs.extend(utc);

// DATA

const jobs = ref([]);
// the jobs loaded once : until then the menu shows the counts it had
const jobsLoaded = ref(false);
const job = ref(null);
// the job of the page could not be read (gone, not visible) : no placeholders for it
const jobMissing = ref(false);
// the summary's facts hidden under its header (the collapse at the header's left)
const summaryCollapsed = ref(false);
// a multistep job's steps, by id, as read with the job : each step's output under the main job's
const stepJobs = ref({});
// the outputs of a multistep job folded away by their title : 'main', or a step's id
const foldedOutputs = ref({});
function toggleOutput(key) {
  foldedOutputs.value = { ...foldedOutputs.value, [key]: !foldedOutputs.value[key] };
}
const isLoading = ref(false);
const jobId = ref(null);
const displayedJobs = ref([]);
// what the list's columns are fitted to (v-fit-columns) : its jobs and their status, the columns
// shown, the steps unfolded - not a running job's duration, which changes every second
const fitKey = computed(
  () =>
    displayedJobs.value.map((j) => `${j.id}:${j.status}`).join(',') +
    '|' +
    visibleColumns.value.map((c) => c.key).join(',') +
    '|' +
    Object.keys(collapsed.value || {})
      .filter((k) => collapsed.value[k])
      .join(','),
);
const showExtraVars = ref(false);
const showArtifacts = ref(false);
// a playbook job's structured events (AppJobEvents) : read with the job, shown on demand
const { jobEvents, showEvents, loadEvents } = useJobEvents();
const hide = ref(false);
const collapsed = ref({});
const showDelete = ref(false);
const showAbort = ref(false);
const showRelaunch = ref(false);
// the job whose approval is being reviewed (openReview), with its title and message filled in
const reviewJob = ref(null);
const relaunchVerbose = ref(false);
const relaunchWithEdit = ref(false);
// what the relaunch asked in the dialog is : 'all' a full relaunch, 'failedHosts' on the failed
// hosts only, 'failedNode' a workflow from its failed node (the Relaunch menu, lib/relaunchMenu.js)
const relaunchScope = ref('all');
// the job page's relaunch choices besides a full relaunch (GET /api/v2/job/:id/relaunch-options),
// read once the job has ended ; null : none, the plain Relaunch button
const relaunchOptions = ref(null);
// the job whose relaunch choices were read (answered or failed) : until then no Relaunch is shown,
// so the button and its caret appear together, never the plain button first and the caret after
const relaunchOptionsFor = ref(null);
const tempJobId = ref(null);
// the left menu's status filter : null shows every job ; /jobs/<status> opens the page on one
// (/jobs/running ; the approvals bell in the header links to /jobs/approval)
const statusFilter = ref(statusFromSlug(route.params.status));
watch(
  () => route.params.status,
  (slug) => {
    // a job's page keeps the list's filter : it is the list it goes back to
    if (!route.params.id) statusFilter.value = statusFromSlug(slug);
  },
);
// a status picked in the left menu : the address follows, so a reload or a shared link
// opens the same view
function selectStatus(status) {
  statusFilter.value = status;
  // from a job's page a status goes back to the list ; on the list it only filters
  if (isJobPage.value) router.push({ path: jobsPath(status), query: route.query });
  else router.replace({ path: jobsPath(status), query: route.query });
}

// a job that is opened (/jobs/:id) has a page of its own : its actions in the header, and
// its output - not the list. The list's status filter is kept while it shows, so going back
// opens the list as it was left (listPath).
const isJobPage = computed(() => !!route.params.id);
// the list a job was opened from (its status filter) : where its page goes back to
const listPath = computed(() => jobsPath(statusFilter.value));
// the status highlighted in the left menu : on a job's page the job's own (a step's, its main
// job's : the menu counts the main jobs), read with the job or else from the list ; on the
// list its filter
const menuStatus = computed(() => {
  if (!isJobPage.value) return statusFilter.value;
  const listed = jobs.value.find((j) => String(j.id) === String(route.params.id));
  if (listed?.parent_id) return jobs.value.find((j) => j.id === listed.parent_id)?.status ?? null;
  return job.value?.status ?? listed?.status ?? null;
});
function backToJobs() {
  router.push({ path: listPath.value, query: route.query });
}
// a job's page and the list open at the top
// to the top when a job opens or closes : the page scrolls in #app, below the header
watch(isJobPage, () => document.getElementById('app')?.scrollTo({ top: 0 }));

// where a multistep job's caret goes : before the form, or after the checkbox when the form is
// hidden (the column picker)
const caretBefore = computed(() => (visibleColumns.value.some((c) => c.key === 'form') ? 'form' : null));

// how long a job ran (lib/jobTime.js), a running one counted up with the page's clock
const durationSeconds = (j) => runSeconds(j, now.value);

/**
 * The status column's width : its widest pill, in the language shown, with the cell's padding
 * (0.9rem each side, as every table's), never narrower than its header.
 *
 * Returns:
 *   string: a CSS width in px.
 */
function statusWidth() {
  const labels = ['running', 'approve', 'success', 'failed', 'aborted'].map((s) => t(`jobs.menu.${s}`));
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize || '16');
  return `${Math.max(pxOf(pillWidth(labels, 1.8 * rem)), pxOf(headerWidth(t('jobs.status'))))}px`;
}

// ─── DataTable-style state (sort / column visibility) ─────────────────────
// the columns as wide as their values (v-fit-columns) : the short ones kept whole (keep), the form
// and the user giving way when the room is short, a long value cut with an ellipsis (its full
// text in the tooltip)
const columnDefs = computed(() => [
  // a number : to the right, as every count
  { key: 'id', label: t('jobs.id'), filterable: true, sortable: true, type: 'number', keep: true, align: 'end' },
  { key: 'form', label: t('jobs.form'), filterable: true, sortable: true },
  {
    key: 'job_type',
    label: t('jobs.jobType'),
    filterable: true,
    sortable: true,
    keep: true,
    // a template job : where it ran (jenkins, semaphore, aap ...), its runner's kind
    render: (j) => jobTypeLabel(j),
  },
  {
    key: 'start',
    label: t('jobs.startTime'),
    filterable: true,
    sortable: true,
    keep: true,
    render: (j) => formatTime(j.start),
  },
  {
    key: 'end',
    label: t('jobs.endTime'),
    filterable: true,
    sortable: true,
    keep: true,
    render: (j) => formatTime(j.end),
  },
  {
    // how long it ran : sorted by its seconds, not its text
    key: 'duration',
    label: t('jobs.duration'),
    sortable: true,
    keep: true,
    render: (j) => formatDuration(durationSeconds(j)),
    type: 'number',
    // a length, read against the others : to the right, like any number of a table
    align: 'end',
    sortValue: (j) => durationSeconds(j) ?? -1,
  },
  // as wide as its widest pill in the language shown (or its header) : no room kept for a
  // longer translation
  { key: 'status', label: t('jobs.status'), filterable: true, sortable: true, width: statusWidth() },
  {
    key: 'user',
    label: t('jobs.launchedBy'),
    filterable: true,
    sortable: true,
    render: (j) => `${j.user || ''}${j.user_type ? ' (' + j.user_type + ')' : ''}`,
  },
]);
const hiddenColumns = ref(new Set());
// the search on the title line : a job whose shown columns (or a step's id or target) hold it
const search = ref('');
const sortKey = ref(null);
const sortDir = ref(1); // 1 asc, -1 desc

const visibleColumns = computed(() => columnDefs.value.filter((c) => !hiddenColumns.value.has(c.key)));

function cellText(item, col) {
  if (!item) return '';
  if (col.render) return String(col.render(item) ?? '');
  const v = item[col.key];
  return v == null ? '' : String(v);
}

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = -sortDir.value;
  } else {
    sortKey.value = key;
    sortDir.value = 1;
  }
}

// a preset of the Columns button : its hidden columns, kept like a toggle
function applyColumnPreset(hidden) {
  hiddenColumns.value = hidden;
  try {
    Helpers.setCookie('dt_cols_jobs', JSON.stringify([...hidden]), 365);
  } catch (e) {
    /* ignore */
  }
}

function toggleColumn(key) {
  const s = new Set(hiddenColumns.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  hiddenColumns.value = s;
  try {
    Helpers.setCookie('dt_cols_jobs', JSON.stringify([...s]), 365);
  } catch (e) {
    /* ignore */
  }
}

// COMPUTED

// Check if user can relaunch jobs
// deleting jobs is a role option (allowJobDeletion, on unless a role turns it off) : without it,
// no Delete and no ticking of jobs to delete
const canDeleteJobs = computed(() => store?.profile?.options?.allowJobDeletion !== false);
// every user's jobs acted on (abort, delete, relaunch) : an admin, or a role with manageAllJobs
const managesAllJobs = computed(() => !!store.isAdmin || !!store?.profile?.options?.manageAllJobs);

/**
 * Whether the user may act on a job (abort it) : theirs, or every job with manageAllJobs.
 *
 * Args:
 *   j (object): the job.
 *
 * Returns:
 *   boolean: true when they may.
 */
function canManage(j) {
  const me = store?.profile;
  return managesAllJobs.value || (j?.user === me?.username && (j?.user_type || 'local') === (me?.type || 'local'));
}
const canRelaunchJobs = computed(() => {
  return store?.profile?.options?.allowJobRelaunch;
});

// an output as shown : the low-verbosity lines left out while the filter is on
function filterOutput(output) {
  if (!hide.value) return output?.replace(/\r\n/g, '<br>') || '';
  return (
    output
      ?.replace(/<span class='low[^<]*<\/span>/g, '')
      .replace(/\r\n/g, '<br>')
      .replace(/(<br>\s*){3,}/gi, '<br><br>') || ''
  );
}
// job output filtered
const filteredJobOutput = computed(() => filterOutput(job.value?.output));
// current job index, expressed in the pager's own index space (position
// within parentJobs). A subjob resolves to its parent so deep-linking a
// child still opens the page that holds its parent row.
const displayedJobIndex = computed(() => {
  if (!jobId.value) return -1;
  const selected = jobs.value.find((e) => e.id == jobId.value);
  if (!selected) return -1;
  const targetId = selected.parent_id ? selected.parent_id : selected.id;
  return parentJobs.value.findIndex((e) => e.id == targetId);
});
// the statuses of the left menu (AppJobsSidebar), for the page title and the line under it
// (the labels are spelled out, not built from the status, so the i18n key check can find them)
const MENU_STATUSES = [
  {
    status: 'running',
    icon: 'play',
    label: () => t('jobs.menu.running'),
    description: () => t('jobs.description.running'),
  },
  {
    status: 'approve',
    icon: 'hourglass-half',
    label: () => t('jobs.menu.approve'),
    description: () => t('jobs.description.approve'),
  },
  {
    status: 'success',
    icon: 'check',
    label: () => t('jobs.menu.success'),
    description: () => t('jobs.description.success'),
  },
  {
    status: 'failed',
    icon: 'xmark',
    label: () => t('jobs.menu.failed'),
    description: () => t('jobs.description.failed'),
  },
  {
    status: 'aborted',
    icon: 'ban',
    label: () => t('jobs.menu.aborted'),
    description: () => t('jobs.description.aborted'),
  },
  {
    status: 'rejected',
    icon: 'thumbs-down',
    label: () => t('jobs.menu.rejected'),
    description: () => t('jobs.description.rejected'),
  },
  {
    status: 'abandoned',
    icon: 'plug-circle-xmark',
    label: () => t('jobs.menu.abandoned'),
    description: () => t('jobs.description.abandoned'),
  },
];
// the page title is the view picked in the left menu (its name and icon, as in the menu)
// a job's page's title in steps : Jobs › Job #73, each a link
const pageCrumbs = computed(() =>
  isJobPage.value
    ? [
        { title: t('nav.jobs'), icon: 'history', to: listPath.value },
        { title: pageTitle.value.title, icon: 'file-lines', to: `/jobs/${route.params.id}` },
      ]
    : [],
);
const pageTitle = computed(() => {
  // a job's page : the job, by its number (the form it ran is the card's heading)
  if (isJobPage.value) {
    return { title: t('jobs.jobTitle', { id: '#' + route.params.id }), icon: 'file-lines' };
  }
  const m = MENU_STATUSES.find((x) => x.status === statusFilter.value);
  return m ? { title: m.label(), icon: m.icon } : { title: t('jobs.menu.all'), icon: 'list' };
});
// the line under the page title : what the status picked in the left menu shows
const pageDescription = computed(() => {
  // a job's page : what the page is for (the job's name is the title)
  if (isJobPage.value) return t('jobs.description.job');
  return MENU_STATUSES.find((m) => m.status === statusFilter.value)?.description() || t('jobs.description.all');
});
// the table's message when no job is shown : a status picked in the menu, a column
// filter, or simply no jobs at all
const emptyMessage = computed(() => {
  if (statusFilter.value) {
    const entry = MENU_STATUSES.find((m) => m.status === statusFilter.value);
    return t('jobs.empty.status', { status: (entry ? entry.label() : statusFilter.value).toLowerCase() });
  }
  return search.value.trim() ? t('jobs.empty.filtered') : t('jobs.empty.none');
});

// main jobs
const parentJobs = computed(() => {
  let list = jobs.value?.filter((x) => !x.parent_id) || [];

  // the left menu's status filter
  if (statusFilter.value) list = list.filter((x) => x.status === statusFilter.value);

  // The search (case-insensitive, on the text the columns show), as every table's : a job
  // whose shown columns hold it, or a multistep job whose steps' id or target does, so a
  // job is found by one of its steps
  const needle = search.value.trim().toLowerCase();
  if (needle) {
    const allJobs = jobs.value || [];
    list = list.filter(
      (item) =>
        visibleColumns.value.some((col) => cellText(item, col).toLowerCase().includes(needle)) ||
        allJobs.some(
          (c) =>
            c.parent_id === item.id &&
            (String(c.id ?? '')
              .toLowerCase()
              .includes(needle) ||
              String(c.target ?? '')
                .toLowerCase()
                .includes(needle)),
        ),
    );
  }

  // Sorting.
  if (sortKey.value) {
    const col = columnDefs.value.find((c) => c.key === sortKey.value);
    if (col) {
      const dir = sortDir.value;
      list = [...list].sort((a, b) => {
        let av = col.sortValue ? col.sortValue(a) : col.render ? col.render(a) : a[col.key];
        let bv = col.sortValue ? col.sortValue(b) : col.render ? col.render(b) : b[col.key];
        if (col.type === 'number') {
          av = Number(av);
          bv = Number(bv);
          if (isNaN(av)) av = 0;
          if (isNaN(bv)) bv = 0;
        } else {
          av = av == null ? '' : String(av);
          bv = bv == null ? '' : String(bv);
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
  }

  return list;
});
// subjobs : a multistep's steps ; a workflow's node jobs are not listed - their output is the
// workflow job's own, under each node's banner, and its graph opens it
const subjobs = computed(() => {
  if (job.value?.job_type === 'workflow') return [];
  return job.value?.subjobs || [];
});
// every step read so far, in their order, each with its output as shown : one under the other
const steps = computed(() =>
  subjobs.value
    .map((id) => stepJobs.value[id])
    .filter(Boolean)
    .map((step) => ({ ...step, shown: filterOutput(step.output) })),
);

// ─── the job at a glance (its page's summary) ─────────────────────────────────
// the extravars or the artifacts, when one of them is shown (one at a time)
const dataShown = computed(() => {
  if (!job.value) return null;
  if (showExtraVars.value) return { value: job.value.extravars ?? {} };
  if (showArtifacts.value && hasArtifacts(job.value)) return { value: job.value.awx_artifacts ?? {} };
  return null;
});
// the outputs (the job's, and the current step's) : the toolbar folds or unfolds them all
const mainOutput = ref(null);
// the output's body : a multistep job's title height set on it, for the headers pinned under the titles
const outputBody = ref(null);
function measureStepTitle() {
  const title = outputBody.value?.querySelector('.af-job-step > .af-job-title');
  outputBody.value?.style.setProperty('--af-step-title', title ? `${title.offsetHeight}px` : '0px');
}
onUpdated(measureStepTitle);
const subOutput = ref(null);

// a running job's output followed down as it comes in, while the reader is at its end
const outputPanel = ref(null);

// ─── finding a text in the output (the search box of a job's title line) ─────────────────────
// Every place the text is, whatever its case, highlighted (lib/findInText.js), the page brought to
// the first ; Enter goes to the next. Searching unfolds the output and its sections first : a
// folded line is not on the page to be found.
const outputSearch = ref('');
const outputFound = ref({ count: 0, current: -1 });
let outputRanges = [];
let outputSearchTimer = null;

/**
 * Finds the text searched in the output, highlights every place, and shows one of them.
 *
 * Args:
 *   keep (boolean): keep the one shown (the output grew while it runs) instead of the first.
 */
async function findInOutput(keep = false) {
  const q = outputSearch.value.trim();
  if (!q) {
    outputRanges = [];
    outputFound.value = { count: 0, current: -1 };
    clearRanges();
    return;
  }
  if (!keep) {
    foldedOutputs.value = {};
    mainOutput.value?.expandAll?.();
    await nextTick();
  }
  const lines = [...(outputPanel.value?.querySelectorAll('.af-ansible-text') || [])];
  outputRanges = findRanges(lines, q);
  const current = outputRanges.length
    ? keep
      ? Math.min(Math.max(outputFound.value.current, 0), outputRanges.length - 1)
      : 0
    : -1;
  outputFound.value = { count: outputRanges.length, current };
  // the output grew : the highlights follow it, the page stays where it is
  showRanges(outputRanges, current, !keep);
}

// Enter : the next place, the first again after the last
function nextInOutput() {
  if (!outputRanges.length) return findInOutput();
  const current = (outputFound.value.current + 1) % outputRanges.length;
  outputFound.value = { count: outputRanges.length, current };
  showRanges(outputRanges, current);
}

// searched as it is typed, once the typing pauses
watch(outputSearch, () => {
  clearTimeout(outputSearchTimer);
  outputSearchTimer = setTimeout(() => findInOutput(), 200);
});
// a running job's output grows : searched again, the place shown kept
watch(filteredJobOutput, () => {
  if (outputSearch.value.trim()) nextTick(() => findInOutput(true));
});
onBeforeUnmount(clearRanges);
const {
  paused: outputPaused,
  newLines: outputNewLines,
  jumpToEnd: jumpToOutputEnd,
} = useFollowOutput(
  outputPanel,
  () => steps.value.reduce((n, step) => n + step.shown.length, filteredJobOutput.value?.length || 0),
  () => job.value?.status === 'running',
);

/**
 * Folds every section of the output, or unfolds them all when all are folded.
 */
function toggleFoldAll() {
  const expand = mainOutput.value?.allFolded;
  for (const out of [mainOutput.value, subOutput.value]) {
    if (out) expand ? out.expandAll() : out.collapseAll();
  }
}

// ─── a workflow node's output, from its graph (composables/useNodeOutput.js) ──
const { nodeShown, openNodeOutput } = useNodeOutput(mainOutput);

// the playbook it ran, when it ran one
// a Rundeck job calls what the form sent its payload ; the others, Ansible's word, extravars
// what the form's values went as : a Rundeck job's payload (its options), a Jenkins build's
// parameters, else extravars - the toolbar's button and the data's title say it
const sentAs = computed(() =>
  job.value?.runner_kind === 'rundeck' ? 'payload' : job.value?.runner_kind === 'jenkins' ? 'parameters' : 'extravars',
);
const SENT_LABELS = {
  payload: { show: 'jobs.showPayload', hide: 'jobs.hidePayload', title: 'jobs.payload' },
  parameters: { show: 'jobs.showParameters', hide: 'jobs.hideParameters', title: 'jobs.parameters' },
  extravars: { show: 'jobs.showExtravars', hide: 'jobs.hideExtravars', title: 'jobs.extravars' },
};
const jobPlaybook = computed(() => job.value?.extravars?.__playbook__ || '');

// the hosts an ansible job ran on : its limit (--limit), else all of its inventories, else the
// localhost ansible falls back to without one ; null for any other job (AWX decides its own)
const jobHosts = computed(() => {
  const j = job.value;
  if (!j || (j.job_type && j.job_type != 'ansible')) return null;
  const list = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? '').trim());
  // a re-run on the failed hosts : those hosts (its __limit__ is only an older RTE's)
  if (Array.isArray(j.extravars?.__limitHosts__) && j.extravars.__limitHosts__.length) {
    return { value: list(j.extravars.__limitHosts__), note: t('jobs.failedHostsNote') };
  }
  const limit = list(j.extravars?.__limit__);
  if (limit) return { value: limit, note: '' };
  const inventory = list(j.extravars?.__inventory__);
  if (inventory) return { value: inventory, note: t('jobs.allHosts') };
  return { value: 'localhost', note: t('jobs.implicit') };
});

// a clock for a job still running (the job shown, or one in the list) : its duration counts up
// every second, till it ends
const now = ref(Date.now());
let clock = null;
watch(
  () => !!(job.value?.start && !job.value?.end) || (jobs.value || []).some((j) => j.status === 'running' && !j.end),
  (running) => {
    clearInterval(clock);
    clock = running ? setInterval(() => (now.value = Date.now()), 1000) : null;
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(clock));

// how long it ran : start to end, or to now while it runs
const jobDuration = computed(() => {
  const j = job.value;
  if (!j?.start) return '–';
  if (j.end) return formatDuration(durationSeconds(j));
  return formatDuration(Math.max(0, Math.round((now.value - new Date(j.start)) / 1000)));
});

// the output's lines, beside its title
const outputLines = computed(() => {
  const text = filteredJobOutput.value || '';
  return text
    ? text
        .replace(/<br\s*\/?>/gi, '\n')
        .trimEnd()
        .split('\n').length
    : 0;
});

// WATCHERS

// watch route changes, get job id and load the output
watch(
  () => route.params.id,
  async (id) => {
    if (id) {
      // another job : its placeholders while it is read, not the job opened before
      if (String(job.value?.id) !== String(id)) job.value = null;
      jobId.value = id;
      await loadOutput(id);
      // Expand parent if this is a child job
      const selectedJob = jobs.value.find((j) => j.id == id);
      if (selectedJob && selectedJob.parent_id) {
        collapsed.value[selectedJob.parent_id] = true;
      }
    }
  },
);

// METHODS

// copy object to clipboard as json or yaml
// (Helpers.copyToClipboard : one copy for the whole app, its promise rejecting when nothing
// was copied, so the success toast only says what really happened)
async function clip(v, doNotStringify = false, asYaml = false) {
  try {
    const text = doNotStringify ? v : asYaml ? YAML.stringify(v) : JSON.stringify(v, null, 2);
    await Helpers.copyToClipboard(text);
    toast.success(t('common.copied'));
  } catch (err) {
    toast.error(t('common.copyFailed', { error: String(err?.message || err) }));
  }
}
// copy the job's output as it reads on screen (the filter applied or not) : the output is
// html - colored spans, <br> for the line breaks - so it is copied as its plain text
function copyOutput() {
  const html = filteredJobOutput.value.replace(/<br\s*\/?>/gi, '\n');
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
  clip(text, true);
}
// load jobs
async function loadJobs() {
  if (!isLoading.value) {
    try {
      isLoading.value = true;
      const result =
        await // as many of the newest jobs as Settings > Jobs says (JOBS_LIST_SIZE)
        axios.get('/api/v2/job');
      if (result.status === 200) {
        jobs.value = result.data.records;
        jobsLoaded.value = true;
        if (jobId.value) {
          await loadOutput(jobId.value);
        }
      } else {
        toast.error(result.data.error);
      }
    } catch (err) {
      if (err.response && err.response.data && err.response.data.error) {
        toast.error(err.response.data.error);
      } else {
        toast.error(t('jobs.failedToLoad'));
      }
    } finally {
      isLoading.value = false;
      State.refreshApprovals();
      // a change came meanwhile : read now, so the last one (a job ending) is never lost
      if (livePending) {
        livePending = false;
        refreshLive();
      }
    }
  }
}
// get child jobs by parent id
function childJobs(id) {
  if (isLoading.value) return [];
  const all = jobs.value.filter((x) => x.parent_id === id);

  // a search the steps match (their id or target) : those steps shown, so a multistep job
  // does not have to be unfolded to see why it is listed
  const needle = search.value.trim().toLowerCase();

  let visible;
  if (collapsed.value[id]) {
    visible = all;
  } else if (needle) {
    visible = all.filter(
      (c) =>
        String(c.id ?? '')
          .toLowerCase()
          .includes(needle) ||
        String(c.target ?? '')
          .toLowerCase()
          .includes(needle),
    );
  } else {
    visible = [];
  }
  return visible.sort((a, b) => (a.id > b.id ? 1 : -1));
}

// the newest read of the job's own output (loadOutput)
let outputSeq = 0;
// load job output
// the output's Refresh : Refreshing... and its arrows turning, at least a second
const { refreshing: outputRefreshing, refresh: refreshOutput } = useRefreshing();
async function loadOutput(id, sub = false) {
  if (!id) {
    job.value = null;
    return;
  }
  if (!sub) {
    jobId.value = id;
    jobMissing.value = false;
  }
  let result;
  // the job's own read : numbered, so an older one that answers late (a big output, the live
  // changes coming faster) never puts back what a newer one already showed - a job ended would
  // read as running again until the next reload
  const seq = sub ? 0 : ++outputSeq;
  try {
    result = await axios.get(`/api/v2/job/${id}`);
  } catch (err) {
    if (!sub && seq === outputSeq) jobMissing.value = true;
    throw err;
  }
  if (!sub && seq !== outputSeq) return;
  if (result.status === 200) {
    const data = result.data;
    if (!sub) {
      job.value = data;
      loadEvents(id, data?.job_type);
      // every step, not only the last : a multistep job reads as its steps one after the other
      await Promise.all(subjobs.value.map((stepId) => loadOutput(stepId, true)));
    } else {
      stepJobs.value = { ...stepJobs.value, [id]: data };
      // the list's own row of the step, when it holds one, keeps its status current
      const idx = getJobIndex(id);
      if (idx >= 0) jobs.value[idx] = data;
    }
  } else {
    toast.error(result.data?.error || t('jobs.failedToLoadOutput'));
  }
}
// Live : the server says the jobs changed (lib/liveEvents.js) - one launched, its status, its
// output, one deleted - or the stream (re)opened. A job's page re-reads its output, the list
// re-reads the list : quietly, without the loading state, which would empty a multistep job's
// steps and send the pager back to page 1 a few times a second while a playbook runs.
// a change heard while the jobs load : read once they have
let livePending = false;
async function refreshLive() {
  if (isLoading.value) {
    livePending = true;
    return;
  }
  if (isJobPage.value) {
    if (jobId.value) await loadOutput(jobId.value);
    return;
  }
  try {
    const result =
      await // as many of the newest jobs as Settings > Jobs says (JOBS_LIST_SIZE)
      axios.get('/api/v2/job');
    if (result.status === 200) jobs.value = result.data.records;
  } catch {
    // the next change, or the stream opening again, re-reads
  }
}
useLiveEvent('jobs', refreshLive);
// download a job
async function download(id) {
  try {
    await Helpers.downloadFile(`/api/v2/job/${id}/download`);
  } catch (err) {
    // the server's reason (downloadFile decodes its error body), else a translated fallback
    toast.error(Helpers.parseAxiosResponseError(err, t('common.downloadFailed')));
  }
}
// display a subset of jobs (by pagination)
// where the pager is, for the footer's range (1-10 of 64)
const pagerState = ref({ page: 1, pageSize: 10 });
function setDisplayJobs(jobs, state) {
  displayedJobs.value = jobs;
  if (state) pagerState.value = state;
}
const jobsRange = computed(() => {
  const total = parentJobs.value.length;
  if (!total || !displayedJobs.value.length) return t('dataTable.rangeOf', { from: 0, to: 0, total });
  const from = (pagerState.value.page - 1) * pagerState.value.pageSize + 1;
  return t('dataTable.rangeOf', { from, to: from + displayedJobs.value.length - 1, total });
});
// format time
// a job time in the user's time zone (Profile > Preferences)
function formatTime(t) {
  return Time.format(t);
}
// get job index by id
function getJobIndex(id) {
  return jobs.value.findIndex((x) => x.id === id);
}
// The approval review : one modal to read what is asked, then approve or reject it, opened from
// a row of a job waiting for approval, its menu, or the job's page. The job is read for its
// approval only : it is not selected (jobId, job), so closing the modal leaves the page as it
// was. Deciding goes through jobAction, which does open the job, to follow what was decided.
async function openReview(id) {
  try {
    const result = await axios.get(`/api/v2/job/${id}`);
    const data = result.data;
    tempJobId.value = id;
    reviewJob.value = {
      ...data,
      message: replacePlaceholders(data.approval?.message || '', data.extravars),
    };
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err) || t('jobs.failedToRead', { id }));
  }
}
// someone else approved or rejected it while the review was open : the live list, or the job's
// page, no longer has it waiting. The buttons are disabled instead of failing on the server.
const reviewDecided = computed(() => {
  const id = reviewJob.value?.id;
  if (!id) return false;
  const live = jobs.value.find((x) => x.id === id) || (job.value?.id === id ? job.value : null);
  return !!live && live.status !== 'approve';
});
async function decide(approve) {
  const id = reviewJob.value.id;
  reviewJob.value = null;
  if (approve) await approveJob(id);
  else await rejectJob(id);
}
// a row of the list : a job waiting for an approval the user may give opens its review, any
// other job its page
function openRow(j) {
  if (j.status === 'approve' && approvalAllowed(j)) openReview(j.id);
  else getJob(j.id);
}
// replace placeholders in a string
function replacePlaceholders(msg, extravars) {
  if (!msg) {
    return '';
  }
  return msg.replace(
    /\$\(([^\)]+)\)/g, // eslint-disable-line
    (placeholderWithDelimiters, placeholderWithoutDelimiters) =>
      Helpers.htmlEncode(String(findExtravar(extravars, placeholderWithoutDelimiters) || placeholderWithDelimiters)),
  );
}
// find extravars
// The value a dotted placeholder names in the extravars (a.b.c), or undefined when a key on the
// way is missing : optional chaining, because the walk used to read master[obj] on undefined as
// soon as a middle key was absent and threw out of the approval review.
function findExtravar(data, expr) {
  return expr.split(/\s*\.\s*/).reduce((master, obj) => master?.[obj], data);
}
/**
 * Reads a job again once it was approved or rejected. An approver is often neither the job's
 * owner nor someone who sees every job : the server then refuses to show it (403), or it is
 * gone (404). That is not a failure of the decision, which went through : the job is closed
 * quietly instead (its page goes back to the list), and the list was already read again.
 *
 * Args:
 *   id (number): the job decided.
 *
 * Raises:
 *   Error: any other failure of the read, for the caller's toast.
 */
async function reloadDecided(id) {
  try {
    await loadOutput(id);
  } catch (err) {
    const status = err?.response?.status;
    if (status !== 403 && status !== 404) throw err;
    // step 1 : the job no longer selected, nor shown as missing
    job.value = null;
    jobId.value = undefined;
    jobMissing.value = false;
    // step 2 : on the job's own page, back to the list it came from
    if (isJobPage.value) router.push({ path: listPath.value, query: route.query }).catch(() => {});
  }
}
async function jobAction(id, action, method = 'post', uri_suffix = '', body = {}) {
  try {
    jobId.value = id;
    var result;
    const uri = `/api/v2/job/${id}${uri_suffix}`;
    switch (method) {
      case 'get':
        result = await axios.get(uri);
        break;
      case 'post':
        result = await axios.post(uri, body);
        break;
      case 'delete':
        result = await axios.delete(uri);
        id = undefined; // reset id after delete
        jobId.value = undefined;
        break;
      case 'patch':
        result = await axios.patch(uri, {});
        break;
      default:
        throw new Error('Invalid method');
    }
    if (result.status == 200) {
      toast.success(result.data.message || `Job ${id} ${action}ed successfully`);
      await loadJobs();
      // If relaunch, navigate to the new job
      if (action === 'relaunch' && result.data.id) {
        getJob(result.data.id);
      } else if (action === 'approve' || action === 'reject') {
        await reloadDecided(id);
      } else {
        await loadOutput(id);
      }
      tempJobId.value = undefined;
    } else {
      toast.error(result.data.message || `Failed to ${action} job ${id}`);
    }
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err) || `Failed to ${action} job ${id}`);
  } finally {
    await loadJobs();
  }
}
// ─── selection : the jobs ticked on the left, deleted together ───────────────
const selected = ref(new Set());
const showBulkDelete = ref(false);

/**
 * Whether a job can be deleted : as its row's delete icon - not one waiting for approval, and
 * a running one by an admin only.
 *
 * Args:
 *   j (object): the job.
 *
 * Returns:
 *   boolean: it can be deleted.
 */
function canDelete(j) {
  return (
    canDeleteJobs.value &&
    canManage(j) &&
    j.status != 'approve' &&
    ((j.status != 'running' && !j.abort_requested) || managesAllJobs.value)
  );
}
// the jobs of the page that can be ticked, and whether they all are
const pageSelectable = computed(() => displayedJobs.value.filter(canDelete));
const pageAllSelected = computed(
  () => pageSelectable.value.length > 0 && pageSelectable.value.every((j) => selected.value.has(j.id)),
);

/**
 * Ticks or unticks a job.
 *
 * Args:
 *   id (number): the job.
 */
function toggleSelected(id) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

// every job the list shows, on all its pages (the search applied), that can be ticked
const allSelectable = computed(() => parentJobs.value.filter(canDelete));

/**
 * Ticks every job of the list that can be deleted, on all its pages, as the other tables'
 * Select all.
 */
function selectAll() {
  selected.value = new Set(allSelectable.value.map((j) => j.id));
}

/**
 * Ticks every job of the page that can be deleted, or unticks them all.
 */
function togglePage() {
  const next = new Set(selected.value);
  const all = pageAllSelected.value;
  for (const j of pageSelectable.value) {
    if (all) next.delete(j.id);
    else next.add(j.id);
  }
  selected.value = next;
}

/**
 * Deletes the ticked jobs, one after another, and says how many were.
 */
async function deleteSelected() {
  showBulkDelete.value = false;
  const ids = [...selected.value];
  let done = 0;
  for (const id of ids) {
    try {
      await axios.delete(`/api/v2/job/${id}`);
      done++;
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err) || `Failed to delete job ${id}`);
    }
  }
  if (done) toast.success(t('jobs.deletedSelected', { count: done }, done));
  selected.value = new Set();
  await loadJobs();
}

// delete a job
async function deleteJob(id) {
  await jobAction(id, 'delete', 'delete');
  // the job of this page is gone (jobAction clears the id once the delete went through)
  if (isJobPage.value && !jobId.value) backToJobs();
}
// abort a job
async function abortJob(id) {
  await jobAction(id, 'abort', 'post', '/abort');
}
// relaunch a job (direct relaunch) ; scope 'failedHosts' : on its failed hosts only
async function relaunchJob(id, verbose = false, scope = 'all') {
  relaunchVerbose.value = false;
  relaunchScope.value = 'all';
  await jobAction(id, 'relaunch', 'post', `/relaunch?verbose=${verbose}`, relaunchBody(scope));
}
/**
 * Opens the relaunch dialog for the job of the page : the Relaunch button, its main part, or an
 * entry of its menu.
 *
 * Args:
 *   scope (string): 'all' a full relaunch, 'failedHosts' the failed hosts only, 'failedNode' a
 *     workflow from its failed node.
 */
function askRelaunch(scope = 'all') {
  tempJobId.value = job.value?.id;
  relaunchScope.value = scope;
  relaunchWithEdit.value = false;
  showRelaunch.value = true;
}
// the Relaunch menu's entries : none without a second choice (the plain button then)
const relaunchMenu = computed(() => relaunchActions(relaunchOptions.value, t));
// the failed hosts the dialog names for a relaunch on them
const relaunchHosts = computed(() => relaunchOptions.value?.failedHosts || []);
// the job page's relaunch choices : read when its job has ended and may be relaunched by this user
// (the profile's permissions among the sources : read as soon as they are known, not at the job's
// next refresh a second later ; and once at once, for a page opened on a job already read)
watch(
  () => [
    isJobPage.value,
    job.value?.id,
    job.value?.status,
    job.value?.end,
    canRelaunchJobs.value,
    store?.profile?.username,
  ],
  async ([page, id, status], [, oldId] = []) => {
    // another job : its choices are read anew, nothing shown until then ; the same job read again
    // (its status or end changed) keeps what it shows until the new answer
    if (String(id) !== String(oldId)) {
      relaunchOptions.value = null;
      relaunchOptionsFor.value = null;
    }
    if (!page || !id || status === 'running' || status === 'approve') return;
    if (!canRelaunchJobs.value || !canManage(job.value)) return;
    // read with the job (GET /api/v2/job/:id carries them for an ended job) : shown at once, with
    // the page's other buttons
    if (job.value && 'relaunchOptions' in job.value) {
      relaunchOptions.value = job.value.relaunchOptions || null;
      relaunchOptionsFor.value = String(id);
      return;
    }
    let options = null;
    try {
      const result = await axios.get(`/api/v2/job/${id}/relaunch-options`);
      options = result.data || null;
    } catch {
      // no choice besides a full relaunch : the plain button
    }
    // the job still shown : an answer for one left meanwhile is dropped
    if (String(job.value?.id) !== String(id)) return;
    relaunchOptions.value = options;
    relaunchOptionsFor.value = String(id);
  },
  { immediate: true },
);
// where a job came from : a re-run of another job (its __relaunchOf__), for its facts
const relaunchOrigin = computed(() => {
  const origin = job.value?.extravars?.__relaunchOf__;
  return origin && typeof origin === 'object' && origin.id ? origin : null;
});
// edit and relaunch - navigate to form with pre-filled data
async function editAndRelaunchJob(id) {
  relaunchWithEdit.value = false;
  // Get the job to find the form name
  try {
    const result = await axios.get(`/api/v2/job/${id}`);
    const formName = result.data.form;
    // Navigate to form with prefillJobId parameter
    router.push({ path: formPath(formName), query: { prefillJobId: id } });
    showRelaunch.value = false;
  } catch (err) {
    toast.error('Failed to load job data: ' + err.toString());
  }
}
// approve a job
async function approveJob(id) {
  await jobAction(id, 'approve', 'post', '/approve');
  State.refreshApprovals(); // refresh approvals before approving
}
// reject a job
async function rejectJob(id) {
  await jobAction(id, 'reject', 'post', '/reject');
}
// get job by id - navigation
function getJob(id) {
  router.push({ path: `/jobs/${id}`, query: route.query }).catch((_e) => {});
}
// check if the user may decide on a job waiting for approval (its review, Reject included)
// One rule with the desktop notifications (lib/jobNotifications.js mayDecide) : an admin any,
// else one of the roles the approval names. It reads the approval as the list sends it (a JSON
// string) or as the single-job endpoint does (an object), and a malformed one refuses instead
// of throwing inside the render.
function approvalAllowed(job) {
  return mayDecide(job, store.profile);
}
// and whether Approve itself is theirs to press : not on their own job unless its approval
// allows it (allowSelf) or they are an admin - the server refuses it otherwise (four eyes).
// Their own job's review still offers Reject : withdrawing it stays allowed.
function approveAllowed(job) {
  return mayApprove(job, store.profile);
}
// keep track of collapsed multistep jobs
function toggleCollapse(id) {
  if (!collapsed.value[id]) {
    collapsed.value[id] = true;
  } else {
    collapsed.value[id] = false;
  }
}
// job background color
// the row of the job shown below the list stands out ; a job's status is its pill, not the
// row's colour
function jobBackground(job) {
  return job.id == jobId.value ? 'table-selected' : '';
}

// EVENTS

// mounted
onMounted(async () => {
  // restore column visibility from cookie
  try {
    const savedCols = Helpers.getCookie('dt_cols_jobs');
    if (savedCols) {
      hiddenColumns.value = new Set(JSON.parse(savedCols));
    }
  } catch (e) {
    /* ignore */
  }

  if (route.params.id) {
    jobId.value = parseInt(route.params.id);
    try {
      await loadOutput(jobId.value);
    } catch (err) {
      // a deep link to a job that is gone (or not visible) must not
      // abort the mount : the list and the polling still have to start
      toast.error(Helpers.parseAxiosResponseError(err, t('jobs.failedToLoadOutput')));
    }
  }
  await loadJobs(true);
  // After jobs are loaded, expand parent if jobId is a child job
  if (jobId.value) {
    const selectedJob = jobs.value.find((j) => j.id == jobId.value);
    if (selectedJob && selectedJob.parent_id) {
      collapsed.value[selectedJob.parent_id] = true;
    }
  }
});
</script>
<template>
  <AppNav />
  <!-- this page scrolls with the document : it is a stack of independent blocks
       (table, pager, output actions, workflow graph, job and subjob output), not
       a single pane, so it must not be trapped in one inner scroller -->
  <div class="flex-shrink-0">
    <!-- Modal - delete verify -->
    <BsModal v-if="showDelete" size="md" @close="showDelete = false" icon="trash">
      <template #title> {{ t('jobs.deleteJob') }} {{ tempJobId }} </template>
      <template #default
        ><p class="py-3 fs-6 user-select-none">
          <i18n-t keypath="jobs.deleteConfirm" scope="global">
            <template #id
              ><strong>{{ tempJobId }}</strong></template
            >
          </i18n-t>
        </p></template
      >
      <template #footer
        ><BsButton
          icon="trash"
          @click="
            deleteJob(tempJobId);
            showDelete = false;
          "
          >{{ t('common.delete') }}</BsButton
        ></template
      >
    </BsModal>
    <!-- Modal - the ticked jobs deleted together -->
    <BsModal v-if="showBulkDelete" size="lg" @close="showBulkDelete = false" icon="trash">
      <template #title> {{ t('jobs.deleteSelected', { count: selected.size }) }} </template>
      <template #default
        ><p class="py-3 fs-6 user-select-none">
          {{ t('jobs.deleteSelectedConfirm', { count: selected.size }, selected.size) }}
        </p></template
      >
      <template #footer
        ><BsButton icon="trash" @click="deleteSelected()">{{ t('common.delete') }}</BsButton></template
      >
    </BsModal>
    <!-- Modal - abort verify -->
    <BsModal v-if="showAbort" @close="showAbort = false" icon="ban">
      <template #title> {{ t('jobs.abortJob') }} {{ tempJobId }} </template>
      <template #default
        ><p class="py-3 fs-6 user-select-none">
          <i18n-t keypath="jobs.abortConfirm" scope="global">
            <template #id
              ><strong>{{ tempJobId }}</strong></template
            >
          </i18n-t>
        </p></template
      >
      <template #footer
        ><BsButton
          icon="ban"
          @click="
            abortJob(tempJobId);
            showAbort = false;
          "
          >{{ t('jobs.abortJob') }}</BsButton
        ></template
      >
    </BsModal>
    <!-- Modal - relaunch verify -->
    <BsModal v-if="showRelaunch" size="md" @close="showRelaunch = false" icon="redo">
      <template #title> {{ t('jobs.relaunchJob') }} {{ tempJobId }} </template>
      <template #default>
        <!-- its body : as much space under it as above it, whichever lines it shows -->
        <div class="af-relaunch-body">
          <!-- on the failed hosts only : how many, and which -->
          <template v-if="relaunchScope === 'failedHosts'">
            <p class="fs-6 user-select-none">
              {{ t('jobs.relaunchFailedLead', { id: tempJobId, count: relaunchHosts.length }) }}
            </p>
            <p class="font-monospace small text-break">{{ relaunchHosts.join(', ') }}</p>
          </template>
          <!-- a workflow from its failed node : what it keeps -->
          <p v-else-if="relaunchScope === 'failedNode'" class="fs-6 user-select-none">
            {{ t('jobs.relaunchFailedNodeLead', { id: tempJobId }) }}
          </p>
          <p v-else class="fs-6 user-select-none">
            {{ t('jobs.relaunchChoose') }} <strong>{{ tempJobId }}</strong>:
          </p>
          <BsCheckbox
            v-if="store.profile.options?.allowVerboseMode"
            v-model="relaunchVerbose"
            :label="t('jobs.relaunchVerbose')"
            class="mt-2"
            :isSwitch="true"
          />
          <!-- editing the values relaunches the form as a whole : not for the failed hosts or node -->
          <BsCheckbox
            v-if="relaunchScope === 'all'"
            v-model="relaunchWithEdit"
            :label="t('jobs.relaunchEdit')"
            class="mt-2"
            :isSwitch="true"
          />
        </div>
      </template>
      <template #footer>
        <BsButton
          v-if="!relaunchWithEdit"
          icon="redo"
          @click="
            relaunchJob(tempJobId, relaunchVerbose, relaunchScope);
            showRelaunch = false;
          "
          >{{ t('jobs.relaunch') }}</BsButton
        >
        <BsButton
          v-else
          icon="edit"
          @click="
            editAndRelaunchJob(tempJobId);
            showRelaunch = false;
          "
          >{{ t('jobs.editRelaunch') }}</BsButton
        >
      </template>
    </BsModal>
    <!-- Modal - approval -->
    <BsModal v-if="reviewJob" size="md" :footerClose="false" @close="reviewJob = null" icon="hourglass-half">
      <!-- the hourglass of a job that needs approval (the jobs menu) -->
      <template #title>{{ t('jobs.reviewApproval') }}</template>
      <template #default>
        <div v-if="reviewDecided" class="alert alert-info mb-3">{{ t('jobs.alreadyDecided') }}</div>
        <!-- their own job, its approval not allowing self-approval : Reject (withdraw) only -->
        <div v-else-if="!approveAllowed(reviewJob)" class="alert alert-warning mb-3">
          {{ t('jobs.ownJobRejectOnly') }}
        </div>
        <!-- what is asked : the form's own approval message, its $(...) placeholders filled in with
             the job's values and html-encoded (replacePlaceholders) ; a generic line without one -->
        <div v-if="reviewJob.message" class="af-review-ask" v-html="reviewJob.message"></div>
        <div v-else class="af-review-ask">{{ t('jobs.reviewLead') }}</div>
        <!-- the job asking, label and value, the labels of the job page's facts : its form, its
             number (two requests from the same form share a name), who launched it -->
        <dl class="af-review-facts">
          <dt>{{ t('jobs.form') }}</dt>
          <dd>{{ reviewJob.form || reviewJob.target || '–' }}</dd>
          <dt>{{ t('jobs.jobId') }}</dt>
          <dd>#{{ reviewJob.id }}</dd>
          <dt>{{ t('jobs.launchedBy') }}</dt>
          <dd>
            {{ reviewJob.user || '–'
            }}<span v-if="reviewJob.user_type" class="af-job-fact-note">{{ reviewJob.user_type }}</span>
          </dd>
          <dt>{{ t('jobs.startTime') }}</dt>
          <dd>{{ reviewJob.start ? formatTime(reviewJob.start) : '–' }}</dd>
          <dt>{{ t('jobs.details') }}</dt>
          <dd class="af-review-link">
            <a
              href="#"
              @click.prevent="
                getJob(reviewJob.id);
                reviewJob = null;
              "
              ><FaIcon icon="arrow-up-right-from-square" class="me-1" />{{
                t('jobs.openJobDetails', { id: '#' + reviewJob.id })
              }}</a
            >
          </dd>
        </dl>
      </template>
      <!-- nothing focused, and no Enter : approving runs a playbook, it takes a click -->
      <template #footer>
        <BsButton icon="circle-xmark" colorClass="danger" :disabled="reviewDecided" @click="decide(false)">{{
          t('jobs.reject')
        }}</BsButton>
        <BsButton
          v-if="approveAllowed(reviewJob)"
          icon="circle-check"
          colorClass="success"
          :disabled="reviewDecided"
          @click="decide(true)"
          >{{ t('jobs.approve') }}</BsButton
        >
      </template>
    </BsModal>
    <!-- a workflow node's output, opened from the graph : over the full screen too -->
    <AppNodeOutputDialog
      :shown="nodeShown"
      :workflow="job?.awx_workflow"
      :jobId="jobId"
      :product="jobTypeName(job)"
      @close="nodeShown = null"
      @copy="(text) => clip(text, true)"
    />
    <main class="d-flex flex-nowrap af-settings-layout">
      <AppJobsSidebar :jobs="jobs || []" :loaded="jobsLoaded" :status="menuStatus" @select="selectStatus" />
      <!-- a job's page : no card around it all - its summary, its workflow graph and its output
           each a card of their own -->
      <AppSettings
        :title="pageTitle.title"
        :crumbs="pageCrumbs"
        :description="pageDescription"
        :icon="pageTitle.icon"
        :bare="isJobPage"
      >
        <template #headerActions>
          <!-- a job's page : the actions the list offers on its row (same rules) ; back to the list
               through the title's Jobs, or the menu's -->
          <!-- a job's page : a text found in its output, at the left as every page's search -->
          <BsSearch
            v-if="isJobPage && job"
            v-model="outputSearch"
            :title="t('jobs.findInOutputHint')"
            @keydown.enter.prevent="nextInOutput()"
          />
          <div v-if="isJobPage" class="d-flex justify-content-end align-items-center gap-2">
            <template v-if="job">
              <!-- shown once its choices are read, so the button and its caret come together -->
              <template
                v-if="
                  job.status != 'running' &&
                  job.status != 'approve' &&
                  canRelaunchJobs &&
                  canManage(job) &&
                  relaunchOptionsFor === String(job.id)
                "
              >
                <!-- a second choice (the failed hosts) : the split button the form's Submit is, its
                     main part a full relaunch ; none : the plain Relaunch button -->
                <!-- outline-primary : the plain Relaunch's look (BsButton), only a caret more -->
                <BsDropdownButton
                  v-if="relaunchMenu.length"
                  colorClass="outline-primary"
                  icon="redo"
                  :label="t('jobs.relaunchJob')"
                  cssClass="text-nowrap"
                  :actions="relaunchMenu"
                  :fullWidth="false"
                  :menuEnd="true"
                  @click="askRelaunch('all')"
                  @action="askRelaunch"
                />
                <BsButton v-else icon="redo" cssClass="text-nowrap" @click="askRelaunch('all')">{{
                  t('jobs.relaunchJob')
                }}</BsButton>
              </template>
              <BsButton
                v-if="job.status == 'running' && !job.abort_requested && canManage(job)"
                icon="ban"
                cssClass="text-nowrap"
                @click="
                  tempJobId = job.id;
                  showAbort = true;
                "
                >{{ t('jobs.abortJob') }}</BsButton
              >
              <BsButton
                v-if="canDelete(job)"
                icon="trash-alt"
                cssClass="text-nowrap"
                @click="
                  tempJobId = job.id;
                  showDelete = true;
                "
                >{{ t('jobs.deleteJob') }}</BsButton
              >
              <BsButton
                v-if="job.status == 'approve' && approvalAllowed(job)"
                icon="clipboard-check"
                cssClass="text-nowrap"
                @click="openReview(job.id)"
                >{{ t('jobs.reviewApproval') }}</BsButton
              >
            </template>
          </div>
          <div v-else class="d-flex justify-content-end align-items-center">
            <!-- the search, as every table's on the title line -->
            <BsSearch v-model="search" class="af-table-search me-2" />
            <!-- the selection, as the other tables' : how many, clear it, or tick every job on all pages -->
            <span v-if="selected.size" class="text-muted small me-2 text-nowrap">{{
              t('dataTable.selected', selected.size)
            }}</span>
            <BsButton v-if="selected.size" icon="xmark" cssClass="me-2 text-nowrap" @click="selected = new Set()">{{
              t('dataTable.clearSelection')
            }}</BsButton>
            <BsButton
              v-if="allSelectable.length && selected.size < allSelectable.length"
              icon="check-double"
              cssClass="me-2 text-nowrap"
              @click="selectAll()"
              >{{ t('dataTable.selectAll', { count: allSelectable.length }) }}</BsButton
            >
            <!-- the ticked jobs, deleted together -->
            <BsButton v-if="selected.size" icon="trash" cssClass="me-2 text-nowrap" @click="showBulkDelete = true">{{
              t('jobs.deleteSelected', { count: selected.size })
            }}</BsButton>
            <!-- Column picker, with presets (BsColumnPicker, as the other tables) -->
            <BsColumnPicker
              class="me-2"
              :columns="columnDefs"
              :hidden="hiddenColumns"
              name="jobs"
              buttonClass="btn-outline-primary"
              @toggle="toggleColumn"
              @apply="applyColumnPreset"
            />
            <!-- last, at the far right -->
            <AppRefreshButton :action="loadJobs" :label="t('jobs.refresh')" />
          </div>
        </template>
        <!-- the list : table and pager framed like the other tables, running to the card's edges -->
        <!-- the list's first load : its rows as grey placeholders (a reload keeps the rows shown) -->
        <AppSkeleton v-if="!isJobPage && !jobsLoaded && isLoading" shape="table" :count="10" />
        <div v-else-if="!isJobPage" class="af-table-frame">
          <!-- the columns fit their values, a spacer after them (directives/fitColumns.js) ; refitted
               when the rows change, not at every tick of a running job's duration -->
          <table v-fit-columns="fitKey" class="custom-table af-table table-sm">
            <thead>
              <tr class="text-start">
                <!-- tick every job of the page that can be deleted -->
                <th class="af-jobs-select">
                  <input
                    class="form-check-input"
                    type="checkbox"
                    :checked="pageAllSelected"
                    :disabled="!pageSelectable.length"
                    :aria-label="t('dataTable.selectAll', { count: pageSelectable.length })"
                    @change="togglePage()"
                  />
                </th>
                <!-- a multistep job's caret : a column of its own, the ids never moved by it, just
                     before the form (after the checkbox when the form is hidden) -->
                <th v-if="!caretBefore" class="af-jobs-expand" data-fit-keep="1.75rem"></th>
                <template v-for="col in visibleColumns" :key="col.key">
                  <th v-if="col.key === caretBefore" class="af-jobs-expand" data-fit-keep="1.75rem"></th>
                  <th
                    :class="{
                      'is-clickable': col.sortable,
                      [col.key]: true,
                      'text-end af-col-end': col.align === 'end',
                    }"
                    :data-fit-keep="col.width || (col.keep ? '' : null)"
                    :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                    @click="col.sortable ? toggleSort(col.key) : undefined"
                  >
                    {{ col.label }}
                    <span v-if="col.sortable" class="text-muted ms-1" style="font-size: 0.7em">
                      <template v-if="sortKey === col.key">
                        <font-awesome-icon :icon="sortDir === 1 ? 'sort-up' : 'sort-down'" />
                      </template>
                      <template v-else>
                        <font-awesome-icon icon="sort" class="opacity-25" />
                      </template>
                    </span>
                  </th>
                </template>
                <!-- the room left, then the row's actions at the right -->
                <th class="af-fit-spacer"></th>
                <th class="af-row-menu-col"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="j in displayedJobs" :key="j.id">
                <!-- the whole row opens the job (a multistep job's id unfolds its steps instead) : the
                   actions cell too, where the icons keep their own action -->
                <tr :class="jobBackground(j)">
                  <!-- ticked to be deleted with others ; a job that cannot be deleted cannot be ticked -->
                  <td class="af-jobs-select">
                    <input
                      class="form-check-input"
                      type="checkbox"
                      :checked="selected.has(j.id)"
                      :disabled="!canDelete(j)"
                      @change="toggleSelected(j.id)"
                    />
                  </td>
                  <!-- a multistep job's caret (before the form, or here when it is hidden) : right
                       while its steps are folded, down once they show ; its cell unfolds them,
                       another job's opens it as the rest of the row -->
                  <td
                    v-if="!caretBefore"
                    class="af-jobs-expand text-center"
                    role="button"
                    @click="j.job_type == 'multistep' ? toggleCollapse(j.id) : openRow(j)"
                  >
                    <font-awesome-icon
                      v-if="j.job_type == 'multistep'"
                      :icon="collapsed[j.id] ? 'angle-down' : 'angle-right'"
                      fixed-width
                    />
                  </td>
                  <template v-for="col in visibleColumns" :key="col.key">
                    <td
                      v-if="col.key === caretBefore"
                      class="af-jobs-expand text-center"
                      role="button"
                      @click="j.job_type == 'multistep' ? toggleCollapse(j.id) : openRow(j)"
                    >
                      <font-awesome-icon
                        v-if="j.job_type == 'multistep'"
                        :icon="collapsed[j.id] ? 'angle-down' : 'angle-right'"
                        fixed-width
                      />
                    </td>
                    <!-- its number, to the right as every count -->
                    <td v-if="col.key === 'id'" role="button" class="text-end af-col-end" @click="openRow(j)">
                      {{ j.id }}
                    </td>
                    <td v-else-if="col.key === 'status'" role="button" class="text-start" @click="openRow(j)">
                      <AppStatusPill :status="j.status" />
                    </td>
                    <!-- the form in the link blue, as a list's name : the row opens the job -->
                    <!-- a column with align 'end' (a duration) to the right, as its header -->
                    <td
                      v-else
                      role="button"
                      :class="[
                        col.align === 'end' ? 'text-end af-col-end' : 'text-start',
                        { 'af-row-open': col.key === 'form' },
                      ]"
                      @click="openRow(j)"
                      :title="cellText(j, col)"
                    >
                      {{ cellText(j, col) }}
                    </td>
                  </template>
                  <td class="af-fit-spacer"></td>
                  <!-- the row's menu, as every table's : what can be done with the job, Delete last -->
                  <td class="bs-dt-row-actions">
                    <div class="dropdown">
                      <!-- fixed, so the menu opens over the table's frame instead of being cut by it -->
                      <button
                        type="button"
                        class="bs-dt-row-menu px-2"
                        data-bs-toggle="dropdown"
                        data-bs-popper-config='{"strategy":"fixed"}'
                        :aria-label="t('common.actions')"
                      >
                        <font-awesome-icon icon="ellipsis-vertical" />
                      </button>
                      <ul class="dropdown-menu dropdown-menu-end">
                        <li>
                          <a class="dropdown-item" href="#" @click.prevent="getJob(j.id)"
                            ><font-awesome-icon icon="file-lines" class="me-2" />{{ t('common.open') }}</a
                          >
                        </li>
                        <!-- what can be done with it, apart from opening it -->
                        <li
                          v-if="
                            (j.status != 'running' && j.status != 'approve' && canRelaunchJobs && canManage(j)) ||
                            (j.status == 'running' && !j.abort_requested && canManage(j)) ||
                            (j.status == 'approve' && approvalAllowed(j))
                          "
                        >
                          <hr class="dropdown-divider" />
                        </li>
                        <li v-if="j.status != 'running' && j.status != 'approve' && canRelaunchJobs && canManage(j)">
                          <a
                            class="dropdown-item"
                            href="#"
                            @click.prevent="
                              tempJobId = j.id;
                              relaunchScope = 'all';
                              showRelaunch = true;
                            "
                            ><font-awesome-icon icon="redo" class="me-2" />{{ t('jobs.relaunch') }}</a
                          >
                        </li>
                        <li v-if="j.status == 'running' && !j.abort_requested && canManage(j)">
                          <a
                            class="dropdown-item"
                            href="#"
                            @click.prevent="
                              tempJobId = j.id;
                              showAbort = true;
                            "
                            ><font-awesome-icon icon="ban" class="me-2" />{{ t('common.abort') }}</a
                          >
                        </li>
                        <li v-if="j.status == 'approve' && approvalAllowed(j)">
                          <a class="dropdown-item" href="#" @click.prevent="openReview(j.id)"
                            ><font-awesome-icon icon="clipboard-check" class="me-2" />{{ t('jobs.reviewApproval') }}</a
                          >
                        </li>
                        <!-- Delete : not there at all for a role without allowJobDeletion -->
                        <li v-if="canDeleteJobs"><hr class="dropdown-divider" /></li>
                        <li v-if="canDeleteJobs">
                          <a
                            class="dropdown-item"
                            :class="canDelete(j) ? 'text-danger' : 'disabled text-muted'"
                            href="#"
                            @click.prevent="
                              tempJobId = j.id;
                              showDelete = true;
                            "
                            ><font-awesome-icon icon="trash-alt" class="me-2" />{{ t('common.delete') }}</a
                          >
                        </li>
                      </ul>
                    </div>
                  </td>
                </tr>
                <template v-for="c in childJobs(j.id)" :key="c.id">
                  <tr :class="jobBackground(c)">
                    <td class="table-info" role="button" @click="getJob(c.id)"></td>
                    <td v-if="!caretBefore" class="af-jobs-expand" role="button" @click="getJob(c.id)"></td>
                    <template v-for="col in visibleColumns" :key="col.key">
                      <td
                        v-if="col.key === caretBefore"
                        class="af-jobs-expand"
                        role="button"
                        @click="getJob(c.id)"
                      ></td>
                      <!-- a step's number under its job's -->
                      <td v-if="col.key === 'id'" role="button" class="text-end af-col-end" @click="getJob(c.id)">
                        {{ c.id }}
                      </td>
                      <td
                        v-else-if="col.key === 'form'"
                        role="button"
                        class="text-start af-row-open"
                        @click="getJob(c.id)"
                        :title="c.target"
                      >
                        {{ c.target }}
                      </td>
                      <td v-else-if="col.key === 'status'" role="button" class="text-start" @click="getJob(c.id)">
                        <AppStatusPill :status="c.status" />
                      </td>
                      <td
                        v-else
                        role="button"
                        :class="col.align === 'end' ? 'text-end af-col-end' : 'text-start'"
                        @click="getJob(c.id)"
                        :title="cellText(c, col)"
                      >
                        {{ cellText(c, col) }}
                      </td>
                    </template>
                    <td class="af-fit-spacer"></td>
                    <td role="button" @click="getJob(c.id)"></td>
                  </tr>
                </template>
              </template>
              <!-- nothing to show : say why, above the pagination -->
              <tr v-if="!isLoading && parentJobs.length === 0" class="af-empty-row">
                <!-- as much room under the text as above it : the message centred between the
                   table's header and its frame -->
                <td :colspan="visibleColumns.length + 4" class="text-center text-body-secondary py-4">
                  <FaIcon icon="circle-info" class="me-2" />{{ emptyMessage }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- the job being read : its facts and its output as grey placeholders -->
        <template v-if="isJobPage && !job && !jobMissing">
          <AppSkeleton shape="facts" :count="6" />
          <AppSkeleton shape="output" :count="14" />
        </template>
        <div v-if="job && isJobPage" class="row af-job-output">
          <div class="col">
            <!-- the job at a glance : its number and state, then what ran, who launched it, when
                 and for how long -->
            <!-- a card as the graph's and the output's : the job's name and pills its header, the
                 facts its body -->
            <div class="af-job-summary" :class="{ 'af-job-summary-collapsed': summaryCollapsed }">
              <div class="af-job-heading">
                <!-- hide or show the facts, as the graph's and the output's collapse : the header stays -->
                <button
                  type="button"
                  class="af-tool-btn af-tool-icon af-job-collapse"
                  :title="summaryCollapsed ? t('jobs.showDetails') : t('jobs.hideDetails')"
                  :aria-label="summaryCollapsed ? t('jobs.showDetails') : t('jobs.hideDetails')"
                  :aria-expanded="!summaryCollapsed"
                  @click="summaryCollapsed = !summaryCollapsed"
                >
                  <FaIcon :icon="summaryCollapsed ? 'angles-down' : 'angles-up'" />
                </button>
                <h3 class="af-job-number">{{ job.form || t('jobs.jobTitle', { id: '#' + jobId }) }}</h3>
                <AppStatusPill :status="job.status" />
                <AppStatusPill :label="jobTypeName(job)" tone="grey" />
              </div>
              <dl v-show="!summaryCollapsed" class="af-job-facts">
                <!-- an ansible job : the hosts it ran on (its limit, else its inventories, else the
                     implicit localhost) ; any other job : its form -->
                <div v-if="jobHosts" class="af-job-fact">
                  <dt><FaIcon icon="server" />{{ t('jobs.hosts') }}</dt>
                  <!-- one line : the hosts cut short when long, their note always seen -->
                  <dd :title="jobHosts.value" class="af-job-fact-split">
                    <span class="af-job-fact-text">{{ jobHosts.value }}</span><span
                      v-if="jobHosts.note"
                      class="af-job-fact-note"
                      >{{ jobHosts.note }}</span
                    >
                  </dd>
                </div>
                <div v-else class="af-job-fact">
                  <dt><FaIcon icon="pen-to-square" />{{ t('jobs.form') }}</dt>
                  <dd :title="job.form">{{ job.form || '–' }}</dd>
                </div>
                <!-- an AWX job : the job template it launched, and its job's number in AWX -->
                <div v-if="job.job_type == 'awx'" class="af-job-fact">
                  <dt><FaIcon icon="scroll" />{{ t('jobs.template') }}</dt>
                  <!-- the template cut short when long, its #id always seen -->
                  <dd :title="job.target" class="af-job-fact-split">
                    <span class="af-job-fact-text">{{ job.target || '–' }}</span>
                    <span v-if="job.awx_id" class="af-job-fact-note">
                      <a
                        v-if="job.runner_job_url"
                        :href="job.runner_job_url"
                        target="_blank"
                        rel="noopener noreferrer"
                        :title="t('jobs.openInRunner', { id: job.awx_id, product: jobTypeName(job) })"
                        >#{{ job.awx_id }}<FaIcon icon="arrow-up-right-from-square" class="ms-1"
                      /></a>
                      <template v-else>#{{ job.awx_id }}</template>
                    </span>
                  </dd>
                </div>
                <!-- a workflow job : the workflow it ran, and how many nodes (where a playbook job's playbook is) -->
                <div v-else-if="job.job_type == 'workflow' && job.awx_workflow" class="af-job-fact">
                  <dt><FaIcon icon="diagram-project" />{{ t('workflow.title') }}</dt>
                  <!-- one line : the workflow cut short when long, its node count always seen -->
                  <dd :title="job.awx_workflow.name" class="af-job-fact-split">
                    <span class="af-job-fact-text">{{ job.awx_workflow.name }}</span><span class="af-job-fact-note">{{
                      t('workflow.nodes', { count: job.awx_workflow.nodes?.length || 0 })
                    }}</span>
                  </dd>
                </div>
                <div v-else-if="jobPlaybook" class="af-job-fact">
                  <dt><FaIcon icon="scroll" />{{ t('jobs.playbook') }}</dt>
                  <dd class="font-monospace" :title="jobPlaybook">{{ jobPlaybook }}</dd>
                </div>
                <div class="af-job-fact">
                  <dt><FaIcon icon="user" />{{ t('jobs.launchedBy') }}</dt>
                  <!-- one line : the user cut short when long, how it signs in always seen -->
                  <dd :title="job.user" class="af-job-fact-split">
                    <span class="af-job-fact-text">{{ job.user || '–' }}</span><span
                      v-if="job.user_type"
                      class="af-job-fact-note"
                      >{{ job.user_type }}</span
                    >
                  </dd>
                </div>
                <div class="af-job-fact">
                  <dt><FaIcon icon="play" />{{ t('jobs.startTime') }}</dt>
                  <dd>{{ job.start ? formatTime(job.start) : '–' }}</dd>
                </div>
                <div class="af-job-fact">
                  <dt><FaIcon icon="flag-checkered" />{{ t('jobs.endTime') }}</dt>
                  <dd>{{ job.end ? formatTime(job.end) : '–' }}</dd>
                </div>
                <div class="af-job-fact">
                  <dt><FaIcon icon="stopwatch" />{{ t('jobs.duration') }}</dt>
                  <dd class="af-job-duration">{{ jobDuration }}</dd>
                </div>
                <!-- a re-run of another job : which one, and on what -->
                <div v-if="relaunchOrigin" class="af-job-fact">
                  <dt><FaIcon icon="redo" />{{ t('jobs.relaunchOf') }}</dt>
                  <dd class="af-job-fact-split">
                    <span class="af-job-fact-text"
                      ><a href="#" @click.prevent="getJob(relaunchOrigin.id)">#{{ relaunchOrigin.id }}</a></span
                    ><span v-if="relaunchOrigin.scope === 'failedHosts'" class="af-job-fact-note">{{
                      t('jobs.failedHostsNote')
                    }}</span
                    ><span v-else-if="relaunchOrigin.scope === 'failedNode'" class="af-job-fact-note">{{
                      t('jobs.failedNodeNote')
                    }}</span>
                  </dd>
                </div>
                <!-- launched from a stored job : its name, a link to its page ; none when this user
                     does not see it, or it was deleted since (the server sends none then) -->
                <div v-if="job.storedJob" class="af-job-fact">
                  <dt><FaIcon icon="floppy-disk" />{{ t('settings.storedJobs.label') }}</dt>
                  <dd :title="job.storedJob.name">
                    <router-link :to="`/jobs/stored/${job.storedJob.id}`">{{ job.storedJob.name }}</router-link>
                  </dd>
                </div>
                <div v-if="job.job_type == 'multistep' && job.subjobs?.length" class="af-job-fact">
                  <dt><FaIcon icon="layer-group" />{{ t('jobs.steps') }}</dt>
                  <dd>{{ job.subjobs.length }}</dd>
                </div>
              </dl>
            </div>

            <!-- awx workflow graph (only for awx workflow jobs) -->
            <div class="row" v-if="job.awx_workflow?.nodes?.length">
              <div class="col">
                <AppAwxWorkflow :workflow="job.awx_workflow" :product="jobTypeName(job)" @node="openNodeOutput" />
              </div>
            </div>

            <!-- the output, in a panel : its toolbar on top - what is shown at the left, what to
                 do with it at the right -->
            <div ref="outputPanel" class="af-output-panel">
              <div class="af-output-toolbar">
                <div class="af-output-label">
                  <!-- fold or unfold every section, PLAY and TASK of the output -->
                  <button
                    v-if="mainOutput"
                    type="button"
                    class="af-tool-btn af-tool-icon"
                    :title="mainOutput.allFolded ? t('jobs.expandAll') : t('jobs.collapseAll')"
                    :aria-label="mainOutput.allFolded ? t('jobs.expandAll') : t('jobs.collapseAll')"
                    @click="toggleFoldAll"
                  >
                    <FaIcon :icon="mainOutput.allFolded ? 'angles-down' : 'angles-up'" />
                  </button>
                  <FaIcon icon="terminal" />
                  <span>{{ t('jobs.output') }}</span>
                  <span class="af-output-count">{{ t('jobs.lines', { count: outputLines }) }}</span>
                  <!-- the places the search found, and which one is shown -->
                  <span v-if="outputSearch.trim()" class="af-output-count">{{
                    outputFound.count
                      ? t('jobs.foundInOutput', { current: outputFound.current + 1, count: outputFound.count })
                      : t('jobs.notFoundInOutput')
                  }}</span>
                </div>
                <div class="af-output-actions">
                  <!-- the failed tasks (else the error lines) : each click the next one -->
                  <AppOutputFailures :output="mainOutput" :jobId="jobId" />
                  <button type="button" class="af-tool-btn" :class="{ active: hide }" @click="hide = !hide">
                    <FaIcon :icon="hide ? 'filter-circle-xmark' : 'filter'" />
                    {{ hide ? t('jobs.removeFilter') : t('jobs.applyFilter') }}
                  </button>
                  <button
                    v-if="store.profile.options?.showExtraVars"
                    type="button"
                    class="af-tool-btn"
                    :class="{ active: showExtraVars }"
                    @click="
                      showExtraVars = !showExtraVars;
                      showArtifacts = false;
                    "
                  >
                    <FaIcon :icon="showExtraVars ? 'eye-slash' : 'eye'" />
                    {{ showExtraVars ? t(SENT_LABELS[sentAs].hide) : t(SENT_LABELS[sentAs].show) }}
                  </button>
                  <button
                    v-if="store.profile.options?.showArtifacts && hasArtifacts(job)"
                    type="button"
                    class="af-tool-btn"
                    :class="{ active: showArtifacts }"
                    @click="
                      showArtifacts = !showArtifacts;
                      showExtraVars = false;
                    "
                  >
                    <FaIcon :icon="showArtifacts ? 'square-poll-horizontal' : 'square-poll-vertical'" />
                    {{ showArtifacts ? t('jobs.hideArtifacts') : t('jobs.showArtifacts') }}
                  </button>
                  <!-- a playbook's hosts and tasks, from its structured events -->
                  <button
                    v-if="jobEvents.length"
                    type="button"
                    class="af-tool-btn"
                    :class="{ active: showEvents }"
                    @click="showEvents = !showEvents"
                  >
                    <FaIcon icon="table-cells" />{{ t('jobs.events.button') }}
                  </button>
                  <span class="af-tool-sep" />
                  <!-- its two arrows turn and it says Refreshing... while the output reads again (useRefreshing) -->
                  <button
                    type="button"
                    class="af-tool-btn"
                    :title="t('jobs.refreshOutput')"
                    @click="refreshOutput(() => loadOutput(jobId))"
                  >
                    <FaIcon icon="sync-alt" :spin="outputRefreshing" />{{
                      outputRefreshing ? t('common.refreshing') : t('jobs.refreshOutput')
                    }}
                  </button>
                  <button type="button" class="af-tool-btn" :title="t('jobs.copyOutput')" @click="copyOutput">
                    <FaIcon icon="copy" />{{ t('jobs.copyOutput') }}
                  </button>
                  <button type="button" class="af-tool-btn" :title="t('jobs.downloadOutput')" @click="download(jobId)">
                    <FaIcon icon="download" />{{ t('jobs.downloadOutput') }}
                  </button>
                </div>
              </div>
              <!-- the extravars or the artifacts, when shown : under the toolbar, above the output -->
              <AppOutputData
                v-if="dataShown"
                :title="showExtraVars ? t(SENT_LABELS[sentAs].title) : t('jobs.artifacts')"
                :icon="showExtraVars ? 'eye' : 'square-poll-vertical'"
                :value="dataShown.value"
                @copy="(value, asYaml) => clip(value, false, asYaml)"
                @close="
                  showExtraVars = false;
                  showArtifacts = false;
                "
              />
              <!-- the hosts and tasks, when shown : under the toolbar, above the output -->
              <AppJobEvents v-if="showEvents && jobEvents.length" :events="jobEvents" @close="showEvents = false" />
              <div ref="outputBody" class="row g-0 af-output-body">
                <div class="col">
                  <!-- a multistep job's titles fold their output (click, Enter, Space), as the
                       output's own section heads do -->
                  <!-- the main job : its title and its output together, so its title sticks over its own
                       output only, as each step's -->
                  <div class="af-job-step">
                    <h3
                      v-if="steps.length"
                      class="af-job-title"
                      role="button"
                      tabindex="0"
                      :aria-expanded="!foldedOutputs.main"
                      :class="{ 'is-folded': foldedOutputs.main }"
                      @click="toggleOutput('main')"
                      @keydown.enter.self.prevent="toggleOutput('main')"
                      @keydown.space.self.prevent="toggleOutput('main')"
                    >
                      <FaIcon :icon="foldedOutputs.main ? 'chevron-right' : 'chevron-down'" class="af-job-chevron" />
                      {{ t('jobs.mainJob') }} {{ t('jobs.jobIdNote', { id: jobId }) }}
                      <AppStatusPill :status="job.status" />
                    </h3>
                    <!-- a wrapper to fold : the output has more than one root, v-show cannot reach it -->
                    <div v-show="!foldedOutputs.main">
                      <AppAnsibleOutput
                        ref="mainOutput"
                        :copyLabel="t('jobs.copy')"
                        @copy="(text) => clip(text, true)"
                        :output="filteredJobOutput"
                        :jobLog="job?.job_log"
                        :workflow="job?.awx_workflow"
                        :title="job.job_type == 'awx' ? job.target : jobPlaybook || job.form"
                        :jobId="jobId"
                        :events="jobEvents"
                        numbered
                        lineLinks
                      />
                    </div>
                  </div>
                  <!-- a multistep job's steps under it, in their order : the whole run reads down -->
                  <div v-for="(step, i) in steps" :key="step.id" class="af-job-step">
                    <h3
                      class="af-job-title"
                      role="button"
                      tabindex="0"
                      :aria-expanded="!foldedOutputs[step.id]"
                      :class="{ 'is-folded': foldedOutputs[step.id] }"
                      @click="toggleOutput(step.id)"
                      @keydown.enter.self.prevent="toggleOutput(step.id)"
                      @keydown.space.self.prevent="toggleOutput(step.id)"
                    >
                      <FaIcon
                        :icon="foldedOutputs[step.id] ? 'chevron-right' : 'chevron-down'"
                        class="af-job-chevron"
                      />
                      {{ t('jobs.stepN', { n: i + 1 }) }}<template v-if="step.target"> · {{ step.target }}</template>
                      {{ t('jobs.jobIdNote', { id: step.id }) }}
                      <AppStatusPill :status="step.status" />
                    </h3>
                    <div v-show="!foldedOutputs[step.id]">
                      <AppAnsibleOutput :output="step.shown" :jobLog="step.job_log" :jobId="step.id" numbered />
                    </div>
                  </div>
                  <!-- scrolled up while it runs : back to its end, following again -->
                  <AppFollowButton
                    :show="outputPaused"
                    :new-lines="outputNewLines"
                    :bottom="job.status === 'running' ? '5.75rem' : '0.75rem'"
                    @click="jumpToOutputEnd"
                  />
                </div>
              </div>
            </div>
            <!-- a running job : its status and Abort under the output, held at the window's bottom while
                 the output scrolls under it, as the form's page does (Abort at once, as there ; the
                 header's Abort asks first) -->
            <div v-if="job.status === 'running'" class="af-job-run-actions">
              <button type="button" class="btn btn-primary text-white flex-fill" disabled>
                <FaIcon icon="spinner" /><span class="ms-3">{{ t('form.running') }}</span>
              </button>
              <button
                v-if="!job.abort_requested && canManage(job)"
                type="button"
                class="btn btn-danger text-white flex-fill"
                @click="abortJob(job.id)"
              >
                <FaIcon icon="stop" /><span class="ms-3">{{ t('form.abort') }}</span>
              </button>
            </div>
          </div>
        </div>
        <!-- the list's pager : the rows shown, the page size and boxes, under the card as every
             table's -->
        <template #footer>
          <div v-if="!isJobPage" class="af-table-pager">
            <span class="af-table-count">{{ jobsRange }}</span>
            <BsPagination
              v-if="!isLoading"
              :dataList="parentJobs"
              :buttonsShown="7"
              :index="displayedJobIndex"
              name="jobs"
              @change="setDisplayJobs"
            />
          </div>
        </template>
      </AppSettings>
      <!-- a long job's page : up to its top, down to its end (over the Running bar while it runs) -->
      <AppScrollButtons v-if="isJobPage" :overBar="job?.status === 'running'" />
    </main>
  </div>
</template>
<style scoped lang="scss">
/* the relaunch dialog's body : 1rem above and below it, as the other dialogs' sentence (py-3), its
   last line without a margin of its own, whichever lines it shows */
.af-relaunch-body {
  padding: 1rem 0;
}
.af-relaunch-body > :last-child {
  margin-bottom: 0;
}
/* the output box keeps 16px under it for what follows it (the log file, the form page's
   buttons) ; last in the job's card it would double the card's own padding */
.af-job-output :deep(.ansible:last-child) {
  margin-bottom: 0;
}
/* "Main job (jobid 97)", "Step 1 · ... (jobid 98)" : a header bar over its output, the grey
   and the divider of the output's own section heads (AppAnsibleOutput's .af-node-head) */
/* a multistep job's titles stick at the top over their own output, its section's header pinned
   under them : both seen while it scrolls by (the height for the header : measureStepTitle) */
.af-job-step > .af-job-title {
  position: sticky;
  top: 0;
  z-index: 4;
}
.af-job-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.625rem 1.25rem;
  background: var(--bs-tertiary-bg);
  border-bottom: 1px solid var(--af-field-border);
  cursor: pointer;
  user-select: none;
  .badge {
    font-size: 0.5em;
  }
}
/* a running job's status and Abort, as the form's page's : held at the window's bottom */
.af-job-run-actions {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  gap: 1rem;
  padding: 1rem 0 1.5rem;
  background: var(--bs-body-bg);
}
/* ─── a job's page : the summary on top ─────────────────────────────────────── */
.af-job-summary {
  margin-bottom: 1.25rem;
  container-type: inline-size;
  border: 1px solid var(--af-field-border);
  border-radius: 0.5rem;
  overflow: hidden;
  background: var(--bs-body-bg);
}
/* its header, as the graph's and the output's toolbars : the job's name, its status and its type
   on one line, the pills on the middle of the name */
.af-job-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1.125rem;
  border-bottom: 1px solid var(--af-field-border);
  background: var(--bs-tertiary-bg);
}
/* the collapse : as far in as the output's, as wide ; no line under a collapsed header */
.af-job-collapse {
  margin-left: calc(-0.5rem - 1px);
  svg {
    width: 0.75rem;
  }
}
.af-job-summary-collapsed .af-job-heading {
  border-bottom: 0;
}
.af-job-number {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
/* the facts in a grid of three, the card's body : what ran and who launched it on the first row,
   when and how long on the second ; two columns, then one, as the page narrows. A hairline
   between them */
.af-job-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
}
@container (max-width: 44rem) {
  .af-job-facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width: 28rem) {
  .af-job-facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
.af-job-fact {
  min-width: 0;
  padding: 0.75rem 1.125rem;
  /* the hairline at each fact's left and top : the outer ones hidden under the frame */
  box-shadow:
    -1px 0 0 var(--bs-border-color),
    0 -1px 0 var(--bs-border-color);
  dt {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--bs-secondary-color);
    svg {
      width: 0.8rem;
      opacity: 0.8;
    }
  }
  dd {
    margin: 0;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  dd.font-monospace {
    font-size: 0.875rem;
    font-weight: 400;
  }
}
/* a value and its note on one line : the value cut short, the note whole */
.af-job-fact dd.af-job-fact-split {
  display: flex;
  align-items: baseline;
  .af-job-fact-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .af-job-fact-note {
    flex-shrink: 0;
    svg {
      font-size: 0.65rem;
    }
  }
}
/* the approval review (openReview) : its question and facts are shared with the runners' review
   (styles/facts.scss) */
/* the kind of user, after the name : a quiet tag */
.af-job-fact-note {
  margin-left: 0.375rem;
  padding: 0.05rem 0.4rem;
  border-radius: 0.25rem;
  /* a note (local, 20 nodes, implicit) a little smaller than its value ; one that is a link (the
     job's #number in the product it ran on) at the value's size, to tell them apart */
  font-size: 0.8125rem;
  font-weight: 400;
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
}
.af-job-fact-note:has(a) {
  font-size: 1rem;
}
.af-job-duration {
  font-variant-numeric: tabular-nums;
}
/* approve and reject on a job waiting for approval : in the light theme the app darkens
   green and red text (textColors.scss), which made these two icons heavy ; they keep
   Bootstrap's own, lighter colors */
[data-bs-theme='light'] .af-approve-icon {
  color: var(--bs-success) !important;
}
[data-bs-theme='light'] .af-reject-icon {
  color: var(--bs-danger) !important;
}
/* the "no jobs" message is a table row, but not a job : no row separator under it */
.af-empty-row td {
  border-bottom: 0 !important;
  box-shadow: none !important;
}
/* Status badge in the ansible-output headings. Same rule as form.vue, which
       renders the identical markup — scoped styles don't cross components, so
       it has to be repeated here rather than shared. Limited to the badge : the
       table's header cells carry their column key as a class, and a bare .status
       shrank the "status" column header too. */
.badge.status {
  font-size: 0.75rem;
}
/* the jobs table : the shared look (styles/tables.scss), plus every cell on one line (the
   action icons side by side, a date not broken in two) */
/* a multistep job's step under the output before it : a line where one ends and the next begins */
/* folded, nothing under it to divide from : the next step's own line is the only one */
.af-job-title.is-folded {
  border-bottom: 0;
}
/* the fold chevron of a title : as the output's own section heads' (.af-node-chevron) */
.af-job-chevron {
  width: 0.75rem;
  color: var(--bs-secondary-color);
}
/* a hairline between the steps : not over the first (the main job), right under the toolbar's own */
.af-job-step + .af-job-step {
  border-top: 1px solid var(--af-field-border);
}
.custom-table {
  /* 20px lines : every row a whole 45px (12px padding twice, a 1px border). At 1.2 a row was
     44.19px, and the browser rounding each row's edges made one row in five a pixel taller */
  line-height: 1.25;
  /* the columns are laid out by v-fit-columns, as every table's : the short ones kept whole, the
     form and the user as wide as their values, a spacer the rest ; too narrow, the form and the
     user give way down to 12 characters, then the frame scrolls sideways */
  table-layout: fixed;
  width: 100%;
}
.custom-table tbody td {
  white-space: nowrap;
}
/* a value longer than its column : cut with an ellipsis, its full text in the tooltip */
.custom-table tbody td:not(.bs-dt-row-actions),
.custom-table thead th {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* a right-aligned column right before the caret (the id) : the caret already keeps the number
   from the form, so only the cells' usual room after it, the caret then halfway between both */
.custom-table.af-table th.af-col-end:not(:first-child):not(:last-child):has(+ .af-jobs-expand),
.custom-table.af-table td.af-col-end:not(:first-child):not(:last-child):has(+ .af-jobs-expand) {
  padding-right: 0.9rem;
}
/* the caret itself : lighter than the row's text (already the secondary grey), the text's colour
   when hovered, the row's own on a selected row */
.custom-table td.af-jobs-expand svg {
  color: var(--bs-tertiary-color);
}
.custom-table td.af-jobs-expand:hover svg {
  color: var(--bs-body-color);
}
.custom-table tr.table-selected td.af-jobs-expand svg {
  color: inherit;
}
/* the caret column of a multistep job : as wide as the caret and a little room on each side
   (1.75rem : the caret's 1.25rem and its padding), and never an ellipsis
   (an icon is not cut) ; over the table's own cell padding */
.custom-table.af-table th.af-jobs-expand:not(:first-child):not(:last-child),
.custom-table.af-table td.af-jobs-expand:not(:first-child):not(:last-child) {
  padding-left: 0.25rem;
  padding-right: 0.25rem;
  text-overflow: clip;
}
/* the checkbox column : as wide as a checkbox and the first cell's padding */
.custom-table .af-jobs-select {
  width: calc(1.25rem + 1rem + 0.5rem);
  padding-right: 0.5rem;
}

tr.table-selected {
  border: 2px solid;
  border-left: none;
  border-right: none;
  td {
    border-left: none;
    border-right: none;
  }
}
</style>
