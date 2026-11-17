<script setup>
/******************************************************************/
/*                                                                */
/*  The jobs left menu                                            */
/*                                                                */
/*  Shown on the jobs list, the scheduled jobs, the stored jobs   */
/*  and the system tasks pages, so all of them keep the same menu */
/*  (the header's Jobs link covers them all).                     */
/*                                                                */
/*  @props:                                                       */
/*      jobs: Array - the jobs list's own jobs, for the counts.   */
/*            Given, this is the jobs list's menu : a status      */
/*            filters the list in place (select). Left out, the   */
/*            menu loads the jobs for its counts once, and a      */
/*            status opens the jobs list on it.                   */
/*      status: String - the status the list is filtered on       */
/*      loaded: Boolean - the jobs list's jobs are loaded (until  */
/*              then the counts of last time)                     */
/*                                                                */
/*  @emits:                                                       */
/*      select: a status was picked (null : every job)            */
/*                                                                */
/*  Every link carries the role option its page needs, the one    */
/*  its route's beforeEnter guard checks : the menu only shows    */
/*  what the router lets through (tests/sidebar-route-parity).    */
/*                                                                */
/******************************************************************/

import { useI18n } from 'vue-i18n';
import { jobsPath } from '@/lib/jobsPath';
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import axios from 'axios';
import { useAppStore } from '@/stores/app';
import { mayOpen } from '@/lib/routePermission';
import { remembered } from '@/lib/menuMemory';
import { useLiveEvent } from '@/composables/useLiveEvent';

// PROPS

const props = defineProps({
  jobs: { type: Array, default: null },
  status: { type: String, default: null },
  // the jobs list's jobs are loaded : until then the menu counts the jobs it counted last
  loaded: { type: Boolean, default: true },
});
const emit = defineEmits(['select']);

// INIT

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const store = useAppStore();

const can = (permission) => !!store.profile?.options?.[permission];

// DATA

// the jobs for the counts when the page is not the jobs list (scheduled, stored jobs)
const ownJobs = ref([]);
const ownLoaded = ref(false);
// the jobs counted last in this tab (lib/menuMemory.js) : the counts while the page's own jobs
// load, instead of zeros then the numbers
const lastJobs = remembered('jobs', null);
const pageJobs = computed(() => props.jobs ?? ownJobs.value);
const ready = computed(() => (props.jobs !== null ? props.loaded : ownLoaded.value));
const countedJobs = computed(() => (ready.value ? pageJobs.value : (lastJobs.value ?? pageJobs.value)));
// the counts known : the page's jobs read, or those counted last in this tab ; until then a grey
// pill in place of each count (a 0 would be false)
const countsKnown = computed(() => ready.value || lastJobs.value != null);
watch(
  [ready, pageJobs],
  () => {
    if (ready.value) lastJobs.value = pageJobs.value;
  },
  { immediate: true },
);

// the future jobs' counts : the schedules and the stored jobs the user may see, and the app's own
// maintenance tasks for an admin (undefined until read : a grey pill ; null when they could not be
// read : none ; then the count of last time while they are read again)
const futureCounts = remembered('jobsFuture', { schedules: undefined, stored: undefined, system: undefined });

// the statuses of the menu, with their names and icons, in the same order and with the
// same icons as the jobs list's page titles (pages/jobs.vue). The labels are spelled out,
// not built from the status, so the i18n key check can find them.
const MENU_STATUSES = {
  // what ran : ended one way or the other
  past: [
    { status: 'success', icon: 'check', label: () => t('jobs.menu.success') },
    { status: 'failed', icon: 'xmark', label: () => t('jobs.menu.failed') },
    { status: 'aborted', icon: 'ban', label: () => t('jobs.menu.aborted') },
    { status: 'rejected', icon: 'thumbs-down', label: () => t('jobs.menu.rejected') },
    { status: 'abandoned', icon: 'plug-circle-xmark', label: () => t('jobs.menu.abandoned') },
  ],
  // what is going on now : running, or waiting for someone's approval
  present: [
    { status: 'running', icon: 'play', label: () => t('jobs.menu.running') },
    { status: 'approve', icon: 'hourglass-half', label: () => t('jobs.menu.approve') },
  ],
};

// COMPUTED

const isJobsList = computed(() => props.jobs !== null);

// on the jobs list a status filters in place ; elsewhere it opens the jobs list on it
function pick(status) {
  if (isJobsList.value) emit('select', status);
  else router.push(jobsPath(status));
}

// the jobs in time : the past ones (ended), the present ones (running, waiting for an approval)
// and the future ones (on a schedule, or stored to be submitted again). Every job is at the
// header's Jobs link (/jobs/all).
const sections = computed(() => {
  const sections = [];
  if (can('showJobs')) {
    const all = countedJobs.value.filter((x) => !x.parent_id);
    const count = (status) => all.filter((x) => x.status === status).length;
    const items = (list) =>
      list.map((m) => ({
        title: m.label(),
        icon: m.icon,
        badge: countsKnown.value ? count(m.status) : null,
        badgeLoading: !countsKnown.value,
        // a job waiting for approval needs someone : its count stands out, in the orange of its status
        badgeAlert: countsKnown.value && m.status === 'approve' && count(m.status) > 0,
        active: isJobsList.value && props.status === m.status,
        action: () => pick(m.status),
      }));
    // in time's order : the past, the present, then the future below
    sections.push({ title: t('jobs.menu.past'), items: items(MENU_STATUSES.past) });
    sections.push({ title: t('jobs.menu.present'), items: items(MENU_STATUSES.present) });
  }
  // job states as the rest of the menu (the pages keep their own titles, Schedules and Stored jobs)
  const future = [
    {
      title: t('jobs.menu.scheduled'),
      icon: 'clock',
      link: '/jobs/scheduled',
      badge: futureCounts.value.schedules,
      badgeLoading: futureCounts.value.schedules === undefined,
    },
    {
      title: t('jobs.menu.stored'),
      icon: 'floppy-disk',
      link: '/jobs/stored',
      badge: futureCounts.value.stored,
      badgeLoading: futureCounts.value.stored === undefined,
    },
    // the app's own maintenance tasks (the job retention, the nightly backup ...) : an admin's,
    // as their route says (showSettings)
    {
      title: t('jobs.menu.system'),
      icon: 'gears',
      link: '/jobs/system',
      badge: futureCounts.value.system,
      badgeLoading: futureCounts.value.system === undefined,
    },
  ].filter((i) => mayOpen(i.link, store.profile?.options));
  if (future.length) sections.push({ title: t('jobs.menu.future'), items: future });
  return sections;
});

// METHODS

async function loadCounts() {
  if (isJobsList.value || !can('showJobs')) return;
  try {
    const result = await axios.get('/api/v2/job');
    ownJobs.value = result.data?.records || [];
  } catch (err) {
    // the counts are a hint : without them the menu still works
    ownJobs.value = [];
  } finally {
    ownLoaded.value = true;
  }
}

/**
 * Reads how many schedules and stored jobs the user has, and how many maintenance tasks the app
 * runs, for the Future badges : only those the user may open (the same role options as their
 * pages).
 */
async function loadFutureCounts() {
  const options = store.profile?.options;
  const read = async (link, url) => {
    if (!mayOpen(link, options)) return null;
    try {
      const result = await axios.get(url);
      return result.data?.count ?? result.data?.records?.length ?? null;
    } catch {
      // a hint : without it the menu still works
      return null;
    }
  };
  const [schedules, stored, system] = await Promise.all([
    read('/jobs/scheduled', '/api/v2/schedule/'),
    read('/jobs/stored', '/api/v2/stored-jobs/'),
    read('/jobs/system', '/api/v2/system/tasks'),
  ]);
  futureCounts.value = { schedules, stored, system };
}

// MOUNT

onMounted(loadCounts);
onMounted(loadFutureCounts);
// a schedule or a stored job added or deleted on its page : read again when the page changes
watch(() => route.path, loadFutureCounts);
// and again whenever the jobs change (lib/liveEvents.js) : the counts follow a job starting,
// ending, or waiting for approval
useLiveEvent('jobs', loadCounts);
</script>
<template>
  <BsSidebar :sections="sections" storageKey="af_jobs_sidebar_collapsed" />
</template>
