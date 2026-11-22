/******************************************************************/
/*                                                                */
/*  When something runs, said in plain language, for every table  */
/*  that shows a schedule : a cron ('0 2 * * *') or an iCal rrule */
/*  (DTSTART... RRULE:...) in words, in the app's language, the   */
/*  cron or rule itself on hover. Used by the schedules list's    */
/*  Schedule column (config/settings.js), a user's Schedules tab  */
/*  (composables/useUserLinks.js) and Jobs > System's Schedule    */
/*  column and page (lib/systemTasks.js). The popover itself      */
/*  opens with useCellPopovers.                                   */
/*                                                                */
/******************************************************************/
import i18n from '@/plugins/i18n';
import { describeCron } from '@/config/cronDescribe';
import { rruleToCron } from '@/config/rrule';

/**
 * Escapes a text for html : a cell's html goes to v-html.
 *
 * Args:
 *   s (string): the text.
 *
 * Returns:
 *   string: the text, & < > and " escaped.
 */
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Whether a schedule is an iCal rrule rather than a cron : it has its RRULE part.
 *
 * Args:
 *   value (string): the schedule.
 *
 * Returns:
 *   boolean: true for an rrule.
 */
export function isRrule(value) {
  return /(^|\s)RRULE:/i.test(String(value ?? ''));
}

/**
 * A schedule in words, in the app's language : a cron ('0 6 * * 0' is 'At 06:00 AM, only on
 * Sunday'), or an rrule through the cron that runs at the same times (config/rrule.js
 * rruleToCron : 'the last weekday of the month').
 *
 * Args:
 *   value (string): the cron or the rrule.
 *   locale (string): the language ; the app's by default.
 *
 * Returns:
 *   string: the words ; '' when it cannot be said (an invalid cron, an rrule no cron says).
 */
export function scheduleWords(value, locale = i18n.global.locale.value) {
  if (isRrule(value)) {
    const cron = rruleToCron(value);
    // built by the app, it may use what a typed cron may not (LW, 5L, 2#2)
    return cron ? describeCron(cron, locale, { built: true }) : '';
  }
  return describeCron(value, locale);
}

/**
 * A schedule in a table cell : its words, the cron or rule itself in a popover on hover ;
 * without words, the cron as it is, or the rule as code.
 *
 * Args:
 *   value (string): the cron or the rrule.
 *
 * Returns:
 *   string: the cell's HTML, escaped.
 */
export function scheduleCell(value) {
  const words = scheduleWords(value);
  if (words) return `<span class="af-has-popover" data-af-popover="${escapeHtml(value)}">${escapeHtml(words)}</span>`;
  if (isRrule(value)) return `<span class="font-monospace small">${escapeHtml(value)}</span>`;
  return escapeHtml(value);
}
