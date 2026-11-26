// Designer fixes that are structural rather than behavioural, so they are pinned by
// reading the source. Each assertion was checked by putting the bug back.
import { describe, it, expect } from 'vitest';
import { DESIGNER_TABS, designerAddressExists } from '@/config/designerTabs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');
const designer = read('src/pages/designer.vue');

describe('a save must not reorder the forms files', () => {
  // formsObj assembles what gets written. It used to call formnames(), the DISPLAY
  // ordering, whose fallback sorts alphabetically - so opening the designer and saving
  // without touching anything rewrote every forms file with its forms alphabetised. On a
  // repository-backed config that is a whole-file diff on every save.
  it('the save path does not use the display ordering', () => {
    const formsObj = designer.slice(
      designer.indexOf('const formsObj = computed'),
      designer.indexOf('const idmapping = computed'),
    );
    expect(formsObj).toContain('formIdsForSave');
    expect(formsObj).not.toMatch(/formnames\(/);
  });

  it('the save ordering falls back to document order, not alphabetical', () => {
    const fn = designer.slice(designer.indexOf('function formIdsForSave'), designer.indexOf('function formnames'));
    expect(fn).toContain('items.map((x) => x.id)');
    // localeCompare / > comparisons belong to the display path only
    expect(fn).not.toContain('localeCompare');
    expect(fn).not.toContain('toLowerCase');
  });

  it('the display path may still sort alphabetically', () => {
    const fn = designer.slice(designer.indexOf('function formnames'), designer.indexOf('async function loadAll'));
    expect(fn).toContain('toLowerCase');
  });
});

describe('the drag order does not survive a reload', () => {
  // form ids are POSITIONAL (form_0, form_1, ...) so the next load reuses them. A stale
  // map therefore applied one document's ordering to a different one.
  it('loadForms resets formOrderMap', () => {
    const fn = designer.slice(
      designer.indexOf('async function loadForms'),
      designer.indexOf('async function loadLock'),
    );
    expect(fn).toMatch(/formOrderMap\.value\s*=\s*\{\}/);
  });
});

describe('the roles are edited in settings, not in the designer', () => {
  // they are edited in Settings > Roles : the designer's copy, read at its start, must never
  // go back over a role changed there meanwhile
  const start = designer.indexOf('async function saveForms');
  const fn = designer.slice(start, designer.indexOf('\n}\n', start));

  it('found the function, so these assertions are not vacuous', () => {
    expect(fn).toContain('assembleForms()');
  });

  it('re-reads the stored roles before it assembles what it saves', () => {
    const reread = fn.indexOf('roles.value = YAML.stringify((await Form.loadAll()).roles)');
    expect(reread).toBeGreaterThan(-1);
    expect(reread).toBeLessThan(fn.indexOf('assembleForms()'));
  });

  it('has no roles section any more', () => {
    expect(designer).not.toMatch(/name: 'Roles'/);
  });
});

describe('the lock switch follows the real lock state', () => {
  // :checked is one way, so a cancelled confirmation or a failed request left the box
  // flipped while the lock was untouched - the designer read "Locked by me" with no lock
  // and the next save answered 423 for no visible reason.
  it('the change handler puts the DOM back', () => {
    const fn = designer.slice(
      designer.indexOf('function onLockToggle'),
      designer.indexOf('async function releaseLock'),
    );
    expect(fn).toMatch(/event\.target\.checked = held/);
  });

  it('the template routes both the input and the label through it', () => {
    expect(designer).toMatch(/type="checkbox"[^>]*@change="onLockToggle"/);
    expect(designer).not.toMatch(/@change="lock\.match \? releaseLock\(\) : setLock\(\)"/);
  });
});

describe('a ytt templated config cannot be saved over', () => {
  const fn = designer.slice(
    designer.indexOf('async function loadConfigTemplated'),
    designer.indexOf('function defaultRepo'),
  );

  it('asks an endpoint a designer can actually reach', () => {
    // /settings/config needs settings access : a designer without it got a 403, the
    // catch said "not templated", and the save wrote the expansion over the template
    expect(fn).toContain('/api/v2/config/templated');
    expect(fn).not.toContain('/api/v2/settings/config');
  });

  it('fails CLOSED when the question cannot be answered', () => {
    const c = fn.slice(fn.indexOf('catch'));
    expect(c).toMatch(/configTemplated\.value = true/);
  });
});

describe('a save in flight cannot swallow the edits typed during it', () => {
  // setDirtyBaseline() used to run AFTER the await, reading the live buffers - so text
  // typed while the request was in flight (a repo-backed save commits and pushes, easily
  // over a second, and nothing makes the editor read-only) became the clean baseline.
  // isDirty went false, Save greyed out, the unsaved marker cleared and the navigation
  // guard stopped warning, for an edit that was never sent.
  it('the baseline is captured before the request, not after', () => {
    const fn = designer.slice(
      designer.indexOf('const formConfig = assembleForms();'),
      designer.indexOf("toast.success(t('designer.formsSaved'))"),
    );
    const capture = fn.indexOf('captureBaseline()');
    const send = fn.indexOf('await Form.save(');
    const apply = fn.indexOf('applyBaseline(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(send);
    expect(apply).toBeGreaterThan(send);
  });

  it('capture and apply are separate, so the snapshot can outlive the await', () => {
    expect(designer).toMatch(/function captureBaseline\(\)/);
    expect(designer).toMatch(/function applyBaseline\(b\)/);
    // setDirtyBaseline still exists for the callers that want "now"
    expect(designer).toMatch(/function setDirtyBaseline\(\)\s*\{\s*applyBaseline\(captureBaseline\(\)\);/);
  });
});

describe('a failed lock operation does not trap the editor behind a spinner', () => {
  // `loaded` is only set true inside loadForms(), which a throwing Lock.set never reaches,
  // and the panel renders a spinner while `lock && !lock.free && !loaded`. Losing a race
  // for the lock left an endless spinner that only a page reload cleared - with the
  // in-memory buffers still there but unreachable.
  it('setLock restores loaded on the error path', () => {
    const fn = designer.slice(
      designer.indexOf('async function setLock'),
      designer.indexOf('async function restoreBackup'),
    );
    const c = fn.slice(fn.indexOf('} catch (err) {'));
    expect(c).toMatch(/loaded\.value = true/);
  });

  it('deleteLock does too', () => {
    const fn = designer.slice(designer.indexOf('async function deleteLock'), designer.indexOf('async function unLock'));
    const c = fn.slice(fn.indexOf('} catch (err) {'));
    expect(c).toMatch(/loaded\.value = true/);
  });
});

describe('the tree marker and the Save button agree', () => {
  // isFormDirty compared RAW text while isDirty compares PARSED content, so pressing
  // Enter at the end of a form or typing a comment painted the tree entry "unsaved" while
  // Save, Diff and Revert stayed disabled and neither guard warned - the UI claimed a
  // change and offered no way to act on it, then dropped it without a prompt. Parsed is
  // the honest side: assembleForms() serializes parsed objects, so a whitespace-only edit
  // can never reach the server anyway.
  it('isFormDirty compares parsed content', () => {
    const fn = designer.slice(designer.indexOf('function isFormDirty'), designer.indexOf('function isFormDirty') + 400);
    expect(fn).toMatch(/parsedForm\(forms\.value\[id\]\) !== parsedForm\(baselineRaw\.value\.forms\[id\]\)/);
  });

  it('an unparsable buffer falls back to the raw text rather than colliding', () => {
    // two different unparsable drafts must not both stringify to the same thing
    const fn = designer.slice(designer.indexOf('function parsedForm'), designer.indexOf('function isFormDirty'));
    expect(fn).toMatch(/catch \{\s*(\/\/[^\n]*\s*)?return raw;\s*\}/);
  });
});

describe('the lock poll is not armed on a dead component', () => {
  // onMounted awaits three times before installing it, so leaving the designer early
  // meant onBeforeUnmount cleared nothing and the interval was then installed on a
  // destroyed component: polling for the rest of the session, one per visit, firing
  // error toasts on unrelated pages and pinning the buffers in memory.
  it('onBeforeUnmount records that it ran', () => {
    const fn = designer.slice(designer.lastIndexOf('onBeforeUnmount('));
    expect(fn).toMatch(/unmounted\.value = true/);
  });

  it('and onMounted checks it before arming the interval', () => {
    const fn = designer.slice(designer.indexOf('onMounted(async () =>'));
    const guard = fn.indexOf('if (unmounted.value) return;');
    const arm = fn.indexOf('lockInterval.value = setInterval');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(arm);
  });
});

describe('read-only offers no Save and leave', () => {
  it('the leave question saves only with the lock held', () => {
    // a force-unlock while editing made "Save and close" dead in the designer's own modal : a
    // toast, and the modal sat there. The app's dialog now asks, and offers Save and leave
    // only when the forms can be saved from here, the lock held among them
    const at = designer.indexOf('const canSaveForms');
    const line = designer.slice(at, designer.indexOf('\n', at));
    expect(line).toMatch(/lock\.value\?\.match/);
    expect(designer).toMatch(/askToLeave\(canSaveForms\.value \? \(\) => saveForms\(\) : null/);
  });
});

describe('a manual form ordering follows its file', () => {
  // formOrderMap is keyed by source and was never re-keyed, so renaming or moving a file
  // left the ordering behind: the tree snapped back to alphabetical and the save order
  // fell back to document order, with no message.
  it('rename moves the order', () => {
    const fn = designer.slice(
      designer.indexOf('function doRenameFile'),
      designer.indexOf('function doRenameFile') + 900,
    );
    expect(fn).toMatch(/moveFormOrder\(renameSource\.value, newName\)/);
  });

  it('move-to-folder moves it too', () => {
    const fn = designer.slice(
      designer.indexOf('function doMoveFileToFolder'),
      designer.indexOf('function doMoveFileToFolder') + 900,
    );
    expect(fn).toMatch(/moveFormOrder\(source, newSource\)/);
  });

  it('the old key is removed, not merely copied', () => {
    const fn = designer.slice(designer.indexOf('function moveFormOrder'), designer.indexOf('function doRenameFile'));
    expect(fn).toMatch(/delete next\[from\]/);
    expect(fn).toMatch(/if \(from === to\) return/);
  });
});

describe('restoring a backup asks before discarding unsaved work', () => {
  // loadAll() replaces every buffer, so this threw away whatever was in the editor with
  // no prompt - while pullAndReload, which does the same thing from a repository, goes
  // through withReloadConfirm.
  const fn = designer.slice(
    designer.indexOf('async function restoreBackup'),
    designer.indexOf('async function pushToRepo') > -1
      ? designer.indexOf('async function pushToRepo')
      : designer.indexOf('async function restoreBackup') + 1200,
  );

  it('found the function, so these assertions are not vacuous', () => {
    expect(fn).toContain('Backup.restore(');
  });

  it('it goes through the same confirmation as pullAndReload', () => {
    expect(fn).toMatch(/withReloadConfirm\(async \(\) => \{/);
    // the restore itself must be INSIDE the confirmation, not beside it
    expect(fn.indexOf('withReloadConfirm(')).toBeLessThan(fn.indexOf('Backup.restore('));
  });

  it('the empty-selection guard still runs first, outside the confirmation', () => {
    expect(fn.indexOf('backupToRestore.value?.file')).toBeLessThan(fn.indexOf('withReloadConfirm('));
  });
});

describe('the designer address names a section and a tab it has', () => {
  // a section it no longer has (roles, users ...) or a tab its section does not have
  // (/designer/constants/diagram) is not found, never another section or tab instead
  // the sections are listed in config/designerViews.js, which the designer shows
  const views = read('src/config/designerViews.js');
  const names = [...views.matchAll(/^ {6}name: '(\w+)',$/gm)].map((m) => m[1].toLowerCase());

  it('lists exactly the sections of the menu', () => {
    expect(Object.keys(DESIGNER_TABS).sort()).toEqual([...names].sort());
  });
  it('knows a section, its tabs and a form', () => {
    expect(designerAddressExists({})).toBe(true);
    expect(designerAddressExists({ view: 'playbooks' })).toBe(true);
    expect(designerAddressExists({ view: 'playbooks', item: 'yaml' })).toBe(true);
    expect(designerAddressExists({ view: 'playbooks', item: 'preview' })).toBe(true);
    expect(designerAddressExists({ view: 'playbooks', item: 'visual' })).toBe(true);
    expect(designerAddressExists({ view: 'varsfiles', item: 'visual' })).toBe(true);
    expect(designerAddressExists({ view: 'forms', item: 'approval-demo' })).toBe(true);
    expect(designerAddressExists({ view: 'forms', item: 'approval-demo', editor: 'preview' })).toBe(true);
    expect(designerAddressExists({ view: 'forms', item: 'visual' })).toBe(true);
  });
  it('answers anything else as not found', () => {
    expect(designerAddressExists({ item: 'roles' })).toBe(false);
    expect(designerAddressExists({ view: 'roles' })).toBe(false);
    expect(designerAddressExists({ view: 'constants', item: 'diagram' })).toBe(false);
    expect(designerAddressExists({ view: 'constants', item: 'preview' })).toBe(true);
    expect(designerAddressExists({ view: 'varsfiles', item: 'site.yml' })).toBe(false);
    expect(designerAddressExists({ view: 'varsfiles', item: 'yaml', editor: 'yaml' })).toBe(false);
    expect(designerAddressExists({ view: 'forms', item: 'approval-demo', editor: 'other' })).toBe(false);
    expect(designerAddressExists({ view: 'forms', item: 'yaml', editor: 'visual' })).toBe(false);
  });
});

describe('renaming a form keeps that form open', () => {
  // The address follows the form shown : renaming it router.replace'd to the new name's slug,
  // and the route watcher then opened the first form of that slug, another form when two read
  // the same in an address ('Test 1', 'test-1'). Each guard was checked by removing it.
  const watcher = designer.slice(designer.indexOf('() => route.path,'), designer.indexOf('watch(currentTab, (tab) =>'));

  it('the route watcher ignores an address the designer wrote itself', () => {
    expect(watcher).toContain('designerAddress === route.path');
    expect(watcher).toContain('!ownAddress');
  });

  it('the form shown stays when it already has the address', () => {
    expect(watcher).toContain('slugMatches(shown, address.form)');
  });

  it('an address picks the exact name before the first of that slug', () => {
    expect(watcher).toContain('findBySlug(address.form, idmapping.value)');
    expect(watcher).not.toMatch(/idmapping\.value\.find\(/);
  });

  it('the address the designer writes is marked first', () => {
    const follow = designer.slice(designer.indexOf('watch([currentTab, currentFormName, editorView, addressApplied]'));
    expect(follow.slice(0, follow.indexOf('function deleteForm'))).toContain('markDesignerAddress(path)');
    const select = designer.slice(designer.indexOf('function selectForm'), designer.indexOf('const addressApplied'));
    expect(select).toContain('markDesignerAddress(path)');
  });
});
