<script setup>
/******************************************************************/
/*                                                                */
/*  A builder's page (/settings/builders/<id>), opened from the   */
/*  builders' list (Connections > Builders), as every record's    */
/*  page : its tabs, the tab kept in the url -                    */
/*    Details   its connection first (its node, its version, what */
/*              it builds now), its name, its description, and    */
/*              whether it takes builds (Enabled)                 */
/*    Builds    the RTE image builds it ran, newest first ; a row */
/*              opens its job                                     */
/*  Test connection (its socket), Delete and Save top right ; the */
/*  search of the title line narrows every tab at once.           */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import BsSwitch from '@/components/BsSwitch.vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { BUILDERS_PATH, socketPill, noCredentialsText } from '@/config/settings';
import { tableMatches } from '@/lib/recordSearch';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { useAppStore } from '@/stores/app';
import { durationSeconds, formatDuration } from '@/lib/jobTime';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useAppStore();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the builder ──────────────────────────────────────────────────────────────
const builderId = computed(() => String(route.params.id || ''));
const builder = ref(null); // as saved
const edit = ref(null); // as edited
// its connection, as the list reads it (GET /api/v2/runner adds each one's socket)
const socket = ref(null);
// changing it : manageBuilders (an admin's by default)
const canManage = computed(() => !!store.profile?.options?.manageBuilders);

/**
 * The fields of a builder as this page edits them, its RTE token credential and its Enabled switch
 * among them : all saved with Save.
 *
 * Args:
 *   record (object): the builder.
 *
 * Returns:
 *   object: the edited fields.
 */
const editable = (record) => ({
  name: record.name ?? '',
  description: record.description ?? '',
  credential: record.credential ?? '',
  enabled: !!Number(record.enabled),
});

const dirty = computed(
  () =>
    !!builder.value &&
    ['name', 'description', 'credential', 'enabled'].some(
      (k) => String(edit.value[k] ?? '') !== String(editable(builder.value)[k] ?? ''),
    ),
);
// leaving with it changed and unsaved asks first
useUnsavedGuard(dirty, () => save());

// the RTE token credentials it can sign in with (its Credentials tab), as a runner's dropdown lists them
const credentials = ref([]);

/** Reads the RTE token credentials, by name : a failure leaves the list empty. */
async function loadCredentials() {
  const res = await axios.get('/api/v2/credential/').catch(() => null);
  // as a runner's dropdown : none first, then its kind's, the one it names kept listed
  credentials.value = [
    { name: '' },
    ...(res?.data?.records || [])
      .filter((c) => c.credential_type === 'rte' || c.name === builder.value?.credential)
      .map((c) => ({ name: c.name })),
  ];
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

/** Loads the builder, and its connection. */
async function load() {
  try {
    const res = await axios.get(`/api/v2/runner/${encodeURIComponent(builderId.value)}`);
    const record = res.data.records ? res.data.records[0] : res.data;
    builder.value = record?.id && record.type === 'builder' ? record : null;
    edit.value = builder.value ? editable(record) : null;
  } catch {
    builder.value = null;
  }
  const list = await axios.get('/api/v2/runner/?type=builder').catch(() => null);
  socket.value = (list?.data?.records || []).find((r) => String(r.id) === builderId.value)?.socket || null;
  loaded.value = true;
}

/**
 * Saves fields of the builder.
 *
 * Args:
 *   data (object): the fields.
 *
 * Returns:
 *   Promise<boolean>: whether they were saved.
 */
async function update(data) {
  try {
    await axios.put(`/api/v2/runner/${encodeURIComponent(builderId.value)}`, data);
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// ─── Builds ───────────────────────────────────────────────────────────────────
const allBuilds = ref([]);
const builds = computed(() =>
  allBuilds.value
    .filter((b) => b.builder === builder.value?.name)
    .map((b) => ({
      ...b,
      key: b.id,
      started: b.start ? Helpers.formatServerDate(b.start) : '',
      ended: b.end ? Helpers.formatServerDate(b.end) : '',
      // as the jobs list counts it : a running build up to now
      duration: formatDuration(durationSeconds(b)),
      to: `/jobs?id=${b.id}`,
    })),
);
const buildColumns = computed(() => [
  { key: 'image', label: t('settings.builders.image') },
  { key: 'ref', label: t('settings.builders.reference') },
  { key: 'started', label: t('jobs.startTime') },
  { key: 'ended', label: t('jobs.endTime') },
  { key: 'duration', label: t('jobs.duration'), class: 'text-end' },
  { key: 'status', label: t('jobs.status') },
]);

/** Reads the builds (jobs of type build) : a failure leaves the tab empty. */
async function loadBuilds() {
  const res = await axios.get('/api/v2/rte-images/builds').catch(() => null);
  allBuilds.value = res?.data?.records || [];
}

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  // the credential it signs in with, as a runner's
  { key: 'credentials', label: t('settings.runners.stepAuth'), icon: 'key' },
  { key: 'builds', label: t('settings.builders.builds'), icon: 'cube', count: builds.value.length },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));
// the tab shown, the page's own when the address names none of its tabs
const shownTab = computed(() => (tabs.value.some((x) => x.key === activeTab.value) ? activeTab.value : 'details'));

// the title : Builders › <name>, each step a link, and the open tab last
const pageCrumbs = computed(() => [
  { title: t('sidebar.builders'), icon: 'hammer', to: BUILDERS_PATH },
  {
    title: builder.value?.name || (loaded.value ? builderId.value : null),
    icon: 'hammer',
    to: `${BUILDERS_PATH}/${builderId.value}`,
  },
]);
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── search ───────────────────────────────────────────────────────────────────
// a word typed in the title line's search narrows every tab at once, as every record's page
const tabFields = computed(() => ({
  details: [
    ['socket', t('settings.runners.socket')],
    ['name', t('settings.fields.name'), t('settings.builders.nameHelp')],
    ['description', t('settings.fields.description')],
    ['enabled', t('settings.runners.enabled'), t('settings.builders.enabledHelp')],
  ],
  credentials: [['credential', t('settings.runners.credential'), t('settings.builders.credentialHelp')]],
}));
const { search, searching, matchingKeys, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) =>
    key === 'builds' ? tableMatches(search.value, builds.value, buildColumns.value) : shownFields.value[key]?.length,
});
const shownFields = computed(() =>
  Object.fromEntries(Object.entries(tabFields.value).map(([tab, fields]) => [tab, matchingKeys(fields)])),
);
const fieldShown = (key) => Object.values(shownFields.value).some((keys) => keys.includes(key));

// ─── actions ──────────────────────────────────────────────────────────────────
/** Saves its name, description, credential and Enabled switch. */
async function save() {
  const e = edit.value;
  if (!e.name.trim()) {
    toast.warning(t('settings.builders.nameRequired'));
    return;
  }
  if (!e.credential) {
    toast.warning(t('settings.builders.credentialRequired'));
    return;
  }
  const data = {
    name: e.name.trim(),
    description: e.description.trim(),
    credential: e.credential,
    enabled: e.enabled ? 1 : 0,
  };
  if (await update(data)) {
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    await load();
  }
}

// Test connection : its socket
const testing = ref(false);
/** Tests its socket and says how it went. */
async function test() {
  testing.value = true;
  try {
    const res = await axios.post(`/api/v2/runner/${encodeURIComponent(builderId.value)}/check`, {});
    toast.success(res.data.result);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('admin.connectionFailed')));
  } finally {
    testing.value = false;
  }
}

// Delete asks first
const confirmDelete = ref(false);
/** Removes the builder (it stops taking builds), then goes back to the builders. */
async function deleteBuilder() {
  confirmDelete.value = false;
  try {
    const name = builder.value?.name;
    await axios.delete(`/api/v2/runner/${encodeURIComponent(builderId.value)}`);
    builder.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push(BUILDERS_PATH);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadBuilds(), loadCredentials()]);
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ builder?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        <i18n-t keypath="settings.common.deleteConfirm" scope="global">
          <template #name
            ><strong>{{ builder?.name }}</strong></template
          >
        </i18n-t>
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteBuilder()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="hammer"
      :title="builder?.name || builderId"
      :crumbs="crumbs"
      :description="t('settings.builders.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="builder" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="builder && !searching" #tabs>
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
      <!-- the record loading : its tabs as grey placeholders -->
      <template v-else-if="!loaded && !searching" #tabs>
        <AppSkeleton shape="tabs" :count="tabs.length" />
      </template>
      <template #default>
        <div v-if="loaded && !builder" class="empty-state">
          <FaIcon icon="hammer" class="empty-state-icon" />
          <span>{{ t('settings.builders.notFound', { id: builderId }) }}</span>
        </div>
        <AppSkeleton v-else-if="!loaded && !builder" shape="form" :count="3" />
        <div v-else-if="builder && edit" class="af-builder-tab">
          <fieldset :disabled="!canManage">
            <!-- Details : what it is called, its connection, whether it takes builds -->
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
                class="af-builder-field"
                v-model="edit.name"
                v-show="fieldShown('name')"
                icon="heading"
                :isFloating="false"
                :required="true"
                :label="t('settings.fields.name')"
                :help="t('settings.builders.nameHelp')"
              />
              <BsInput
                class="af-builder-field"
                v-model="edit.description"
                v-show="fieldShown('description')"
                icon="info-circle"
                :isFloating="false"
                :label="t('settings.fields.description')"
              />
              <!-- its connection, after its name and description as a runner's : connected or not, its node,
                   its version and its load on hover -->
              <div v-if="socket" v-show="fieldShown('socket')" class="mb-3">
                <div class="form-label fw-bold">{{ t('settings.runners.socket') }}</div>
                <span v-html="socketPill(t, { socket })"></span>
                <span v-if="socket.version" class="text-body-secondary small ms-2">{{
                  t('settings.builders.versionIs', { version: socket.version })
                }}</span>
              </div>
              <div v-show="fieldShown('enabled')" class="mb-3">
                <label class="form-label fw-bold d-block" for="af-builder-enabled">{{
                  t('settings.runners.enabled')
                }}</label>
                <!-- saved with Save, as every record's Enabled -->
                <BsSwitch id="af-builder-enabled" v-model="edit.enabled" class="mb-0" />
                <div class="form-text">{{ t('settings.builders.enabledHelp') }}</div>
              </div>
            </template>
            <!-- Credentials : the RTE token credential it signs in with, the same field as a runner's -->
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
                class="af-builder-field"
                v-model="edit.credential"
                v-show="fieldShown('credential')"
                type="select"
                icon="key"
                :isFloating="false"
                :required="true"
                :values="credentials"
                :emptyText="noCredentialsText(t, 'rte')"
                valueKey="name"
                labelKey="name"
                :help="t('settings.builders.credentialHelp')"
                :label="t('settings.runners.credential')"
              />
            </template>
          </fieldset>
          <!-- Builds : the builds it ran -->
          <template v-if="tabShown('builds')">
            <template v-if="searching && searchHead('builds')">
              <hr v-if="!searchHead('builds').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('builds').first }"
              >
                <FaIcon :icon="searchHead('builds').tab.icon" class="me-1" />{{ searchHead('builds').tab.label }}
              </h6>
            </template>
            <AppLinkedTable
              :search="search"
              :exportName="`${builder?.name || builderId}-builds`"
              :columns="buildColumns"
              :rows="builds"
              rowKey="key"
              :to="(b) => b.to"
              :empty="t('settings.builders.noBuilds')"
            >
              <!-- its status as the jobs list shows it -->
              <template #cell-status="{ row }"><AppStatusPill :status="row.status" /></template>
            </AppLinkedTable>
          </template>
          <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
        </div>
      </template>
      <template v-if="builder" #actions>
        <!-- Credentials : a new RTE token credential, chosen once made, as on a runner's page -->
        <AppNewCredentialButton
          v-if="shownTab === 'credentials'"
          type="rte"
          :disabled="!canManage"
          @created="onCredentialCreated"
        />
        <BsButton icon="plug" cssClass="text-nowrap" :disabled="testing" @click="test()">{{
          t('settings.common.testConnection')
        }}</BsButton>
        <template v-if="canManage">
          <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
          <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
        </template>
      </template>
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('databases', builderId)" />
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
/* the wide fields' width of the settings pages */
.af-builder-field :deep(.input-group) {
  max-width: 40rem;
}
/* the tab ends a little above the card's edge, as every record's page */
.af-builder-tab {
  padding-bottom: 0.5rem;
}
.af-builder-tab fieldset > :last-child,
.af-builder-tab fieldset > :last-child :deep(.mb-3:last-child) {
  margin-bottom: 0 !important;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
