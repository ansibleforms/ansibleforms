/******************************************************************/
/*                                                                */
/*  A form's YAML edited in place, for its Visual tab in the      */
/*  designer (components/AppFormVisualEditor.vue) : the form's    */
/*  name, type, description, playbook or template, icon,          */
/*  categories and roles ; its fields read as rows, a field's     */
/*  name, type, label and required set, fields moved, removed     */
/*  and added - each edit on the YAML                             */
/*  document itself, so comments, quoting and every other key of  */
/*  the form and of its fields stay as they were written. A list  */
/*  or a map an edit changes or creates is written one item per   */
/*  line (lib/yamlBlock.js), even when it was written [a, b].     */
/*                                                                */
/******************************************************************/
import YAML from 'yaml';
import { forbiddenFieldKeys, requiredFieldKeys, forbiddenFormKeys } from '@/config/formFields';
import { toBlock, putKey, dropKey } from '@/lib/yamlBlock';

/**
 * Sets a key of a map : an existing scalar keeps its node (its quoting, its comment) ;
 * undefined removes the key. An empty placeholder ("") that gets a value loses its quotes,
 * so the value is written plain where YAML allows it. A key added, replaced or removed
 * writes the map one key per line.
 *
 * Args:
 *   map (object): the YAML map.
 *   key (string): the key.
 *   value (any): the value, or undefined.
 */
export function setKey(map, key, value) {
  if (value === undefined) {
    dropKey(map, key);
    return;
  }
  const node = map.get(key, true);
  if (YAML.isScalar(node)) {
    // the quotes were only there to write an empty string : the YAML picks them anew
    if (node.value === '' && value !== '') node.type = undefined;
    node.value = value;
  } else putKey(map, key, value);
}

/**
 * Whether the form's fields can be edited here : 'list', 'none' (no fields yet), or why not -
 * 'alias' (a list, or a field, written as an alias : rewriting it would expand it) or
 * 'unreadable' (not a list of maps).
 *
 * Args:
 *   doc (object): the form's YAML document.
 *
 * Returns:
 *   string: 'list', 'none', 'alias' or 'unreadable'.
 */
export function fieldsState(doc) {
  if (!doc || !YAML.isMap(doc.contents)) return 'unreadable';
  const seq = doc.get('fields', true);
  if (seq === undefined || seq === null) return 'none';
  if (YAML.isAlias(seq)) return 'alias';
  if (!YAML.isSeq(seq)) return 'unreadable';
  if (seq.items.some((item) => YAML.isAlias(item))) return 'alias';
  if (seq.items.some((item) => !YAML.isMap(item))) return 'unreadable';
  return 'list';
}

/**
 * The form's fields as rows : each its node, name, type, label, required, and whether its name
 * is missing or another field's.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *
 * Returns:
 *   object[]: the rows ; none when the fields cannot be edited here.
 */
export function readFields(doc) {
  if (fieldsState(doc) !== 'list') return [];
  const seq = doc.get('fields', true);
  const names = seq.items.map((node) => String(node.get('name') ?? '').trim());
  return seq.items.map((node, i) => ({
    node,
    name: String(node.get('name') ?? ''),
    type: String(node.get('type') ?? '') || 'text',
    label: String(node.get('label') ?? ''),
    required: node.get('required') === true,
    noName: !names[i],
    duplicate: !!names[i] && names.indexOf(names[i]) !== i,
  }));
}

/**
 * Sets a field's name or label : an empty label removes the key, a name always stays.
 *
 * Args:
 *   node (object): the field.
 *   key (string): 'name' or 'label'.
 *   value (string): the text.
 */
export function setFieldText(node, key, value) {
  setKey(node, key, key === 'name' ? value : value === '' ? undefined : value);
}

/**
 * Sets whether a field is required : required: true, or no key at all.
 *
 * Args:
 *   node (object): the field.
 *   on (boolean): required or not.
 */
export function setFieldRequired(node, on) {
  setKey(node, 'required', on ? true : undefined);
}

/**
 * Changes a field's type : the keys the new type forbids are removed (the schema refuses the
 * form with them), and what the new type needs but the field lacks is told.
 *
 * Args:
 *   node (object): the field.
 *   type (string): the new type.
 *
 * Returns:
 *   object: { removed: the keys removed, needs: the key sets it needs, none present ; or null }.
 */
export function setFieldType(node, type) {
  setKey(node, 'type', type);
  const removed = [];
  for (const key of forbiddenFieldKeys[type] || []) {
    if (dropKey(node, key)) removed.push(key);
  }
  const sets = requiredFieldKeys[type];
  const needs = sets && !sets.some((set) => set.every((key) => node.has(key))) ? sets : null;
  return { removed, needs };
}

/**
 * A comment between 'fields:' and the first '-' belongs to the list : it goes onto the first
 * field, so it travels with that field when the list changes (as the fields editor does).
 *
 * Args:
 *   seq (object): the fields' list.
 */
function hoistComment(seq) {
  if (!seq.commentBefore) return;
  const first = seq.items[0];
  if (!first || typeof first !== 'object') return;
  first.commentBefore = first.commentBefore ? `${seq.commentBefore}\n${first.commentBefore}` : seq.commentBefore;
  seq.commentBefore = null;
}

/**
 * Moves a field one place up or down.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   index (number): the field.
 *   step (number): -1 up, 1 down.
 *
 * Returns:
 *   boolean: true when it moved.
 */
export function moveField(doc, index, step) {
  if (fieldsState(doc) !== 'list') return false;
  const seq = doc.get('fields', true);
  const to = index + step;
  if (index < 0 || index >= seq.items.length || to < 0 || to >= seq.items.length) return false;
  hoistComment(seq);
  seq.items.splice(to, 0, seq.items.splice(index, 1)[0]);
  toBlock(seq);
  return true;
}

/**
 * Removes a field, with everything it holds.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   index (number): the field.
 *
 * Returns:
 *   boolean: true when it was removed.
 */
export function removeField(doc, index) {
  if (fieldsState(doc) !== 'list') return false;
  const seq = doc.get('fields', true);
  if (index < 0 || index >= seq.items.length) return false;
  hoistComment(seq);
  seq.items.splice(index, 1);
  toBlock(seq);
  return true;
}

/**
 * Adds a field at the end : a text field without a name yet ; the form's first field makes its
 * fields list.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *
 * Returns:
 *   boolean: true when it was added.
 */
export function addField(doc) {
  const state = fieldsState(doc);
  const field = { name: '', type: 'text', label: '' };
  if (state === 'list') toBlock(doc.get('fields', true)).items.push(doc.createNode(field));
  else if (state === 'none') putKey(doc.contents, 'fields', doc.createNode([field]));
  else return false;
  return true;
}

// ─── the form itself ──────────────────────────────────────────────────────────

/**
 * Sets a text key of the form : empty removes it, but the name (the schema requires it).
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): the key (name, description, playbook, template, icon).
 *   value (string): the text.
 */
export function setFormText(doc, key, value) {
  const text = String(value ?? '').trim();
  setKey(doc.contents, key, key === 'name' || text ? text : undefined);
}

/**
 * Changes the form's type : the keys the new type forbids are removed (the schema refuses the
 * form with them), as the form settings do.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   type (string): the new type.
 *
 * Returns:
 *   string[]: the keys removed.
 */
export function setFormType(doc, type) {
  setKey(doc.contents, 'type', type);
  const removed = [];
  for (const key of forbiddenFormKeys[type] || []) {
    if (dropKey(doc.contents, key)) removed.push(key);
  }
  return removed;
}

/**
 * A list of strings of the form (its categories, its roles), or null when it holds anything
 * else (it is then edited in the YAML).
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): 'categories' or 'roles'.
 *
 * Returns:
 *   string[]|null: the strings.
 */
export function formList(doc, key) {
  const node = doc.get(key, true);
  if (node === undefined || node === null) return [];
  if (!YAML.isSeq(node) || !node.items.every((i) => YAML.isScalar(i) && typeof i.value === 'string')) return null;
  return node.items.map((i) => i.value);
}

/**
 * Sets a list of strings of the form, keeping the node of every string it already held (its
 * quoting, its comment). No categories : the key goes (the form is then in Default) ; roles
 * stay, empty, as the schema requires them. The list, changed, is written one item per line,
 * even when it was written [a, b].
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): 'categories' or 'roles'.
 *   list (string[]): the strings.
 *
 * Returns:
 *   boolean: false when the list holds anything else (an alias, a map) : not changed.
 */
export function setFormList(doc, key, list) {
  if (formList(doc, key) === null) return false;
  if (!list.length && key === 'categories') {
    dropKey(doc.contents, key);
    return true;
  }
  const seq = doc.get(key, true);
  if (!YAML.isSeq(seq)) {
    putKey(doc.contents, key, doc.createNode(list));
    return true;
  }
  const kept = new Map(seq.items.map((i) => [i.value, i]));
  const items = list.map((v) => kept.get(v) || doc.createNode(v));
  // the same strings in the same order : nothing changed, the list keeps its style
  if (items.length === seq.items.length && items.every((item, i) => item === seq.items[i])) return true;
  seq.items = items;
  toBlock(seq);
  return true;
}

/**
 * Sets any key of the form : a number, a flag (true, or no key), a list ; undefined removes it.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): the key.
 *   value (any): the value, or undefined.
 */
export function setFormValue(doc, key, value) {
  setKey(doc.contents, key, value);
}

// ─── a field's other properties ───────────────────────────────────────────────

/**
 * A field's default as text : a scalar as it reads ; null for a list or a map (edited in the
 * YAML, a text would flatten it).
 *
 * Args:
 *   node (object): the field.
 *
 * Returns:
 *   string|null: the text, or null.
 */
export function fieldDefaultText(node) {
  const def = node.get('default', true);
  if (def === undefined || def === null) return '';
  if (YAML.isScalar(def)) return def.value === null || def.value === undefined ? '' : String(def.value);
  return null;
}

/**
 * Sets a field's default from text : a whole number that spells itself back, true and false
 * are typed as such (as the fields editor does : '0755' stays a string) ; empty removes it.
 *
 * Args:
 *   node (object): the field.
 *   text (string): the text.
 */
export function setFieldDefault(node, text) {
  const d = String(text ?? '');
  if (!d.trim()) {
    dropKey(node, 'default');
    return;
  }
  const n = Number(d.trim());
  let value = d;
  if (d.trim() === 'true') value = true;
  else if (d.trim() === 'false') value = false;
  else if (Number.isInteger(n) && String(n) === d.trim()) value = n;
  setKey(node, 'default', value);
}

/**
 * Sets whether a field's value goes to the job : output: false, or no key (it does).
 *
 * Args:
 *   node (object): the field.
 *   on (boolean): in the output or not.
 */
export function setFieldOutput(node, on) {
  setKey(node, 'output', on ? undefined : false);
}

/**
 * A field's values as YAML text, or null when they are an alias (rewriting would expand it).
 *
 * Args:
 *   node (object): the field.
 *
 * Returns:
 *   string|null: the text ('' for none), or null.
 */
export function fieldValuesText(node) {
  const values = node.get('values', true);
  if (values === undefined || values === null) return '';
  if (YAML.isAlias(values)) return null;
  return YAML.stringify(values.toJSON()).trimEnd();
}

/**
 * Sets a field's values from YAML text : a list of strings or of maps ; empty removes them.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   node (object): the field.
 *   text (string): the YAML.
 *
 * Returns:
 *   string: '' when set, else why not (not YAML, not a list).
 */
export function setFieldValues(doc, node, text) {
  if (!String(text ?? '').trim()) {
    dropKey(node, 'values');
    return '';
  }
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    return e?.message || String(e);
  }
  if (!Array.isArray(parsed)) return 'not a list';
  putKey(node, 'values', doc.createNode(parsed));
  return '';
}

// ─── a field's properties of its type (config/fieldProperties.js) ─────────────

/**
 * A property of a field as its input shows it : text, a number, a flag, a choice, a scalar (text
 * or a number), or YAML text for a list or an object.
 *
 * Args:
 *   node (object): the field.
 *   prop (object): the property ({ key, kind }).
 *
 * Returns:
 *   any: the value as its input takes it.
 */
export function fieldPropValue(node, prop) {
  const value = node.get(prop.key, true);
  if (value === undefined || value === null) return prop.kind === 'switch' ? false : '';
  const json = YAML.isNode(value) ? value.toJSON() : value;
  if (prop.kind === 'yaml') return typeof json === 'string' ? json : YAML.stringify(json).trimEnd();
  if (prop.kind === 'switch') return json === true;
  return json === null || json === undefined ? '' : String(json);
}

/**
 * Sets a property of a field from its input : a number as a number (empty removes it), a flag
 * as true or false, YAML as what it says (a list, an object, a value) ; a scalar keeps its node.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   node (object): the field.
 *   prop (object): the property ({ key, kind }).
 *   input (any): what was typed or picked.
 *
 * Returns:
 *   string: '' when set, else why not (YAML that does not parse, not a number).
 */
export function setFieldProp(doc, node, prop, input) {
  if (prop.kind === 'switch') {
    setKey(node, prop.key, !!input);
    return '';
  }
  if (prop.kind === 'number') {
    const text = String(input ?? '').trim();
    if (!text) {
      dropKey(node, prop.key);
      return '';
    }
    const n = Number(text);
    if (isNaN(n)) return 'not a number';
    setKey(node, prop.key, n);
    return '';
  }
  if (prop.kind === 'yaml') {
    let parsed;
    try {
      parsed = YAML.parse(String(input ?? ''));
    } catch (e) {
      return e?.message || String(e);
    }
    if (parsed === null || parsed === undefined) parsed = '';
    if (typeof parsed === 'object') putKey(node, prop.key, doc.createNode(parsed));
    else setKey(node, prop.key, parsed);
    return '';
  }
  // text or a number (minValue, maxLength...) : a whole number that spells itself back is one
  if (prop.kind === 'scalar') {
    const text = String(input ?? '').trim();
    const n = Number(text);
    setKey(node, prop.key, text !== '' && Number.isFinite(n) && String(n) === text ? n : text);
    return '';
  }
  setKey(node, prop.key, String(input ?? ''));
  return '';
}

/**
 * Adds a property to a field, with what a new one starts as : empty text, 0, on, the first
 * choice, an empty list or object.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   node (object): the field.
 *   prop (object): the property ({ key, kind, options, init }).
 */
export function addFieldProp(doc, node, prop) {
  if (node.has(prop.key)) return;
  const start = {
    text: '',
    scalar: '',
    number: 0,
    switch: true,
    select: prop.options?.[0] ?? '',
    yaml: prop.init ?? '',
  }[prop.kind];
  putKey(node, prop.key, typeof start === 'object' ? doc.createNode(start) : start);
}

// ─── the form's nested settings : notifications, approval, credentials ────────

/**
 * A nested setting of the form as plain data : undefined when it is not there, null when it is
 * no map (an alias, a list : edited in the YAML).
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): 'notifications', 'approval' or 'credentials'.
 *
 * Returns:
 *   object|null|undefined: its keys and values.
 */
export function formObject(doc, key) {
  const node = doc.get(key, true);
  if (node === undefined || node === null) return undefined;
  if (!YAML.isMap(node)) return null;
  return node.toJSON() || {};
}

/**
 * Sets or removes a nested setting as a whole (its switch) : on, it starts as given ; off, it
 * goes.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): the setting.
 *   start (object|undefined): what it starts as, or undefined to remove it.
 */
export function setFormObject(doc, key, start) {
  if (start === undefined) dropKey(doc.contents, key);
  else if (!doc.has(key)) putKey(doc.contents, key, doc.createNode(start));
}

/**
 * Sets one key inside a nested setting, keeping the rest of it (and its comments) : an empty
 * text or list removes the key, unless the schema requires it.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   key (string): the setting.
 *   sub (string): the key inside it.
 *   value (any): the value ; undefined removes it.
 */
export function setFormIn(doc, key, sub, value) {
  const map = doc.get(key, true);
  if (!YAML.isMap(map)) return;
  if (value === undefined) {
    dropKey(map, sub);
    return;
  }
  if (typeof value === 'object') putKey(map, sub, doc.createNode(value));
  else setKey(map, sub, value);
}

/**
 * Renames or removes a credential of the form (a key of its credentials map), keeping its
 * place ; the map goes when its last one does.
 *
 * Args:
 *   doc (object): the form's YAML document.
 *   from (string): the extravar's name now.
 *   to (string|undefined): its new name, or undefined to remove it.
 */
export function renameFormCredential(doc, from, to) {
  const map = doc.get('credentials', true);
  if (!YAML.isMap(map)) return;
  const pair = map.items.find((p) => YAML.isScalar(p.key) && String(p.key.value) === from);
  if (!pair) return;
  if (to === undefined) map.items.splice(map.items.indexOf(pair), 1);
  else pair.key = doc.createNode(to);
  toBlock(map);
  if (!map.items.length) dropKey(doc.contents, 'credentials');
}

// an email as the schema takes it (server/schema/form_schema.json, /email)
export const EMAIL = /^[A-Z0-9a-z._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,64}$/;

// ─── the form's place in the forms list (its order) ───────────────────────────

/**
 * The forms with an order, as the forms list sorts them (pages/index.vue : by order, then by
 * name) - the places another form can go after.
 *
 * Args:
 *   others (object[]): the other forms, { name, order }.
 *
 * Returns:
 *   object[]: those with a number, sorted.
 */
export function orderedForms(others) {
  return others
    .filter((f) => typeof f.order === 'number' && Number.isFinite(f.order))
    .sort((a, b) => a.order - b.order || String(a.name).localeCompare(String(b.name)));
}

/**
 * Where a form sits now : 'first', 'after:<name>' of the form just before it, or '' without an
 * order (the list puts it last, alphabetically).
 *
 * Args:
 *   order (number|undefined): its order.
 *   name (string): its name (ties are sorted by name).
 *   others (object[]): the other forms, { name, order }.
 *
 * Returns:
 *   string: its place.
 */
export function placeOf(order, name, others) {
  if (typeof order !== 'number' || !Number.isFinite(order)) return '';
  const before = orderedForms(others).filter(
    (f) => f.order < order || (f.order === order && String(f.name).localeCompare(String(name)) < 0),
  );
  return before.length ? `after:${before[before.length - 1].name}` : 'first';
}

/**
 * The order that puts a form at a place : a whole number when there is room, else halfway
 * between its two neighbours (the order takes any number : no other form changes).
 *
 * Args:
 *   place (string): 'first', 'after:<name>', or '' for none.
 *   others (object[]): the other forms, { name, order }.
 *
 * Returns:
 *   number|undefined: the order ; undefined for none.
 */
export function orderFor(place, others) {
  if (!place) return undefined;
  const list = orderedForms(others);
  if (!list.length) return 1;
  if (place === 'first') return Math.ceil(list[0].order) - 1;
  const i = list.findIndex((f) => `after:${f.name}` === place);
  if (i < 0) return undefined;
  const a = list[i].order;
  const next = list.slice(i + 1).find((f) => f.order > a);
  if (!next) return Math.floor(a) + 1;
  const whole = Math.floor(a) + 1;
  if (whole < next.order) return whole;
  return (a + next.order) / 2;
}
