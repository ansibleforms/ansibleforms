// The French texts carry their accents.
//
// A good part of fr.js was once typed without them ("donnees", "cle", "Echec de connexion"),
// which reads as a typo on every screen. A word below is never right without its accent, so
// any of them standing as a whole word in a French text is a regression. Placeholders, code in
// backticks and paths (roles/web/main.yml, controller_roles) are technical and left out.
import { describe, it, expect } from 'vitest';
import fr from '@/locales/fr';

// Common French words that are only ever spelled with an accent.
const UNACCENTED = [
  'acces',
  'annees',
  'apercu',
  'categorie',
  'categories',
  'cle',
  'cles',
  'cree',
  'creee',
  'creer',
  'crees',
  'debut',
  'defaut',
  'deja',
  'depot',
  'depots',
  'derniere',
  'dernieres',
  'donnee',
  'donnees',
  'echec',
  'echoue',
  'editeur',
  'element',
  'elements',
  'enregistrees',
  'enregistres',
  'entree',
  'etape',
  'etapes',
  'etat',
  'ete',
  'etes',
  'etre',
  'evenement',
  'evenements',
  'executer',
  'execution',
  'hote',
  'hotes',
  'icone',
  'meme',
  'modele',
  'numero',
  'operations',
  'parametre',
  'parametres',
  'precedent',
  'pret',
  'proprietes',
  'rafraichissement',
  'repertoire',
  'requete',
  'requetes',
  'reussi',
  'reussie',
  'role',
  'roles',
  'schema',
  'securite',
  'selectionne',
  'selectionner',
  'succes',
  'superieur',
  'systeme',
  'telecharger',
  'theme',
  'verification',
  'verifier',
  'verifiez',
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

describe('the French texts', () => {
  const texts = flatten(fr);

  it('are found, so this is not vacuous', () => {
    expect(Object.keys(texts).length).toBeGreaterThan(1000);
  });

  it('have no common word without its accent', () => {
    const found = [];
    for (const [key, text] of Object.entries(texts)) {
      // Placeholders and code in backticks are not French.
      const prose = text.replace(/\{[^}]*\}/g, ' ').replace(/`[^`]*`/g, ' ');
      const m = pattern.exec(prose);
      if (m) found.push(`${key}: ${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it('catch a word without its accent', () => {
    expect(pattern.test('Aucune donnees')).toBe(true);
    expect(pattern.test('Echec de connexion')).toBe(true);
    expect(pattern.test('roles/web/tasks/main.yml')).toBe(false);
    expect(pattern.test('controller_roles:')).toBe(false);
  });
});
