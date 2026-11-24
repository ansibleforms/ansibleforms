// The forms page's tiles (pages/index.vue).
//
// A category click or a search filters the forms already loaded. The tiles faded in and out
// in a TransitionGroup : the leaving ones kept their place while they faded, so a tile shown
// in both lists stayed on the right for a moment, then jumped to the left. The tiles now show
// at once, in their places.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '../src/pages/index.vue'), 'utf8');

describe('forms page tiles', () => {
  it('draws the tiles without a transition group', () => {
    expect(page).not.toMatch(/<TransitionGroup/);
  });
});
