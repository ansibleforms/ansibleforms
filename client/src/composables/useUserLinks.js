/******************************************************************/
/*                                                                */
/*  useUserLinks : what a user has done and keeps, for the tabs   */
/*  of a user's page - a local user's and an LDAP or SSO user's   */
/*  alike, each named by its type and username :                  */
/*    Jobs         the jobs it launched, the latest first         */
/*    Stored jobs  the form values it stored (written type/name)  */
/*    Schedules    the jobs it planned with Run later (those that */
/*                 run as it) ; an admin's schedule is nobody's   */
/*    Activity     what the audit log recorded it doing           */
/*  and the columns of their tables (AppLinkedTable). Each read   */
/*  refused or failing leaves its tab empty.                      */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import axios from 'axios';
import { useI18n } from 'vue-i18n';
import Helpers from '@/lib/Helpers';
import { PILL, pill } from '@/lib/tableCells';
// a job's times as the jobs page shows them (the server sends them in its own zone)
import Time from '@/lib/Time';
import { durationSeconds, formatDuration } from '@/lib/jobTime';
import { cronCell } from '@/lib/cronCell';

// the latest jobs and audit entries a tab shows
const JOBS_SHOWN = 100;
const ACTIVITY_SHOWN = 100;
// the outcomes of the audit log, as its page names them
const OUTCOMES = { success: 'audit.outcomeSuccess', failure: 'audit.outcomeFailure', denied: 'audit.outcomeDenied' };
// each outcome's pill colour, as the audit log's ; one not known is grey, never a success's green
const OUTCOME_PILLS = { success: PILL.green, failure: PILL.red, denied: PILL.amber };

/**
 * The jobs, stored jobs, schedules and activity of a user.
 *
 * Args:
 *   who (Ref<object|null>): the user, { type, username } (type local, ldap, azuread, oidc) ;
 *     null while unknown.
 *
 * Returns:
 *   object: { jobs, storedJobs, schedules, activity, loadUserLinks, jobColumns,
 *     storedJobColumns, scheduleColumns, activityColumns }.
 */
export function useUserLinks(who) {
  const { t, te } = useI18n();
  const allJobs = ref([]);
  const allStoredJobs = ref([]);
  const allSchedules = ref([]);
  const activity = ref([]);

  // a multistep job's steps stay under their job
  const jobs = computed(() => allJobs.value.filter((j) => !j.parent_id));
  /**
   * The steps of a multistep job, in their order ; null for another job.
   *
   * Args:
   *   job (object): the job.
   *
   * Returns:
   *   object[]|null: its steps.
   */
  function stepsOf(job) {
    if (job.job_type !== 'multistep') return null;
    return allJobs.value.filter((j) => j.parent_id === job.id).sort((a, b) => a.id - b.id);
  }
  const storedJobs = computed(() =>
    who.value ? allStoredJobs.value.filter((j) => j.username === `${who.value.type}/${who.value.username}`) : [],
  );
  const schedules = computed(() => {
    if (!who.value) return [];
    return allSchedules.value.filter((s) => {
      try {
        const owner = s.owner ? JSON.parse(s.owner) : null;
        return owner?.type === who.value.type && owner.username === who.value.username;
      } catch {
        return false;
      }
    });
  });

  /**
   * Loads the user's jobs and activity, and every stored job and schedule (the tabs keep the
   * user's) ; call it once the user is known.
   */
  async function loadUserLinks() {
    if (!who.value?.username) return;
    const name = encodeURIComponent(who.value.username);
    const type = encodeURIComponent(who.value.type);
    const [j, a, sj, s] = await Promise.allSettled([
      axios.get(`/api/v2/job/?user=${name}&user_type=${type}&records=${JOBS_SHOWN}`),
      axios.get(`/api/v2/audit?actor=${name}&actorType=${type}&limit=${ACTIVITY_SHOWN}`),
      axios.get('/api/v2/stored-jobs/'),
      axios.get('/api/v2/schedule/'),
    ]);
    const records = (r) => (r.status === 'fulfilled' ? r.value.data.records || r.value.data || [] : []);
    allJobs.value = records(j);
    allStoredJobs.value = records(sj);
    allSchedules.value = records(s);
    const audit = a.status === 'fulfilled' ? a.value.data : null;
    activity.value = (audit?.records !== undefined ? audit : audit?.result)?.records || [];
  }

  // ─── the tables' columns ──────────────────────────────────────────────────
  // a one-time run's Schedule cell : it has no cron, it runs once (escaped : it goes to v-html)
  const oneTimeCell = computed(() =>
    t('settings.schedules.oneTimeRun').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );

  /**
   * When a schedule runs : a one-time run at its moment (one_time_run), a recurring one at its
   * cron's next time.
   *
   * Args:
   *   s (object): a schedule row, with one_time_run and next_run.
   *
   * Returns:
   *   string|null: the date, as the server sent it ; null when there is none.
   */
  function nextRunOf(s) {
    return s.one_time_run || s.next_run || null;
  }

  /**
   * An audit action in words, as the audit log shows it ; the stored action when it has none.
   *
   * Args:
   *   action (string): the stored action (settings.config.update).
   *
   * Returns:
   *   string: its label.
   */
  function actionLabel(action) {
    if (!action) return '';
    const key = 'audit.actionLabels.' + String(action).replace(/[.-]/g, '_');
    return te(key) ? t(key) : action;
  }

  const jobColumns = computed(() => [
    { key: 'id', label: t('settings.linked.job'), keep: true, class: 'text-end', value: (j) => `#${j.id}` },
    // a step : its own name, as the jobs list shows its steps under their job
    { key: 'form', label: t('settings.fields.form'), value: (j) => (j.parent_id ? j.target : j.form) },
    // its type, as the jobs list shows it (a job without one is a playbook's : ansible)
    { key: 'job_type', label: t('jobs.jobType'), keep: true, value: (j) => j.job_type || 'ansible' },
    { key: 'status', label: t('settings.linked.status'), keep: true },
    { key: 'start', label: t('jobs.startTime'), keep: true, value: (j) => j.start && Time.format(j.start) },
    { key: 'end', label: t('jobs.endTime'), keep: true, value: (j) => j.end && Time.format(j.end) },
    // how long it ran, as the jobs page says it (a running one : until the tab was loaded), to the
    // right as a number
    {
      key: 'duration',
      label: t('jobs.duration'),
      keep: true,
      class: 'text-end',
      value: (j) => formatDuration(durationSeconds(j)),
    },
  ]);
  const storedJobColumns = computed(() => [
    { key: 'name', label: t('settings.fields.name') },
    { key: 'form_name', label: t('settings.fields.form') },
    { key: 'description', label: t('settings.fields.description') },
    {
      key: 'expires_at',
      label: t('settings.fields.expiresAt'),
      // none : it never expires
      value: (j) => (j.expires_at ? Helpers.formatServerDate(j.expires_at) : t('settings.storedJobs.neverExpires')),
    },
  ]);
  const scheduleColumns = computed(() => [
    { key: 'name', label: t('settings.fields.name') },
    { key: 'form', label: t('settings.fields.form') },
    // how it runs : a recurring schedule's cron, its meaning on hover ; or once
    {
      key: 'cron',
      label: t('settings.schedules.stepSchedule'),
      class: 'text-nowrap',
      html: (s) => (s.one_time_run ? oneTimeCell.value : cronCell(s.cron)),
    },
    // when it runs : a one-time run its Run at, a recurring one its cron's next time
    {
      key: 'next_run',
      label: t('settings.schedules.nextRun'),
      value: (s) => nextRunOf(s) && Helpers.formatServerDate(nextRunOf(s)),
    },
  ]);
  const activityColumns = computed(() => [
    { key: 'created_at', label: t('audit.time'), value: (r) => Helpers.formatServerDate(r.created_at) },
    { key: 'action', label: t('audit.action'), value: (r) => actionLabel(r.action) },
    { key: 'target', label: t('audit.target') },
    {
      // a pill, as the audit log's : success green, failure red, denied amber ; its own words
      // for one not known (an own key only : 'constructor' is no outcome)
      key: 'outcome',
      label: t('audit.outcome'),
      keep: true,
      html: (r) => {
        const known = Object.hasOwn(OUTCOMES, r.outcome);
        return pill(
          known ? OUTCOME_PILLS[r.outcome] : PILL.grey,
          known ? t(OUTCOMES[r.outcome]) : String(r.outcome ?? ''),
        );
      },
    },
  ]);

  return {
    jobs,
    stepsOf,
    storedJobs,
    schedules,
    activity,
    loadUserLinks,
    jobColumns,
    storedJobColumns,
    scheduleColumns,
    activityColumns,
  };
}
