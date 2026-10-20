import { describe, it, expect } from 'vitest';
import { roleOptionGroups, roleOptionKeys } from '@/config/roles';

describe('role option groups', () => {
  it('hold every role option once, in the same order as the list', () => {
    const grouped = roleOptionGroups.flatMap((g) => g.keys);
    expect(grouped).toEqual(roleOptionKeys);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('each have a name and a title key', () => {
    for (const g of roleOptionGroups) {
      expect(g.name).toBeTruthy();
      expect(g.title).toMatch(/^[a-zA-Z]+\.[a-zA-Z.]+$/);
    }
  });
});

import { effectiveRoleOption } from '@/config/roles';

describe('what a role option really gives', () => {
  it('an option included in another that is on is on, whatever its own value', () => {
    expect(effectiveRoleOption({ showSettings: true, showAuditLog: false }, 'showAuditLog')).toEqual({
      value: true,
      includedBy: 'showSettings',
      needs: null,
    });
    expect(effectiveRoleOption({ manageAllJobs: true }, 'showAllJobLogs').value).toBe(true);
  });

  it('an option missing the one it needs is off, whatever its own value', () => {
    expect(effectiveRoleOption({ showDesigner: false, allowFormDesign: true }, 'allowFormDesign')).toEqual({
      value: false,
      includedBy: null,
      needs: 'showDesigner',
    });
    expect(
      effectiveRoleOption({ allowApiTokens: false, extendedTokenExpiration: true }, 'extendedTokenExpiration').value,
    ).toBe(false);
  });

  it('else its own value', () => {
    expect(effectiveRoleOption({ showDesigner: true, allowFormDesign: true }, 'allowFormDesign').value).toBe(true);
    expect(effectiveRoleOption({ showLogs: false }, 'showLogs').value).toBe(false);
  });
});

import { roleOptionDefaults, roleToEditable } from '@/config/roles';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('designAllForms : every form in the designer, or only those of the roles', () => {
  const LANGS = ['en', 'es', 'ca', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ja', 'zh'];

  it('in the Designer group after Edit Forms, on by default, needing the designer', () => {
    const designer = roleOptionGroups.find((g) => g.name === 'designer').keys;
    expect(designer.indexOf('designAllForms')).toBe(designer.indexOf('allowFormDesign') + 1);
    expect(roleOptionDefaults('ops').designAllForms).toBe(true);
    expect(roleToEditable({ name: 'ops', options: { designAllForms: false } }).options.designAllForms).toBe(false);
    expect(effectiveRoleOption({ showDesigner: false, designAllForms: true }, 'designAllForms').needs).toBe(
      'showDesigner',
    );
  });

  it('its label and description in every language, shown by the role editor and the Permissions view', async () => {
    for (const lang of LANGS) {
      const m = (await import(`../src/locales/${lang}.js`)).default;
      expect(m.settings.settingsPage.roleOptionDesignAllForms, lang).toBeTruthy();
      expect(m.profilePage.optionDescription.designAllForms, lang).toBeTruthy();
      expect(m.designer.subformReadOnly, lang).toBeTruthy();
    }
    // both draw every option of roleOptionGroups
    const src = (f) => readFileSync(join(__dirname, '../src', f), 'utf8');
    expect(src('pages/profile.vue')).toContain('roleOptionGroups');
    expect(src('components/AppRoleEditor.vue')).toContain('roleOptionGroups');
    // the designer shows a subform the user only uses read only
    expect(src('pages/designer.vue')).toContain('!canDesignForms || formReadOnly');
  });
});

describe('designAllPlaybooks and designAllWorkflows : right after Edit Playbooks and Edit Workflows', () => {
  const LANGS = ['en', 'es', 'ca', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ja', 'zh'];

  it('in the Designer group, each after its Edit option, on by default, needing the designer', () => {
    const designer = roleOptionGroups.find((g) => g.name === 'designer').keys;
    expect(designer).toEqual([
      'showDesigner',
      'allowFormDesign',
      'designAllForms',
      'allowPlaybookDesign',
      'designAllPlaybooks',
      'allowWorkflowDesign',
      'designAllWorkflows',
      'allowInventoryDesign',
      'allowVarsFileDesign',
    ]);
    for (const key of ['designAllPlaybooks', 'designAllWorkflows']) {
      expect(roleOptionDefaults('ops')[key]).toBe(true);
      expect(effectiveRoleOption({ showDesigner: false, [key]: true }, key).needs).toBe('showDesigner');
    }
  });

  it('their labels and descriptions in every language, for the role editor and the Permissions view', async () => {
    for (const lang of LANGS) {
      const m = (await import(`../src/locales/${lang}.js`)).default;
      for (const key of ['DesignAllPlaybooks', 'DesignAllWorkflows']) {
        expect(m.settings.settingsPage[`roleOption${key}`], lang).toBeTruthy();
        expect(m.profilePage.optionDescription[key.charAt(0).toLowerCase() + key.slice(1)], lang).toBeTruthy();
      }
    }
    const en = (await import('../src/locales/en.js')).default.settings.settingsPage;
    expect([en.roleOptionDesignAllPlaybooks, en.roleOptionDesignAllWorkflows]).toEqual([
      'Edit All Playbooks',
      'Edit All Workflows',
    ]);
  });
});
