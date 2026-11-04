<script setup>
/******************************************************************/
/*                                                                */
/*  A secret store's page (/settings/secret-stores/<id>), opened from */
/*  the secret stores' list : the steps of its dialog as tabs,    */
/*  the tab kept in the url -                                     */
/*    Details     its name and description                        */
/*    Type        HashiCorp Vault or CyberArk CCP, and whether a  */
/*                Vault is a Vault Enterprise (both set when it   */
/*                was made, read only)                            */
/*    Credentials its credential, or a new one : a Vault's        */
/*                password is its token, a CyberArk's is a        */
/*                cyberark one (AppID, client certificate, key) ; */
/*                its address and TLS are the credential's        */
/*    Options     namespace, KV version, mount, cache, extra      */
/*  Test connection and Delete top right, beside Save. A store of */
/*  the config seed is read only.                                 */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import getSettings, { SECRET_STORE_TYPES, noCredentialsText } from '@/config/settings';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { useAppStore } from '@/stores/app';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the store ────────────────────────────────────────────────────────────────
const storeId = computed(() => String(route.params.id || ''));
const store = ref(null); // as saved
const edit = ref(null); // as edited
// what this page edits : how it logs in, and where, is its credential's
const EDITED = [
  'credential',
  'name',
  'description',
  'type',
  'vault_enterprise',
  'namespace',
  'kv_version',
  'default_mount',
  'cache_ttl_seconds',
  'extra',
  'write_enabled',
  'write_prefix',
];
// the types, Vault last, as the dialog's : a short name beside the radio, the rest in its hint
const TYPES = [...SECRET_STORE_TYPES].reverse();

/**
 * The fields of a store as this page edits them : the switches read from what is stored.
 *
 * Args:
 *   record (object): the store.
 *
 * Returns:
 *   object: the edited fields.
 */
function editable(record) {
  return {
    name: record.name ?? '',
    description: record.description ?? '',
    credential: record.credential ?? '',
    type: record.type || 'vault',
    vault_enterprise: !!String(record.namespace || '').trim(),
    namespace: record.namespace ?? '',
    kv_version: Number(record.kv_version) || 2,
    default_mount: record.default_mount ?? '',
    cache_ttl_seconds: record.cache_ttl_seconds ?? '',
    extra: record.extra ?? '',
    // a credential's secret typed in the app may be written to it, below its prefix
    write_enabled: !!Number(record.write_enabled),
    write_prefix: record.write_prefix ?? '',
  };
}

const managed = computed(() => !!store.value?.managed);
// a store logs in with a token or a key it sends to its address : only an admin changes one (the
// server refuses the others, as a runner's page does) ; Test connection of the saved store stays
// theirs ; a seeded one nobody changes here
const appStore = useAppStore();
const readOnly = computed(() => managed.value || !appStore.isAdmin);
const isVault = computed(() => edit.value?.type === 'vault');
const dirty = computed(
  () => !!store.value && EDITED.some((k) => String(edit.value[k] ?? '') !== String(editable(store.value)[k] ?? '')),
);
// leaving with the store changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(),
);

/**
 * Loads the store.
 */
async function load() {
  try {
    const res = await axios.get(`/api/v2/secretstore/${encodeURIComponent(storeId.value)}`);
    const record = res.data.records ? res.data.records[0] : res.data;
    store.value = record || null;
    edit.value = record ? editable(record) : null;
  } catch {
    store.value = null;
  }
  await loadCredentials();
  loaded.value = true;
}

// the credentials it can log in with : a CyberArk's cyberark ones, a Vault's vault ones
const allCredentials = ref([]);
const credentials = computed(() => [
  { name: '' },
  ...allCredentials.value
    .filter((c) => c.credential_type === (isVault.value ? 'vault' : 'cyberark'))
    .map((c) => ({ name: c.name })),
]);

// where it connects : the server of the credential chosen ; none, it needs one
const chosenServer = computed(() => allCredentials.value.find((c) => c.name === edit.value?.credential)?.url || '');

/**
 * Loads the credentials the Credential dropdown chooses from.
 */
async function loadCredentials() {
  const res = await axios.get('/api/v2/credential/').catch(() => null);
  allCredentials.value = res?.data?.records || [];
}

// Add credential : the credentials' own dialog, over this page ; what it creates is chosen
const credentialsSettings = computed(() => getSettings(t).credentials);
const creator = ref(null);

/**
 * Chooses the credential just created in the credentials' dialog.
 *
 * Args:
 *   name (string): the new credential's name.
 */
async function onCredentialCreated(name) {
  await loadCredentials();
  edit.value.credential = name;
}

/**
 * Saves fields of the store.
 *
 * Args:
 *   data (object): the fields.
 *
 * Returns:
 *   Promise<boolean>: whether they were saved.
 */
async function update(data) {
  try {
    await axios.put(`/api/v2/secretstore/${encodeURIComponent(storeId.value)}`, data);
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// ─── tabs ─────────────────────────────────────────────────────────────────────
// the dialog's steps : Store, Type, Credentials, Options
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'type', label: t('settings.secretStores.stepType'), icon: 'shapes' },
  { key: 'credentials', label: t('settings.secretStores.stepAuth'), icon: 'key' },
  { key: 'options', label: t('settings.secretStores.stepOptions'), icon: 'sliders' },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Secret stores › <name>, each step a link
const pageCrumbs = computed(() => [
  { title: t('sidebar.secretStores'), icon: 'vault', to: '/settings/secret-stores' },
  {
    title: store.value?.name || (loaded.value ? storeId.value : null),
    icon: 'vault',
    to: `/settings/secret-stores/${storeId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the fields of each tab whose label or help has it (a type by its name and grey words), each
// under its tab's name, the tabs set aside meanwhile.
const { search, searching, matchingKeys, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => (tabFields.value[key] || []).some(([k]) => fieldShown(k)),
});
// each tab's fields : [key, label, help], only those its type shows (as the template's v-if)
const tabFields = computed(() => {
  const e = edit.value || {};
  const vault = isVault.value;
  return {
    details: [
      ['name', t('settings.fields.name'), t('settings.secretStores.nameHelp')],
      ['description', t('settings.fields.description')],
    ],
    type: [
      ...TYPES.map((type) => [
        `type-${type.value}`,
        type.short || type.label,
        t(`settings.secretStores.type_${type.value}Hint`),
      ]),
      vault && ['enterprise', t('settings.secretStores.enterprise'), t('settings.secretStores.enterpriseHelp')],
    ].filter(Boolean),
    credentials: [
      [
        'credential',
        t('settings.secretStores.credential'),
        t(vault ? 'settings.secretStores.helpCredential' : 'settings.secretStores.helpCredentialCyberark'),
      ],
      e.credential && !chosenServer.value && ['no_server', t('settings.credentials.noServer')],
      (vault ? store.value?.token : store.value?.app_id) &&
        !e.credential && ['own_login', t(vault ? 'settings.secretStores.ownToken' : 'settings.secretStores.ownLogin')],
    ].filter(Boolean),
    options: [
      vault &&
        e.vault_enterprise && [
          'namespace',
          t('settings.secretStores.namespace'),
          t('settings.secretStores.namespaceHelp'),
        ],
      vault && [
        'kv_version',
        t('settings.secretStores.kvVersion'),
        'KV v2',
        t('settings.secretStores.kv2Hint'),
        'KV v1',
        t('settings.secretStores.kv1Hint'),
      ],
      vault && ['default_mount', t('settings.secretStores.defaultMount'), t('settings.secretStores.defaultMountHelp')],
      vault && ['write_enabled', t('settings.secretStores.writeEnabled'), t('settings.secretStores.writeEnabledHelp')],
      vault &&
        e.write_enabled && [
          'write_prefix',
          t('settings.secretStores.writePrefix'),
          t('settings.secretStores.writePrefixHelp'),
        ],
      ['cache_ttl_seconds', t('settings.secretStores.cacheTtl'), t('settings.secretStores.cacheTtlHelp')],
      ['extra', t('settings.secretStores.extra'), t('settings.secretStores.extraHelp')],
    ].filter(Boolean),
  };
});
// the fields shown : those whose label or help has the text
const shownFields = computed(() => matchingKeys(Object.values(tabFields.value).flat()));
const fieldShown = (key) => shownFields.value.includes(key);

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Saves the fields of every tab, the switches stored as the dialog stores them : no namespace
 * but in a Vault Enterprise, a CA bundle only when checked against one.
 */
async function save() {
  const e = edit.value;
  if (!e.name.trim()) {
    toast.warning(t('settings.secretStores.fieldsRequired'));
    return;
  }
  // a Vault Enterprise keeps its namespace (its switch is set when it was made)
  if (isVault.value && e.vault_enterprise && !String(e.namespace || '').trim()) {
    toast.warning(t('settings.secretStores.namespaceRequired'));
    return;
  }
  const data = {
    name: e.name.trim(),
    description: e.description.trim(),
    type: e.type,
    namespace: isVault.value && e.vault_enterprise ? e.namespace.trim() : '',
    cache_ttl_seconds: e.cache_ttl_seconds,
    extra: typeof e.extra === 'string' ? e.extra.trim() : e.extra,
  };
  data.credential = e.credential;
  if (isVault.value) {
    Object.assign(data, {
      kv_version: e.kv_version,
      default_mount: e.default_mount.trim(),
      write_enabled: e.write_enabled ? 1 : 0,
      write_prefix: e.write_enabled ? e.write_prefix.trim() : '',
    });
  }
  // writing on needs a prefix : never the whole store
  if (isVault.value && e.write_enabled && !e.write_prefix.trim()) {
    toast.warning(t('settings.secretStores.writePrefixRequired'));
    return;
  }
  if (await update(data)) {
    toast.success(t('settings.common.nameUpdated', { name: data.name }));
    await load();
  }
}

// Test connection : one at a time
const testing = ref(false);

/**
 * Asks the store whether it answers, and says so.
 */
async function testConnection() {
  testing.value = true;
  try {
    const result = await axios.post(`/api/v2/secretstore/${encodeURIComponent(storeId.value)}/check`, {});
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
 * Deletes the store, then goes back to the secret stores.
 */
async function deleteStore() {
  confirmDelete.value = false;
  try {
    const name = store.value?.name;
    await axios.delete(`/api/v2/secretstore/${encodeURIComponent(storeId.value)}`);
    store.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/secret-stores');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await load();
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ store?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ store?.name }}</strong
        >?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteStore()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <!-- Add credential : the credentials' dialog only, an api or cyberark credential preset -->
  <div class="af-nested-dialogs">
    <AppAdminMulti
      ref="creator"
      dialogOnly
      :apiVersion="2"
      :settings="credentialsSettings"
      @created="onCredentialCreated"
    />
  </div>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="vault"
      :title="store?.name || storeId"
      :crumbs="crumbs"
      :description="t('settings.secretStores.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="store" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="store && !searching" #tabs>
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
        <div v-if="loaded && !store" class="empty-state">
          <FaIcon icon="vault" class="empty-state-icon" />
          <span>{{ t('settings.secretStores.notFound', { id: storeId }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !store" shape="form" :count="3" />
        <div v-else-if="store && edit && shownTabs.length" class="af-store-tab">
          <!-- a store of the config seed : read only here -->
          <div v-if="managed" class="alert alert-secondary py-2">
            <FaIcon icon="lock" class="me-2" />{{ t('settings.common.seedManagedNotice') }}
          </div>
          <fieldset :disabled="readOnly">
            <!-- Details : what it is called -->
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
                class="af-store-field"
                v-model="edit.name"
                v-show="fieldShown('name')"
                icon="heading"
                :isFloating="false"
                :required="true"
                :help="t('settings.secretStores.nameHelp')"
                :label="t('settings.fields.name')"
              />
              <BsInput
                class="af-store-field"
                v-model="edit.description"
                v-show="fieldShown('description')"
                icon="info-circle"
                :isFloating="false"
                :label="t('settings.fields.description')"
              />
            </template>
            <!-- Type : CyberArk CCP or HashiCorp Vault, set when it was made (the credentials that read
                 from it expect it) ; a Vault's Enterprise switch under it -->
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
                  TYPES.map((type) => ({
                    value: type.value,
                    label: type.short || type.label,
                    hint: t(`settings.secretStores.type_${type.value}Hint`),
                  }))
                "
                :selected="edit.type"
                name="store-type"
                :shown="(value) => fieldShown(`type-${value}`)"
              />
              <div v-if="isVault" v-show="fieldShown('enterprise')" class="form-check form-switch mt-3 af-type-option">
                <input
                  id="af-store-enterprise"
                  v-model="edit.vault_enterprise"
                  class="form-check-input"
                  type="checkbox"
                  role="switch"
                  disabled
                />
                <label class="form-check-label" for="af-store-enterprise">{{
                  t('settings.secretStores.enterprise')
                }}</label>
                <div class="form-text mt-1">{{ t('settings.secretStores.enterpriseHelp') }}</div>
              </div>
            </template>
            <!-- Credentials : its credential, or a new one of its kind -->
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
                class="af-store-field"
                v-model="edit.credential"
                v-show="fieldShown('credential')"
                type="select"
                icon="key"
                :isFloating="false"
                :values="credentials"
                :emptyText="noCredentialsText(t, isVault ? 'vault' : 'cyberark')"
                valueKey="name"
                labelKey="name"
                :help="
                  t(isVault ? 'settings.secretStores.helpCredential' : 'settings.secretStores.helpCredentialCyberark')
                "
                :label="t('settings.secretStores.credential')"
              />
              <!-- a credential without a server : said (the store connects to its credential's) -->
              <p
                v-if="edit.credential && !chosenServer"
                v-show="fieldShown('no_server')"
                class="form-text text-warning-emphasis mt-3 mb-0"
              >
                {{ t('settings.credentials.noServer') }}
              </p>
              <!-- a store from before credentials : its own token or AppID, until one is chosen -->
              <p
                v-if="(isVault ? store.token : store.app_id) && !edit.credential"
                v-show="fieldShown('own_login')"
                class="form-text mt-3 mb-0"
              >
                {{ t(isVault ? 'settings.secretStores.ownToken' : 'settings.secretStores.ownLogin') }}
              </p>
            </template>
            <!-- Options : a Vault's namespace, KV version and mount ; the cache and extra of both -->
            <template v-if="tabShown('options')">
              <template v-if="searching && searchHead('options')">
                <hr v-if="!searchHead('options').first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead('options').first }"
                >
                  <FaIcon :icon="searchHead('options').tab.icon" class="me-1" />{{ searchHead('options').tab.label }}
                </h6>
              </template>
              <template v-if="isVault">
                <BsInput
                  v-if="edit.vault_enterprise"
                  class="af-store-field"
                  v-model="edit.namespace"
                  v-show="fieldShown('namespace')"
                  icon="folder"
                  :isFloating="false"
                  :required="true"
                  :help="t('settings.secretStores.namespaceHelp')"
                  :label="t('settings.secretStores.namespace')"
                />
                <div v-show="fieldShown('kv_version')" class="mb-3">
                  <div class="form-label">{{ t('settings.secretStores.kvVersion') }}</div>
                  <div
                    v-for="opt in [
                      { value: 2, label: 'KV v2', hint: t('settings.secretStores.kv2Hint') },
                      { value: 1, label: 'KV v1', hint: t('settings.secretStores.kv1Hint') },
                    ]"
                    :key="opt.value"
                    class="form-check af-short-check"
                  >
                    <input
                      :id="'af-kv-' + opt.value"
                      v-model="edit.kv_version"
                      class="form-check-input"
                      type="radio"
                      name="af-store-kv"
                      :value="opt.value"
                    />
                    <label class="form-check-label" :for="'af-kv-' + opt.value">
                      <span class="af-short-label">{{ opt.label }}</span>
                      <span class="text-body-secondary small">{{ opt.hint }}</span>
                    </label>
                  </div>
                </div>
                <BsInput
                  class="af-store-field"
                  v-model="edit.default_mount"
                  v-show="fieldShown('default_mount')"
                  icon="folder-open"
                  placeholder="secret"
                  :isFloating="false"
                  :help="t('settings.secretStores.defaultMountHelp')"
                  :label="t('settings.secretStores.defaultMount')"
                />
                <!-- writing : a credential's secret typed in the app written here on Save, only
                     below the prefix -->
                <div v-show="fieldShown('write_enabled')" class="form-check form-switch mb-1">
                  <input
                    id="af-store-write"
                    v-model="edit.write_enabled"
                    class="form-check-input"
                    type="checkbox"
                    role="switch"
                    :disabled="readOnly"
                  />
                  <label class="form-check-label" for="af-store-write">{{
                    t('settings.secretStores.writeEnabled')
                  }}</label>
                </div>
                <div v-show="fieldShown('write_enabled')" class="form-text mb-3">
                  {{ t('settings.secretStores.writeEnabledHelp') }}
                </div>
                <BsInput
                  v-if="edit.write_enabled"
                  class="af-store-field"
                  v-model="edit.write_prefix"
                  v-show="fieldShown('write_prefix')"
                  icon="folder-tree"
                  placeholder="secret/ansibleforms"
                  :isFloating="false"
                  :required="true"
                  :help="t('settings.secretStores.writePrefixHelp')"
                  :label="t('settings.secretStores.writePrefix')"
                />
              </template>
              <BsInput
                class="af-store-field"
                v-model="edit.cache_ttl_seconds"
                v-show="fieldShown('cache_ttl_seconds')"
                type="number"
                icon="clock"
                :isFloating="false"
                :help="t('settings.secretStores.cacheTtlHelp')"
                :label="t('settings.secretStores.cacheTtl')"
              />
              <BsInput
                class="af-store-field"
                v-model="edit.extra"
                v-show="fieldShown('extra')"
                type="textarea"
                icon="code"
                placeholder="{}"
                :isFloating="false"
                :help="t('settings.secretStores.extraHelp')"
                :label="t('settings.secretStores.extra')"
              />
            </template>
          </fieldset>
        </div>
        <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
          {{ t('settings.settingsPage.searchNone') }}
        </div>
      </template>
      <template v-if="store" #actions>
        <!-- Credentials : a new api (Vault) or cyberark credential, chosen once made -->
        <BsButton
          v-if="activeTab === 'credentials'"
          icon="plus"
          :disabled="readOnly"
          @click="creator?.newItem({ credential_type: isVault ? 'vault' : 'cyberark' })"
          >{{ t('settings.repositories.newCredential') }}</BsButton
        >
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
        <AppSkeleton shape="buttons" :widths="recordButtons('secret-stores', storeId)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a runner's and a repository's */
.af-store-field :deep(.input-group) {
  max-width: 40rem;
}
/* the tab ends a little above the card's edge, as every record's page (24px in all) */
.af-store-tab {
  padding-bottom: 0.5rem;
}
/* the fields sit in a fieldset (read only for the config seed's stores) : the card cannot reach
   its last field's margin to zero it, so it is zeroed here */
.af-store-tab fieldset > :last-child,
.af-store-tab fieldset > :last-child :deep(.mb-3:last-child) {
  margin-bottom: 0 !important;
}
/* the radio buttons : their labels one width, so the grey hints line up, as in the dialog */
.af-short-check {
  margin-bottom: 0.6rem;
}
.af-short-label {
  display: inline-block;
  min-width: 12rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
