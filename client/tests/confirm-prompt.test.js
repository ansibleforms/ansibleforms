// The app's own confirm question (lib/confirmPrompt.js, shown by AppConfirmDialog).
//
// Deleting a role, rejecting an RTE, a bulk delete and the lists' confirmed actions asked
// in the browser's own confirm() : a grey "localhost:8443 says" box, in the browser's
// language, apart from the app. They ask in the app's modal now, and nothing in the client
// calls the browser's confirm() again.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { askConfirm, answerConfirm, confirmPrompt, confirmLines } from '../src/lib/confirmPrompt.js';

describe('askConfirm', () => {
  it('opens the dialog with its question, title, button and icon', () => {
    askConfirm('Delete 2 item(s)?', { title: 'Delete', icon: 'trash' });
    expect(confirmPrompt).toMatchObject({
      open: true,
      message: 'Delete 2 item(s)?',
      title: 'Delete',
      ok: 'Delete',
      icon: 'trash',
    });
    answerConfirm(false);
  });

  it('answers true for its button and closes', async () => {
    const answer = askConfirm('Reject rte?', { title: 'Reject', icon: 'ban' });
    answerConfirm(true);
    expect(await answer).toBe(true);
    expect(confirmPrompt.open).toBe(false);
  });

  it('answers false when it is closed', async () => {
    const answer = askConfirm('Delete it?');
    answerConfirm(false);
    expect(await answer).toBe(false);
  });

  it('turns down a question still open when another is asked', async () => {
    const first = askConfirm('First?');
    const second = askConfirm('Second?');
    expect(await first).toBe(false);
    expect(confirmPrompt.message).toBe('Second?');
    answerConfirm(true);
    expect(await second).toBe(true);
  });
});

// AppConfirmDialog says Escape turns the question down, but BsModal is not a Bootstrap JS
// instance : its data-bs-keyboard did nothing, the question stayed open and askConfirm never
// answered. The question listens for Escape itself while it is open.
describe('askConfirm and Escape', () => {
  // a press of a key, as the browser sends it to the page
  const press = (key, target = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('answers false and closes on Escape', async () => {
    const answer = askConfirm('Delete it?');
    press('Escape');
    expect(confirmPrompt.open).toBe(false);
    expect(await answer).toBe(false);
  });

  it('answers false on Escape pressed in the dialog itself', async () => {
    const modal = document.createElement('div');
    document.body.appendChild(modal);
    const answer = askConfirm('Delete it?');
    press('Escape', modal);
    expect(await answer).toBe(false);
    modal.remove();
  });

  it('keeps the question open for any other key', async () => {
    const answer = askConfirm('Delete it?');
    press('Enter');
    press('a');
    expect(confirmPrompt.open).toBe(true);
    answerConfirm(true);
    expect(await answer).toBe(true);
  });

  it('keeps Escape from what lies under the question', () => {
    let heard = 0;
    const under = (e) => e.key === 'Escape' && heard++;
    window.addEventListener('keydown', under);
    askConfirm('Delete it?');
    press('Escape');
    expect(heard).toBe(0);
    // answered : Escape is the page's again
    press('Escape');
    expect(heard).toBe(1);
    window.removeEventListener('keydown', under);
  });

  it('stops listening once answered by its buttons', async () => {
    const answer = askConfirm('Delete it?');
    answerConfirm(true);
    expect(await answer).toBe(true);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('confirmLines', () => {
  it('puts what follows the question on a line of its own', () => {
    expect(confirmLines('Reject rte? It is removed with its credential.')).toEqual([
      'Reject rte?',
      'It is removed with its credential.',
    ]);
  });

  it('splits Spanish, French and the full-width mark of Japanese and Chinese', () => {
    expect(confirmLines('¿Rechazar rte? Se elimina.')).toEqual(['¿Rechazar rte?', 'Se elimina.']);
    expect(confirmLines('Rejeter rte ? Il est supprimé.')).toEqual(['Rejeter rte ?', 'Il est supprimé.']);
    expect(confirmLines('拒绝 rte 吗？它将被删除。')).toEqual(['拒绝 rte 吗？', '它将被删除。']);
  });

  it('keeps a lone question, or a text without a mark, whole', () => {
    expect(confirmLines('Delete 3 item(s)?')).toEqual(['Delete 3 item(s)?']);
    expect(confirmLines('Delete them')).toEqual(['Delete them']);
  });
});

describe('the client', () => {
  // every .vue and .js under src, comments left out
  const files = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(vue|js)$/.test(f) ? [p] : [];
    });
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it("never calls the browser's confirm()", () => {
    const src = join(import.meta.dirname, '../src');
    const offenders = files(src).filter((p) =>
      /(^|[^.\w])(window\.)?confirm\(/.test(strip(readFileSync(p, 'utf8')).replace(/askConfirm\(/g, '')),
    );
    expect(offenders).toEqual([]);
  });
});
