'use strict';
// What a designer sees : the forms (designAllForms), the playbooks (designAllPlaybooks) and the
// workflows (designAllWorkflows) - each every one with its option on (the default, and always for
// an admin), else only a part, one rule per kind, written here once.
//
// The forms (the role option designAllForms) : every form with it on (the
// default, and always for an admin), else only the forms whose roles hold one of the user's - the
// Forms page's filter (Form.checkFormRole), enforced here on the server for the designer's config
// (GET /api/v2/config), its save (POST /api/v2/config), its restore and the load's warnings.
//
//   shown      the forms the user reaches, and the subforms they use (their list, yaml and wizard
//              steps' subforms, recursively) read only, so a form of theirs can still be edited ;
//              any other form is left out, never named
//   saved      what the user sends laid over the forms they do not see : those are kept as they
//              are (in their files, a file holding several forms keeping its hidden ones in their
//              places), a read-only subform kept unless it is unchanged, a form whose name is a
//              hidden one's refused (the name taken, nothing more said), and every form saved must
//              keep one of the user's roles, or they would no longer see it
//
// The playbooks and the workflow files (designAllPlaybooks, designAllWorkflows) : the ones a form
// the user sees in the designer uses (by the rule above : every form with designAllForms on), and
// the ones no form uses yet, so a new file stays shown until a form claims it. A form uses a
// playbook by its playbook (and playbookSubPath), its ansible steps' and the job template nodes of
// the workflows it runs ; a workflow file by its workflow, and the nested workflows those run. A
// hidden file is never listed nor read ; a save of it is refused as a name taken, its delete as a
// file not found. Edit Playbooks and Edit Workflows still decide whether a shown one is changed.
//
// The inventories, the vars files, the categories and the constants stay as they are for every
// designer.
import path from "path";
import _ from "lodash";
import Form from "../models/form.model.js";
import ProjectFiles from "../models/projectFiles.model.js";
import { workflowFiles, findWorkflowIn } from "../models/workflowRun.js";
import Errors from "./errors.js";

// each kind of the designer's files limited by a role option, and that option
export const FILE_OPTIONS = { playbooks: "designAllPlaybooks", workflows: "designAllWorkflows" };
// how deep nested workflows are followed (a workflow run stops there too)
const MAX_NESTING = 5;

// the fields the loader adds to a form, never part of it : its file, its repository, read only
const PLACEMENT = ["source", "repository", "readOnly"];

/**
 * Whether a user designs every form : the role option designAllForms (on unless a role turns it
 * off), always for an admin.
 *
 * Args:
 *   user (object): the signed-in user ({ roles, options }).
 *
 * Returns:
 *   boolean: true when no form is left out for them.
 */
export function designsAllForms(user) {
  return designsAll(user, "designAllForms");
}

/**
 * Whether a user sees every one of a kind in the designer : its role option (on unless a role
 * turns it off), always for an admin.
 *
 * Args:
 *   user (object): the signed-in user ({ roles, options }).
 *   option (string): the option (designAllForms, designAllPlaybooks, designAllWorkflows).
 *
 * Returns:
 *   boolean: true when none is left out for them.
 */
export function designsAll(user, option) {
  return (user?.roles || []).includes("admin") || user?.options?.[option] !== false;
}

/**
 * The forms a user designs, out of every form : the ones their roles reach, and the subforms those
 * use, read only.
 *
 * Args:
 *   forms (object[]): every form (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *
 * Returns:
 *   object: { visible (Set of names : theirs), readOnly (Set of names : the subforms only used),
 *     hidden (object[] : every other form, and the read-only ones, as stored) }.
 */
export function designerScope(forms, user) {
  const all = forms || [];
  if (designsAllForms(user)) return { visible: new Set(all.map((f) => f.name)), readOnly: new Set(), hidden: [] };
  const visible = new Set(all.filter((f) => Form.checkFormRole(f, user?.roles || [])).map((f) => f.name));
  const readOnly = new Set();
  for (const f of all) {
    if (!visible.has(f.name)) continue;
    for (const name of Form.subformNamesOf(f, all)) if (!visible.has(name)) readOnly.add(name);
  }
  return { visible, readOnly, hidden: all.filter((f) => !visible.has(f.name)) };
}

/**
 * Whether a "defined twice" warning (Form.duplicates) may be shown to a user : both copies reached
 * by their roles, or every form designed.
 *
 * Args:
 *   duplicate (object): { used: { roles }, skipped: { roles } }.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   boolean: true when it names nothing hidden from them.
 */
export function duplicateShown(duplicate, user) {
  if (designsAllForms(user)) return true;
  const roles = user?.roles || [];
  return Form.checkFormRole({ roles: duplicate.used?.roles }, roles) && Form.checkFormRole({ roles: duplicate.skipped?.roles }, roles);
}

/**
 * The designer's config for a user : the forms they design (the subforms they only use marked
 * readOnly), and the load's warnings without the duplicates naming a form hidden from them.
 *
 * Args:
 *   config (object): the full config (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<object>: the config as they get it (the same one when they design every form).
 */
export async function designerConfig(config, user) {
  if (designsAllForms(user)) return config;
  const { visible, readOnly } = designerScope(config.forms, user);
  const forms = (config.forms || []).filter((f) => visible.has(f.name) || readOnly.has(f.name)).map((f) => (readOnly.has(f.name) ? { ...f, readOnly: true } : f));
  // a duplicate naming a hidden form : its warning left out
  const hiddenNotices = new Set((await Form.duplicates()).filter((d) => !duplicateShown(d, user)).map((d) => d.notice));
  return { ...config, forms, warnings: (config.warnings || []).filter((w) => !hiddenNotices.has(w)) };
}

/**
 * The forms a user's save writes : theirs as sent, laid over the forms they do not see, kept as
 * stored and in their places (a file holding several forms keeps its hidden ones where they were).
 *
 * Args:
 *   sent (object[]): the forms the designer sent.
 *   stored (object[]): every form as stored (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *
 * Returns:
 *   object[]: the forms to save (the sent ones as they are when the user designs every form).
 *
 * Raises:
 *   Errors.ConflictError: a form named as one hidden from them (the name taken, nothing more said).
 *   Errors.AccessDeniedError: a read-only subform changed.
 *   Errors.BadRequestError: a form saved without one of their roles.
 */
export function designerSave(sent, stored, user) {
  const forms = sent || [];
  if (designsAllForms(user)) return forms;
  const { readOnly, hidden } = designerScope(stored, user);
  const hiddenByName = new Map(hidden.map((f) => [f.name, f]));
  const roles = user?.roles || [];
  const own = [];
  for (const f of forms) {
    const kept = hiddenByName.get(f?.name);
    if (kept && readOnly.has(f.name)) {
      // a subform a form of theirs uses : shown, not theirs to change
      if (!_.isEqual(_.omit(f, PLACEMENT), _.omit(kept, PLACEMENT))) {
        throw new Errors.AccessDeniedError(`The subform '${f.name}' is read only here: it is used by a form of yours, but none of your roles is in its roles`);
      }
      continue;
    }
    if (kept) throw new Errors.ConflictError(`The form name '${f.name}' is already taken`);
    if (!Form.checkFormRole(f, roles)) {
      const mine = roles.filter((r) => r !== "admin");
      throw new Errors.BadRequestError(`Form '${f?.name ?? ""}': keep one of your roles (${mine.join(", ")}) in its roles, or you would no longer see it`);
    }
    own.push(f);
  }
  // the stored order, each slot of theirs filled by the next of theirs as sent, the hidden ones in
  // their places ; any more of theirs (new ones) after
  const out = [];
  let next = 0;
  for (const f of stored || []) {
    if (hiddenByName.has(f.name)) out.push(_.cloneDeep(f));
    else if (next < own.length) out.push(own[next++]);
  }
  return [...out, ...own.slice(next)].map((f) => _.omit(f, ["readOnly"]));
}

/**
 * The playbooks and the workflow files some forms use, by absolute path.
 *
 * Args:
 *   forms (object[]): the forms.
 *   ctx (object): { playbookRoot (the playbooks folder), workflows (workflowFiles) }.
 *
 * Returns:
 *   object: { playbooks (Set), workflows (Set) }.
 */
function usedBy(forms, ctx) {
  const playbooks = new Set();
  const workflows = new Set();
  // a playbook named literally (an expression resolves only at launch : nothing to compare)
  const addPlaybook = (playbook, subPath) => {
    if (typeof playbook !== "string" || !playbook.trim() || /\$\(|\{\{/.test(playbook)) return;
    playbooks.add(path.resolve(ctx.playbookRoot, String(subPath || ""), playbook.trim().replace(/^(\.\/|\/)+/, "")));
  };
  // a workflow and the ones it nests : its file, and the playbooks of its job template nodes
  const addWorkflow = (ref, depth) => {
    if (!ref || depth > MAX_NESTING) return;
    let found;
    try {
      found = findWorkflowIn(ctx.workflows, ref);
    } catch {
      return; // none, or two : the form cannot run it either
    }
    const file = path.resolve(found.file);
    const seen = workflows.has(file) && depth > 0;
    workflows.add(file);
    if (seen) return;
    for (const node of found.workflow.nodes || []) {
      if (node.type === "job_template" && !node.runner) addPlaybook(node.name);
      else if (node.type === "workflow_job_template") addWorkflow(node.name, depth + 1);
    }
  };
  for (const f of forms || []) {
    if (f?.type === "ansible" || (f?.playbook && !f?.type)) addPlaybook(f.playbook, f.playbookSubPath);
    for (const step of Array.isArray(f?.steps) ? f.steps : []) {
      if (step?.type === "ansible") addPlaybook(step.playbook, step.playbookSubPath ?? f.playbookSubPath);
    }
    if (f?.type === "workflow") addWorkflow(f.workflow, 0);
  }
  return { playbooks, workflows };
}

/**
 * Which files of a kind a user sees in the designer : those a form they see uses, and those no
 * form uses.
 *
 * Args:
 *   kind (string): 'playbooks' or 'workflows' ; any other kind is shown whole.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<function|null>: (absolute path) => whether it is shown ; null when every one is.
 */
export async function fileVisibility(kind, user) {
  const option = FILE_OPTIONS[kind];
  if (!option || designsAll(user, option)) return null;
  const forms = (await Form.load(undefined, undefined, true))?.forms || [];
  const { visible } = designerScope(forms, user);
  const ctx = { playbookRoot: (await ProjectFiles.roots("playbooks"))[0].root, workflows: await workflowFiles() };
  const all = usedBy(forms, ctx)[kind];
  const theirs = usedBy(forms.filter((f) => visible.has(f.name)), ctx)[kind];
  return (abs) => !all.has(abs) || theirs.has(abs);
}

/**
 * A kind's files as the explorer lists them, without the ones hidden from the user.
 *
 * Args:
 *   kind (string): the kind.
 *   listing (object): ProjectFiles.list's answer.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<object>: the listing (the same one when every file is shown).
 */
export async function designerListing(kind, listing, user) {
  const shown = await fileVisibility(kind, user);
  if (!shown) return listing;
  const abs = await ProjectFiles.absolutes(kind, listing.files.map((f) => f.path));
  return { ...listing, files: listing.files.filter((f) => abs.has(f.path) && shown(abs.get(f.path))) };
}

/**
 * Refuses a request aimed at a file hidden from the user, saying nothing of it : a read or a
 * delete as a file not found, a save or a new file as a name taken.
 *
 * Args:
 *   kind (string): the kind.
 *   rel (string): the file, as the explorer shows it.
 *   user (object): the signed-in user.
 *   action (string): 'read', 'delete', 'save' or 'create'.
 *
 * Raises:
 *   Errors.NotFoundError: a read or a delete of a hidden file.
 *   Errors.ConflictError: a save or a new file of a hidden one's name.
 */
export async function assertFileShown(kind, rel, user, action) {
  const shown = await fileVisibility(kind, user);
  if (!shown) return;
  const abs = (await ProjectFiles.absolutes(kind, [rel])).get(rel);
  if (!abs || shown(abs)) return;
  if (action === "read" || action === "delete") throw new Errors.NotFoundError(`File '${rel}' not found`);
  throw new Errors.ConflictError(`The name '${rel}' is already taken`);
}

export default {
  FILE_OPTIONS,
  designsAll,
  designsAllForms,
  designerScope,
  duplicateShown,
  designerConfig,
  designerSave,
  fileVisibility,
  designerListing,
  assertFileShown,
};
