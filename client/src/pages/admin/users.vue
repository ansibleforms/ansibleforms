<script setup>
import getSettings from '@/config/settings';
import Profile from '@/lib/Profile';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const settings = computed(() => getSettings(t));
const authenticated = ref(false);

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
});
</script>

<template>
  <AppSettingsPage>
    <AppAdminMulti v-if="authenticated" :settings="settings.users" :apiVersion="2" />
  </AppSettingsPage>
</template>
