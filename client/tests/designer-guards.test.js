// The designer's lock, address and save guards.
//
// Read from the page source, like the other designer tests : the guards live inside
// <script setup> closures that depend on the whole designer state.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src/pages/designer.vue'), 'utf8');
const fnAt = (name, len) => src.slice(src.indexOf(name), src.indexOf(name) + len);

describe('the designer lock', () => {
  it('keeps every YAML editor read-only without the lock', () => {
    // they were read-only only for a templated config : losing the lock race left them editable
    const editors = src.match(/type="editor"\s*\n\s*:readonly="[^"]*"/g) || [];
    const yaml = editors.filter((e) => e.includes('canDesignForms'));
    expect(yaml.length).toBe(3);
    yaml.forEach((e) => expect(e).toMatch(/!lock\?\.match/));
  });

  it('reads the lock back when taking or releasing it fails', () => {
    expect(src).not.toMatch(/lock\.value = undefined;/);
    const set = src.slice(src.indexOf('async function setLock'), src.indexOf('async function restoreBackup'));
    expect(set).toMatch(/catch \(err\) \{[\s\S]*await loadLock\(\);/);
  });

  it('does not take back a lock an admin released', () => {
    const load = fnAt('async function loadLock', 1400);
    expect(load).toMatch(/lock\.value\?\.released/);
    expect(load).toMatch(/t\('designer\.lockReleasedBy'/);
  });
});

describe('the designer address', () => {
  it('Back and Forward open the form the address names', () => {
    const watcher = fnAt('() => route.path,', 2400);
    expect(watcher).toMatch(/address\.form/);
    expect(watcher).toMatch(/currentForm\.value = f\.id/);
  });
});

describe('saving the forms', () => {
  it('has an in-flight flag that keeps a second save out', () => {
    expect(src).toMatch(/const saving = ref\(false\);/);
    expect(src).toMatch(/const busy = computed\(\(\) => [^)]*saving\.value\)/);
    const save = fnAt('async function saveForms', 4000);
    expect(save).toMatch(/if \(busy\.value\) return;/);
    expect(save).toMatch(/saving\.value = true;/);
    expect(save).toMatch(/finally \{\s*saving\.value = false;/);
  });

  it('the Restore button leaves the confirm flow to restoreBackup', () => {
    expect(src).not.toMatch(/restoreBackup\(\);\s*resetAction\(\);/);
  });
});

describe('a read-only subform (designAllForms off)', () => {
  // the server keeps it as stored : a delete or a move in the designer would be said saved, and be
  // back on the next load
  const body = (name) => {
    const start = src.indexOf(name);
    return src.slice(start, src.indexOf('\n}\n', start));
  };

  it('is never deleted nor moved, by its row, its menu or a drag', () => {
    expect(body('function deleteForm(')).toMatch(/refusedReadOnly\(readOnlyForm\(id\)\)/);
    expect(body('function onDragStart(')).toMatch(/if \(readOnlyForm\(id\)\) \{\s*event\.preventDefault\(\);/);
    expect(body('function ctxMoveToFile(')).toMatch(/refusedReadOnly\(readOnlyForm\(/);
    expect(src).toContain(':draggable="!readOnlyForm(n.id)"');
    expect(src).toMatch(/v-if="!readOnlyForm\(n\.id\)"\s+role="button"\s+class="tree-del-btn/);
    expect(src).toMatch(/'ctx-item-disabled': readOnlyForm\(ctxMenu\.target\?\.id\) \}"\s+@click="ctxMoveToFile\(\)"/);
    expect(src).toMatch(
      /'ctx-item-disabled': readOnlyForm\(ctxMenu\.target\?\.id\) \}"\s+@click="ctxDeleteFormFromMenu\(\)"/,
    );
  });

  it('keeps the file and the folder holding it : not renamed, moved nor deleted', () => {
    for (const fn of ['function ctxRenameFile(', 'function confirmDeleteFile(', 'function ctxMoveFileToFolder(']) {
      expect(body(fn)).toMatch(/refusedReadOnly\(fileHoldsReadOnly\(source\)\)/);
    }
    expect(body('function confirmDeleteFolder(')).toMatch(/refusedReadOnly\(folderHoldsReadOnly\(folder\)\)/);
  });

  it('says it is read only on the Visual tab as on the YAML tab', () => {
    const notices = src.match(/<div v-if="formReadOnly" class="alert alert-secondary py-2 mb-2">/g) || [];
    expect(notices.length).toBe(2);
    const visual = src.slice(src.indexOf('editorView === \'visual\'" class="designer-visual">'));
    expect(visual.indexOf('formReadOnly')).toBeLessThan(visual.indexOf('<AppFormVisualEditor'));
  });
});
