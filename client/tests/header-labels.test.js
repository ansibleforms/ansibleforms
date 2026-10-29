// The labels beside the header's logo (AppLabels : Settings > Appearance > Labels) never cover
// the menu links. The links are placed by AppNav's fitPrimaryNav, measured from where the left
// side ends : it must find the labels by the class AppLabels gives them (it looked for the old
// single label's class, found nothing, and centred the links over four labels at 1400px). And
// when the room is short the labels give way : narrower pills, their names cut short with an
// ellipsis, whole in their tooltip ; on a phone between the logo and the toggler.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blocksOf, withoutComments } from './vueSource.js';

const read = (file) => readFileSync(join(import.meta.dirname, '../src/components', file), 'utf8');
const labels = read('AppLabels.vue');
const nav = read('AppNav.vue');
const bar = read('BsNavBar.vue');

// the body of a css rule in a style block, found by its selector
const rule = (css, selector) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};
const labelsCss = withoutComments(blocksOf(labels, 'style').join('\n'), '/*', '*/');
const barCss = withoutComments(blocksOf(bar, 'style').join('\n'), '/*', '*/');

describe('the header labels and the menu links', () => {
  it('measures the left side up to the labels, by the class AppLabels renders', () => {
    // the class of the labels' outer element
    const template = withoutComments(blocksOf(labels, 'template')[0]);
    const outer = template.match(/<span[^>]*class="([^"]+)"/)?.[1].split(/\s+/)[0];
    expect(outer).toBe('af-labels');
    // fitPrimaryNav finds them by that class
    const script = withoutComments(withoutComments(blocksOf(nav, 'script').join('\n'), '/*', '*/'), '//', '\n');
    const fit = script.slice(script.indexOf('function fitPrimaryNav'), script.indexOf('const refit'));
    expect(fit).toContain(`querySelector('.${outer}')`);
    expect(fit).not.toContain('.af-env-label');
  });

  it('lets the labels shrink and cuts their names short with an ellipsis', () => {
    // what has no room even then is cut off at their right edge, never drawn over the links
    expect(rule(labelsCss, '.af-labels')).toContain('min-width: 0');
    expect(rule(labelsCss, '.af-labels')).toMatch(/overflow(-x)?: (hidden|clip)/);
    expect(rule(labelsCss, '.af-label')).toContain('min-width: 0');
    const name = rule(labelsCss, '.af-label .af-pill-label');
    expect(name).toContain('min-width: 0');
    expect(name).toContain('white-space: nowrap');
    expect(name).toContain('text-overflow: ellipsis');
    expect(name).toMatch(/overflow(-x)?: (hidden|clip)/);
    // the +N pill stays whole
    expect(rule(labelsCss, '.af-label-more')).toContain('flex-shrink: 0');
  });

  it('shows a label whole in its tooltip', () => {
    // the pill drawn for each label (v-for ... in labels.slice) carries its name as its title
    const pill = labels.slice(labels.indexOf('v-for="(l, i)'), labels.indexOf('<span class="af-pill-label"'));
    expect(pill).toContain(':title="l.name"');
  });

  it('keeps the labels between the logo and the toggler on a phone', () => {
    const phone = rule(barCss, '.af-header-inner > .af-labels');
    expect(phone).toContain('flex: 1 1 0');
  });
});
