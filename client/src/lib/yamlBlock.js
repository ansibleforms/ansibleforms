/******************************************************************/
/*                                                                */
/*  The style of the lists and maps the app writes into a YAML    */
/*  document : one item per line ("- " items, one key per line),  */
/*  never a flow [a, b] or { a: 1 }. A flow list or map the app   */
/*  does not change keeps its style ; one it changes or creates   */
/*  is written in block style, and so is every flow list or map   */
/*  around it (a block one cannot sit inside a flow one). Flow    */
/*  input is still read as it always was.                         */
/*                                                                */
/*  Every editor that changes a YAML document in place (the form  */
/*  designer, the vars files, the inventories, the playbooks,     */
/*  the categories and the forms config) marks what it changes    */
/*  with toBlock and writes its text with yamlText.               */
/*                                                                */
/******************************************************************/
import YAML from 'yaml';

/**
 * Marks a list or a map as changed by the app : it is written in block style, one item per
 * line. Anything else (a scalar, an alias, nothing) is left as it is.
 *
 * Args:
 *   node (any): the list or map changed.
 *
 * Returns:
 *   any: the node.
 */
export function toBlock(node) {
  if (YAML.isCollection(node)) node.flow = false;
  return node;
}

/**
 * Sets a key of a map to a new value (a new node) : the map, changed, is then written one key
 * per line.
 *
 * Args:
 *   map (YAML.YAMLMap): the map.
 *   key (any): the key.
 *   value (any): the value, or its node.
 */
export function putKey(map, key, value) {
  map.set(key, value);
  toBlock(map);
}

/**
 * Removes a key of a map, if it has it : the map, changed, is then written one key per line.
 *
 * Args:
 *   map (YAML.YAMLMap): the map.
 *   key (any): the key.
 *
 * Returns:
 *   boolean: true when the key was there.
 */
export function dropKey(map, key) {
  if (!map.has(key)) return false;
  map.delete(key);
  toBlock(map);
  return true;
}

/**
 * Writes the flow lists and maps that hold a block one in block style too : a list or map the
 * app changed or created inside a flow one would otherwise be written in flow style with it.
 * A flow list or map read from the text holds only flow ones, so a block one inside it is
 * always the app's.
 *
 * Args:
 *   node (any): the node, and all it holds.
 *
 * Returns:
 *   boolean: true when the node is, or holds, a block list or map.
 */
function liftBlock(node) {
  if (!YAML.isCollection(node)) return false;
  // every item visited : each flow list or map down the tree is lifted as needed
  let holdsBlock = false;
  for (const item of node.items) {
    if (YAML.isPair(item)) {
      if (liftBlock(item.key)) holdsBlock = true;
      if (liftBlock(item.value)) holdsBlock = true;
    } else if (liftBlock(item)) holdsBlock = true;
  }
  if (holdsBlock) node.flow = false;
  return holdsBlock || !node.flow;
}

/**
 * The text of a YAML document the app changed : the lists and maps it changed or created are
 * written in block style, with the flow ones around them ; the rest as it was.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   options (object): the options of doc.toString, if any.
 *
 * Returns:
 *   string: the YAML.
 */
export function yamlText(doc, options) {
  liftBlock(doc.contents);
  return doc.toString(options);
}
