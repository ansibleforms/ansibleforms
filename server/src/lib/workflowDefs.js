// A workflow of the designer's Workflows section, as the RTE engine runs it : the AWX export
// syntax (workflow_job_templates, its nodes under related.workflow_nodes) or the awx.awx
// collection's (workflow_nodes at the top of a workflow), read into one shape ; what AWX would
// refuse in it ; and AWX's scheduling rules - which nodes start, which will never run, and
// whether the workflow failed. Pure : models/workflowRun.js reads the files and runs the jobs.
import YAML from "yaml";

// what a node runs : a playbook of the designer (a job template), another workflow, an approval,
// a repository pulled (AWX's project update)
export const NODE_TYPES = ["job_template", "workflow_job_template", "workflow_approval_template", "project"];

// a node's links, by what makes them fire : its success, its failure, either
export const LINK_KINDS = ["success", "failure", "always"];

// a node's statuses, as AWX names them (the jobs page colours them) ; finished ones are final.
// skipped is AnsibleForms' own : a node whose condition (if_extra_var) was not met - it counts
// as a success for what comes after it, as a skipped multistep step does
export const FINISHED = ["successful", "failed", "canceled", "skipped"];

// an identifier : what AWX's export writes (a uuid) or a name a person types
const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;

/**
 * A name given either way AWX writes it : a string (the collection's) or a map with a name
 * (the export's : inventory: { name: production }).
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   string: the name, '' when none.
 */
function nameOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return String(value.name ?? "");
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Extra vars given either way AWX writes them : a map, or YAML / JSON text (the export's).
 *
 * Args:
 *   value (any): the value.
 *
 * Returns:
 *   object: the variables ({} when none).
 *
 * Raises:
 *   Error: text that is not a map.
 */
export function varsOf(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = YAML.parse(value);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  throw new Error("extra vars are not a map");
}

/**
 * A node's credentials : the export's related.credentials, or the collection's credentials ;
 * each with what kind it is when the export says (its credential_type, Vault for a vault one).
 *
 * Args:
 *   node (object): the node.
 *
 * Returns:
 *   object[]: { name, kind (the credential type's name or kind, lower case, '' unknown) }.
 */
function credentialsOf(node) {
  const list = Array.isArray(node?.related?.credentials) ? node.related.credentials : Array.isArray(node?.credentials) ? node.credentials : [];
  return list
    .map((c) => {
      const type = c && typeof c === "object" ? c.credential_type : null;
      const kind = type && typeof type === "object" ? type.kind || type.name || "" : type || "";
      return { name: nameOf(c), kind: String(kind).toLowerCase() };
    })
    .filter((c) => c.name);
}

/**
 * A node's links of one kind, each the identifier it leads to.
 *
 * Args:
 *   node (object): the node.
 *   kind (string): 'success', 'failure' or 'always'.
 *
 * Returns:
 *   string[]: the identifiers.
 */
function linksOf(node, kind) {
  const list = node?.related?.[`${kind}_nodes`] ?? node?.[`${kind}_nodes`];
  if (!Array.isArray(list)) return [];
  return list.map((i) => (i && typeof i === "object" ? String(i.identifier ?? "") : String(i ?? ""))).filter(Boolean);
}

/**
 * The workflows of a workflow file, in one shape.
 *
 * Args:
 *   text (string): the file, in YAML.
 *
 * Returns:
 *   object[]: { name, description, extra_vars, nodes : [{ identifier, type, name, description,
 *     timeout, converge, success, failure, always, extra_data, inventory, credentials, limit,
 *     job_tags, skip_tags, verbosity, diff_mode, job_type, runner, playbook_repository,
 *     if_extra_var, extra_vars_key }] }. The last four are AnsibleForms' own (AWX ignores them) : the runner a
 *     job template node runs a template or job on (none : a designer playbook on the RTE), the
 *     extravar that must be true for the node to run, the extravar whose value is all the node
 *     gets.
 *
 * Raises:
 *   Error: the text is not YAML.
 */
export function workflowsOf(text) {
  const data = YAML.parse(text || "");
  const list = Array.isArray(data?.workflow_job_templates) ? data.workflow_job_templates : [];
  return list
    .filter((wf) => wf && typeof wf === "object")
    .map((wf) => {
      const raw = Array.isArray(wf.related?.workflow_nodes) ? wf.related.workflow_nodes : Array.isArray(wf.workflow_nodes) ? wf.workflow_nodes : [];
      const nodes = raw
        .filter((n) => n && typeof n === "object")
        .map((n) => {
          const ujt = n.unified_job_template && typeof n.unified_job_template === "object" ? n.unified_job_template : {};
          return {
            identifier: String(n.identifier ?? ""),
            type: String(ujt.type ?? ""),
            name: String(ujt.name ?? ""),
            description: String(ujt.description ?? ""),
            timeout: Number(ujt.timeout) || 0,
            converge: n.all_parents_must_converge === true,
            success: linksOf(n, "success"),
            failure: linksOf(n, "failure"),
            always: linksOf(n, "always"),
            extra_data: n.extra_data ?? {},
            inventory: nameOf(n.inventory),
            credentials: credentialsOf(n),
            limit: n.limit ? String(n.limit) : "",
            job_tags: n.job_tags ? String(n.job_tags) : "",
            skip_tags: n.skip_tags ? String(n.skip_tags) : "",
            verbosity: Number(n.verbosity) || 0,
            diff_mode: n.diff_mode === true,
            job_type: n.job_type ? String(n.job_type) : "",
            runner: n.runner ? String(n.runner) : "",
            // AnsibleForms' own : the repository a playbook node runs from (its root), as a form's
            // playbookRepository
            playbook_repository: n.playbook_repository ? String(n.playbook_repository) : "",
            if_extra_var: n.if_extra_var ? String(n.if_extra_var) : "",
            extra_vars_key: n.extra_vars_key ? String(n.extra_vars_key) : "",
          };
        });
      return { name: String(wf.name ?? ""), description: String(wf.description ?? ""), extra_vars: wf.extra_vars ?? {}, nodes };
    });
}

/**
 * Whether a workflow's links loop : AWX refuses a workflow that is not a DAG.
 *
 * Args:
 *   nodes (object[]): the nodes.
 *
 * Returns:
 *   string|null: an identifier on the loop, null when there is none.
 */
function loopIn(nodes) {
  const next = new Map(nodes.map((n) => [n.identifier, [...n.success, ...n.failure, ...n.always]]));
  const state = new Map();
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
 * What would stop a workflow from running : what AWX refuses.
 *
 * Args:
 *   wf (object): the workflow (workflowsOf).
 *
 * Returns:
 *   string[]: the problems, in English ; none when it can run.
 */
export function workflowErrors(wf) {
  const errors = [];
  if (!wf.nodes.length) errors.push(`workflow '${wf.name}' has no node`);
  const ids = new Set();
  for (const n of wf.nodes) {
    if (!IDENTIFIER.test(n.identifier)) errors.push(`'${n.identifier}' is not a node identifier`);
    else if (ids.has(n.identifier)) errors.push(`two nodes are '${n.identifier}'`);
    ids.add(n.identifier);
    if (!NODE_TYPES.includes(n.type)) errors.push(`node '${n.identifier}' runs '${n.type || "-"}': a job_template, a workflow_job_template, a workflow_approval_template or a project`);
    else if (!n.name) errors.push(`node '${n.identifier}' runs nothing`);
    else if (n.type === "workflow_job_template" && n.name === wf.name) errors.push(`node '${n.identifier}' runs its own workflow`);
    try {
      varsOf(n.extra_data);
    } catch {
      errors.push(`node '${n.identifier}': its extra_data is not a map`);
    }
  }
  for (const n of wf.nodes) {
    for (const kind of LINK_KINDS) for (const to of n[kind]) if (!ids.has(to)) errors.push(`node '${n.identifier}' links to '${to}', which is not a node`);
  }
  const loop = loopIn(wf.nodes);
  if (loop) errors.push(`the links loop through '${loop}': a workflow runs forward only`);
  try {
    varsOf(wf.extra_vars);
  } catch {
    errors.push("its extra_vars are not a map");
  }
  return errors;
}

/**
 * The links into each node : who it runs after, and on what.
 *
 * Args:
 *   nodes (object[]): the nodes.
 *
 * Returns:
 *   Map: identifier -> [{ from, kind }].
 */
export function parentsOf(nodes) {
  const parents = new Map(nodes.map((n) => [n.identifier, []]));
  for (const n of nodes) {
    for (const kind of LINK_KINDS) for (const to of n[kind]) parents.get(to)?.push({ from: n.identifier, kind });
  }
  return parents;
}

/**
 * Whether a link fires : its node finished, and as the link asks.
 *
 * Args:
 *   kind (string): the link's kind.
 *   parent (object): the node it comes from's state ({ status, doNotRun }).
 *
 * Returns:
 *   boolean|null: true it fires, false it never will, null not known yet.
 */
function fires(kind, parent) {
  if (parent.doNotRun) return false;
  if (!FINISHED.includes(parent.status)) return null;
  if (parent.status === "canceled") return false;
  if (kind === "always") return true;
  // a node skipped on its condition lets what follows it run, as a success
  if (parent.status === "skipped") return kind === "success";
  return kind === "success" ? parent.status === "successful" : parent.status === "failed";
}

/**
 * The artifacts a node gets from the nodes before it, AWX's way : what each parent whose link
 * into it fired passes on (its own ancestors' artifacts, and its job's set_stats data over them),
 * merged in the order the parents are written - a later one wins a key both set.
 *
 * Args:
 *   nodes (object[]): the workflow's nodes.
 *   state (Map): identifier -> { status, doNotRun, artifacts (what it passes on) }.
 *   identifier (string): the node.
 *
 * Returns:
 *   object: the artifacts.
 */
export function ancestorArtifacts(nodes, state, identifier) {
  const out = {};
  for (const { from, kind } of parentsOf(nodes).get(identifier) || []) {
    const parent = state.get(from);
    if (parent && fires(kind, parent) === true) Object.assign(out, parent.artifacts || {});
  }
  return out;
}

/**
 * The next step of a workflow, by AWX's rules : a node without a parent starts at once ; one
 * with parents starts when a link into it fires (all of them when its parents must converge),
 * and will never run (do not run) once that cannot happen any more.
 *
 * Args:
 *   nodes (object[]): the nodes.
 *   state (Map): identifier -> { status : 'pending' | 'running' | 'successful' | 'failed' |
 *     'canceled', doNotRun }.
 *
 * Returns:
 *   object: { start : [identifier] (to run now), skip : [identifier] (never to run) }.
 */
export function nextStep(nodes, state) {
  const parents = parentsOf(nodes);
  const start = [];
  const skip = [];
  for (const n of nodes) {
    const s = state.get(n.identifier);
    if (s.status !== "pending" || s.doNotRun) continue;
    const links = parents.get(n.identifier);
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
 * Whether a finished workflow failed, by AWX's rule : a node failed and nothing was there to
 * handle it (no failure and no always link out of it).
 *
 * Args:
 *   nodes (object[]): the nodes.
 *   state (Map): identifier -> { status, doNotRun }.
 *
 * Returns:
 *   boolean: true when it failed.
 */
export function workflowFailed(nodes, state) {
  return nodes.some((n) => state.get(n.identifier)?.status === "failed" && !n.failure.length && !n.always.length);
}
