/******************************************************************/
/*                                                                */
/*  The Jobs menu's counts (components/AppJobsSidebar.vue) : the  */
/*  jobs per status and the future ones (schedules, stored jobs,  */
/*  system tasks). Read once as the user enters the site (the     */
/*  header, components/AppNav.vue), so the menu has them when     */
/*  the jobs pages open ; kept with the menus' memory             */
/*  (lib/menuMemory.js), forgotten at logout.                     */
/*                                                                */
/******************************************************************/
import axios from 'axios';
import { mayOpen } from '@/lib/routePermission';
import { remembered } from '@/lib/menuMemory';

// the preload being read, shared while it is in flight
let preloading = null;

/**
 * The jobs counted last, for the menu's past and present badges : null until read.
 *
 * Returns:
 *   Ref: the jobs.
 */
export function lastJobs() {
  return remembered('jobs', null);
}

/**
 * The future badges' counts : undefined until read (a grey pill), null when they could not be
 * read or the user may not open their page.
 *
 * Returns:
 *   Ref: { schedules, stored, system }.
 */
export function futureCounts() {
  return remembered('jobsFuture', { schedules: undefined, stored: undefined, system: undefined });
}

/**
 * Reads how many schedules and stored jobs the user has, and how many maintenance tasks the app
 * runs, for the Future badges : only those the user may open (the same role options as their
 * pages). Each count is kept as soon as its own answer comes.
 *
 * Args:
 *   options (object): the user's role options.
 *
 * Returns:
 *   Promise<void>: settles once all three are read.
 */
export async function loadFutureCounts(options) {
  const counts = futureCounts();
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
  const show = (key, link, url) =>
    read(link, url).then((count) => {
      counts.value = { ...counts.value, [key]: count };
    });
  await Promise.all([
    show('schedules', '/jobs/scheduled', '/api/v2/schedule/'),
    show('stored', '/jobs/stored', '/api/v2/stored-jobs/'),
    show('system', '/jobs/system', '/api/v2/system/tasks'),
  ]);
}

/**
 * Reads the menu's counts as the user enters the site, when nothing was read yet for them : the
 * jobs (with showJobs) and the future counts. Once read, the menu keeps them fresh itself.
 *
 * Args:
 *   options (object): the user's role options ; nothing is read without them (not signed in).
 *
 * Returns:
 *   Promise<void>: settles once read.
 */
export function preloadJobsMenu(options) {
  if (!options) return Promise.resolve();
  if (preloading) return preloading;
  const jobs = lastJobs();
  const needJobs = !!options.showJobs && jobs.value == null;
  const needFuture = Object.values(futureCounts().value).some((v) => v === undefined);
  if (!needJobs && !needFuture) return Promise.resolve();
  preloading = Promise.all([
    needJobs &&
      axios
        .get('/api/v2/job')
        .then((result) => {
          // the menu's own read may have come first : it is the fresher
          if (jobs.value == null) jobs.value = result.data?.records || [];
        })
        .catch(() => {
          // a hint : the menu reads them itself when it opens
        }),
    needFuture && loadFutureCounts(options),
  ]).finally(() => {
    preloading = null;
  });
  return preloading;
}
