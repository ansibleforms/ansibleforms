<script setup>
/******************************************************************/
/*                                                                */
/*  The databases' list (Connections > Databases) : the databases */
/*  forms query, each with the credential of type database it     */
/*  connects with (config/settings.js databases). A row opens its */
/*  page (database.vue) ; Test connection tests its credential.   */
/*                                                                */
/******************************************************************/
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';
import { useI18n } from 'vue-i18n';
import { useConnectionTest } from '@/composables/useConnectionTest';

const { t } = useI18n();
const settings = computed(() => getSettings(t).databases);
const authenticated = ref(false);
// Test connection, from a row's menu : its credential's
const { tests, test } = useConnectionTest((item) => `/api/v2/database/${item.id}/check`);

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
});
</script>
<template>
  <AppSettingsPage>
    <AppAdminMulti v-if="authenticated" apiVersion="2" :settings="settings" @test="test" :busyItems="tests" />
  </AppSettingsPage>
</template>
