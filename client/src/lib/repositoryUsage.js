/******************************************************************/
/*                                                                */
/*  What a repository is used for : its usage types, one flag     */
/*  each (use_for_<type>), in five categories - the one list the  */
/*  Usage step (AppRepositoryUsage, in the repository's dialog    */
/*  and on its page) and the repositories list's Usage column     */
/*  read. And the one question asked before a save turns object   */
/*  types on or off (what each will take, or let go), the toast   */
/*  said after, and a linked object's Repository badge.           */
/*                                                                */
/*  The server keeps the same list (server/src/lib/repoObjects/   */
/*  types.js) : it refuses a second repository for a one-only     */
/*  type.                                                         */
/*                                                                */
/******************************************************************/
import axios from 'axios';
import { toast } from 'vue-sonner';
import { askConfirm } from '@/lib/confirmPrompt';
import { esc } from '@/lib/tableCells';

// ===========================================================================
// THE TYPES
// ===========================================================================

// the categories, in the order the Usage step shows them
export const USAGE_CATEGORIES = ['designer', 'system', 'appearance', 'access', 'connections'];

// every usage type, in its category's order :
//   key       the type (its label : settings.repositories.usageTypes.<key>, its hint : usageHints)
//   flag      the repository's column
//   category  its heading
//   objects   one object per file in its folder, kept in step both ways : turning it on or off
//             asks first (what it will take, or let go)
//   oneOnly   one repository at most : greyed on the others, with who has it
//   folder    its folder in the repository (an object type), or
//   file      its one file at the repository's root (a type the app has one of : chat.yaml)
export const USAGE_TYPES = [
  { key: 'forms', flag: 'use_for_forms', category: 'designer' },
  { key: 'inventories', flag: 'use_for_inventories', category: 'designer' },
  { key: 'playbooks', flag: 'use_for_playbooks', category: 'designer', oneOnly: true },
  { key: 'workflows', flag: 'use_for_workflows', category: 'designer' },
  {
    key: 'schedules',
    flag: 'use_for_schedules',
    category: 'designer',

    objects: true,
    oneOnly: true,
    folder: 'schedules',
  },
  {
    key: 'settings',
    flag: 'use_for_settings',
    category: 'system',
    objects: true,
    oneOnly: true,
    file: 'settings.yaml',
  },
  {
    key: 'branding',
    flag: 'use_for_branding',
    category: 'appearance',
    objects: true,
    oneOnly: true,
    file: 'branding.yaml',
  },
  {
    key: 'labels',
    flag: 'use_for_labels',
    category: 'appearance',

    objects: true,
    oneOnly: true,
    folder: 'labels',
  },
  {
    key: 'announcements',
    flag: 'use_for_announcements',
    category: 'appearance',

    objects: true,
    oneOnly: true,
    folder: 'announcements',
  },
  {
    key: 'disclaimer',
    flag: 'use_for_disclaimer',
    category: 'access',
    objects: true,
    oneOnly: true,
    folder: 'disclaimer',
  },
  { key: 'config', flag: 'use_for_config', category: 'access', oneOnly: true },
  { key: 'ldap', flag: 'use_for_ldap', category: 'access', objects: true, oneOnly: true, folder: 'ldap' },
  { key: 'sso', flag: 'use_for_sso', category: 'access', objects: true, oneOnly: true, folder: 'sso' },
  {
    key: 'credentials',
    flag: 'use_for_credentials',
    category: 'connections',

    objects: true,
    oneOnly: true,
    folder: 'credentials',
  },
  {
    key: 'secret_stores',
    flag: 'use_for_secret_stores',
    category: 'connections',

    objects: true,
    oneOnly: true,
    folder: 'secret-stores',
  },
  {
    key: 'runners',
    flag: 'use_for_runners',
    category: 'connections',

    objects: true,
    oneOnly: true,
    folder: 'runners',
  },
  {
    key: 'notification_channels',
    flag: 'use_for_notification_channels',
    category: 'connections',

    objects: true,
    oneOnly: true,
    folder: 'notification-channels',
  },
  { key: 'chat', flag: 'use_for_chat', category: 'connections', objects: true, oneOnly: true, file: 'chat.yaml' },
  {
    key: 'syslog',
    flag: 'use_for_syslog',
    category: 'connections',

    objects: true,
    oneOnly: true,
    folder: 'syslog',
  },
];

// every usage flag : what a repository's dialog and page edit and save
export const USAGE_FLAGS = USAGE_TYPES.map((u) => u.flag);

// the order the object types are read and asked about : the credentials first, then what signs
// in with them, then the others (the server's order)
export const APPLY_ORDER = [
  'credentials',
  'secret_stores',
  'runners',
  'sso',
  'ldap',
  'notification_channels',
  'syslog',
  'chat',
  'schedules',
  'disclaimer',
  'branding',
  'labels',
  'announcements',
  'settings',
];

// what a type's question adds of its own (the schedules : the one-time jobs stay in the app), and
// how it says what stays in the app (the schedules : the crons a rrule cannot express)
const TYPE_NOTES = { schedules: ['settings.repositories.schedulesOnPlanned'] };
const KEPT_KEY = { schedules: 'settings.repositories.schedulesOnKept' };

/**
 * A usage type by its key.
 *
 * Args:
 *   key (string): the type (credentials).
 *
 * Returns:
 *   object|undefined: the type.
 */
export const usageType = (key) => USAGE_TYPES.find((u) => u.key === key);

/**
 * A type's label, as the Usage step, the badges and the questions name it.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   key (string): the type.
 *
 * Returns:
 *   string: the label (Credentials).
 */
export const usageLabel = (t, key) => t(`settings.repositories.usageTypes.${key}`);

/**
 * A type's few grey words : what the repository holds for it.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   key (string): the type.
 *
 * Returns:
 *   string: the hint.
 */
export const usageHint = (t, key) => t(`settings.repositories.usageHints.${key}`);

/**
 * Whether a flag is on, whatever it is (true, 1, '1').
 *
 * Args:
 *   v (any): the flag.
 *
 * Returns:
 *   boolean: true when it is on.
 */
export const flagOn = (v) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * The types of a category, in their order.
 *
 * Args:
 *   category (string): the category.
 *
 * Returns:
 *   object[]: its types.
 */
export const typesOf = (category) => USAGE_TYPES.filter((u) => u.category === category);

/**
 * The fields the search of a repository's page matches on the Usage tab : each type's flag, its
 * label and its hint.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *
 * Returns:
 *   Array[]: [flag, label, hint] each.
 */
export const usageSearchFields = (t) => USAGE_TYPES.map((u) => [u.flag, usageLabel(t, u.key), usageHint(t, u.key)]);

// ===========================================================================
// WHO MAY TICK WHAT
// ===========================================================================

/**
 * The other repository that already has a one-only type, so this one cannot take it too.
 *
 * Args:
 *   type (object): the type.
 *   record (object): the repository being edited (its flags as edited, its id and name).
 *   others (object[]): the repositories as saved.
 *
 * Returns:
 *   string|null: that repository's name.
 */
export function takenBy(type, record, others) {
  if (!type.oneOnly || flagOn(record?.[type.flag])) return null;
  const other = (others || []).find(
    (r) =>
      flagOn(r[type.flag]) &&
      !(record?.id !== undefined && r.id === record.id) &&
      !(record?.name !== undefined && r.name === record.name),
  );
  return other ? other.name : null;
}

/**
 * Whether a type can be ticked or unticked on a repository : not another one's.
 *
 * Args:
 *   type (object): the type.
 *   record (object): the repository being edited.
 *   others (object[]): the repositories as saved.
 *
 * Returns:
 *   boolean: true when it can.
 */
export const available = (type, record, others) => !takenBy(type, record, others);

/**
 * The state of a category's box : ticked when every type that can be ticked is, half when some
 * are, and whether it can be used at all.
 *
 * Args:
 *   category (string): the category.
 *   record (object): the repository being edited.
 *   others (object[]): the repositories as saved.
 *
 * Returns:
 *   object: { checked, indeterminate, disabled }.
 */
export function categoryState(category, record, others) {
  const list = typesOf(category).filter((u) => available(u, record, others));
  const on = list.filter((u) => flagOn(record?.[u.flag])).length;
  return {
    checked: !!list.length && on === list.length,
    indeterminate: on > 0 && on < list.length,
    disabled: !list.length,
  };
}

/**
 * Ticks or unticks every type of a category that can be : the ones another repository uses are
 * left as they are.
 *
 * Args:
 *   category (string): the category.
 *   record (object): the repository being edited (changed in place).
 *   others (object[]): the repositories as saved.
 *   on (boolean): tick, or untick.
 */
export function setCategory(category, record, others, on) {
  for (const u of typesOf(category)) if (available(u, record, others)) record[u.flag] = on;
}

// ===========================================================================
// THE LIST : ITS USAGE COLUMN
// ===========================================================================

/**
 * The types a repository is used for, in their order.
 *
 * Args:
 *   row (object): the repository.
 *
 * Returns:
 *   object[]: the types.
 */
export const usedFor = (row) => USAGE_TYPES.filter((u) => flagOn(row?.[u.flag]));

/**
 * A repository's Usage cell : a small badge per type it is used for, labelled with the type's
 * name (escaped), in the shape of the other row badges.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   row (object): the repository.
 *
 * Returns:
 *   string: the badges' HTML ('' for none : the table shows its en dash).
 */
export function usageBadges(t, row) {
  return usedFor(row)
    .map((u) => `<span class="badge af-usage-badge me-1">${esc(usageLabel(t, u.key))}</span>`)
    .join('');
}

/**
 * A repository's Usage, to sort its column : its types' labels in order (one used for nothing
 * last).
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   row (object): the repository.
 *
 * Returns:
 *   string: the sort value.
 */
export const usageSortValue = (t, row) =>
  usedFor(row)
    .map((u) => usageLabel(t, u.key))
    .join(', ') || '￿';

/**
 * The repositories in the order Pull all pulls them : those that hold objects first, in the
 * object types' order (the credentials before what signs in with them), one after the other ;
 * the others after them.
 *
 * Args:
 *   repos (object[]): the repositories.
 *
 * Returns:
 *   object[][]: [the ones pulled one after the other, the ones pulled at once].
 */
export function pullOrder(repos) {
  const rank = (r) => {
    const i = APPLY_ORDER.findIndex((key) => flagOn(r[usageType(key).flag]));
    return i < 0 ? Infinity : i;
  };
  const ordered = repos.filter((r) => rank(r) !== Infinity).sort((a, b) => rank(a) - rank(b));
  return [ordered, repos.filter((r) => rank(r) === Infinity)];
}

// ===========================================================================
// THE QUESTION BEFORE A SAVE
// ===========================================================================

/**
 * The object types a save turns on and off, in their order.
 *
 * Args:
 *   was (object|null): the repository as saved (null for a new one).
 *   now (object): the repository to save.
 *
 * Returns:
 *   object: { on: [key], off: [key] }.
 */
export function usageChanges(was, now) {
  const on = [];
  const off = [];
  for (const key of APPLY_ORDER) {
    const u = usageType(key);
    const before = flagOn(was?.[u.flag]);
    const after = flagOn(now?.[u.flag]);
    if (after && !before) on.push(key);
    else if (before && !after) off.push(key);
  }
  return { on, off };
}

/**
 * What the server says turning the types on or off would do (GET .../usage-preview).
 *
 * Args:
 *   name (string): the repository (one not made yet may be named too).
 *   keys (string[]): the types.
 *
 * Returns:
 *   Promise<object>: { unpushed, types: { <type>: preview } } ; empty when it cannot be read.
 */
async function preview(name, keys) {
  try {
    const res = await axios.get(
      `/api/v2/repository/${encodeURIComponent(name || '-')}/usage-preview?types=${keys.join(',')}`,
    );
    return { unpushed: !!res.data?.unpushed, types: res.data?.types || {} };
  } catch {
    return { unpushed: false, types: {} };
  }
}

/**
 * Why an object stays in the app, as the question says it.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   k (object): what the server kept ({ name, code, reason, cron }).
 *
 * Returns:
 *   string: its name and why (a cron's, its cron).
 */
function keptText(t, k) {
  if (k.cron) return `${k.name} (${k.cron})`;
  const why = k.code ? t(`settings.repositories.usageKeptWhy.${k.code}`) : k.reason;
  return why ? `${k.name} (${why})` : k.name;
}

/**
 * The paragraphs of what turning a type on will do : how many objects go to git, git winning on a
 * name, what stays in the app and those whose secrets stay in the database.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   key (string): the type.
 *   name (string): the repository.
 *   p (object): the type's preview.
 *
 * Returns:
 *   string[]: the paragraphs.
 */
export function activationLines(t, key, name, p) {
  const type = usageLabel(t, key);
  const { file, folder } = usageType(key) || {};
  // a type the app has one of : written as its one file, when the repository has none yet
  const lines = file
    ? [
        t(`settings.repositories.${(p.written || []).length ? 'usageOnWrittenFile' : 'usageOnReadFile'}`, {
          type,
          name,
          file,
        }),
      ]
    : [
        t('settings.repositories.usageOnWritten', {
          type,
          name,
          folder: folder || key,
          count: (p.written || []).length,
        }),
      ];
  lines.push(
    (p.clashes || []).length
      ? t('settings.repositories.usageOnClashes', { names: p.clashes.join(', ') })
      : t('settings.repositories.usageOnGitWins'),
  );
  if ((p.kept || []).length) {
    const names = p.kept.map((k) => keptText(t, k)).join(', ');
    lines.push(t(KEPT_KEY[key] || 'settings.repositories.usageOnKept', { names }));
  }
  if ((p.withoutSecret || []).length) {
    lines.push(t('settings.repositories.usageOnWithoutSecret', { names: p.withoutSecret.join(', ') }));
  }
  // files the type does not import (announcements already ended) : how many
  if (p.skipped) lines.push(t('settings.repositories.usageOnSkipped', { count: p.skipped }));
  for (const note of TYPE_NOTES[key] || []) lines.push(t(note));
  return lines;
}

/**
 * The paragraph of what turning a type off will do : its objects stay in the app, unlinked.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   key (string): the type.
 *   p (object): the type's preview.
 *
 * Returns:
 *   string[]: the paragraphs.
 */
export function deactivationLines(t, key, p) {
  return [t('settings.repositories.usageOffKept', { type: usageLabel(t, key), count: p.linked ?? 0 })];
}

/**
 * The question asked before a save turns object types on or off, or before the repository is
 * deleted : one type shows its own effects, several a section each under its heading ; what is
 * true of them all (what follows, the pull before letting go, the changes not pushed yet) once,
 * at the end.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   name (string): the repository.
 *   changes (object): { on: [key], off: [key] }.
 *   pv (object): the preview ({ unpushed, types }).
 *
 * Returns:
 *   object: { details (the paragraphs, a heading as { heading }), single (the one type changed,
 *     or null) }.
 */
export function usageQuestion(t, name, changes, pv) {
  const single = changes.on.length + changes.off.length === 1;
  const details = [];
  for (const key of changes.on) {
    if (!single) details.push({ heading: t('settings.repositories.usageOnHeading', { type: usageLabel(t, key) }) });
    details.push(...activationLines(t, key, name, pv.types[key] || {}));
  }
  for (const key of changes.off) {
    if (!single) details.push({ heading: t('settings.repositories.usageOffHeading', { type: usageLabel(t, key) }) });
    details.push(...deactivationLines(t, key, pv.types[key] || {}));
  }
  // what is true of every type turned on, and of every type turned off : said once
  if (changes.on.length) details.push(t('settings.repositories.usageOnAfter'));
  if (changes.off.length) {
    details.push(t('settings.repositories.usageOffPull'));
    if (pv.unpushed) details.push(t('settings.repositories.usageOffUnpushed'));
  }
  return { details, single: single ? changes.on[0] || changes.off[0] : null };
}

/**
 * Asks before a save turns object types on or off : one type, its own question ; several, one
 * question with a section each ; Cancel saves nothing. A save that changes none asks nothing.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   name (string): the repository.
 *   was (object|null): the repository as saved (null for a new one).
 *   now (object): the repository to save.
 *
 * Returns:
 *   Promise<boolean>: true to save, false for Cancel.
 */
export async function confirmUsageChange(t, name, was, now) {
  const changes = usageChanges(was, now);
  if (!changes.on.length && !changes.off.length) return true;
  const pv = await preview(name, [...changes.on, ...changes.off]);
  const { details, single } = usageQuestion(t, name, changes, pv);
  if (single) {
    const on = changes.on.length === 1;
    const type = usageLabel(t, single);
    return askConfirm(t(`settings.repositories.${on ? 'usageOnQuestion' : 'usageOffQuestion'}`, { name, type }), {
      title: t(`settings.repositories.${on ? 'usageOnTitle' : 'usageOffTitle'}`, { type }),
      ok: t(`settings.repositories.${on ? 'usageOnButton' : 'usageOffButton'}`),
      icon: 'list-check',
      details,
    });
  }
  return askConfirm(t('settings.repositories.usageChangeQuestion', { name }), {
    title: t('settings.repositories.usageChangeTitle'),
    ok: t('settings.repositories.usageChangeButton'),
    icon: 'list-check',
    details,
  });
}

/**
 * Asks before a repository holding objects is deleted : its objects stay in the app.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   repo (object): the repository.
 *
 * Returns:
 *   Promise<boolean|null>: true to delete, false for Cancel ; null for a repository that holds no
 *     objects (the usual question is asked).
 */
export async function confirmUsageDelete(t, repo) {
  const { off } = usageChanges(repo, {});
  if (!off.length) return null;
  const pv = await preview(repo.name, off);
  const changes = { on: [], off };
  return askConfirm(`${t('settings.common.deleteConfirm')} ${repo.name}?`, {
    title: t('common.delete'),
    ok: t('common.delete'),
    icon: 'trash',
    details: usageQuestion(t, repo.name, changes, pv).details,
  });
}

/**
 * Says what turning the types on or off did (the answer of the save or the delete), in a toast.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   data (object): the answer, by type ({ <type>: { activated | deactivated | error } }).
 *
 * Returns:
 *   string: what was said ('' when the answer says nothing of the object types).
 */
export function usageToast(t, data) {
  const lines = [];
  let failed = false;
  for (const key of APPLY_ORDER) {
    const s = data?.[key];
    if (!s) continue;
    const type = usageLabel(t, key);
    if (s.error) {
      failed = true;
      lines.push(t('settings.repositories.usageFailed', { type, error: s.error }));
      continue;
    }
    let text = '';
    if (s.activated) {
      const a = s.activated;
      text = t('settings.repositories.usageOnDone', {
        type,
        written: (a.written || []).length,
        matched: (a.matched || []).length,
        kept: (a.kept || []).length,
      });
      if (a.pull && !['pulled', 'cloned'].includes(a.pull))
        text += ` ${t('settings.repositories.usageNotPulled', { reason: a.pull })}`;
    } else if (s.deactivated) {
      const d = s.deactivated;
      text = t('settings.repositories.usageOffDone', { type, count: d.unlinked ?? 0 });
      if (d.pull && d.pull !== 'pulled') text += ` ${t('settings.repositories.usageNotPulled', { reason: d.pull })}`;
    }
    if (text) lines.push(text);
  }
  const text = lines.join(' ');
  if (!text) return '';
  if (failed) toast.error(text);
  else toast.success(text, { duration: 10000 });
  return text;
}

// ===========================================================================
// A LINKED OBJECT : ITS REPOSITORY
// ===========================================================================

/**
 * Where an object comes from, as a badge : the repository it is kept in (its file in the
 * tooltip) ; nothing for one kept in the app only.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   row (object): the object ({ repository, repo_file }).
 *
 * Returns:
 *   string: the badge's HTML, '' for none.
 */
export function repositoryBadge(t, row) {
  if (!row?.repository) return '';
  return `<span class="badge af-source-badge" title="${esc(row.repo_file)}">${esc(
    t('settings.repositories.sourceRepository', { name: row.repository }),
  )}</span>`;
}

/**
 * The Source field of an object's page, for its search : found by its label, its repository and
 * its file ; none for an object kept in the app only (no Source on its page).
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   row (object): the object ({ repository, repo_file }).
 *
 * Returns:
 *   Array[]: [['source', label, the badge's text, the file]], or [] (spread into a tab's fields).
 */
export function repositorySourceFields(t, row) {
  if (!row?.repository) return [];
  return [
    [
      'source',
      t('settings.repositories.source'),
      t('settings.repositories.sourceRepository', { name: row.repository }),
      row.repo_file,
    ],
  ];
}

/**
 * Where a type kept in one file is (the chat's, the settings', the branding's) : the repository
 * used for it and its file, as a record of a repository says it ; none when no repository holds it.
 *
 * Args:
 *   key (string): the type.
 *
 * Returns:
 *   Promise<object|null>: { repository, repo_file }, or null.
 */
export async function singleTypeSource(key) {
  const type = usageType(key);
  if (!type?.file) return null;
  try {
    const res = await axios.get('/api/v2/repository/');
    const repo = (res.data?.records || []).find((r) => flagOn(r[type.flag]));
    return repo ? { repository: repo.name, repo_file: type.file } : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// WHAT PUSH ALL PUSHES
// ===========================================================================

/**
 * The repositories Push all pushes : the ones with changes not pushed yet, as a row's own Push is
 * enabled for (config/settings.js). None : the button stays greyed.
 *
 * Args:
 *   repos (object[]): the repositories, as the list shows them.
 *
 * Returns:
 *   object[]: the repositories to push.
 */
export const toPush = (repos) => (Array.isArray(repos) ? repos : []).filter((r) => !!r?.unpushed);
