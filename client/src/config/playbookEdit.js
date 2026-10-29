// The Visual tab of the designer's Playbooks section : a playbook edited field by field - its
// plays (name, hosts, become, gather_facts, roles) and the tasks of their sections (pre_tasks,
// tasks, post_tasks, handlers : name, module and its arguments, when, register, tags, notify,
// become, ignore_errors), a task added, removed or moved. Every edit changes only the keys it
// touches, in the YAML document itself, so comments and the rest stay as written ; a list or a
// map an edit changes or creates is written one item per line (lib/yamlBlock.js). A block, and
// an argument that is itself a map or a list, are shown, edited in the YAML. Pure :
// AppPlaybookEditor uses it.
import YAML from 'yaml';
import { PLAY_SECTIONS } from '@/config/playbookOutline';
import { toBlock, putKey, dropKey, yamlText } from '@/lib/yamlBlock';

export { PLAY_SECTIONS };

// the task keys the Visual tab edits, besides its name and its module
export const TASK_FIELDS = ['when', 'register', 'tags', 'notify', 'become', 'ignore_errors'];
// the switches among them
export const TASK_SWITCHES = ['become', 'ignore_errors'];

// the modules a new task's module field suggests
export const COMMON_MODULES = [
  'ansible.builtin.debug',
  'ansible.builtin.command',
  'ansible.builtin.shell',
  'ansible.builtin.copy',
  'ansible.builtin.template',
  'ansible.builtin.file',
  'ansible.builtin.lineinfile',
  'ansible.builtin.package',
  'ansible.builtin.service',
  'ansible.builtin.user',
  'ansible.builtin.uri',
  'ansible.builtin.get_url',
  'ansible.builtin.set_fact',
  'ansible.builtin.assert',
  'ansible.builtin.fail',
  'ansible.builtin.pause',
  'ansible.builtin.wait_for',
  'ansible.builtin.include_tasks',
  'ansible.builtin.import_tasks',
  'ansible.builtin.include_role',
];

// what a task says that is not its module : ansible's task keywords (playbookOutline's)
const TASK_KEYWORDS = new Set([
  'name',
  'action',
  'args',
  'any_errors_fatal',
  'async',
  'become',
  'become_exe',
  'become_flags',
  'become_method',
  'become_user',
  'changed_when',
  'check_mode',
  'collections',
  'connection',
  'debugger',
  'delay',
  'delegate_facts',
  'delegate_to',
  'diff',
  'environment',
  'failed_when',
  'ignore_errors',
  'ignore_unreachable',
  'listen',
  'local_action',
  'loop',
  'loop_control',
  'module_defaults',
  'no_log',
  'notify',
  'poll',
  'port',
  'register',
  'remote_user',
  'retries',
  'run_once',
  'tags',
  'throttle',
  'timeout',
  'until',
  'vars',
  'when',
  'block',
  'rescue',
  'always',
]);

/** The text of a scalar node, '' when it is something else. */
function textOf(node) {
  if (YAML.isScalar(node)) return node.value === null || node.value === undefined ? '' : String(node.value);
  return '';
}

/**
 * A value as YAML would read it typed : true / false, a number, else the text.
 *
 * Args:
 *   text (string): what was typed.
 *
 * Returns:
 *   any: the value.
 */
export function typed(text) {
  const v = String(text ?? '');
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
  return v;
}

/**
 * A list's items as text, joined : tags and notify may be a list or a comma separated text.
 *
 * Args:
 *   node (any): the value's YAML node.
 *
 * Returns:
 *   string: the text.
 */
function listText(node) {
  if (YAML.isSeq(node)) return node.items.map(textOf).filter(Boolean).join(', ');
  return textOf(node);
}

/** The key of a task's module : its first key that is not a keyword (nor a with_ loop). */
function moduleKey(task) {
  for (const p of task.items) {
    const key = textOf(p.key);
    if (key && !TASK_KEYWORDS.has(key) && !key.startsWith('with_')) return key;
  }
  return '';
}

/**
 * A task as its fields.
 *
 * Args:
 *   task (YAML.YAMLMap): the task.
 *   lineOf (function): a node's line.
 *
 * Returns:
 *   object: { kind : 'task' | 'block', line, name, module, args : 'map' (with params : [{ key,
 *     value, complex }]) | 'text' (with argsText) | 'none', when, register, tags, notify, become,
 *     ignore_errors }.
 */
function taskOf(task, lineOf) {
  const name = textOf(task.get('name', true));
  if (task.has('block')) return { kind: 'block', name, line: lineOf(task) };
  const module = moduleKey(task);
  const value = module ? task.get(module, true) : null;
  let args = 'none';
  let params = [];
  let argsText = '';
  if (YAML.isMap(value)) {
    args = 'map';
    params = value.items.map((p) => ({
      key: textOf(p.key),
      value: YAML.isScalar(p.value) ? textOf(p.value) : '',
      complex: !!p.value && !YAML.isScalar(p.value),
    }));
  } else if (YAML.isScalar(value) && value.value !== null && value.value !== undefined) {
    args = 'text';
    argsText = textOf(value);
  }
  const fields = Object.fromEntries(
    TASK_FIELDS.map((k) => [
      k,
      k === 'tags' || k === 'notify' ? listText(task.get(k, true)) : textOf(task.get(k, true)),
    ]),
  );
  return { kind: 'task', line: lineOf(task), name, module, args, params, argsText, ...fields };
}

/**
 * A playbook as its fields : its plays, their sections and tasks.
 *
 * Args:
 *   text (string): the playbook.
 *
 * Returns:
 *   object: { kind : 'playbook' | 'empty' | 'invalid' (with error, line), plays : [{ kind : 'play'
 *     | 'import', line, name, hosts, become, gather_facts, roles : [name], rolesEditable,
 *     sections : { [section] : [task] } }] }.
 */
export function playbookFields(text) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text || '', { lineCounter });
  if (doc.errors.length) {
    const e = doc.errors[0];
    return { kind: 'invalid', error: e.message.split('\n')[0], line: e.linePos?.[0]?.line ?? null };
  }
  const root = doc.contents;
  if (root === null || root === undefined || (YAML.isScalar(root) && root.value === null))
    return { kind: 'empty', plays: [] };
  if (!YAML.isSeq(root)) return { kind: 'invalid', error: 'A playbook is a list of plays', line: 1 };
  const lineOf = (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : null);
  const plays = root.items.map((play) => {
    if (!YAML.isMap(play)) return { kind: 'other', line: lineOf(play) };
    const imported =
      textOf(play.get('import_playbook', true)) || textOf(play.get('ansible.builtin.import_playbook', true));
    if (imported) return { kind: 'import', name: imported, line: lineOf(play) };
    const roles = play.get('roles', true);
    const rolesEditable = !roles || (YAML.isSeq(roles) && roles.items.every((r) => YAML.isScalar(r)));
    return {
      kind: 'play',
      line: lineOf(play),
      name: textOf(play.get('name', true)),
      hosts: textOf(play.get('hosts', true)),
      become: textOf(play.get('become', true)) === 'true',
      gather_facts: play.has('gather_facts') ? textOf(play.get('gather_facts', true)) !== 'false' : true,
      roles: YAML.isSeq(roles)
        ? roles.items.map((r) =>
            YAML.isMap(r) ? textOf(r.get('role', true)) || textOf(r.get('name', true)) : textOf(r),
          )
        : [],
      rolesEditable,
      sections: Object.fromEntries(
        PLAY_SECTIONS.filter((k) => play.has(k)).map((k) => {
          const seq = play.get(k, true);
          return [k, YAML.isSeq(seq) ? seq.items.filter(YAML.isMap).map((t) => taskOf(t, lineOf)) : []];
        }),
      ),
    };
  });
  return { kind: 'playbook', plays };
}

// ─── its edits ────────────────────────────────────────────────────────────────

/** The document of a playbook, a list of plays made sure of. */
function docOf(text) {
  const doc = YAML.parseDocument(text || '');
  if (!YAML.isSeq(doc.contents)) doc.contents = doc.createNode([]);
  return doc;
}
/** The document as text. */
const textOfDoc = (doc) => yamlText(doc, { lineWidth: 0 });

/**
 * A play, by its place.
 *
 * Raises:
 *   Error: no play there.
 */
function playAt(doc, pi) {
  const play = doc.contents.items[pi];
  if (!YAML.isMap(play)) throw new Error(`No play at ${pi}`);
  return play;
}

/**
 * A section's tasks of a play, made when missing.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   play (YAML.YAMLMap): the play.
 *   section (string): one of PLAY_SECTIONS.
 *
 * Returns:
 *   YAML.YAMLSeq: the tasks.
 */
function sectionSeq(doc, play, section) {
  let seq = play.get(section, true);
  if (!YAML.isSeq(seq)) {
    seq = doc.createNode([]);
    putKey(play, section, seq);
  }
  return seq;
}

/**
 * A task, by its place in its section (the section's maps only, as playbookFields lists them).
 *
 * Raises:
 *   Error: no task there.
 */
function taskAt(doc, pi, section, ti) {
  const seq = sectionSeq(doc, playAt(doc, pi), section);
  const task = seq.items.filter(YAML.isMap)[ti];
  if (!task) throw new Error(`No task ${ti} in ${section}`);
  return task;
}

/**
 * Adds a play : named, on all the hosts, its tasks to add.
 *
 * Args:
 *   text (string): the playbook.
 *
 * Returns:
 *   string: the playbook.
 */
export function editAddPlay(text) {
  const doc = docOf(text);
  toBlock(doc.contents).items.push(doc.createNode({ name: 'New play', hosts: 'all', gather_facts: false, tasks: [] }));
  return textOfDoc(doc);
}

/**
 * Removes a play.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): its place.
 *
 * Returns:
 *   string: the playbook.
 */
export function editRemovePlay(text, pi) {
  const doc = docOf(text);
  toBlock(doc.contents).items.splice(pi, 1);
  return textOfDoc(doc);
}

/**
 * Sets a play's name, hosts, become or gather_facts (become off : removed ; gather_facts on :
 * removed, ansible's own default).
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   key (string): 'name', 'hosts', 'become' or 'gather_facts'.
 *   value (any): the value.
 *
 * Returns:
 *   string: the playbook.
 */
export function editPlay(text, pi, key, value) {
  const doc = docOf(text);
  const play = playAt(doc, pi);
  if (key === 'become') {
    if (value) putKey(play, 'become', true);
    else dropKey(play, 'become');
  } else if (key === 'gather_facts') {
    if (value) dropKey(play, 'gather_facts');
    else putKey(play, 'gather_facts', false);
  } else if (value === '' && key === 'name') {
    dropKey(play, 'name');
  } else {
    putKey(play, key, value);
  }
  return textOfDoc(doc);
}

/**
 * Sets a play's roles (their names) ; none : the key removed.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   roles (string[]): the roles.
 *
 * Returns:
 *   string: the playbook.
 */
export function editRoles(text, pi, roles) {
  const doc = docOf(text);
  const play = playAt(doc, pi);
  if (roles.length) putKey(play, 'roles', doc.createNode(roles));
  else dropKey(play, 'roles');
  return textOfDoc(doc);
}

/**
 * Adds a task to a section (made when missing) : a debug, to change.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): one of PLAY_SECTIONS.
 *
 * Returns:
 *   object: { text, index (the task's place) }.
 */
export function editAddTask(text, pi, section) {
  const doc = docOf(text);
  const seq = sectionSeq(doc, playAt(doc, pi), section);
  toBlock(seq).items.push(doc.createNode({ name: 'New task', 'ansible.builtin.debug': { msg: '' } }));
  return { text: textOfDoc(doc), index: seq.items.filter(YAML.isMap).length - 1 };
}

/**
 * Removes a task ; its section, emptied, goes too.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *
 * Returns:
 *   string: the playbook.
 */
export function editRemoveTask(text, pi, section, ti) {
  const doc = docOf(text);
  const play = playAt(doc, pi);
  const seq = sectionSeq(doc, play, section);
  const task = taskAt(doc, pi, section, ti);
  toBlock(seq).items.splice(seq.items.indexOf(task), 1);
  if (!seq.items.length && section !== 'tasks') dropKey(play, section);
  return textOfDoc(doc);
}

/**
 * Moves a task up or down its section.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   by (number): -1 up, 1 down.
 *
 * Returns:
 *   string: the playbook (as it was when it cannot move).
 */
export function editMoveTask(text, pi, section, ti, by) {
  const doc = docOf(text);
  const seq = sectionSeq(doc, playAt(doc, pi), section);
  const task = taskAt(doc, pi, section, ti);
  const at = seq.items.indexOf(task);
  const to = at + by;
  if (to < 0 || to >= seq.items.length) return text;
  seq.items.splice(at, 1);
  toBlock(seq).items.splice(to, 0, task);
  return textOfDoc(doc);
}

/**
 * Sets a task's name, or one of TASK_FIELDS : tags and notify as lists (a comma separated text
 * split), the switches on or removed, an emptied value removed.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   key (string): 'name' or one of TASK_FIELDS.
 *   value (any): the value.
 *
 * Returns:
 *   string: the playbook.
 */
export function editTask(text, pi, section, ti, key, value) {
  const doc = docOf(text);
  const task = taskAt(doc, pi, section, ti);
  if (TASK_SWITCHES.includes(key)) {
    if (value) putKey(task, key, true);
    else dropKey(task, key);
  } else if (value === '' || value === null || value === undefined) {
    dropKey(task, key);
  } else if (key === 'tags' || key === 'notify') {
    const items = String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    putKey(task, key, items.length === 1 && key === 'notify' ? items[0] : doc.createNode(items));
  } else if (key === 'name') {
    // the name first, as a task is read
    task.delete('name');
    toBlock(task).items.unshift(doc.createPair('name', value));
  } else {
    putKey(task, key, value);
  }
  return textOfDoc(doc);
}

/**
 * Changes a task's module, its arguments kept (a module set where there was none : no arguments).
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   module (string): the new module.
 *
 * Returns:
 *   string: the playbook.
 */
export function editModule(text, pi, section, ti, module) {
  const doc = docOf(text);
  const task = taskAt(doc, pi, section, ti);
  const old = moduleKey(task);
  if (!module || old === module) return text;
  const pair = old ? task.items.find((p) => textOf(p.key) === old) : null;
  if (pair) {
    pair.key = doc.createNode(module);
    toBlock(task);
  } else putKey(task, module, doc.createNode({}));
  return textOfDoc(doc);
}

/**
 * Sets one of a task's arguments (its module's map ; made a map when it had none), typed.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   arg (string): the argument.
 *   value (string): its value, as typed (typed()).
 *
 * Returns:
 *   string: the playbook.
 */
export function editArg(text, pi, section, ti, arg, value) {
  const doc = docOf(text);
  const task = taskAt(doc, pi, section, ti);
  const module = moduleKey(task);
  if (!module) throw new Error('This task has no module');
  let args = task.get(module, true);
  if (!YAML.isMap(args)) {
    args = doc.createNode({});
    putKey(task, module, args);
  }
  putKey(args, arg, typed(value));
  return textOfDoc(doc);
}

/**
 * Renames one of a task's arguments, its value kept.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   from (string): its name.
 *   to (string): its new name.
 *
 * Returns:
 *   string: the playbook.
 */
export function editRenameArg(text, pi, section, ti, from, to) {
  const doc = docOf(text);
  const task = taskAt(doc, pi, section, ti);
  const args = task.get(moduleKey(task), true);
  if (!YAML.isMap(args) || !to || from === to) return text;
  if (args.has(to)) throw new Error(`'${to}' is set already`);
  const pair = args.items.find((p) => textOf(p.key) === from);
  if (pair) {
    pair.key = doc.createNode(to);
    toBlock(args);
  }
  return textOfDoc(doc);
}

/**
 * Removes one of a task's arguments.
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   arg (string): the argument.
 *
 * Returns:
 *   string: the playbook.
 */
export function editRemoveArg(text, pi, section, ti, arg) {
  const doc = docOf(text);
  const task = taskAt(doc, pi, section, ti);
  const args = task.get(moduleKey(task), true);
  if (YAML.isMap(args)) dropKey(args, arg);
  return textOfDoc(doc);
}

/**
 * Sets a task's arguments as one line (free form : command, shell ; key=value pairs).
 *
 * Args:
 *   text (string): the playbook.
 *   pi (number): the play's place.
 *   section (string): the section.
 *   ti (number): the task's place.
 *   value (string): the line.
 *
 * Returns:
 *   string: the playbook.
 */
export function editArgsText(text, pi, section, ti, value) {
  const doc = docOf(text);
  const task = taskAt(doc, pi, section, ti);
  const module = moduleKey(task);
  if (!module) throw new Error('This task has no module');
  putKey(task, module, value === '' ? null : value);
  return textOfDoc(doc);
}
