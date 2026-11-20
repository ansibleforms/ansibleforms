<script setup>
/******************************************************************/
/*                                                                */
/*  An announcement's page (/settings/announcements/<id>), opened */
/*  from the announcements' list : its message, its type, its     */
/*  start and its end, and whether it is enabled (shown under the */
/*  header from its start until its end).                         */
/*  Delete and Save top right.                                    */
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
import { useSingleTab } from '@/composables/useSingleTab';
import { useRecordSearch } from '@/composables/useRecordSearch';
import { repositorySourceFields } from '@/lib/repositoryUsage';
import BsSwitch from '@/components/BsSwitch.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the announcement ─────────────────────────────────────────────────────────
const announcementId = computed(() => String(route.params.id || ''));
const record = ref(null); // as saved
const edit = ref(null); // as edited
// its switch among them : shown or not, saved with Save as the rest
const FIELDS = ['message', 'level', 'start_at', 'end_at', 'enabled'];
// its types, as the list's wizard offers them
const LEVELS = computed(() =>
  ['info', 'warning', 'danger'].map((value) => ({ value, label: t(`settings.interface.banner_${value}`) })),
);

/**
 * A field's value to compare : a moment as epoch ms (the calendar sends it again in its own
 * format), the rest as text.
 *
 * Args:
 *   key (string): the field.
 *   value (any): its value.
 *
 * Returns:
 *   string|number: the value to compare.
 */
function comparable(key, value) {
  if (key === 'start_at' || key === 'end_at') return value ? new Date(value).getTime() : '';
  if (key === 'enabled') return !!Number(value);
  return value ?? '';
}
const dirty = computed(
  () => !!record.value && FIELDS.some((k) => comparable(k, edit.value[k]) !== comparable(k, record.value[k])),
);
useUnsavedGuard(dirty, () => save());

/**
 * Reads the announcement.
 */
async function load() {
  try {
    const res = await axios.get(`/api/v2/announcement/${encodeURIComponent(announcementId.value)}`);
    record.value = res.data?.id ? res.data : null;
    edit.value = record.value
      ? {
          ...Object.fromEntries(FIELDS.map((k) => [k, record.value[k] ?? null])),
          enabled: !!Number(record.value.enabled),
        }
      : null;
  } catch {
    record.value = null;
  }
  loaded.value = true;
}

// ─── Save ─────────────────────────────────────────────────────────────────────
/**
 * Saves its message, its type, its moments and whether it is enabled.
 *
 * Returns:
 *   Promise<boolean>: whether it was saved.
 */
async function save() {
  if (!dirty.value) return true;
  if (!String(edit.value.message || '').trim()) {
    toast.warning(t('settings.interface.announcementMissing'));
    return false;
  }
  try {
    await axios.put(`/api/v2/announcement/${encodeURIComponent(announcementId.value)}`, {
      message: edit.value.message,
      level: edit.value.level,
      start_at: edit.value.start_at || null,
      end_at: edit.value.end_at || null,
      enabled: !!edit.value.enabled,
    });
    // read again first : the toast names it by its message as saved
    await load();
    toast.success(t('settings.common.nameUpdated', { name: name.value }));
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// Delete asks first
const confirmDelete = ref(false);
/**
 * Deletes it, then goes back to the announcements.
 */
async function deleteAnnouncement() {
  confirmDelete.value = false;
  try {
    const gone = name.value;
    await axios.delete(`/api/v2/announcement/${encodeURIComponent(announcementId.value)}`);
    // gone : nothing left to save
    record.value = null;
    toast.success(t('settings.common.nameDeleted', { name: gone }));
    router.push('/settings/announcements');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

// ─── title ────────────────────────────────────────────────────────────────────
// the start of its message, as the list's delete dialog names it
const name = computed(() => {
  const text = String(record.value?.message || '');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
});
// the title's step : the first 12 characters of its message, then ... (a whole message is long)
const shortName = computed(() => {
  const text = String(record.value?.message || '');
  return text.length > 12 ? `${text.slice(0, 12)}...` : text;
});
const pageCrumbs = computed(() => [
  { title: t('sidebar.announcement'), icon: 'bullhorn', to: '/settings/announcements' },
  {
    title: record.value ? shortName.value : loaded.value ? announcementId.value : null,
    icon: 'bullhorn',
    to: `/settings/announcements/${announcementId.value}`,
  },
]);

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows the page, as Settings > General's : the fields
// whose label or help has it, under the tab's name, the tab set aside meanwhile.
const { search, searching, matchingKeys } = useRecordSearch();
const shownFields = computed(() =>
  matchingKeys([
    // one kept in a repository : where it comes from
    ...repositorySourceFields(t, record.value),
    ['message', t('settings.interface.banner'), t('settings.interface.bannerHelp')],
    ['level', t('settings.interface.bannerLevel'), t('settings.interface.bannerLevelHelp')],
    ['start', t('settings.interface.bannerStart'), t('settings.interface.bannerStartHelp')],
    ['end', t('settings.interface.bannerEnd'), t('settings.interface.bannerEndHelp')],
    ['enabled', t('settings.interface.announcementEnabled'), t('settings.interface.announcementEnabledHelp')],
  ]),
);
const fieldShown = (key) => shownFields.value.includes(key);

// one tab, Details, as every record's page ; named last in the title
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
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        <i18n-t keypath="settings.common.deleteConfirm" scope="global">
          <template #name
            ><strong>{{ name }}</strong></template
          >
        </i18n-t>
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteAnnouncement()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="bullhorn"
      :title="shortName || announcementId"
      :crumbs="crumbs"
      :description="t('settings.interface.announcementDescription')"
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
        <AppSkeleton shape="tabs" :count="1" />
      </template>
      <template #default>
        <div v-if="loaded && !record" class="empty-state">
          <FaIcon icon="bullhorn" class="empty-state-icon" />
          <span>{{ t('settings.interface.announcementNotFound', { id: announcementId }) }}</span>
        </div>
        <AppSkeleton v-else-if="!loaded" shape="form" :count="5" />
        <div v-else class="af-announcement-tab">
          <div v-if="searching && !shownFields.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
          <!-- searching : the matches under the tab's name, as Settings > General -->
          <h6 v-if="searching && shownFields.length" class="fw-bold text-body-secondary af-search-tab af-search-first">
            <FaIcon :icon="tabs[0].icon" class="me-1" />{{ tabs[0].label }}
          </h6>
          <!-- where it comes from : a repository's file ; nothing for one kept in the app only -->
          <AppRepositorySource v-show="fieldShown('source')" :record="record" />
          <BsInput
            v-show="fieldShown('message')"
            class="af-announcement-field"
            v-model="edit.message"
            icon="bullhorn"
            :isFloating="false"
            :required="true"
            :help="t('settings.interface.bannerHelp')"
            :label="t('settings.interface.banner')"
          />
          <BsInput
            v-show="fieldShown('level')"
            class="af-announcement-field"
            v-model="edit.level"
            type="select"
            icon="circle-info"
            :isFloating="false"
            :values="LEVELS"
            valueKey="value"
            labelKey="label"
            :help="t('settings.interface.bannerLevelHelp')"
            :label="t('settings.interface.bannerLevel')"
          />
          <!-- its start and its end : moments, picked in the app's time zone -->
          <div v-show="fieldShown('start')" class="mb-3 af-announcement-field">
            <label class="form-label fw-bold">{{ t('settings.interface.bannerStart') }}</label>
            <BsDateTime v-model="edit.start_at" icon="calendar" dateType="datetime" convertToUtc />
            <div class="form-text">{{ t('settings.interface.bannerStartHelp') }}</div>
          </div>
          <div v-show="fieldShown('end')" class="mb-3 af-announcement-field">
            <label class="form-label fw-bold">{{ t('settings.interface.bannerEnd') }}</label>
            <BsDateTime v-model="edit.end_at" icon="calendar" dateType="datetime" convertToUtc />
            <div class="form-text">{{ t('settings.interface.bannerEndHelp') }}</div>
          </div>
          <!-- whether it shows : a switch, as a disclaimer's, saved with Save -->
          <div v-show="fieldShown('enabled')" class="mb-0">
            <label class="form-label fw-bold d-block" for="af-announcement-enabled">{{
              t('settings.interface.announcementEnabled')
            }}</label>
            <BsSwitch id="af-announcement-enabled" v-model="edit.enabled" class="mb-0" />
            <div class="form-text">{{ t('settings.interface.announcementEnabledHelp') }}</div>
          </div>
        </div>
      </template>
      <template v-if="record" #actions>
        <BsButton icon="trash" @click="confirmDelete = true">{{ t('common.delete') }}</BsButton>
        <BsButton icon="save" :disabled="!dirty" @click="save()">{{ t('settings.common.save') }}</BsButton>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* one width, as the other pages' wide fields */
.af-announcement-field :deep(.input-group),
.af-announcement-field.mb-3 {
  max-width: 40rem;
}
/* the page ends a little above the card's edge */
.af-announcement-tab {
  padding-bottom: 0.5rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
