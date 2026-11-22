// A workflow file of the designer's Workflows section : the AWX export syntax, as `awx export`
// writes its workflows (workflow_job_templates : nodes linked on success, failure or always). A
// job template node runs one of the designer's playbooks (unified_job_template.name), with the
// node's own inventory, credentials, limit, tags... (AWX's node prompts). The awx.awx
// collection's shape reads as well (workflow_nodes at the top of a workflow, credentials and
// inventory by name) ; what the editor writes is the export's.
//
// Pure : what the file holds (workflowFileOf), what is wrong in it (workflowProblems), its edits
// on the YAML document itself so comments and order stay (the edit* functions), and a
// workflow's graph laid out (workflowGraph). AppWorkflowEditor draws and edits it.
import YAML from 'yaml';
import { playbookChoices } from '@/lib/playbookChoices';

// ─── what a workflow file holds ───────────────────────────────────────────────

// what a node runs (unified_job_template.type) : a playbook of the designer (a job template),
// another workflow, an approval, a repository pulled (AWX's project update) ; AWX's
// inventory_source has no meaning here
export const NODE_TYPES = ['job_template', 'workflow_job_template', 'workflow_approval_template', 'project'];

// a node's links, by what makes them run : its success, its failure, either
export const LINK_KINDS = ['success', 'failure', 'always'];

// what a job template node sets for its playbook's run, as AWX's node prompts ; and AnsibleForms'
// own (AWX ignores them) : the runner a node runs a template or job on (none : a designer
// playbook on the RTE), the extravar that must be true for it to run, the extravar whose value is
// all it gets - as a multistep's step runner, ifExtraVar and key
export const NODE_RUN_KEYS = [
  'runner',
  'playbook_repository',
  'if_extra_var',
  'extra_vars_key',
  'inventory',
  'credentials',
  'limit',
  'job_tags',
  'skip_tags',
  'verbosity',
  'diff_mode',
  'job_type',
];

// an identifier : what AWX's export writes (a uuid) or a name a person types
const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;

/**
 * The playbooks a playbook node may name : the first repository's, or the one it names
 * (playbook_repository), from its root (lib/playbookChoices.js).
 *
 * Args:
 *   refs (object): what the instance has ({ playbooks, playbookFiles }).
 *   repository (string): the node's playbook_repository.
 *
 * Returns:
 *   string[]: the names.
 */
function playbooksOf(refs, repository) {
  if (!repository || !refs.playbookFiles) return refs.playbooks || [];
  return playbookChoices(refs.playbookFiles.files, refs.playbookFiles.repositories, repository);
}

/** The text of a scalar node, or of a plain value. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (YAML.isScalar(node)) return node.value === null || node.value === undefined ? '' : String(node.value);
  if (YAML.isNode(node)) return '';
  return String(node);
}

/**
 * A name given either way AWX writes it : a string (the collection's) or a map with a name
 * (the export's : inventory: { name: production }).
 *
 * Args:
 *   node (any): the value's YAML node.
 *
 * Returns:
 *   string: the name, '' when none.
 */
function nameOf(node) {
  if (YAML.isMap(node)) return textOf(node.get('name', true));
  return textOf(node);
}

/**
 * The names of a list given either way : names, or maps with a name.
 *
 * Args:
 *   node (any): the list's YAML node.
 *
 * Returns:
 *   string[]: the names.
 */
function namesOf(node) {
  if (!YAML.isSeq(node)) return [];
  return node.items.map(nameOf).filter(Boolean);
}

/**
 * The line a node starts on.
 *
 * Args:
 *   lineCounter (YAML.LineCounter): the document's line counter.
 *   node (any): the YAML node.
 *
 * Returns:
 *   number|null: the line (1-based), null when unknown.
 */
function lineOf(lineCounter, node) {
  return node?.range ? lineCounter.linePos(node.range[0]).line : null;
}

/**
 * A workflow's nodes list : the export's related.workflow_nodes, or the collection's
 * workflow_nodes.
 *
 * Args:
 *   wf (YAML.YAMLMap): the workflow.
 *
 * Returns:
 *   YAML.YAMLSeq|null: the list, null when it has none.
 */
function nodesSeqOf(wf) {
  const related = wf.get('related', true);
  const inRelated = YAML.isMap(related) ? related.get('workflow_nodes', true) : null;
  if (YAML.isSeq(inRelated)) return inRelated;
  const top = wf.get('workflow_nodes', true);
  return YAML.isSeq(top) ? top : null;
}

/**
 * A node's links of one kind : its related.<kind>_nodes (the export's and the collection's),
 * each { identifier }.
 *
 * Args:
 *   node (YAML.YAMLMap): the node.
 *   kind (string): 'success', 'failure' or 'always'.
 *
 * Returns:
 *   string[]: the identifiers it leads to.
 */
function linksOf(node, kind) {
  const related = node.get('related', true);
  const list = YAML.isMap(related) ? related.get(`${kind}_nodes`, true) : node.get(`${kind}_nodes`, true);
  if (!YAML.isSeq(list)) return [];
  return list.items.map((i) => (YAML.isMap(i) ? textOf(i.get('identifier', true)) : textOf(i))).filter(Boolean);
}

/**
 * A node's credentials : the export's related.credentials, or the collection's credentials.
 *
 * Args:
 *   map (YAML.YAMLMap): the node.
 *
 * Returns:
 *   string[]: the credentials' names.
 */
function credentialsOf(map) {
  const related = map.get('related', true);
  const inRelated = YAML.isMap(related) ? related.get('credentials', true) : null;
  if (YAML.isSeq(inRelated)) return namesOf(inRelated);
  return namesOf(map.get('credentials', true));
}

/**
 * What a workflow file holds : its workflows, each with the line it starts on.
 *
 * Args:
 *   text (string): the file, in YAML.
 *
 * Returns:
 *   object: { kind : 'workflows' (a workflow file), 'empty', or 'invalid' (with error and
 *     line), workflows : [{ name, description, line, nodes : [{ identifier, type, name
 *     (what it runs : a playbook's path for a job template), timeout, converge, success,
 *     failure, always, inventory, credentials, limit, job_tags, skip_tags, verbosity,
 *     diff_mode, job_type, line }] }] }.
 */
export function workflowFileOf(text) {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text || '', { lineCounter });
  if (doc.errors.length) {
    const e = doc.errors[0];
    return { kind: 'invalid', error: e.message.split('\n')[0], line: e.linePos?.[0]?.line ?? null };
  }
  const root = doc.contents;
  if (root === null || root === undefined || (YAML.isScalar(root) && root.value === null)) {
    return { kind: 'empty', workflows: [] };
  }
  if (!YAML.isMap(root)) return { kind: 'invalid', error: 'A workflow file is a map', line: 1 };
  const wfs = root.get('workflow_job_templates', true);
  const workflows = (YAML.isSeq(wfs) ? wfs.items : []).filter(YAML.isMap).map((wf) => {
    const seq = nodesSeqOf(wf);
    const nodes = (seq ? seq.items : []).filter(YAML.isMap).map((n) => {
      const ujt = n.get('unified_job_template', true);
      return {
        identifier: textOf(n.get('identifier', true)),
        type: YAML.isMap(ujt) ? textOf(ujt.get('type', true)) : '',
        name: YAML.isMap(ujt) ? textOf(ujt.get('name', true)) : '',
        timeout: YAML.isMap(ujt) ? textOf(ujt.get('timeout', true)) : '',
        converge: textOf(n.get('all_parents_must_converge', true)) === 'true',
        success: linksOf(n, 'success'),
        failure: linksOf(n, 'failure'),
        always: linksOf(n, 'always'),
        inventory: nameOf(n.get('inventory', true)),
        credentials: credentialsOf(n),
        limit: textOf(n.get('limit', true)),
        job_tags: textOf(n.get('job_tags', true)),
        skip_tags: textOf(n.get('skip_tags', true)),
        verbosity: textOf(n.get('verbosity', true)),
        diff_mode: textOf(n.get('diff_mode', true)),
        job_type: textOf(n.get('job_type', true)),
        runner: textOf(n.get('runner', true)),
        playbook_repository: textOf(n.get('playbook_repository', true)),
        if_extra_var: textOf(n.get('if_extra_var', true)),
        extra_vars_key: textOf(n.get('extra_vars_key', true)),
        line: lineOf(lineCounter, n),
      };
    });
    return {
      name: textOf(wf.get('name', true)),
      description: textOf(wf.get('description', true)),
      line: lineOf(lineCounter, wf),
      nodes,
    };
  });
  return { kind: 'workflows', workflows };
}

/**
 * Whether a text is a workflow file : a map with workflow_job_templates.
 *
 * Args:
 *   text (string): the file.
 *
 * Returns:
 *   boolean: true when it is one.
 */
export function isWorkflowFile(text) {
  const doc = YAML.parseDocument(text || '');
  return YAML.isMap(doc.contents) && doc.contents.has('workflow_job_templates');
}

// ─── what is wrong in it ──────────────────────────────────────────────────────

/**
 * Whether a workflow's links loop : AWX refuses a workflow that is not a DAG.
 *
 * Args:
 *   nodes (object[]): the workflow's nodes (workflowFileOf).
 *
 * Returns:
 *   string|null: an identifier on the loop, null when there is none.
 */
function loopIn(nodes) {
  const next = new Map(nodes.map((n) => [n.identifier, [...n.success, ...n.failure, ...n.always]]));
  const state = new Map(); // 1 : on the path, 2 : done
  const visit = (id) => {
    if (state.get(id) === 1) return id;
    if (state.get(id) === 2 || !next.has(id)) return null;
    state.set(id, 1);
    for (const to of next.get(id)) {
      const found = visit(to);
      if (found) return found;
    }
    state.set(id, 2);
    return null;
  };
  for (const n of nodes) {
    const found = visit(n.identifier);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a job template node runs a template or job on a runner (AWX, Semaphore, Rundeck,
 * Jenkins) rather than a designer playbook on an RTE.
 *
 * Args:
 *   n (object): the node.
 *   refs (object): { runners : [{ name, type }] } - null when unknown.
 *
 * Returns:
 *   boolean: true on a template runner ; a runner of unknown type counts as one.
 */
export function onTemplateRunner(n, refs = {}) {
  if (!n?.runner) return false;
  const type = (refs.runners || []).find((r) => r.name === n.runner)?.type;
  return type !== 'rte';
}

// where a job template node runs, as the node's "Runs" offers it : a designer playbook on the RTE,
// or a runner's template (AWX - AAP and Ascender included - and Semaphore) or job (Rundeck, Jenkins)
export const RUN_TARGETS = ['rte', 'awx', 'semaphore', 'rundeck', 'jenkins'];

/**
 * Where a job template node runs : its runner's type, the RTE without a runner.
 *
 * Args:
 *   n (object): the node.
 *   refs (object): { runners : [{ name, type }] } - null when unknown.
 *
 * Returns:
 *   string|null: one of RUN_TARGETS ; null when it names a runner of unknown type (or none the
 *     instance has), or is no job template node.
 */
export function nodeRunsOn(n, refs = {}) {
  if (n?.type !== 'job_template') return null;
  if (!n.runner) return 'rte';
  const type = (refs.runners || []).find((r) => r.name === n.runner)?.type;
  return RUN_TARGETS.includes(type) ? type : null;
}

/**
 * The runner a node gets when "Runs" picks where it runs : none on the RTE (its default runs it),
 * else the type's default runner, or its first by name.
 *
 * Args:
 *   target (string): one of RUN_TARGETS.
 *   runners (object[]): the runners, each { name, type, is_default }.
 *
 * Returns:
 *   string: the runner's name ; '' on the RTE, or when the type has no runner.
 */
export function runnerForTarget(target, runners) {
  if (target === 'rte') return '';
  const ofType = (runners || []).filter((r) => r.type === target).sort((a, b) => a.name.localeCompare(b.name));
  return (ofType.find((r) => r.is_default) || ofType[0])?.name || '';
}

/**
 * What is wrong in a workflow file : what AWX would refuse, and what the instance does not
 * have (a playbook, an inventory, a credential, a repository).
 *
 * Args:
 *   file (object): the file (workflowFileOf), kind 'workflows'.
 *   refs (object): what the instance has, each an array of names, or null when unknown (not
 *     checked) : { playbooks (the designer's), inventories, credentials, repositories }.
 *
 * Returns:
 *   object[]: { message (the problem, in English : a key and its values for the page to
 *     translate is { key, values }), line }.
 */
export function workflowProblems(file, refs = {}) {
  const problems = [];
  const add = (key, values, line) => problems.push({ key, values, line });
  if (!file || file.kind !== 'workflows') return problems;
  const wfNames = new Set(file.workflows.map((w) => w.name).filter(Boolean));
  const seenWf = new Set();
  for (const wf of file.workflows) {
    if (!wf.name) add('wfNoName', {}, wf.line);
    else if (seenWf.has(wf.name)) add('wfDuplicate', { name: wf.name }, wf.line);
    seenWf.add(wf.name);
    const ids = new Set();
    for (const n of wf.nodes) {
      if (!n.identifier) add('nodeNoIdentifier', { workflow: wf.name }, n.line);
      else if (!IDENTIFIER.test(n.identifier)) add('nodeBadIdentifier', { identifier: n.identifier }, n.line);
      else if (ids.has(n.identifier)) add('nodeDuplicate', { identifier: n.identifier }, n.line);
      ids.add(n.identifier);
      if (!NODE_TYPES.includes(n.type)) add('nodeBadType', { identifier: n.identifier, type: n.type || '-' }, n.line);
      else if (!n.name) add('nodeNoName', { identifier: n.identifier }, n.line);
      else if (n.type === 'job_template' && n.runner && refs.runners && !refs.runners.some((r) => r.name === n.runner))
        add('nodeUnknownRunner', { identifier: n.identifier, runner: n.runner }, n.line);
      else if (
        n.type === 'job_template' &&
        !onTemplateRunner(n, refs) &&
        refs.playbooks &&
        !playbooksOf(refs, n.playbook_repository).includes(n.name)
      )
        add('nodeUnknownPlaybook', { identifier: n.identifier, name: n.name }, n.line);
      else if (n.type === 'workflow_job_template') {
        if (!wfNames.has(n.name)) add('nodeUnknownWf', { identifier: n.identifier, name: n.name }, n.line);
        else if (n.name === wf.name) add('nodeSelf', { identifier: n.identifier }, n.line);
      } else if (n.type === 'project' && refs.repositories && !refs.repositories.includes(n.name)) {
        add('nodeUnknownRepo', { identifier: n.identifier, name: n.name }, n.line);
      }
      // a playbook's run : the inventory and the credentials the instance has (a node on a
      // template runner names the runner's, which the instance does not list)
      if (n.type === 'job_template' && !onTemplateRunner(n, refs)) {
        if (n.inventory && refs.inventories && !refs.inventories.includes(n.inventory)) {
          add('unknownInventory', { identifier: n.identifier, inventory: n.inventory }, n.line);
        }
        for (const c of n.credentials) {
          if (refs.credentials && !refs.credentials.includes(c))
            add('unknownCredential', { identifier: n.identifier, credential: c }, n.line);
        }
      }
    }
    for (const n of wf.nodes) {
      for (const kind of LINK_KINDS) {
        for (const to of n[kind]) {
          if (!ids.has(to)) add('linkUnknown', { identifier: n.identifier, to }, n.line);
        }
      }
    }
    const loop = loopIn(wf.nodes);
    if (loop) add('loop', { workflow: wf.name, identifier: loop }, wf.line);
  }
  return problems;
}

// ─── its edits, on the YAML document ──────────────────────────────────────────

/**
 * Parses a workflow file for an edit : the document, its lists made sure of.
 *
 * Args:
 *   text (string): the file.
 *
 * Returns:
 *   YAML.Document: the document (an empty file becomes the two lists).
 */
function docOf(text) {
  const doc = YAML.parseDocument(text || '');
  if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  return doc;
}

/** The document as text, as the editor writes it. */
function textOfDoc(doc) {
  return doc.toString({ lineWidth: 0 });
}

/**
 * A list of the document's root, made when missing.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   key (string): 'workflow_job_templates'.
 *
 * Returns:
 *   YAML.YAMLSeq: the list.
 */
function rootSeq(doc, key) {
  let seq = doc.contents.get(key, true);
  if (!YAML.isSeq(seq)) {
    seq = doc.createNode([]);
    doc.contents.set(key, seq);
  }
  return seq;
}

/**
 * A workflow's map, by its place in the file.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   wfIndex (number): the workflow's place.
 *
 * Returns:
 *   YAML.YAMLMap: the workflow.
 *
 * Raises:
 *   Error: there is no workflow there.
 */
function workflowAt(doc, wfIndex) {
  const wf = rootSeq(doc, 'workflow_job_templates').items[wfIndex];
  if (!YAML.isMap(wf)) throw new Error(`No workflow at ${wfIndex}`);
  return wf;
}

/**
 * A workflow's nodes list, made (the export's related.workflow_nodes) when missing.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   wf (YAML.YAMLMap): the workflow.
 *
 * Returns:
 *   YAML.YAMLSeq: the list.
 */
function nodesSeq(doc, wf) {
  const seq = nodesSeqOf(wf);
  if (seq) return seq;
  let related = wf.get('related', true);
  if (!YAML.isMap(related)) {
    related = doc.createNode({});
    wf.set('related', related);
  }
  const created = doc.createNode([]);
  related.set('workflow_nodes', created);
  return created;
}

/**
 * A node of a workflow, by its identifier.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   wfIndex (number): the workflow's place.
 *   identifier (string): the node's identifier.
 *
 * Returns:
 *   YAML.YAMLMap: the node.
 *
 * Raises:
 *   Error: no node has it.
 */
function nodeOf(doc, wfIndex, identifier) {
  const node = nodesSeq(doc, workflowAt(doc, wfIndex)).items.find(
    (n) => YAML.isMap(n) && textOf(n.get('identifier', true)) === identifier,
  );
  if (!node) throw new Error(`No node '${identifier}'`);
  return node;
}

/**
 * A node's link list of one kind, made when missing (under related, as the export writes it).
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   node (YAML.YAMLMap): the node.
 *   kind (string): 'success', 'failure' or 'always'.
 *
 * Returns:
 *   YAML.YAMLSeq: the list.
 */
function linkSeq(doc, node, kind) {
  let related = node.get('related', true);
  if (!YAML.isMap(related)) {
    related = doc.createNode({});
    node.set('related', related);
  }
  let list = related.get(`${kind}_nodes`, true);
  if (!YAML.isSeq(list)) {
    list = doc.createNode([]);
    related.set(`${kind}_nodes`, list);
  }
  return list;
}

/**
 * A name not taken yet : the base, else the base with a number after it.
 *
 * Args:
 *   base (string): the name wanted.
 *   taken (string[]): the names taken.
 *
 * Returns:
 *   string: the name.
 */
export function freeName(base, taken) {
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * A new workflow file : one workflow, its nodes to add.
 *
 * Args:
 *   name (string): the workflow's name.
 *
 * Returns:
 *   string: the file.
 */
export function workflowSkeleton(name = 'my-workflow') {
  return textOfDoc(
    new YAML.Document({
      workflow_job_templates: [{ name, description: '', extra_vars: {}, related: { workflow_nodes: [] } }],
    }),
  );
}

/**
 * Points the nodes that run something renamed at its new name.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   type (string): what was renamed ('workflow_job_template').
 *   from (string): its old name.
 *   to (string): its new name.
 */
function renameRefs(doc, type, from, to) {
  for (const wf of rootSeq(doc, 'workflow_job_templates').items.filter(YAML.isMap)) {
    const seq = nodesSeqOf(wf);
    for (const n of seq ? seq.items.filter(YAML.isMap) : []) {
      const ujt = n.get('unified_job_template', true);
      if (YAML.isMap(ujt) && textOf(ujt.get('type', true)) === type && textOf(ujt.get('name', true)) === from) {
        ujt.set('name', to);
      }
    }
  }
}

/**
 * Adds a workflow.
 *
 * Args:
 *   text (string): the file.
 *   name (string): its name (made free of the others').
 *
 * Returns:
 *   object: { text, index (its place) }.
 */
export function editAddWorkflow(text, name) {
  const doc = docOf(text);
  const seq = rootSeq(doc, 'workflow_job_templates');
  const taken = seq.items.filter(YAML.isMap).map((m) => textOf(m.get('name', true)));
  seq.items.push(
    doc.createNode({
      name: freeName(name || 'workflow', taken),
      description: '',
      extra_vars: {},
      related: { workflow_nodes: [] },
    }),
  );
  return { text: textOfDoc(doc), index: seq.items.length - 1 };
}

/**
 * Sets a workflow's name or description (a rename : the nodes running it follow).
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): its place.
 *   key (string): 'name' or 'description'.
 *   value (string): the value.
 *
 * Returns:
 *   string: the file.
 */
export function editWorkflow(text, wfIndex, key, value) {
  const doc = docOf(text);
  const wf = workflowAt(doc, wfIndex);
  const oldName = textOf(wf.get('name', true));
  wf.set(key, value ?? '');
  if (key === 'name' && oldName && value && oldName !== value) renameRefs(doc, 'workflow_job_template', oldName, value);
  return textOfDoc(doc);
}

/**
 * Removes a workflow.
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): its place.
 *
 * Returns:
 *   string: the file.
 */
export function editRemoveWorkflow(text, wfIndex) {
  const doc = docOf(text);
  rootSeq(doc, 'workflow_job_templates').items.splice(wfIndex, 1);
  return textOfDoc(doc);
}

/**
 * Adds a node to a workflow, running something ; linked from a node when one is given.
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): the workflow's place.
 *   node (object): { identifier (made free of the others'), type, name, timeout (an
 *     approval's, seconds) }.
 *   from (object): { identifier, kind } : the node it runs after, and on what (optional).
 *
 * Returns:
 *   object: { text, identifier (the one given) }.
 */
export function editAddNode(text, wfIndex, node, from = null) {
  const doc = docOf(text);
  const wf = workflowAt(doc, wfIndex);
  const seq = nodesSeq(doc, wf);
  const taken = seq.items.filter(YAML.isMap).map((m) => textOf(m.get('identifier', true)));
  const identifier = freeName(node.identifier || 'node', taken);
  const ujt = { name: node.name || '', type: node.type || 'job_template' };
  if (ujt.type === 'workflow_approval_template') {
    ujt.description = '';
    ujt.timeout = Number(node.timeout) || 0;
  }
  seq.items.push(
    doc.createNode({
      identifier,
      unified_job_template: ujt,
      all_parents_must_converge: false,
      related: { success_nodes: [], failure_nodes: [], always_nodes: [] },
    }),
  );
  if (from?.identifier && LINK_KINDS.includes(from.kind)) {
    linkSeq(doc, nodeOf(doc, wfIndex, from.identifier), from.kind).items.push(doc.createNode({ identifier }));
  }
  return { text: textOfDoc(doc), identifier };
}

/**
 * Sets what a node runs, its identifier (a rename : the links to it follow), whether all its
 * parents must converge, or what its playbook's run uses (NODE_RUN_KEYS : the inventory as
 * { name }, the credentials under related as [{ name }], as AWX's export writes them ; an empty
 * value removed).
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): the workflow's place.
 *   identifier (string): the node.
 *   key (string): 'identifier', 'type', 'name', 'timeout', 'converge' or one of NODE_RUN_KEYS.
 *   value (any): the value.
 *
 * Returns:
 *   string: the file.
 */
export function editNode(text, wfIndex, identifier, key, value) {
  const doc = docOf(text);
  const node = nodeOf(doc, wfIndex, identifier);
  if (key === 'converge') {
    node.set('all_parents_must_converge', !!value);
  } else if (NODE_RUN_KEYS.includes(key)) {
    setRunKey(doc, node, key, value);
  } else if (key === 'identifier') {
    node.set('identifier', value);
    for (const other of nodesSeq(doc, workflowAt(doc, wfIndex)).items.filter(YAML.isMap)) {
      for (const kind of LINK_KINDS) {
        const related = other.get('related', true);
        const list = YAML.isMap(related) ? related.get(`${kind}_nodes`, true) : null;
        for (const item of YAML.isSeq(list) ? list.items : []) {
          if (YAML.isMap(item) && textOf(item.get('identifier', true)) === identifier) item.set('identifier', value);
        }
      }
    }
  } else {
    let ujt = node.get('unified_job_template', true);
    if (!YAML.isMap(ujt)) {
      ujt = doc.createNode({ name: '', type: 'job_template' });
      node.set('unified_job_template', ujt);
    }
    if (key === 'type') {
      ujt.set('type', value);
      // what it runs is of another kind now : its name is chosen again
      ujt.set('name', '');
      if (value === 'workflow_approval_template') {
        if (!ujt.has('description')) ujt.set('description', '');
        if (!ujt.has('timeout')) ujt.set('timeout', 0);
      } else {
        ujt.delete('description');
        ujt.delete('timeout');
      }
    } else if (key === 'timeout') {
      ujt.set('timeout', Number(value) || 0);
    } else {
      ujt.set(key, value);
    }
  }
  return textOfDoc(doc);
}

/**
 * Sets what a node's playbook run uses, as AWX's export writes it.
 *
 * Args:
 *   doc (YAML.Document): the document.
 *   node (YAML.YAMLMap): the node.
 *   key (string): one of NODE_RUN_KEYS.
 *   value (any): the value (credentials : an array of names) ; empty removes it.
 */
function setRunKey(doc, node, key, value) {
  if (key === 'credentials') {
    const names = (value || []).filter(Boolean);
    // the collection's credentials at the top : replaced by the export's
    if (node.has('credentials')) node.delete('credentials');
    let related = node.get('related', true);
    if (!YAML.isMap(related)) {
      related = doc.createNode({});
      node.set('related', related);
    }
    related.set('credentials', doc.createNode(names.map((n) => ({ name: n }))));
  } else if (key === 'inventory') {
    if (value) node.set('inventory', doc.createNode({ name: value }));
    else node.delete('inventory');
  } else if (key === 'verbosity') {
    if (value === '' || value === null || value === undefined) node.delete('verbosity');
    else node.set('verbosity', Number(value));
  } else if (key === 'diff_mode') {
    if (value) node.set('diff_mode', true);
    else node.delete('diff_mode');
  } else if (value === '' || value === null || value === undefined) {
    node.delete(key);
  } else {
    node.set(key, value);
  }
}

/**
 * Removes a node and the links to it.
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): the workflow's place.
 *   identifier (string): the node.
 *
 * Returns:
 *   string: the file.
 */
export function editRemoveNode(text, wfIndex, identifier) {
  const doc = docOf(text);
  const seq = nodesSeq(doc, workflowAt(doc, wfIndex));
  const at = seq.items.findIndex((n) => YAML.isMap(n) && textOf(n.get('identifier', true)) === identifier);
  if (at >= 0) seq.items.splice(at, 1);
  for (const other of seq.items.filter(YAML.isMap)) {
    const related = other.get('related', true);
    if (!YAML.isMap(related)) continue;
    for (const kind of LINK_KINDS) {
      const list = related.get(`${kind}_nodes`, true);
      if (!YAML.isSeq(list)) continue;
      list.items = list.items.filter((i) => !(YAML.isMap(i) && textOf(i.get('identifier', true)) === identifier));
    }
  }
  return textOfDoc(doc);
}

/**
 * Links a node to another : it runs after it, on its success, its failure, or either. A link
 * between the two of another kind is replaced (AWX has one per pair).
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): the workflow's place.
 *   from (string): the node it runs after.
 *   to (string): the node that runs.
 *   kind (string): 'success', 'failure' or 'always'.
 *
 * Returns:
 *   string: the file.
 */
export function editLink(text, wfIndex, from, to, kind) {
  const doc = docOf(text);
  const node = nodeOf(doc, wfIndex, from);
  for (const k of LINK_KINDS) {
    const list = linkSeq(doc, node, k);
    list.items = list.items.filter((i) => !(YAML.isMap(i) && textOf(i.get('identifier', true)) === to));
  }
  linkSeq(doc, node, kind).items.push(doc.createNode({ identifier: to }));
  return textOfDoc(doc);
}

/**
 * Removes the link between two nodes.
 *
 * Args:
 *   text (string): the file.
 *   wfIndex (number): the workflow's place.
 *   from (string): the node it ran after.
 *   to (string): the node that ran.
 *
 * Returns:
 *   string: the file.
 */
export function editUnlink(text, wfIndex, from, to) {
  const doc = docOf(text);
  const node = nodeOf(doc, wfIndex, from);
  for (const k of LINK_KINDS) {
    const list = linkSeq(doc, node, k);
    list.items = list.items.filter((i) => !(YAML.isMap(i) && textOf(i.get('identifier', true)) === to));
  }
  return textOfDoc(doc);
}

// ─── a workflow's graph ───────────────────────────────────────────────────────

// its sizes : as the jobs page's AWX graph (AppAwxWorkflow)
export const GRAPH = { nodeW: 190, nodeH: 56, gapX: 70, gapY: 26, margin: 16, startW: 70, startH: 32 };

/**
 * A workflow's graph laid out as AWX's visualizer does : a column per depth (the longest path
 * from START), each column centered, the links as curves.
 *
 * Args:
 *   nodes (object[]): the workflow's nodes (workflowFileOf).
 *
 * Returns:
 *   object: { nodes : [node with x, y], links : [{ from, to, kind, d, mx, my (its middle) }],
 *     start : { x, y }, width, height }.
 */
export function workflowGraph(nodes) {
  const { nodeW, nodeH, gapX, gapY, margin, startW, startH } = GRAPH;
  const ids = new Set(nodes.map((n) => n.identifier));
  const edges = [];
  for (const n of nodes) {
    for (const kind of LINK_KINDS)
      for (const to of n[kind] || []) if (ids.has(to)) edges.push({ from: n.identifier, to, kind });
  }
  const depth = new Map(nodes.map((n) => [n.identifier, 0]));
  // the longest path, relaxed at most once per node (a loop stops it there)
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      if (depth.get(e.from) + 1 > depth.get(e.to) && depth.get(e.from) + 1 <= nodes.length) {
        depth.set(e.to, depth.get(e.from) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = new Map();
  for (const n of nodes) {
    const d = depth.get(n.identifier);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }
  const maxDepth = Math.max(0, ...columns.keys());
  const maxRows = Math.max(1, ...[...columns.values()].map((c) => c.length));
  const height = margin * 2 + maxRows * nodeH + (maxRows - 1) * gapY;
  const width = margin * 2 + startW + gapX + (maxDepth + 1) * nodeW + maxDepth * gapX;
  const pos = new Map();
  for (const [d, list] of columns) {
    const colH = list.length * nodeH + (list.length - 1) * gapY;
    const y0 = (height - colH) / 2;
    list.forEach((n, i) =>
      pos.set(n.identifier, { x: margin + startW + gapX + d * (nodeW + gapX), y: y0 + i * (nodeH + gapY) }),
    );
  }
  const start = { x: margin, y: height / 2 - startH / 2 };
  const curve = (x1, y1, x2, y2) => {
    const dx = Math.max(30, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };
  // a link over the columns between its nodes : an arc above them, higher the more it skips, so
  // it never runs through a node and hides the links that do end there
  // (it climbs in the gap after its node, runs level over the others, comes down in the gap
  // before its target)
  const arc = (x1, y1, x2, y2, skipped) => {
    const top = Math.min(y1, y2) - nodeH / 2 - 16 - 10 * (skipped - 1);
    return (
      `M ${x1} ${y1} C ${x1 + gapX * 0.6} ${y1}, ${x1 + gapX * 0.4} ${top}, ${x1 + gapX} ${top} ` +
      `L ${x2 - gapX} ${top} C ${x2 - gapX * 0.4} ${top}, ${x2 - gapX * 0.6} ${y2}, ${x2} ${y2}`
    );
  };
  let lift = 0;
  const links = edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    const x1 = a.x + nodeW;
    const y1 = a.y + nodeH / 2;
    const x2 = b.x;
    const y2 = b.y + nodeH / 2;
    const skipped = Math.round((b.x - a.x) / (nodeW + gapX)) - 1;
    if (skipped > 0) {
      lift = Math.max(lift, nodeH / 2 + 16 + 10 * (skipped - 1) - Math.min(y1, y2) + margin);
      return { ...e, d: arc(x1, y1, x2, y2, skipped), mx: (x1 + x2) / 2, my: Math.min(y1, y2) - nodeH / 2 - 16 };
    }
    return { ...e, d: curve(x1, y1, x2, y2), mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  });
  const hasParent = new Set(edges.map((e) => e.to));
  for (const n of nodes.filter((x) => !hasParent.has(x.identifier))) {
    const b = pos.get(n.identifier);
    links.push({
      from: null,
      to: n.identifier,
      kind: 'start',
      d: curve(start.x + startW, start.y + startH / 2, b.x, b.y + nodeH / 2),
    });
  }
  // the arcs need room above the top row : everything moved down by as much
  const shift = Math.max(0, Math.ceil(lift));
  if (shift) {
    for (const p of pos.values()) p.y += shift;
    start.y += shift;
    for (const l of links)
      l.d = l.d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (m, x, y) => `${x} ${Number(y) + shift}`);
  }
  return { nodes: nodes.map((n) => ({ ...n, ...pos.get(n.identifier) })), links, start, width, height: height + shift };
}

// ─── a dry run (the Preview tab) ──────────────────────────────────────────────
// AWX's scheduling rules, as the RTE engine applies them (server/src/lib/workflowDefs.js) : the
// same here, so the preview shows what a run would do.

/**
 * Whether a link fires : its node finished, and as the link asks.
 *
 * Args:
 *   kind (string): 'success', 'failure' or 'always'.
 *   parent (object): its node's state ({ status, doNotRun }).
 *
 * Returns:
 *   boolean|null: true it fires, false it never will, null not known yet.
 */
function fires(kind, parent) {
  if (parent.doNotRun) return false;
  if (parent.status === 'skipped') return kind !== 'failure';
  if (parent.status !== 'successful' && parent.status !== 'failed') return null;
  if (kind === 'always') return true;
  return kind === 'success' ? parent.status === 'successful' : parent.status === 'failed';
}

/**
 * The next step of a run : the nodes that start (no parent, or a link into them fired - all of
 * them when their parents must converge) and those that will never run.
 *
 * Args:
 *   nodes (object[]): the workflow's nodes (workflowFileOf).
 *   state (Map): identifier -> { status : 'pending' | 'successful' | 'failed', doNotRun }.
 *
 * Returns:
 *   object: { start : [identifier], skip : [identifier] }.
 */
export function nextStep(nodes, state) {
  const parents = new Map(nodes.map((n) => [n.identifier, []]));
  for (const n of nodes)
    for (const kind of LINK_KINDS) for (const to of n[kind] || []) parents.get(to)?.push({ from: n.identifier, kind });
  const start = [];
  const skip = [];
  for (const n of nodes) {
    const s = state.get(n.identifier);
    if (s.status !== 'pending' || s.doNotRun) continue;
    const links = parents.get(n.identifier).filter((l) => state.has(l.from));
    if (!links.length) {
      start.push(n.identifier);
      continue;
    }
    const outcomes = links.map((l) => fires(l.kind, state.get(l.from)));
    if (n.converge) {
      if (outcomes.includes(false)) skip.push(n.identifier);
      else if (outcomes.every((o) => o === true)) start.push(n.identifier);
    } else if (outcomes.includes(true)) {
      start.push(n.identifier);
    } else if (outcomes.every((o) => o === false)) {
      skip.push(n.identifier);
    }
  }
  return { start, skip };
}

/**
 * A dry run of a workflow : every node that runs succeeds, but the ones said to fail.
 *
 * Args:
 *   nodes (object[]): the workflow's nodes (workflowFileOf).
 *   failing (Set): the identifiers of the nodes that fail when they run.
 *
 * Returns:
 *   object: { status : Map identifier -> 'successful' | 'failed' | 'do_not_run' | 'pending' (never
 *     reached : a loop), order : [identifier] (in the order they ran), failed : whether the
 *     workflow fails (a node failed with no failure and no always link out of it) }.
 */
export function dryRun(nodes, failing = new Set()) {
  const state = new Map(nodes.map((n) => [n.identifier, { status: 'pending', doNotRun: false }]));
  const order = [];
  for (let guard = 0; guard <= nodes.length * 2; guard++) {
    const { start, skip } = nextStep(nodes, state);
    if (!start.length && !skip.length) break;
    for (const id of skip) state.get(id).doNotRun = true;
    for (const id of start) {
      state.get(id).status = failing.has(id) ? 'failed' : 'successful';
      order.push(id);
    }
  }
  const status = new Map([...state].map(([id, s]) => [id, s.doNotRun ? 'do_not_run' : s.status]));
  const failed = nodes.some((n) => status.get(n.identifier) === 'failed' && !n.failure.length && !n.always.length);
  return { status, order, failed };
}
