// One ellipsis: the single character "…", never three dots.
//
// The texts mixed "Loading..." with "Loading…", and a few lists ended in " ...)" or ", ...)".
// Every text of the eleven languages, and every text the client code shows itself (a select's
// placeholder, a shortened announcement), now uses "…". Code, regexes and comments keep their
// three dots, as does the Designer's https://... placeholder, a URL pattern.
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

/**
 * Lists the source files of the client, recursively, without the locales.
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

// three dots right after a word and right before the end of a string or of a tag's text :
// "Loading...'", "{{ t('x') }}...<", "...}...`" ; a spread (...rest) never matches
const SHOWN_DOTS = /[\p{L}}]\.\.\.(?=['"`<]|\s*<)/u;

describe('the ellipsis', () => {
  it.each(LANGS)('in %s is always the single character', async (lang) => {
    const flat = flatten((await import(`../src/locales/${lang}.js`)).default);
    const dots = Object.entries(flat)
      .filter(([, v]) => v.includes('...'))
      .map(([k]) => k);
    expect(dots).toEqual([]);
  });

  it('is the single character in the texts the client code shows itself', () => {
    const src = path.resolve(__dirname, '../src');
    const dots = [];
    for (const file of sources(src)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // comments and the console are not shown
          if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line) || /console\.\w+\(/.test(line)) return;
          if (SHOWN_DOTS.test(line)) dots.push(`${path.relative(src, file)}:${i + 1}`);
        });
    }
    expect(dots).toEqual([]);
  });

  it('is used where a text waits, as Loading…', async () => {
    const en = (await import('../src/locales/en.js')).default;
    expect(en.common.refreshing).toBe('Refreshing…');
    expect(fs.readFileSync(path.resolve(__dirname, '../src/components/BsInputSelectAdvanced.vue'), 'utf8')).toContain(
      "'Loading…'",
    );
  });
});
