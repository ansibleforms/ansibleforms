/******************************************************************/
/*                                                                */
/*  Desktop notifications for the signed-in user's jobs : one     */
/*  when a job it launched ends (succeeded, failed, aborted...),  */
/*  one when a job waits for its approval. Turned on per browser  */
/*  in Profile > Preferences, after the browser's own permission. */
/*                                                                */
/*  It hears the jobs change on the live stream the header        */
/*  already follows (lib/liveEvents.js) and compares the user's   */
/*  jobs with what it saw before : nothing is polled, nothing is  */
/*  stored on the server. It works while an AnsibleForms tab is   */
/*  open, even in the background ; with every tab closed nothing  */
/*  is sent.                                                      */
/*                                                                */
/*  Every open tab hears the same change : a notification carries */
/*  a tag per job and status, so the browser shows it once. A job */
/*  waiting for an approval gets Approve and Reject buttons,      */
/*  through public/notifications-sw.js.                           */
/*                                                                */
/******************************************************************/
import axios from 'axios';
import { listen } from '@/lib/liveEvents';
import { durationSeconds, formatDuration } from '@/lib/jobTime';
import { toast } from 'vue-sonner';
import Helpers from '@/lib/Helpers';
import BaseUrl from '@/lib/BaseUrl';
import State from '@/lib/State';

// ─── the browser's choice ────────────────────────────────────────────────────

// on or off for this browser (Profile > Preferences)
const STORAGE_KEY = 'af_job_notifications';

// the statuses a job ends with : the jobs menu's Past
export const FINAL_STATUSES = ['success', 'warning', 'failed', 'aborted', 'rejected', 'abandoned'];

// how many of the user's newest jobs are compared : a job ending is one of its latest
const MINE_SHOWN = 25;
// how many of the newest jobs are searched for the ones waiting for its approval
const APPROVALS_SHOWN = 50;

/**
 * Whether this browser can show notifications here : the API is there and the page is secure
 * (browsers refuse notifications to a page served over plain http).
 *
 * Returns:
 *   boolean: true when it can.
 */
export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && !!window.isSecureContext;
}

/**
 * What the browser allows this site : 'granted', 'denied' or 'default' (not asked yet), or
 * 'unsupported' when it cannot show notifications here.
 *
 * Returns:
 *   string: the permission.
 */
export function notificationPermission() {
  return notificationsSupported() ? window.Notification.permission : 'unsupported';
}

/**
 * Whether the user turned the notifications on in this browser.
 *
 * Returns:
 *   boolean: true when turned on (the browser's permission aside).
 */
export function notificationsChosen() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remembers the choice in this browser.
 *
 * Args:
 *   on (boolean): true to turn them on.
 */
function saveChoice(on) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage refused (a private window) : the choice lasts as long as the page
  }
}

/**
 * Whether notifications are sent : turned on, and allowed by the browser.
 *
 * Returns:
 *   boolean: true when they are.
 */
export function notificationsActive() {
  return notificationsChosen() && notificationPermission() === 'granted';
}

/**
 * Turns the notifications on : the browser asks the user first, the first time. Refused, they
 * stay off.
 *
 * Returns:
 *   Promise<string>: the browser's answer ('granted', 'denied', 'default'), or 'unsupported'.
 */
export async function turnNotificationsOn() {
  if (!notificationsSupported()) return 'unsupported';
  let answer = window.Notification.permission;
  if (answer === 'default') answer = await window.Notification.requestPermission();
  saveChoice(answer === 'granted');
  if (answer === 'granted') registration();
  return answer;
}

/**
 * Turns the notifications off in this browser (the browser's permission stays as it is).
 */
export function turnNotificationsOff() {
  saveChoice(false);
  reset();
}

// ─── what was seen ───────────────────────────────────────────────────────────
// Kept for the page's lifetime, not per component : the header that hears the changes is
// mounted again on every page, and a job that ended meanwhile must still be told.

const seen = new Map(); // job id -> its status when last seen
let primed = false; // the first look only learns : jobs that ended before say nothing
let newestAtPrime = 0; // a job newer than this one appeared since : it was launched since

/**
 * Forgets what was seen : the next look learns again, telling nothing.
 */
function reset() {
  seen.clear();
  primed = false;
  newestAtPrime = 0;
}

// ─── deciding ────────────────────────────────────────────────────────────────

/**
 * A job's approval as an object : the list sends it as a JSON string, the job's page as an
 * object.
 *
 * Args:
 *   job (object): the job.
 *
 * Returns:
 *   object|null|false: the approval ; null when the job has none ; false when it cannot be read.
 */
function approvalOf(job) {
  if (!job?.approval) return null;
  if (typeof job.approval !== 'string') return job.approval;
  try {
    return JSON.parse(job.approval);
  } catch {
    return false;
  }
}

/**
 * Whether the job is the signed-in user's own : launched by that username with that login type.
 *
 * Args:
 *   job (object): the job, { user, user_type }.
 *   profile (object): the signed-in user, { username, type }.
 *
 * Returns:
 *   boolean: true for its own job.
 */
export function isOwnJob(job, profile) {
  return !!job?.user && job.user === profile?.username && (job.user_type || 'local') === (profile?.type || 'local');
}

/**
 * Whether the user may decide on a job waiting for approval at all, Reject included, as the jobs
 * page decides it (an admin any, else one of the roles the job's approval names ; none named,
 * anyone who sees it). The requester may always reject (withdraw) their own job.
 *
 * Args:
 *   job (object): the job, its approval a JSON string (the list) or an object.
 *   profile (object): the signed-in user, { roles }.
 *
 * Returns:
 *   boolean: true when it may.
 */
export function mayDecide(job, profile) {
  const roles = profile?.roles || [];
  if (roles.includes('admin')) return true;
  const approval = approvalOf(job);
  if (approval === null) return true;
  if (approval === false) return false;
  return (approval?.roles || []).some((role) => roles.includes(role));
}

/**
 * Whether the user may APPROVE a job : as mayDecide, and the four-eyes rule of the server
 * (server/src/models/job.model.js Job.approve) - who launched the job does not approve it
 * themselves, unless its approval allows it (allowSelf: true) or they are an admin. Offering
 * Approve there only led to the server refusing it.
 *
 * Args:
 *   job (object): the job, { approval, user, user_type }.
 *   profile (object): the signed-in user, { username, type, roles }.
 *
 * Returns:
 *   boolean: true when it may.
 */
export function mayApprove(job, profile) {
  if (!mayDecide(job, profile)) return false;
  if ((profile?.roles || []).includes('admin')) return true;
  if (!isOwnJob(job, profile)) return true;
  return approvalOf(job)?.allowSelf === true;
}

/**
 * What is new since the last look : the user's jobs that ended, the jobs that now wait for its
 * approval. The first look only learns.
 *
 * Args:
 *   mine (object[]): the user's newest jobs.
 *   waiting (object[]): the newest jobs that wait for an approval it may give.
 *   profile (object): the signed-in user, { username, type }.
 *
 * Returns:
 *   {ended: object[], approve: object[]}: the jobs to tell, each once.
 */
export function whatIsNew(mine, waiting, profile) {
  const ended = [];
  const approve = [];
  const isMine = (j) => j.user === profile?.username && (j.user_type || 'local') === (profile?.type || 'local');
  if (primed) {
    for (const j of mine) {
      // a multistep job's steps : its own job tells
      if (j.parent_id) continue;
      if (!FINAL_STATUSES.includes(j.status)) continue;
      const before = seen.get(j.id);
      // ended since the last look : seen going, or launched since and ended at once
      if (before ? !FINAL_STATUSES.includes(before) : j.id > newestAtPrime) ended.push(j);
    }
    for (const j of waiting) {
      // its own job waiting : it knows, it launched it
      if (j.status !== 'approve' || isMine(j)) continue;
      const before = seen.get(j.id);
      if (before ? before !== 'approve' : j.id > newestAtPrime) approve.push(j);
    }
  }
  for (const j of [...mine, ...waiting]) seen.set(j.id, j.status);
  if (!primed) newestAtPrime = Math.max(0, ...[...mine, ...waiting].map((j) => Number(j.id) || 0));
  primed = true;
  return { ended, approve };
}

// ─── telling ─────────────────────────────────────────────────────────────────

/**
 * The site's icon, for the notification : the one the page shows in its tab.
 *
 * Returns:
 *   string|undefined: its address.
 */
function siteIcon() {
  return document.querySelector('link[rel~="icon"]')?.href || undefined;
}

// ─── the service worker : notifications with buttons ─────────────────────────
// Shown through public/notifications-sw.js, a notification can carry buttons (Approve, Reject)
// where the browser shows them ; a click comes back here as a message, to the one tab the
// worker picked, which holds the sign-in and acts. Without a worker (a browser that has none, a
// refused registration) the notifications are plain ones, a click opening the job.

let ctxNow = null; // the translations, router and store of the header that follows the jobs
let worker = null; // the registration, once asked for (a promise)
let hearing = false; // the worker's messages heard once per page

/**
 * The worker's registration, registered once : null when there can be none.
 *
 * Returns:
 *   Promise<ServiceWorkerRegistration|null>: the registration, active.
 */
function registration() {
  if (worker) return worker;
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return Promise.resolve(null);
  worker = navigator.serviceWorker
    .register(`${BaseUrl}/notifications-sw.js`, { scope: `${BaseUrl}/` })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  return worker;
}

/**
 * Approves or rejects a job from its notification's button, as the jobs page does, and says
 * how it went : a toast for the tab, a notification for the user who is elsewhere.
 *
 * Args:
 *   decision (string): 'approve' or 'reject'.
 *   id (number): the job.
 *   form (string): its form, to name it.
 */
async function decide(decision, id, form) {
  const { t } = ctxNow;
  const name = form || t('profilePage.notificationsJob', { id });
  let message;
  let ok = false;
  try {
    const result = await axios.post(`/api/v2/job/${id}/${decision}`, {});
    ok = result.status === 200;
    message = result.data?.message || `${name}: ${t(decision === 'approve' ? 'jobs.approve' : 'jobs.reject')}`;
  } catch (err) {
    message = Helpers.parseAxiosResponseError(err) || t('jobs.alreadyDecided');
  }
  if (ok) toast.success(message);
  else toast.error(message);
  show({ title: name, body: message, tag: `af-job-${id}-decided` });
}

/**
 * Hears the worker's messages once : a click on a notification, its button or itself.
 */
function hearWorker() {
  if (hearing || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  hearing = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type !== 'af-job-notification' || !ctxNow) return;
    if (msg.decision === 'approve' || msg.decision === 'reject') decide(msg.decision, msg.id, msg.form);
    else if (msg.open) ctxNow.router.push(msg.open).catch(() => {});
  });
}

/**
 * Shows one notification : through the worker when there is one (with its buttons), else a
 * plain one ; a click brings the tab to the front, on the job.
 *
 * Args:
 *   n (object): { title, body, tag (one per job and status, so several tabs show it once),
 *     id, form (the job), open (its place in the app), actions (the buttons, [{ action, title }]) }.
 */
async function show({ title, body, tag, id, form, open, actions = [] }) {
  const icon = siteIcon();
  const reg = await registration();
  if (reg?.showNotification) {
    try {
      await reg.showNotification(title, {
        body,
        tag,
        icon,
        actions,
        data: { id, form, open, url: open ? `${window.location.origin}${BaseUrl}${open}` : undefined },
      });
      return;
    } catch {
      // the worker refused (no permission any more) : a plain one
    }
  }
  try {
    const n = new window.Notification(title, { body, tag, icon });
    n.onclick = () => {
      window.focus();
      if (open) ctxNow?.router.push(open).catch(() => {});
      n.close();
    };
  } catch {
    // a browser that shows notifications only from a service worker, and none here
  }
}

// a look under way, and whether a change was heard meanwhile : looks never overlap (two at once
// compared their jobs with the same `seen` and told a job twice, or each half of it), and a
// change heard during one is looked at once more right after it, not lost
let looking = false;
let lookAgain = false;

/**
 * Looks at the user's jobs, one look at a time : a change heard while a look runs asks for one
 * more look after it (however many changes were heard, one more is enough).
 *
 * Args:
 *   ctx (object): { t, router, store } - the translations, the router, the app store.
 */
async function lookOnce(ctx) {
  if (looking) {
    lookAgain = true;
    return;
  }
  looking = true;
  try {
    do {
      lookAgain = false;
      await look(ctx);
    } while (lookAgain);
  } finally {
    looking = false;
  }
}

/**
 * Looks at the user's jobs once and tells what is new.
 *
 * Args:
 *   ctx (object): { t, router, store } - the translations, the router, the app store.
 */
async function look({ t, router, store }) {
  if (!notificationsActive()) {
    reset();
    return;
  }
  const profile = store.profile;
  if (!profile?.username) return;
  const params = new URLSearchParams({
    records: String(MINE_SHOWN),
    user: profile.username,
    user_type: profile.type || 'local',
  });
  let mine;
  let waiting = [];
  try {
    mine = (await axios.get(`/api/v2/job?${params}`)).data?.records || [];
    // the jobs waiting for its approval : looked up only when there are some. The count is the
    // header bell's (State.refreshApprovals), read once for both on the same change
    const count = await State.refreshApprovals();
    if (count > 0) {
      const newest = (await axios.get(`/api/v2/job?records=${APPROVALS_SHOWN}`)).data?.records || [];
      waiting = newest.filter((j) => j.status === 'approve' && mayApprove(j, profile));
    }
  } catch {
    // signed out, no right to see jobs, or the server away : the next change looks again
    return;
  }
  const { ended, approve } = whatIsNew(mine, waiting, profile);
  const current = router.currentRoute.value.path;
  const name = (j) => j.form || j.target || t('profilePage.notificationsJob', { id: j.id });
  for (const j of ended) {
    // the user looks at that job : it sees it end
    if (document.visibilityState === 'visible' && current === `/jobs/${j.id}`) continue;
    const duration = formatDuration(durationSeconds(j));
    show({
      title: `${name(j)}: ${t(`jobs.menu.${j.status}`)}`,
      // a job that needs attention : why, under the job's number
      body: [t('profilePage.notificationsBody', { id: j.id, duration }), j.status_message].filter(Boolean).join('\n'),
      tag: `af-job-${j.id}-${j.status}`,
      id: j.id,
      form: j.form,
      open: `/jobs/${j.id}`,
    });
  }
  // a job waiting for its approval : Approve and Reject on the notification (where the browser
  // shows buttons ; Chrome and Edge show two), Open job when there is room, the notification
  // itself opening the approvals
  for (const j of approve) {
    show({
      title: `${name(j)}: ${t('jobs.menu.approve')}`,
      body: t('profilePage.notificationsApprovalBody', { id: j.id, user: j.user }),
      tag: `af-job-${j.id}-approve`,
      id: j.id,
      form: j.form,
      open: '/jobs/approval',
      actions: [
        { action: 'approve', title: t('jobs.approve') },
        { action: 'reject', title: t('jobs.reject') },
        { action: 'open', title: t('jobs.openJob') },
      ],
    });
  }
}

/**
 * Follows the user's jobs while the caller lives (the header, on every page) : a look now,
 * then one at each change of the jobs.
 *
 * Args:
 *   ctx (object): { t, router, store } - the translations, the router, the app store.
 *
 * Returns:
 *   function: stops following.
 */
export function followJobNotifications(ctx) {
  ctxNow = ctx;
  hearWorker();
  // the worker registered as soon as the notifications are on, so the first one has it
  if (notificationsActive()) registration();
  const run = () => lookOnce(ctx);
  run();
  return listen('jobs', run);
}

export default {
  notificationsSupported,
  notificationPermission,
  notificationsChosen,
  notificationsActive,
  turnNotificationsOn,
  turnNotificationsOff,
  followJobNotifications,
  whatIsNew,
  mayDecide,
  mayApprove,
  isOwnJob,
};
