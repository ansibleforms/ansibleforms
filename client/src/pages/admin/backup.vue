<script setup>
/******************************************************************/
/*                                                                */
/*  A backup's page (/settings/backups/<folder>), opened from the */
/*  backups' list : what the backup holds, read only - its        */
/*  folder, date and description, then its database dump,         */
/*  config.yaml, environment file and forms folder, each found or */
/*  not with its size. Download (a .tar.gz), Restore (the list's  */
/*  dialog, AppBackupRestore) and Delete top right.               */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { useSingleTab } from '@/composables/useSingleTab';
import { useRecordSearch } from '@/composables/useRecordSearch';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the backup ───────────────────────────────────────────────────────────────
const folder = computed(() => String(route.params.folder || ''));
const record = ref(null);

/**
 * Reads the backup (GET /api/v2/backup/<folder>) ; none when it is not there.
 */
async function load() {
  try {
    const result = await axios.get(`/api/v2/backup/${encodeURIComponent(folder.value)}`);
    record.value = result.data?.folder ? result.data : null;
  } catch {
    record.value = null;
  }
  loaded.value = true;
}

/**
 * What a part of the backup is : its name and size, or not found.
 *
 * Args:
 *   exists (boolean): whether the backup holds it.
 *   name (string): its name in the backup folder.
 *   detail (string): its size, or its file count and size.
 *
 * Returns:
 *   string: "ansibleforms.sql (1.2 MB)", or "Not found".
 */
function fileState(exists, name, detail) {
  return exists ? `${name} (${detail})` : t('admin.backups.notFound');
}

// ─── its details : read only, one field each ──────────────────────────────────
const details = computed(() => {
  const b = record.value;
  if (!b) return [];
  return [
    { key: 'folder', icon: 'folder', label: t('admin.backups.folder'), value: b.folder },
    { key: 'date', icon: 'calendar', label: t('admin.backups.date'), value: Helpers.formatServerDate(b.date) },
    { key: 'description', icon: 'comment', label: t('admin.backups.description'), value: b.description || '' },
    {
      key: 'backupFile',
      icon: 'database',
      label: t('admin.backups.backupFile'),
      value: fileState(b.backupFileExists, b.backupFileName, Helpers.humanFileSize(b.backupFileSize)),
    },
    {
      key: 'configYaml',
      icon: 'file-code',
      label: t('admin.backups.configYaml'),
      value: fileState(b.configYamlExists, b.configYamlName, Helpers.humanFileSize(b.configYamlSize)),
    },
    {
      key: 'envFile',
      icon: 'file-shield',
      label: t('admin.backups.envFile'),
      value: fileState(b.envFileExists, b.envFileName, Helpers.humanFileSize(b.envFileSize)),
      // restored on request only, never with the backup : said where the file is shown
      help: b.envFileExists ? t('admin.backups.envFileHelp') : '',
    },
    {
      key: 'formsDirectory',
      icon: 'folder-tree',
      label: t('admin.backups.formsDirectory'),
      value: fileState(
        b.formsDirExists,
        `${b.formsDirName}/`,
        `${t('admin.backups.fileCount', b.formsDirFileCount)}, ${Helpers.humanFileSize(b.formsDirTotalSize)}`,
      ),
    },
  ];
});

// ─── Download ─────────────────────────────────────────────────────────────────
/**
 * Downloads the backup as a .tar.gz (GET /api/v2/backup/<folder>/download).
 */
async function download() {
  try {
    await Helpers.downloadFile(`/api/v2/backup/${encodeURIComponent(folder.value)}/download`);
  } catch (err) {
    // the server's reason (downloadFile decodes its error body), else a translated fallback
    toast.error(Helpers.parseAxiosResponseError(err, t('common.downloadFailed')));
  }
}

// ─── Restore : the list's dialog (AppBackupRestore) ───────────────────────────
const restoring = ref(null);

// ─── Delete : asks first, then back to the list ───────────────────────────────
const confirmDelete = ref(false);
/**
 * Deletes the backup, then goes back to the backups.
 */
async function deleteBackup() {
  confirmDelete.value = false;
  try {
    await axios.delete(`/api/v2/backup/${encodeURIComponent(folder.value)}`);
    toast.success(t('settings.common.nameDeleted', { name: folder.value }));
    router.push('/settings/backups');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows the page, as the other records' pages : the
// details whose label or value has it, under the tab's name.
const { search, searching, matchingKeys } = useRecordSearch();
const shownDetails = computed(() => {
  const keys = matchingKeys(details.value.map((d) => [d.key, d.label, d.value, d.help]));
  return details.value.filter((d) => keys.includes(d.key));
});

// ─── title ────────────────────────────────────────────────────────────────────
const pageCrumbs = computed(() => [
  { title: t('sidebar.backups'), icon: 'box-archive', to: '/settings/backups' },
  {
    title: record.value || loaded.value ? folder.value : null,
    icon: 'box-archive',
    to: `/settings/backups/${folder.value}`,
  },
]);
// one tab, Details, as every record's page ; named last in the title : Backups › 20261019212310 › Details
const { tabs, activeTab, crumbs } = useSingleTab({
  key: 'details',
  label: () => t('settings.common.tabDetails'),
  icon: 'sliders',
  pageCrumbs: () => pageCrumbs.value,
});

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await load();
});
</script>
<template>
  <AppBackupRestore :backup="restoring" @close="restoring = null" @restored="load()" />
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ folder }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ folder }}</strong
        >?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteBackup()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="box-archive"
      :title="folder"
      :crumbs="crumbs"
      :description="t('settings.backups.description')"
    >
      <!-- narrows the page ; the search box of the other pages -->
      <template v-if="record" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="record && !searching" #tabs>
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
      <!-- the record loading : its tab as a grey placeholder -->
      <template v-else-if="!loaded" #tabs>
        <AppSkeleton shape="tabs" :count="tabs.length" />
      </template>
      <template #default>
        <div v-if="loaded && !record" class="empty-state">
          <FaIcon icon="box-archive" class="empty-state-icon" />
          <span>{{ t('admin.backups.pageNotFound', { folder }) }}</span>
        </div>
        <AppSkeleton v-else-if="!loaded" shape="form" :count="7" />
        <div v-else class="af-backup-details">
          <!-- a folder the backup failed to fill : no dump, so not a restore point -->
          <div v-if="!record.valid && !searching" class="alert alert-warning py-2" role="alert">
            <FaIcon icon="triangle-exclamation" class="me-2" /><strong>{{ t('admin.backups.incomplete') }}</strong> -
            {{ t('admin.backups.incompleteDetail') }}
          </div>
          <div v-if="searching && !shownDetails.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
          <!-- searching : the matches under the tab's name, as the other records' pages -->
          <h6 v-if="searching && shownDetails.length" class="fw-bold text-body-secondary af-search-tab af-search-first">
            <FaIcon :icon="tabs[0].icon" class="me-1" />{{ tabs[0].label }}
          </h6>
          <BsInput
            v-for="d in shownDetails"
            :key="d.key"
            class="af-backup-field"
            :modelValue="d.value"
            :icon="d.icon"
            :isFloating="false"
            :disabled="true"
            :label="d.label"
            :help="d.help"
          />
        </div>
      </template>
      <template v-if="record" #actions>
        <BsButton icon="download" @click="download()">{{ t('settings.backups.download') }}</BsButton>
        <BsButton icon="undo" @click="restoring = record">{{ t('settings.backups.restore') }}</BsButton>
        <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="[110, 100, 90]" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a directory user's details */
.af-backup-field :deep(.input-group) {
  max-width: 40rem;
}
/* the page ends a little above the card's edge */
.af-backup-details {
  padding-bottom: 0.5rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
