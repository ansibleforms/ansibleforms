<script setup>
/******************************************************************/
/*                                                                */
/*  A repository's page (/settings/repositories/<name>), opened from */
/*  the repositories' list : the steps of its dialog as tabs, the */
/*  tab kept in the url -                                         */
/*    Details      its name, branch, uri, description, and where  */
/*                 it stands (status, head)                       */
/*    Credentials  the credential git uses                        */
/*    Usage        what the app reads from it                     */
/*    Schedule     the scheduled pull, clone on app start         */
/*    Last pull output  what git said on the last pull (or clone, */
/*                 reset)                                         */
/*    Last push output  what git said on the last push (none on   */
/*                 a repository the app does not write to)        */
/*  Pull, Reset, Push to repo and Delete top right, beside Save.  */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import TokenStorage from '@/lib/TokenStorage';
import { repositoryPullPill, repositoryPushPill } from '@/config/settings';
import { cronValidationMessage } from '@/config/cron';
import {
  USAGE_FLAGS,
  confirmUsageChange,
  confirmUsageDelete,
  usageToast,
  usageSearchFields,
  usedFor,
  usageLabel,
} from '@/lib/repositoryUsage';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';
import Helpers from '@/lib/Helpers';
import { useAppStore } from '@/stores/app';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);
// where its content comes from (its address and branch) and what the app reads from it (its
// usages) choose the configuration, the forms and the playbooks the app runs : only an admin
// changes them, adds or deletes a repository (the server refuses the others, as a runner's page
// does) ; its name, description, credential and schedule stay editable for a connections user
const appStore = useAppStore();
const sourceLocked = computed(() => !appStore.isAdmin);

// ─── the repository ───────────────────────────────────────────────────────────
// the repository by its number in the address (/settings/repositories/1), as every record ; the
// api works by its name (its folder on disk), read from the list once (resolveName)
const repoId = computed(() => String(route.params.id || ''));
const repoName = ref('');
const repo = ref(null); // as saved
const edit = ref(null); // as edited
const others = ref([]); // the other repositories : who already has a one-only usage
const credentials = ref([]); // the credentials it can use
// what this page edits : its login is its credential's (Connections > Credentials) ; a user of its
// own, from before credentials, is shown, not edited
const EDITED = [
  'name',
  'branch',
  'uri',
  'description',
  'credential',
  // what the app reads from it : every usage type's flag
  ...USAGE_FLAGS,
  'cron',
  'rebase_on_start',
];
/**
 * The fields of a record as this page edits them : the checkboxes booleans, the schedule's
 * switch read from the schedule.
 *
 * Args:
 *   record (object): the repository.
 *
 * Returns:
 *   object: the edited fields.
 */
function editable(record) {
  const out = Object.fromEntries(EDITED.map((k) => [k, record[k] ?? '']));
  for (const u of [...USAGE_FLAGS, 'rebase_on_start']) {
    out[u] = !!record[u];
  }
  out.pull_scheduled = !!(record.cron && String(record.cron).trim());
  return out;
}

// the fields to save : Scheduled pull off saves no schedule
const toSave = computed(() => {
  if (!edit.value) return {};
  const data = Object.fromEntries(
    EDITED.map((k) => [k, typeof edit.value[k] === 'string' ? edit.value[k].trim() : edit.value[k]]),
  );
  if (!edit.value.pull_scheduled) data.cron = '';
  for (const k of Object.keys(data)) if (typeof data[k] === 'boolean') data[k] = data[k] ? 1 : 0;
  return data;
});
const dirty = computed(() => {
  if (!repo.value) return false;
  const saved = editable(repo.value);
  return (
    EDITED.some((k) => String(edit.value[k] ?? '') !== String(saved[k] ?? '')) ||
    edit.value.pull_scheduled !== saved.pull_scheduled
  );
});
// leaving with the repository changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

const running = computed(() => repo.value?.status === 'running');
/**
 * Git's output on an output tab : the last pull's, or the last push's.
 *
 * Args:
 *   key (string): the tab, pull-output or push-output.
 *
 * Returns:
 *   string: the output, empty when there is none yet.
 */
const outputOf = (key) => (key === 'push-output' ? repo.value?.push_output : repo.value?.pull_output) || '';
// the box shows OUTPUT_ROWS numbered lines at least, as a textarea's rows : nothing yet, its first
// line says why ; more output, more lines
const OUTPUT_ROWS = 4;
/**
 * The numbered lines of an output tab, a line each (the trailing newline adds none) ; while
 * searching, only the lines with the text, each keeping its number.
 *
 * Args:
 *   key (string): the tab, pull-output or push-output.
 *
 * Returns:
 *   object[]: the lines, each { no, text, empty } (empty : the reason there is no output yet).
 */
function outputLines(key) {
  const output = outputOf(key);
  const lines = (output ? output.replace(/\n$/, '').split('\n') : [emptyOutput(key)]).map((text, i) => ({
    no: i + 1,
    text,
    empty: !output && i === 0,
  }));
  if (searching.value) return lines.filter((line) => matches(line.text));
  const pad = Array.from({ length: Math.max(0, OUTPUT_ROWS - lines.length) }, (_, i) => ({
    no: lines.length + i + 1,
    text: '',
    empty: false,
  }));
  return [...lines, ...pad];
}
/**
 * Why there is no output yet : never pulled, never pushed, or a repository the app does not write to.
 *
 * Args:
 *   key (string): the tab, pull-output or push-output.
 *
 * Returns:
 *   string: the reason.
 */
function emptyOutput(key) {
  if (key !== 'push-output') return t('settings.repositories.noOutput');
  return t(canPush.value ? 'settings.repositories.noPushOutput' : 'settings.repositories.noPushTarget');
}
// pushed back : only what the app writes to it, its forms, config, playbooks, workflows,
// inventories or the objects it holds (and, on the button, only when it has changes not pushed yet)
const canPush = computed(() => usedFor(repo.value).length > 0);
// the other repositories, as saved : who already has a one-only usage
const otherRepos = computed(() => others.value.filter((r) => r.name !== repo.value?.name));
const cronError = computed(() => (edit.value?.pull_scheduled ? cronValidationMessage(t, edit.value.cron) : null));

/**
 * Loads the repository, the others (for the one-only usages) and the credentials.
 *
 * Args:
 *   keepEdits (boolean): keep what is being edited (a status refresh while running).
 */
/**
 * Reads the name of the repository the address numbers, from the repositories list.
 *
 * Returns:
 *   Promise<void>: repoName set, or left empty when no repository has that number.
 */
async function resolveName() {
  const auth = TokenStorage.getAuthentication();
  const res = await axios.get('/api/v2/repository/', auth).catch(() => null);
  const records = res?.data?.records || res?.data || [];
  repoName.value = records.find((r) => String(r.id) === repoId.value)?.name || '';
}

async function load(keepEdits = false) {
  const auth = TokenStorage.getAuthentication();
  if (!repoName.value) await resolveName();
  try {
    const res = await axios.get(`/api/v2/repository/${encodeURIComponent(repoName.value)}`, auth);
    const record = res.data.records ? res.data.records[0] : res.data;
    repo.value = record || null;
    if (record && (!keepEdits || !edit.value)) edit.value = editable(record);
  } catch {
    repo.value = null;
  }
  if (!keepEdits) {
    const [list, creds] = await Promise.all([
      axios.get('/api/v2/repository/', auth).catch(() => null),
      axios.get('/api/v2/credential/', auth).catch(() => null),
    ]);
    others.value = list?.data?.records || [];
    credentials.value = [{ name: '' }, ...(creds?.data?.records || []).map((c) => ({ name: c.name }))];
  }
  loaded.value = true;
}

/**
 * Chooses the credential just made with Add credential.
 *
 * Args:
 *   name (string): the new credential's name.
 */
async function onCredentialCreated(name) {
  const creds = await axios.get('/api/v2/credential/', TokenStorage.getAuthentication()).catch(() => null);
  credentials.value = [{ name: '' }, ...(creds?.data?.records || []).map((c) => ({ name: c.name }))];
  edit.value.credential = name;
}

// while git runs, the status and output are refreshed every 2 seconds
let poll = null;
function watchRun() {
  clearInterval(poll);
  poll = setInterval(async () => {
    await load(true);
    if (!running.value) clearInterval(poll);
  }, 2000);
}
onBeforeUnmount(() => clearInterval(poll));

// ─── tabs ─────────────────────────────────────────────────────────────────────
// the dialog's steps, and git's last outputs : the pull's and the push's (none on a repository
// the app does not write to, the tab says so)
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'credentials', label: t('settings.repositories.stepCredentials'), icon: 'key' },
  { key: 'usage', label: t('settings.repositories.stepUsage'), icon: 'list-check' },
  { key: 'schedule', label: t('settings.repositories.stepSchedule'), icon: 'stopwatch' },
  { key: 'pull-output', label: t('settings.repositories.lastPullOutput'), icon: 'terminal' },
  { key: 'push-output', label: t('settings.repositories.lastPushOutput'), icon: 'terminal' },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Repositories › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('settings.repositories.labelPlural'), icon: 'fab,git', to: '/settings/repositories' },
  {
    title: repo.value?.name || (loaded.value ? repoName.value : null),
    icon: 'fab,git',
    to: `/settings/repositories/${repoId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the fields of Details, Credentials, Usage and Schedule whose label or help has it (a usage by
// its name and grey words), the lines of git's outputs with it, each under its tab's name, the
// tabs set aside meanwhile.
const { search, searching, matches, matchingKeys, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => tabMatch(key),
});
// each tab's fields : [key, label, help], only those it shows (as the template's v-if)
const tabFields = computed(() => ({
  details: [
    ['pull', t('settings.fields.pull')],
    ['push', t('settings.fields.push')],
    ['head', t('settings.fields.head'), repo.value?.head],
    ['name', t('settings.fields.name'), t('settings.repositories.helpName')],
    ['branch', t('settings.fields.branch')],
    ['uri', t('settings.fields.uri'), t('settings.repositories.helpUri')],
    ['description', t('settings.fields.description')],
  ],
  credentials: [
    ['credential', t('settings.repositories.credential'), t('settings.repositories.helpCredential')],
    repo.value?.user &&
      !edit.value?.credential && ['own_user', t('settings.repositories.ownUser', { user: repo.value.user })],
  ].filter(Boolean),
  usage: usageSearchFields(t),
  schedule: [
    ['pull_scheduled', t('settings.repositories.scheduledPull'), t('settings.repositories.helpScheduledPull')],
    ['rebase_on_start', t('settings.repositories.cloneOnStart'), t('settings.repositories.helpCloneOnStart')],
  ],
}));
// the fields shown : those whose label or help has the text
const shownFields = computed(() => matchingKeys(Object.values(tabFields.value).flat()));
const fieldShown = (key) => shownFields.value.includes(key);
// an output tab with a line that has the text, a tab of fields with one of them shown
const tabMatch = (key) =>
  key.endsWith('-output') ? outputLines(key).length > 0 : (tabFields.value[key] || []).some(([k]) => fieldShown(k));

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Says what went wrong in a toast.
 *
 * Args:
 *   err (Error): the axios error.
 */
function fail(err) {
  toast.error(Helpers.parseAxiosResponseError(err));
}

/**
 * Saves the fields of every tab ; renamed, the page follows the new name.
 */
async function save() {
  const data = toSave.value;
  if (!data.name || !String(data.branch || '').trim() || !data.uri || !data.description) {
    toast.warning(t('settings.repositories.fieldsRequired'));
    return;
  }
  if (cronError.value) {
    toast.warning(cronError.value);
    return;
  }
  // its object usages turned on or off : one question first, a section per type (Cancel saves
  // nothing)
  if (!(await confirmUsageChange(t, repoName.value, repo.value, data))) return;
  try {
    const res = await axios.put(`/api/v2/repository/${encodeURIComponent(repoName.value)}`, data);
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    // and what it did to the objects of each usage
    usageToast(t, res.data);
    // renamed : the api knows it by its new name from now on ; its address, its number, stays
    if (data.name !== repoName.value) repoName.value = data.name;
    await load();
  } catch (err) {
    fail(err);
  }
}

/**
 * Runs git on it : a pull (clone), a reset or a push of its forms ; the status refreshed
 * until it is done, and the output shown.
 *
 * Args:
 *   what (string): clone, reset or sync.
 */
async function run(what) {
  // the lock, and the badge of what runs : the Push one for a push (sync), else the Pull one
  repo.value.status = 'running';
  repo.value[what === 'sync' ? 'push_status' : 'pull_status'] = 'running';
  try {
    await axios.post(`/api/v2/repository/${encodeURIComponent(repoName.value)}/${what}`, {});
  } catch (err) {
    fail(err);
  }
  await load(true);
  if (running.value) watchRun();
}

// Delete asks first ; a repository holding objects says they stay in the app
const confirmDelete = ref(false);

/**
 * Asks before the delete : the question of a repository holding objects (they stay in the app),
 * or the usual one.
 */
async function askDelete() {
  const answer = await confirmUsageDelete(t, repo.value);
  if (answer === null) confirmDelete.value = true;
  else if (answer) await deleteRepo();
}

/**
 * Deletes the repository, then goes back to the repositories.
 */
async function deleteRepo() {
  confirmDelete.value = false;
  try {
    const name = repoName.value;
    const res = await axios.delete(`/api/v2/repository/${encodeURIComponent(repoName.value)}`);
    edit.value = null;
    repo.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    usageToast(t, res.data);
    router.push('/settings/repositories');
  } catch (err) {
    fail(err);
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await load();
  if (running.value) watchRun();
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ repo?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ repo?.name }}</strong>?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteRepo()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <!-- a title from the first frame (a space until the repository's name is read) : without one
         the title line is left out, and the page jumps when it comes -->
    <AppSettings
      v-if="authenticated"
      icon="fab,git"
      :title="repo?.name || repoName || ' '"
      :crumbs="crumbs"
      :description="t('settings.repositories.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="repo" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="repo && !searching" #tabs>
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
        <div v-if="loaded && !repo" class="empty-state">
          <FaIcon icon="fab,git" class="empty-state-icon" />
          <span>{{ t('settings.repositories.notFound', { name: repoName || '#' + repoId }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !repo" shape="form" :count="3" />
        <div v-else-if="repo && edit && shownTabs.length" class="af-repo-tab">
          <!-- Details : what it is, and where it stands -->
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
            <!-- its roles, categories or constants read from config.yaml : deprecated, a line each -->
            <div v-for="d in repo.deprecations || []" :key="d.key" class="alert alert-warning py-2">
              <FaIcon icon="triangle-exclamation" class="me-2" />{{
                t('settings.repositories.configDeprecated', { key: usageLabel(t, d.key), file: d.file })
              }}
            </div>
            <!-- a form name it shares with another forms repository : the copy used, the one skipped -->
            <div v-for="d in repo.formDuplicates || []" :key="d.skipped.place" class="alert alert-warning py-2">
              <FaIcon icon="triangle-exclamation" class="me-2" />{{
                t('settings.repositories.formDuplicate', { name: d.name, used: d.used.place, skipped: d.skipped.place })
              }}
            </div>
            <BsInput
              class="af-repo-field"
              v-model="edit.name"
              v-show="fieldShown('name')"
              icon="heading"
              :isFloating="false"
              :required="true"
              :help="t('settings.repositories.helpName')"
              :label="t('settings.fields.name')"
            />
            <BsInput
              class="af-repo-field"
              v-model="edit.description"
              v-show="fieldShown('description')"
              icon="info-circle"
              :isFloating="false"
              :label="t('settings.fields.description')"
            />
            <BsInput
              class="af-repo-field"
              v-model="edit.uri"
              v-show="fieldShown('uri')"
              icon="fab,git"
              placeholder="https://github.com/account/repo.git"
              :readonly="sourceLocked"
              :isFloating="false"
              :required="true"
              :help="t('settings.repositories.helpUri')"
              :label="t('settings.fields.uri')"
            />
            <BsInput
              class="af-repo-field"
              v-model="edit.branch"
              v-show="fieldShown('branch')"
              icon="code-branch"
              placeholder="main"
              :readonly="sourceLocked"
              :isFloating="false"
              :required="true"
              :label="t('settings.fields.branch')"
            />
            <!-- where it stands : its pull, push and head, each a field of the column, read only ; after
                 its name, description, branch and uri, as every record page's Details -->
            <div v-show="fieldShown('pull')" class="mb-3">
              <div class="form-label fw-bold">{{ t('settings.fields.pull') }}</div>
              <!-- the last pull (clone, sync or reset) : running, success or failed -->
              <span v-html="repositoryPullPill(t, repo)"></span>
            </div>
            <div v-show="fieldShown('push')" class="mb-3">
              <div class="form-label fw-bold">{{ t('settings.fields.push') }}</div>
              <!-- changes saved here and not pushed yet, or none -->
              <span v-html="repositoryPushPill(t, repo)"></span>
            </div>
            <div v-show="fieldShown('head')" class="mb-3">
              <div class="form-label fw-bold">{{ t('settings.fields.head') }}</div>
              <span v-if="repo.head" class="font-monospace af-repo-head">{{ repo.head }}</span>
              <span v-else>–</span>
            </div>
          </template>
          <!-- Credentials : the user and password git uses -->
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
              class="af-repo-field"
              v-model="edit.credential"
              v-show="fieldShown('credential')"
              type="select"
              icon="key"
              :isFloating="false"
              :values="credentials"
              valueKey="name"
              labelKey="name"
              :help="t('settings.repositories.helpCredential')"
              :label="t('settings.repositories.credential')"
            />
            <!-- a repository from before credentials : its own user, until a credential is chosen -->
            <p v-if="repo.user && !edit.credential" v-show="fieldShown('own_user')" class="form-text">
              {{ t('settings.repositories.ownUser', { user: repo.user }) }}
            </p>
          </template>
          <!-- Usage : what the app reads from it, under five headings ; a one-only usage another
             repository has is greyed with its name, one of a later version with a short note -->
          <template v-if="tabShown('usage')">
            <template v-if="searching && searchHead('usage')">
              <hr v-if="!searchHead('usage').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('usage').first }"
              >
                <FaIcon :icon="searchHead('usage').tab.icon" class="me-1" />{{ searchHead('usage').tab.label }}
              </h6>
            </template>
            <AppRepositoryUsage v-model="edit" :others="otherRepos" :readonly="sourceLocked" :shown="fieldShown" />
          </template>
          <!-- Schedule : the scheduled pull and its schedule, the clone on app start -->
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
            <div v-show="fieldShown('pull_scheduled')" class="form-check form-switch mb-3">
              <input
                id="af-repo-scheduled"
                v-model="edit.pull_scheduled"
                class="form-check-input"
                type="checkbox"
                role="switch"
              />
              <label class="form-check-label fw-bold" for="af-repo-scheduled">{{
                t('settings.repositories.scheduledPull')
              }}</label>
              <div class="form-text mt-1">{{ t('settings.repositories.helpScheduledPull') }}</div>
            </div>
            <!-- its schedule goes with the switch -->
            <div v-if="edit.pull_scheduled" v-show="fieldShown('pull_scheduled')" class="mb-3 af-repo-cron">
              <BsCron v-model="edit.cron" icon="stopwatch" :hasError="!!cronError" />
              <div v-if="cronError" class="invalid-feedback d-block">{{ cronError }}</div>
            </div>
            <div v-show="fieldShown('rebase_on_start')" class="form-check form-switch mb-0">
              <input
                id="af-repo-rebase"
                v-model="edit.rebase_on_start"
                class="form-check-input"
                type="checkbox"
                role="switch"
              />
              <label class="form-check-label fw-bold" for="af-repo-rebase">{{
                t('settings.repositories.cloneOnStart')
              }}</label>
              <div class="form-text mt-1">{{ t('settings.repositories.helpCloneOnStart') }}</div>
            </div>
          </template>
          <!-- Output : what git said on the last pull, and on the last push -->
          <template v-for="key in ['pull-output', 'push-output']" :key="key">
            <template v-if="tabShown(key)">
              <template v-if="searching && searchHead(key)">
                <hr v-if="!searchHead(key).first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead(key).first }"
                >
                  <FaIcon :icon="searchHead(key).tab.icon" class="me-1" />{{ searchHead(key).tab.label }}
                </h6>
              </template>
              <!-- as the server log shows its lines : each with its number in a grey column -->
              <div class="af-repo-output font-monospace" tabindex="0" role="region">
                <div v-for="line in outputLines(key)" :key="line.no" class="af-repo-output-line">
                  <span class="af-line-no af-repo-line-no">{{ line.no }}</span><span
                    class="af-repo-line"
                    :class="{ 'af-repo-output-empty': line.empty }"
                    >{{ line.text }}</span
                  >
                </div>
              </div>
            </template>
          </template>
        </div>
        <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
          {{ t('settings.settingsPage.searchNone') }}
        </div>
      </template>
      <template v-if="repo" #actions>
        <!-- Credentials : a new git credential, chosen once made -->
        <AppNewCredentialButton v-if="activeTab === 'credentials'" type="git" @created="onCredentialCreated" />
        <!-- Pull, Push and Reset : git on the repository, as the designer's repository page -->
        <BsButton icon="download" cssClass="text-nowrap" :disabled="running" @click="run('clone')">{{
          t('settings.repositories.pull')
        }}</BsButton>
        <!-- Push : only a repository the app writes to (forms, settings), else greyed, why in the tooltip -->
        <BsButton
          icon="upload"
          cssClass="text-nowrap"
          :disabled="running || !canPush || !repo?.unpushed"
          :title="canPush ? null : t('settings.repositories.pushHint')"
          @click="run('sync')"
          >{{ t('settings.repositories.push') }}</BsButton
        >
        <BsButton icon="redo" cssClass="text-nowrap" :disabled="running" @click="run('reset')">{{
          t('settings.repositories.reset')
        }}</BsButton>
        <BsButton v-if="appStore.isAdmin" icon="trash" @click="askDelete()">{{ t('common.delete') }}</BsButton>
        <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('repositories', repoId)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a user's and an SSO provider's */
.af-repo-field :deep(.input-group),
.af-repo-cron {
  max-width: 40rem;
}
/* the tab ends a little above the card's edge : the card zeroes its last element's margin */
.af-repo-tab {
  padding-bottom: 0.5rem;
}
.af-repo-head {
  font-size: 0.85em;
}
/* git's output, as the server log : a bordered box that scrolls within the card, each line
   numbered in a grey column, git's own spacing kept */
.af-repo-output {
  max-height: 60vh;
  overflow: auto;
  /* the fields' darker border, as the inputs on the other tabs */
  border: 1px solid var(--af-field-border);
  border-radius: var(--bs-border-radius);
  font-size: 0.85rem;
}
.af-repo-output-line {
  display: flex;
}
/* no output yet : the reason, grey, as the first line */
.af-repo-output-empty {
  color: var(--bs-secondary-color);
  font-style: italic;
  white-space: normal;
}
.af-repo-line-no {
  flex: 0 0 3rem;
  padding: 0 0.5rem;
  margin-right: 0.75rem;
  text-align: right;
  color: var(--bs-secondary-color);
  user-select: none;
}
.af-repo-line {
  white-space: pre;
}
/* the first and last lines a little away from the box's top and bottom, the grey column too */
.af-repo-output-line:first-child > span {
  padding-top: 0.4rem;
}
.af-repo-output-line:last-child > span {
  padding-bottom: 0.4rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
