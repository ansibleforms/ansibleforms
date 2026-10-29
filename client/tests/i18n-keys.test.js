// Every t('some.key') in the source must exist in every locale.
//
// vue-i18n renders a key it does not know as the key ITSELF, so a missing entry is not a
// crash and not a lint error - it is the literal string `errors.requiredFields` appearing
// in a toast, in every language. That is exactly how it shipped: the key existed in the
// SERVER locales only, and the settings page used it for a client-side validation message.
//
// This scans the real source rather than a list, so a key added tomorrow is covered.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const maps = {};
for (const lang of LANGS) {
  const mod = await import(`../src/locales/${lang}.js`);
  maps[lang] = flatten(mod.default);
}

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|locales/.test(p)) sourceFiles(p, acc);
    } else if (/\.(vue|js)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

// Keys assembled at runtime by string concatenation. A plain scan cannot see them, so they
// are checked separately below against the lists they are built from.
const CONCATENATED = /^(settings\.settingsPage\.roleOption|health\.check|health\.info)$/;

describe('every translated key used in the source exists', () => {
  const files = sourceFiles(path.join(root, 'src'));

  it('found the source, so this is not vacuous', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(Object.keys(maps.en).length).toBeGreaterThan(500);
  });

  it('has no key that is missing from en', () => {
    const missing = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*['`]([A-Za-z0-9_.]+)['`]/g)) {
        const key = m[1];
        // a bare word is a variable or an unrelated t(), not a message path
        if (!key.includes('.')) continue;
        if (CONCATENATED.test(key)) continue;
        if (maps.en[key] === undefined) missing.push(`${key}  (${path.relative(root, file)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('and every en key exists in all the other locales', () => {
    const gaps = [];
    for (const key of Object.keys(maps.en)) {
      for (const lang of LANGS.slice(1)) {
        if (maps[lang][key] === undefined) gaps.push(`${lang}: ${key}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe('keys built by concatenation are covered too', () => {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const read = (p) => readFileSync(path.join(root, '..', p), 'utf8');

  it('every role option has a description (its (i) on the role page, the profile)', () => {
    const roles = read('client/src/config/roles.js');
    const block = roles.slice(
      roles.indexOf('export const roleOptionKeys'),
      roles.indexOf('];', roles.indexOf('export const roleOptionKeys')),
    );
    const keys = [...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    const gaps = [];
    for (const k of keys)
      for (const lang of LANGS) {
        const key = `profilePage.optionDescription.${k}`;
        if (maps[lang][key] === undefined) gaps.push(`${lang}: ${key}`);
      }
    expect(gaps).toEqual([]);
  });

  it('every role option has a label', () => {
    const roles = read('client/src/config/roles.js');
    const block = roles.slice(
      roles.indexOf('export const roleOptionKeys'),
      roles.indexOf('];', roles.indexOf('export const roleOptionKeys')),
    );
    const keys = [...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBe(35);
    const gaps = [];
    for (const k of keys)
      for (const lang of LANGS) {
        const key = `settings.settingsPage.roleOption${cap(k)}`;
        if (maps[lang][key] === undefined) gaps.push(`${lang}: ${key}`);
      }
    expect(gaps).toEqual([]);
  });

  it('every health check and info row has a label', () => {
    // derived from the model that emits them, so adding a row without a label fails here
    const health = read('server/src/models/health.model.js');
    const checks = [...health.matchAll(/safely\('([A-Za-z]+)'/g)].map((m) => m[1]);
    const infos = [...new Set([...health.matchAll(/\badd\('([A-Za-z]+)'/g)].map((m) => m[1]))];
    expect(checks.length).toBeGreaterThan(10);
    expect(infos.length).toBeGreaterThan(10);
    const gaps = [];
    for (const [prefix, list] of [
      ['check', checks],
      ['info', infos],
    ]) {
      for (const k of list)
        for (const lang of LANGS) {
          const key = `health.${prefix}${cap(k)}`;
          if (maps[lang][key] === undefined) gaps.push(`${lang}: ${key}`);
        }
    }
    expect(gaps).toEqual([]);
  });
});

// The Run later, schedule and store panels of the form page are seen by every user who runs a
// form, so their words must go through t(). A literal sentence in the template stays English
// whatever the user picked (it shipped that way: "Select the date and time to run this job
// once" under the Run later picker).
describe('the form page panels carry no hard-coded English', () => {
  const src = readFileSync(path.join(root, 'src/pages/form.vue'), 'utf8');
  // only the template is rendered text; comments are not shown to the user
  const template = withoutComments(src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>')));
  // the panels, from the schedule off-canvas to the end of the store off-canvas
  const start = template.indexOf(':show="showScheduleOffcanvas"');
  const end = template.indexOf('</BsOffCanvas>', template.indexOf(':show="showStoreOffcanvas"'));
  const panels = template.slice(start, end);

  it('found both panels, so this is not vacuous', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(panels).toContain("t('form.runAt')");
  });

  it('has no literal word between tags', () => {
    const literals = [];
    for (const m of panels.matchAll(/>([^<>]*)</g)) {
      // drop the interpolations; what remains is text written straight into the page
      const text = m[1].replace(/\{\{[\s\S]*?\}\}/g, '').trim();
      if (/[A-Za-z]{2,}/.test(text)) literals.push(text);
    }
    expect(literals).toEqual([]);
  });

  it('has no literal placeholder', () => {
    // a bound :placeholder is fine, a static one with words in it is English for everybody
    const literals = [...panels.matchAll(/\splaceholder="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((v) => /[A-Za-z]{2,}/.test(v));
    expect(literals).toEqual([]);
  });

  it('and its bound placeholders are no English strings either', () => {
    const literals = [...panels.matchAll(/:placeholder="([^"]*)"/g)]
      .map((m) => m[1])
      // what t() translates is fine; a quoted sentence or name left over is not
      .map((v) => v.replace(/\bt\(\s*'[^']*'\s*\)/g, ''))
      .filter((v) => /'[^']*\s[^']*'|'[A-Z][a-z]/.test(v));
    expect(literals).toEqual([]);
  });
});
