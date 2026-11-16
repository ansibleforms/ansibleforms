// Every Designer section with an explorer opens on the first item it lists, through the same
// helper (config/fileExplorer.js firstExplorerFile) : the files and the forms
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { firstExplorerFile } from '../src/config/fileExplorer';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '..', 'src', f), 'utf8');

describe('the first item a section opens on', () => {
  it('is the first the explorer lists : folders first, then by name', () => {
    expect(firstExplorerFile(['b.yaml', 'a/z.yaml', 'a.yaml'])).toBe('a/z.yaml');
    expect(firstExplorerFile(['team-b/x.yaml', 'team-a/z.yaml', 'team-a/y.yaml'])).toBe('team-a/y.yaml');
    expect(firstExplorerFile([])).toBe(null);
  });

  it('the files and the forms both ask the same helper', () => {
    for (const f of ['components/AppProjectFiles.vue', 'pages/designer.vue']) {
      expect(read(f), f).toContain('firstExplorerFile(');
    }
  });
});
