/******************************************************************/
/*                                                                */
/*  The repositories list's Push all, on the right of Pull all :  */
/*  every repository with changes not pushed yet pushed, greyed   */
/*  while none has any, its words in every language.              */
/*                                                                */
/******************************************************************/
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toPush } from '../src/lib/repositoryUsage.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (p) => readFileSync(path.join(SRC, p), 'utf8');
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

describe('Push all on the repositories list', () => {
  it('pushes the repositories with changes, greyed when none has any', () => {
    const repos = [
      { name: 'forms', use_for_forms: 1, unpushed: true },
      { name: 'clean', use_for_forms: 1, unpushed: false },
      { name: 'play', use_for_playbooks: 1, unpushed: 1 },
    ];
    expect(toPush(repos).map((r) => r.name)).toEqual(['forms', 'play']);
    expect(toPush([{ name: 'clean', use_for_forms: 1 }])).toEqual([]);
    expect(toPush(undefined)).toEqual([]);
  });

  it('sits after Pull all, greyed while nothing is to push', () => {
    const page = read('pages/admin/repositories.vue');
    expect(page.indexOf("t('settings.repositories.pushAll')")).toBeGreaterThan(
      page.indexOf("t('settings.repositories.pullAll')\n"),
    );
    expect(page).toContain(':disabled="pushingAll || pullingAll || !pushable.length"');
    expect(page).toContain('const pushable = computed(() => toPush(adminMulti.value?.itemList));');
    expect(page).toContain('.catch(() => failed.push(repo.name));');
    expect(read('components/AppAdminMulti.vue')).toMatch(/defineExpose\(\{[^}]*\bitemList,/);
  });

  it('has its words in every language', async () => {
    for (const lang of LANGS) {
      const r = (await import(`../src/locales/${lang}.js`)).default.settings.repositories;
      for (const key of ['pushAll', 'pushAllDone', 'pushAllFailed', 'pushAllNone'])
        expect(r[key], `${lang} ${key}`).toBeTruthy();
      expect(r.pushAllFailed, lang).toContain('{names}');
      expect(r.pushAllDone, lang).toContain('{n}');
    }
  });
});
