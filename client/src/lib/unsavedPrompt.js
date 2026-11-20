/******************************************************************/
/*                                                                */
/*  The Unsaved changes question : one for the whole app, shown   */
/*  by AppUnsavedDialog (App.vue) and asked by useUnsavedGuard    */
/*  when a page with unsaved changes is left. A page that says    */
/*  how it saves also gets Save and leave : the page is left once */
/*  the save went through, else it stays with its error shown.    */
/*  One wording for all : the dialog says it, the callers do not. */
/*                                                                */
/******************************************************************/
import { reactive } from 'vue';

// what the dialog shows : open or not, and who waits for the answer and, for a page that can
// save, how (save) and whether it still has changes after (isDirty)
export const unsavedPrompt = reactive({
  open: false,
  resolve: null,
  save: null,
  isDirty: null,
  saving: false,
});

/**
 * Asks whether to leave the page and lose its unsaved changes : whether to save them first when
 * the page can save, else whether to lose them.
 *
 * Args:
 *   save (Function|null): the page's own save (its Save button) ; none : no Save and leave.
 *   isDirty (Function|null): whether the page still has unsaved changes, read after a save.
 *
 * Returns:
 *   Promise<boolean>: true to leave, false to stay.
 */
export function askToLeave(save = null, isDirty = null) {
  // a question still open (a second navigation before the first was answered) : it stays
  unsavedPrompt.resolve?.(false);
  return new Promise((resolve) => {
    Object.assign(unsavedPrompt, { open: true, resolve, save, isDirty, saving: false });
  });
}

/**
 * Answers the question and closes the dialog.
 *
 * Args:
 *   leave (boolean): leave the page (true) or stay on it (false).
 */
export function answerUnsaved(leave) {
  const resolve = unsavedPrompt.resolve;
  Object.assign(unsavedPrompt, { open: false, resolve: null, save: null, isDirty: null, saving: false });
  resolve?.(leave);
}

/**
 * Saves the page, then leaves it when nothing is left unsaved ; a save refused (a required
 * field, the server saying no, which the page shows) keeps the user on the page.
 */
export async function saveAndLeave() {
  const { save, isDirty } = unsavedPrompt;
  if (!save || unsavedPrompt.saving) return;
  unsavedPrompt.saving = true;
  let saved;
  try {
    const result = await save();
    // a part the page saves on its own after (AppAdminSingle's saveExtra) : a moment to land
    for (let i = 0; i < 30 && isDirty && isDirty(); i++) await new Promise((r) => setTimeout(r, 100));
    saved = result !== false && !(isDirty && isDirty());
  } catch {
    saved = false;
  }
  answerUnsaved(saved);
}
