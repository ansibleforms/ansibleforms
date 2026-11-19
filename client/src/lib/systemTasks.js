/******************************************************************/
/*                                                                */
/*  The app's own maintenance tasks (Jobs > System) in words : a  */
/*  task's name and description in the user's language, when it   */
/*  runs (its cron in words, or every so many seconds), and how   */
/*  long a run took. The list (config/settings.js system_tasks)   */
/*  and a task's page (pages/system-task.vue) say them alike.     */
/*                                                                */
/*  The server answers a task's name and description in English  */
/*  (server/src/lib/systemTasks.js) : they are said here from the */
/*  locales by the task's key, the server's words for a task the  */
/*  locales do not know yet.                                      */
/*                                                                */
/******************************************************************/
import i18n from '@/plugins/i18n';
import { scheduleWords, scheduleCell } from '@/lib/scheduleCell';
import { esc } from '@/lib/tableCells';
import { formatDuration } from '@/lib/jobTime';

/**
 * A text of a task from the locales, or the server's own when the locales have none.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   task (object): the task, as the API answers it ({ key, name, description }).
 *   field (string): name or description.
 *
 * Returns:
 *   string: the text.
 */
function taskText(t, task, field) {
  const path = `jobs.system.tasks.${task?.key}.${field}`;
  return task?.key && i18n.global.te(path) ? t(path) : String(task?.[field] ?? '');
}

/**
 * A task's name, in the user's language.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   task (object): the task ({ key, name }).
 *
 * Returns:
 *   string: its name.
 */
export function taskName(t, task) {
  return taskText(t, task, 'name');
}

/**
 * What a task does, in the user's language.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   task (object): the task ({ key, description }).
 *
 * Returns:
 *   string: its description.
 */
export function taskDescription(t, task) {
  return taskText(t, task, 'description');
}

/**
 * When a task runs, in words : its cron described (Every hour, At 02:30 AM, every day), every so
 * many seconds for a runner hub loop, or Off for one that does not run.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   task (object): the task ({ cron, interval_seconds, enabled }).
 *   locale (string): the user's language (the cron's words).
 *
 * Returns:
 *   string: when it runs ; its cron itself when it cannot be said in words.
 */
export function taskTiming(t, task, locale = i18n.global.locale.value) {
  if (task?.enabled === false) return t('jobs.system.off');
  if (task?.cron) return scheduleWords(task.cron, locale) || task.cron;
  if (task?.interval_seconds) return t('jobs.system.everySeconds', { n: task.interval_seconds });
  return '';
}

/**
 * When a task runs, as a table cell : its cron as every schedule's (lib/scheduleCell.js, the
 * words, the cron on hover) ; Off, or every so many seconds for a runner hub loop, as words.
 *
 * Args:
 *   t (function): the vue-i18n translate function.
 *   task (object): the task's row.
 *
 * Returns:
 *   string: the cell's HTML, escaped.
 */
export function taskTimingCell(t, task) {
  if (task?.cron && task?.enabled !== false) return scheduleCell(task.cron);
  return esc(taskTiming(t, task));
}

/**
 * How long a run took : in milliseconds under a second, else as the job tables say a duration
 * (6s, 2m 05s, 1h 02m 05s) ; an en dash when not known (a run still going).
 *
 * Args:
 *   ms (number|null): the run's duration, in milliseconds.
 *
 * Returns:
 *   string: the duration.
 */
export function runDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '–';
  const n = Math.max(0, Math.round(Number(ms)));
  return n < 1000 ? `${n} ms` : formatDuration(Math.round(n / 1000));
}

export default { taskName, taskDescription, taskTiming, taskTimingCell, runDuration };
