// The German texts carry their umlauts and ß.
//
// A part of de.js was once typed with ae, oe, ue and ss for ä, ö, ü and ß ("loeschen", "fuer",
// "Schluessel", "Groesse"), which reads as a typo on every screen. A word below is never right
// spelled that way, so any of them standing as a whole word in a German text is a regression.
// Placeholders and code in backticks are technical and left out.
import { describe, it, expect } from 'vitest';
import de from '@/locales/de';

// Common German words that are only ever spelled with ä, ö, ü or ß.
const SPELLED_OUT = [
  'aendern',
  'aenderungen',
  'ausfuehren',
  'ausfuehrlicher',
  'ausfuehrung',
  'ausfuellen',
  'ausloesen',
  'auswaehlen',
  'bestaetigen',
  'eintraege',
  'enthaelt',
  'fuer',
  'geloescht',
  'gemaess',
  'gewaehlt',
  'gewaehrleistung',
  'groesse',
  'gross',
  'gueltig',
  'gueltige',
  'haeufig',
  'hinzufuegen',
  'koennen',
  'koennte',
  'laedt',
  'laeuft',
  'loeschen',
  'moechten',
  'muessen',
  'naechste',
  'naechsten',
  'nuetzlich',
  'oeffentlich',
  'oeffentliche',
  'oeffentlichen',
  'oeffentlicher',
  'oeffnen',
  'pruefen',
  'pruefung',
  'ruecklinks',
  'schliessen',
  'schluessel',
  'schreibgeschuetzt',
  'spaeter',
  'spaeteren',
  'ueber',
  'uebergeordnete',
  'ueberschrieben',
  'uebersicht',
  'uebliche',
  'ungueltig',
  'ungueltige',
  'ungueltiges',
  'unterschluessel',
  'unterstuetzt',
  'unterstuetzter',
  'unverschluesselt',
  'veroeffentlicht',
  'waehlen',
  'wuerde',
  'zeitplaene',
  'zurueck',
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
  `(?<![\\p{L}\\d_/])(?<!\\p{L}\\.)(${SPELLED_OUT.join('|')})(?![\\p{L}\\d_/])(?!\\.\\p{L})`,
  'iu',
);

describe('the German texts', () => {
  const texts = flatten(de);

  it('are found, so this is not vacuous', () => {
    expect(Object.keys(texts).length).toBeGreaterThan(1000);
  });

  it('have no common word spelled without ä, ö, ü or ß', () => {
    const found = [];
    for (const [key, text] of Object.entries(texts)) {
      // Placeholders and code in backticks are not German.
      const prose = text.replace(/\{[^}]*\}/g, ' ').replace(/`[^`]*`/g, ' ');
      const m = pattern.exec(prose);
      if (m) found.push(`${key}: ${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it('catch a word spelled out', () => {
    expect(pattern.test('Element loeschen')).toBe(true);
    expect(pattern.test('SSH-Schluessel')).toBe(true);
    expect(pattern.test('Spaeter ausfuehren')).toBe(true);
    expect(pattern.test('Queue')).toBe(false);
    expect(pattern.test('Value')).toBe(false);
    expect(pattern.test('true')).toBe(false);
    expect(pattern.test('Benutzer')).toBe(false);
  });
});
