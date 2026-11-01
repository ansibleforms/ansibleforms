// The version beside About in the help menu : the meta grey (af-menu-meta) stayed dark when the row
// was pressed and its text turned white. It takes the row's own colour at all times.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const nav = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/AppNav.vue'),
  'utf8',
);

describe('the version beside About', () => {
  it('has a class of its own, not the grey meta one', () => {
    expect(nav).toMatch(/<span class="ms-auto ps-3 af-menu-version">v\{\{ store\.version \}\}<\/span>/);
    expect(nav).not.toMatch(/af-menu-meta">v\{\{ store\.version/);
  });

  it("takes the row's colour, smaller", () => {
    const rule = /\.af-menu-version \{([^}]*)\}/.exec(nav)?.[1] || '';
    expect(rule).toMatch(/color: inherit;/);
    expect(rule).toMatch(/font-size: 0\.85rem;/);
  });
});
