<script setup>
/******************************************************************/
/*                                                                */
/*  A label's page (/settings/labels/<id>), opened from the       */
/*  labels' list : its text, its colour, its place among the      */
/*  others, whether it is shown (its switch), and a preview of    */
/*  the header with every label shown. Delete and Save top right. */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers';
import { PILL } from '@/lib/tableCells';
import { LABEL_COLORS } from '@/config/settings';
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

// ─── the label ────────────────────────────────────────────────────────────────
const labelId = computed(() => String(route.params.id || ''));
const record = ref(null); // as saved
const edit = ref(null); // as edited
const others = ref([]); // every label, for the preview
// its switch among them : shown or not, saved with Save as the rest
const FIELDS = ['name', 'color', 'position', 'enabled'];

/**
 * The fields of a label as this page edits them.
 *
 * Args:
 *   rec (object): the label.
 *
 * Returns:
 *   object: the edited fields.
 */
const editable = (rec) => ({
  name: rec.name ?? null,
  color: rec.color ?? null,
  position: rec.position ?? null,
  enabled: !!Number(rec.enabled),
});
const dirty = computed(
  () => !!record.value && FIELDS.some((k) => String(edit.value[k] ?? '') !== String(editable(record.value)[k] ?? '')),
);
useUnsavedGuard(dirty, () => save());

/**
 * Reads the label, and every label for the preview.
 */
async function load() {
  try {
    const [one, all] = await Promise.all([
      axios.get(`/api/v2/label/${encodeURIComponent(labelId.value)}`),
      axios.get('/api/v2/label/').catch(() => ({ data: { records: [] } })),
    ]);
    record.value = one.data?.id ? one.data : null;
    edit.value = record.value ? editable(record.value) : null;
    others.value = all.data?.records || [];
  } catch {
    record.value = null;
  }
  loaded.value = true;
}

// ─── Save ─────────────────────────────────────────────────────────────────────
/**
 * Saves its text, its colour, its place and whether it is shown.
 *
 * Returns:
 *   Promise<boolean>: whether it was saved.
 */
async function save() {
  if (!dirty.value) return true;
  if (!String(edit.value.name || '').trim()) {
    toast.warning(t('settings.labels.nameMissing'));
    return false;
  }
  try {
    await axios.put(`/api/v2/label/${encodeURIComponent(labelId.value)}`, {
      name: edit.value.name,
      color: edit.value.color,
      position: edit.value.position === '' ? null : edit.value.position,
      enabled: !!edit.value.enabled,
    });
    toast.success(t('settings.common.nameUpdated', { name: edit.value.name }));
    await load();
    return true;
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
    return false;
  }
}

// Delete asks first
const confirmDelete = ref(false);
/**
 * Deletes it, then goes back to the labels.
 */
async function deleteLabel() {
  confirmDelete.value = false;
  try {
    const name = record.value?.name;
    await axios.delete(`/api/v2/label/${encodeURIComponent(labelId.value)}`);
    // gone : nothing left to save
    record.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/labels');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

// ─── the preview : every label enabled, this one as edited (AppLabelsPreview) ──────────────
const previewLabels = computed(() => {
  const mine = record.value ? { ...record.value, ...edit.value } : null;
  return others.value
    .map((l) => (mine && l.id === mine.id ? mine : l))
    .filter((l) => l.enabled)
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows the page, as Settings > General's : the fields
// whose label or help has it, under the tab's name, the tab set aside meanwhile.
const { search, searching, matchingKeys } = useRecordSearch();
const shownFields = computed(() =>
  matchingKeys([
    // one kept in a repository : where it comes from
    ...repositorySourceFields(t, record.value),
    ['name', t('settings.labels.label'), t('settings.labels.nameHelp')],
    ['color', t('settings.labels.color'), t('settings.labels.colorHelp')],
    ['position', t('settings.labels.position'), t('settings.labels.positionHelp')],
    ['enabled', t('settings.labels.enabled'), t('settings.labels.enabledHelp')],
    ['preview', t('settings.labels.preview')],
  ]),
);
const fieldShown = (key) => shownFields.value.includes(key);

// ─── title ────────────────────────────────────────────────────────────────────
const pageCrumbs = computed(() => [
  { title: t('sidebar.labels'), icon: 'tag', to: '/settings/labels' },
  {
    title: record.value ? record.value.name : loaded.value ? labelId.value : null,
    icon: 'tag',
    to: `/settings/labels/${labelId.value}`,
  },
]);
// one tab, Details, as every record's page ; named last in the title : Labels › PRODUCTION › Details
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
    <template #title> {{ t('common.delete') }} {{ record?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        <i18n-t keypath="settings.common.deleteConfirm" scope="global">
          <template #name
            ><strong>{{ record?.name }}</strong></template
          >
        </i18n-t>
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteLabel()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="tag"
      :title="record?.name || labelId"
      :crumbs="crumbs"
      :description="t('settings.labels.description')"
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
          <FaIcon icon="tag" class="empty-state-icon" />
          <span>{{ t('settings.labels.notFound', { id: labelId }) }}</span>
        </div>
        <AppSkeleton v-else-if="!loaded" shape="form" :count="4" />
        <div v-else class="af-label-tab">
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
            v-show="fieldShown('name')"
            class="af-label-field"
            v-model="edit.name"
            icon="tag"
            :isFloating="false"
            :required="true"
            placeholder="PRODUCTION"
            :help="t('settings.labels.nameHelp')"
            :label="t('settings.labels.label')"
          />
          <!-- its colour : round swatches in the pills' colours -->
          <div v-show="fieldShown('color')">
            <label class="form-label fw-bold d-block"
              >{{ t('settings.labels.color') }}<span class="text-danger ms-1">*</span></label
            >
            <div class="d-flex flex-wrap gap-2 ms-1" role="radiogroup" :aria-label="t('settings.labels.color')">
              <button
                v-for="c in LABEL_COLORS"
                :key="c"
                type="button"
                class="settings-color-swatch"
                :class="[PILL[c], { 'af-swatch-active': edit.color === c }]"
                :title="t(`settings.labels.color_${c}`)"
                role="radio"
                :aria-checked="edit.color === c"
                @click="edit.color = c"
              >
                <FaIcon v-if="edit.color === c" icon="check" class="settings-swatch-check" />
              </button>
            </div>
            <div class="form-text mb-3">{{ t('settings.labels.colorHelp') }}</div>
          </div>
          <BsInput
            v-show="fieldShown('position')"
            class="af-label-field af-label-short"
            v-model="edit.position"
            type="number"
            icon="arrow-down-1-9"
            :isFloating="false"
            :help="t('settings.labels.positionHelp')"
            :label="t('settings.labels.position')"
          />
          <!-- enabled or not : a switch, after the fields as on the other records' pages, saved with Save -->
          <div v-show="fieldShown('enabled')" class="mb-3">
            <label class="form-label fw-bold d-block" for="af-label-enabled">{{ t('settings.labels.enabled') }}</label>
            <BsSwitch id="af-label-enabled" v-model="edit.enabled" class="mb-0" />
            <div class="form-text">{{ t('settings.labels.enabledHelp') }}</div>
          </div>
          <!-- the preview : the header's logo and every label shown, as the header shows them -->
          <div v-show="fieldShown('preview')">
            <label class="form-label fw-bold d-block">{{ t('settings.labels.preview') }}</label>
            <AppLabelsPreview :labels="previewLabels" />
            <div v-if="!edit.enabled" class="form-text">{{ t('settings.labels.previewHidden') }}</div>
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
/* one width, as the other pages' wide fields ; the place a short one */
.af-label-field :deep(.input-group) {
  max-width: 20rem;
}
.af-label-short :deep(.input-group) {
  max-width: 10rem;
}
/* the page ends a little above the card's edge */
.af-label-tab {
  padding-bottom: 0.5rem;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
