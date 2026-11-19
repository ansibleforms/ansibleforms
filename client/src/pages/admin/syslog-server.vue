<script setup>
/******************************************************************/
/*                                                                */
/*  A syslog server's page (/settings/syslog/<id>), opened from   */
/*  the syslog servers' list : the steps of its dialog as tabs,   */
/*  the tab kept in the url -                                     */
/*    Details     its name, description, and whether it is sent   */
/*                to (Enabled)                                    */
/*    Connection  its protocol, and its host and port (its socket */
/*                path on unix)                                   */
/*    Messages    what it gets (the server log, the audit         */
/*                entries, both), the level, and how lines are    */
/*                written                                         */
/*  Send test message (through it, as saved), Delete and Save top */
/*  right, as a secret store's page. A server of the config seed  */
/*  is read only, and can still be tested. The search of the      */
/*  title line narrows every tab at once.                         */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { repositorySourceFields } from '@/lib/repositoryUsage';
import BsSwitch from '@/components/BsSwitch.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the server ───────────────────────────────────────────────────────────────
const serverId = computed(() => String(route.params.id || ''));
const server = ref(null); // as saved
const edit = ref(null); // as edited
// Enabled among them : its switch saved with Save, as every record page's
const EDITED = [
  'name',
  'description',
  'enabled',
  'protocol',
  'host',
  'port',
  'path',
  'receives',
  'level',
  'type',
  'app_name',
  'source',
];

// the choices of its dropdowns
const PROTOCOLS = ['udp4', 'tcp4', 'tls4', 'udp6', 'tcp6', 'tls6', 'unix', 'unix-connect'].map((value) => ({
  value,
  label: value,
}));
const LEVELS = ['error', 'warning', 'notice', 'info', 'debug'].map((value) => ({ value, label: value }));
const TYPES = [
  { value: 'BSD', label: 'BSD (RFC 3164)' },
  { value: '5424', label: 'RFC 5424' },
];
const RECEIVES = computed(() =>
  ['both', 'audit', 'log'].map((value) => ({ value, label: t(`settings.syslogServers.receives_${value}`) })),
);

/**
 * The fields of a server as this page edits them.
 *
 * Args:
 *   record (object): the syslog server.
 *
 * Returns:
 *   object: the edited fields.
 */
function editable(record) {
  return {
    name: record.name ?? '',
    description: record.description ?? '',
    enabled: !!Number(record.enabled),
    protocol: record.protocol || 'udp4',
    host: record.host ?? '',
    port: record.port ?? '',
    path: record.path ?? '',
    receives: record.receives || 'both',
    level: record.level || 'info',
    type: record.type || 'BSD',
    app_name: record.app_name ?? '',
    source: record.source ?? '',
  };
}

const managed = computed(() => !!server.value?.managed);
// a unix socket : a path, no host and port
const onSocket = computed(() => String(edit.value?.protocol || '').startsWith('unix'));
const dirty = computed(
  () => !!server.value && EDITED.some((k) => String(edit.value[k] ?? '') !== String(editable(server.value)[k] ?? '')),
);
// leaving with the server changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

/**
 * Loads the server.
 */
async function load() {
  try {
    const res = await axios.get(`/api/v2/syslogserver/${encodeURIComponent(serverId.value)}`);
    const record = res.data.records ? res.data.records[0] : res.data;
    server.value = record?.id ? record : null;
    edit.value = server.value ? editable(record) : null;
  } catch {
    server.value = null;
  }
  loaded.value = true;
}

/**
 * Saves fields of the server.
 *
 * Args:
 *   data (object): the fields.
 *
 * Returns:
 *   Promise<boolean>: whether they were saved.
 */
async function update(data) {
  try {
    await axios.put(`/api/v2/syslogserver/${encodeURIComponent(serverId.value)}`, data);
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'connection', label: t('settings.syslogServers.stepConnection'), icon: 'network-wired' },
  { key: 'messages', label: t('settings.syslogServers.stepMessages'), icon: 'inbox' },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Syslog › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('sidebar.syslog'), icon: 'tower-broadcast', to: '/settings/syslog' },
  {
    title: server.value?.name || (loaded.value ? serverId.value : null),
    icon: 'tower-broadcast',
    to: `/settings/syslog/${serverId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the fields whose label or help has it, each under its tab's name, the tabs set aside meanwhile
// (a field the protocol hides stays hidden : the socket's path, or the host and port).
const { search, searching, matchingKeys, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => shownFields.value[key]?.length,
});
// each tab's fields : [key, label, help], only the ones the page draws
const tabFields = computed(() => ({
  details: [
    // one kept in a repository : where it comes from
    ...repositorySourceFields(t, server.value),
    ['name', t('settings.fields.name')],
    ['description', t('settings.fields.description')],
    ['enabled', t('settings.syslogServers.enabled'), t('settings.syslogServers.enabledHelp')],
  ],
  connection: [
    ['protocol', t('settings.syslogServers.protocol'), t('settings.syslogServers.protocolHelp')],
    ...(onSocket.value
      ? [['path', t('settings.syslogServers.path'), t('settings.syslogServers.pathHelp')]]
      : [
          ['host', t('settings.syslogServers.host'), t('settings.syslogServers.hostHelp')],
          ['port', t('settings.syslogServers.port'), t('settings.syslogServers.portHelp')],
        ]),
  ],
  messages: [
    ['receives', t('settings.syslogServers.receives'), t('settings.syslogServers.receivesHelp')],
    ['level', t('settings.syslogServers.level'), t('settings.syslogServers.levelHelp')],
    ['type', t('settings.syslogServers.type'), t('settings.syslogServers.typeHelp')],
    ['app_name', t('settings.syslogServers.appName'), t('settings.syslogServers.appNameHelp')],
    ['source', t('settings.syslogServers.source'), t('settings.syslogServers.sourceHelp')],
  ],
}));
// the fields that match, per tab
const shownFields = computed(() =>
  Object.fromEntries(Object.entries(tabFields.value).map(([tab, fields]) => [tab, matchingKeys(fields)])),
);
const fieldShown = (key) => Object.values(shownFields.value).some((keys) => keys.includes(key));

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Saves the fields of every tab.
 */
async function save() {
  const e = edit.value;
  if (!e.name.trim() || (onSocket.value ? !e.path.trim() : !e.host.trim())) {
    toast.warning(
      t(onSocket.value ? 'settings.syslogServers.fieldsRequiredSocket' : 'settings.syslogServers.fieldsRequired'),
    );
    return;
  }
  const data = {
    name: e.name.trim(),
    description: e.description.trim(),
    enabled: e.enabled ? 1 : 0,
    protocol: e.protocol,
    host: onSocket.value ? '' : e.host.trim(),
    port: onSocket.value ? '' : e.port,
    path: onSocket.value ? e.path.trim() : '',
    receives: e.receives,
    level: e.level,
    type: e.type,
    app_name: e.app_name.trim(),
    source: e.source.trim(),
  };
  if (await update(data)) {
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    await load();
  }
}

// Test : a message through the server as saved
const testing = ref(false);

/**
 * Sends a test message and says how it went.
 */
async function sendTest() {
  testing.value = true;
  try {
    const res = await axios.post(`/api/v2/syslogserver/${encodeURIComponent(serverId.value)}/test`);
    toast.success(res.data.message || res.data.result?.message);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  } finally {
    testing.value = false;
  }
}

// Delete asks first
const confirmDelete = ref(false);

/**
 * Deletes the server, then goes back to the syslog servers.
 */
async function deleteServer() {
  confirmDelete.value = false;
  try {
    const name = server.value?.name;
    await axios.delete(`/api/v2/syslogserver/${encodeURIComponent(serverId.value)}`);
    server.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/syslog');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await load();
  // the list's Send test : the message sent at once, as the button sends it
  if (server.value && route.query.test) {
    router.replace({ query: { ...route.query, test: undefined } });
    await sendTest();
  }
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ server?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ server?.name }}</strong>?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteServer()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="tower-broadcast"
      :title="server?.name || serverId"
      :crumbs="crumbs"
      :description="t('settings.syslogServers.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="server" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="server && !searching" #tabs>
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
        <div v-if="loaded && !server" class="empty-state">
          <FaIcon icon="tower-broadcast" class="empty-state-icon" />
          <span>{{ t('settings.syslogServers.notFound', { id: serverId }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !server" shape="form" :count="3" />
        <div v-else-if="server && edit" class="af-syslog-tab">
          <!-- a server of the config seed : read only here -->
          <div v-if="managed" class="alert alert-secondary py-2">
            <FaIcon icon="lock" class="me-2" />{{ t('settings.common.seedManagedNotice') }}
          </div>
          <fieldset :disabled="managed">
            <!-- Details : what it is called, and whether it is sent to -->
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
              <AppRepositorySource v-show="fieldShown('source')" :record="server" />
              <BsInput
                class="af-syslog-field"
                v-model="edit.name"
                v-show="fieldShown('name')"
                icon="heading"
                :isFloating="false"
                :required="true"
                :label="t('settings.fields.name')"
              />
              <BsInput
                class="af-syslog-field"
                v-model="edit.description"
                v-show="fieldShown('description')"
                icon="info-circle"
                :isFloating="false"
                :label="t('settings.fields.description')"
              />
              <div v-show="fieldShown('enabled')" class="mb-3">
                <label class="form-label fw-bold d-block" for="af-syslog-enabled">{{
                  t('settings.syslogServers.enabled')
                }}</label>
                <!-- saved with Save, as every record's Enabled -->
                <BsSwitch id="af-syslog-enabled" v-model="edit.enabled" class="mb-0" />
                <div class="form-text">{{ t('settings.syslogServers.enabledHelp') }}</div>
              </div>
            </template>
            <!-- Connection : its protocol, and its host and port, or its socket -->
            <template v-if="tabShown('connection')">
              <template v-if="searching && searchHead('connection')">
                <hr v-if="!searchHead('connection').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('connection').first }"
                >
                  <FaIcon :icon="searchHead('connection').tab.icon" class="me-1" />{{
                    searchHead('connection').tab.label
                  }}
                </h6>
              </template>
              <BsInput
                class="af-syslog-field"
                v-model="edit.protocol"
                v-show="fieldShown('protocol')"
                type="select"
                icon="network-wired"
                :isFloating="false"
                :values="PROTOCOLS"
                valueKey="value"
                labelKey="label"
                :help="t('settings.syslogServers.protocolHelp')"
                :label="t('settings.syslogServers.protocol')"
              />
              <template v-if="onSocket">
                <BsInput
                  class="af-syslog-field"
                  v-model="edit.path"
                  v-show="fieldShown('path')"
                  icon="folder"
                  placeholder="/dev/log"
                  :isFloating="false"
                  :required="true"
                  :help="t('settings.syslogServers.pathHelp')"
                  :label="t('settings.syslogServers.path')"
                />
              </template>
              <template v-else>
                <BsInput
                  class="af-syslog-field"
                  v-model="edit.host"
                  v-show="fieldShown('host')"
                  icon="server"
                  placeholder="syslog.example.com"
                  :isFloating="false"
                  :required="true"
                  :help="t('settings.syslogServers.hostHelp')"
                  :label="t('settings.syslogServers.host')"
                />
                <BsInput
                  class="af-syslog-field"
                  v-model="edit.port"
                  v-show="fieldShown('port')"
                  type="number"
                  icon="arrows-alt-v"
                  placeholder="514"
                  :isFloating="false"
                  :help="t('settings.syslogServers.portHelp')"
                  :label="t('settings.syslogServers.port')"
                />
              </template>
            </template>
            <!-- Messages : what it gets, from which level, and how a line is written -->
            <template v-if="tabShown('messages')">
              <template v-if="searching && searchHead('messages')">
                <hr v-if="!searchHead('messages').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('messages').first }"
                >
                  <FaIcon :icon="searchHead('messages').tab.icon" class="me-1" />{{ searchHead('messages').tab.label }}
                </h6>
              </template>
              <BsInput
                class="af-syslog-field"
                v-model="edit.receives"
                v-show="fieldShown('receives')"
                type="select"
                icon="inbox"
                :isFloating="false"
                :values="RECEIVES"
                valueKey="value"
                labelKey="label"
                :help="t('settings.syslogServers.receivesHelp')"
                :label="t('settings.syslogServers.receives')"
              />
              <BsInput
                class="af-syslog-field"
                v-model="edit.level"
                v-show="fieldShown('level')"
                type="select"
                icon="signal"
                :isFloating="false"
                :values="LEVELS"
                valueKey="value"
                labelKey="label"
                :help="t('settings.syslogServers.levelHelp')"
                :label="t('settings.syslogServers.level')"
              />
              <BsInput
                class="af-syslog-field"
                v-model="edit.type"
                v-show="fieldShown('type')"
                type="select"
                icon="file-lines"
                :isFloating="false"
                :values="TYPES"
                valueKey="value"
                labelKey="label"
                :help="t('settings.syslogServers.typeHelp')"
                :label="t('settings.syslogServers.type')"
              />
              <BsInput
                class="af-syslog-field"
                v-model="edit.app_name"
                v-show="fieldShown('app_name')"
                icon="tag"
                placeholder="AnsibleForms"
                :isFloating="false"
                :help="t('settings.syslogServers.appNameHelp')"
                :label="t('settings.syslogServers.appName')"
              />
              <BsInput
                class="af-syslog-field"
                v-model="edit.source"
                v-show="fieldShown('source')"
                icon="desktop"
                placeholder="localhost"
                :isFloating="false"
                :help="t('settings.syslogServers.sourceHelp')"
                :label="t('settings.syslogServers.source')"
              />
            </template>
          </fieldset>
          <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
        </div>
      </template>
      <template v-if="server" #actions>
        <!-- a message through it, as saved : unsaved changes are saved first -->
        <BsButton
          icon="paper-plane"
          cssClass="text-nowrap"
          :disabled="testing || dirty"
          :title="dirty ? t('settings.syslogServers.testSaveFirst') : t('settings.syslogServers.testHelp')"
          @click="sendTest()"
          >{{ t('settings.syslogServers.sendTest') }}</BsButton
        >
        <template v-if="!managed">
          <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
          <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
        </template>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('syslog', serverId)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a mail server's */
.af-syslog-field :deep(.input-group) {
  max-width: 40rem;
}
/* the tab ends a little above the card's edge, as every record's page (24px in all) */
.af-syslog-tab {
  padding-bottom: 0.5rem;
}
/* the fields sit in a fieldset (read only for the config seed's servers) : the card cannot reach
   its last field's margin to zero it, so it is zeroed here */
.af-syslog-tab fieldset > :last-child,
.af-syslog-tab fieldset > :last-child :deep(.mb-3:last-child) {
  margin-bottom: 0 !important;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
