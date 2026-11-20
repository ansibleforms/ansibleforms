// Every search box says the same thing: Search.
//
// They had drifted apart: "Filter" in the pages' search boxes, "Search..." in the designer's
// icon pickers and file trees, "Find a field" or "Find in the output" elsewhere. One text,
// common.search, now says it everywhere, without dots, and BsSearch takes no other.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

/**
 * Every .vue file under a folder.
 *
 * Args:
 *   dir (string): the folder.
 *   acc (string[]): the files found so far.
 *
 * Returns:
 *   string[]: their paths.
 */
function vueFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) vueFiles(p, acc);
    else if (entry.name.endsWith('.vue')) acc.push(p);
  }
  return acc;
}

// Each opening tag of a template, with its attributes (a tag may span lines, and a quoted
// attribute may hold a > of its own).
const TAG = /<([A-Za-z][\w-]*)\b((?:[^<>"]|"[^"]*")*?)\/?>/g;

/**
 * The search boxes of the templates: every BsSearch, every input of type search, and every
 * tag whose placeholder speaks of searching.
 *
 * Returns:
 *   object[]: { file, tag, attrs } of each.
 */
function searchBoxes() {
  const boxes = [];
  for (const file of vueFiles(src)) {
    const text = withoutComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(TAG)) {
      const [, tag, attrs] = m;
      const placeholder = /:?placeholder="([^"]*)"/.exec(attrs)?.[1] ?? '';
      if (tag === 'BsSearch' || /type="search"/.test(attrs) || /search|find/i.test(placeholder)) {
        boxes.push({ file: path.relative(src, file), tag, attrs });
      }
    }
  }
  return boxes;
}

describe('the search boxes', () => {
  const boxes = searchBoxes();

  it('are found, so this is not vacuous', () => {
    expect(boxes.filter((b) => b.tag === 'BsSearch').length).toBeGreaterThan(20);
  });

  it('all say common.search', () => {
    const wrong = boxes
      .filter((b) => b.tag !== 'BsSearch')
      .filter((b) => !/:placeholder="t\('common\.search'\)"/.test(b.attrs))
      .map((b) => `${b.file} <${b.tag}>`);
    expect(wrong).toEqual([]);
  });

  it('BsSearch says it itself and takes no other placeholder', () => {
    const own = readFileSync(path.join(src, 'components', 'BsSearch.vue'), 'utf8');
    expect(own).toContain(`:placeholder="t('common.search')"`);
    const given = boxes.filter((b) => b.tag === 'BsSearch' && /placeholder=/.test(b.attrs));
    expect(given.map((b) => b.file)).toEqual([]);
  });

  it('is "Search" without dots, in every language', async () => {
    for (const lang of LANGS) {
      const { common } = (await import(`../src/locales/${lang}.js`)).default;
      expect(typeof common.search, lang).toBe('string');
      expect(common.search, lang).not.toMatch(/\.\.\.|…|\.$/);
      expect(common.searchPlaceholder, lang).toBeUndefined();
    }
  });
});
