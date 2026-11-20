// Leaving with unsaved changes asks one question, in one dialog, everywhere.
//
// There were two wordings and three dialogs: the app's Unsaved changes dialog (Save and leave,
// Leave without saving), the designer's own (Save and close, Close without saving, "Are you
// sure you want to leave the designer ?") and the file explorer's ("{path} has unsaved
// changes. Drop them?", Save and close, Discard). Every guard now goes through
// AppUnsavedDialog: Save and leave where the page can save, Leave without saving, and Cancel to
// stay; where nothing can be saved from there, it says so in one wording of its own.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

/**
 * Every .vue and .js file under a folder, the locales left out.
 *
 * Args:
 *   dir (string): the folder.
 *   acc (string[]): the files found so far.
 *
 * Returns:
 *   string[]: their paths.
 */
function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'locales') sourceFiles(p, acc);
    } else if (/\.(vue|js)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

/**
 * A source file without its comments.
 *
 * Args:
 *   file (string): its path.
 *
 * Returns:
 *   string: its text, without its HTML and JS block and line comments.
 */
function code(file) {
  const text = withoutComments(withoutComments(readFileSync(file, 'utf8')), '/*', '*/');
  return text.replace(/^\s*\/\/.*$/gm, '');
}

const files = sourceFiles(src).map((f) => ({ file: path.relative(src, f), text: code(f) }));
const read = (rel) => files.find((f) => f.file === rel).text;

describe('the leave guards', () => {
  it('every page guarded by useUnsavedGuard offers Save and leave', () => {
    const calls = files.flatMap(({ file, text }) =>
      [...text.matchAll(/useUnsavedGuard\(([^;]*?)\);/g)].map((m) => ({ file, args: m[1] })),
    );
    expect(calls.length).toBeGreaterThan(20);
    // two arguments : what is dirty, and the page's save
    const noSave = calls.filter((c) => c.args.split(',').filter((a) => a.trim()).length < 2);
    expect(noSave.map((c) => c.file)).toEqual([]);
  });

  it('no caller words the question itself', () => {
    const worded = files.filter(({ text }) => /settings\.common\.unsaved(Changes|SaveQuestion)/.test(text));
    expect(worded.map((f) => f.file)).toEqual(['components/AppUnsavedDialog.vue']);
  });

  it('the designer and its file explorer ask in the same dialog', () => {
    for (const file of ['pages/designer.vue', 'components/AppProjectFiles.vue']) {
      const text = read(file);
      expect(text, file).toMatch(/askToLeave\(/);
      expect(text, file).not.toMatch(/saveAndClose|closeWithoutSaving|leaveConfirm|unsavedConfirm/);
    }
  });

  it('the dialog offers Save and leave, Leave without saving and Cancel', () => {
    const dialog = read('components/AppUnsavedDialog.vue');
    expect(dialog).toContain("t('settings.common.unsavedSaveLeave')");
    expect(dialog).toContain("t('settings.common.unsavedLeave')");
    expect(dialog).toContain("t('common.cancel')");
    expect(dialog).toContain(':footerClose="false"');
  });

  it('the texts left unused are gone, the ones used are in every language', async () => {
    for (const lang of LANGS) {
      const { settings, designer } = (await import(`../src/locales/${lang}.js`)).default;
      for (const key of ['unsavedTitle', 'unsavedChanges', 'unsavedSaveQuestion', 'unsavedSaveLeave', 'unsavedLeave']) {
        expect(typeof settings.common[key], `${lang} ${key}`).toBe('string');
      }
      for (const key of ['unsavedChanges', 'unsavedConfirm', 'unsavedNote', 'closeWithoutSaving', 'saveAndClose']) {
        expect(designer[key], `${lang} designer.${key}`).toBeUndefined();
      }
      expect(designer.files.leaveConfirm, lang).toBeUndefined();
      expect(designer.files.discard, lang).toBeUndefined();
    }
  });
});
