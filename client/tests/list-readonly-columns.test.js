// A list's readonlyColumns (#1347) : the subform fields a row the list already holds
// cannot change, while a new row still fills them in - like the old table field's
// readonlyColumns. The rules live in lib/Helpers.js ; the wiring through the edit
// stack is read from the component sources, as form-robustness.test.js does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Helpers from '@/lib/Helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');

describe('the read-only columns of a row', () => {
  const field = { name: 'addresses', type: 'list', subform: 'Address', readonlyColumns: ['street', 'city'] };

  it('are the list readonlyColumns on an existing row', () => {
    expect(Helpers.readonlyColumnsFor(field, false)).toEqual(['street', 'city']);
  });

  it('are none on a new row', () => {
    expect(Helpers.readonlyColumnsFor(field, true)).toEqual([]);
  });

  it('are none without readonlyColumns, and skip what is not a name', () => {
    expect(Helpers.readonlyColumnsFor({ name: 'a', type: 'list' }, false)).toEqual([]);
    expect(Helpers.readonlyColumnsFor({ readonlyColumns: 'street' }, false)).toEqual([]);
    expect(Helpers.readonlyColumnsFor({ readonlyColumns: ['street', 3, '', null] }, false)).toEqual(['street']);
    expect(Helpers.readonlyColumnsFor(undefined, false)).toEqual([]);
  });
});

describe('saving an existing row', () => {
  const original = { street: 'Main 1', city: 'Ghent', country: 'BE', tags: ['a'] };

  it('keeps the read-only columns as they were, the others as edited', () => {
    const edited = { street: 'Other 2', city: 'Paris', country: 'FR', tags: ['a'] };
    expect(Helpers.keepReadonlyColumns(edited, original, ['street', 'city'])).toEqual({
      street: 'Main 1',
      city: 'Ghent',
      country: 'FR',
      tags: ['a'],
    });
  });

  it('leaves the edited row untouched and shares nothing with the original', () => {
    const edited = { street: 'Other 2', tags: ['b'] };
    const kept = Helpers.keepReadonlyColumns(edited, original, ['street', 'tags']);
    expect(edited).toEqual({ street: 'Other 2', tags: ['b'] });
    expect(kept.tags).toEqual(['a']);
    expect(kept.tags).not.toBe(original.tags);
  });

  it('leaves a column the row did not have as the editor gave it', () => {
    expect(Helpers.keepReadonlyColumns({ zip: '9000' }, original, ['zip'])).toEqual({ zip: '9000' });
  });

  it('changes nothing without read-only columns', () => {
    const edited = { street: 'Other 2' };
    expect(Helpers.keepReadonlyColumns(edited, original, [])).toEqual(edited);
    expect(Helpers.keepReadonlyColumns(edited, null, ['street'])).toEqual(edited);
  });
});

describe('the wiring from list to subform pane', () => {
  it('the list hands its readonlyColumns to the editor, by add or edit', () => {
    const src = read('src/components/AppListField.vue');
    expect(src).toMatch(/readonlyFields:\s*Helpers\.readonlyColumnsFor\(props\.field,\s*isAdd\)/);
  });

  it('the form page keeps them on the stack entry and passes them to the pane', () => {
    const src = read('src/pages/form.vue');
    expect(src).toMatch(/function pushEdit\(\{[^}]*readonlyFields[^}]*\}\)/);
    expect(src).toContain(':readonlyFields="entry.readonlyFields"');
  });

  it('the pane makes those fields inert and saves them as they were', () => {
    const src = read('src/components/AppForm.vue');
    expect(src).toContain(':inert="isReadonlyField(field.name)"');
    const save = src.slice(src.indexOf('function handleSubformSave'), src.indexOf("emit('save'"));
    expect(save).toMatch(/Helpers\.keepReadonlyColumns\(.*props\.initialData,\s*props\.readonlyFields\)/);
    // validation still runs first : a read-only column is never exempt from its rules
    expect(save.indexOf('validateForm()')).toBeLessThan(save.indexOf('keepReadonlyColumns'));
  });
});
