// The designer's Inventories tab for a designer without the connections settings.
//
// A new inventory is a new repository : the tab mounts the repositories' New dialog
// (AppAdminMulti), which reads /api/v2/repository/ and /api/v2/credential/. Both answer 403
// without showSettings or showConnectionsSettings, loadList returned undefined and the dialog's
// `[{...}, ...list]` threw "TypeError: t is not iterable" on every visit of the tab.
//
// Read from the sources, like the other designer tests : the code lives inside <script setup>
// closures that depend on the whole page state.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(here, '..', file), 'utf8');
const designer = read('src/pages/designer.vue');
const multi = read('src/components/AppAdminMulti.vue');
const files = read('src/components/AppProjectFiles.vue');

describe('an admin list that cannot be read', () => {
  it('loadList gives an empty list, never undefined', () => {
    // every caller spreads or filters the list : undefined threw in each of them
    const fn = multi.slice(multi.indexOf('async function loadList'), multi.indexOf('const loadingItem'));
    const failed = fn.slice(fn.indexOf('} catch (err) {'));
    expect(failed).toMatch(/toast\.error\([\s\S]*return \[\];\s*\}\s*\}/);
  });
});

describe('a new inventory needs the repositories', () => {
  it('is offered only to a user who may open the repositories', () => {
    const allowed = designer.slice(designer.indexOf('const canCreateInventories'));
    expect(allowed.slice(0, allowed.indexOf(';\n'))).toMatch(
      /canDesignFiles\('inventories'\) && mayOpen\('\/settings\/repositories', store\.profile\?\.options\)/,
    );
  });

  it('mounts the repositories dialog only for that user', () => {
    expect(designer).toMatch(
      /<AppAdminMulti\s+v-if="currentTab === 'Inventories' && canCreateInventories"\s+ref="inventoryRepoDialog"/,
    );
  });

  it('keeps the New buttons of the tab off without it', () => {
    // the toolbar's New and the explorer's own button
    const actions = designer.slice(designer.indexOf("key: 'newFile',"));
    expect(actions.slice(0, actions.indexOf('},'))).toMatch(
      /disabled: f\.busy \|\| readOnly \|\| \(inventories && !canCreateInventories\.value\)/,
    );
    expect(designer).toMatch(/:canCreateInventories="canCreateInventories"/);
    expect(files).toMatch(/canCreateInventories: \{ type: Boolean, default: true \}/);
    expect(files).toMatch(/<template v-if="!readOnly && isInventories && canCreateInventories">/);
    // and the other sections' New folder and New file do not take its place
    expect(files).toMatch(/<template v-else-if="!readOnly && !isInventories">/);
    const start = files.slice(files.indexOf('function startCreate'));
    expect(start.slice(0, start.indexOf('\n}\n'))).toMatch(/if \(!props\.canCreateInventories\) return;/);
  });
});
