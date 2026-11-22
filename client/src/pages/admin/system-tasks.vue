<script setup>
/******************************************************************/
/*                                                                */
/*  The app's own maintenance tasks (/jobs/system) : one row per  */
/*  task, with when it runs in words, its last run and how it     */
/*  went, and its next run, in the scheduled jobs' table, search  */
/*  and layout (config/settings.js system_tasks). Read only : a   */
/*  row opens the task's page (pages/system-task.vue), there is   */
/*  no Add, no row menu.                                          */
/*                                                                */
/******************************************************************/
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const settings = computed(() => getSettings(t));

const authenticated = ref(false);

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
});
</script>

<template>
  <AppNav />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout">
      <AppJobsSidebar />
      <AppAdminMulti v-if="authenticated" apiVersion="2" :settings="settings.system_tasks" />
      <!-- the user being checked : the title and placeholders where the list comes -->
      <AppPageSkeleton v-else />
    </main>
  </div>
</template>
