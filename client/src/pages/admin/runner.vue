<script setup>
/******************************************************************/
/*                                                                */
/*  A runner's page (/settings/runners/<id>), opened from the        */
/*  runners' list : the steps of its dialog as tabs, the tab kept */
/*  in the url -                                                  */
/*    Details         its registration, name, description,        */
/*                    whether it is the default of its kind and   */
/*                    whether it takes jobs (saved with Save)     */
/*    Type            RTE, AWX, AAP, Ascender, Semaphore, Rundeck,*/
/*                    Jenkins                                     */
/*    RTE             an RTE's mode and connection ; in a socket  */
/*                    mode its settings, sent to it : jobs at     */
/*                    once, its files cache, transfer or local    */
/*                    files, the wait of a stop                   */
/*    Credentials     its credential : a token, or a user and     */
/*                    password (AWX), a user and its token        */
/*                    (Jenkins), and the server it connects to ;  */
/*                    a Semaphore's, a Rundeck's or a Jenkins'    */
/*                    project under it                            */
/*    Forms           the forms that run on it, by name or as the */
/*                    default of its type                         */
/*    Jobs            the jobs that ran on it, the latest first   */
/*  Test connection, Delete and Save top right ; its token (or    */
/*  right, beside Save. A runner of the config seed is read only. */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { deleteRecords } from '@/lib/bulkDelete';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { useAppStore } from '@/stores/app';
import { RUNNER_KINDS, PROJECT_RUNNER_KINDS, runnerKind, socketPill, noCredentialsText } from '@/config/settings';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { useFormLinks } from '@/composables/useFormLinks';
import { formPath } from '@/lib/formsPath';
import Time from '@/lib/Time';
import { durationSeconds, formatDuration } from '@/lib/jobTime';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { reloadKeepingEdits } from '@/lib/keepEdits';
import { askConfirm } from '@/lib/confirmPrompt';
import { repositorySourceFields } from '@/lib/repositoryUsage';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the runner ───────────────────────────────────────────────────────────────
const runnerId = computed(() => String(route.params.id || ''));
const runner = ref(null); // as saved
const edit = ref(null); // as edited
// what this page edits : the token and the password have their own dialog
// (where it connects is its credential's)
const EDITED = [
  'name',
  'description',
  'kind',
  'project',
  'credential',
  'rte_mode',
  'rte_max_jobs',
  'rte_cache_mb',
  'rte_files',
  'rte_drain_seconds',
  // its switches, saved with Save as the rest
  'is_default',
  'enabled',
];
// how an RTE talks to the app (RTE_MODE) : outbound, inbound or database (deprecated)
const RTE_MODES = ['outbound', 'inbound', 'database'];
// a socket-mode RTE's settings (server rte/socket/settings.js) : its key in what the RTE says,
// its column, the variable on the RTE it overrides (used when empty), its default ; the
// numbers with their unit after the field
const RTE_NUMBERS = [
  { key: 'maxJobs', column: 'rte_max_jobs', env: 'RTE_MAX_JOBS', def: 10, icon: 'layer-group', unit: '' },
  { key: 'cacheMb', column: 'rte_cache_mb', env: 'RTE_CACHE_MB', def: 1024, icon: 'box-archive', unit: 'MB' },
  {
    key: 'drainSeconds',
    column: 'rte_drain_seconds',
    env: 'RTE_DRAIN_SECONDS',
    def: 25,
    icon: 'hourglass-half',
    unit: 's',
  },
];
const RTE_FILES = { key: 'files', column: 'rte_files', env: 'RTE_FILES', def: 'transfer' };

/**
 * The fields of a runner as this page edits them : its kind from its type and flavour.
 *
 * Args:
 *   record (object): the runner.
 *
 * Returns:
 *   object: the edited fields.
 */
function editable(record) {
  return {
    name: record.name ?? '',
    description: record.description ?? '',
    kind: runnerKind(record),
    project: record.project ?? '',
    credential: record.credential ?? '',
    // an RTE from before 7.3 : database
    rte_mode: record.rte_mode || 'database',
    // its settings : empty is the default
    rte_max_jobs: record.rte_max_jobs ?? '',
    rte_cache_mb: record.rte_cache_mb ?? '',
    rte_files: record.rte_files ?? '',
    rte_drain_seconds: record.rte_drain_seconds ?? '',
    // Default : turned on only (another made the default turns it off) ; Enabled : on when unset
    is_default: !!Number(record.is_default),
    enabled: record.enabled === undefined || record.enabled === null || !!Number(record.enabled),
  };
}

const managed = computed(() => !!runner.value?.managed);
// a runner receives the credentials of the jobs it runs : only an admin changes one (the server
// refuses the others) ; a seeded one nobody changes here
const appStore = useAppStore();
const readOnly = computed(() => managed.value || !appStore.isAdmin);
// a Semaphore or a Rundeck : a project on its server, signed in with a token
const hasProject = computed(() => PROJECT_RUNNER_KINDS.includes(edit.value?.kind));
// the kinds in the order of their names, in the language shown, as the dialog's ; read only here :
// a runner keeps the type and the mode it was made with (an RTE says its mode itself when it connects)
const sortedKinds = computed(() =>
  [...RUNNER_KINDS].sort((a, b) => t(`settings.runners.type_${a}`).localeCompare(t(`settings.runners.type_${b}`))),
);
// an RTE's modes in the order of their names, in the language shown, as the dialog's
const sortedModes = computed(() =>
  [...RTE_MODES].sort((a, b) => t(`settings.runners.rteMode_${a}`).localeCompare(t(`settings.runners.rteMode_${b}`))),
);
// a Jenkins signs in with a user and that user's API token ; its folder (project) is optional
const isJenkins = computed(() => edit.value?.kind === 'jenkins');
// the credentials it can sign in with : those of its kind (rte, awx, aap, ascender, semaphore,
// rundeck, jenkins), each with its server
const allCredentials = ref([]);
const credentials = computed(() => [
  { name: '' },
  ...allCredentials.value
    // of its kind ; the one it names stays listed (an AWX may change product, its credential not)
    .filter((c) => c.credential_type === edit.value?.kind || c.name === runner.value?.credential)
    .map((c) => ({ name: c.name })),
]);
// where it connects, but an RTE : the server of the credential chosen ; none, it needs one
const chosenServer = computed(() => allCredentials.value.find((c) => c.name === edit.value?.credential)?.url || '');
// an outbound RTE dials the app : its credential needs no server
const outboundRte = computed(() => edit.value?.kind === 'rte' && edit.value?.rte_mode === 'outbound');
/**
 * Reads the credentials its dropdown offers.
 */
async function loadCredentials() {
  const res = await axios.get('/api/v2/credential/').catch(() => null);
  allCredentials.value = res?.data?.records || [];
}
/**
 * Chooses the credential just made with Add credential.
 *
 * Args:
 *   name (string): the new credential's name.
 */
async function onCredentialCreated(name) {
  await loadCredentials();
  edit.value.credential = name;
}
// one from before credentials : its own token (or user and password), until a credential is
// chosen ; an RTE that registered itself keeps the token of its registration
const ownSecret = computed(
  () => !!runner.value && !runner.value.credential && !!(runner.value.token || runner.value.password),
);
const dirty = computed(
  () => !!runner.value && EDITED.some((k) => String(edit.value[k] ?? '') !== String(editable(runner.value)[k] ?? '')),
);
// leaving with the runner changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

/**
 * Loads the runner.
 */
async function load() {
  try {
    const res = await axios.get(`/api/v2/runner/${encodeURIComponent(runnerId.value)}`);
    const record = res.data.records ? res.data.records[0] : res.data;
    // a socket-mode RTE's socket is added to the list only : read from there
    if (record) {
      const list = await axios.get('/api/v2/runner/').catch(() => null);
      const listed = (list?.data?.records || []).find((r) => String(r.id) === String(record.id));
      if (listed?.socket) record.socket = listed.socket;
    }
    runner.value = record || null;
    edit.value = record ? editable(record) : null;
  } catch {
    runner.value = null;
  }
  loaded.value = true;
}

/**
 * Saves fields of the runner.
 *
 * Args:
 *   data (object): the fields.
 *
 * Returns:
 *   Promise<boolean>: whether they were saved.
 */
async function update(data) {
  try {
    await axios.put(`/api/v2/runner/${encodeURIComponent(runnerId.value)}`, data);
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// ─── tabs ─────────────────────────────────────────────────────────────────────
// the dialog's steps : Runner, Type, Credentials ; then what runs on it
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'type', label: t('settings.runners.stepType'), icon: 'shapes' },
  // an RTE : its mode, its connection and its settings
  ...(runner.value?.type === 'rte' ? [{ key: 'rte', label: t('settings.runners.tabRte'), icon: 'gauge' }] : []),
  { key: 'credentials', label: t('settings.runners.stepAuth'), icon: 'key' },
  { key: 'forms', label: t('settings.linked.forms'), icon: 'rectangle-list', count: runnerForms.value.length },
  { key: 'jobs', label: t('settings.linked.jobs'), icon: 'history', count: runnerJobs.value.length },
]);

// ─── Forms and Jobs ───────────────────────────────────────────────────────────
// the forms whose jobs run on it : those that name it, and, the default of its type, those that
// name none ; a row opens the form
const { loadForms, formsOfRunner } = useFormLinks();
const runnerForms = computed(() => formsOfRunner(runner.value));
const formColumns = computed(() => [
  { key: 'name', label: t('settings.fields.form') },
  {
    key: 'how',
    label: t('settings.linked.runsHere'),
    value: (f) => (f.byDefault ? t('settings.linked.asDefault') : t('settings.linked.namesIt')),
  },
  { key: 'description', label: t('settings.fields.description') },
]);
// the jobs that ran on it, the latest first : a multistep job's steps stay under their job
const JOBS_SHOWN = 100;
const jobs = ref([]);
const runnerJobs = computed(() => jobs.value.filter((j) => !j.parent_id));
const jobColumns = computed(() => [
  { key: 'id', label: t('settings.linked.job'), keep: true, class: 'text-end', value: (j) => `#${j.id}` },
  { key: 'form', label: t('settings.fields.form') },
  { key: 'status', label: t('settings.linked.status'), keep: true },
  // its times as the jobs page shows them (the server sends them in its own zone)
  { key: 'start', label: t('jobs.startTime'), keep: true, value: (j) => j.start && Time.format(j.start) },
  { key: 'end', label: t('jobs.endTime'), keep: true, value: (j) => j.end && Time.format(j.end) },
  // how long it ran, as the jobs page says it (a running one : until the tab was loaded), to the
  // right as a number
  {
    key: 'duration',
    label: t('jobs.duration'),
    keep: true,
    class: 'text-end',
    value: (j) => formatDuration(durationSeconds(j)),
  },
]);

/**
 * Loads the jobs that ran on the runner ; refused or failing, the tab stays empty.
 */
async function loadJobs() {
  if (!runner.value?.name) return;
  try {
    const res = await axios.get(`/api/v2/job/?runner=${encodeURIComponent(runner.value.name)}&records=${JOBS_SHOWN}`);
    jobs.value = res.data.records || res.data || [];
  } catch {
    jobs.value = [];
  }
}
// every tab a runner may have : the url's is checked before the runner is read (the RTE tab is an
// RTE's only), then shownTab falls back to Details for a runner without it
const { activeTab, tabLink } = useRouteTab('details', (key) =>
  ['details', 'type', 'rte', 'credentials', 'forms', 'jobs'].includes(key),
);
const shownTab = computed(() => (tabs.value.some((x) => x.key === activeTab.value) ? activeTab.value : 'details'));

// the title : Runners › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('sidebar.runners'), icon: 'rocket', to: '/settings/runners' },
  {
    title: runner.value?.name || (loaded.value ? runnerId.value : null),
    icon: 'rocket',
    to: `/settings/runners/${runnerId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === shownTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// the forms it is the default for : those of its type (an awx runner : awx, aap and ascender forms)
const defaultFor = computed(() => t(`settings.runners.default_${runner.value?.type || 'rte'}`));

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the fields of Details, Type and Credentials whose label or help has it (a kind by its name and
// grey words), the forms and the jobs with it in one of their cells (AppLinkedTable's search),
// each under its tab's name, the tabs set aside meanwhile.
const { search, searching, matchingKeys, tableMatches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => shownTab.value,
  tabMatch: (key) => tabMatch(key),
});
// each tab's fields : [key, label, help], only those its kind shows (as the template's v-if)
const tabFields = computed(() => {
  const e = edit.value || {};
  return {
    details: [
      // a runner kept in a repository : where it comes from
      ...repositorySourceFields(t, runner.value),
      ['name', t('settings.fields.name'), t('settings.runners.nameHelp')],
      ['description', t('settings.fields.description')],
      ['is_default', t('settings.runners.isDefault'), t('settings.runners.defaultHelp', { forms: defaultFor.value })],
      ['enabled', t('settings.runners.enabled'), t('settings.runners.enabledHelp')],
    ].filter(Boolean),
    type: [
      ...sortedKinds.value.map((kind) => [
        `kind-${kind}`,
        t(`settings.runners.type_${kind}`),
        t(`settings.runners.type_${kind}Hint`),
      ]),
      ...(e.kind === 'rte'
        ? sortedModes.value.map((mode) => [
            `mode-${mode}`,
            t(`settings.runners.rteMode_${mode}`),
            t(`settings.runners.rteMode_${mode}Hint`),
          ])
        : []),
    ],
    credentials: [
      ['credential', t('settings.runners.credential'), t(`settings.runners.credentialHelp_${e.kind || 'rte'}`)],
      e.credential && !chosenServer.value && !outboundRte.value && ['no_server', t('settings.credentials.noServer')],
      ownSecret.value &&
        !e.credential && [
          'own_token',
          t(runner.value?.node_id ? 'settings.runners.ownTokenRte' : 'settings.runners.ownToken'),
        ],
      hasProject.value && ['project', t('settings.runners.project'), t(`settings.runners.projectHelp_${e.kind}`)],
    ].filter(Boolean),
    rte:
      runner.value?.type === 'rte'
        ? [
            ['rte_mode_text', t('settings.runners.rteMode')],
            runner.value?.socket && ['socket', t('settings.runners.socket')],
            ...(socketRte.value
              ? [
                  ...RTE_NUMBERS.map((f) => [
                    f.column,
                    t(`settings.runners.${f.key}`),
                    t(`settings.runners.${f.key}Help`, { default: f.def, env: f.env }),
                  ]),
                  ['rte_files', t('settings.runners.filesMode'), t('settings.runners.filesModeHelp')],
                ]
              : [['rte_socket_only', t('settings.runners.rteSettingsSocketOnly')]]),
          ].filter(Boolean)
        : [],
  };
});
// the fields shown : those whose label or help has the text
const shownFields = computed(() => matchingKeys(Object.values(tabFields.value).flat()));
const fieldShown = (key) => shownFields.value.includes(key);
// a form or a job with the text in one of the cells its table shows (lib/recordSearch.js)
const tabMatch = (key) =>
  key === 'forms'
    ? tableMatches(runnerForms.value, formColumns.value)
    : key === 'jobs'
      ? tableMatches(runnerJobs.value, jobColumns.value)
      : (tabFields.value[key] || []).some(([k]) => fieldShown(k));

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Saves the fields of every tab, its kind stored as a type and a flavour, as the dialog does, and
 * its switches : Enabled, and Default when turned on (the one before stops being it, on the
 * server).
 */
async function save() {
  const e = edit.value;
  if (!e.name.trim()) {
    toast.warning(t('settings.runners.fieldsRequired'));
    return;
  }
  const data = {
    name: e.name.trim(),
    description: e.description.trim(),
    type: e.kind === 'rte' || PROJECT_RUNNER_KINDS.includes(e.kind) ? e.kind : 'awx',
    project: PROJECT_RUNNER_KINDS.includes(e.kind) ? String(e.project || '').trim() : null,
    flavour: ['aap', 'ascender'].includes(e.kind) ? e.kind : null,
    // as whom : a credential of Connections > Credentials
    credential: e.credential || null,
    // an RTE's mode ; none for the other kinds
    rte_mode: e.kind === 'rte' ? e.rte_mode || 'outbound' : null,
    enabled: e.enabled ? 1 : 0,
  };
  // made the default here : sent only then (never unmade here)
  if (e.is_default && !Number(runner.value.is_default)) data.is_default = 1;
  // an RTE's settings : a whole number, transfer or local, or empty for the default
  if (e.kind === 'rte') {
    for (const f of RTE_NUMBERS) data[f.column] = String(e[f.column] ?? '').trim() === '' ? null : Number(e[f.column]);
    data.rte_files = e.rte_files || null;
  }
  if (await update(data)) {
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    await load();
  }
}

// an RTE's mode as plain words : Outbound, Inbound, or Database (deprecated) for one from before 7.3
const rteModeText = computed(() => t(`settings.runners.rteMode_${runner.value?.rte_mode || 'database'}`));
// an RTE in a socket mode, as saved : its settings go to it over its socket
const socketRte = computed(
  () => runner.value?.type === 'rte' && ['outbound', 'inbound'].includes(runner.value?.rte_mode),
);
// the value a variable on the RTE gives a setting : what an empty field uses, and what a value
// here overrides (the runner page wins)
const rteEnv = (f) => runner.value?.socket?.env?.[f.key];
/**
 * Says beside a setting what the RTE's own variable does : used while the field is empty,
 * overridden once it holds a value ; nothing when the RTE has no such variable.
 *
 * Args:
 *   f (object): the setting (RTE_NUMBERS, RTE_FILES).
 *
 * Returns:
 *   string: the words, or empty.
 */
function rteEnvNote(f) {
  const v = rteEnv(f);
  if (v === undefined || v === null) return '';
  const value = f.key === 'files' ? t(`settings.runners.files_${v}`) : String(v);
  const empty = String(edit.value?.[f.column] ?? '').trim() === '';
  return t(empty ? 'settings.runners.usesRte' : 'settings.runners.overridesRte', { env: f.env, value });
}
// the note under a setting : what the RTE's own variable does
const notesOf = (f) => rteEnvNote(f);
// Job files : the default, transfer or local
const filesOptions = computed(() => [
  // the default : the RTE's own RTE_FILES when it has one, else transfer
  {
    value: '',
    label: t('settings.runners.files_defaultValue', {
      value: t(`settings.runners.files_${rteEnv(RTE_FILES) || 'transfer'}`),
    }),
  },
  { value: 'transfer', label: t('settings.runners.files_transfer') },
  { value: 'local', label: t('settings.runners.files_local') },
]);

// an RTE that asked to join : what it said of itself, for the admin to recognise it
const pending = computed(() => !!Number(runner.value?.pending));
const pendingRows = computed(() => {
  if (!pending.value) return [];
  let info;
  try {
    info = JSON.parse(runner.value.pending_info || '{}') || {};
  } catch {
    info = {};
  }
  return [
    [t('settings.runners.pendingFingerprint'), info.fingerprint || '–', true],
    [t('settings.runners.pendingHost'), info.host || '–'],
    [t('settings.runners.pendingIp'), info.ip || '–'],
    [t('settings.runners.rteMode'), info.mode ? t(`settings.runners.rteMode_${info.mode}`) : '–'],
    info.url && [t('settings.fields.uri'), info.url],
    [t('settings.runners.pendingVersion'), info.version || '–'],
    [
      t('settings.runners.pendingSince'),
      runner.value.pending_since ? Helpers.formatServerDate(runner.value.pending_since) : '–',
    ],
  ].filter(Boolean);
});

// Approve or Reject : one at a time
const deciding = ref(false);

/**
 * Approves the RTE that asked to join (it takes jobs from now on), or rejects it (it is removed,
 * and the page goes back to the list).
 *
 * Args:
 *   what (string): approve or reject.
 */
async function decide(what) {
  const name = runner.value?.name;
  if (
    what === 'reject' &&
    !(await askConfirm(t('settings.runners.rejectConfirm', { name }), {
      title: t('settings.runners.reject'),
      icon: 'ban',
    }))
  )
    return;
  deciding.value = true;
  try {
    await axios.post(`/api/v2/runner/${encodeURIComponent(runnerId.value)}/${what}`, {});
    toast.success(t(what === 'approve' ? 'settings.runners.approved' : 'settings.runners.rejected', { name }));
    if (what === 'reject') return router.push('/settings/runners');
    await reloadKeepingEdits(edit, load);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t(`settings.runners.${what}`)));
  } finally {
    deciding.value = false;
  }
}

// Test connection : one at a time
const testing = ref(false);

/**
 * Asks the runner whether it answers, and says so.
 */
async function testConnection() {
  testing.value = true;
  try {
    const result = await axios.post(`/api/v2/runner/${encodeURIComponent(runnerId.value)}/check`, {});
    toast.success(result.data.result);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('admin.connectionFailed')));
  } finally {
    testing.value = false;
  }
}

// Delete asks first
const confirmDelete = ref(false);

/**
 * Deletes the runner, then goes back to the runners.
 */
async function deleteRunner() {
  confirmDelete.value = false;
  try {
    const name = runner.value?.name;
    await axios.delete(`/api/v2/runner/${encodeURIComponent(runnerId.value)}`);
    runner.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/runners');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

/**
 * Deletes the rows ticked in its Jobs, Stored jobs or Schedules table, after asking, then reads
 * them again.
 *
 * Args:
 *   rows (object[]): the rows ticked.
 *   api (string): their api : job, stored-jobs or schedule.
 */
async function deleteTicked(rows, api) {
  if (
    await deleteRecords(
      t,
      rows.map((r) => `/api/v2/${api}/${r.id}`),
    )
  )
    await loadJobs();
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadForms(), loadCredentials()]);
  await loadJobs();
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ runner?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ runner?.name }}</strong>?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteRunner()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="rocket"
      :title="runner?.name || runnerId"
      :crumbs="crumbs"
      :description="t('settings.runners.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="runner" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="runner && !searching" #tabs>
        <ul class="nav nav-tabs mb-0">
          <li v-for="tab in tabs" :key="tab.key" class="nav-item">
            <a class="nav-link" :class="{ active: shownTab === tab.key }" href="#" @click.prevent="activeTab = tab.key">
              <FaIcon :icon="tab.icon" class="me-1" />
              {{ tab.label }}
              <span v-if="tab.count !== undefined" class="badge af-tab-count ms-1">{{ tab.count }}</span>
            </a>
          </li>
        </ul>
      </template>
      <!-- the record loading : its tabs as grey placeholders -->
      <template v-else-if="!loaded && !searching" #tabs>
        <AppSkeleton shape="tabs" :count="tabs.length" />
      </template>
      <template #default>
        <div v-if="loaded && !runner" class="empty-state">
          <FaIcon icon="rocket" class="empty-state-icon" />
          <span>{{ t('settings.runners.notFound', { id: runnerId }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !runner" shape="form" :count="3" />
        <div v-if="runner && edit && ['details', 'type', 'credentials', 'rte'].some(tabShown)" class="af-runner-tab">
          <!-- an RTE that asked to join : who it says it is, and Approve or Reject -->
          <div v-if="pending" class="alert alert-warning af-runner-pending">
            <div class="fw-bold mb-1">
              <FaIcon icon="hourglass-half" class="me-2" />{{ t('settings.runners.pendingTitle') }}
            </div>
            <div class="mb-2">{{ t('settings.runners.pendingHelp') }}</div>
            <dl class="row mb-2 small">
              <template v-for="row in pendingRows" :key="row[0]">
                <dt class="col-sm-3">{{ row[0] }}</dt>
                <dd class="col-sm-9 mb-1" :class="{ 'font-monospace fw-bold': row[2] }">{{ row[1] }}</dd>
              </template>
            </dl>
            <div v-if="appStore.isAdmin" class="d-flex gap-2">
              <BsButton icon="check" cssClass="btn-success" :disabled="deciding" @click="decide('approve')">{{
                t('settings.runners.approve')
              }}</BsButton>
              <BsButton icon="ban" cssClass="btn-outline-danger" :disabled="deciding" @click="decide('reject')">{{
                t('settings.runners.reject')
              }}</BsButton>
            </div>
          </div>
          <!-- a runner of the config seed : read only here -->
          <div v-if="managed" class="alert alert-secondary py-2">
            <FaIcon icon="lock" class="me-2" />{{ t('settings.common.seedManagedNotice') }}
          </div>
          <fieldset :disabled="readOnly">
            <!-- Details : its registration, what it is called, whether it is the default -->
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
              <!-- where it comes from : a repository's file ; nothing for one kept in the app only -->
              <AppRepositorySource v-show="fieldShown('source')" :record="runner" />
              <BsInput
                class="af-runner-field"
                v-model="edit.name"
                v-show="fieldShown('name')"
                icon="heading"
                :isFloating="false"
                :required="true"
                :help="t('settings.runners.nameHelp')"
                :label="t('settings.fields.name')"
              />
              <BsInput
                class="af-runner-field"
                v-model="edit.description"
                v-show="fieldShown('description')"
                icon="info-circle"
                :isFloating="false"
                :label="t('settings.fields.description')"
              />
              <div v-show="fieldShown('is_default')" class="mb-3">
                <label class="form-label fw-bold d-block" for="af-runner-default">{{
                  t('settings.runners.isDefault')
                }}</label>
                <!-- turned on, saved with Save ; turned off by making another the default -->
                <div class="form-check form-switch mb-0">
                  <input
                    id="af-runner-default"
                    class="form-check-input"
                    type="checkbox"
                    role="switch"
                    v-model="edit.is_default"
                    :disabled="!!Number(runner.is_default)"
                  />
                </div>
                <div class="form-text">{{ t('settings.runners.defaultHelp', { forms: defaultFor }) }}</div>
              </div>
              <div v-show="fieldShown('enabled')" class="mb-3">
                <label class="form-label fw-bold d-block" for="af-runner-enabled">{{
                  t('settings.runners.enabled')
                }}</label>
                <!-- saved with Save, as the default ; turned off, no job goes to it -->
                <div class="form-check form-switch mb-0">
                  <input
                    id="af-runner-enabled"
                    class="form-check-input"
                    type="checkbox"
                    role="switch"
                    v-model="edit.enabled"
                    :disabled="readOnly"
                  />
                </div>
                <div class="form-text">{{ t('settings.runners.enabledHelp') }}</div>
              </div>
            </template>
            <!-- Type : RTE, AWX, AAP, Ascender, Semaphore or Rundeck, each its label and a few grey words -->
            <template v-if="tabShown('type')">
              <template v-if="searching && searchHead('type')">
                <hr v-if="!searchHead('type').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('type').first }"
                >
                  <FaIcon :icon="searchHead('type').tab.icon" class="me-1" />{{ searchHead('type').tab.label }}
                </h6>
              </template>
              <AppTypeOptions
                :options="
                  sortedKinds.map((kind) => ({
                    value: kind,
                    label: t(`settings.runners.type_${kind}`),
                    hint: t(`settings.runners.type_${kind}Hint`),
                  }))
                "
                :selected="edit.kind"
                name="runner-kind"
                :shown="(kind) => fieldShown(`kind-${kind}`)"
              />
              <!-- an RTE's mode : how it talks to the app (RTE_MODE on the RTE) -->
              <template v-if="edit.kind === 'rte'">
                <div v-show="RTE_MODES.some((m) => fieldShown(`mode-${m}`))" class="form-label fw-bold mt-4 mb-2">
                  {{ t('settings.runners.rteMode') }}
                </div>
                <AppTypeOptions
                  :options="
                    sortedModes.map((mode) => ({
                      value: mode,
                      label: t(`settings.runners.rteMode_${mode}`),
                      hint: t(`settings.runners.rteMode_${mode}Hint`),
                    }))
                  "
                  :selected="edit.rte_mode"
                  name="runner-mode"
                  :shown="(mode) => fieldShown(`mode-${mode}`)"
                />
              </template>
            </template>
            <!-- RTE : how it talks to the app and its connection ; in a socket mode its settings,
                 sent to it over its socket : they win over the same variables on the RTE, which
                 fill the empty ones -->
            <template v-if="runner.type === 'rte' && tabShown('rte')">
              <template v-if="searching && searchHead('rte')">
                <hr v-if="!searchHead('rte').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('rte').first }"
                >
                  <FaIcon :icon="searchHead('rte').tab.icon" class="me-1" />{{ searchHead('rte').tab.label }}
                </h6>
              </template>
              <!-- how it talks to the app, in words (it is chosen on the Type tab) -->
              <div v-show="fieldShown('rte_mode_text')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.runners.rteMode') }}</div>
                <div>{{ rteModeText }}</div>
              </div>
              <!-- a socket-mode RTE : its socket, connected or not, as a badge -->
              <div v-if="runner.socket" v-show="fieldShown('socket')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.runners.socket') }}</div>
                <span v-html="socketPill(t, runner)"></span>
              </div>
              <template v-if="socketRte">
                <div v-for="f in RTE_NUMBERS" :key="f.column" v-show="fieldShown(f.column)">
                  <BsInput
                    class="af-runner-number"
                    :class="{ 'mb-0': notesOf(f) }"
                    v-model="edit[f.column]"
                    type="number"
                    :icon="f.icon"
                    :isFloating="false"
                    :suffix="f.unit"
                    :placeholder="t('settings.runners.settingDefault', { value: rteEnv(f) ?? f.def })"
                    :help="t(`settings.runners.${f.key}Help`, { default: f.def, env: f.env })"
                    :label="t(`settings.runners.${f.key}`)"
                  />
                  <p v-if="notesOf(f)" class="form-text mt-1 mb-3">{{ notesOf(f) }}</p>
                </div>
                <div v-show="fieldShown('rte_files')">
                  <BsInput
                    class="af-runner-number"
                    :class="{ 'mb-0': notesOf(RTE_FILES) }"
                    v-model="edit.rte_files"
                    type="select"
                    icon="folder-tree"
                    :isFloating="false"
                    :values="filesOptions"
                    :help="t('settings.runners.filesModeHelp')"
                    :label="t('settings.runners.filesMode')"
                  />
                  <p v-if="notesOf(RTE_FILES)" class="form-text mt-1 mb-3">{{ notesOf(RTE_FILES) }}</p>
                </div>
              </template>
              <!-- database mode : the settings are its own variables -->
              <p v-else v-show="fieldShown('rte_socket_only')" class="form-text mb-0">
                {{ t('settings.runners.rteSettingsSocketOnly') }}
              </p>
            </template>
            <!-- Authentication : an RTE's, a Semaphore's or a Rundeck's token, a Jenkins' user and
                 its token ; an AWX's token, or a user and password -->
            <template v-if="tabShown('credentials')">
              <template v-if="searching && searchHead('credentials')">
                <hr v-if="!searchHead('credentials').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('credentials').first }"
                >
                  <FaIcon :icon="searchHead('credentials').tab.icon" class="me-1" />{{
                    searchHead('credentials').tab.label
                  }}
                </h6>
              </template>
              <BsInput
                class="af-runner-field"
                v-model="edit.credential"
                v-show="fieldShown('credential')"
                type="select"
                icon="key"
                :isFloating="false"
                :values="credentials"
                :emptyText="noCredentialsText(t, edit.kind || 'rte')"
                valueKey="name"
                labelKey="name"
                :help="t(`settings.runners.credentialHelp_${edit.kind || 'rte'}`)"
                :label="t('settings.runners.credential')"
              />
              <!-- a credential without a server : said (it connects to its credential's) -->
              <p
                v-if="edit.credential && !chosenServer && !outboundRte"
                v-show="fieldShown('no_server')"
                class="form-text text-warning-emphasis mb-0"
              >
                {{ t('settings.credentials.noServer') }}
              </p>
              <!-- one from before credentials : its own token, until a credential is chosen -->
              <p v-if="ownSecret && !edit.credential" v-show="fieldShown('own_token')" class="form-text mb-0">
                {{ t(runner.node_id ? 'settings.runners.ownTokenRte' : 'settings.runners.ownToken') }}
              </p>
              <!-- a Semaphore's project id, a Rundeck's project name, a Jenkins' folder : where on
                   the credential's server it launches -->
              <BsInput
                v-if="hasProject"
                class="af-runner-field mt-3"
                v-model="edit.project"
                v-show="fieldShown('project')"
                icon="folder"
                :isFloating="false"
                :required="!isJenkins"
                :help="t(`settings.runners.projectHelp_${edit.kind}`)"
                :label="t('settings.runners.project')"
              />
            </template>
          </fieldset>
        </div>
        <!-- Forms : the forms that run on it ; a row opens the form -->
        <template v-if="runner && tabShown('forms')">
          <template v-if="searching && searchHead('forms')">
            <hr v-if="!searchHead('forms').first" class="mt-4 mb-0 af-search-line" />
            <h6
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('forms').first }"
            >
              <FaIcon :icon="searchHead('forms').tab.icon" class="me-1" />{{ searchHead('forms').tab.label }}
            </h6>
          </template>
          <AppLinkedTable
            :search="search"
            :exportName="`${runner.name}-forms`"
            :columns="formColumns"
            :rows="runnerForms"
            rowKey="name"
            :to="(f) => formPath(f.name)"
            :empty="t('settings.linked.noFormRunner')"
          />
        </template>
        <!-- Jobs : the jobs that ran on it, the latest first ; a row opens the job -->
        <template v-if="runner && tabShown('jobs')">
          <template v-if="searching && searchHead('jobs')">
            <hr v-if="!searchHead('jobs').first" class="mt-4 mb-0 af-search-line" />
            <h6
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('jobs').first }"
            >
              <FaIcon :icon="searchHead('jobs').tab.icon" class="me-1" />{{ searchHead('jobs').tab.label }}
            </h6>
          </template>
          <AppLinkedTable
            :search="search"
            selectable
            :rowActions="[
              { title: t('common.delete'), icon: 'trash', danger: true, run: (r) => deleteTicked([r], 'job') },
            ]"
            :exportName="`${runner.name}-jobs`"
            :columns="jobColumns"
            :rows="runnerJobs"
            :to="(j) => `/jobs/${j.id}`"
            :empty="t('settings.linked.noJob')"
          >
            <template #cell-status="{ row }"><AppStatusPill :status="row.status" /></template>
            <template #bulk-actions="{ selected, count }">
              <BsButton v-if="count" icon="trash" @click="deleteTicked(selected, 'job')"
                >{{ t('common.delete') }} ({{ count }})</BsButton
              >
            </template>
          </AppLinkedTable>
        </template>
        <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
          {{ t('settings.settingsPage.searchNone') }}
        </div>
      </template>
      <template v-if="runner" #actions>
        <!-- Credentials : a new credential of the type it signs in with, chosen once made -->
        <AppNewCredentialButton
          v-if="shownTab === 'credentials'"
          :type="edit?.kind || 'rte'"
          :disabled="readOnly"
          @created="onCredentialCreated"
        />
        <BsButton icon="plug" cssClass="text-nowrap" :disabled="testing" @click="testConnection()">{{
          t('settings.common.testConnection')
        }}</BsButton>
        <template v-if="!readOnly">
          <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
          <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
        </template>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('runners', runnerId, appStore.isAdmin)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the count of a tab : small and grey, as the menus' badges */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
/* the wide fields' width of the settings pages, as a user's and a repository's */
.af-runner-field :deep(.input-group) {
  max-width: 40rem;
}
/* a number or a short choice : a narrow field */
.af-runner-number :deep(.input-group) {
  max-width: 20rem;
}
/* the tab ends a little above the card's edge, as every record's page (24px in all) */
.af-runner-tab {
  padding-bottom: 0.5rem;
}
/* the fields sit in a fieldset (read only for the config seed's runners) : the card cannot reach
   its last field's margin to zero it, so it is zeroed here */
.af-runner-tab fieldset > :last-child,
.af-runner-tab fieldset > :last-child :deep(.mb-3:last-child) {
  margin-bottom: 0 !important;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
