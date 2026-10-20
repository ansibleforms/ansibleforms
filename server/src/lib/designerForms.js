'use strict';
// The forms a designer works on (the role option designAllForms) : every form with it on (the
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
// Only the forms : the playbooks, the workflows, the inventories, the vars files, the categories and
// the constants stay as they are for every designer.
import _ from "lodash";
import Form from "../models/form.model.js";
import Errors from "./errors.js";

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
  return (user?.roles || []).includes("admin") || user?.options?.designAllForms !== false;
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

export default { designsAllForms, designerScope, duplicateShown, designerConfig, designerSave };
