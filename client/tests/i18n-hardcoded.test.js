// The pages and the shared components below are seen in every language, so their words go
// through t(). A literal word in a template stays English whatever the user picked: it shipped
// that way on the sign-in page ("Please sign in", "Sign in", "or"), on the change of a default
// password, on the database setup and API docs pages, and in labels every list, dialog and
// pager carries ("No data", "Close", "Goto page 1").
//
// Also: the pages shown before anyone signs in take the instance's default language
// (DEFAULT_LANGUAGE) from /api/v2/app/config, as the pages with the header always did.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments, blocksOf } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

// ------------------------------------------------------------------
// The scan
// ------------------------------------------------------------------

// the files, whole : every word they show is checked
const FILES = [
  'pages/login.vue',
  'pages/change-password.vue',
  'pages/schema.vue',
  'pages/api-docs.vue',
  'components/AppLoginFrame.vue',
  'components/AppSkeleton.vue',
  'components/AppNav.vue',
  'components/BsInputSelectAdvancedTable.vue',
  'components/BsInputSelectAdvancedTable2.vue',
  'components/BsThemeSwitcher.vue',
  'components/BsDropdownButton.vue',
  'components/BsModal.vue',
  'components/BsOffCanvas.vue',
  'components/BsPagination.vue',
  'components/BsNavBar.vue',
  'pages/designer.vue',
];

// the attributes a user sees or a screen reader reads out
const SHOWN_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'label'];

// what may stay as it is : product names, technical tokens, addresses and an html entity, and the
// designer's technical examples (a file name, a constant's name, an image source)
const ALLOWED =
  /^(AnsibleForms|YAML|\/api\/v2\/docs|https?:\/\/\S+|&\w+;|my-forms\.yaml|CONSTANT_NAME|https:\/\/\.\.\. or data:image\/\.\.\.)$/;

/**
 * Reads the template of a component, without its comments (the user never sees those) and
 * without its interpolations (what they show is computed, a t() or a value).
 *
 * Args:
 *   file (string): the component, relative to client/src.
 *
 * Returns:
 *   string: the text between the first <template> and the last </template>.
 */
function templateOf(file) {
  // the comments first : an old template kept in a comment would end the slice inside it
  const text = withoutComments(readFileSync(path.join(src, file), 'utf8'));
  return text.slice(text.indexOf('<template>'), text.lastIndexOf('</template>')).replace(/\{\{[\s\S]*?\}\}/g, '');
}

/**
 * Reads the script of a component, without its comments.
 *
 * Args:
 *   file (string): the component, relative to client/src.
 *
 * Returns:
 *   string: the text of its <script> blocks.
 */
function scriptOf(file) {
  const text = readFileSync(path.join(src, file), 'utf8');
  return withoutComments(blocksOf(text, 'script').join('\n'), '/*', '*/').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Whether a piece of text has a word in it : two letters in a row, not an allowed name.
 *
 * Args:
 *   text (string): the text, trimmed.
 *
 * Returns:
 *   boolean: true when it would show as English.
 */
function hasWords(text) {
  return /\p{L}{2,}/u.test(text) && !ALLOWED.test(text);
}

describe('the pages and components carry no hard-coded English', () => {
  it('found the files, so this is not vacuous', () => {
    for (const file of FILES) expect(templateOf(file).length, file).toBeGreaterThan(50);
    expect(templateOf('pages/login.vue')).toContain("t('login.withMicrosoft')");
  });

  it('has no literal word between tags', () => {
    const literals = [];
    for (const file of FILES) {
      for (const m of templateOf(file).matchAll(/>([^<>]*)</g)) {
        // the interpolations are gone (templateOf) : what remains is written straight in the page
        const text = m[1].trim();
        if (hasWords(text)) literals.push(`${file}: ${text}`);
      }
    }
    expect(literals).toEqual([]);
  });

  it('has no literal word in a shown attribute', () => {
    // a bound :placeholder="t(...)" is fine; a static one with words in it is English for all
    const literals = [];
    for (const file of FILES) {
      for (const attr of SHOWN_ATTRIBUTES) {
        const pattern = new RegExp(`\\s${attr}="([^"]*)"`, 'g');
        for (const m of templateOf(file).matchAll(pattern)) {
          if (hasWords(m[1])) literals.push(`${file}: ${attr}="${m[1]}"`);
        }
      }
    }
    expect(literals).toEqual([]);
  });

  it('builds no shown attribute from an English string', () => {
    // :aria-label="'Goto page ' + n" is still English
    const literals = [];
    for (const file of FILES) {
      for (const attr of SHOWN_ATTRIBUTES) {
        const pattern = new RegExp(`\\s:${attr}="([^"]*)"`, 'g');
        for (const m of templateOf(file).matchAll(pattern)) {
          const rest = m[1].replace(/\bt\(\s*'[^']*'/g, '');
          if (/'[^']*\p{L}{2,}[^']*'/u.test(rest)) literals.push(`${file}: :${attr}="${m[1]}"`);
        }
      }
    }
    expect(literals).toEqual([]);
  });

  it('shows no English message from its script', () => {
    // a toast, the fallback of an error toast, a validation message
    const literals = [];
    const pattern =
      /(?:toast(?:\.\w+)?\(|parseAxiosResponseError\([^,]+,\s*|withMessage\()\s*(['`])([^'`]*\p{L}{2,}[^'`]*)\1/gu;
    for (const file of FILES) {
      for (const m of scriptOf(file).matchAll(pattern)) literals.push(`${file}: ${m[2]}`);
    }
    expect(literals).toEqual([]);
  });
});

// ------------------------------------------------------------------
// The language before anyone signs in
// ------------------------------------------------------------------

describe('the language of the pages shown before sign-in', () => {
  const cookie = vi.hoisted(() => ({ language: null }));
  vi.mock('@/lib/Helpers', async (importOriginal) => {
    const real = (await importOriginal()).default;
    return { default: { ...real, getCookie: (name) => (name === 'af_language' ? cookie.language : null) } };
  });

  let i18n;
  let State;
  beforeEach(async () => {
    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    i18n = (await import('@/plugins/i18n')).default;
    State = (await import('@/lib/State')).default;
    i18n.global.locale.value = 'en';
    cookie.language = null;
  });

  it("is the instance's default when this browser has chosen none", () => {
    // what the login and the database setup pages read (State.loadAppConfig)
    State.applyAppConfig({ defaultLanguage: 'de' });
    expect(i18n.global.locale.value).toBe('de');
  });

  it("is this browser's own choice when it made one", () => {
    cookie.language = 'fr';
    i18n.global.locale.value = 'fr';
    State.applyAppConfig({ defaultLanguage: 'de' });
    expect(i18n.global.locale.value).toBe('fr');
  });

  it('stays as it is for a language the app does not have', () => {
    State.applyAppConfig({ defaultLanguage: 'xx' });
    expect(i18n.global.locale.value).toBe('en');
  });
});
