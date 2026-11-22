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
export const USAGE_CATEGORIES = ['designer', 'jobs', 'system', 'appearance', 'access', 'connections'];

// every usage type, in its category's order :
//   key       the type (its label : settings.repositories.usageTypes.<key>, its hint : usageHints)
//   flag      the repository's column
//   category  its heading
//   objects   kept in step both ways, read from the entries its key gives in any YAML file of the
//             repository (credentials:) : turning it on or off asks first (what it will take, or
//             let go)
//   oneOnly   one repository at most : greyed on the others, with who has it
//   single    the app has one of it : one map under its key (chat_assistant:), in one file at most
//   labelKey  its label's translation when it is its menu item's (settings.repositories.usageTypes.<key>
//             when not given)
export const USAGE_TYPES = [
  // the base configuration's keys : each from the file giving it (roles:, categories:, constants: ;
  // config.yaml still read, deprecated), named as their menu items name them
  {
    key: 'categories',
    flag: 'use_for_categories',
    category: 'designer',
    labelKey: 'sidebar.categories',
    oneOnly: true,
  },
  {
    key: 'constants',
    flag: 'use_for_constants',
    category: 'designer',
    labelKey: 'sidebar.constants',
    oneOnly: true,
  },
  { key: 'forms', flag: 'use_for_forms', category: 'designer' },
  { key: 'inventories', flag: 'use_for_inventories', category: 'designer' },
  // several : a form runs the first one's playbooks, or names its own (playbookRepository)
  { key: 'playbooks', flag: 'use_for_playbooks', category: 'designer' },
  { key: 'workflows', flag: 'use_for_workflows', category: 'designer' },
  {
    key: 'schedules',
    flag: 'use_for_schedules',
    category: 'jobs',

    objects: true,
    oneOnly: true,
  },
  // named as its menu item names it (System > General)
  {
    key: 'general',
    flag: 'use_for_general',
    category: 'system',
    labelKey: 'sidebar.ansibleForms',
    objects: true,
    oneOnly: true,
    single: true,
  },
  // the Appearance pages, one key each holding what its page saves, in the menu's order, each
  // named as its menu item names it (Defaults, Logo, Icon, Name)
  {
    key: 'defaults',
    flag: 'use_for_defaults',
    category: 'appearance',
    labelKey: 'sidebar.defaults',
    objects: true,
    oneOnly: true,
    single: true,
  },
  {
    key: 'logo',
    flag: 'use_for_logo',
    category: 'appearance',
    labelKey: 'sidebar.logo',
    objects: true,
    oneOnly: true,
    single: true,
  },
  {
    key: 'icon',
    flag: 'use_for_icon',
    category: 'appearance',
    labelKey: 'sidebar.icon',
    objects: true,
    oneOnly: true,
    single: true,
  },
  {
    key: 'name',
    flag: 'use_for_name',
    category: 'appearance',
    labelKey: 'sidebar.name',
    objects: true,
    oneOnly: true,
    single: true,
  },
  // named as its menu item names it (Links)
  {
    key: 'links',
    flag: 'use_for_links',
    category: 'appearance',
    labelKey: 'sidebar.links',
    objects: true,
    oneOnly: true,
    single: true,
  },
  {
    key: 'labels',
    flag: 'use_for_labels',
    category: 'appearance',

    objects: true,
    oneOnly: true,
  },
  {
    key: 'announcements',
    flag: 'use_for_announcements',
    category: 'appearance',

    objects: true,
    oneOnly: true,
  },
  {
    key: 'disclaimer',
    flag: 'use_for_disclaimer',
    category: 'access',
    objects: true,
    oneOnly: true,
  },
  // the users (local and of a directory) and the local groups holding their members, named as
  // their menu items name them, in the menu's order
  {
    key: 'users',
    flag: 'use_for_users',
    category: 'access',
    labelKey: 'sidebar.users',
    objects: true,
    oneOnly: true,
  },
  {
    key: 'groups',
    flag: 'use_for_groups',
    category: 'access',
    labelKey: 'sidebar.groups',
    objects: true,
    oneOnly: true,
  },
  {
    key: 'roles',
    flag: 'use_for_roles',
    category: 'access',
    labelKey: 'sidebar.roles',
    oneOnly: true,
  },
  { key: 'ldap', flag: 'use_for_ldap', category: 'access', objects: true, oneOnly: true },
  { key: 'sso', flag: 'use_for_sso', category: 'access', objects: true, oneOnly: true },
  // the other repositories, the entries of its repositories: lists, named as its menu item names it
  {
    key: 'repositories',
    flag: 'use_for_repositories',
    category: 'connections',
    labelKey: 'sidebar.repositories',
    objects: true,
    oneOnly: true,
  },
  {
    key: 'credentials',
    flag: 'use_for_credentials',
    category: 'connections',

    objects: true,
    oneOnly: true,
  },
  {
    key: 'secret_stores',
    flag: 'use_for_secret_stores',
    category: 'connections',

    objects: true,
    oneOnly: true,
  },
  // the databases forms query, named as its menu item names it (Databases)
  {
    key: 'databases',
    flag: 'use_for_databases',
    category: 'connections',
    labelKey: 'sidebar.databases',
    objects: true,
    oneOnly: true,
  },
  {
    key: 'runners',
    flag: 'use_for_runners',
    category: 'connections',

    objects: true,
    oneOnly: true,
  },
  // named as its menu item names it (SSH) : the key and the known hosts, one map
  {
    key: 'ssh',
    flag: 'use_for_ssh',
    category: 'connections',
    labelKey: 'sidebar.ssh',
    objects: true,
    oneOnly: true,
    single: true,
  },
  {
    key: 'notifications',
    flag: 'use_for_notifications',
    category: 'connections',
    // named as its menu item names it (Notifications)
    labelKey: 'sidebar.notifications',
    objects: true,
    oneOnly: true,
  },
  // named as its menu item names it (Chat assistant)
  {
    key: 'chat_assistant',
    flag: 'use_for_chat_assistant',
    category: 'connections',
    labelKey: 'sidebar.chat',
    objects: true,
    oneOnly: true,
    single: true,
  },
  // named as its menu item names it (MCP)
  {
    key: 'mcp',
    flag: 'use_for_mcp',
    category: 'connections',
    labelKey: 'sidebar.mcp',
    objects: true,
    oneOnly: true,
    single: true,
  },
  {
    key: 'syslog',
    flag: 'use_for_syslog',
    category: 'connections',

    objects: true,
    oneOnly: true,
  },
];

// every usage flag : what a repository's dialog and page edit and save
export const USAGE_FLAGS = USAGE_TYPES.map((u) => u.flag);

// the order the object types are read and asked about : the credentials first, then what signs
// in or connects with them, then the others (the server's order)
export const APPLY_ORDER = [
  'credentials',
  'repositories',
  // the SSH key and known hosts right after : the repositories are cloned once the pass is done
  'ssh',
  'secret_stores',
  'databases',
  'runners',
  'sso',
  'ldap',
  // the groups before the users : a new local user is put in the groups whose entries list it
  'groups',
  'users',
  'notifications',
  'syslog',
  'chat_assistant',
  'schedules',
  'disclaimer',
  'defaults',
  'logo',
  'icon',
  'name',
  'links',
  'labels',
  'announcements',
  'general',
  'mcp',
];

// what a type's question adds of its own (the schedules : the jobs users planned stay in the app)
const TYPE_NOTES = { schedules: ['settings.repositories.schedulesOnPlanned'] };

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
export const usageLabel = (t, key) => t(usageType(key)?.labelKey || `settings.repositories.usageTypes.${key}`);

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
// WHAT A REPOSITORY IS USED FOR, PULL ALL'S ORDER AND WHAT PUSH ALL PUSHES
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

/**
 * The repositories Push all pushes : the ones the app writes to (a usage on) with changes not
 * pushed yet, as a row's own Push is enabled for. None : the button stays greyed.
 *
 * Args:
 *   repos (object[]): the repositories, as the list shows them.
 *
 * Returns:
 *   object[]: the repositories to push.
 */
export const toPush = (repos) =>
  (Array.isArray(repos) ? repos : []).filter((r) => !!r?.unpushed && usedFor(r).length > 0);

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
 *   Promise<object>: { unpushed, types: { <type>: preview } } ; { failed: true } and no types when
 *     it cannot be read.
 */
async function preview(name, keys) {
  try {
    const res = await axios.get(
      `/api/v2/repository/${encodeURIComponent(name || '-')}/usage-preview?types=${keys.join(',')}`,
    );
    return { unpushed: !!res.data?.unpushed, types: res.data?.types || {} };
  } catch {
    // not read : the question says so, rather than counts of nothing
    return { unpushed: false, types: {}, failed: true };
  }
}

/**
 * Why an object stays in the app, as the question says it : by the code of why, in the app's
 * language (the server's English reason only for one without a code).
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   k (object): what the server kept ({ name, code, reason, error, whole (the type's one object :
 *     the chat assistant's settings, named by the type) }).
 *   key (string): the type.
 *
 * Returns:
 *   string: its name and why.
 */
function keptText(t, k, key) {
  const name = k.whole ? usageLabel(t, key) : k.name;
  const why = k.code
    ? t(`settings.repositories.usageKeptWhy.${k.code}`, k.error ? { error: k.error } : undefined)
    : k.reason;
  return why ? `${name} (${why})` : name;
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
  const { single } = usageType(key) || {};
  const count = (p.written || []).length;
  // the file its objects go to : the first giving the type's key, else <key>.yaml (the preview's)
  const file = p.file || `${key}.yaml`;
  // a type the app has one of : written to that file when no file gives it yet, else that file
  // read ; another : its objects written as entries of that file
  let lines;
  // a type the app has one of, which the config seed holds whole (nothing written) and the
  // repository has no file of : its kept line says it
  if (single && !count && !p.files && (p.kept || []).some((k) => k.whole)) lines = [];
  else if (single)
    lines = [t(`settings.repositories.${count ? 'usageOnWrittenFile' : 'usageOnReadFile'}`, { type, name, file })];
  else lines = [t('settings.repositories.usageOnWrittenList', { type, name, file, count })];
  // what its files give, read in by the turn-on : each file with its objects' names
  if (!single && (p.readIn || []).length) {
    const files = p.readIn.map((f) => `${f.file} (${(f.names || []).join(', ')})`).join('; ');
    lines.push(t('settings.repositories.usageOnReadIn', { files }));
  }
  lines.push(
    (p.clashes || []).length
      ? t('settings.repositories.usageOnClashes', { names: p.clashes.join(', ') })
      : t('settings.repositories.usageOnGitWins'),
  );
  // what stays in the app, each with why, in one sentence
  if ((p.kept || []).length) {
    lines.push(t('settings.repositories.usageOnKept', { names: p.kept.map((k) => keptText(t, k, key)).join(', ') }));
  }
  if ((p.withoutSecret || []).length) {
    lines.push(t('settings.repositories.usageOnWithoutSecret', { names: p.withoutSecret.join(', ') }));
  }
  // what it takes that no field of its files gives (a schedule's launch options) : kept in the app
  if ((p.appOnly || []).length) {
    lines.push(t('settings.repositories.usageOnAppOnly', { names: p.appOnly.join(', ') }));
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
 * true of them all (a new repository's files in git winning, what follows, the pull before letting
 * go, the changes not pushed yet) once, at the end. A preview that could not be read says so in
 * one line, in place of the types' own effects.
 *
 * Args:
 *   t (function): vue-i18n's t.
 *   name (string): the repository.
 *   changes (object): { on: [key], off: [key] }.
 *   pv (object): the preview ({ unpushed, types, failed }).
 *   isNew (boolean): a repository not made yet : its files cannot be read before its clone.
 *
 * Returns:
 *   object: { details (the paragraphs, a heading as { heading }), single (the one type changed,
 *     or null) }.
 */
export function usageQuestion(t, name, changes, pv, isNew = false) {
  const single = changes.on.length + changes.off.length === 1;
  const details = [];
  if (pv.failed) details.push(t('settings.repositories.usagePreviewFailed'));
  for (const key of pv.failed ? [] : changes.on) {
    if (!single) details.push({ heading: t('settings.repositories.usageOnHeading', { type: usageLabel(t, key) }) });
    details.push(...activationLines(t, key, name, pv.types[key] || {}));
  }
  for (const key of pv.failed ? [] : changes.off) {
    if (!single) details.push({ heading: t('settings.repositories.usageOffHeading', { type: usageLabel(t, key) }) });
    details.push(...deactivationLines(t, key, pv.types[key] || {}));
  }
  // what is true of every type turned on, and of every type turned off : said once ; a new
  // repository's, what the remote already has, only known once it is cloned
  if (changes.on.length && isNew) details.push(t('settings.repositories.usageOnNewRepository', { name }));
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
  const { details, single } = usageQuestion(t, name, changes, pv, !was);
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
  return askConfirm(t('settings.common.deleteConfirm', { name: repo.name }), {
    title: t('common.delete'),
    ok: t('common.delete'),
    icon: 'trash',
    details: usageQuestion(t, repo.name, changes, pv).details,
  });
}

/**
 * Why the repository was not pulled before a type followed its usage, as the toast says it : the
 * server's reason without its leading "not pulled: " (the sentence already says it), or '' when it
 * was pulled (or cloned).
 *
 * Args:
 *   pull (string): the report's pull ('pulled', 'cloned', 'not cloned', 'not pulled: <why>').
 *
 * Returns:
 *   string: the reason, '' for none.
 */
const notPulledReason = (pull) =>
  pull && !['pulled', 'cloned'].includes(pull) ? String(pull).replace(/^not pulled:\s*/, '') : '';

/**
 * Says what turning the types on or off did (the answer of the save or the delete), in a toast :
 * in red when one of them did not go as asked (an error, a pull that failed, files refused, the
 * latest files not read in before letting go), with why.
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
    const parts = [];
    const r = s.activated || s.deactivated;
    if (s.activated) {
      const a = s.activated;
      parts.push(
        t('settings.repositories.usageOnDone', {
          type,
          // read in from its files
          created: a.created ?? 0,
          written: (a.written || []).length,
          matched: (a.matched || []).length,
          kept: (a.kept || []).length,
        }),
      );
      // files of the repository the type could not take : named, each with why
      if ((a.refused || []).length) {
        failed = true;
        const files = a.refused.map((f) => `${f.file} (${(f.reasons || []).join('; ')})`).join(', ');
        parts.push(t('settings.repositories.usageRefused', { files }));
      }
    } else if (s.deactivated) {
      parts.push(t('settings.repositories.usageOffDone', { type, count: s.deactivated.unlinked ?? 0 }));
      // the latest files not read in before letting go : the objects stay as the last pull left them
      if (s.deactivated.error) {
        failed = true;
        parts.push(
          t('settings.repositories.usageNotReadIn', {
            error: String(s.deactivated.error).replace(/^not read in:\s*/, ''),
          }),
        );
      }
    }
    const reason = notPulledReason(r?.pull);
    if (r && reason) {
      // a repository let go of that was never cloned : nothing to read in, said only
      if (!(s.deactivated && r.pull === 'not cloned')) failed = true;
      parts.push(t('settings.repositories.usageNotPulled', { reason }));
    }
    if (parts.length) lines.push(parts.join(' '));
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
 * Where a type the app has one of is (the chat's, the settings', the defaults') : the repository
 * used for it and the file giving its key, as a record of a repository says it ; none when no
 * repository holds it.
 * Read with the settings (source_<type>), so a page of a part of the settings on its own shows it
 * without reading the repositories.
 *
 * Args:
 *   key (string): the type.
 *
 * Returns:
 *   Promise<object|null>: { repository, repo_file }, or null.
 */
export async function singleTypeSource(key) {
  if (!usageType(key)?.single) return null;
  try {
    const res = await axios.get('/api/v2/settings/');
    const source = res.data?.[`source_${key}`];
    return source?.repository ? { repository: source.repository, repo_file: source.repo_file } : null;
  } catch {
    return null;
  }
}
