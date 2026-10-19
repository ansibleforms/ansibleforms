<script setup>
import axios from 'axios';
import { toast } from 'vue-sonner';
import Helpers from '@/lib/Helpers';
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';
import { useI18n } from 'vue-i18n';
import { loadScheduleRepository } from '@/config/rrule';

const { t } = useI18n();
const settings = computed(() => getSettings(t));

const adminMulti = ref(null);
const authenticated = ref(false);

/**
 * Runs a schedule now from its row : its status shown as running meanwhile, a refusal said in a
 * toast (the server's own words), and the list read again whatever the answer.
 *
 * Args:
 *   schedule (object): the schedule's row.
 */
async function triggerLaunch(schedule) {
  adminMulti.value.setItemProperty({ id: schedule.id, key: 'status', value: 'running' });
  try {
    await axios.post(`/api/v2/schedule/${schedule.id}/launch`, {});
    // wait 1 second to visually see the change
    await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('settings.schedules.runSchedule')));
  } finally {
    adminMulti.value?.loadItems();
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
  // a schedules repository : a new recurring schedule is written to it, edited as a rrule
  await loadScheduleRepository();
});
</script>

<template>
  <AppNav />
  <div class="flex-shrink-0">
    <main class="d-flex flex-nowrap af-settings-layout">
      <AppJobsSidebar />
      <AppAdminMulti
        v-if="authenticated"
        apiVersion="2"
        ref="adminMulti"
        :settings="settings.schedules"
        @trigger="triggerLaunch"
      />
      <!-- the user being checked : the title and placeholders where the list comes -->
      <AppPageSkeleton v-else />
    </main>
  </div>
</template>
