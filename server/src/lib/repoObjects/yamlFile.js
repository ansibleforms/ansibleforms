'use strict';
// The YAML files of the repository-backed objects (lib/repoObjects/engine.js) : the types' keys of
// a file (a list of objects under each, or one map), an entry of a list or a type's map written
// back with only the fields the app changed - the keys it does not know, the other entries and
// keys of the file, their comments and their order kept as the file has them, a new key put at
// its place in the type's key order. Pure, no database : the schedules (lib/scheduleFiles.js) and
// every other object type write through these.
import fs from "fs";
import path from "path";
import YAML from "yaml";

// ===========================================================================
// CONSTANTS
// ===========================================================================

// an object's file : yaml
export const YAML_FILE = /\.(yaml|yml)$/i;

// ===========================================================================
// THE FILE : WRITTEN
// ===========================================================================

/**
 * The plain key of a map's pair.
 *
 * Args:
 *   pair (Pair): the pair.
 *
 * Returns:
 *   any: its key.
 */
const keyOf = (pair) => (YAML.isScalar(pair.key) ? pair.key.value : pair.key);

/**
 * Sets a key of a map, a key that is not there yet put at its place in a key order among the keys
 * there ; whatever else the map holds (and its comments) left as it is.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   map (YAMLMap): the map.
 *   key (string): the key.
 *   value (any): the value.
 *   keyOrder (string[]): the order a new key is put in (none : at the end).
 */
export function setKey(doc, map, key, value, keyOrder = []) {
  if (map.has(key)) {
    const pair = map.items.find((p) => keyOf(p) === key);
    const node = doc.createNode(value);
    // the comment before the old value stays with the key
    if (pair?.value?.commentBefore) node.commentBefore = pair.value.commentBefore;
    if (pair?.value?.comment) node.comment = pair.value.comment;
    pair.value = node;
    return;
  }
  const pair = doc.createPair(key, value);
  const rank = keyOrder.indexOf(key);
  let at = map.items.length;
  if (rank >= 0) {
    // after the last key ranked before it, else before the first ranked after it
    let lastBefore = -1;
    let firstAfter = -1;
    map.items.forEach((p, i) => {
      const r = keyOrder.indexOf(keyOf(p));
      if (r < 0) return;
      if (r < rank) lastBefore = i;
      else if (r > rank && firstAfter < 0) firstAfter = i;
    });
    if (lastBefore >= 0) at = lastBefore + 1;
    else if (firstAfter >= 0) at = firstAfter;
  }
  // first in its map : below the map's leading comment, which the writer gives the key it was above
  if (at === 0 && YAML.isNode(map.items[0]?.key) && map.items[0].key.commentBefore) {
    pair.key = YAML.isNode(pair.key) ? pair.key : doc.createNode(pair.key);
    pair.key.commentBefore = map.items[0].key.commentBefore;
    pair.key.spaceBefore = map.items[0].key.spaceBefore;
    map.items[0].key.commentBefore = undefined;
    map.items[0].key.spaceBefore = undefined;
  }
  map.items.splice(at, 0, pair);
}

/**
 * A line as two are compared to tell an untouched line : its trailing spaces left out, and the
 * spaces before its inline comment as one (the YAML writer re-spaces them) - those inside a quoted
 * value kept, a value changed only there is a changed line.
 *
 * Args:
 *   line (string): the line.
 *
 * Returns:
 *   string: the line compared.
 */
function comparedLine(line) {
  const text = line.replace(/\s+$/, "");
  const at = commentAt(text);
  return at < 0 ? text : `${text.slice(0, at).replace(/[ \t]+$/, "")} ${text.slice(at)}`;
}

/**
 * Where a line's inline comment starts : a # after a space, outside a quoted value (a quote opens
 * a value only where a value starts : the line's start, after a colon, a dash, a bracket or a
 * comma) - a # inside "a  #b" is the value's, its spaces never taken for the comment's.
 *
 * Args:
 *   line (string): the line.
 *
 * Returns:
 *   number: the index of its #, -1 when it has no comment.
 */
function commentAt(line) {
  let quote = null;
  let last = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'" && line[i + 1] === "'") i++;
      else if (c === "'") quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && (last === "" || /[:\-[{,]/.test(last))) quote = c;
    else if (c === "#" && (i === 0 || /[ \t]/.test(line[i - 1]))) return i;
    if (!/[ \t]/.test(c)) last = c;
  }
  return -1;
}

/**
 * A changed line given the spacing of its inline comment as the line it replaces had it : the
 * same comment after the new value, as far from it as before.
 *
 * Args:
 *   line (string): the line as written now.
 *   old (string): the line it replaces.
 *
 * Returns:
 *   string: the line, its comment spaced as before (as it is when the comment is not the same).
 */
function withCommentSpacing(line, old) {
  const was = commentAt(old);
  const now = commentAt(line);
  if (was < 1 || now < 1) return line;
  const comment = old.slice(was).replace(/\s+$/, "");
  if (line.slice(now).replace(/\s+$/, "") !== comment) return line;
  const gap = old.slice(0, was).match(/[ \t]+$/)[0];
  return line.slice(0, now).replace(/[ \t]+$/, "") + gap + comment;
}

/**
 * The text the YAML writer gives a file, with every line it did not change as the file had it,
 * byte for byte (the writer re-spaces inline comments and drops trailing spaces on every line),
 * and a changed line keeping the spacing of its comment. The lines are matched as a diff matches
 * them (the longest common sequence of lines compared by comparedLine) ; a changed line takes the
 * comment spacing of the line it replaces : the one of the same key, else the one at its place.
 *
 * Args:
 *   original (string): the file's text before the edit.
 *   rendered (string): the text the writer gives it after the edit.
 *
 * Returns:
 *   string: the text to write.
 */
export function keepUntouchedLines(original, rendered) {
  const a = String(original ?? "").split("\n");
  const b = String(rendered ?? "").split("\n");
  const ka = a.map(comparedLine);
  const kb = b.map(comparedLine);
  // the lines kept, as the longest common sequence pairs them
  const pairs = commonLines(ka, kb);
  const out = [];
  let i = 0;
  let j = 0;
  // the lines replaced and their replacements, since the last line kept
  let gone = [];
  let added = [];
  // a changed line paired with the line it replaces : the one of the same key, else the one at
  // its place when as many lines are replaced as written
  const keyOfLine = (line) => (line.match(/^\s*(?:-\s+)?[^\s:#][^:#]*:(?=\s|$)/) || [null])[0];
  const flush = () => {
    const free = gone.map(() => true);
    added.forEach((line, k) => {
      let at = keyOfLine(line) === null ? -1 : gone.findIndex((g, x) => free[x] && keyOfLine(g) === keyOfLine(line));
      if (at < 0 && added.length === gone.length && free[k]) at = k;
      if (at >= 0) free[at] = false;
      out.push(at >= 0 ? withCommentSpacing(line, gone[at]) : line);
    });
    gone = [];
    added = [];
  };
  for (const [pi, pj] of [...pairs, [a.length, b.length]]) {
    while (i < pi) gone.push(a[i++]);
    while (j < pj) added.push(b[j++]);
    flush();
    if (pi < a.length) {
      out.push(a[i++]);
      j++;
    }
  }
  return out.join("\n");
}

/**
 * The longest common sequence of two lists of lines, as the pairs of the lines it keeps, in order -
 * in memory linear in their length (Hirschberg : each half's lengths, one row at a time), the
 * lines the two share at their start and their end paired first.
 *
 * Args:
 *   ka (string[]): the lines of one, as compared.
 *   kb (string[]): the lines of the other.
 *
 * Returns:
 *   number[][]: [index in ka, index in kb] for each line kept.
 */
function commonLines(ka, kb) {
  const pairs = [];
  // the lengths of the common sequences of ka[a0..a1) with each kb[b0..b0+k), one row kept
  const forward = (a0, a1, b0, b1) => {
    let row = new Int32Array(b1 - b0 + 1);
    let next = new Int32Array(b1 - b0 + 1);
    for (let i = a0; i < a1; i++) {
      for (let j = b0; j < b1; j++) next[j - b0 + 1] = ka[i] === kb[j] ? row[j - b0] + 1 : Math.max(row[j - b0 + 1], next[j - b0]);
      [row, next] = [next, row];
    }
    return row;
  };
  // the same from the ends : with each kb[b0+k..b1)
  const backward = (a0, a1, b0, b1) => {
    let row = new Int32Array(b1 - b0 + 1);
    let next = new Int32Array(b1 - b0 + 1);
    for (let i = a1 - 1; i >= a0; i--) {
      for (let j = b1 - 1; j >= b0; j--) next[j - b0] = ka[i] === kb[j] ? row[j - b0 + 1] + 1 : Math.max(row[j - b0], next[j - b0 + 1]);
      [row, next] = [next, row];
    }
    return row;
  };
  const walk = (a0, a1, b0, b1) => {
    const tail = [];
    while (a0 < a1 && b0 < b1 && ka[a0] === kb[b0]) pairs.push([a0++, b0++]);
    while (a0 < a1 && b0 < b1 && ka[a1 - 1] === kb[b1 - 1]) tail.unshift([--a1, --b1]);
    if (a1 - a0 === 1) {
      for (let j = b0; j < b1; j++) {
        if (ka[a0] === kb[j]) {
          pairs.push([a0, j]);
          break;
        }
      }
    } else if (a0 < a1 && b0 < b1) {
      const mid = (a0 + a1) >> 1;
      const left = forward(a0, mid, b0, b1);
      const right = backward(mid, a1, b0, b1);
      let cut = b0;
      for (let k = b0; k <= b1; k++) if (left[k - b0] + right[k - b0] > left[cut - b0] + right[cut - b0]) cut = k;
      walk(a0, mid, b0, cut);
      walk(mid, a1, cut, b1);
    }
    pairs.push(...tail);
  };
  walk(0, ka.length, 0, kb.length);
  return pairs;
}

/**
 * A document edited in place, as its file's new text : the writer's text, every line the edit
 * did not change kept as the file had it (keepUntouchedLines), its byte order mark and its CRLF
 * line ends kept.
 *
 * Args:
 *   doc (YAML.Document): the document, edited.
 *   original (string): the file's text before the edit.
 *
 * Returns:
 *   string: the text to write.
 */
export function editedText(doc, original) {
  // its byte order mark and its line ends (CRLF) as the file has them, every line alike
  const text = String(original ?? "");
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const crlf = /\r\n/.test(text);
  const lines = keepUntouchedLines(text.slice(bom.length).replace(/\r\n/g, "\n"), doc.toString({ lineWidth: 0 }));
  return bom + (crlf ? lines.replace(/\n/g, "\r\n") : lines);
}

/**
 * Whether two plain values are the same (a changed field only is written, so a file the app
 * saves with nothing changed stays byte for byte).
 *
 * Args:
 *   a (any): one.
 *   b (any): the other.
 *
 * Returns:
 *   boolean: true when they are.
 */
export function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Writes the fields an app edit changed into a map file : each key of `edits` set (a new one at
 * its place in the key order), a key whose edit is undefined removed ; the rest of the file - the
 * keys the app does not know, its comments, its order - kept.
 *
 * Args:
 *   text (string): the file's text.
 *   edits (object): { key: value } ; undefined removes the key.
 *   keyOrder (string[]): the type's key order.
 *
 * Returns:
 *   string: the file's new text.
 *
 * Raises:
 *   Error: the file is not valid YAML, or not a map.
 */
export function updateMapFile(text, edits, keyOrder = []) {
  const doc = YAML.parseDocument(String(text ?? ""));
  if (doc.errors.length) throw new Error(`not valid YAML: ${doc.errors[0].message}`);
  if (!YAML.isMap(doc.contents)) throw new Error("the file is not a YAML dictionary");
  const map = doc.contents;
  // an empty map ({}) : its keys written one below the other, never all on one line
  if (!map.items.length) map.flow = false;
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) map.delete(key);
    else setKey(doc, map, key, value, keyOrder);
  }
  return editedText(doc, text);
}

/**
 * A new map file : its keys in the type's key order, the others after them as given.
 *
 * Args:
 *   obj (object): the fields.
 *   keyOrder (string[]): the type's key order.
 *
 * Returns:
 *   string: the file's text.
 */
export function newMapFile(obj, keyOrder = []) {
  const rank = (k) => (keyOrder.includes(k) ? keyOrder.indexOf(k) : keyOrder.length);
  const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => rank(a) - rank(b)));
  return YAML.stringify(sorted, { lineWidth: 0 });
}

/**
 * Reads a map file as a plain object.
 *
 * Args:
 *   text (string): the file's text.
 *
 * Returns:
 *   object: { errors (string[]), object (the map, null when refused) }.
 */
export function parseMapFile(text) {
  const doc = YAML.parseDocument(String(text ?? ""), { prettyErrors: false });
  if (doc.errors.length) return { errors: [`not valid YAML: ${doc.errors[0].message}`], object: null };
  if (!YAML.isMap(doc.contents)) return { errors: ["the file is not a YAML dictionary"], object: null };
  // its aliases expanded : too many (an alias bomb) is refused, said, never thrown
  try {
    return { errors: [], object: doc.contents.toJS(doc) || {} };
  } catch (e) {
    return { errors: [`not valid YAML: ${e.message || e}`], object: null };
  }
}

// ===========================================================================
// THE PATHS OF A REPOSITORY
// ===========================================================================

/**
 * The absolute path of a file a file names beside it (a logo or icon image : logo.png,
 * images/logo.png, ../images/logo.png), relative to the folder it is named from, checked to be
 * inside a root - that folder itself (the seed file's folder), or the repository the file is in -
 * and to stay in it once its links are followed (staysIn) : a link in a repository never reads nor
 * writes the server's files.
 *
 * Args:
 *   dir (string): the folder it is named from (the folder of the file naming it).
 *   name (string): its path, relative to it.
 *   root (string|null): the repository's working tree it must be in ; none : inside dir.
 *
 * Returns:
 *   string: the path.
 *
 * Raises:
 *   Error: a path that leads outside the root, a link too.
 */
export function fileBeside(dir, name, root = null) {
  const base = path.resolve(root || dir || ".");
  const abs = path.resolve(dir || ".", String(name));
  if (!abs.startsWith(base + path.sep) || !staysIn(base, abs)) throw new Error(root ? `'${name}' is not a file of the repository` : `'${name}' is not a file beside it`);
  return abs;
}

/**
 * The absolute path of a YAML file of a repository, checked to be inside it and to stay in it once
 * its links are followed (staysIn), and to be no hidden one (its .git folder).
 *
 * Args:
 *   repoDir (string): the repository's working tree.
 *   repoFile (string): the file, relative to it (credentials.yaml, settings/app.yml).
 *
 * Returns:
 *   string: the path.
 *
 * Raises:
 *   Error: a file outside the repository, a hidden one, or no YAML file.
 */
export function fileInRepository(repoDir, repoFile) {
  const rel = String(repoFile || "");
  const abs = path.resolve(repoDir, rel);
  const parts = path.relative(repoDir, abs).split(path.sep);
  if (!rel || !abs.startsWith(path.resolve(repoDir) + path.sep) || parts.some((p) => p.startsWith(".")) || !YAML_FILE.test(abs) || !staysIn(repoDir, abs)) {
    throw new Error(`'${repoFile}' is not a YAML file of the repository`);
  }
  return abs;
}

/**
 * Whether a path stays in a folder once its links are followed : the path itself when it is there
 * (a link that leads nowhere does not), else the nearest folder above it that is (the file will be
 * made there). A link in a repository - its folder, or its file - that leads outside it is never
 * read nor written through.
 *
 * Args:
 *   root (string): the folder (a repository's working tree).
 *   abs (string): the path, inside it as written.
 *
 * Returns:
 *   boolean: true when it stays in it.
 */
export function staysIn(root, abs) {
  try {
    const base = fs.realpathSync(root);
    let probe = abs;
    for (;;) {
      let there = true;
      try {
        fs.lstatSync(probe);
      } catch {
        there = false;
      }
      if (there) break;
      const up = path.dirname(probe);
      if (up === probe) return false;
      probe = up;
    }
    const real = fs.realpathSync(probe);
    return real === base || real.startsWith(base + path.sep);
  } catch {
    return false;
  }
}

// ===========================================================================
// A TYPE'S KEY IN A FILE
// ===========================================================================
// A file holds a type under its key : a list of objects, each found by its name (credentials:), or
// one map (defaults:). An entry is read, edited field by field, added and removed, the key's map
// edited, the rest of the file - the other keys and entries, their comments - kept.

/**
 * A file's document, its contents a map : an empty text (or one of comments only) an empty map.
 *
 * Args:
 *   text (string): the file's text ('' for a new one).
 *
 * Returns:
 *   YAML.Document: the document.
 *
 * Raises:
 *   Error: not valid YAML, or not a map.
 */
function mapDocument(text) {
  const doc = YAML.parseDocument(String(text ?? ""));
  if (doc.errors.length) throw new Error(`not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents === null || doc.contents === undefined || (YAML.isScalar(doc.contents) && (doc.contents.value === null || doc.contents.value === undefined))) {
    doc.contents = doc.createNode({});
  }
  if (!YAML.isMap(doc.contents)) throw new Error("the file is not a YAML dictionary");
  // an empty map ({}) : its keys written one below the other, never all on one line
  if (!doc.contents.items.length) doc.contents.flow = false;
  return doc;
}

/**
 * The list of a type's key in a file, made when the file has none (or the key with nothing after
 * it : credentials:).
 *
 * Args:
 *   doc (YAML.Document): the file's document (mapDocument).
 *   key (string): the type's key.
 *
 * Returns:
 *   YAMLSeq: the list.
 *
 * Raises:
 *   Error: the key holds no list.
 */
function listOf(doc, key) {
  const value = doc.contents.get(key, true);
  if (!doc.contents.has(key) || (YAML.isScalar(value) && (value.value === null || value.value === undefined))) doc.contents.set(key, doc.createNode([]));
  const seq = doc.contents.get(key, true);
  if (!YAML.isSeq(seq)) throw new Error(`'${key}' must be a list`);
  // an empty list ([]) : its entries written one below the other, never all on one line
  if (!seq.items.length) seq.flow = false;
  return seq;
}

/**
 * The entry of a name in a list : its map, or none ; names compared as the tables compare them
 * (case does not count).
 *
 * Args:
 *   seq (YAMLSeq): the list.
 *   name (string): the entry's name.
 *   nameField (string): the field an entry is named by (a disclaimer version's : version).
 *
 * Returns:
 *   YAMLMap|undefined: the entry.
 */
function entryOf(seq, name, nameField = "name") {
  const key = String(name ?? "").trim().toLowerCase();
  return seq.items.find((item) => YAML.isMap(item) && String(item.get(nameField) ?? "").trim().toLowerCase() === key);
}

/**
 * The anchors set in a node and inside it (&u), each with the value it stands for now : what the
 * aliases to them (*u) elsewhere in the file must keep once that node is changed or removed
 * (keepAliases).
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   node (YAML.Node): the node (an entry about to be edited or removed).
 *
 * Returns:
 *   Map: anchor name -> { value (its value, aliases resolved), json (that value as JSON) } ; one
 *     whose value cannot be resolved (too many aliases) left out.
 */
function anchorsIn(doc, node) {
  const out = new Map();
  YAML.visit(node, {
    Node(_, n) {
      if (!n.anchor || YAML.isAlias(n)) return;
      try {
        const value = n.toJS(doc);
        out.set(n.anchor, { value, json: JSON.stringify(value) });
      } catch {
        // an alias bomb : never copied
      }
    },
  });
  return out;
}

/**
 * Keeps the aliases to the anchors of a node changed or removed (anchorsIn, read before) : each
 * alias whose anchor is gone, or stands for another value now, made a copy of the value it stood
 * for - the entries that used it keep their values, the file stays valid YAML (no alias left
 * without its anchor).
 *
 * Args:
 *   doc (YAML.Document): the document, changed.
 *   anchors (Map): anchorsIn's, read before the change.
 */
function keepAliases(doc, anchors) {
  if (!anchors.size) return;
  const now = new Map();
  YAML.visit(doc, {
    Node(_, n) {
      if (n.anchor && !YAML.isAlias(n) && anchors.has(n.anchor)) now.set(n.anchor, n);
    },
  });
  const changed = new Set();
  for (const [name, { json }] of anchors) {
    const node = now.get(name);
    let same = false;
    try {
      same = !!node && JSON.stringify(node.toJS(doc)) === json;
    } catch {
      same = false;
    }
    if (!same) changed.add(name);
  }
  if (!changed.size) return;
  YAML.visit(doc, {
    Alias(_, alias) {
      if (changed.has(alias.source)) return doc.createNode(anchors.get(alias.source).value);
    },
  });
}

/**
 * Applies edits to a map : each key set (a new one at its place in the key order), a key whose edit
 * is undefined removed.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   map (YAMLMap): the map.
 *   edits (object): { key: value } ; undefined removes the key.
 *   keyOrder (string[]): the order a new key is put in.
 */
export function applyEdits(doc, map, edits, keyOrder = []) {
  if (!map.items.length) map.flow = false;
  for (const [k, value] of Object.entries(edits)) {
    if (value === undefined) map.delete(k);
    else setKey(doc, map, k, value, keyOrder);
  }
}

/**
 * Whether a file holds an entry of a name under a type's key.
 *
 * Args:
 *   text (string): the file's text.
 *   key (string): the type's key.
 *   name (string): the entry's name.
 *   nameField (string): the field an entry is named by.
 *
 * Returns:
 *   boolean: true when it does (false for a file that cannot be read).
 */
export function hasListEntry(text, key, name, nameField = "name") {
  try {
    const doc = mapDocument(text);
    const seq = doc.contents.get(key, true);
    return YAML.isSeq(seq) && !!entryOf(seq, name, nameField);
  } catch {
    return false;
  }
}

/**
 * Edits an entry of a type's list in a file : mutate changes its map in place ; an entry not there
 * is added whole when `whole` is given.
 *
 * Args:
 *   text (string): the file's text.
 *   key (string): the type's key.
 *   name (string): the entry's name (before the edit).
 *   mutate (function): (doc, map) => changes the entry's map.
 *   opts (object): { nameField (the field an entry is named by), whole (the entry, added at the
 *     list's end when it is not there), keyOrder (its keys' order) }.
 *
 * Returns:
 *   string: the file's new text (the same text when nothing changed).
 *
 * Raises:
 *   Error: the file is not a map of valid YAML, or its key no list.
 */
export function editListEntry(text, key, name, mutate, opts = {}) {
  const doc = mapDocument(text);
  const seq = listOf(doc, key);
  const entry = entryOf(seq, name, opts.nameField);
  if (entry) {
    // what another entry takes from it by an alias : kept as it was
    const anchors = anchorsIn(doc, entry);
    mutate(doc, entry);
    keepAliases(doc, anchors);
  } else if (opts.whole) seq.items.push(doc.createNode(sortedByOrder(opts.whole, opts.keyOrder || [])));
  else return text;
  return editedText(doc, text);
}

/**
 * Adds entries to a type's list in a file, at its end (the key made at the file's end when the
 * file has none) ; one whose name is there already left as it is, its name put in skipped for the
 * caller to say.
 *
 * Args:
 *   text (string): the file's text ('' for a new one).
 *   key (string): the type's key.
 *   entries (object[]): the entries.
 *   keyOrder (string[]): the type's key order.
 *   nameField (string): the field an entry is named by.
 *   skipped (string[]): filled with the names of the entries not added (an entry of that name is
 *     there already).
 *
 * Returns:
 *   string: the file's new text.
 *
 * Raises:
 *   Error: the file is not a map of valid YAML, or its key no list.
 */
export function appendListEntries(text, key, entries, keyOrder = [], nameField = "name", skipped = []) {
  const doc = mapDocument(text);
  const seq = listOf(doc, key);
  for (const entry of entries) {
    if (!entryOf(seq, entry[nameField], nameField)) seq.items.push(doc.createNode(sortedByOrder(entry, keyOrder)));
    else skipped.push(entry[nameField]);
  }
  return String(text ?? "").trim() ? editedText(doc, text) : doc.toString({ lineWidth: 0 });
}

/**
 * Removes an entry of a type's list in a file, the comment right above it with it ; the key goes
 * when its list is left empty.
 *
 * Args:
 *   text (string): the file's text.
 *   key (string): the type's key.
 *   name (string): the entry's name.
 *   nameField (string): the field an entry is named by.
 *
 * Returns:
 *   object: { text (the file's new text ; the same when the entry is not there), empty (true : the
 *     file holds no key any more - it is removed) }.
 */
export function removeListEntry(text, key, name, nameField = "name") {
  let doc;
  try {
    doc = mapDocument(text);
  } catch {
    return { text, empty: false };
  }
  const seq = doc.contents.get(key, true);
  const entry = YAML.isSeq(seq) ? entryOf(seq, name, nameField) : null;
  if (!entry) return { text, empty: false };
  // what another entry takes from it by an alias : a copy of it left there
  const anchors = anchorsIn(doc, entry);
  const at = seq.items.indexOf(entry);
  // the comment right above the first entry is the list's to the writer : it goes with the entry
  // (one apart from it by an empty line is the list's own, and stays)
  if (at === 0 && seq.commentBefore && !entry.spaceBefore) seq.commentBefore = undefined;
  seq.items.splice(at, 1);
  keepAliases(doc, anchors);
  // its last entry : the key goes too
  if (!seq.items.length) doc.contents.delete(key);
  if (!doc.contents.items.length) return { text: "", empty: true };
  return { text: editedText(doc, text), empty: false };
}

/**
 * Edits a type's map in a file (a type the app has one of : defaults:) : mutate changes it in place
 * ; the key is made at the file's end when the file has none.
 *
 * Args:
 *   text (string): the file's text ('' for a new one).
 *   key (string): the type's key.
 *   mutate (function): (doc, map) => changes the map.
 *
 * Returns:
 *   string: the file's new text.
 *
 * Raises:
 *   Error: the file is not a map of valid YAML, or its key holds no map.
 */
export function editMapEntry(text, key, mutate) {
  const doc = mapDocument(text);
  const value = doc.contents.get(key, true);
  if (!doc.contents.has(key) || (YAML.isScalar(value) && (value.value === null || value.value === undefined))) doc.contents.set(key, doc.createNode({}));
  const map = doc.contents.get(key, true);
  if (!YAML.isMap(map)) throw new Error(`'${key}' must be a dictionary`);
  if (!map.items.length) map.flow = false;
  mutate(doc, map);
  return String(text ?? "").trim() ? editedText(doc, text) : doc.toString({ lineWidth: 0 });
}

/**
 * An object's keys in a key order, the others after them.
 *
 * Args:
 *   obj (object): the object.
 *   keyOrder (string[]): the order.
 *
 * Returns:
 *   object: a copy, its keys in that order.
 */
export function sortedByOrder(obj, keyOrder = []) {
  const rank = (k) => (keyOrder.includes(k) ? keyOrder.indexOf(k) : keyOrder.length);
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => rank(a) - rank(b)));
}
