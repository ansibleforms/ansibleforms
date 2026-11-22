// A Name field has the heading icon, a Description field the info-circle icon.
//
// They had drifted apart: a description with comment or circle-info, a name with font, tag,
// lock, users, user-shield, database or diagram-project. Every input labelled Name or
// Description now has the same icon, wherever it is drawn: the list settings (config/settings.js),
// the record pages and dialogs, and the designer's Visual tabs. A name keeps another icon only
// where it is listed below, with why.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');

// the labels of a plain name field, and of a description field
const NAME_LABELS = [
  'settings.fields.name',
  'settings.settingsPage.name',
  'profilePage.token.name',
  'designer.formName',
  'designer.categoryName',
  'playbookEditor.name',
  'workflowEditor.name',
];
const DESCRIPTION_LABELS = [
  'settings.fields.description',
  'designer.formDescription',
  'workflowEditor.description',
  'admin.backups.description',
];

// names that keep an icon of their own : a text found in the field's definition, the icon, why
const KEPT = [
  {
    marker: "t('settings.ldap.nameHelp')",
    icon: 'tag',
    why: "an LDAP directory's name is the prefix its members sign in with (corp/jane)",
  },
];

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
 * The text of the innermost {...} object around a position of a script.
 *
 * Args:
 *   text (string): the script.
 *   at (number): the position.
 *
 * Returns:
 *   string: the object's text, or '' when the position is in none.
 */
function enclosingObject(text, at) {
  let depth = 0;
  let start = at;
  for (; start >= 0; start--) {
    if (text[start] === '}') depth++;
    else if (text[start] === '{') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (start < 0) return '';
  depth = 0;
  for (let end = at; end < text.length; end++) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') {
      if (depth === 0) return text.slice(start, end + 1);
      depth--;
    }
  }
  return '';
}

/**
 * The icon of the input a label belongs to : the icon of its BsInput tag, of the input group
 * right after its <label>, or of its field definition in a script ; null when it has none (a
 * table column, a heading).
 *
 * Args:
 *   text (string): the file's text.
 *   at (number): where the label's t('...') stands.
 *
 * Returns:
 *   object|null: { icon, context } where context is the text the icon was found in.
 */
function iconOf(text, at) {
  // in a tag : <BsInput ... :label="t('...')" ... icon="...">
  const tagStart = text.lastIndexOf('<', at);
  const tagEnd = text.indexOf('>', at);
  const tag = text.slice(tagStart, tagEnd + 1);
  if (/^<Bs\w+/.test(tag)) {
    const m = /\sicon="([^"]+)"/.exec(tag);
    return m ? { icon: m[1], context: tag } : null;
  }
  // a <label> above an input group : its icon next
  if (/^<label\b/.test(tag)) {
    const after = text.slice(at, at + 500);
    const m =
      /^[\s\S]*?<\/label>\s*(?:<!--[\s\S]*?-->\s*)?<div class="input-group">\s*<span class="input-group-text[^"]*">\s*<FaIcon[^>]*\sicon="([^"]+)"/.exec(
        after,
      );
    return m ? { icon: m[1], context: after } : null;
  }
  // a field definition : { key, label: t('...'), icon: '...' }
  const object = enclosingObject(text, at);
  const m = /\bicon: '([^']+)'/.exec(object);
  return m ? { icon: m[1], context: object } : null;
}

/**
 * Every input labelled with one of some labels, with its icon.
 *
 * Args:
 *   labels (string[]): the label keys.
 *
 * Returns:
 *   object[]: { where, icon, context } of each.
 */
function inputsLabelled(labels) {
  const found = [];
  const pattern = new RegExp(
    `t\\('(${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})'\\)`,
    'g',
  );
  for (const file of sourceFiles(src)) {
    const text = withoutComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(pattern)) {
      const icon = iconOf(text, m.index);
      if (icon) found.push({ where: `${path.relative(src, file)} (${m[1]})`, ...icon });
    }
  }
  return found;
}

describe('the field icons', () => {
  it('every description input has info-circle', () => {
    const inputs = inputsLabelled(DESCRIPTION_LABELS);
    expect(inputs.length).toBeGreaterThan(25);
    const wrong = inputs.filter((i) => i.icon !== 'info-circle').map((i) => `${i.where}: ${i.icon}`);
    expect(wrong).toEqual([]);
  });

  it('every name input has heading, but the ones kept for their kind', () => {
    const inputs = inputsLabelled(NAME_LABELS);
    expect(inputs.length).toBeGreaterThan(20);
    const wrong = inputs
      .filter((i) => i.icon !== 'heading')
      .filter((i) => !KEPT.some((k) => k.icon === i.icon && i.context.includes(k.marker)))
      .map((i) => `${i.where}: ${i.icon}`);
    expect(wrong).toEqual([]);
  });

  it('the ones kept are still there, so the list says what is true', () => {
    const inputs = inputsLabelled(NAME_LABELS);
    for (const k of KEPT) {
      expect(
        inputs.some((i) => i.icon === k.icon && i.context.includes(k.marker)),
        k.why,
      ).toBe(true);
    }
  });
});
