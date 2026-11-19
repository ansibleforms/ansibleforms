// A new record's credential dropdowns (AppAdminMulti) : the first credential of their kind chosen,
// not an empty choice nor the first credential of all (another kind, which the dropdown could not
// show) ; chosen again when the kind changes ; one the user emptied stays empty.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import getSettings from '@/config/settings';

const multi = readFileSync(resolve(__dirname, '../src/components/AppAdminMulti.vue'), 'utf8');
const all = getSettings((key) => key);

describe("a new record's credential dropdown", () => {
  it('is not given the first credential of all when the dialog opens', () => {
    expect(multi).toMatch(
      /if \(field\.type === 'select' && field\.parent && field\.valueKey && !isCredentialSelect\(field\)\) \{/,
    );
  });

  it('takes the first credential its choices keep', () => {
    expect(multi).toMatch(/const offered = choicesOf\(field\)\.filter\(\(c\) => c\?\.\[field\.valueKey\]\);/);
    expect(multi).toMatch(/const chosen = choices\.length \? choices\[0\]\[field\.valueKey\] : '';/);
  });

  it("takes the kind its New button makes when its dropdown lists every kind (a repository's git)", () => {
    expect(multi).toMatch(
      /const kind = field\.choicesWhen \? null : textOf\(field\.createDefaults\)\?\.credential_type;/,
    );
    expect(multi).toMatch(/const choices = offered\.filter\(\(c\) => !kind \|\| c\.credential_type === kind\);/);
    const repo = all.repositories.fields.find((f) => f.key === 'credential');
    expect(repo.choicesWhen).toBeUndefined();
    expect(repo.createDefaults.credential_type).toBe('git');
  });

  it('keeps one of its kind, replaces one of another kind', () => {
    // any credential it offers, of whatever kind, once chosen or picked by the user
    expect(multi).toMatch(/if \(current && offered\.some\(\(c\) => c\[field\.valueKey\] === current\)\) continue;/);
  });

  it('only on a new record, on a shown dropdown, and never one the user emptied', () => {
    expect(multi).toMatch(/function preselectCredentials\(\) \{\s*if \(action\.value !== 'new'\) return;/);
    expect(multi).toMatch(/credentialsCleared\.has\(field\.key\) \|\| !showField\(field\)/);
    expect(multi).toMatch(
      /if \(before\[i\] && !now\[i\] && credentialsChosen\.get\(f\.key\) !== ''\) credentialsCleared\.add\(f\.key\);/,
    );
  });

  it('chooses again on every step, when the credentials are read and when the kind changes', () => {
    expect(multi).toMatch(/stepIndex\.value,\s*\(parentLists\.value\?\.credentials \|\| \[\]\)\.length,/);
    expect(multi).toMatch(/\(\) => nextTick\(preselectCredentials\)/);
  });

  it('covers every credential dropdown of the list dialogs', () => {
    const credentialSelects = Object.values(all)
      .flatMap((list) => list?.fields || [])
      .filter((f) => f.type === 'select' && f.parent === 'credentials');
    expect(credentialSelects.length).toBeGreaterThan(5);
    expect(credentialSelects.every((f) => f.valueKey)).toBe(true);
  });
});
