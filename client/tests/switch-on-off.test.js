// A switch with no words beside it says where it stands : BsSwitch puts "On" or "Off" beside it,
// changing as it is flipped, or a text of one's own. Every switch of the app that had nothing
// beside it is a BsSwitch now : a `role="switch"` input of a page or a component always has a
// label beside it, outside BsSwitch itself. The two words are in every language.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { withoutComments, blocksOf } from './vueSource';

const root = resolve(__dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const LOCALES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

/**
 * Every .vue file under a folder, with its path from the client's root.
 *
 * Args:
 *   dir (string): the folder, from the client's root.
 *
 * Returns:
 *   string[]: the paths of its .vue files, in its sub folders too.
 */
function vueFiles(dir) {
  const out = [];
  for (const name of readdirSync(resolve(root, dir))) {
    const path = join(dir, name);
    if (statSync(resolve(root, path)).isDirectory()) out.push(...vueFiles(path));
    else if (name.endsWith('.vue')) out.push(relative(root, resolve(root, path)));
  }
  return out;
}

/**
 * The markup of a .vue file, without its comments : the file with its script and style blocks
 * cut out (its template holds nested <template> tags, which a search by tag would stop at).
 *
 * Args:
 *   path (string): the file, from the client's root.
 *
 * Returns:
 *   string: its markup.
 */
function templateOf(path) {
  let text = read(path);
  for (const tag of ['script', 'style']) {
    for (const block of blocksOf(text, tag)) text = text.replace(block, '');
  }
  return withoutComments(text);
}

/**
 * Every Bootstrap switch block of a template : from a `form-switch` div to its own closing tag,
 * the divs nested in it counted.
 *
 * Args:
 *   template (string): the template.
 *
 * Returns:
 *   string[]: the blocks.
 */
function switchBlocks(template) {
  const blocks = [];
  const opening = /<div\b[^>]*form-switch[^>]*>/g;
  let m;
  while ((m = opening.exec(template))) {
    let depth = 1;
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = m.index + m[0].length;
    let t;
    while (depth && (t = tags.exec(template))) depth += t[0] === '</div>' ? -1 : 1;
    blocks.push(template.slice(m.index, t ? t.index + t[0].length : template.length));
  }
  return blocks;
}

/**
 * The value of a key of a locale's `common` block.
 *
 * Args:
 *   locale (string): the language code.
 *   key (string): the key in `common`.
 *
 * Returns:
 *   string|undefined: its text, when found.
 */
function commonText(locale, key) {
  const src = read(`src/locales/${locale}.js`);
  const block = src.slice(src.indexOf('\n  common: {'));
  return new RegExp(`\\n    ${key}: '([^']*)'`).exec(block)?.[1];
}

const sw = read('src/components/BsSwitch.vue');
const swTemplate = templateOf('src/components/BsSwitch.vue');
const files = [...vueFiles('src/components'), ...vueFiles('src/pages')].filter((f) => !f.endsWith('BsSwitch.vue'));

// ------------------------------------------------------------------
// the component
// ------------------------------------------------------------------
describe('BsSwitch', () => {
  it('renders a Bootstrap switch with its label beside it, bound to its id', () => {
    expect(swTemplate).toMatch(/<div class="form-check form-switch"/);
    expect(swTemplate).toMatch(/class="form-check-input"/);
    expect(swTemplate).toMatch(/type="checkbox"/);
    expect(swTemplate).toMatch(/role="switch"/);
    expect(swTemplate).toMatch(/:id="inputId"/);
    expect(swTemplate).toMatch(/<label class="form-check-label" :for="inputId">\{\{ word \}\}<\/label>/);
    // an id of its own when none is given
    expect(sw).toMatch(/props\.id \|\| ownId/);
  });

  it('says On when checked and Off when not, or the text given', () => {
    expect(sw).toMatch(/props\.label \|\| \(model\.value \? t\('common\.switchOn'\) : t\('common\.switchOff'\)\)/);
  });

  it('follows its v-model : checked by it, and setting it as it is flipped', () => {
    expect(sw).toMatch(/const model = defineModel\(/);
    expect(swTemplate).toMatch(/:checked="!!model"/);
    expect(swTemplate).toMatch(/@change="onChange"/);
    expect(sw).toMatch(/model\.value = event\.target\.checked/);
  });

  it('is disabled by its prop, the word after the input so that Bootstrap mutes it', () => {
    expect(swTemplate).toMatch(/:disabled="disabled"/);
    expect(swTemplate.indexOf('<input')).toBeLessThan(swTemplate.indexOf('<label'));
  });

  it('passes its class and style to its block and every other attribute to the input', () => {
    expect(sw).toMatch(/inheritAttrs: false/);
    expect(swTemplate).toMatch(/form-switch" v-bind="blockAttrs"/);
    expect(swTemplate).toMatch(/v-bind="inputAttrs"/);
  });
});

// ------------------------------------------------------------------
// the switches of the app
// ------------------------------------------------------------------
describe('every switch of the app', () => {
  it('has a label beside it, outside BsSwitch', () => {
    const bare = [];
    for (const f of files) {
      for (const block of switchBlocks(templateOf(f))) {
        if (!block.includes('form-check-label')) bare.push(`${f}: ${block.slice(0, 80)}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('never leaves a role="switch" input outside a switch block with a label', () => {
    const loose = [];
    for (const f of files) {
      const template = templateOf(f);
      const count = (template.match(/role="switch"/g) || []).length;
      const labelled = switchBlocks(template)
        .filter((b) => b.includes('form-check-label'))
        .reduce((n, b) => n + (b.match(/role="switch"/g) || []).length, 0);
      if (count !== labelled) loose.push(f);
    }
    expect(loose).toEqual([]);
  });

  it('is a BsSwitch where it had nothing beside it', () => {
    const expected = {
      'src/components/AppAdminMulti.vue': 1,
      'src/components/AppAdminSingle.vue': 3,
      'src/components/AppEnvField.vue': 1,
      'src/components/AppFormVisualEditor.vue': 4,
      'src/components/AppScheduleEnd.vue': 1,
      'src/components/AppVarsEditor.vue': 1,
      'src/pages/admin/announcement.vue': 1,
      'src/pages/admin/directory-user.vue': 1,
      'src/pages/admin/disclaimer-version.vue': 1,
      'src/pages/admin/label.vue': 1,
      'src/pages/admin/links.vue': 1,
      'src/pages/admin/notification-channel.vue': 2,
      'src/pages/admin/runner.vue': 2,
      'src/pages/admin/sso-provider.vue': 1,
      'src/pages/admin/syslog-server.vue': 1,
      'src/pages/admin/user.vue': 1,
      'src/pages/profile.vue': 1,
      'src/pages/schedule.vue': 1,
    };
    for (const [f, n] of Object.entries(expected)) {
      expect((templateOf(f).match(/<BsSwitch\b/g) || []).length, f).toBe(n);
      expect(read(f), f).toMatch(/import BsSwitch from '(\.\/|@\/components\/)BsSwitch\.vue';/);
    }
  });

  it('keeps the ids the titles above point at', () => {
    const ids = {
      'src/pages/admin/runner.vue': ['af-runner-default', 'af-runner-enabled'],
      'src/pages/admin/notification-channel.vue': ['af-channel-enabled', 'af-channel-active'],
      'src/pages/admin/user.vue': ['af-sign-in'],
      'src/pages/schedule.vue': ['af-schedule-enabled'],
      'src/pages/profile.vue': ['af-job-notifications'],
      'src/components/AppFormVisualEditor.vue': ['af-notif', 'af-appr'],
    };
    for (const [f, list] of Object.entries(ids)) {
      const template = templateOf(f);
      for (const id of list) {
        expect(template, `${f} ${id}`).toMatch(new RegExp(`<BsSwitch[^>]*\\bid="${id}"`));
        expect(template, `${f} ${id}`).toMatch(new RegExp(`for="${id}"`));
      }
    }
  });
});

// ------------------------------------------------------------------
// the words
// ------------------------------------------------------------------
describe('the words On and Off', () => {
  it('are in every language, one short word each', () => {
    for (const locale of LOCALES) {
      for (const key of ['switchOn', 'switchOff']) {
        const text = commonText(locale, key);
        expect(text, `${locale} ${key}`).toBeTruthy();
        expect(text, `${locale} ${key}`).not.toMatch(/\s/);
        expect(text.length, `${locale} ${key}`).toBeLessThanOrEqual(12);
      }
    }
    expect(commonText('en', 'switchOn')).toBe('On');
    expect(commonText('en', 'switchOff')).toBe('Off');
  });
});
