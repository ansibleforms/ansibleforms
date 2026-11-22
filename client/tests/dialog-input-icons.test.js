// Every input of a dialog that is typed in or picked from (a text, a number, a password, a
// dropdown, a date, a file) has a left icon, as the form Designer's Visual tabs : an icon in an
// input-group-text before it. Switches, radio groups, code editors and tables have none. Read from
// the sources, as dialog-labels-above : a guard on what a dialog must carry, not on how it looks.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { withoutComments } from './vueSource.js';
import getSettings from '@/config/settings';

const src = path.join(import.meta.dirname, '../src');
const read = (file) => withoutComments(readFileSync(path.join(src, file), 'utf8'));
const vueFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? vueFiles(p) : p.endsWith('.vue') ? [p] : [];
  });

// ─── the list dialogs (AppAdminMulti) : a field's icon ──────────────────────────────────────

// the kinds with no icon : a switch, a radio group, a code editor, a table, and what is not an
// input (a component, the usage flags, the colour swatches)
const NO_ICON = ['checkbox', 'radio', 'editor', 'component', 'usage', 'swatches'];
// a list drawn on a page of its own (AppAdminSingle), not in a dialog
const NOT_A_DIALOG = ['ssh'];

describe("a list's dialogs : every typed or picked field has an icon", () => {
  const settings = getSettings((k) => k);
  const fields = Object.entries(settings)
    .filter(([list, cfg]) => !NOT_A_DIALOG.includes(list) && Array.isArray(cfg?.fields))
    .flatMap(([list, cfg]) => cfg.fields.map((field) => ({ list, field })))
    .filter(({ field }) => !field.noInput && !NO_ICON.includes(field.type || 'text'));

  it('finds the fields', () => {
    expect(fields.length).toBeGreaterThan(100);
  });

  it('gives each of them an icon', () => {
    const without = fields.filter(({ field }) => !field.icon).map(({ list, field }) => `${list}.${field.key}`);
    expect(without).toEqual([]);
  });

  it('draws that icon before the input, whatever the kind', () => {
    const multi = read('components/AppAdminMulti.vue');
    const at = multi.indexOf('<template v-for="field in dialogFields"');
    const dialog = multi.slice(at, multi.indexOf('childLists"', at));
    for (const tag of ['BsDateTime', 'BsCron', 'BsRrule', 'BsInputList', 'BsInput']) {
      const open = dialog.match(new RegExp(`<${tag}\\s((?:[^>"]|"[^"]*")*)>`));
      expect(open, tag).toBeTruthy();
      expect(open[1], tag).toMatch(/:icon="field\.icon/);
    }
  });
});

// ─── the purpose-built dialogs (BsModal, BsOffCanvas) : an input-group with its icon ────────

// what is typed in or picked from, as it is written in a template
const INPUT =
  /<(input|select|textarea|BsInput|BsDateTime|BsCron|BsRrule|BsInputList|BsInputSelectAdvanced)\b((?:[^>"]|"[^"]*")*?)\/?>/g;
// the parts a dialog draws whose inputs are written in their own file
const PARTS = ['components/AppWorkflowNodeFields.vue', 'components/AppRoleEditor.vue', 'components/AppEndChoice.vue'];
// the Visual editor (the reference this follows) is out of the rule's reach : its own dialogs
// only ask a confirmation
const SKIPPED = ['components/AppFormVisualEditor.vue'];
// inputs with no icon on purpose, each where it is and why
const EXEMPT = [
  // the new API token, shown once to copy : read only, not typed in nor picked from
  { file: 'pages/profile.vue', match: 'id="af-token"' },
];

/**
 * The template parts of a file that are dialogs : each BsModal and BsOffCanvas from its opening
 * to its closing tag, nested ones in their parent's.
 *
 * Args:
 *   text (string): the file, its comments cut out.
 *
 * Returns:
 *   Array: the dialogs, each { at, text } : where it starts in the file, and its text.
 */
function dialogsOf(text) {
  const out = [];
  for (const tag of ['BsModal', 'BsOffCanvas']) {
    const token = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
    let depth = 0;
    let start = -1;
    for (const m of text.matchAll(token)) {
      if (m[0].startsWith('</')) {
        depth--;
        if (depth === 0) out.push({ at: start, text: text.slice(start, m.index) });
      } else if (depth++ === 0) start = m.index;
    }
  }
  return out;
}

/**
 * The element an input sits in : the innermost div opened before it and not closed yet, and what
 * comes between its opening and the input.
 *
 * Args:
 *   before (string): the dialog's text up to the input.
 *
 * Returns:
 *   object: { open, inside } ; open is null when there is no such div.
 */
function enclosing(before) {
  let depth = 0;
  const tags = [...before.matchAll(/<div\b(?:[^>"]|"[^"]*")*>|<\/div>/g)].reverse();
  for (const m of tags) {
    if (m[0] === '</div>') depth++;
    else if (depth === 0) return { open: m[0], inside: before.slice(m.index + m[0].length) };
    else depth--;
  }
  return { open: null, inside: '' };
}

/**
 * Whether an input of a dialog has its left icon : a component given one (icon), or a plain
 * input inside an input-group whose input-group-text holds a FaIcon before it.
 *
 * Args:
 *   tag (string): the element's name.
 *   attrs (string): its attributes.
 *   before (string): the text before it.
 *
 * Returns:
 *   boolean: true when it has one, or needs none.
 */
function hasIcon(tag, attrs, before) {
  if (tag === 'input' && /\btype="(checkbox|radio|hidden)"/.test(attrs)) return true;
  if (tag === 'BsInput' && /\btype="(checkbox|editor)"/.test(attrs)) return true;
  if (/^[A-Z]/.test(tag)) return /(^|\s):?icon="/.test(attrs);
  const { open, inside } = enclosing(before);
  return !!open && /class="[^"]*\binput-group\b/.test(open) && /input-group-text[\s\S]*<FaIcon\b/.test(inside);
}

describe('the purpose-built dialogs : every typed or picked input has an icon', () => {
  const files = vueFiles(src)
    .map((file) => path.relative(src, file).split(path.sep).join('/'))
    .filter((file) => !SKIPPED.includes(file));
  const inputs = files.flatMap((file) => {
    const text = read(file);
    const parts = PARTS.includes(file) ? [{ at: 0, text }] : dialogsOf(text);
    return parts.flatMap((part) =>
      [...part.text.matchAll(INPUT)].map((m) => ({
        file,
        line: text.slice(0, part.at + m.index).split('\n').length,
        tag: m[1],
        attrs: m[2],
        before: part.text.slice(0, m.index),
      })),
    );
  });

  it('finds the inputs of the dialogs', () => {
    expect(inputs.length).toBeGreaterThan(80);
    for (const file of ['pages/form.vue', 'components/AppWorkflowEditor.vue', 'components/AppInventoryEditor.vue']) {
      expect(
        inputs.some((i) => i.file === file),
        file,
      ).toBe(true);
    }
  });

  it('puts each in an input-group with its icon, or gives the component one', () => {
    const without = inputs
      .filter((i) => !EXEMPT.some((e) => e.file === i.file && i.attrs.includes(e.match)))
      .filter((i) => !hasIcon(i.tag, i.attrs, i.before))
      .map((i) => `${i.file}:${i.line} <${i.tag}${i.attrs.replace(/\s+/g, ' ').slice(0, 60)}`);
    expect(without).toEqual([]);
  });

  it("names the save and schedule dialogs' fields with an icon", () => {
    const form = dialogsOf(read('pages/form.vue'))
      .map((d) => d.text)
      .join('\n');
    for (const model of ['scheduleForm.name', 'storeForm.name', 'storeForm.description']) {
      const at = form.indexOf(`v-model="${model}"`);
      expect(at, model).toBeGreaterThan(-1);
      expect(hasIcon('input', '', form.slice(0, at)), model).toBe(true);
    }
  });

  it('draws the icon as BsInput does : an input-group-text with a fixed-width FaIcon', () => {
    const bsInput = read('components/BsInput.vue');
    expect(bsInput).toContain('<span class="input-group-text text-gray-500" :style="style">');
    expect(bsInput).toContain('<FaIcon :fixedwidth="true" :icon="icon" />');
    for (const file of ['components/BsRrule.vue', 'components/AppEndChoice.vue']) {
      expect(read(file), file).toMatch(
        /<span[^>]*class="input-group-text text-gray-500"[^>]*><FaIcon :fixedwidth="true"/,
      );
    }
  });
});
