<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Notifications : the channels notifications go to - */
/*  SMTP servers (one of them active : the app sends its mail     */
/*  with it), Slack, Microsoft Teams, Telegram and webhooks. A    */
/*  row opens the channel's page (notification-channel.vue), Add  */
/*  the wizard. A config seed's mail settings are a mail channel  */
/*  of its own, shown in the list like any managed record.        */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';

const { t } = useI18n();
const settings = computed(() => getSettings(t));
const authenticated = ref(false);

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
});
</script>
<template>
  <AppSettingsPage>
    <!-- min-width 0 : a flex item, it keeps the page's width instead of growing with its list (the
         list's columns then fit the room, as every list's) -->
    <div v-if="authenticated" class="flex-grow-1 d-flex flex-column af-channels-page">
      <AppAdminMulti :settings="settings.notificationChannels" :apiVersion="2" />
    </div>
  </AppSettingsPage>
</template>
<style scoped>
.af-channels-page {
  min-width: 0;
}
</style>
