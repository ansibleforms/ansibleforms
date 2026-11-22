// A list's New title and Add button in every language : the shared templates ("New {item}",
// "Add {item}") cannot agree with a noun's gender or case, so a list names its own words
// (settings.titleKey) and every language whose grammar needs them gives them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(__dirname, '../src', p), 'utf8');
const keys = [...read('config/settings.js').matchAll(/titleKey: '(\w+)'/g)].map((m) => m[1]);
// the languages whose adjective agrees with its noun ; Polish puts the Add button's noun in the accusative
const GENDERED = ['fr', 'es', 'it', 'de', 'ca', 'pt', 'nl', 'pl'];

describe("a list's New title and Add button", () => {
  it('every list with a title key has its words in every gendered language, and the Add words in Polish', async () => {
    expect(keys.length).toBeGreaterThan(15);
    for (const lang of GENDERED) {
      const common = (await import(`../src/locales/${lang}.js`)).default.settings.common;
      for (const key of keys) expect(common.newTitle?.[key], `${lang} newTitle.${key}`).toBeTruthy();
    }
    const pl = (await import('../src/locales/pl.js')).default.settings.common;
    for (const key of keys) expect(pl.addLabel?.[key], `pl addLabel.${key}`).toMatch(/^Dodaj /);
  });

  it('the words agree : no title the template used to get wrong', async () => {
    const fr = (await import('../src/locales/fr.js')).default.settings.common.newTitle;
    const de = (await import('../src/locales/de.js')).default.settings.common.newTitle;
    const es = (await import('../src/locales/es.js')).default.settings.common.newTitle;
    expect(fr.users).toBe('Nouvel utilisateur');
    expect(de.schedules).toBe('Neuer Zeitplan');
    expect(es.schedules).toBe('Nueva programación');
    expect((await import('../src/locales/pl.js')).default.settings.common.addLabel.groups).toBe('Dodaj grupę');
  });

  it('AppAdminMulti reads them from the language itself, the template otherwise', () => {
    const src = read('components/AppAdminMulti.vue');
    expect(src).toContain('te(key, locale.value)');
    expect(src).toContain("ownWords('newTitle') ||");
    expect(src).toContain('{{ addLabel }}');
  });

  it("a wizard's buttons are a step's, the pager keeps a page's words", async () => {
    for (const p of [
      'components/AppAdminMulti.vue',
      'components/AppWorkflowEditor.vue',
      'pages/profile.vue',
      'pages/admin/roles.vue',
    ]) {
      expect(read(p), p).not.toMatch(/t\('common\.(next|previous)'\)/);
    }
    expect(read('components/BsPagination.vue')).toContain("t('common.next')");
    const zh = (await import('../src/locales/zh.js')).default.common;
    expect([zh.previousStep, zh.nextStep, zh.next]).toEqual(['上一步', '下一步', '下一页']);
    expect((await import('../src/locales/pl.js')).default.common.nextStep).toBe('Dalej');
  });

  it("a schedule's Timing is not the word of its Schedule tab, Polish's Last launch is not its Last run", async () => {
    for (const lang of ['es', 'fr', 'it', 'ca', 'pt', 'pl']) {
      const s = (await import(`../src/locales/${lang}.js`)).default.settings;
      expect(s.schedules.timing, lang).not.toBe(s.schedules.stepSchedule);
    }
    const pl = (await import('../src/locales/pl.js')).default.settings;
    expect(pl.schedules.lastLaunch).not.toBe(pl.fields.lastRun);
    expect((await import('../src/locales/nl.js')).default.sidebar.categories).toBe('Categorieën');
  });
});
