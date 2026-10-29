// The Visual tab of the designer's Inventories section : an inventory (inventory.yaml) edited
// field by field - its groups and their child groups, their hosts, the variables a group or a
// host sets in it. A group is found by its path from the top (all, web : all's child web). Every
// edit changes only the keys it touches, in the YAML document itself, so comments and the rest
// stay as written ; a map an edit changes or creates is written one key per line (lib/yamlBlock.js),
// even when it was written { a: 1 }. Pure : AppInventoryEditor uses it ; config/inventoryTree.js reads the tree.
import YAML from 'yaml';
import { typed } from '@/config/playbookEdit';
import { toBlock, putKey, dropKey, yamlText } from '@/lib/yamlBlock';

/** The text of a scalar node, '' when it is something else. */
function textOf(node) {
  if (YAML.isScalar(node)) return node.value === null || node.value === undefined ? '' : String(node.value);
  return '';
}

/** The document of an inventory, a map made sure of. */
function docOf(text) {
  const doc = YAML.parseDocument(text || '');
  if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  return doc;
}
/** The document as text. */
// a host without variables, new or emptied, written `web1:` as people write it, not `web1: null` ;
// a null the file spells out (null, ~) keeps its spelling
const textOfDoc = (doc) => yamlText(doc, { lineWidth: 0, nullStr: '' });

/**
 * A map under a key of a map, made when missing (a null value too : `web:`).
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   map (YAML.YAMLMap): the map.
 *   key (string): the key.
 *
 * Returns:
 *   YAML.YAMLMap: the map under it.
 */
function mapUnder(doc, map, key) {
  let child = map.get(key, true);
  if (!YAML.isMap(child)) {
    child = doc.createNode({});
    putKey(map, key, child);
  }
  return child;
}

/**
 * Where a group is : the map holding it (the root, or its parent's children) and its own map.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   path (string[]): the group's path.
 *   make (boolean): its map made when it has none (a group written `web:`).
 *
 * Returns:
 *   object: { holder (YAML.YAMLMap), group (YAML.YAMLMap, or null) }.
 *
 * Raises:
 *   Error: no group there.
 */
function groupAt(doc, path, make = false) {
  let holder = doc.contents;
  for (let i = 0; i < path.length; i++) {
    if (!holder.has(path[i])) throw new Error(`No group '${path.slice(0, i + 1).join(' / ')}'`);
    if (i === path.length - 1) break;
    holder = mapUnder(doc, mapUnder(doc, holder, path[i]), 'children');
  }
  const name = path[path.length - 1];
  let group = holder.get(name, true);
  if (!YAML.isMap(group) && make) group = mapUnder(doc, holder, name);
  return { holder, group: YAML.isMap(group) ? group : null };
}

/**
 * The map a group's or a host's variables are in, made when missing : a group's vars, a host's
 * own map.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   target (object): { path (the group's), host (a host of it, optional) }.
 *
 * Returns:
 *   YAML.YAMLMap: the variables' map.
 */
function varsMap(doc, target) {
  const { group } = groupAt(doc, target.path, true);
  if (target.host) return mapUnder(doc, mapUnder(doc, group, 'hosts'), target.host);
  return mapUnder(doc, group, 'vars');
}

/**
 * A key of a map renamed, its value and place kept.
 *
 * Raises:
 *   Error: the new key is taken.
 */
function renameKey(doc, map, from, to) {
  if (from === to) return;
  if (map.has(to)) throw new Error(`'${to}' is there already`);
  const pair = map.items.find((p) => textOf(p.key) === from);
  if (pair) {
    pair.key = doc.createNode(to);
    toBlock(map);
  }
}

// ─── reading ──────────────────────────────────────────────────────────────────

/**
 * The variables a group or a host sets in the inventory.
 *
 * Args:
 *   text (string): the inventory.
 *   target (object): { path, host (optional) }.
 *
 * Returns:
 *   object[]: { key, value (a scalar's text), complex (a map or a list : edited in the YAML) }.
 */
export function varsOf(text, target) {
  const doc = YAML.parseDocument(text || '');
  if (!YAML.isMap(doc.contents)) return [];
  let group;
  try {
    ({ group } = groupAt(doc, target.path));
  } catch {
    return [];
  }
  if (!group) return [];
  const map = target.host ? group.get('hosts', true)?.get?.(target.host, true) : group.get('vars', true);
  if (!YAML.isMap(map)) return [];
  return map.items.map((p) => ({
    key: textOf(p.key),
    value: YAML.isScalar(p.value) ? textOf(p.value) : '',
    complex: !!p.value && !YAML.isScalar(p.value),
  }));
}

// ─── its edits ────────────────────────────────────────────────────────────────

/**
 * Adds a group : at the top, or a child of a group.
 *
 * Args:
 *   text (string): the inventory.
 *   parent (string[]|null): the parent group's path ; null : at the top.
 *   name (string): the group's name.
 *
 * Returns:
 *   string: the inventory.
 *
 * Raises:
 *   Error: the name is taken there.
 */
export function editAddGroup(text, parent, name) {
  const doc = docOf(text);
  const holder = parent ? mapUnder(doc, groupAt(doc, parent, true).group, 'children') : doc.contents;
  if (holder.has(name)) throw new Error(`'${name}' is there already`);
  putKey(holder, name, doc.createNode({ hosts: {} }));
  return textOfDoc(doc);
}

/**
 * Renames a group.
 *
 * Args:
 *   text (string): the inventory.
 *   path (string[]): the group's path.
 *   name (string): its new name.
 *
 * Returns:
 *   string: the inventory.
 */
export function editRenameGroup(text, path, name) {
  const doc = docOf(text);
  renameKey(doc, groupAt(doc, path).holder, path[path.length - 1], name);
  return textOfDoc(doc);
}

/**
 * Removes a group, its hosts and its child groups with it.
 *
 * Args:
 *   text (string): the inventory.
 *   path (string[]): the group's path.
 *
 * Returns:
 *   string: the inventory.
 */
export function editRemoveGroup(text, path) {
  const doc = docOf(text);
  dropKey(groupAt(doc, path).holder, path[path.length - 1]);
  return textOfDoc(doc);
}

/**
 * Adds a host to a group.
 *
 * Args:
 *   text (string): the inventory.
 *   path (string[]): the group's path.
 *   host (string): the host.
 *
 * Returns:
 *   string: the inventory.
 *
 * Raises:
 *   Error: the group has it already.
 */
export function editAddHost(text, path, host) {
  const doc = docOf(text);
  const hosts = mapUnder(doc, groupAt(doc, path, true).group, 'hosts');
  if (hosts.has(host)) throw new Error(`'${host}' is there already`);
  putKey(hosts, host, null);
  return textOfDoc(doc);
}

/**
 * Renames a host of a group.
 *
 * Args:
 *   text (string): the inventory.
 *   path (string[]): the group's path.
 *   host (string): the host.
 *   name (string): its new name.
 *
 * Returns:
 *   string: the inventory.
 */
export function editRenameHost(text, path, host, name) {
  const doc = docOf(text);
  renameKey(doc, mapUnder(doc, groupAt(doc, path, true).group, 'hosts'), host, name);
  return textOfDoc(doc);
}

/**
 * Removes a host from a group.
 *
 * Args:
 *   text (string): the inventory.
 *   path (string[]): the group's path.
 *   host (string): the host.
 *
 * Returns:
 *   string: the inventory.
 */
export function editRemoveHost(text, path, host) {
  const doc = docOf(text);
  const { group } = groupAt(doc, path);
  const hosts = group?.get('hosts', true);
  if (YAML.isMap(hosts)) dropKey(hosts, host);
  return textOfDoc(doc);
}

/**
 * Sets a variable of a group or a host, typed (true / false, a number, else text).
 *
 * Args:
 *   text (string): the inventory.
 *   target (object): { path, host (optional) }.
 *   key (string): the variable.
 *   value (string): its value, as typed.
 *
 * Returns:
 *   string: the inventory.
 */
export function editSetVar(text, target, key, value) {
  const doc = docOf(text);
  putKey(varsMap(doc, target), key, typed(value));
  return textOfDoc(doc);
}

/**
 * Renames a variable of a group or a host.
 *
 * Args:
 *   text (string): the inventory.
 *   target (object): { path, host (optional) }.
 *   from (string): its name.
 *   to (string): its new name.
 *
 * Returns:
 *   string: the inventory.
 */
export function editRenameVar(text, target, from, to) {
  const doc = docOf(text);
  renameKey(doc, varsMap(doc, target), from, to);
  return textOfDoc(doc);
}

/**
 * Removes a variable of a group or a host ; its map, emptied, goes too (a host back to `web1:`).
 *
 * Args:
 *   text (string): the inventory.
 *   target (object): { path, host (optional) }.
 *   key (string): the variable.
 *
 * Returns:
 *   string: the inventory.
 */
export function editRemoveVar(text, target, key) {
  const doc = docOf(text);
  const map = varsMap(doc, target);
  dropKey(map, key);
  if (!map.items.length) {
    const { group } = groupAt(doc, target.path, true);
    if (target.host) {
      // a new pair, not the parsed one with its value nulled : the yaml library writes that one as
      // an explicit key (`? web1`) rather than as `web1:`
      const hosts = group.get('hosts', true);
      const i = hosts.items.findIndex((pair) => String(pair.key?.value ?? pair.key) === target.host);
      hosts.items[i] = doc.createPair(target.host, null);
      toBlock(hosts);
    } else dropKey(group, 'vars');
  }
  return textOfDoc(doc);
}
