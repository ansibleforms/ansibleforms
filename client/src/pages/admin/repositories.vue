<script setup>
import axios from 'axios';
import { toast } from 'vue-sonner';
import Profile from '@/lib/Profile';
import getSettings from '@/config/settings';
import { useI18n } from 'vue-i18n';
import Helpers from '@/lib/Helpers';
import { sortPulls } from '@/lib/pullResults';
import { useAppStore } from '@/stores/app';
import { toPush, pullOrder } from '@/lib/repositoryUsage';

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
 * Runs a git action of a repository's row (Pull, Push, Reset) : its status shown as running
 * meanwhile, a refusal said in a toast (the server's own words), and the list read again
 * whatever the answer, so the row never stays on running.
 *
 * Args:
 *   repo (object): the repository's row.
 *   action (string): the api action ('clone', 'sync', 'reset').
 *   title (string): what the action is called, said when the server gives no reason.
 */
async function runGit(repo, action, title) {
  adminMulti.value.setItemProperty({ id: repo.name, key: 'status', value: 'running' });
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
// Pull all : every repository pulled (cloned when it is not there yet), as its own Pull does ; the
// ones holding objects one after the other in the objects' order (the credentials before what signs
// in with them : lib/repositoryUsage.js pullOrder), the others at once ; the ones that fail are named,
// and so are the ones skipped because their changes are not pushed yet (the server refuses their pull
// with a 409, the others still go)
const pullingAll = ref(false);
async function pullAll() {
  pullingAll.value = true;
  try {
    const result = await axios.get('/api/v2/repository/');
    const repos = Array.isArray(result.data.records) ? result.data.records : [];
    for (const repo of repos) adminMulti.value.setItemProperty({ id: repo.name, key: 'status', value: 'running' });
    const pull = (repo) => axios.post(`/api/v2/repository/${encodeURIComponent(repo.name)}/clone`, {});
    const [ordered, rest] = pullOrder(repos);
    // each outcome as Promise.allSettled gives it, in the order the repositories were pulled
    const settled = [];
    for (const repo of ordered) {
      settled.push(
        await pull(repo).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        ),
      );
    }
    settled.push(...(await Promise.allSettled(rest.map(pull))));
    const { pulled, skipped, failed } = sortPulls([...ordered, ...rest], settled);
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
// Push all, on the right of Pull all : every repository with changes not pushed yet pushed, as its
// own Push does, one after the other, the ones that fail named ; greyed while none has any (read
// from the list as shown : lib/repositoryUsage.js toPush)
const pushingAll = ref(false);
const pushable = computed(() => toPush(adminMulti.value?.itemList));
async function pushAll() {
  pushingAll.value = true;
  try {
    const repos = pushable.value;
    for (const repo of repos) adminMulti.value.setItemProperty({ id: repo.name, key: 'status', value: 'running' });
    // one after the other, as the designer's Push all (each a commit and a push of its own)
    const failed = [];
    for (const repo of repos) {
      await axios
        .post(`/api/v2/repository/${encodeURIComponent(repo.name)}/sync`, {})
        .catch(() => failed.push(repo.name));
    }
    const pushed = repos.length - failed.length;
    if (failed.length) toast.error(t('settings.repositories.pushAllFailed', { names: failed.join(', ') }));
    else if (pushed) toast.success(t('settings.repositories.pushAllDone', pushed));
  } finally {
    pushingAll.value = false;
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
        <BsButton icon="download" :disabled="pullingAll || pushingAll" @click="pullAll()">{{
          t('settings.repositories.pullAll')
        }}</BsButton>
        <!-- greyed while no repository has anything to push, why in the tooltip -->
        <BsButton
          icon="upload"
          :disabled="pushingAll || pullingAll || !pushable.length"
          :title="pushable.length ? null : t('settings.repositories.pushAllNone')"
          @click="pushAll()"
          >{{ t('settings.repositories.pushAll') }}</BsButton
        >
      </template>
    </AppAdminMulti>
  </AppSettingsPage>
</template>
