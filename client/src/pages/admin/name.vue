<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Appearance > Name : the application's name, in the */
/*  browser tab and on the sign-in page ; AnsibleForms without   */
/*  one. Kept in the settings row.                                */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import { useSettingsRow } from '@/composables/useSettingsRow';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useSingleTab } from '@/composables/useSingleTab';

const { t } = useI18n();

// one tab, General, as every settings page is a table or in tabs ; named last in the title
const { tabs, activeTab, crumbs } = useSingleTab({
  key: 'general',
  label: () => t('settings.common.tabGeneral'),
  icon: 'sliders',
  pageCrumbs: () => [{ title: t('sidebar.name'), icon: 'font', to: '/settings/name' }],
});
const authenticated = ref(false);
// the page's values read once : until then its fields as grey placeholders
const loaded = ref(false);

/**
 * The name of a settings row, as the page edits it : empty without one.
 *
 * Args:
 *   row (object): the settings row.
 *
 * Returns:
 *   object: { app_name }.
 */
function nameOf(row) {
  return { app_name: row?.app_name || '' };
}
const { edit: look, dirty, load, save } = useSettingsRow(nameOf);
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => save(t('settings.common.nameUpdated', { name: title.value })),
);

const title = computed(() => t('sidebar.name'));

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (authenticated.value) await load();
  loaded.value = true;
});
</script>
<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="font"
      :title="title"
      :description="t('settings.interface.nameDescription')"
      :crumbs="crumbs"
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
      <template #actions>
        <BsButton icon="save" :disabled="!dirty" @click="save(t('settings.common.nameUpdated', { name: title }))">{{
          t('settings.common.save')
        }}</BsButton>
      </template>
      <template #default>
        <!-- the first load : the fields as grey placeholders, in their place -->
        <AppSkeleton v-if="!loaded" shape="form" :count="1" />
        <template v-else>
          <!-- kept in a repository's branding.yaml : which one -->
          <AppRepositorySource type="branding" />
          <BsInput
            class="af-interface-field"
            :isFloating="false"
            icon="font"
            v-model="look.app_name"
            placeholder="AnsibleForms"
            :label="t('settings.interface.appName')"
            :help="t('settings.interface.appNameHelp')"
          />
        </template>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the card ends at its own padding : no margin of the last field under it */
:deep(.card-body > .mb-3:last-child),
:deep(.card-body > :last-child > .mb-3:last-child) {
  margin-bottom: 0 !important;
}
/* as wide as the other fields of the settings pages */
.af-interface-field :deep(.input-group) {
  max-width: 40rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
