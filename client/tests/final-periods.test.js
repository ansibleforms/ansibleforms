// Texts end with a period as natural language does.
//
// A text that is a full sentence or more ends with a period (or "?" or "!"): the help lines
// under the fields, the notes and explanations, the descriptions of options and pages, and
// the messages that are sentences ("The group was created, but these users were not added:
// {names}."). Labels, buttons, titles, tabs, column headers, menu entries, placeholders,
// short status phrases ("Backup imported"), short empty texts ("No roles yet") and other
// fragments end without one. The choice is made on the English text, and every language
// makes the same one for that key, Japanese and Chinese with 。.
import { describe, it, expect } from 'vitest';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

/**
 * Every text of a locale, keyed by its dotted path.
 *
 * Args:
 *   obj (object): the locale, or one of its sections.
 *   prefix (string): the path of that section.
 *   out (object): the texts found so far.
 *
 * Returns:
 *   object: the texts, by dotted key.
 */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const flat = {};
for (const lang of LANGS) flat[lang] = flatten((await import(`../src/locales/${lang}.js`)).default);

/**
 * Whether a text ends as a sentence does: with a period, a question or an exclamation mark,
 * in each of its plural forms (the last one stands for them all).
 *
 * Args:
 *   text (string): the text.
 *
 * Returns:
 *   boolean: true when it ends with . ? ! or their Japanese and Chinese forms.
 */
function endsSentence(text) {
  const last = text.split(' | ').pop().trimEnd();
  return /[.?!。？！]$/.test(last);
}

// labels a language shortens with an abbreviation, whose dot is not a period
const ABBREVIATED = [
  'settings.cron.dayOfWeek',
  'settings.runners.maxJobs',
  'settings.cron.preset1hour',
  'settings.cron.preset6hours',
  'settings.cron.preset12hours',
];

// keys named as help lines that are labels (a column, a field's name, a button), or a lead
// that a colon joins to what follows
const NAMED_LIKE_HELP = [
  'admin.ldap.testDescription',
  'profilePage.columnDescription',
  'designer.fieldHelp',
  'designer.formDescription',
  'designer.helpText',
  'form.showHelp',
  'form.hideHelp',
];

// the help lines and descriptions, which end with a period
const HELP = Object.keys(flat.en).filter(
  (key) =>
    !NAMED_LIKE_HELP.includes(key) &&
    (/(Help|Desc|Description)(_\w+)?$/.test(key) ||
      /\.help[A-Z]\w*$/.test(key) ||
      /^(designer\.fieldProp|profilePage\.optionDescription|jobs\.description)\./.test(key) ||
      /^jobs\.system\.tasks\.\w+\.description$/.test(key)),
);

// messages that are sentences, and end with a period
const SENTENCES = [
  'settings.groups.usersNotAdded',
  'settings.users.rolesNotGiven',
  'settings.common.fieldRequired',
  'settings.common.nameCreated',
  'settings.common.passwordsDiffer',
  'settings.settingsPage.envRestartPending',
  'settings.runners.approved',
  'settings.runners.rteMode_outboundHint',
  'errors.notAdmin',
  'designer.notLockedHint',
  'designer.importBadYaml',
  'designer.warnUniqueFieldName',
  'form.warnSelfReferenceDetail',
  'form.prefillNotFound',
  'jobs.empty.none',
  'changePassword.invalid',
  'nav.designerLockedBy',
  'workflowEditor.problems.loop',
];

// the labels, buttons, titles, menus, tabs and placeholders, which end without one
const LABELS = Object.keys(flat.en).filter(
  (key) =>
    !key.startsWith('designer.fieldProp.') &&
    (/^(nav|sidebar|audit\.actionLabels|jobs\.menu|settings\.repositories\.usageTypes)\./.test(key) ||
      /\.roleOption(?!Included|Needs)[A-Z]\w*$/.test(key) ||
      /\.tab[A-Z]\w*$/.test(key) ||
      /(Title|Label|Placeholder)(_\w+)?$/.test(key)) &&
    !/^nav\.(designerLocked)/.test(key),
);

// short status phrases, empty texts and fragments, which end without one
const FRAGMENTS = [
  'settings.settingsPage.noRoles',
  'jobs.empty.filtered',
  'jobs.failedToLoad',
  'designer.noChanges',
  'designer.syncDone',
  'designer.importReadFailed',
  'common.copyFailed',
  'settings.credentials.awxSignInHint_password',
  'settings.runners.type_awxHint',
  'settings.schedules.timingOnceHint',
  'settings.repositories.usageHints.forms',
];

describe('the final periods', () => {
  it('found the help lines and the labels, so this is not vacuous', () => {
    expect(HELP.length).toBeGreaterThan(250);
    expect(LABELS.length).toBeGreaterThan(250);
  });

  it('end every help line and description in English', () => {
    expect(HELP.filter((key) => !endsSentence(flat.en[key]))).toEqual([]);
  });

  it('end the messages that are sentences in English', () => {
    expect(SENTENCES.filter((key) => !endsSentence(flat.en[key]))).toEqual([]);
  });

  it('never end a label, a button, a title, a tab or a placeholder in English', () => {
    expect(LABELS.filter((key) => /\.$/.test(flat.en[key]))).toEqual([]);
  });

  it('never end a short status phrase, an empty text or a fragment in English', () => {
    expect(FRAGMENTS.filter((key) => endsSentence(flat.en[key]))).toEqual([]);
  });

  it.each(LANGS.filter((lang) => lang !== 'en'))('in %s are where English has them', (lang) => {
    const wrong = Object.keys(flat.en)
      .filter((key) => key in flat[lang] && !ABBREVIATED.includes(key))
      .filter((key) => endsSentence(flat.en[key]) !== endsSentence(flat[lang][key]))
      .map((key) => `${key}: ${flat[lang][key]}`);
    expect(wrong).toEqual([]);
  });

  it.each(['ja', 'zh'])('in %s are the full-width 。, never a dot', (lang) => {
    const dots = Object.entries(flat[lang])
      .filter(([key, text]) => !ABBREVIATED.includes(key) && /[^\p{ASCII}][)）]?\.$/u.test(text.trimEnd()))
      .map(([key]) => key);
    expect(dots).toEqual([]);
  });
});
