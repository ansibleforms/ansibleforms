// Counted texts use plural forms, never "(s)".
//
// A few counted texts wrote both numbers at once: "{count} item(s)", "{count} user(s)",
// French "sélectionné(s)", Polish "element(y)" and "użytkownik(ów)", Italian "elemento/i",
// Portuguese "item(ns)" and "pode(m)". They are now written with their plural forms
// (" | " between them, lib/Plural.js picks one by the language's own rule), and the code
// passes the count as the plural choice, so "Delete 1 item?" and "Delete 3 items?" read
// right, and Polish says 1 element, 2 elementy, 5 elementów.
import { describe, it, expect } from 'vitest';
import { createI18n } from 'vue-i18n';
import { pluralRules } from '@/lib/Plural';

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

const messages = {};
for (const lang of LANGS) messages[lang] = (await import(`../src/locales/${lang}.js`)).default;

// a word ending in a bracketed or slashed plural ending : item(s), utente/i, element(y),
// użytkownik(ów), pode(m), está(ão) ; a bracket after a space ("(optional)") is not one
const PAREN_PLURAL = /\p{L}\((s|es|e|en|n|ns|m|y|i|a|ów|ão)\)|\p{L}\/(i|e|s)(?!\p{L})/u;

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages,
  pluralRules: pluralRules(LANGS),
});

/**
 * Translates in a given language.
 *
 * Args:
 *   lang (string): the language code.
 *   args: the arguments of t().
 *
 * Returns:
 *   string: the translation.
 */
function t(lang, ...args) {
  i18n.global.locale.value = lang;
  return i18n.global.t(...args);
}

describe('the counted texts', () => {
  it.each(LANGS)('in %s have no "(s)" style plural', (lang) => {
    const found = Object.entries(flatten(messages[lang]))
      .filter(([, v]) => PAREN_PLURAL.test(v.replace(/\{[^}]*\}/g, ' ')))
      .map(([k, v]) => `${k}: ${v}`);
    expect(found).toEqual([]);
  });

  it('catch a "(s)" style plural', () => {
    expect(PAREN_PLURAL.test('Delete 3 item(s)?')).toBe(true);
    expect(PAREN_PLURAL.test('Usunąć 3 element(y)?')).toBe(true);
    expect(PAREN_PLURAL.test('3 użytkownik(ów)')).toBe(true);
    expect(PAREN_PLURAL.test('Eliminare 3 elemento/i?')).toBe(true);
    expect(PAREN_PLURAL.test('Name (optional)')).toBe(false);
    expect(PAREN_PLURAL.test('and/or')).toBe(false);
  });

  it('read right for one and for several in English', () => {
    expect(t('en', 'settings.common.bulkDeleteConfirm', { count: 1 }, 1)).toBe('Delete 1 item?');
    expect(t('en', 'settings.common.bulkDeleteConfirm', { count: 3 }, 3)).toBe('Delete 3 items?');
    expect(t('en', 'settings.common.bulkDeleteSkipped', { skipped: 1 }, 1)).toBe(
      '1 selected item cannot be deleted and is left alone.',
    );
    expect(t('en', 'jobs.deleteSelectedConfirm', { count: 1 }, 1)).toBe('Delete 1 selected job?');
    expect(t('en', 'jobs.deleteSelectedConfirm', { count: 4 }, 4)).toBe('Delete 4 selected jobs?');
    expect(t('en', 'jobs.deletedSelected', { count: 1 }, 1)).toBe('1 job deleted');
    expect(t('en', 'settings.disclaimer.askAgainConfirm', { count: 2 }, 2)).toMatch(/^Ask 2 users /);
    expect(t('en', 'settings.disclaimer.askAgainConfirm', { count: 1 }, 1)).toMatch(/^Ask 1 user /);
    expect(t('en', 'dataTable.selected', 5)).toBe('5 selected');
  });

  it('read right for one, a few and many in Polish', () => {
    const del = (n) => t('pl', 'settings.common.bulkDeleteConfirm', { count: n }, n);
    expect(del(1)).toBe('Usunąć 1 element?');
    expect(del(3)).toBe('Usunąć 3 elementy?');
    expect(del(5)).toBe('Usunąć 5 elementów?');
    expect(del(22)).toBe('Usunąć 22 elementy?');
    const done = (n) => t('pl', 'settings.disclaimer.askAgainDone', { count: n }, n);
    expect(done(1)).toMatch(/^1 użytkownik zaakceptuje /);
    expect(done(2)).toMatch(/^2 użytkownicy zaakceptują /);
    expect(done(12)).toMatch(/^12 użytkowników zaakceptuje /);
    expect(t('pl', 'dataTable.selected', 1)).toBe('1 zaznaczony');
    expect(t('pl', 'dataTable.selected', 4)).toBe('4 zaznaczone');
    expect(t('pl', 'dataTable.selected', 7)).toBe('7 zaznaczonych');
  });
});
