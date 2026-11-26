// Every Designer section with an explorer opens on the first item it lists, through the same
// helper (config/fileExplorer.js firstExplorerFile) : the files, the forms, the RTE images
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { firstExplorerFile, openFirstExplorerItem } from '../src/config/fileExplorer';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '..', 'src', f), 'utf8');

describe('the first item a section opens on', () => {
  it('is the first the explorer lists : folders first, then by name', () => {
    expect(firstExplorerFile(['b.yaml', 'a/z.yaml', 'a.yaml'])).toBe('a/z.yaml');
    expect(firstExplorerFile(['team-b/rte-x', 'team-a/rte-z', 'team-a/rte-y'])).toBe('team-a/rte-y');
    expect(firstExplorerFile([])).toBe(null);
  });

  it('the files and the RTE images open it through the same helper, the forms pick it with it', () => {
    for (const f of ['components/AppProjectFiles.vue', 'components/AppRteImages.vue']) {
      expect(read(f), f).toContain('openFirstExplorerItem(');
    }
    expect(read('pages/designer.vue')).toContain('firstExplorerFile(');
  });

  it('opens nothing over an item open already, else the first through the section own open', async () => {
    const opened = [];
    const open = (p) => opened.push(p);
    expect(await openFirstExplorerItem({ isOpen: () => true, paths: ['a.yaml'], open })).toBe(null);
    expect(await openFirstExplorerItem({ isOpen: () => false, paths: ['b.yaml', 'a.yaml'], open })).toBe('a.yaml');
    expect(opened).toEqual(['a.yaml']);
  });
});
