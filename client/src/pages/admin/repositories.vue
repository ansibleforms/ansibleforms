<script setup>
import axios from 'axios';
import { toast } from 'vue-sonner';
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';
import { useI18n } from 'vue-i18n';
import Helpers from '@/lib/Helpers';
import { sortPulls } from '@/lib/pullResults';
import { useAppStore } from '@/stores/app';

const { t } = useI18n();
const settings = computed(() => getSettings(t));
// adding or deleting a repository is an admin's (its content becomes the configuration, the forms
// or the playbooks the app runs ; the server refuses the others) : no Add, no Delete for them, the
// rest (Edit, Pull, Push, Reset) stays theirs
const store = useAppStore();
const repoSettings = computed(() => {
  const base = settings.value.repositories;
  if (store.isAdmin) return base;
  return { ...base, noCreate: true, actions: (base.actions || []).filter((a) => a.name !== 'delete') };
});

const adminMulti = ref(null);
const authenticated = ref(false);

/**
 * Shows a repository's row as running a git action until the list is read again : its status
 * (the lock any git operation takes), and the Push badge for a push (sync), else the Pull badge
 * (a pull or a reset) - as the server writes them (models/repository.model.js claim).
 *
 * Args:
 *   name (string): the repository's name.
 *   action (string): the api action ('clone', 'sync', 'reset').
 */
function showRunning(name, action) {
  adminMulti.value.setItemProperty({ id: name, key: 'status', value: 'running' });
  adminMulti.value.setItemProperty({
    id: name,
    key: action === 'sync' ? 'push_status' : 'pull_status',
    value: 'running',
  });
}

/**
 * Runs a git action of a repository's row (Pull, Push, Reset) : its badge shown as running
 * meanwhile, a refusal said in a toast (the server's own words), and the list read again
 * whatever the answer, so the row never stays on running.
 *
 * Args:
 *   repo (object): the repository's row.
 *   action (string): the api action ('clone', 'sync', 'reset').
 *   title (string): what the action is called, said when the server gives no reason.
 */
async function runGit(repo, action, title) {
  showRunning(repo.name, action);
  try {
    await axios.post(`/api/v2/repository/${encodeURIComponent(repo.name)}/${action}`, {});
    // wait 1 second to visually see the change
    await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, title));
  } finally {
    adminMulti.value?.loadItems();
  }
}
async function triggerClone(repo) {
  await runGit(repo, 'clone', t('settings.repositories.pull'));
}
// Pull all : every repository pulled (cloned when it is not there yet) at once, as its own Pull
// does ; the ones that fail are named, and so are the ones skipped because their changes are
// not pushed yet (the server refuses their pull with a 409, the others still go)
const pullingAll = ref(false);
async function pullAll() {
  pullingAll.value = true;
  try {
    const result = await axios.get('/api/v2/repository/');
    const repos = Array.isArray(result.data.records) ? result.data.records : [];
    for (const repo of repos) showRunning(repo.name, 'clone');
    const pulls = await Promise.allSettled(
      repos.map((repo) => axios.post(`/api/v2/repository/${encodeURIComponent(repo.name)}/clone`, {})),
    );
    const { pulled, skipped, failed } = sortPulls(repos, pulls);
    if (failed.length) toast.error(t('settings.repositories.pullAllFailed', { names: failed.join(', ') }));
    if (skipped.length) toast.warning(t('settings.repositories.pullAllSkipped', { names: skipped.join(', ') }));
    if (!failed.length && pulled.length) toast.success(t('settings.repositories.pullAllDone', pulled.length));
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err, t('settings.repositories.pullAll')));
  } finally {
    pullingAll.value = false;
    adminMulti.value?.loadItems();
  }
}
async function triggerSync(repo) {
  await runGit(repo, 'sync', t('settings.repositories.push'));
}
async function triggerReset(repo) {
  await runGit(repo, 'reset', t('settings.repositories.reset'));
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
});
</script>

<template>
  <AppSettingsPage>
    <AppAdminMulti
      v-if="authenticated"
      ref="adminMulti"
      :settings="repoSettings"
      :apiVersion="2"
      @trigger="triggerClone"
      @reset="triggerReset"
      @sync="triggerSync"
    >
      <template #actionsBefore>
        <BsButton icon="download" :disabled="pullingAll" @click="pullAll()">{{
          t('settings.repositories.pullAll')
        }}</BsButton>
      </template>
    </AppAdminMulti>
  </AppSettingsPage>
</template>
