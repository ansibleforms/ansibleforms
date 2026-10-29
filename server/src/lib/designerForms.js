'use strict';
// What a designer sees : the forms (designAllForms), the playbooks (designAllPlaybooks) and the
// workflows (designAllWorkflows) - each every one with its option on (the default, and always for
// an admin), else only a part, one rule per kind, written here once.
//
// The forms (the role option designAllForms) : every form with it on (the
// default, and always for an admin), else only the forms whose roles hold one of the user's - the
// Forms page's filter (Form.checkFormRole), enforced here on the server for the designer's config
// (GET /api/v2/config), its save (POST /api/v2/config), its restore and the load's warnings and
// errors.
//
//   shown      the forms the user reaches ; the subforms (they have no roles) their forms use, or
//              no form uses, theirs to edit ; a subform a hidden form uses as well read only, so a
//              form of theirs can still be edited ; any other form is left out, never named (a
//              list field naming a form that is no subform shows nothing)
//   saved      what the user sends laid over the forms they do not see : those are kept as they
//              are (in their files, a file holding several forms keeping its hidden ones in their
//              places), a read-only subform kept unless it is unchanged ; refused, as a name taken
//              and nothing more said : a hidden form's name (one that does not load too), a subform
//              name a hidden form uses, a subform hidden from them used by a form of theirs, and a
//              form of theirs put in a file holding a hidden form that does not load ; every form
//              saved (a subform aside) must keep one of the user's roles, or they would no longer
//              see it
//
// The playbooks and the workflow files (designAllPlaybooks, designAllWorkflows) : the ones a form
// the user sees in the designer uses (by the rule above : every form with designAllForms on), and
// the ones no form uses yet, so a new file stays shown until a form claims it. A form uses a
// playbook by its playbook (and playbookSubPath), its ansible steps' and the job template nodes of
// the workflows it runs (on the app or an rte runner) ; a workflow file by its workflow, and the
// nested workflows those run - every workflow a reference may mean, when it means several. A
// hidden file is never listed nor read : a read or a delete of it answers as a file not found, a
// save or a new file as a file there already, in the words of a real one. A form saved naming one
// hidden from the user is refused, the visibility read from the forms as they were before the save ;
// so is a workflow file saved or made whose nodes run one (a workflow a form of theirs runs would
// show it), read from the forms and the workflows as they were before the write.
// Edit Playbooks and Edit Workflows still decide whether a shown one is changed. Each rule applies in
// every explorer (a repository's whole working tree is the workflows' and the inventories' folder) ;
// without designAllForms the form files are in none of them either (Form.formsFileTest).
//
// The git outputs a limited designer reads (a push, a repository's pull and push output) leave out
// the lines naming files ; the load's warning of a form name defined twice is left out unless both
// copies are theirs.
//
// A designer some forms, playbooks or workflows are hidden from adds no expression nor query the
// server runs to a form (assertServerCodeKept), and runs no raw expression either
// (lib/expressionPolicy.js mayRunRawExpression) : either would read any file of the server.
//
// The inventories, the vars files, the categories and the constants stay as they are for every
// designer.
import fs from "fs";
import path from "path";
import _ from "lodash";
import Form from "../models/form.model.js";
import ProjectFiles from "../models/projectFiles.model.js";
import mysql from "../models/db.model.js";
import { workflowFiles, workflowCandidates } from "../models/workflowRun.js";
import { workflowsOf } from "./workflowDefs.js";
import { runsOnServer } from "./expressionPolicy.js";
import Errors from "./errors.js";
import logger from "./logger.js";

// each kind of the designer's files limited by a role option, and that option
export const FILE_OPTIONS = { playbooks: "designAllPlaybooks", workflows: "designAllWorkflows" };
// how deep nested workflows are followed (a workflow run stops there too)
const MAX_NESTING = 5;

// the fields the loader adds to a form, never part of it : its file, its repository, read only
const PLACEMENT = ["source", "repository", "readOnly"];

// the lines of git's output naming a file : a commit's summary (a file made, removed, renamed,
// copied, its mode changed) and a pull's diffstat ( forms/deploy.yaml | 3 ++)
const GIT_FILE_LINE = /^\s*(create mode|delete mode|rename |copy |mode change )|^\s\S.*\s\|\s+(\d+ ?[+-]*|Bin \d+ -> \d+ bytes)\s*$/;

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
 * Whether a user designs every form, every playbook and every workflow : nothing is left out of
 * what they read.
 *
 * Args:
 *   user (object): the signed-in user.
 *
 * Returns:
 *   boolean: true when none of the three options is off for them.
 */
export function designsEverything(user) {
  return designsAllForms(user) && Object.values(FILE_OPTIONS).every((option) => designsAll(user, option));
}

/** A form's roles as a role check reads them : a form that does not load may hold anything there. */
const rolesOf = (form) => ({ roles: Array.isArray(form?.roles) ? form.roles : [] });

/** Whether a form is a subform : used by the forms naming it, it has no roles of its own. */
const isSubform = (form) => form?.type === "subform";

/**
 * The forms a user designs, out of every form : the ones their roles reach, the subforms no hidden
 * form uses (theirs to edit), and the subforms a hidden form uses as well as one of theirs, read
 * only.
 *
 * Args:
 *   forms (object[]): every form (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *   unloaded (object[]): the forms that do not load (Form.unloaded) ; none when not given.
 *
 * Returns:
 *   object: { visible (Set of names : theirs), readOnly (Set of names : the subforms only used),
 *     hidden (object[] : every other form, and the read-only ones, as stored), taken (Set of the
 *     names they cannot take : a hidden form's, one that does not load included, and a subform
 *     name a hidden form uses), hiddenSubforms (Set of the subforms hidden from them, not read
 *     only), files ([{ source, repository }] : the files holding a hidden form that does not
 *     load) }.
 */
export function designerScope(forms, user, unloaded = []) {
  const all = forms || [];
  if (designsAllForms(user)) {
    return { visible: new Set(all.map((f) => f.name)), readOnly: new Set(), hidden: [], taken: new Set(), hiddenSubforms: new Set(), files: [] };
  }
  const roles = user?.roles || [];
  const subforms = all.filter(isSubform).map((f) => f.name);
  const mine = new Set(all.filter((f) => !isSubform(f) && Form.checkFormRole(f, roles)).map((f) => f.name));
  // the subform names the user's forms use, and those the others use (one that does not load too) ;
  // only a form of type subform is one (a list field naming any other form shows nothing)
  const usedByMine = new Set();
  const usedByHidden = new Set();
  for (const f of all) {
    if (isSubform(f)) continue;
    for (const name of Form.subformNamesOf(f, all)) (mine.has(f.name) ? usedByMine : usedByHidden).add(name);
  }
  for (const u of unloaded || []) {
    if (!isSubform(u.form) && !Form.checkFormRole(rolesOf(u.form), roles)) for (const name of Form.subformNamesOf(u.form, all)) usedByHidden.add(name);
  }
  const visible = new Set([...mine, ...subforms.filter((name) => !usedByHidden.has(name))]);
  const readOnly = new Set(subforms.filter((name) => usedByHidden.has(name) && usedByMine.has(name)));
  const hidden = all.filter((f) => !visible.has(f.name));
  // the forms that do not load and are not theirs : a subform one when a hidden form uses it
  const unloadedHidden = (unloaded || []).filter((u) => (isSubform(u.form) ? usedByHidden.has(u.form.name) : !Form.checkFormRole(rolesOf(u.form), roles)));
  return {
    visible,
    readOnly,
    hidden,
    // a subform name a hidden form uses : one of theirs it names that is no subform aside
    taken: new Set([...hidden.map((f) => f.name), ...unloadedHidden.map((u) => u.form.name), ...[...usedByHidden].filter((name) => !visible.has(name))]),
    hiddenSubforms: new Set([...hidden, ...unloadedHidden.map((u) => u.form)].filter((f) => isSubform(f) && !readOnly.has(f.name)).map((f) => f.name)),
    files: unloadedHidden.map((u) => ({ source: u.source, repository: u.repository })),
  };
}

/**
 * Whether a "skipping duplicate form" warning (Form.duplicates) may be shown to a user : both
 * copies reached by their roles, or every form designed.
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
 * readOnly), the load's warnings without the duplicates naming a form hidden from them, and its
 * errors without those of a form hidden from them that does not load.
 *
 * Args:
 *   config (object): the full config (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *   unloaded (object[]): the forms that do not load (Form.unloaded).
 *
 * Returns:
 *   Promise<object>: the config as they get it (the same one when they design every form).
 */
export async function designerConfig(config, user, unloaded = []) {
  if (designsAllForms(user)) return config;
  const { visible, readOnly, taken } = designerScope(config.forms, user, unloaded);
  const forms = (config.forms || []).filter((f) => visible.has(f.name) || readOnly.has(f.name)).map((f) => (readOnly.has(f.name) ? { ...f, readOnly: true } : f));
  // a hidden form failing validation : its error left out
  const hiddenErrors = [...taken].map((name) => Form.validationError(name, ""));
  return {
    ...config,
    forms,
    // a duplicate naming a hidden form : its warning left out
    warnings: await designerWarnings(config.warnings, user),
    errors: (config.errors || []).filter((e) => !hiddenErrors.some((start) => String(e).startsWith(start))),
  };
}

/**
 * A load's warnings as a user reads them : without the "skipping duplicate form" warnings naming a
 * form hidden from them (duplicateShown). The forms list (GET /api/v2/config/formlist) is filtered
 * by the user's roles already, but the loader warns of every name defined twice, whoever it
 * belongs to.
 *
 * Args:
 *   warnings (string[]): the load's warnings.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<string[]>: the warnings (the same ones when they design every form).
 */
export async function designerWarnings(warnings, user) {
  if (designsAllForms(user) || !Array.isArray(warnings)) return warnings;
  const hiddenNotices = new Set((await Form.duplicates()).filter((d) => !duplicateShown(d, user)).map((d) => d.notice));
  return warnings.filter((w) => !hiddenNotices.has(w));
}

/**
 * The forms a user is told of outside the designer (the settings pages' Forms tabs, a credential's
 * Used by tab) : every form with the full settings or designAllForms, else the forms their
 * designer shows (designerScope : theirs, and the subforms they use or no hidden form uses).
 *
 * Args:
 *   forms (object[]): every form (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *
 * Returns:
 *   object[]: the forms (the same ones when nothing is left out for them).
 */
export function designerForms(forms, user) {
  if (user?.options?.showSettings || designsAllForms(user)) return forms;
  const { visible, readOnly } = designerScope(forms, user);
  return (forms || []).filter((f) => visible.has(f?.name) || readOnly.has(f?.name));
}

/**
 * Which workflow files a user is told of outside the designer (a credential's Used by tab) : every
 * one with the full settings, else those their designer shows (fileVisibility).
 *
 * Args:
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<function|null>: (absolute path) => whether it is shown ; null when every one is.
 */
export async function designerWorkflowFiles(user) {
  if (user?.options?.showSettings) return null;
  return fileVisibility("workflows", user);
}

/**
 * Whether a form is saved in a file holding a hidden form that does not load, and was not there
 * before : the file is not the user's to write into.
 *
 * Args:
 *   form (object): the form saved ({ source, repository }).
 *   before (object|undefined): the same form as stored.
 *   files (object[]): the files holding a hidden form that does not load (designerScope).
 *
 * Returns:
 *   boolean: true when it is refused.
 */
function inHiddenFile(form, before, files) {
  const repository = form?.repository ?? null;
  const there = files.some((u) => u.source === form?.source && (repository === null || repository === u.repository));
  return there && !(before && before.source === form.source && (before.repository ?? null) === repository);
}

/**
 * The forms a user's save writes : theirs as sent, laid over the forms they do not see, kept as
 * stored and in their places (a file holding several forms keeps its hidden ones where they were).
 *
 * Args:
 *   sent (object[]): the forms the designer sent.
 *   stored (object[]): every form as stored (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *   unloaded (object[]): the forms that do not load (Form.unloaded).
 *
 * Returns:
 *   object[]: the forms to save (the sent ones as they are when the user designs every form).
 *
 * Raises:
 *   Errors.ConflictError: a name they cannot take, a subform hidden from them used, a file of a
 *     hidden form that does not load (the name or the file taken, nothing more said).
 *   Errors.AccessDeniedError: a read-only subform changed.
 *   Errors.BadRequestError: a form saved without one of their roles.
 */
export function designerSave(sent, stored, user, unloaded = []) {
  const forms = sent || [];
  if (designsAllForms(user)) return forms;
  const { readOnly, hidden, taken, hiddenSubforms, files } = designerScope(stored, user, unloaded);
  const hiddenByName = new Map(hidden.map((f) => [f.name, f]));
  const storedByName = new Map((stored || []).map((f) => [f.name, f]));
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
    if (kept || taken.has(f?.name)) throw new Errors.ConflictError(Form.nameTaken(f.name));
    // a subform hidden from them, named by a form of theirs : it would show it
    for (const name of Form.subformNamesOf(f, stored || [])) {
      if (hiddenSubforms.has(name)) throw new Errors.ConflictError(Form.nameTaken(name));
    }
    if (inHiddenFile(f, storedByName.get(f?.name), files)) throw new Errors.ConflictError(`The file '${f.source}' is already taken`);
    // a subform has no roles : it is theirs while no hidden form uses it
    if (!isSubform(f) && !Form.checkFormRole(f, roles)) {
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
 * The code a form has the server run : each expression evaluated there (runsOnServer) and each
 * query with the database it runs on, wherever they are in the form (its fields, a table's).
 *
 * Args:
 *   form (object): the form.
 *
 * Returns:
 *   Set<string>: the code, one entry each.
 */
function serverCodeOf(form) {
  const out = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (runsOnServer(node)) out.add(`expression:${node.expression}`);
    if (typeof node.query === "string" && node.query) out.add(`query:${JSON.stringify(node.dbConfig ?? null)}:${node.query}`);
    Object.values(node).forEach(walk);
  };
  walk(form);
  return out;
}

/**
 * Refuses a save that gives a form server code it does not have yet, to a designer some forms,
 * playbooks or workflows are hidden from : an expression runs with the server's reach
 * (fn.fnReadYamlFile reads any file, the hidden ones too), as a raw expression does, which they
 * may not run either (lib/expressionPolicy.js mayRunRawExpression). The expressions and queries a
 * form of theirs has already (an admin's, a designer's of every form) stay, moved or not ; a new
 * one, a changed one, or one copied into another form is refused.
 *
 * Args:
 *   sent (object[]): the forms the user sent.
 *   stored (object[]): every form as stored (Form.load(undefined, undefined, true)).
 *   user (object): the signed-in user.
 *
 * Raises:
 *   Errors.AccessDeniedError: a form given an expression or a query it does not have.
 */
export function assertServerCodeKept(sent, stored, user) {
  if (designsEverything(user)) return;
  const storedByName = new Map((stored || []).map((f) => [f.name, f]));
  for (const f of sent || []) {
    const kept = serverCodeOf(storedByName.get(f?.name));
    if ([...serverCodeOf(f)].some((code) => !kept.has(code))) {
      throw new Errors.AccessDeniedError(
        `Form '${f?.name ?? ""}': an expression or a query the server runs is only added or changed by a designer who sees every form, playbook and workflow`,
      );
    }
  }
}

/**
 * The runners a workflow node runs a playbook on (type rte) : by name.
 *
 * Returns:
 *   Promise<Set<string>|null>: their names ; null when they cannot be read (every runner node's
 *     playbook then counted).
 */
async function rteRunners() {
  try {
    return new Set((await mysql.do("SELECT name, type FROM AnsibleForms.`runners`")).filter((r) => r?.type === "rte").map((r) => r.name));
  } catch (e) {
    logger.warning(`Could not read the runners for the designer's playbooks: ${e.message}`);
    return null;
  }
}

/**
 * The playbooks and the workflow files some forms use, by absolute path, and those some workflows
 * run (a workflow file about to be saved : its nodes, and the nested workflows they run).
 *
 * Args:
 *   forms (object[]): the forms.
 *   ctx (object): { playbookRoot (the playbooks folder), workflows (workflowFiles), rteRunners
 *     (rteRunners) }.
 *   workflows (object[]): workflows read from a file's text (workflowsOf) ; none when not given.
 *
 * Returns:
 *   object: { playbooks (Set), workflows (Set) }.
 */
function usedBy(forms, ctx, workflows = []) {
  const playbooks = new Set();
  const files = new Set();
  const seen = new Set();
  // a playbook named literally (an expression resolves only at launch : nothing to compare)
  const addPlaybook = (playbook, subPath) => {
    if (typeof playbook !== "string" || !playbook.trim() || /\$\(|\{\{/.test(playbook)) return;
    playbooks.add(path.resolve(ctx.playbookRoot, String(subPath || ""), playbook.trim().replace(/^(\.\/|\/)+/, "")));
  };
  // a node running a playbook : on the app, or on an rte runner (every runner when unknown)
  const runsPlaybook = (node) => node.type === "job_template" && (!node.runner || !ctx.rteRunners || ctx.rteRunners.has(node.runner));
  // a workflow and the ones it nests : its file, and the playbooks of its job template nodes ;
  // every workflow the reference may mean (two of a name : the form cannot run either, and a
  // second one never shows the first)
  const addNodes = (workflow, depth) => {
    for (const node of workflow.nodes || []) {
      if (runsPlaybook(node)) addPlaybook(node.name);
      else if (node.type === "workflow_job_template") addWorkflow(node.name, depth + 1);
    }
  };
  const addWorkflow = (ref, depth) => {
    if (!ref || depth > MAX_NESTING) return;
    for (const found of workflowCandidates(ctx.workflows, ref)) {
      files.add(path.resolve(found.file));
      if (seen.has(found)) continue;
      seen.add(found);
      addNodes(found.workflow, depth);
    }
  };
  for (const f of forms || []) {
    if (f?.type === "ansible" || (f?.playbook && !f?.type)) addPlaybook(f.playbook, f.playbookSubPath);
    for (const step of Array.isArray(f?.steps) ? f.steps : []) {
      if (step?.type === "ansible") addPlaybook(step.playbook, step.playbookSubPath ?? f.playbookSubPath);
    }
    if (f?.type === "workflow") addWorkflow(f.workflow, 0);
  }
  for (const workflow of workflows || []) addNodes(workflow, 0);
  return { playbooks, workflows: files };
}

/**
 * Which files of a kind a user sees in the designer, read from the forms as they are stored : those
 * a form they see uses, and those no form uses (one that does not load counted too).
 *
 * Args:
 *   kind (string): 'playbooks' or 'workflows' ; any other kind is shown whole.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<object|null>: { shown ((absolute path) => whether it is shown), ctx (usedBy's) } ;
 *     null when every one is.
 */
async function visibilityOf(kind, user) {
  const option = FILE_OPTIONS[kind];
  if (!option || designsAll(user, option)) return null;
  const forms = (await Form.load(undefined, undefined, true))?.forms || [];
  const unloaded = (await Form.unloaded()).map((u) => u.form);
  const { visible } = designerScope(forms, user);
  const roles = user?.roles || [];
  const ctx = { playbookRoot: (await ProjectFiles.roots("playbooks"))[0].root, workflows: await workflowFiles(), rteRunners: await rteRunners() };
  const all = usedBy([...forms, ...unloaded], ctx)[kind];
  const theirs = usedBy([...forms.filter((f) => visible.has(f.name)), ...unloaded.filter((f) => Form.checkFormRole(rolesOf(f), roles))], ctx)[kind];
  return { shown: (abs) => !all.has(abs) || theirs.has(abs), ctx };
}

/**
 * Which files of a kind a user sees in the designer (visibilityOf).
 *
 * Args:
 *   kind (string): 'playbooks' or 'workflows' ; any other kind is shown whole.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<function|null>: (absolute path) => whether it is shown ; null when every one is.
 */
export async function fileVisibility(kind, user) {
  return (await visibilityOf(kind, user))?.shown ?? null;
}

/**
 * Which files a user may not see in any of the designer's explorers, whatever explorer lists them :
 * a playbook or a workflow file hidden from them (visibilityOf, each kind's rule), and without
 * designAllForms a form file (Form.formsFileTest) - an explorer whose folder holds playbooks,
 * workflows or forms of another kind (a repository's whole working tree for the workflows and the
 * inventories) would show them otherwise.
 *
 * Args:
 *   user (object): the signed-in user.
 *
 * Returns:
 *   Promise<object|null>: { hidden ((absolute path) => whether it is hidden), formFile ((absolute
 *     path) => whether it is hidden as a form file) } ; null when nothing is.
 */
async function hiddenFiles(user) {
  const tests = [];
  for (const kind of Object.keys(FILE_OPTIONS)) {
    const visibility = await visibilityOf(kind, user);
    if (visibility) tests.push((abs) => !visibility.shown(abs));
  }
  const formFile = designsAllForms(user) ? () => false : await Form.formsFileTest();
  if (!tests.length && designsAllForms(user)) return null;
  return { hidden: (abs) => formFile(abs) || tests.some((test) => test(abs)), formFile };
}

/**
 * Refuses a save of forms naming a playbook or a workflow hidden from the user, by the files as the
 * forms stored before it show them : a form of theirs pointed at one would show it.
 *
 * Args:
 *   forms (object[]): the forms the user sent.
 *   user (object): the signed-in user.
 *
 * Raises:
 *   Errors.ConflictError: a form naming a file hidden from them (which one not said).
 */
export async function assertFilesShown(forms, user) {
  for (const kind of Object.keys(FILE_OPTIONS)) {
    const visibility = await visibilityOf(kind, user);
    if (!visibility) continue;
    for (const f of forms || []) {
      if ([...usedBy([f], visibility.ctx)[kind]].some((abs) => !visibility.shown(abs))) {
        throw new Errors.ConflictError(`Form '${f?.name ?? ""}': the ${kind === "playbooks" ? "playbook" : "workflow"} it runs is not available to you`);
      }
    }
  }
}

/**
 * Refuses a workflow file saved (or made) naming a playbook or a workflow hidden from the user, by
 * the files as the forms and the workflows stored before it show them : a workflow a form of theirs
 * runs would show what its nodes run.
 *
 * Args:
 *   content (string): the file's new text.
 *   user (object): the signed-in user.
 *
 * Raises:
 *   Errors.ConflictError: a node running a file hidden from them (which one not said).
 */
export async function assertWorkflowFileShown(content, user) {
  let workflows;
  try {
    workflows = workflowsOf(content);
  } catch {
    // not read as workflows : it runs nothing
    return;
  }
  if (!workflows.length) return;
  for (const kind of Object.keys(FILE_OPTIONS)) {
    const visibility = await visibilityOf(kind, user);
    if (!visibility) continue;
    if ([...usedBy([], visibility.ctx, workflows)[kind]].some((abs) => !visibility.shown(abs))) {
      throw new Errors.ConflictError(`The workflow runs a ${kind === "playbooks" ? "playbook" : "workflow"} that is not available to you`);
    }
  }
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
  const files = await hiddenFiles(user);
  if (!files) return listing;
  const abs = await ProjectFiles.absolutes(kind, listing.files.map((f) => f.path));
  return { ...listing, files: listing.files.filter((f) => abs.has(f.path) && !files.hidden(abs.get(f.path))) };
}

/**
 * Refuses a request aimed at a file hidden from the user, saying nothing of it : a read or a
 * delete as a file not found, a save or a new file as a file there already - each in the words
 * ProjectFiles answers a real one in.
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
 *   Errors.BadRequestError: the path is not valid (as the request itself would answer).
 */
export async function assertFileShown(kind, rel, user, action) {
  const files = await hiddenFiles(user);
  if (!files) return;
  const { abs, name } = await ProjectFiles.locate(kind, rel);
  if (!files.hidden(abs)) return;
  if (action === "read" || action === "delete") throw new Errors.NotFoundError(`File '${name}' not found`);
  // a form file only : no file of anyone's named, the write refused as it is for everyone
  // (ProjectFiles.write : a form file is the designer's forms')
  if (files.formFile(abs) && !fs.existsSync(abs)) return;
  throw new Errors.ConflictError(`File '${name}' exists already`);
}

/**
 * A git output as a user reads it : without the lines naming files when a role option leaves some
 * out for them.
 *
 * Args:
 *   output (string): the output (a commit and push, a pull).
 *   user (object): the signed-in user.
 *
 * Returns:
 *   string: the output (the same one when they design everything).
 */
export function designerGitOutput(output, user) {
  if (typeof output !== "string" || designsEverything(user)) return output;
  return output
    .split("\n")
    .filter((line) => !GIT_FILE_LINE.test(line))
    .join("\n");
}

/**
 * Repositories as a user reads them : their pull and push outputs without the lines naming files
 * (designerGitOutput) - the outputs are stored once, for every reader, so they are filtered here.
 *
 * Args:
 *   rows (object[]): the repositories.
 *   user (object): the signed-in user.
 *
 * Returns:
 *   object[]: the repositories (the same ones when they design everything).
 */
export function designerRepositories(rows, user) {
  if (designsEverything(user)) return rows;
  return (rows || []).map((r) => (r ? { ...r, pull_output: designerGitOutput(r.pull_output, user), push_output: designerGitOutput(r.push_output, user) } : r));
}

export default {
  FILE_OPTIONS,
  designsAll,
  designsAllForms,
  designsEverything,
  designerScope,
  duplicateShown,
  designerConfig,
  designerWarnings,
  designerForms,
  designerWorkflowFiles,
  designerSave,
  assertServerCodeKept,
  fileVisibility,
  assertFilesShown,
  assertWorkflowFileShown,
  designerListing,
  assertFileShown,
  designerGitOutput,
  designerRepositories,
};
