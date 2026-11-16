// A record read again after something saved at once, Approve or Ask again (lib/keepEdits.js) :
// the words typed and not saved yet stay on the form, the fields just saved come from the record.
import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { reloadKeepingEdits } from '@/lib/keepEdits';

describe('reloadKeepingEdits', () => {
  it('keeps the unsaved edits over the record read again', async () => {
    const edit = ref({ name: 'typed', description: 'old' });
    await reloadKeepingEdits(edit, async () => {
      edit.value = { name: 'saved', description: 'old' };
    });
    expect(edit.value).toEqual({ name: 'typed', description: 'old' });
  });

  it('takes the fields just saved from the record', async () => {
    const edit = ref({ name: 'typed', is_default: false });
    await reloadKeepingEdits(edit, async () => {
      edit.value = { name: 'saved', is_default: true };
    }, ['is_default']);
    expect(edit.value).toEqual({ name: 'typed', is_default: true });
  });

  it('keeps nothing once the record is gone', async () => {
    const edit = ref({ name: 'typed' });
    await reloadKeepingEdits(edit, async () => {
      edit.value = null;
    });
    expect(edit.value).toBeNull();
  });
});
