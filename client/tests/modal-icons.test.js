// Every modal has an icon before its title : the icon of the action that opened it (a delete's
// trash, a relaunch's arrow), passed to BsModal as `icon` so all of them look the same. Read
// from the sources, like chat-panel : a guard on what a modal must carry, not on how it looks.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
const vueFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? vueFiles(p) : p.endsWith('.vue') ? [p] : [];
  });

// every <BsModal ...> opening tag, with its file and line
const modals = vueFiles(src).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/<BsModal\b([^>]*)>/g)].map((m) => ({
    where: `${path.relative(src, file)}:${text.slice(0, m.index).split('\n').length}`,
    attrs: m[1],
    after: text.slice(m.index + m[0].length, m.index + m[0].length + 400),
  }));
});

describe('the modals', () => {
  it('are found', () => {
    expect(modals.length).toBeGreaterThan(50);
  });

  it('each have an icon', () => {
    const without = modals.filter((m) => !/(^|\s):?icon="[^"]+"/.test(m.attrs)).map((m) => m.where);
    expect(without).toEqual([]);
  });

  it('pass it to BsModal, not as an icon of their own in the title', () => {
    const inTitle = modals
      .filter((m) => /<template (#title|v-slot:title)\s*>\s*<(FaIcon|font-awesome-icon)\b/.test(m.after))
      .map((m) => m.where);
    expect(inTitle).toEqual([]);
  });
});
