// The Spanish texts carry their accents.
//
// A few texts of es.js were once typed without them ("sesion", "aplicacion", "Categoria",
// "Numero"), which reads as a typo on every screen. A word below is never right without its
// accent, so any of them standing as a whole word in a Spanish text is a regression.
// Placeholders and code in backticks are technical and left out.
import { describe, it, expect } from 'vitest';
import es from '@/locales/es';

// Common Spanish words that are only ever spelled with an accent (not those that are also a verb,
// as valida or publica).
const UNACCENTED = [
  'accion',
  'aplicacion',
  'autenticacion',
  'automatica',
  'automatico',
  'busqueda',
  'categoria',
  'categorias',
  'codigo',
  'conexion',
  'configuracion',
  'contrasena',
  'depuracion',
  'descripcion',
  'direccion',
  'ejecucion',
  'exito',
  'informacion',
  'invalido',
  'metodo',
  'numero',
  'opcion',
  'operacion',
  'publico',
  'restauracion',
  'seleccion',
  'sesion',
  'subcategoria',
  'tambien',
  'titulo',
  'ultima',
  'ultimo',
  'unica',
  'unico',
  'validacion',
  'version',
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

describe('the Spanish texts', () => {
  const texts = flatten(es);

  it('are found, so this is not vacuous', () => {
    expect(Object.keys(texts).length).toBeGreaterThan(1000);
  });

  it('have no common word without its accent', () => {
    const found = [];
    for (const [key, text] of Object.entries(texts)) {
      // Placeholders and code in backticks are not Spanish.
      const prose = text.replace(/\{[^}]*\}/g, ' ').replace(/`[^`]*`/g, ' ');
      const m = pattern.exec(prose);
      if (m) found.push(`${key}: ${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it('catch a word without its accent', () => {
    expect(pattern.test('Inicio de sesion')).toBe(true);
    expect(pattern.test('Agregar categoria')).toBe(true);
    expect(pattern.test('versiones')).toBe(false);
    expect(pattern.test('Versión')).toBe(false);
  });
});
