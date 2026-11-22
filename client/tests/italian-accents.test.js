// The Italian texts carry their accents.
//
// A few texts of it.js were once typed without them ("gia", "piu", "modalita", "non e stato"),
// which reads as a typo on every screen. A word below is never right without its accent, so
// any of them standing as a whole word in an Italian text is a regression. "e" alone is left
// out, being also the word for and: "non e" is checked as a phrase instead. Placeholders and
// code in backticks are technical and left out.
import { describe, it, expect } from 'vitest';
import itLocale from '@/locales/it';

// Common Italian words, and one phrase, that are only ever spelled with an accent.
const UNACCENTED = [
  'attivita',
  'citta',
  'cosi',
  'entita',
  'funzionalita',
  'gia',
  'identita',
  'modalita',
  'non e',
  'perche',
  'piu',
  'poiche',
  'priorita',
  'proprieta',
  'puo',
  'qualita',
  'sara',
  'sicche',
  'validita',
];

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

// A word stands alone : no letter, digit, underscore or slash on either side, and no dot
// joining it to a following word (a file name).
const pattern = new RegExp(
  `(?<![\\p{L}\\d_/])(?<!\\p{L}\\.)(${UNACCENTED.join('|')})(?![\\p{L}\\d_/])(?!\\.\\p{L})`,
  'iu',
);

describe('the Italian texts', () => {
  const texts = flatten(itLocale);

  it('are found, so this is not vacuous', () => {
    expect(Object.keys(texts).length).toBeGreaterThan(1000);
  });

  it('have no common word without its accent', () => {
    const found = [];
    for (const [key, text] of Object.entries(texts)) {
      // Placeholders and code in backticks are not Italian.
      const prose = text.replace(/\{[^}]*\}/g, ' ').replace(/`[^`]*`/g, ' ');
      const m = pattern.exec(prose);
      if (m) found.push(`${key}: ${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it('catch a word without its accent', () => {
    expect(pattern.test('Test gia in corso')).toBe(true);
    expect(pattern.test('Esegui piu tardi')).toBe(true);
    expect(pattern.test('Il modulo non e stato trovato')).toBe(true);
    expect(pattern.test('Non esiste')).toBe(false);
    expect(pattern.test('giallo')).toBe(false);
  });
});
