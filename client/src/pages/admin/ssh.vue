<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Connections > SSH, in two tabs, the tab kept in    */
/*  the url : the app's own ssh, its ~/.ssh                       */
/*  Key         - the key pair the app connects with (git over    */
/*                ssh : a repository at git@host:org/repo.git)    */
/*  Known hosts - the servers it trusts ; a repository's host is  */
/*                added when it is first cloned. Playbooks run on */
/*                an RTE, which keeps its own                     */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from 'vue-sonner';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import getSettings from '@/config/settings';
import { useRouteTab } from '@/composables/useRouteTab';

const { t } = useI18n();
const settings = computed(() => getSettings(t));
const authenticated = ref(false);

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'key', label: t('settings.ssh.tabKey'), icon: 'key' },
  { key: 'known-hosts', label: t('sidebar.knownHosts'), icon: 'server' },
]);
const { activeTab, tabLink } = useRouteTab('key', (key) => ['key', 'known-hosts'].includes(key));
// the title says the tab : SSH › Known hosts, each step a link (the key's tab is in the form's)
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return [
    { title: t('sidebar.ssh'), icon: 'key', to: '/settings/ssh' },
    { title: tab.label, icon: tab.icon, to: tabLink(tab.key) },
  ];
});

// ─── Known hosts : an entry copied ────────────────────────────────────────────
/**
 * Copies a known hosts entry to the clipboard.
 *
 * Args:
 *   item (string): the entry.
 */
function preview(item) {
  Helpers.copyToClipboard(item)
    .then(() => toast.success(t('admin.copiedToClipboard')))
    .catch(() => toast.error(t('admin.clipboardHttpsRequired')));
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
});
</script>
<template>
  <AppSettingsPage>
    <!-- KNOWN HOSTS : the servers the app trusts ; the page's tabs above them -->
    <AppAdminMulti
      v-if="authenticated && activeTab === 'known-hosts'"
      apiVersion="2"
      :settings="settings.knownhosts"
      :crumbs="crumbs"
      @preview="preview"
    >
      <template #tabs>
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
    </AppAdminMulti>
    <!-- KEY : the key pair ; the form draws the same tabs, and the search box of the settings pages -->
    <AppAdminSingle v-else-if="authenticated" :apiVersion="2" :settings="settings.ssh" :tabs="tabs" searchable>
      <!-- kept under controller_ssh: in a repository's file (the key and the known hosts) : which one, and the file -->
      <template #tab-top-key="{ searching }">
        <AppRepositorySource v-show="!searching" type="ssh" />
      </template>
    </AppAdminSingle>
  </AppSettingsPage>
</template>
<route lang="yaml">
meta:
  layout: settings
</route>
