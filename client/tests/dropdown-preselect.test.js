// A new record's dropdowns (AppAdminMulti) : each list dropdown starts on the first choice it
// offers (its choicesWhen applied, a credential dropdown of every kind on the kind its New button
// makes), never on its empty choice nor on a record it does not offer ; none to offer : empty, its
// emptyText saying so ; chosen again when what it offers changes ; one the user emptied stays empty.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import getSettings from '@/config/settings';

const multi = readFileSync(resolve(__dirname, '../src/components/AppAdminMulti.vue'), 'utf8');
const all = getSettings((key) => key);
const credentialField = (key) => all.credentials.fields.find((f) => f.key === key);

describe("a new record's dropdown", () => {
  it('is every select of a list, credentials, secret stores and the others alike', () => {
    expect(multi).toMatch(
      /function isListSelect\(field\) \{\s*return field\?\.type === 'select' && !!field\.parent && !!field\.valueKey;/,
    );
    expect(multi).not.toMatch(/isCredentialSelect|preselectCredentials/);
  });

  it('is not given the first record of its list when the dialog opens', () => {
    expect(multi).not.toMatch(/item\.value\[field\.key\] = list\[0\]\[field\.valueKey\]/);
  });

  it('takes the first choice it offers, keeps one it offers, replaces one it does not', () => {
    expect(multi).toMatch(/const offered = choicesOf\(field\)\.filter\(\(c\) => c\?\.\[field\.valueKey\]\);/);
    expect(multi).toMatch(/if \(current && offered\.some\(\(c\) => c\[field\.valueKey\] === current\)\) continue;/);
    expect(multi).toMatch(/const chosen = choices\.length \? choices\[0\]\[field\.valueKey\] : '';/);
  });

  it("takes the kind its New button makes for a credential dropdown of every kind (a repository's git)", () => {
    expect(multi).toMatch(
      /field\.parent === 'credentials' && !field\.choicesWhen \? textOf\(field\.createDefaults\)\?\.credential_type : null;/,
    );
    const repo = all.repositories.fields.find((f) => f.key === 'credential');
    expect(repo.choicesWhen).toBeUndefined();
    expect(repo.createDefaults.credential_type).toBe('git');
  });

  it('only on a new record, on a shown dropdown, and never one the user emptied', () => {
    expect(multi).toMatch(/function preselectChoices\(\) \{\s*if \(action\.value !== 'new'\) return;/);
    expect(multi).toMatch(/choicesCleared\.has\(field\.key\) \|\| !showField\(field\)/);
    expect(multi).toMatch(
      /if \(before\[i\] && !now\[i\] && choicesChosen\.get\(f\.key\) !== ''\) choicesCleared\.add\(f\.key\);/,
    );
  });

  it('chooses again on every step, when the lists are read and when what decides them changes', () => {
    expect(multi).toMatch(/\(\) => nextTick\(preselectChoices\)/);
  });
});

describe("a credential's secret store", () => {
  it('says there is none yet, to read from or to write to', () => {
    const store = credentialField('secret_store');
    expect(store.emptyText({ secret_source: 'store' })).toBe('settings.credentials.noSecretStore');
    expect(store.emptyText({ secret_source: 'store', secret_action: 'write' })).toBe(
      'settings.credentials.noWritableStore',
    );
  });

  it('has the words in every language', async () => {
    for (const lang of ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl']) {
      const { default: m } = await import(`../src/locales/${lang}.js`);
      expect(m.settings.credentials.noSecretStore, lang).toBeTruthy();
    }
  });
});
