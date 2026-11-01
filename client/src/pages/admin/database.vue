<script setup>
/******************************************************************/
/*                                                                */
/*  A database's page (/settings/databases/<id>), opened from the */
/*  databases' list (Connections > Databases) : its fields in     */
/*  tabs, the tab kept in the url -                               */
/*    Details     its name (the one a field's dbConfig gives) and */
/*                what it is                                      */
/*    Credentials the credential of type database it connects     */
/*                with (New credential beside it)                 */
/*    Used by  the forms whose fields name it in their dbConfig,  */
/*             or name its credential (a form of before           */
/*             databases) ; a row opens the form                  */
/*  Test connection (its credential's), Delete and Save top       */
/*  right ; the search of the title line narrows every tab at     */
/*  once.                                                         */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import getSettings, { DATABASES_PATH } from '@/config/settings';
import { databaseFormRows } from '@/lib/formUseRows';
import { tableMatches } from '@/lib/recordSearch';
import { useConnectionTest } from '@/composables/useConnectionTest';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);

// ─── the database ─────────────────────────────────────────────────────────────
const databaseId = computed(() => String(route.params.id || ''));
// its fields and actions (config/settings.js databases), on its record : the list first in the
// title (Databases › cmdb › Used by) ; what it types only (its credential's columns are the list's),
// and Test connection and Delete (Edit is the list's)
const settings = computed(() => {
  const list = getSettings(t).databases;
  return {
    ...list,
    type: `database/${databaseId.value}`,
    recordTitle: 'name',
    parentCrumbs: [{ title: t('sidebar.databases'), icon: 'database', to: DATABASES_PATH }],
    fields: list.fields.filter((f) => !f.noInput),
    // its fields as wide as a secret store's or a runner's (40rem), on both tabs of fields
    wideTabs: ['details', 'credential'],
    actions: list.actions.filter((a) => a.name !== 'edit'),
  };
});
// the database as saved, from the form (AppAdminSingle) : its name and credential, what the Used
// by tab looks for
const database = ref(null);

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  // the credential of type database it connects with, as a runner's page has its own
  { key: 'credential', label: t('settings.runners.stepAuth'), icon: 'key' },
  { key: 'used-by', label: t('settings.linked.usedBy'), icon: 'link', count: usedBy.value.length },
]);

// ─── Used by ──────────────────────────────────────────────────────────────────
// the forms naming it (or its credential) in a field's dbConfig, as the server scans them
const forms = ref([]);
const usedBy = computed(() => databaseFormRows(forms.value, database.value));
const usedByColumns = computed(() => [
  // the form that queries it
  { key: 'name', label: t('settings.fields.form') },
  { key: 'description', label: t('settings.fields.description') },
  // the form's fields that query it
  { key: 'fields', label: t('settings.databases.field') },
]);
/**
 * Reads the forms and the names their fields give in dbConfig (lib/formLinks.js formCredentials) :
 * a failure leaves the tab empty.
 */
async function loadForms() {
  const res = await axios.get('/api/v2/config/formscredentials').catch(() => null);
  forms.value = res?.data?.records || [];
}

// ─── search ───────────────────────────────────────────────────────────────────
// the word of the title line (AppAdminSingle searchable) : the Used by rows with it match too
const search = ref('');
const topMatches = computed(() => ({ 'used-by': tableMatches(search.value, usedBy.value, usedByColumns.value) }));

// ─── actions ──────────────────────────────────────────────────────────────────
// Test connection : its credential's, as saved
const { test } = useConnectionTest(() => `/api/v2/database/${encodeURIComponent(databaseId.value)}/check`);

// Delete asks first
const deleting = ref(null);
// the form (AppAdminSingle), told to forget its changes once the database is deleted
const single = ref(null);
/**
 * Deletes the database (its credential stays), then goes back to the databases.
 */
async function deleteDatabase() {
  const name = deleting.value?.name;
  deleting.value = null;
  try {
    await axios.delete(`/api/v2/database/${encodeURIComponent(databaseId.value)}`);
    // gone : its form has nothing left to save, so leaving does not offer to save it
    single.value?.forget();
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push(DATABASES_PATH);
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (authenticated.value) await loadForms();
});
</script>
<template>
  <BsModal v-if="deleting" size="md" @close="deleting = null" icon="trash">
    <template #title> {{ t('common.delete') }} {{ deleting.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ deleting.name }}</strong
        >?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteDatabase()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppAdminSingle
      v-if="authenticated"
      ref="single"
      :key="databaseId"
      apiVersion="2"
      :settings="settings"
      :tabs="tabs"
      searchable
      v-model:search="search"
      :searchTopMatches="topMatches"
      @loaded="(item) => (database = item)"
      @test="() => test({ id: databaseId })"
      @delete="(item) => (deleting = item)"
    >
      <!-- Used by : the forms that query it -->
      <template #tab-top-used-by="{ active, searching }">
        <!-- only while its tab is shown, or the search covers every tab : its toolbar and pager go
             to the page's, and would show on the other tabs too -->
        <AppLinkedTable
          v-if="active || searching"
          :search="search || null"
          :exportName="`${database?.name || databaseId}-used-by`"
          :columns="usedByColumns"
          :rows="usedBy"
          rowKey="key"
          :to="(u) => u.to"
          :empty="t('settings.databases.noUse')"
        />
      </template>
    </AppAdminSingle>
  </AppSettingsPage>
</template>
