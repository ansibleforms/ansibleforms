<script setup>
/******************************************************************/
/*                                                                */
/*  A schedule's page (/jobs/scheduled/<id>), opened from the     */
/*  schedules' list : the steps of its dialog as tabs, and what   */
/*  it said the last time, the tab kept in the url -              */
/*    Details      where it stands (last launch, the job it       */
/*                 started, state, last and next run), its name   */
/*                 and the form it runs                           */
/*    Schedule     once at a time, or on a cron schedule          */
/*    Extra vars   what it sends the form (YAML)                  */
/*  Under Last launch : the job it started (a link), or why it    */
/*  could not start one.                                          */
/*  Run now and Delete top right, beside Save. While it runs, its */
/*  state and output are re-read every 2 seconds. The search of   */
/*  the title line narrows every tab at once.                     */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { statusPill, schedulePill } from '@/config/settings';
import { editorStyle } from '@/config/editorStyle';
import { cronValidationMessage } from '@/config/cron';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { recordButtons } from '@/lib/recordButtons';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the schedule ─────────────────────────────────────────────────────────────
const scheduleId = computed(() => String(route.params.id || ''));
const schedule = ref(null); // as saved
const edit = ref(null); // as edited
const formNames = ref([]); // the forms it can run
const EDITED = ['name', 'form', 'one_time_run', 'cron', 'run_at', 'extra_vars'];

/**
 * The fields of a schedule as this page edits them.
 *
 * Args:
 *   record (object): the schedule.
 *
 * Returns:
 *   object: the edited fields.
 */
function editable(record) {
  return {
    name: record.name ?? '',
    form: record.form ?? '',
    one_time_run: !!record.one_time_run,
    cron: record.cron ?? '',
    run_at: record.run_at ?? '',
    extra_vars: record.extra_vars ?? '',
  };
}

const dirty = computed(
  () =>
    !!schedule.value && EDITED.some((k) => String(edit.value[k] ?? '') !== String(editable(schedule.value)[k] ?? '')),
);
// leaving with the schedule changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

const running = computed(() => ['running', 'queued'].includes(schedule.value?.state));
const cronError = computed(() =>
  edit.value && !edit.value.one_time_run ? cronValidationMessage(t, edit.value.cron) : null,
);
// what its last run said : the job it started (schedule.model writes "The schedule started
// job <id>."), or, when it started none, why
const startedJob = computed(() => schedule.value?.output?.match(/started job (\d+)/)?.[1] || null);
const launchError = computed(() =>
  schedule.value?.status === 'failed' ? (schedule.value.output || '').split('\n')[0] : '',
);

/**
 * Loads the schedule.
 *
 * Args:
 *   keepEdits (boolean): keep what is being edited (a refresh while it runs).
 *
 * Returns:
 *   Promise<boolean>: false when the server no longer has it (404), true otherwise.
 */
async function load(keepEdits = false) {
  let found = true;
  try {
    const res = await axios.get(`/api/v2/schedule/${encodeURIComponent(scheduleId.value)}`);
    const record = res.data.records ? res.data.records[0] : res.data;
    // when it runs next is worked out for the list only : read from there
    if (record?.id && !record.next_run) {
      const list = await axios.get('/api/v2/schedule/').catch(() => null);
      const listed = (list?.data?.records || []).find((r) => String(r.id) === String(record.id));
      if (listed) record.next_run = listed.next_run;
    }
    schedule.value = record?.id ? record : null;
    if (schedule.value && (!keepEdits || !edit.value)) edit.value = editable(record);
  } catch (err) {
    schedule.value = null;
    if (err?.response?.status === 404) found = false;
  }
  loaded.value = true;
  return found;
}

/**
 * Loads the forms a schedule can run, for the Form dropdown.
 */
async function loadForms() {
  const res = await axios.get('/api/v2/config/formnames/').catch(() => null);
  formNames.value = (res?.data?.records || []).map((f) => ({ name: f.name }));
}

// while it runs : its state and output re-read every 2 seconds, until it is idle again
let poll = null;
function watchRun() {
  clearInterval(poll);
  // a one-time schedule is deleted by the server once it has run : its page would read as
  // missing on the next poll, so the jobs are opened instead, where its job is
  const oneTime = !!schedule.value?.one_time_run;
  poll = setInterval(async () => {
    const found = await load(true);
    if (!found && oneTime) {
      clearInterval(poll);
      toast.info(t('settings.schedules.oneTimeRanRemoved'));
      router.push('/jobs');
      return;
    }
    if (!running.value) clearInterval(poll);
  }, 2000);
}
onBeforeUnmount(() => clearInterval(poll));

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'schedule', label: t('settings.schedules.stepSchedule'), icon: 'stopwatch' },
  { key: 'extra-vars', label: t('settings.schedules.stepExtraVars'), icon: 'code' },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Schedules › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('jobs.menu.scheduled'), icon: 'clock', to: '/jobs/scheduled' },
  {
    title: schedule.value?.name || (loaded.value ? scheduleId.value : null),
    icon: 'clock',
    to: `/jobs/scheduled/${scheduleId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the facts and fields whose label or help has it, the extra vars when their text has it (shown
// whole), each under its tab's name, the tabs set aside meanwhile.
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
// each tab's fields : [key, label, help...], only the ones the page draws
const tabFields = computed(() => {
  const s = schedule.value || {};
  return {
    details: [
      ['lastLaunch', t('settings.schedules.lastLaunch'), t('settings.schedules.lastLaunchHelp'), launchError.value],
      ...(startedJob.value
        ? [
            [
              'startedJob',
              t('settings.schedules.startedJobTitle'),
              t('settings.schedules.startedJobHelp'),
              t('settings.schedules.startedJob', { id: startedJob.value }),
            ],
          ]
        : []),
      ['state', t('settings.schedules.scheduleState'), t('settings.schedules.scheduleStateHelp')],
      ['lastRun', t('settings.fields.lastRun'), s.last_run ? Helpers.formatServerDate(s.last_run) : ''],
      ['nextRun', t('settings.schedules.nextRun'), s.next_run ? Helpers.formatServerDate(s.next_run) : ''],
      ['name', t('settings.fields.name'), t('settings.repositories.helpName')],
      ['form', t('settings.fields.form'), edit.value?.form],
    ],
    schedule: [
      ['one_time_run', t('settings.schedules.oneTimeRun')],
      edit.value?.one_time_run
        ? ['run_at', t('settings.schedules.runAt'), t('settings.schedules.runAtHelp')]
        : [
            'cron',
            t('settings.cron.minute'),
            t('settings.cron.hour'),
            t('settings.cron.dayOfMonth'),
            t('settings.cron.month'),
            t('settings.cron.dayOfWeek'),
            edit.value?.cron,
          ],
    ],
    'extra-vars': [
      ['extra_vars', t('settings.fields.extraVars'), t('settings.schedules.extraVarsHelp'), edit.value?.extra_vars],
    ],
  };
});
// the fields that match, per tab
const shownFields = computed(() =>
  Object.fromEntries(
    Object.entries(tabFields.value).map(([tab, fields]) => [
      tab,
      fields.filter(([, ...texts]) => matches(...texts)).map(([key]) => key),
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

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Saves the fields of every tab : a one time run keeps its time and no cron, a recurring one
 * its cron.
 */
async function save() {
  const e = edit.value;
  if (!e.name.trim() || !e.form) {
    toast.warning(t('settings.schedules.fieldsRequired'));
    return;
  }
  if (cronError.value) {
    toast.warning(cronError.value);
    return;
  }
  const data = {
    name: e.name.trim(),
    form: e.form,
    one_time_run: e.one_time_run ? 1 : 0,
    cron: e.one_time_run ? '' : e.cron,
    run_at: e.one_time_run ? e.run_at : null,
    extra_vars: e.extra_vars,
  };
  try {
    await axios.put(`/api/v2/schedule/${encodeURIComponent(scheduleId.value)}`, data);
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    await load();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

/**
 * Runs it now, then follows it until it is idle.
 */
async function runNow() {
  try {
    await axios.post(`/api/v2/schedule/${encodeURIComponent(scheduleId.value)}/launch`, {});
    schedule.value.state = 'queued';
    watchRun();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

// Delete asks first
const confirmDelete = ref(false);

/**
 * Deletes the schedule, then goes back to the schedules.
 */
async function deleteSchedule() {
  confirmDelete.value = false;
  try {
    await axios.delete(`/api/v2/schedule/${encodeURIComponent(scheduleId.value)}`);
    schedule.value = null;
    router.push('/jobs/scheduled');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadForms()]);
  if (running.value) watchRun();
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ schedule?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ schedule?.name }}</strong
        >?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteSchedule()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppNav />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout">
      <AppJobsSidebar />
      <AppSettings
        v-if="authenticated"
        icon="clock"
        :title="schedule?.name || scheduleId"
        :crumbs="crumbs"
        :description="t('settings.schedules.description')"
      >
        <!-- narrows every tab at once ; the search box of the other pages -->
        <template v-if="schedule" #headerActions>
          <BsSearch v-model="search" />
        </template>
        <template v-if="schedule && !searching" #tabs>
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
              </a>
            </li>
          </ul>
        </template>
        <!-- the record loading : its tabs as grey placeholders -->
        <template v-else-if="!loaded && !searching" #tabs>
          <AppSkeleton shape="tabs" :count="tabs.length" />
        </template>
        <template #default>
          <div v-if="loaded && !schedule" class="empty-state">
            <FaIcon icon="clock" class="empty-state-icon" />
            <span>{{ t('settings.schedules.notFound', { id: scheduleId }) }}</span>
          </div>
          <!-- the record loading : its fields as grey placeholders, where they come -->
          <AppSkeleton v-else-if="!loaded && !schedule" shape="form" :count="3" />
          <div v-else-if="schedule && edit" class="af-schedule-tab">
            <!-- Details : where it stands, its name and the form it runs -->
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
              <BsInput
                class="af-schedule-field"
                v-model="edit.name"
                v-show="fieldShown('name')"
                icon="heading"
                :isFloating="false"
                :required="true"
                :help="t('settings.repositories.helpName')"
                :label="t('settings.fields.name')"
              />
              <BsInput
                class="af-schedule-field"
                v-model="edit.form"
                v-show="fieldShown('form')"
                type="select"
                icon="pen-to-square"
                :isFloating="false"
                :required="true"
                :values="formNames"
                valueKey="name"
                labelKey="name"
                :label="t('settings.fields.form')"
              />
              <!-- where it stands : each a field of the column, read only, as a repository's status ; after
                   its name and form, as every record page's Details -->
              <div v-show="fieldShown('lastLaunch')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.schedules.lastLaunch') }}</div>
                <span v-html="statusPill(t, schedule.status)"></span>
                <!-- why it started no job -->
                <div v-if="launchError" class="form-text text-danger">{{ launchError }}</div>
                <div class="form-text">{{ t('settings.schedules.lastLaunchHelp') }}</div>
              </div>
              <!-- the job it started : opened to see how it ended -->
              <div v-if="startedJob" v-show="fieldShown('startedJob')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.schedules.startedJobTitle') }}</div>
                <router-link :to="`/jobs/${startedJob}`" class="af-started-job"
                  ><FaIcon icon="file-lines" class="me-1" />{{
                    t('settings.schedules.startedJob', { id: startedJob })
                  }}</router-link
                >
                <div class="form-text">{{ t('settings.schedules.startedJobHelp') }}</div>
              </div>
              <div v-show="fieldShown('state')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.schedules.scheduleState') }}</div>
                <span v-html="schedulePill(t, schedule.state)"></span>
                <div class="form-text">{{ t('settings.schedules.scheduleStateHelp') }}</div>
              </div>
              <div v-show="fieldShown('lastRun')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.fields.lastRun') }}</div>
                <span>{{ schedule.last_run ? Helpers.formatServerDate(schedule.last_run) : '–' }}</span>
              </div>
              <div v-show="fieldShown('nextRun')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.schedules.nextRun') }}</div>
                <span>{{ schedule.next_run ? Helpers.formatServerDate(schedule.next_run) : '–' }}</span>
              </div>
            </template>
            <!-- Schedule : once at a time, or on a cron schedule -->
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
              <div v-show="fieldShown('one_time_run')" class="form-check form-switch mb-3">
                <input
                  id="af-schedule-once"
                  v-model="edit.one_time_run"
                  class="form-check-input"
                  type="checkbox"
                  role="switch"
                />
                <label class="form-check-label" for="af-schedule-once">{{ t('settings.schedules.oneTimeRun') }}</label>
              </div>
              <div v-if="edit.one_time_run" v-show="fieldShown('run_at')" class="af-schedule-field mb-0">
                <label class="form-label">{{ t('settings.schedules.runAt') }}</label>
                <BsDateTime v-model="edit.run_at" icon="calendar" dateType="datetime" :convertToUtc="true" teleport />
                <div class="form-text">{{ t('settings.schedules.runAtHelp') }}</div>
              </div>
              <div v-else v-show="fieldShown('cron')" class="af-schedule-cron mb-0">
                <BsCron v-model="edit.cron" icon="stopwatch" :hasError="!!cronError" />
                <div v-if="cronError" class="invalid-feedback d-block">{{ cronError }}</div>
              </div>
            </template>
            <!-- Extra vars : what it sends the form -->
            <template v-if="tabShown('extra-vars')">
              <template v-if="searching && searchHead('extra-vars')">
                <hr v-if="!searchHead('extra-vars').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('extra-vars').first }"
                >
                  <FaIcon :icon="searchHead('extra-vars').tab.icon" class="me-1" />{{
                    searchHead('extra-vars').tab.label
                  }}
                </h6>
              </template>
              <BsInput
                v-model="edit.extra_vars"
                v-show="fieldShown('extra_vars')"
                type="editor"
                lang="yaml"
                :style="editorStyle('40vh')"
                :isFloating="false"
                :help="t('settings.schedules.extraVarsHelp')"
                :label="t('settings.fields.extraVars')"
              />
            </template>
            <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
              {{ t('settings.settingsPage.searchNone') }}
            </div>
          </div>
        </template>
        <template v-if="schedule" #actions>
          <BsButton icon="play" cssClass="text-nowrap" :disabled="running" @click="runNow()">{{
            t('settings.schedules.runSchedule')
          }}</BsButton>
          <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
          <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
        </template>
        <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
             height and nothing moves when they come -->
        <template v-else-if="!loaded" #actions>
          <AppSkeleton shape="buttons" :widths="recordButtons('scheduled', scheduleId)" />
        </template>
      </AppSettings>
      <!-- the user being checked : the title and placeholders where the page comes -->
      <AppPageSkeleton v-else />
    </main>
  </div>
</template>
<style scoped>
/* the wide fields' width of the record pages */
.af-schedule-field :deep(.input-group),
.af-schedule-field,
.af-schedule-cron {
  max-width: 40rem;
}
/* the tab ends a little above the card's edge, as every record's page (24px in all) */
.af-schedule-tab {
  padding-bottom: 0.5rem;
}
/* the job it started : the link blue of a list's name, underlined only when hovered */
.af-started-job {
  font-weight: 500;
  text-decoration: none;
}
.af-started-job:hover {
  text-decoration: underline;
}
</style>
