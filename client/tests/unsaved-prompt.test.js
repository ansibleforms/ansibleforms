// The Unsaved changes question (lib/unsavedPrompt.js) : Leave without saving leaves, Close
// stays, and Save and leave leaves only once the page's save went through and nothing is left
// unsaved - a refused save keeps the user on the page.
import { describe, test, expect } from 'vitest';
import { unsavedPrompt, askToLeave, answerUnsaved, saveAndLeave } from '@/lib/unsavedPrompt';

describe('the Unsaved changes question', () => {
  test('Leave without saving leaves, Close stays', async () => {
    const leave = askToLeave();
    expect(unsavedPrompt.open).toBe(true);
    expect(unsavedPrompt.save).toBe(null);
    answerUnsaved(true);
    expect(await leave).toBe(true);
    const stay = askToLeave();
    answerUnsaved(false);
    expect(await stay).toBe(false);
    expect(unsavedPrompt.open).toBe(false);
  });

  test('Save and leave : a save that went through leaves', async () => {
    let dirty = true;
    const asked = askToLeave(
      async () => {
        dirty = false;
      },
      () => dirty,
    );
    await saveAndLeave();
    expect(await asked).toBe(true);
    expect(unsavedPrompt.open).toBe(false);
  });

  test('Save and leave : a refused save stays', async () => {
    const refused = askToLeave(
      async () => false,
      () => true,
    );
    await saveAndLeave();
    expect(await refused).toBe(false);
    const thrown = askToLeave(
      async () => {
        throw new Error('no');
      },
      () => true,
    );
    await saveAndLeave();
    expect(await thrown).toBe(false);
  });

  test('Save and leave : changes still there after the save stay', async () => {
    const asked = askToLeave(
      async () => undefined,
      () => true,
    );
    await saveAndLeave();
    expect(await asked).toBe(false);
  }, 10000);
});
