<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Appearance > Icon : the website icon, shown in     */
/*  the browser tab and the bookmarks. Stored like the logo       */
/*  (favicon.controller.js) ; without one, the bundled icon.      */
/*                                                                */
/******************************************************************/

import axios from 'axios';
import { toast } from 'vue-sonner';
import TokenStorage from '@/lib/TokenStorage';
import State from '@/lib/State';
import Profile from '@/lib/Profile';
import { useAppStore } from '@/stores/app';
import { useI18n } from 'vue-i18n';
import { useSingleTab } from '@/composables/useSingleTab';
import { useSeedManaged } from '@/composables/useSeedManaged';

const { t } = useI18n();

// one tab, General, as every settings page is a table or in tabs ; named last in the title
const { tabs, activeTab, crumbs } = useSingleTab({
  key: 'general',
  label: () => t('settings.common.tabGeneral'),
  icon: 'sliders',
  pageCrumbs: () => [{ title: t('sidebar.icon'), icon: 'bookmark', to: '/settings/icon' }],
});
const store = useAppStore();
const authenticated = ref(false);
const fileInput = ref(null);
const selectedFile = ref(null);
const preview = ref(null);
const busy = ref(false);

// keep in sync with the server (favicon.controller.js) ; it checks the type by the file's
// bytes and the size again anyway
const allowedTypes = [
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
  'image/webp',
  'image/gif',
  'image/jpeg',
];
const maxBytes = 256 * 1024;

function onFileChange(e) {
  selectedFile.value = null;
  preview.value = null;
  const file = e.target.files?.[0];
  if (!file) return;
  // an .ico often comes without a type from the browser : its extension is enough here
  if (!allowedTypes.includes(file.type) && !/\.ico$/i.test(file.name)) {
    toast.error(t('favicon.invalidType'));
    fileInput.value.value = '';
    return;
  }
  if (file.size > maxBytes) {
    toast.error(t('favicon.tooLarge'));
    fileInput.value.value = '';
    return;
  }
  selectedFile.value = file;
  const reader = new FileReader();
  reader.onload = () => {
    preview.value = reader.result;
  };
  reader.readAsDataURL(file);
}

function clearPreview() {
  selectedFile.value = null;
  preview.value = null;
  fileInput.value.value = '';
}

function showError(err) {
  const error = err.response?.data?.error || err.message;
  const details = err.response?.data?.details;
  toast.error(details ? `${error}: ${details}` : error);
}

async function upload() {
  if (!selectedFile.value) return;
  busy.value = true;
  try {
    const formData = new FormData();
    formData.append('favicon', selectedFile.value);
    await axios.post(`/api/v2/favicon`, formData, TokenStorage.getAuthenticationMultipart());
    toast.success(t('favicon.uploaded'));
    clearPreview();
    await State.loadFavicon();
  } catch (err) {
    showError(err);
  } finally {
    busy.value = false;
  }
}

async function removeIcon() {
  busy.value = true;
  try {
    await axios.delete(`/api/v2/favicon`, TokenStorage.getAuthentication());
    toast.success(t('favicon.removed'));
    await State.loadFavicon();
  } catch (err) {
    showError(err);
  } finally {
    busy.value = false;
  }
}

// the icon in use : the stored one, or the bundled one of index.html
const currentIcon = computed(() => store.customFavicon || 'favicon.svg');
// the current icon's own size, read from its image once loaded ; an svg has none, it is sharp at
// any size
const iconSize = ref(null);

/**
 * Reads the current icon's size from its loaded image.
 *
 * Args:
 *   event (Event): the image's load.
 */
function onIconLoad(event) {
  const img = event.target;
  const svg = /^data:image\/svg\+xml|\.svg$/i.test(currentIcon.value);
  iconSize.value = svg ? 'svg' : { width: img.naturalWidth, height: img.naturalHeight };
}

// the fields the config seed manages : read only here
const { seeded, loadSeedManaged } = useSeedManaged();

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  State.loadFavicon();
  await loadSeedManaged();
});
</script>
<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="bookmark"
      :title="t('sidebar.icon')"
      :description="t('favicon.description')"
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
        <BsButton
          icon="upload"
          :colorClass="!selectedFile || busy ? 'secondary' : 'primary'"
          :disabled="!selectedFile || busy || seeded('icon')"
          @click="upload()"
          >{{ t('favicon.uploadButton') }}</BsButton
        >
        <BsButton v-if="store.customFavicon" icon="trash" :disabled="busy || seeded('icon')" @click="removeIcon()">{{
          t('favicon.remove')
        }}</BsButton>
      </template>
      <template #default>
        <AppSeedNotice v-if="seeded('icon')" />
        <!-- kept under icon: in a repository's file, the image it names : which one, and the file -->
        <AppRepositorySource type="icon" />
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label fw-bold mb-2">{{ t('favicon.current') }}</label>
            <div class="af-icon-box">
              <!-- as the browser shows it : 16 px in a tab, 32 px on a bookmark -->
              <img :src="currentIcon" class="af-icon-16" alt="" @load="onIconLoad" />
              <img :src="currentIcon" class="af-icon-32" alt="" />
            </div>
            <!-- which one it is, and its own size (an svg : any size), as the logo page -->
            <div class="form-text">
              {{ store.customFavicon ? t('favicon.custom') : t('favicon.default') }}
              <template v-if="iconSize === 'svg'"> · {{ t('favicon.vector') }}</template>
              <template v-else-if="iconSize"> · {{ t('favicon.size', iconSize) }}</template>
            </div>
          </div>
          <div v-if="preview" class="col-md-6">
            <label class="form-label fw-bold mb-2">{{ t('favicon.newIcon') }}</label>
            <div class="af-icon-box position-relative">
              <button type="button" class="btn-close btn-close-preview" @click="clearPreview"></button>
              <img :src="preview" class="af-icon-16" alt="" />
              <img :src="preview" class="af-icon-32" alt="" />
            </div>
          </div>
        </div>
        <hr class="my-3" />
        <div>
          <input
            ref="fileInput"
            :disabled="seeded('icon')"
            class="form-control"
            style="max-width: 40rem"
            type="file"
            accept="image/png,image/x-icon,.ico,image/svg+xml,image/webp,image/gif,image/jpeg"
            @change="onFileChange"
          />
        </div>
        <div class="form-text mt-3">{{ t('favicon.constraints') }}</div>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped lang="scss">
.af-icon-box {
  /* the logo page's box : the same padding and height (its 40px logo, 1.5rem around it) */
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  min-height: calc(40px + 3rem + 2px);
  padding: 1.5rem;
  background-color: var(--bs-tertiary-bg);
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.375rem;
}
.af-icon-16 {
  width: 16px;
  height: 16px;
}
.af-icon-32 {
  width: 32px;
  height: 32px;
}
.btn-close-preview {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  font-size: 0.6rem;
  opacity: 0.5;
  &:hover {
    opacity: 1;
  }
}
</style>
