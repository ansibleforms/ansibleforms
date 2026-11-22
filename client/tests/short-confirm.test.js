// The abort and release confirmations ask in the short form of the delete ones.
//
// They asked "Are you sure you want to abort job" with the id glued on after the text, and
// "Are you sure you want to release {user}'s lock?". They now read "Abort job {id}?" and
// "Release {user}'s lock?", and no English text starts with "Are you sure" any more.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

// the short confirmations, with the placeholder that names their subject
const SHORT = {
  'jobs.abortConfirm': '{id}',
  'designer.releaseConfirm': '{user}',
};

describe('the abort and release confirmations', () => {
  it('leave no English text starting with "Are you sure"', () => {
    const long = Object.entries(flat.en)
      .filter(([, v]) => /^are you sure/i.test(v))
      .map(([k]) => k);
    expect(long).toEqual([]);
  });

  it('in English read "Abort job {id}?" and "Release {user}\'s lock?"', () => {
    expect(flat.en['jobs.abortConfirm']).toBe('Abort job {id}?');
    expect(flat.en['designer.releaseConfirm']).toBe("Release {user}'s lock?");
  });

  it.each(LANGS)('in %s name their subject by its placeholder and end as a question', (lang) => {
    const wrong = Object.entries(SHORT)
      .filter(([key, slot]) => !flat[lang][key]?.includes(slot) || !/[?？]$/.test(flat[lang][key]))
      .map(([key]) => key);
    expect(wrong).toEqual([]);
  });

  it('never glue the job id after the text in the code', () => {
    const jobs = fs.readFileSync(path.resolve(__dirname, '../src/pages/jobs.vue'), 'utf8');
    expect(jobs).not.toMatch(/t\('jobs\.abortConfirm'\)/);
    expect(jobs).toMatch(/keypath="jobs\.abortConfirm"/);
  });
});
