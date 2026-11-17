<script setup>
/******************************************************************/
/*                                                                */
/*  An LDAP directory's page (/settings/ldap/<id>), opened from   */
/*  the directories' list : its fields in tabs, the tab kept in   */
/*  the url -                                                     */
/*    Details  its name (the default directory keeps its own),    */
/*             and on or off                                      */
/*    Credentials  where it connects and as whom : an ldap        */
/*             credential of Connections > Credentials (its       */
/*             servers, the next one when one cannot be reached,  */
/*             TLS, and the bind account)                         */
/*    Users    where the users are, their attributes, and the     */
/*             sign-in domains that go straight to it             */
/*    Groups   how their groups are found                         */
/*  Test connection, Delete (but the default directory's) and     */
/*  Save top right ; the search of the title line narrows every   */
/*  tab at once.                                                  */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';
import Helpers from '@/lib/Helpers';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);

const directoryId = computed(() => String(route.params.id || ''));
// a directory's fields and actions (config/settings.js ldap), on its record : the list first in
// the title (LDAP › corp › Server)
const settings = computed(() => ({
  ...getSettings(t).ldap,
  type: `ldapdirectory/${directoryId.value}`,
  recordTitle: 'name',
  parentCrumbs: [{ title: t('sidebar.ldap'), icon: 'address-book', to: '/settings/ldap' }],
  // every tab's fields 40rem wide, as on every record page (a database's, a runner's)
  wideTabs: ['details', 'credentials', 'users', 'groups'],
}));
// the page in tabs : on or off and where it stands, its credential (the servers and the binding),
// the users, the groups
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'credentials', label: t('settings.common.tabCredentials'), icon: 'key' },
  { key: 'users', label: t('settings.ldap.tabUsers'), icon: 'user' },
  { key: 'groups', label: t('settings.ldap.tabGroups'), icon: 'users' },
]);

// the directory tested, its fields as they are on the page (saved or not)
const testing = ref(null);
function openTest(item) {
  testing.value = { ...item, id: directoryId.value };
}

// Delete asks first
const deleting = ref(null);
// the form (AppAdminSingle), told to forget its changes once the directory is deleted
const single = ref(null);
/**
 * Deletes the directory, then goes back to the directories.
 */
async function deleteDirectory() {
  const name = deleting.value?.name;
  deleting.value = null;
  try {
    await axios.delete(`/api/v2/ldapdirectory/${encodeURIComponent(directoryId.value)}`);
    // gone : its form has nothing left to save, so leaving does not offer to save it
    single.value?.forget();
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/ldap');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
});
</script>
<template>
  <AppLdapTestDialog v-if="testing" :directory="testing" @close="testing = null" />
  <BsModal v-if="deleting" size="md" @close="deleting = null" icon="trash">
    <template #title> {{ t('common.delete') }} {{ deleting.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ deleting.name }}</strong>?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteDirectory()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppAdminSingle
      v-if="authenticated"
      ref="single"
      :key="directoryId"
      apiVersion="2"
      :settings="settings"
      :tabs="tabs"
      searchable
      @test="openTest"
      @delete="(item) => (deleting = item)"
    />
  </AppSettingsPage>
</template>
<route lang="yaml">
meta:
  layout: settings
</route>
