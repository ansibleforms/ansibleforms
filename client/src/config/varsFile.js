// The Visual tab of the designer's Vars files section : a vars file's variables as rows, changed
// in place on the file's own text (a value, a new key or list item, a key deleted), so its
// comments and quoting stay ; a list or a map an edit changes or creates is written one item per
// line (lib/yamlBlock.js). Pure : the component (AppVarsEditor) draws it.
import YAML from 'yaml';
import { toBlock, yamlText } from '@/lib/yamlBlock';

/**
 * The list or map a path's last key or index is in : the top of the file for a path of one.
 *
 * Args:
 *   doc (YAML.Document): the file's document.
 *   path (Array): the keys and indexes down to a value.
 *
 * Returns:
 *   any: its list or map (another node, or nothing, when the path does not lead there).
 */
function parentOf(doc, path) {
  return path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
}

/**
 * What a YAML file is, for the Visual tab : variables (a map) it can show, or not.
 *
 * Args:
 *   text (string): the file's content.
 *
 * Returns:
 *   object: { kind } - 'vars' (a map), 'empty', 'other' (a list, a scalar), or 'invalid' with
 *     the YAML's first error and its line.
 */
export function varsKind(text) {
  const doc = YAML.parseDocument(text || '');
  if (doc.errors.length) {
    const e = doc.errors[0];
    return { kind: 'invalid', error: e.message.split('\n')[0], line: e.linePos?.[0]?.line ?? null };
  }
  const root = doc.contents;
  if (root === null || root === undefined || (YAML.isScalar(root) && root.value === null)) return { kind: 'empty' };
  return { kind: YAML.isMap(root) ? 'vars' : 'other' };
}

/** A scalar's type as the editor shows it : yes / no, a number, nothing, or text. */
function scalarType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (value === null || value === undefined) return 'null';
  return 'string';
}

/**
 * The variables of a vars file as rows : every key (and list item) with its depth, its type and
 * its value when it is a scalar - a map or a list says how many it holds.
 *
 * Args:
 *   text (string): the file (a map).
 *
 * Returns:
 *   object[]: { path (the keys and indexes down to it), id (the path as text), key, depth, type
 *     ('map', 'seq', 'boolean', 'number', 'null', 'string'), value, count, line }.
 */
export function varsRows(text) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text || '', { lineCounter });
  if (doc.errors.length || !YAML.isMap(doc.contents)) return [];
  const rows = [];
  const walk = (node, path, depth) => {
    const entries = YAML.isMap(node)
      ? node.items.map((p) => [YAML.isScalar(p.key) ? p.key.value : String(p.key), p.value, p.key])
      : node.items.map((v, i) => [i, v, v]);
    for (const [key, value, at] of entries) {
      const here = [...path, key];
      const line = at?.range ? lineCounter.linePos(at.range[0]).line : null;
      const row = { path: here, id: JSON.stringify(here), key, depth, line };
      if (YAML.isMap(value) || YAML.isSeq(value)) {
        rows.push({ ...row, type: YAML.isMap(value) ? 'map' : 'seq', count: value.items.length });
        walk(value, here, depth + 1);
      } else {
        const v = YAML.isScalar(value) ? value.value : (value ?? null);
        rows.push({ ...row, type: YAML.isAlias(value) ? 'alias' : scalarType(v), value: v });
      }
    }
  };
  walk(doc.contents, [], 0);
  return rows;
}

/**
 * The file with a value changed : the scalar's own node is changed, so its comments and its
 * quoting stay.
 *
 * Args:
 *   text (string): the file.
 *   path (Array): the keys and indexes down to the value.
 *   value (any): its new value.
 *
 * Returns:
 *   string: the file, changed.
 */
export function setVar(text, path, value) {
  const doc = YAML.parseDocument(text || '');
  const node = doc.getIn(path, true);
  if (YAML.isScalar(node)) node.value = value;
  else {
    doc.setIn(path, value);
    toBlock(parentOf(doc, path));
  }
  return yamlText(doc);
}

/**
 * The file without a key (or a list item), its comment line gone with it.
 *
 * Args:
 *   text (string): the file.
 *   path (Array): the keys and indexes down to it.
 *
 * Returns:
 *   string: the file, changed.
 */
export function deleteVar(text, path) {
  const doc = YAML.parseDocument(text || '');
  doc.deleteIn(path);
  toBlock(parentOf(doc, path));
  return yamlText(doc);
}

/**
 * The file with a new key at its top, or a new item at the end of a list.
 *
 * Args:
 *   text (string): the file (a map, or empty).
 *   path (Array): where : [] for the top, else the path of a map or a list.
 *   key (string): the new key (unused for a list).
 *   value (any): its value.
 *
 * Returns:
 *   string: the file, changed.
 *
 * Raises:
 *   Error: the key is there already.
 */
export function addVar(text, path, key, value) {
  const doc = YAML.parseDocument(text || '');
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode({});
  const parent = path.length ? doc.getIn(path, true) : doc.contents;
  if (YAML.isSeq(parent)) {
    parent.add(doc.createNode(value));
  } else {
    if (parent.has(key)) throw new Error('exists');
    parent.set(key, doc.createNode(value));
  }
  toBlock(parent);
  return yamlText(doc);
}

/**
 * The file with a key renamed, in place : its value, its comments and its place kept.
 *
 * Args:
 *   text (string): the file.
 *   path (Array): the keys down to it (its last, the key renamed).
 *   newKey (string): its new name.
 *
 * Returns:
 *   string: the file, changed.
 *
 * Raises:
 *   Error: 'exists' when its map has that key already ; 'notAMap' when it is a list's item.
 */
export function renameVar(text, path, newKey) {
  const doc = YAML.parseDocument(text || '');
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length ? doc.getIn(parentPath, true) : doc.contents;
  if (!YAML.isMap(parent)) throw new Error('notAMap');
  const old = path[path.length - 1];
  if (newKey === old) return text;
  if (parent.has(newKey)) throw new Error('exists');
  const pair = parent.items.find((p) => (YAML.isScalar(p.key) ? p.key.value : p.key) === old);
  if (YAML.isScalar(pair.key)) pair.key.value = newKey;
  else {
    pair.key = doc.createNode(newKey);
    toBlock(parent);
  }
  return yamlText(doc);
}
