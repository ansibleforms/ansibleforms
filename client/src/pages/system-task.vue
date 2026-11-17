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
/*    Runs     its recent runs, the latest first                  */
/*  Read only : no Save, no Delete, nothing to edit - the task is */
/*  the app's own. The search of the title line narrows both tabs */
/*  at once.                                                      */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { useRouteTab } from '@/composables/useRouteTab';
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

/**
 * Loads the task and its recent runs ; refused or failing, the page says it is not found.
 */
async function load() {
  try {
    const res = await axios.get(`/api/v2/system/tasks/${encodeURIComponent(taskKey.value)}`);
    task.value = res.data?.key ? res.data : null;
  } catch {
    task.value = null;
  }
  loaded.value = true;
}

// its name and what it does, in the user's language
const name = computed(() => (task.value ? taskName(t, task.value) : ''));
const description = computed(() => (task.value ? taskDescription(t, task.value) : ''));
// when it runs in words, its cron after them ; Off, or every so many seconds, alone
const timing = computed(() => {
  if (!task.value) return '';
  const words = taskTiming(t, task.value, locale.value);
  return task.value.cron && task.value.enabled !== false ? `${words} (${task.value.cron})` : words;
});
// its next three runs, in the zone its cron runs in, as a schedule's preview shows them
// a field's label : the preview's words without their colon
const nextRunsLabel = computed(() =>
  t('settings.cron.nextRunsIn', {
    tz: task.value?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).replace(/\s*[:：]\s*$/, ''),
);
const nextRuns = computed(() =>
  (task.value?.next_runs || []).map((iso) => {
    const options = {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    };
    try {
      return new Intl.DateTimeFormat(locale.value, { ...options, timeZone: task.value?.timezone || undefined }).format(
        new Date(iso),
      );
    } catch {
      return new Intl.DateTimeFormat(locale.value, options).format(new Date(iso));
    }
  }),
);
const lastRun = computed(() => task.value?.last_run || null);
// why the last run failed, on the Last launch badge's hover (as a schedule's launchError)
const launchError = computed(() => (lastRun.value?.outcome === 'failed' ? lastRun.value.result || '' : ''));
// the setting it applies : its variable and value, then where it is changed or what sets it
const setting = computed(() => task.value?.setting || null);

// ─── Runs ─────────────────────────────────────────────────────────────────────
// its recent runs, the latest first (the server keeps a month of them) : when, how long, how it
// went, what it did, and the node that ran it ; a row opens nothing
const runs = computed(() => task.value?.runs || []);
const runColumns = computed(() => [
  {
    key: 'started_at',
    label: t('jobs.startTime'),
    keep: true,
    value: (r) => (r.started_at ? Helpers.formatServerDate(r.started_at) : ''),
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
  // when it runs, as a schedule's Schedule tab : read only
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
    ['setting', t('jobs.system.setting'), setting.value?.env, setting.value?.value],
  ],
  schedule: [
    ['timing', t('jobs.system.timing'), timing.value],
    ['nextRuns', nextRunsLabel.value, ...nextRuns.value],
  ],
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
            <!-- Schedule : when it runs, in words with its cron, and its next runs ; read only -->
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
              <div v-show="fieldShown('timing')" class="mb-3">
                <div class="form-label fw-bold">{{ t('jobs.system.timing') }}</div>
                <span>{{ timing || '–' }}</span>
              </div>
              <!-- the tab's last field, no margin under it -->
              <div v-show="fieldShown('nextRuns')" class="mb-0">
                <div class="form-label fw-bold">{{ nextRunsLabel }}</div>
                <div v-if="nextRuns.length" class="d-flex flex-wrap gap-2">
                  <span
                    v-for="(run, i) in nextRuns"
                    :key="i"
                    class="badge bg-body-secondary text-body-secondary border"
                  >
                    {{ run }}
                  </span>
                </div>
                <span v-else>–</span>
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
      </AppSettings>
      <!-- the user being checked : the title and placeholders where the page comes -->
      <AppPageSkeleton v-else />
    </main>
  </div>
</template>
<style scoped>
/* the wide fields' width of the record pages */
.af-system-field :deep(.input-group),
.af-system-field {
  max-width: 40rem;
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
