/******************************************************************/
/*                                                                */
/*  The app's own confirm question : one for the whole app, shown */
/*  by AppConfirmDialog (App.vue) and asked with askConfirm, in   */
/*  place of the browser's confirm() ("localhost says"). It       */
/*  answers true for its button, false for Cancel, the cross,     */
/*  Escape or the backdrop. BsModal is not a Bootstrap instance,  */
/*  so Escape is heard here, while the question is open.          */
/*                                                                */
/******************************************************************/
import { reactive } from 'vue';

// what the dialog shows : open or not, its title, question, button and icon, and who waits
export const confirmPrompt = reactive({
  open: false,
  title: '',
  message: '',
  ok: '',
  icon: 'circle-question',
  resolve: null,
});

/**
 * Turns the open question down on Escape. Heard on the window, in its capture phase, so the
 * question answers first and what lies under it (a modal, the chat, a popover) does not hear
 * the same press and close as well.
 *
 * Args:
 *   event (KeyboardEvent): a key press anywhere on the page.
 */
function onEscape(event) {
  // only Escape, and only while a question waits for its answer
  if (event.key !== 'Escape' || !confirmPrompt.open) return;
  event.preventDefault();
  event.stopPropagation();
  answerConfirm(false);
}

/**
 * Asks a question in the app's modal.
 *
 * Args:
 *   message (string): the question ; what follows its question mark shows on a line of its own.
 *   options (object): title (the modal's title), ok (its button's label, the title when not
 *     given) and icon (of the title and the button).
 *
 * Returns:
 *   Promise<boolean>: true when its button is clicked, false when it is closed.
 */
export function askConfirm(message, { title = '', ok = '', icon = 'circle-question' } = {}) {
  // a question still open (asked again before it was answered) : it is turned down
  confirmPrompt.resolve?.(false);
  return new Promise((resolve) => {
    Object.assign(confirmPrompt, { open: true, title, message, ok: ok || title, icon, resolve });
    // Escape turns it down while it is open (once : adding the same listener again is a no-op)
    window.addEventListener('keydown', onEscape, true);
  });
}

/**
 * Answers the question and closes the dialog.
 *
 * Args:
 *   yes (boolean): its button (true), or closed (false).
 */
export function answerConfirm(yes) {
  // answered : Escape is no longer the question's
  window.removeEventListener('keydown', onEscape, true);
  const resolve = confirmPrompt.resolve;
  Object.assign(confirmPrompt, { open: false, title: '', message: '', ok: '', icon: 'circle-question', resolve: null });
  resolve?.(yes);
}

/**
 * Splits a question from what follows it, each to show on a line of its own : after the first
 * question mark (? or the full-width ？ of Japanese and Chinese) that has text after it.
 *
 * Args:
 *   text (string): the question.
 *
 * Returns:
 *   string[]: the question and what follows, or the whole text when nothing follows a mark.
 */
export function confirmLines(text) {
  const m = String(text || '').match(/^(.*?[?？])\s*(.+)$/s);
  return m ? [m[1], m[2]] : [String(text || '')];
}
