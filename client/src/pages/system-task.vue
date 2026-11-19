<script setup>
/******************************************************************/
/*                                                                */
/*  A maintenance task's page (/jobs/system/<key>), opened from   */
/*  the system tasks' list : one of the app's own tasks, in tabs, */
/*  the tab kept in the url -                                     */
/*    Details  its name and what it does, then read only : when   */
/*             it runs, its last run and its result, its next     */
/*             run, and the setting it applies (where it is       */
/*             changed, or the environment variable that sets it) */
/*    Schedule when it runs : its cron in the editor of a        */
/*             schedule's Schedule tab, saved with Save (read     */
/*             only when the environment sets it ; leaving with   */
/*             a change asks first) ; a cron still read from a    */
/*             deprecated variable says so under it. A runner hub */
/*             loop has no cron : every so many seconds, a number */
/*             within its bounds, saved the same way, and its     */
/*             node on Details                                    */
/*    Runs     its recent runs, the latest first                  */
/*  Run now top right, beside Save, as a schedule's page : the    */
/*  task run once at once, then read again (its last run, result  */
/*  and Runs) ; disabled while it runs and for a task that is     */
/*  off. A runner hub loop runs one pass on the node that answers */
/*  (disabled where its hub does not run), in milliseconds.       */
/*  No Delete, nothing else to edit - the task is the app's own.  */
/*  The search of the title line narrows every tab at once.       */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { useRouteTab } from '@/composables/useRouteTab';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { cronValidationMessage } from '@/config/cron';
import { tableMatches } from '@/lib/recordSearch';
import { statusPill } from '@/config/settings';
import { taskName, taskDescription, taskTiming, runDuration } from '@/lib/systemTasks';

const { t, locale } = useI18n();
const route = useRoute();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the task ─────────────────────────────────────────────────────────────────
const taskKey = computed(() => String(route.params.key || ''));
// as the server answers it, with its recent runs (null : not found)
const task = ref(null);
// its cron as edited on the Schedule tab, the saved one until changed
const cronEdit = ref('');
// a runner hub loop's seconds as edited on the Schedule tab, the saved ones until changed
const secondsEdit = ref('');

/**
 * Loads the task and its recent runs ; refused or failing, the page says it is not found. Its
 * cron in the editor (a loop's seconds in their field) is the saved one again, unless it is being
 * changed (keepEdit : read again after a run, the change not lost).
 *
 * Args:
 *   keepEdit (boolean): keep a changed cron in the editor.
 */
async function load(keepEdit = false) {
  const keep = keepEdit && dirty.value;
  try {
    const res = await axios.get(`/api/v2/system/tasks/${encodeURIComponent(taskKey.value)}`);
    task.value = res.data?.key ? res.data : null;
  } catch {
    task.value = null;
  }
  if (!keep) {
    cronEdit.value = task.value?.cron || '';
    secondsEdit.value = String(task.value?.interval_seconds ?? '');
  }
  loaded.value = true;
}

// ─── its schedule ─────────────────────────────────────────────────────────────
// a runner hub loop (its seconds, no cron) : its seconds in a number field ; what it did is the
// memory of the node that answered (task.loop), named on Details
const isLoop = computed(() => !!task.value && task.value.interval_seconds != null);
// its cron (a loop's seconds) is a setting (schedule_env), in the editor : changed here, not when
// the environment sets its variable (or ALLOW_ENV_EDIT=0), the editor then read only, saying so
const scheduleEditable = computed(() => !!task.value?.schedule_env && !!task.value?.editable_schedule);
// a loop's bounds, as the server takes them, said under its field
const secondsMin = computed(() => task.value?.interval_min ?? 1);
const secondsMax = computed(() => task.value?.interval_max ?? 60);
const secondsBounds = computed(() => t('jobs.system.intervalBounds', { min: secondsMin.value, max: secondsMax.value }));
// why a loop's seconds cannot be saved : a whole number within its bounds, as the server checks
const secondsProblem = computed(() => {
  if (!isLoop.value || !scheduleEditable.value) return '';
  const text = String(secondsEdit.value ?? '').trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isInteger(n) && n >= secondsMin.value && n <= secondsMax.value ? '' : secondsBounds.value;
});
// the line under a loop's field : the environment's variable when it sets it, else its bounds
const secondsHelp = computed(() =>
  scheduleEditable.value ? secondsBounds.value : t('jobs.system.scheduleEnv', { env: task.value?.schedule_env }),
);
// the deprecated variable its cron still comes from (the config seed reload's
// CONFIG_SEED_RELOAD_SECONDS, maybe a cron of 6 fields) : the editor shows the cron it reads as,
// and a cron saved here replaces it ; null for none
const deprecated = computed(() => task.value?.schedule_deprecated || null);
// why the cron cannot be saved : 5 fields (the server takes no seconds), then croner's own rules
const cronProblem = computed(() => {
  if (isLoop.value) return secondsProblem.value;
  if (!scheduleEditable.value) return '';
  const cron = cronEdit.value.trim();
  if (cron.split(/\s+/).filter(Boolean).length !== 5) return t('jobs.system.cronFiveFields');
  return cronValidationMessage(t, cron);
});
// the cron (a loop's seconds) changed and not saved : Save turns orange, leaving asks first
const dirty = computed(() => {
  if (!scheduleEditable.value) return false;
  if (isLoop.value) return String(secondsEdit.value ?? '').trim() !== String(task.value?.interval_seconds ?? '');
  return cronEdit.value.trim() !== (task.value?.cron || '');
});
// the problem said under the editor : once the cron is changed, so a cron of 6 fields read from
// the deprecated variable is shown without an error
const cronError = computed(() => (dirty.value ? cronProblem.value : ''));
// Save : a changed cron, or the deprecated variable's cron as it is when it has 5 fields, saved as
// the new variable
const canSave = computed(() => dirty.value || (scheduleEditable.value && !!deprecated.value && !cronProblem.value));
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

/**
 * Saves the task's cron (PUT /api/v2/system/tasks/<key>/schedule), a runner hub loop's seconds,
 * then reads the task again : its next run and next runs follow the new cron or seconds.
 *
 * Returns:
 *   Promise<boolean>: false when the cron was refused (the leave dialog then stays).
 */
async function save() {
  if (cronProblem.value) {
    toast.warning(cronProblem.value);
    return false;
  }
  try {
    const body = isLoop.value ? { seconds: Number(String(secondsEdit.value).trim()) } : { cron: cronEdit.value.trim() };
    await axios.put(`/api/v2/system/tasks/${encodeURIComponent(taskKey.value)}/schedule`, body);
    toast.success(t('settings.common.nameUpdated', { name: name.value }));
    await load();
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// ─── Run now ──────────────────────────────────────────────────────────────────
// a run asked here and not ended yet ; the task's own running (a scheduled run, or one asked
// elsewhere) disables Run now too
const runAsked = ref(false);
const running = computed(() => runAsked.value || !!task.value?.running);
// a task that is off (the config seed reload without CONFIG_SEED_PATH) is not run, nor a runner hub
// loop on a node whose hub does not run (its enabled false)
const canRun = computed(() => !!task.value && task.value.enabled !== false && !running.value);
// a run that goes on after the answer (the nightly backup) : read again every 2 seconds until it
// is recorded, 30 minutes at most
const FOLLOW_MS = 2000;
const FOLLOW_MAX_MS = 30 * 60 * 1000;
let followTimer = null;

/**
 * Says how a run went : its result, or its error.
 *
 * Args:
 *   run (object|null): the task's last run.
 */
function sayRun(run) {
  if (run?.outcome === 'failed')
    toast.error(t('jobs.system.runFailed', { name: name.value, result: run.result || '' }));
  // a run without a result (a runner hub loop's pass) : its outcome alone
  else if (!run?.result) toast.success(t('jobs.system.runSucceeded', { name: name.value }));
  else toast.success(t('jobs.system.runDone', { name: name.value, result: run.result }));
}

/**
 * Reads the task again every FOLLOW_MS until the run that started is recorded (a last run other
 * than `before`, the task no longer running), then says how it went.
 *
 * Args:
 *   before (number|null): the id of its last run before the run.
 *   until (number): when to stop following (ms since the epoch).
 *   quiet (boolean): say nothing when it ends (a run found going when the page opened).
 */
function followRun(before, until, quiet = false) {
  clearTimeout(followTimer);
  followTimer = setTimeout(async () => {
    await load(true);
    const run = task.value?.last_run;
    const ended = !!run && run.id !== before && !task.value?.running;
    if (ended || !task.value || Date.now() > until) {
      runAsked.value = false;
      if (ended && !quiet) sayRun(run);
      return;
    }
    followRun(before, until, quiet);
  }, FOLLOW_MS);
}

/**
 * Runs the task now (POST /api/v2/system/tasks/<key>/run), then reads it again : its last run,
 * result and Runs show the new run. A run answered while it still goes (202) is followed until
 * it ends.
 */
async function runNow() {
  const before = task.value?.last_run?.id ?? null;
  runAsked.value = true;
  try {
    const res = await axios.post(`/api/v2/system/tasks/${encodeURIComponent(taskKey.value)}/run`, {});
    await load(true);
    if (res.status === 202) {
      toast.info(t('jobs.system.runStarted', { name: name.value }));
      followRun(before, Date.now() + FOLLOW_MAX_MS);
      return;
    }
    sayRun(task.value?.last_run);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    await load(true);
  }
  runAsked.value = false;
}

onBeforeUnmount(() => clearTimeout(followTimer));

// its name and what it does, in the user's language
const name = computed(() => (task.value ? taskName(t, task.value) : ''));
const description = computed(() => (task.value ? taskDescription(t, task.value) : ''));
// when it runs in words, its cron after them ; Off alone (the search's words for the Schedule tab)
const timing = computed(() => {
  if (!task.value) return '';
  const words = taskTiming(t, task.value, locale.value);
  return task.value.cron && task.value.enabled !== false ? `${words} (${task.value.cron})` : words;
});
const lastRun = computed(() => task.value?.last_run || null);
// why the last run failed, on the Last launch badge's hover (as a schedule's launchError)
const launchError = computed(() => (lastRun.value?.outcome === 'failed' ? lastRun.value.result || '' : ''));
// the setting it applies : its variable and value, then where it is changed or what sets it
const setting = computed(() => task.value?.setting || null);

// ─── Runs ─────────────────────────────────────────────────────────────────────
// its recent runs, the latest first (the server keeps a month of them) : when it started and ended,
// how long, how it
// went, what it did, and the node that ran it ; a row opens nothing
const runs = computed(() => task.value?.runs || []);
const runColumns = computed(() => [
  {
    key: 'started_at',
    label: t('jobs.startTime'),
    keep: true,
    value: (r) => (r.started_at ? Helpers.formatServerDate(r.started_at) : ''),
  },
  // when it ended ; empty while it runs
  {
    key: 'ended_at',
    label: t('jobs.endTime'),
    keep: true,
    value: (r) => (r.ended_at ? Helpers.formatServerDate(r.ended_at) : ''),
  },
  // how long it ran, to the right as a number
  {
    key: 'duration',
    label: t('jobs.duration'),
    keep: true,
    class: 'text-end',
    value: (r) => runDuration(r.duration_ms),
  },
  { key: 'outcome', label: t('settings.fields.status'), keep: true },
  { key: 'result', label: t('jobs.system.result') },
  { key: 'node', label: t('jobs.system.node') },
]);

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  // when it runs, as a schedule's Schedule tab
  { key: 'schedule', label: t('settings.schedules.stepSchedule'), icon: 'stopwatch' },
  { key: 'runs', label: t('jobs.system.tabRuns'), icon: 'history', count: runs.value.length },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : System › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('jobs.menu.system'), icon: 'gears', to: '/jobs/system' },
  {
    title: name.value || (loaded.value ? taskKey.value : null),
    icon: 'gears',
    to: `/jobs/system/${taskKey.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows both tabs at once, as a stored job's page : the
// fields whose label or value has it, the runs with a cell that has it, each under its tab's
// name, the tabs set aside meanwhile.
const search = ref('');
const searching = computed(() => !!search.value.trim());
const matches = (...texts) => {
  const q = search.value.trim().toLowerCase();
  return (
    !q ||
    texts.some((x) =>
      String(x ?? '')
        .toLowerCase()
        .includes(q),
    )
  );
};
// each tab's fields : [key, label, value...]
const tabFields = computed(() => ({
  details: [
    ['name', t('settings.fields.name'), name.value],
    ['description', t('settings.fields.description'), description.value],
    ['lastLaunch', t('settings.schedules.lastLaunch'), lastRun.value?.outcome],
    ['result', t('jobs.system.result'), lastRun.value?.result],
    [
      'lastRun',
      t('settings.fields.lastRun'),
      lastRun.value?.started_at ? Helpers.formatServerDate(lastRun.value.started_at) : '',
    ],
    [
      'nextRun',
      t('settings.schedules.nextRun'),
      task.value?.next_run ? Helpers.formatServerDate(task.value.next_run) : '',
    ],
    ['node', t('jobs.system.node'), task.value?.loop?.node],
    ['setting', t('jobs.system.setting'), setting.value?.env, setting.value?.value],
  ],
  // its cron's editor, found by the cron or its words ; a runner hub loop's seconds, or their words
  schedule: isLoop.value
    ? [['seconds', t('jobs.system.intervalLabel'), secondsEdit.value, timing.value]]
    : [['cron', t('jobs.system.timing'), cronEdit.value, timing.value]],
  // the table : its name, or a row with the word in a cell it shows (runsMatch)
  runs: [['runs', t('jobs.system.tabRuns')]],
}));
// the Runs table keeps a row with the word : the tab then shows, with only those rows
const runsMatch = computed(() => tableMatches(search.value, runs.value, runColumns.value));
// the fields that match, per tab
const shownFields = computed(() =>
  Object.fromEntries(
    Object.entries(tabFields.value).map(([tab, fields]) => [
      tab,
      fields.filter(([key, ...texts]) => matches(...texts) || (key === 'runs' && runsMatch.value)).map(([key]) => key),
    ]),
  ),
);
const fieldShown = (key) => Object.values(shownFields.value).some((keys) => keys.includes(key));
// the tabs shown : the active one, or while searching each one with a match
const shownTabs = computed(() =>
  searching.value
    ? tabs.value.filter((tab) => shownFields.value[tab.key]?.length)
    : tabs.value.filter((tab) => tab.key === activeTab.value),
);
const tabShown = (key) => shownTabs.value.some((tab) => tab.key === key);
// while searching, a tab's name over its matches (the first without the line above)
const searchHead = (key) => {
  const i = shownTabs.value.findIndex((tab) => tab.key === key);
  return i < 0 ? null : { tab: shownTabs.value[i], first: i === 0 };
};

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await load();
  // a run going as the page opens (scheduled, or asked elsewhere) : Run now waits for its end
  if (task.value?.running) followRun(task.value.last_run?.id ?? null, Date.now() + FOLLOW_MAX_MS, true);
});
</script>
<template>
  <AppNav />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout">
      <AppJobsSidebar />
      <AppSettings
        v-if="authenticated"
        icon="gears"
        :title="name || taskKey"
        :crumbs="crumbs"
        :description="t('jobs.system.description')"
      >
        <!-- narrows both tabs at once ; the search box of the other pages -->
        <template v-if="task" #headerActions>
          <BsSearch v-model="search" />
        </template>
        <template v-if="task && !searching" #tabs>
          <ul class="nav nav-tabs mb-0">
            <li v-for="tab in tabs" :key="tab.key" class="nav-item">
              <a
                class="nav-link"
                :class="{ active: activeTab === tab.key }"
                href="#"
                @click.prevent="activeTab = tab.key"
              >
                <FaIcon :icon="tab.icon" class="me-1" />
                {{ tab.label }}
                <span v-if="tab.count !== undefined" class="badge af-tab-count ms-1">{{ tab.count }}</span>
              </a>
            </li>
          </ul>
        </template>
        <!-- the task loading : its tabs as grey placeholders -->
        <template v-else-if="!loaded && !searching" #tabs>
          <AppSkeleton shape="tabs" :count="tabs.length" />
        </template>
        <template #default>
          <div v-if="loaded && !task" class="empty-state">
            <FaIcon icon="gears" class="empty-state-icon" />
            <span>{{ t('jobs.system.notFound', { key: taskKey }) }}</span>
          </div>
          <!-- the task loading : its fields as grey placeholders, where they come -->
          <AppSkeleton v-else-if="!loaded && !task" shape="form" :count="3" />
          <div v-else-if="task" class="af-system-tab">
            <!-- Details : what it is, when it runs, how it last went, and what it applies -->
            <template v-if="tabShown('details')">
              <template v-if="searching && searchHead('details')">
                <hr v-if="!searchHead('details').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('details').first }"
                >
                  <FaIcon :icon="searchHead('details').tab.icon" class="me-1" />{{ searchHead('details').tab.label }}
                </h6>
              </template>
              <!-- its name and what it does : the app's own, greyed out -->
              <BsInput
                class="af-system-field"
                :modelValue="name"
                v-show="fieldShown('name')"
                icon="heading"
                :isFloating="false"
                :disabled="true"
                :label="t('settings.fields.name')"
              />
              <BsInput
                class="af-system-field"
                :modelValue="description"
                v-show="fieldShown('description')"
                icon="info-circle"
                :isFloating="false"
                :disabled="true"
                :label="t('settings.fields.description')"
              />
              <!-- the facts the server reports : read only, a dash while unknown, no help line -->
              <!-- its last launch, as a schedule's page has it : the badge only, its error when hovered
                   (a failed run's result) -->
              <div v-show="fieldShown('lastLaunch')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.schedules.lastLaunch') }}</div>
                <span :title="launchError || undefined" v-html="statusPill(t, lastRun?.outcome)"></span>
              </div>
              <!-- what the last run did, or its error -->
              <div v-show="fieldShown('result')" class="mb-3">
                <div class="form-label fw-bold">{{ t('jobs.system.result') }}</div>
                <span>{{ lastRun?.result || '–' }}</span>
              </div>
              <!-- when it last ran : plain text, a dash when it never ran -->
              <div v-show="fieldShown('lastRun')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.fields.lastRun') }}</div>
                <span>{{ lastRun?.started_at ? Helpers.formatServerDate(lastRun.started_at) : '–' }}</span>
              </div>
              <div v-show="fieldShown('nextRun')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.schedules.nextRun') }}</div>
                <span>{{ task.next_run ? Helpers.formatServerDate(task.next_run) : '–' }}</span>
              </div>
              <!-- a runner hub loop : the node whose memory answered, its last run and outcome -->
              <div v-if="isLoop" v-show="fieldShown('node')" class="mb-3">
                <div class="form-label fw-bold">{{ t('jobs.system.node') }}</div>
                <span>{{ task.loop?.node || '–' }}</span>
              </div>
              <!-- the setting it applies : its variable and value, then where it is changed, or that
                   the environment sets it ; none, a dash. The tab's last field, no margin under it -->
              <div v-show="fieldShown('setting')" class="mb-0">
                <div class="form-label fw-bold">{{ t('jobs.system.setting') }}</div>
                <span v-if="setting"
                  ><code>{{ setting.env }}</code> {{ setting.value ?? '–' }}
                  <span class="text-body-secondary mx-1">·</span>
                  <router-link v-if="setting.editable && setting.link" :to="setting.link">{{
                    t('jobs.system.settingChange')
                  }}</router-link>
                  <span v-else class="text-body-secondary">{{ t('jobs.system.settingEnv') }}</span></span
                >
                <span v-else>–</span>
              </div>
            </template>
            <!-- Schedule : its cron in the editor of a schedule's Schedule tab (presets, fields, words,
                 next runs), saved with Save ; read only when the environment sets it, which one line
                 says, as one says a cron read from a deprecated variable. The tab's last field, no
                 margin under it -->
            <template v-if="tabShown('schedule')">
              <template v-if="searching && searchHead('schedule')">
                <hr v-if="!searchHead('schedule').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('schedule').first }"
                >
                  <FaIcon :icon="searchHead('schedule').tab.icon" class="me-1" />{{ searchHead('schedule').tab.label }}
                </h6>
              </template>
              <!-- a runner hub loop : every so many seconds, a number within its bounds (the line under
                   it names them, or the variable that sets it, read only then) -->
              <BsInput
                v-if="isLoop"
                v-show="fieldShown('seconds')"
                class="af-system-seconds"
                v-model="secondsEdit"
                type="number"
                icon="stopwatch"
                :isFloating="false"
                :disabled="!scheduleEditable"
                :hasError="!!cronError"
                :suffix="t('jobs.system.intervalUnit')"
                :help="secondsHelp"
                :label="t('jobs.system.intervalLabel')"
              />
              <div v-else v-show="fieldShown('cron')" class="af-system-cron mb-0">
                <BsCron v-model="cronEdit" icon="stopwatch" :hasError="!!cronError" :disabled="!scheduleEditable" />
                <div v-if="cronError" class="invalid-feedback d-block">{{ cronError }}</div>
                <div v-else-if="deprecated" class="form-text af-schedule-deprecated">
                  {{ t('jobs.system.scheduleDeprecated', { env: deprecated.env }) }}
                </div>
                <div v-else-if="!scheduleEditable" class="form-text">
                  {{ t('jobs.system.scheduleEnv', { env: task.schedule_env }) }}
                </div>
              </div>
            </template>
            <!-- Runs : its recent runs, the latest first -->
            <template v-if="tabShown('runs')">
              <template v-if="searching && searchHead('runs')">
                <hr v-if="!searchHead('runs').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('runs').first }"
                >
                  <FaIcon :icon="searchHead('runs').tab.icon" class="me-1" />{{ searchHead('runs').tab.label }}
                </h6>
              </template>
              <AppLinkedTable
                :search="search"
                :exportName="`${task.key}-runs`"
                :columns="runColumns"
                :rows="runs"
                :empty="t('jobs.system.noRuns')"
              >
                <template #cell-outcome="{ row }"><AppStatusPill :status="row.outcome" /></template>
              </AppLinkedTable>
            </template>
            <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
              {{ t('settings.settingsPage.searchNone') }}
            </div>
          </div>
        </template>
        <!-- Run now, as a schedule's page (disabled while it runs, for a task that is off and for
             a runner hub loop whose hub does not run on this node), then Save when its cron (a
             loop's seconds) may be changed, as a record page's (orange while it is changed ;
             enabled too while the cron comes from a deprecated variable, which Save replaces) -->
        <template v-if="task" #actions>
          <BsButton icon="play" cssClass="text-nowrap" :disabled="!canRun" @click="runNow()">{{
            t('settings.schedules.runSchedule')
          }}</BsButton>
          <BsButton v-if="scheduleEditable" icon="save" :disabled="!canSave" @click="save()">{{
            t('settings.common.save')
          }}</BsButton>
        </template>
      </AppSettings>
      <!-- the user being checked : the title and placeholders where the page comes -->
      <AppPageSkeleton v-else />
    </main>
  </div>
</template>
<style scoped>
/* the wide fields' width of the record pages, the cron editor's as a schedule's */
.af-system-field :deep(.input-group),
.af-system-field,
.af-system-cron {
  max-width: 40rem;
}
/* a loop's seconds : a short number, narrower ; the tab's last field, no margin under it */
.af-system-seconds :deep(.input-group) {
  max-width: 16rem;
}
.af-system-seconds.mb-3 {
  margin-bottom: 0 !important;
}
/* the count of a tab : small and grey, as the menus' badges */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
/* the tab ends a little above the card's edge, as every record's page (24px in all) */
.af-system-tab {
  padding-bottom: 0.5rem;
}
</style>
