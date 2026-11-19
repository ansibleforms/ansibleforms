// The empty texts of the lists, tables, editors and pick lists share one form.
//
// They had drifted apart: "no form" and "no facts" in lower case without a period, "No task
// yet." and "No roles configured yet." with one. Each now starts with a capital letter and
// ends without a final period (or 。), in every language; where it means that none was made
// yet, the English says so as "No X yet".
import { describe, it, expect } from 'vitest';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

// The texts shown where a list, a table, an editor or a pick list has nothing to show.
const EMPTY_TEXTS = [
  'inventoryEditor.noVar',
  'valuesPreview.noForm',
  'valuesPreview.noConstant',
  'valuesPreview.noVar',
  'playbookEditor.noRoles',
  'playbookEditor.noTask',
  'playbookOutline.empty',
  'workflowEditor.nothingNext',
  'workflowEditor.noWorkflowHint',
  'workflowEditor.noCredentials',
  'search.noResults',
  'apiTokens.none',
  'profilePage.noneYet',
  'audit.empty',
  'audit.noEntriesFor',
  'common.noFilterMatch',
  'common.noData',
  'yamlFile.noItems',
  'settings.databases.noUse',
  'settings.common.noneYet',
  'settings.directory.noMember',
  'settings.directory.noGroupSeen',
  'settings.linked.noFormRole',
  'settings.linked.noFormGroup',
  'settings.linked.noFormUser',
  'settings.linked.noFormRunner',
  'settings.linked.noJob',
  'settings.linked.noActivity',
  'settings.linked.noUse',
  'settings.interface.noLinks',
  'settings.users.noGroup',
  'settings.users.noRole',
  'settings.users.noStoredJob',
  'settings.users.noSchedule',
  'settings.groups.noUsers',
  'settings.groups.noRole',
  'settings.repositories.noOutput',
  'settings.repositories.noPushOutput',
  'settings.repositories.noPushTarget',
  'settings.credentials.noWritableStore',
  'settings.credentials.noSecretStore',
  'settings.credentials.noneOfType',
  'settings.settingsPage.noRoleLeft',
  'settings.settingsPage.noCategories',
  'settings.settingsPage.noRoles',
  'settings.settingsPage.noConstants',
  'settings.settingsPage.roleNoUsers',
  'settings.settingsPage.roleNoGroups',
  'settings.settingsPage.searchNone',
  'designer.noFiles',
  'designer.sectionToBuild',
  'designer.files.noInventories',
  'designer.files.noVars',
  'designer.files.noneOpen',
  'designer.files.noFiles',
  'designer.files.inventoryEmpty',
  'designer.noIconsFound',
  'designer.noIconSelected',
  'designer.noCategories',
  'designer.noConstants',
  'designer.noRoles',
  'designer.noFormSelected',
  'designer.noBackups',
  'designer.visualNoFields',
  'jobs.empty.status',
  'jobs.empty.filtered',
  'jobs.empty.none',
  'jobs.system.noRuns',
  'form.noSavedForms',
  'logs.noLog',
  'dataTable.presetsEmpty',
  'designer.files.noFolder',
];

// Those that mean none was made yet.
const NONE_YET = [
  'inventoryEditor.noVar',
  'valuesPreview.noConstant',
  'playbookEditor.noRoles',
  'playbookEditor.noTask',
  'playbookOutline.empty',
  'workflowEditor.noWorkflowHint',
  'apiTokens.none',
  'audit.empty',
  'settings.linked.noJob',
  'settings.interface.noLinks',
  'settings.users.noGroup',
  'settings.users.noRole',
  'settings.users.noStoredJob',
  'settings.users.noSchedule',
  'settings.credentials.noSecretStore',
  'settings.credentials.noneOfType',
  'settings.settingsPage.noCategories',
  'settings.settingsPage.noRoles',
  'settings.settingsPage.noConstants',
  'designer.files.noInventories',
  'designer.files.noVars',
  'designer.files.noFiles',
  'designer.noCategories',
  'designer.noConstants',
  'designer.noRoles',
  'designer.noBackups',
  'designer.visualNoFields',
  'jobs.empty.none',
  'jobs.system.noRuns',
  'form.noSavedForms',
  'dataTable.presetsEmpty',
];

const locales = {};
for (const lang of LANGS) locales[lang] = (await import(`../src/locales/${lang}.js`)).default;

/**
 * The text at a dotted key of a locale.
 *
 * Args:
 *   locale (object): the locale.
 *   key (string): the dotted key.
 *
 * Returns:
 *   string|undefined: the text, or undefined when the key is missing.
 */
function textAt(locale, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), locale);
}

describe('the empty texts', () => {
  it('exist in every language', () => {
    const missing = [];
    for (const lang of LANGS) {
      for (const key of EMPTY_TEXTS) if (typeof textAt(locales[lang], key) !== 'string') missing.push(`${lang} ${key}`);
    }
    expect(missing).toEqual([]);
  });

  it('start with a capital letter and end without a period, in every language', () => {
    const wrong = [];
    for (const lang of LANGS) {
      for (const key of EMPTY_TEXTS) {
        const text = textAt(locales[lang], key) ?? '';
        const first = text[0] ?? '';
        if (first !== first.toUpperCase() || /[.。．]$/.test(text)) wrong.push(`${lang} ${key}: ${text}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('say "No X yet" in English where none was made yet', () => {
    const wrong = NONE_YET.filter((key) => !/^No .*\byet\b/.test(textAt(locales.en, key)));
    expect(wrong).toEqual([]);
  });
});
