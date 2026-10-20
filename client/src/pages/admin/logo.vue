<script setup>
import axios from 'axios';
import { toast } from 'vue-sonner';
import TokenStorage from '@/lib/TokenStorage';
import State from '@/lib/State';
import Profile from '@/lib/Profile';
import { useAppStore } from '@/stores/app';
import { useI18n } from 'vue-i18n';
import { useSingleTab } from '@/composables/useSingleTab';

const { t } = useI18n();

// one tab, General, as every settings page is a table or in tabs ; named last in the title
const { tabs, activeTab, crumbs } = useSingleTab({
  key: 'general',
  label: () => t('settings.common.tabGeneral'),
  icon: 'sliders',
  pageCrumbs: () => [{ title: t('sidebar.logo'), icon: 'image', to: '/settings/logo' }],
});
const store = useAppStore();
const authenticated = ref(false);
const fileInput = ref(null);
const selectedFile = ref(null);
const preview = ref(null);
const busy = ref(false);
// the size the current logo shows at in the header (BsNavBar : at most 200 x 33 px, its ratio
// kept), measured there ; null until it is drawn
const headerSize = ref(null);
// the image the header shows : the uploaded logo, or the default one of the theme
const headerSrc = ref(null);

/**
 * Measures the logo of the header, once its image is loaded (a new one after an upload).
 */
async function measureHeaderLogo() {
  await nextTick();
  const img = document.querySelector('.af-brand img.logo');
  if (!img) return;
  if (!img.complete) await new Promise((resolve) => img.addEventListener('load', resolve, { once: true }));
  headerSrc.value = img.currentSrc || img.src;
  const box = img.getBoundingClientRect();
  headerSize.value = box.width > 0 ? { width: Math.round(box.width), height: Math.round(box.height) } : null;
}

// keep in sync with the server (logo.controller.js) ; the server re-validates
// the type with magic-byte sniffing and enforces the size limit anyway
const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
const maxBytes = 900 * 1024;

function onFileChange(e) {
  selectedFile.value = null;
  preview.value = null;
  const file = e.target.files?.[0];
  if (!file) return;
  if (!allowedTypes.includes(file.type)) {
    toast.error(t('logo.invalidType'));
    fileInput.value.value = '';
    return;
  }
  if (file.size > maxBytes) {
    toast.error(t('logo.tooLarge'));
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

async function upload() {
  if (!selectedFile.value) return;
  busy.value = true;
  try {
    const formData = new FormData();
    formData.append('logo', selectedFile.value);
    await axios.post(`/api/v2/logo`, formData, TokenStorage.getAuthenticationMultipart());
    toast.success(t('logo.uploaded'));
    selectedFile.value = null;
    preview.value = null;
    fileInput.value.value = '';
    await State.loadLogo();
    await measureHeaderLogo();
  } catch (err) {
    const error = err.response?.data?.error || err.message;
    const details = err.response?.data?.details;
    toast.error(details ? `${error}: ${details}` : error);
  } finally {
    busy.value = false;
  }
}

async function removeLogo() {
  busy.value = true;
  try {
    await axios.delete(`/api/v2/logo`);
    toast.success(t('logo.removed'));
    await State.loadLogo();
    await measureHeaderLogo();
  } catch (err) {
    const error = err.response?.data?.error || err.message;
    const details = err.response?.data?.details;
    toast.error(details ? `${error}: ${details}` : error);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  await measureHeaderLogo();
});
</script>
<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="image"
      :title="t('sidebar.logo')"
      :description="t('logo.description')"
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
          :disabled="!selectedFile || busy"
          @click="upload()"
          >{{ t('logo.uploadButton') }}</BsButton
        >
        <BsButton v-if="store.customLogo && !store.logoIsDefault" icon="trash" :disabled="busy" @click="removeLogo()">{{
          t('logo.remove')
        }}</BsButton>
      </template>
      <template #default>
        <!-- kept in a repository's branding.yaml, the image beside it : which one -->
        <AppRepositorySource type="branding" />
        <div class="row">
          <div class="col-md-6">
            <label class="form-label fw-bold mb-2">{{ t('logo.current') }}</label>
            <div class="logo-display-box">
              <!-- the image of the header, the default one of the theme too -->
              <img v-if="headerSrc" :src="headerSrc" class="logo-preview" alt="" />
            </div>
            <!-- which one it is, as on the icon page, and its size in the header -->
            <div class="form-text">
              {{ store.logoIsDefault ? t('logo.default') : t('logo.custom') }}
              <template v-if="headerSize"> · {{ t('logo.headerSize', headerSize) }}</template>
            </div>
          </div>
          <div v-if="preview" class="col-md-6">
            <label class="form-label fw-bold mb-2">{{ t('logo.newLogo') }}</label>
            <div class="logo-display-box position-relative">
              <button type="button" class="btn-close btn-close-preview" @click="clearPreview"></button>
              <img :src="preview" class="logo-preview" />
            </div>
          </div>
        </div>
        <hr class="my-3" />
        <div>
          <input
            ref="fileInput"
            class="form-control"
            style="max-width: 40rem"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            @change="onFileChange"
          />
        </div>
        <div class="form-text mt-3">{{ t('logo.constraints') }}</div>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped lang="scss">
.logo-preview {
  max-width: 200px;
  max-height: 40px;
}
/* an svg without width/height has no size of its own (see .logo in BsNavBar.vue) */
.logo-preview[src^='data:image/svg+xml'] {
  height: 40px;
  width: auto;
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
.logo-display-box {
  background-color: var(--bs-tertiary-bg);
  border: 1px dashed var(--bs-border-color);
  border-radius: 0.375rem;
  padding: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 5rem;
}
</style>
