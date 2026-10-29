import { createI18n } from 'vue-i18n';
import en from '@/locales/en.js';
import nl from '@/locales/nl.js';
import fr from '@/locales/fr.js';
import it from '@/locales/it.js';
import de from '@/locales/de.js';
import es from '@/locales/es.js';
import ca from '@/locales/ca.js';
import pt from '@/locales/pt.js';
import ja from '@/locales/ja.js';
import zh from '@/locales/zh.js';
import pl from '@/locales/pl.js';
import Helpers from '@/lib/Helpers';
import { pluralRules } from '@/lib/Plural';

// Get language from cookie (set later from server default if no cookie exists)
const savedLocale = Helpers.getCookie('af_language') || 'en';

// the loaded locales, keyed by language code (config/languages.js lists them for the UI)
const messages = {
  en,
  nl,
  fr,
  it,
  de,
  es,
  ca,
  pt,
  ja,
  zh,
  pl,
};

const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: 'en',
  messages,
  // counted texts ("{n} file | {n} files") : each language's own plural forms (lib/Plural.js)
  pluralRules: pluralRules(Object.keys(messages)),
});

/**
 * Set the default language from server config (called after app/config fetch).
 * Only applies if the user has not explicitly chosen a language (no cookie).
 *
 * The language of a page is therefore, in this order : the af_language cookie (picked in the
 * header or on the profile page), the instance's default (DEFAULT_LANGUAGE, else Settings, read
 * by State.applyAppConfig on every page, the sign-in page too), then English.
 *
 * Args:
 *   defaultLang (string): the instance's default language code ; an unknown or empty one
 *     changes nothing.
 */
export function applyDefaultLanguage(defaultLang) {
  if (!Helpers.getCookie('af_language') && defaultLang && Object.keys(messages).includes(defaultLang)) {
    i18n.global.locale.value = defaultLang;
  }
}

export default i18n;
