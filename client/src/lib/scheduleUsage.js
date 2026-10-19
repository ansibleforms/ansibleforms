/******************************************************************/
/*                                                                */
/*  The questions a repository's Schedules usage asks before it   */
/*  is saved, and what it says after : turned on, the app's       */
/*  recurring schedules go to the repository (how many, which     */
/*  crons stay in the app, git winning on a name) ; turned off or */
/*  the repository deleted, its schedules stay in the app,        */
/*  unlinked. Asked in the app's modal (askConfirm), from the     */
/*  repository's page and the repositories list.                  */
/*                                                                */
/******************************************************************/
import axios from 'axios';
import { toast } from 'vue-sonner';
import { askConfirm } from '@/lib/confirmPrompt';

/**
 * What the server says turning the usage on or off would do (GET .../schedules-preview).
 *
 * Args:
 *   name (string): the repository (one not made yet may be named too).
 *
 * Returns:
 *   Promise<object>: the preview ; {} when it cannot be read.
 */
async function preview(name) {
  try {
    const res = await axios.get(`/api/v2/repository/${encodeURIComponent(name || '-')}/schedules-preview`);
    return res.data || {};
  } catch {
    return {};
  }
}

/**
 * The paragraphs of the question asked before the usage is turned on.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   name (string): the repository.
 *   p (object): the preview.
 *
 * Returns:
 *   string[]: the paragraphs.
 */
export function activationLines(t, name, p) {
  const lines = [t('settings.repositories.schedulesOnWritten', { count: (p.written || []).length, name })];
  lines.push(
    (p.clashes || []).length
      ? t('settings.repositories.schedulesOnClashes', { names: p.clashes.join(', ') })
      : t('settings.repositories.schedulesOnGitWins'),
  );
  if ((p.kept || []).length) {
    lines.push(
      t('settings.repositories.schedulesOnKept', {
        names: p.kept.map((k) => (k.cron ? `${k.name} (${k.cron})` : k.name)).join(', '),
      }),
    );
  }
  lines.push(t('settings.repositories.schedulesOnPlanned'));
  lines.push(t('settings.repositories.schedulesOnAfter'));
  return lines;
}

/**
 * The paragraphs of the question asked before the usage is turned off, or the repository deleted.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   name (string): the repository.
 *   p (object): the preview.
 *
 * Returns:
 *   string[]: the paragraphs.
 */
export function deactivationLines(t, name, p) {
  const lines = [t('settings.repositories.schedulesOffKept', { count: p.linked ?? 0, name })];
  lines.push(t('settings.repositories.schedulesOffPull'));
  if (p.unpushed) lines.push(t('settings.repositories.schedulesOffUnpushed'));
  return lines;
}

/**
 * Asks before a repository's Schedules usage changes : turned on, what it will take ; turned off,
 * that its schedules stay in the app. A save that does not change it asks nothing.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   name (string): the repository.
 *   was (boolean): the usage as saved (false for a new repository).
 *   now (boolean): the usage to save.
 *
 * Returns:
 *   Promise<boolean>: true to save, false for Cancel.
 */
export async function confirmScheduleUsage(t, name, was, now) {
  if (!!was === !!now) return true;
  const p = await preview(name);
  if (now) {
    return askConfirm(t('settings.repositories.schedulesOnQuestion', { name }), {
      title: t('settings.repositories.schedulesOnTitle'),
      ok: t('settings.repositories.schedulesOnButton'),
      icon: 'clock',
      details: activationLines(t, name, p),
    });
  }
  return askConfirm(t('settings.repositories.schedulesOffQuestion', { name }), {
    title: t('settings.repositories.schedulesOffTitle'),
    ok: t('settings.repositories.schedulesOffButton'),
    icon: 'clock',
    details: deactivationLines(t, name, p),
  });
}

/**
 * Asks before a schedules repository is deleted : its schedules stay in the app.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   repo (object): the repository.
 *
 * Returns:
 *   Promise<boolean|null>: true to delete, false for Cancel ; null for a repository that holds no
 *     schedules (the usual question is asked).
 */
export async function confirmScheduleDelete(t, repo) {
  if (!repo?.use_for_schedules) return null;
  const p = await preview(repo.name);
  return askConfirm(`${t('settings.common.deleteConfirm')} ${repo.name}?`, {
    title: t('common.delete'),
    ok: t('common.delete'),
    icon: 'trash',
    details: deactivationLines(t, repo.name, p),
  });
}

/**
 * Says what turning the usage on or off did (the answer of the save or the delete), in a toast.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   data (object): the answer ({ schedules: { activated | deactivated | error } }).
 *
 * Returns:
 *   string: what was said ('' when the answer says nothing of the schedules).
 */
export function scheduleUsageToast(t, data) {
  const s = data?.schedules;
  if (!s) return '';
  let text = '';
  if (s.error) {
    text = t('settings.repositories.schedulesFailed', { error: s.error });
    toast.error(text);
    return text;
  }
  if (s.activated) {
    const a = s.activated;
    text = t('settings.repositories.schedulesOnDone', {
      written: (a.written || []).length,
      matched: (a.matched || []).length,
      kept: (a.kept || []).length,
    });
    if (a.pull && !['pulled', 'cloned'].includes(a.pull))
      text += ` ${t('settings.repositories.schedulesNotPulled', { reason: a.pull })}`;
  } else if (s.deactivated) {
    const d = s.deactivated;
    text = t('settings.repositories.schedulesOffDone', { count: d.unlinked ?? 0 });
    if (d.pull && d.pull !== 'pulled') text += ` ${t('settings.repositories.schedulesNotPulled', { reason: d.pull })}`;
  }
  if (text) toast.success(text, { duration: 10000 });
  return text;
}
