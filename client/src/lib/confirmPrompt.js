/******************************************************************/
/*                                                                */
/*  The app's own confirm question : one for the whole app, shown */
/*  by AppConfirmDialog (App.vue) and asked with askConfirm, in   */
/*  place of the browser's confirm() ("localhost says"). It       */
/*  answers true for its button, false for Cancel, the cross,     */
/*  Escape or the backdrop.                                       */
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
  // paragraphs under the question (what a repository's Schedules usage will do)
  details: [],
  resolve: null,
});

/**
 * Asks a question in the app's modal.
 *
 * Args:
 *   message (string): the question ; what follows its question mark shows on a line of its own.
 *   options (object): title (the modal's title), ok (its button's label, the title when not
 *     given), icon (of the title and the button) and details (paragraphs under the question).
 *
 * Returns:
 *   Promise<boolean>: true when its button is clicked, false when it is closed.
 */
export function askConfirm(message, { title = '', ok = '', icon = 'circle-question', details = [] } = {}) {
  // a question still open (asked again before it was answered) : it is turned down
  confirmPrompt.resolve?.(false);
  return new Promise((resolve) => {
    Object.assign(confirmPrompt, { open: true, title, message, ok: ok || title, icon, details, resolve });
  });
}

/**
 * Answers the question and closes the dialog.
 *
 * Args:
 *   yes (boolean): its button (true), or closed (false).
 */
export function answerConfirm(yes) {
  const resolve = confirmPrompt.resolve;
  Object.assign(confirmPrompt, {
    open: false,
    title: '',
    message: '',
    ok: '',
    icon: 'circle-question',
    details: [],
    resolve: null,
  });
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
