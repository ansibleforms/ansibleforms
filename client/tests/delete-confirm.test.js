// Every delete confirmation asks in one short form.
//
// They used to ask "Are you sure you want to delete" with the name glued on after the text,
// in every language, next to bulk questions that already read "Delete 3 items?". They now
// all read "Delete X?" for one thing ("Delete folder X and all its files?") and "Delete N
// things?" for several, the name being a placeholder of the text so each language puts it
// where its grammar wants it.
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

// the confirmations of one thing, with the placeholder that names it
const ONE = {
  'settings.common.deleteConfirm': '{name}',
  'designer.deleteConfirm': '{name}',
  'designer.files.deleteConfirm': '{name}',
  'designer.deleteFileConfirm': '{name}',
  'designer.deleteFolderConfirm': '{name}',
  'jobs.deleteConfirm': '{id}',
};

// the confirmations of several things, with their count
const SEVERAL = ['settings.common.bulkDeleteConfirm', 'jobs.deleteSelectedConfirm'];

/**
 * Lists the source files of the client, recursively.
 *
 * Args:
 *   dir (string): the folder to list.
 *
 * Returns:
 *   string[]: the .vue and .js files under it.
 */
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'locales' ? [] : sources(p);
    return /\.(vue|js)$/.test(e.name) ? [p] : [];
  });
}

describe('the delete confirmations', () => {
  it('in English never start with "Are you sure"', () => {
    const long = Object.entries(flat.en)
      .filter(([k, v]) => /delet/i.test(k + v) && /^are you sure/i.test(v))
      .map(([k]) => k);
    expect(long).toEqual([]);
  });

  it('in English read "Delete X?" and "Delete N things?"', () => {
    for (const key of Object.keys(ONE)) expect(flat.en[key]).toMatch(/^Delete .*\?$/);
    for (const key of SEVERAL) expect(flat.en[key]).toMatch(/^Delete \{count\} /);
  });

  it.each(LANGS)('in %s name the thing by its placeholder, and count the several', (lang) => {
    const wrong = [];
    for (const [key, slot] of Object.entries(ONE)) if (!flat[lang][key]?.includes(slot)) wrong.push(key);
    for (const key of SEVERAL) if (!flat[lang][key]?.includes('{count}')) wrong.push(key);
    expect(wrong).toEqual([]);
  });

  it('are never glued to a name in the code, which the text places itself', () => {
    const glued = sources(path.resolve(__dirname, '../src')).filter((f) =>
      /t\('[\w.]*delete(File|Folder)?Confirm'\)/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(glued).toEqual([]);
  });
});
