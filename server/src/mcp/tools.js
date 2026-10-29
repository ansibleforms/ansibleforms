'use strict';
import { z } from 'zod';
import { resolveForm, normalizeFields, isDynamicField } from '../lib/formEngine/resolve.js';
import { scanDependencies } from '../lib/formEngine/placeholders.js';
import { buildLaunchPayload, filterRawFormData, maskPasswords } from '../lib/formEngine/output.js';
import { sha256 } from '../lib/formEngine/node/hash.js';
import { createFormServices } from '../lib/formServices.js';
import { describeRowErrors, resolveWizard } from '../lib/launchValidation.js';
import { cronError } from '../lib/cronValidate.js';
import yaml from 'yaml';
import { ownerOf as storedJobOwner, seesShared } from '../lib/storedJobScope.js';

/**
 * The MCP tools. Deliberately technical : they expose the form flow a browser goes through
 * - list, open, fill in, launch, follow - as the authenticated AnsibleForms user, and add no
 * policy of their own. Confirmation, approval UX and which forms an agent may use belong to
 * the MCP client (the chat backend). What stays here is what AnsibleForms already enforces
 * for the browser : RBAC on forms and jobs, expressions and queries only as the form
 * defines them, reserved extravars stripped, credentials never returned.
 *
 * `createHandlers` takes its models as `deps`, so the tests can drive every tool without a
 * database ; mcp/router.js passes the real ones.
 */

/**
 * A refusal the caller can act on. `code` and `details` are returned as structured content
 * next to the text, so a client does not have to parse the message.
 */
export class ToolError extends Error {
  constructor(message, code = 'invalid_request', details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// model errors, by name, and the code a caller gets for them
const KNOWN_ERRORS = {
  AccessDeniedError: 'access_denied',
  ForbiddenError: 'access_denied',
  NotFoundError: 'not_found',
  ConflictError: 'conflict',
  BadRequestError: 'invalid_request',
  ValidationError: 'form_incomplete',
};

function lastLines(text, n) {
  if (!n || n <= 0) return text;
  const lines = String(text || '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function parseJson(s, fallback) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s || '');
  } catch {
    return fallback;
  }
}

// the internal keys resolveForm hands back for the launch - never sent to a caller, they
// hold the raw values including passwords
/** whether a form is a wizard : its fields live in its steps */
function isWizard(formObj) {
  return Array.isArray(formObj?.wizard) && formObj.wizard.length > 0;
}

/** a wizard's steps (the summary left out), named as the browser and the drafts name them */
function wizardSteps(formObj) {
  return (formObj.wizard || []).filter((s) => s && !s.summary && s.subform)
    .map((s) => ({ name: s.name || s.subform, subform: s.subform, optional: s.optional === true, when: s.when || '' }));
}

function publicResolution(res) {
  const { _values, _visibility, _fields, ...rest } = res; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * @param {object} args
 * @param {object} args.user  req.user.user
 * @param {object} args.deps  { Form, Job, Expression, Query, resolveFormQuery } ; for the
 *   schedules also { Schedule, cron (the cron service : add and remove a schedule's task),
 *   appTimezone (async : the app's display zone, Settings > Appearance) } ; for the stored jobs
 *   { StoredJobs : findAll, findById, create, delete on the stored_jobs table }
 * @param {object} [args.policy]  the MCP settings, from the MCP router only (the chat
 *   assistant has its own rules) : `readOnly` refuses launch_job and relaunch_job,
 *   `chatFormsOnly` offers only the forms offered in the chat (enableForChat)
 */
export function createHandlers({ user, deps, policy = {} }) {
  const { Form, Job, Expression, Query, resolveFormQuery, Schedule, cron, appTimezone, StoredJobs } = deps;
  const roles = user?.roles || [];

  // a form MCP may offer : any the user may open, or with chatFormsOnly those offered in the
  // chat as well - a form left out is not found, as one the user may not open
  const offered = (f) => !policy.chatFormsOnly || f?.enableForChat === true;

  async function loadForm(name) {
    const formConfig = await Form.load(roles, name);
    const formObj = formConfig?.forms?.[0];
    if (!formObj || !offered(formObj)) throw new ToolError(`Form '${name}' not found or you do not have access to it`, 'not_found');
    return { formConfig, formObj };
  }

  function refuseWhenReadOnly(what = 'jobs cannot be launched or relaunched through it') {
    if (policy.readOnly) {
      throw new ToolError(`This MCP server is read only: ${what}`, 'access_denied');
    }
  }

  // ─── schedules (#1069) : the role options decide, as on the schedule routes ────────────────
  // allowScheduledJobs : every schedule (an admin-level right) ; allowPlannedJobs : one-time runs
  // of a form, as the user, and those only
  const mayPlan = !!user?.options?.allowPlannedJobs;
  const mayManage = !!user?.options?.allowScheduledJobs;

  /** The user a planned run runs as, from its owner ; null for an admin-level schedule. */
  function ownerOf(row) {
    if (!row?.owner) return null;
    try {
      const owner = typeof row.owner === 'string' ? JSON.parse(row.owner) : row.owner;
      return owner?.username ? { username: owner.username, type: owner.type || 'local' } : null;
    } catch {
      return null;
    }
  }

  /** Whether a schedule is this user's : a run they planned. */
  function isMine(row) {
    const owner = ownerOf(row);
    return !!owner && owner.username === user?.username && owner.type === (user?.type || 'local');
  }

  /** The names of the forms MCP offers this user, when only the chat's are offered. */
  async function offeredFormNames() {
    if (!policy.chatFormsOnly) return null;
    const cfg = await Form.load(roles);
    return new Set((cfg?.forms || []).filter(offered).map((f) => f.name));
  }

  /** A schedule this user may see, else not found (as one that does not exist). */
  async function visibleSchedule(id) {
    if (!mayManage && !mayPlan) throw new ToolError('You do not have permission to see schedules', 'access_denied');
    const notFound = new ToolError(`Schedule ${id} not found or you do not have access to it`, 'not_found');
    let row;
    try {
      row = await Schedule.findById(id);
    } catch (err) {
      if (err?.name === 'NotFoundError') throw notFound;
      throw err;
    }
    if (!row || (!mayManage && !isMine(row))) throw notFound;
    const names = await offeredFormNames();
    if (names && !names.has(row.form)) throw notFound;
    return row;
  }

  /**
   * When a schedule runs next : as the list has it, else as the model works it out for one row
   * (the scheduler's zone for a cron, none for a one-time run already past).
   */
  function nextRunOf(row) {
    if (row && 'next_run' in row) return row.next_run ?? null;
    return Schedule.withNextRun ? Schedule.withNextRun(row).next_run ?? null : null;
  }

  /** A schedule as the list shows it : what, when and how it went ; not its values. */
  function scheduleSummary(row) {
    const owner = ownerOf(row);
    return {
      id: row.id,
      name: row.name,
      form: row.form,
      // a run planned by a user runs as them ; any other schedule as the Schedule Service
      planned: !!owner,
      runsAs: owner ? owner.username : 'Schedule Service',
      oneTimeRun: !!row.one_time_run,
      runAt: row.run_at ?? null,
      cron: row.cron || null,
      nextRun: nextRunOf(row),
      status: row.status || null,
      state: row.state || null,
      lastRun: row.last_run ?? null,
    };
  }

  /**
   * A moment as a planned run takes it : an ISO 8601 time with its offset or Z, so the run never
   * depends on the zone of a server or a browser (#1064) ; not in the past.
   */
  function momentOf(runAt, what = 'run_at') {
    const text = String(runAt ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      throw new ToolError(`${what} must be an ISO 8601 time with its offset or Z, such as 2026-10-15T22:00:00+02:00 or `
        + `2026-10-15T20:00:00Z, not '${text}': a time without a zone is ambiguous`, 'invalid_request');
    }
    const when = new Date(text);
    // a date that does not exist (30 February, 24:00) is moved by the parser without a word :
    // refused instead, the run would happen on another day than the one asked
    const [, y, mo, d, h, mi] = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/).map(Number);
    const day = new Date(Date.UTC(y, mo - 1, d));
    if (Number.isNaN(when.getTime()) || h > 23 || mi > 59
      || day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
      throw new ToolError(`${what} '${text}' is not a valid time`, 'invalid_request');
    }
    if (when.getTime() < Date.now() - 60 * 1000) {
      throw new ToolError(`${what} '${text}' is in the past`, 'invalid_request', { now: new Date().toISOString() });
    }
    return when;
  }

  /** A moment in UTC and on the app's clock (Settings > Appearance > Defaults, else UTC). */
  async function bothClocks(when) {
    let zone;
    try {
      zone = (await appTimezone?.()) || 'UTC';
    } catch {
      zone = 'UTC';
    }
    let local;
    try {
      local = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'medium' }).format(when);
    } catch {
      zone = 'UTC';
      local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'medium' }).format(when);
    }
    return { runAt: when.toISOString(), runAtLocal: `${local} ${zone}`, timezone: zone };
  }

  /** A schedule stored ; a name already taken (names are unique, for every user) said so. */
  async function stored(name, store) {
    try {
      return await store();
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(err?.message || '')) {
        throw new ToolError(`A schedule named '${name}' already exists ; choose another name`, 'conflict', { name });
      }
      throw err;
    }
  }

  // ─── stored jobs (#1070) : as the stored jobs routes scope them ───────────────────────────────
  // allowStoredJobs : the user's own, and the ones shared with them (#1269, lib/storedJobScope.js) ;
  // a settings user (showSettings) everyone's
  const mayStore = !!user?.options?.allowStoredJobs;
  const seesAllStored = !!user?.options?.showSettings;
  // the owner of a stored job, as the routes write it
  const me = storedJobOwner(user);

  /** Whether another user's stored job is shared with this user : its form as they may open it. */
  async function sharedWithMe(row) {
    if (row.visibility !== 'shared') return false;
    return seesShared(user, row, (await Form.load(roles, row.form_name))?.forms?.[0]);
  }

  /**
   * A stored job this user may see : by its id, or by its form and name among their own ; else
   * not found, as one that does not exist.
   */
  async function visibleStored({ id, form, name }) {
    if (!mayStore) throw new ToolError('You do not have permission to use stored jobs (the allowStoredJobs role option)', 'access_denied');
    const notFound = new ToolError(`Stored job ${id ?? `'${name}' of form '${form}'`} not found or you do not have access to it`, 'not_found');
    let row;
    if (id) {
      try {
        row = await StoredJobs.findById(id);
      } catch (err) {
        if (err?.name === 'NotFoundError') throw notFound;
        throw err;
      }
    } else if (form && name) {
      row = ((await StoredJobs.findAll()) || []).find((r) => r.form_name === form && r.name === name && r.username === me);
    } else {
      throw new ToolError('Name a stored job by its id, or by its form and name', 'invalid_request');
    }
    if (!row || (!seesAllStored && row.username !== me && !(await sharedWithMe(row)))) throw notFound;
    const names = await offeredFormNames();
    if (names && !names.has(row.form_name)) throw notFound;
    return row;
  }

  /** A stored job as the list shows it : what and when, not its values. */
  function storedSummary(row) {
    const expires = row.expires_at ? new Date(row.expires_at) : null;
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      form: row.form_name,
      ...(seesAllStored || row.username !== me ? { owner: row.username } : {}),
      shared: row.visibility === 'shared',
      createdAt: row.created_at ?? null,
      expiresAt: expires ? expires.toISOString() : null,
      expired: !!expires && expires.getTime() < Date.now(),
    };
  }

  /** The values a stored job holds (the form's raw values, no passwords). */
  function storedValues(row) {
    const data = parseJson(row.form_data, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ToolError(`The values of stored job ${row.id} cannot be read`, 'invalid_request');
    }
    return data;
  }

  /**
   * The values to resolve or launch with : a stored job's (Load on the form), with the values
   * given laid over them. A stored value for a field the form no longer has is left out and said.
   *
   * A wizard's stored job holds its step drafts (`{ __wizard__: true, drafts, skipped }`) : the
   * given values are laid over each step's draft, a step given values for is no longer skipped,
   * and `skipped` given as true or false overrides the stored skips.
   *
   * Returns:
   *   Promise<object>: { values, skipped, warnings } - `skipped` for a wizard only.
   */
  async function overStored(form, values, storedJob, skipped, loaded) {
    if (!storedJob) return { values: values || {}, skipped, warnings: [] };
    const row = await visibleStored({ id: storedJob.id, form, name: storedJob.name });
    // a start from your own, or one shared with you : a settings user reads and deletes
    // everyone's, but launches nobody else's private values
    if (row.username !== me && !(await sharedWithMe(row))) {
      throw new ToolError(`Stored job ${row.id} is ${row.username}'s ; you can only start from your own or a shared one`, 'access_denied');
    }
    if (row.form_name !== form) {
      throw new ToolError(`Stored job ${row.id} holds values of form '${row.form_name}', not of '${form}'`, 'invalid_request');
    }
    const data = storedValues(row);
    const { formObj } = loaded || await loadForm(form);
    const warnings = [];
    if (storedSummary(row).expired) warnings.push(`Stored job '${row.name}' has expired`);
    if (isWizard(formObj)) {
      const over = wizardOverStored(formObj, row, data, values, skipped);
      if (over.stale.length) warnings.push(`Stored job '${row.name}' has values for steps or fields the form no longer has, left out: ${over.stale.join(', ')}`);
      return { values: over.drafts, skipped: over.skipped, warnings };
    }
    if (data.__wizard__ === true) {
      throw new ToolError(`Stored job ${row.id} holds the step drafts of a wizard, and '${form}' is no longer one ; store it again from the form`, 'invalid_request');
    }
    const known = new Set(normalizeFields(formObj.fields).map((f) => f.name));
    const stale = Object.keys(data).filter((k) => !known.has(k));
    const kept = Object.fromEntries(Object.entries(data).filter(([k]) => known.has(k)));
    if (stale.length) warnings.push(`Stored job '${row.name}' has values for fields the form no longer has, left out: ${stale.join(', ')}`);
    return { values: { ...kept, ...(values || {}) }, warnings };
  }

  /**
   * A wizard's stored drafts with the given values over them, per step (overStored).
   *
   * Returns:
   *   object: { drafts, skipped, stale } - `stale` the stored steps and fields (`<step>.<field>`)
   *   the form no longer has.
   */
  function wizardOverStored(formObj, row, data, values, skipped) {
    const plain = (o) => o && typeof o === 'object' && !Array.isArray(o);
    if (data.__wizard__ !== true || !plain(data.drafts)) {
      throw new ToolError(`Stored job ${row.id} holds no step drafts of wizard '${formObj.name}' ; store it again from the form`, 'invalid_request');
    }
    const given = wizardInput(formObj, values, skipped);
    const steps = wizardSteps(formObj);
    const subforms = formObj.subforms || [];
    const drafts = {};
    const stale = [];
    for (const [name, draft] of Object.entries(data.drafts)) {
      const step = steps.find((s) => s.name === name);
      const sub = step && subforms.find((s) => s?.name === step.subform);
      if (!sub || !plain(draft)) {
        stale.push(name);
        continue;
      }
      const known = new Set(normalizeFields(sub.fields || []).map((f) => f.name));
      for (const k of Object.keys(draft)) if (!known.has(k)) stale.push(`${name}.${k}`);
      drafts[name] = Object.fromEntries(Object.entries(draft).filter(([k]) => known.has(k)));
    }
    for (const [name, v] of Object.entries(given.drafts)) drafts[name] = { ...(drafts[name] || {}), ...v };
    // the stored skips, except for a step given values for ; then the given skips over them
    const skips = {};
    for (const step of steps) {
      if (step.optional && data.skipped?.[step.name] === true && !given.drafts[step.name]) skips[step.name] = true;
    }
    for (const [name, v] of Object.entries(plain(skipped) ? skipped : {})) {
      if (v === true) skips[name] = true;
      else if (v === false) delete skips[name];
    }
    return { drafts, skipped: skips, stale };
  }

  /** The cron service runs it from now on (the schedule routes do the same). */
  async function registered(id) {
    const row = await Schedule.findById(id);
    cron?.addSchedule?.(row.id, row.name, row.cron, row.one_time_run, row.run_at);
    return row;
  }

  function servicesFor(formConfig, formObj, subformName) {
    return createFormServices({ user, formConfig, formObj, subformName, deps: { Expression, Query, resolveFormQuery } });
  }

  async function resolveFor({ form, values, field, subform, parent, maxOptions }, loaded) {
    const { formConfig, formObj } = loaded || await loadForm(form);
    let target = formObj;
    let parentData;
    // a wizard keeps its fields in its steps : resolving the empty root would report a
    // "complete" form that is nothing of the sort
    if (!subform && isWizard(formObj)) {
      throw new ToolError(`'${formObj.name}' is a wizard form ; its fields live in its steps`, 'invalid_request');
    }
    if (subform) {
      target = (formObj.subforms || []).find((s) => s?.name === subform);
      if (!target) throw new ToolError(`Subform '${subform}' is not part of form '${formObj.name}'`, 'not_found');
      // a subform sees its parent form's values (and through them the constants and
      // varsFiles data) as __parent__, as a list row or wizard step does in the browser
      parentData = { ...(formConfig.constants || {}), ...(formObj.vars || {}), ...(parent || {}) };
    }
    const res = await resolveForm({
      form: target,
      constants: formConfig.constants || {},
      vars: target.vars || {},
      user,
      parent: parentData,
      values: values || {},
      only: field,
      maxOptions,
      services: servicesFor(formConfig, formObj, subform),
      subforms: formObj.subforms || [],
      // an agent's rows never went through the browser's row editor : resolve them all
      allRows: true,
    });
    return { res, formConfig, formObj };
  }

  /**
   * What launch_job submits for a complete resolution, and its hash. The hash covers the
   * form name, the modelled extravars and the credential names, computed over the REAL
   * values (passwords included) ; the preview a caller sees has the passwords masked.
   * Job.launch adds ansibleforms_user and __jobid__ afterwards, and `verbose` adds
   * __verbose__ - none of those are part of the hash.
   */
  function launchPayload(res, formObj) {
    const { extravars, credentials } = buildLaunchPayload(res, formObj.subforms || []);
    return {
      extravars,
      credentials,
      preview: maskPasswords(extravars, res._fields, formObj.subforms || []),
      payloadHash: sha256({ form: formObj.name, extravars, credentials }),
    };
  }

  /**
   * A wizard's values as its step drafts : `{ <step>: { field: value } }`, and the optional
   * steps skipped as `{ <step>: true }` - the shape the browser sends and a wizard job stores.
   */
  function wizardInput(formObj, values, skipped) {
    const plain = (o) => o && typeof o === 'object' && !Array.isArray(o);
    const names = wizardSteps(formObj).map((s) => s.name);
    if (values != null && !plain(values)) throw new ToolError('The values of a wizard form are an object of its steps', 'invalid_request');
    const unknown = Object.keys(values || {}).filter((k) => !names.includes(k));
    if (unknown.length) {
      throw new ToolError(`'${formObj.name}' is a wizard form ; its values are given per step (${names.join(', ')}), not: ${unknown.join(', ')}`,
        'invalid_request', { steps: names });
    }
    const drafts = {};
    for (const [step, v] of Object.entries(values || {})) {
      if (!plain(v)) throw new ToolError(`The values of step '${step}' are an object of its fields`, 'invalid_request');
      drafts[step] = v;
    }
    // only an optional step can be skipped : a silent ignore would leave the agent guessing
    // why the step is still reported as missing
    const optional = wizardSteps(formObj).filter((s) => s.optional).map((s) => s.name);
    const skips = {};
    for (const [step, v] of Object.entries(plain(skipped) ? skipped : {})) {
      if (v !== true) continue;
      if (!optional.includes(step)) {
        throw new ToolError(`'${step}' is not an optional step of '${formObj.name}'${optional.length ? ` ; the optional steps are: ${optional.join(', ')}` : ''}`,
          'invalid_request', { steps: names, optional });
      }
      skips[step] = true;
    }
    return { drafts, skipped: skips };
  }

  /** A wizard resolved step by step, as the browser walks it (lib/launchValidation.js). */
  async function resolveWizardFor({ form, values, skipped }, loaded) {
    const { formConfig, formObj } = loaded || await loadForm(form);
    const input = wizardInput(formObj, values, skipped);
    const res = await resolveWizard({
      formConfig, formObj, user, drafts: input.drafts, skipped: input.skipped,
      services: servicesFor(formConfig, formObj),
      // an agent gives a step's passwords with its values ; a browser in the extravars
      passwordFrom: 'drafts',
      allRows: true,
    });
    return { res, formConfig, formObj, ...input };
  }

  /** launchPayload for a wizard : its payload is the steps' output merged. */
  function wizardPayload(res, formObj) {
    const { extravars, credentials } = res.payload;
    return {
      extravars,
      credentials,
      preview: maskPasswords(extravars, res.maskFields, formObj.subforms || []),
      payloadHash: sha256({ form: formObj.name, extravars, credentials }),
    };
  }

  /**
   * What a wizard job keeps of its drafts : each filtered by its step's subform (no passwords),
   * the skips of its optional steps only.
   */
  function wizardRawFormData(formObj, drafts, skipped) {
    const kept = {};
    const skips = {};
    for (const step of wizardSteps(formObj)) {
      const sub = (formObj.subforms || []).find((s) => s?.name === step.subform);
      const draft = drafts?.[step.name];
      if (sub && draft && typeof draft === 'object' && !Array.isArray(draft)) kept[step.name] = filterRawFormData(sub.fields || [], draft, formObj.subforms || []);
      if (step.optional && skipped?.[step.name] === true) skips[step.name] = true;
    }
    return { __wizard__: true, drafts: kept, skipped: skips };
  }

  /**
   * What store_job keeps of a form's values : the given fields as the form reads them, filtered
   * as the Store dialog filters them (no password, nothing the form does not have).
   *
   * Returns:
   *   Promise<object>: { kept, stored, passwords, unknown, other } - `kept` the form_data,
   *   `stored` the names kept, the rest the names left out and why.
   */
  async function plainToStore(loaded, values) {
    const { formObj } = loaded;
    const fields = normalizeFields(formObj.fields);
    const { res } = await resolveFor({ form: formObj.name, values: values || {} }, loaded);
    const given = Object.fromEntries(Object.keys(values || {}).filter((k) => k in res._values).map((k) => [k, res._values[k]]));
    const kept = filterRawFormData(res._fields || fields, given, formObj.subforms || []);
    const types = Object.fromEntries(fields.map((f) => [f.name, f.type]));
    const leftOut = Object.keys(values || {}).filter((k) => !(k in kept));
    const passwords = leftOut.filter((k) => types[k] === 'password');
    const unknown = leftOut.filter((k) => !(k in types));
    const other = leftOut.filter((k) => !passwords.includes(k) && !unknown.includes(k));
    return { kept, stored: Object.keys(kept), passwords, unknown, other };
  }

  /**
   * plainToStore for a wizard : its step drafts (`{ __wizard__: true, drafts, skipped }`, as the
   * browser stores a wizard), each step's given fields as the step reads them when it is shown,
   * as given when it is not. The names are `<step>.<field>`.
   */
  async function wizardToStore(loaded, values, skipped) {
    const { formObj } = loaded;
    const subforms = formObj.subforms || [];
    const { res, drafts, skipped: skips } = await resolveWizardFor({ form: formObj.name, values, skipped }, loaded);
    const kept = {};
    const passwords = [];
    const unknown = [];
    const other = [];
    for (const step of wizardSteps(formObj)) {
      const given = drafts[step.name];
      const sub = subforms.find((s) => s?.name === step.subform);
      if (!given || !sub) continue;
      const fields = normalizeFields(sub.fields || []);
      const types = Object.fromEntries(fields.map((f) => [f.name, f.type]));
      const resolved = res.values[step.name];
      const source = resolved ? Object.fromEntries(Object.keys(given).filter((k) => k in resolved).map((k) => [k, resolved[k]])) : given;
      const stepKept = filterRawFormData(fields, source, subforms);
      if (Object.keys(stepKept).length) kept[step.name] = stepKept;
      for (const k of Object.keys(given)) {
        if (k in stepKept) continue;
        const at = `${step.name}.${k}`;
        if (types[k] === 'password') passwords.push(at);
        else if (!(k in types)) unknown.push(at);
        else other.push(at);
      }
    }
    return {
      kept: { __wizard__: true, drafts: kept, skipped: skips },
      stored: Object.entries(kept).flatMap(([step, v]) => Object.keys(v).map((k) => `${step}.${k}`)),
      passwords, unknown, other,
    };
  }

  /**
   * resolve_field for a wizard : every step resolved in order, the fields and errors named
   * `<step>.<field>`, and the launch payload once every shown step is complete.
   */
  async function resolveWizardField({ form, values: given, skipped: givenSkips, field, storedJob }, loaded) {
    const { values, skipped, warnings } = await overStored(form, given, storedJob, givenSkips, loaded);
    const { res, formObj } = await resolveWizardFor({ form, values, skipped }, loaded);
    // the resolved values hold the passwords : never sent
    const { payload, values: _values, maskFields, passwordsVisible, ...rest } = res; // eslint-disable-line no-unused-vars
    const out = { form: formObj.name, ...rest, fields: field ? rest.fields.filter((f) => f.name === field) : rest.fields };
    if (warnings.length) out.warnings = [...(out.warnings || []), ...warnings];
    out.formFingerprint = sha256(formObj);
    if (res.complete && !field) {
      const built = wizardPayload(res, formObj);
      out.modeledExtravars = built.preview;
      out.modeledPayload = built.preview;
      out.credentials = built.credentials;
      out.payloadHash = built.payloadHash;
    }
    return out;
  }

  /** form_incomplete, with what is missing and failing */
  function incomplete(res) {
    const parts = [];
    const notAnOption = res.fields.filter((f) => f.notInOptions && res.invalid.includes(f.name)).map((f) => f.name);
    const failing = Object.entries(res.validationErrors)
      .map(([name, errs]) => `${name} (${errs.map((e) => e.description ? `${e.type}: ${e.description}` : e.type).join(', ')})`);
    if (res.missing.length) parts.push(`missing input for: ${res.missing.join(', ')}`);
    if (notAnOption.length) parts.push(`not one of the options: ${notAnOption.join(', ')}`);
    if (failing.length) parts.push(`validation failed: ${failing.join(' ; ')}`);
    const rows = describeRowErrors(res.rowErrors);
    if (rows.length) parts.push(`list rows failing: ${rows.join(', ')}`);
    if (res.waiting.length) parts.push(`not resolvable yet: ${res.waiting.join(', ')}`);
    return new ToolError(`The form is not complete - ${parts.join(' ; ')}. Call resolve_field to see what is needed.`,
      'form_incomplete', {
        missing: res.missing, invalid: res.invalid, waiting: res.waiting, validationErrors: res.validationErrors,
        rowErrors: res.rowErrors,
      });
  }

  /**
   * A form resolved, validated and turned into its launch payload, as launch_job submits it and
   * plan_job plans it : refused while incomplete, with a file field, or when the payload differs
   * from the confirmed one.
   *
   * Returns:
   *   Promise<object>: { formObj, extravars, credentials, payloadHash, rawFormData, warnings }.
   */
  async function readyToLaunch({ form, values: given, skipped: givenSkips, storedJob, verbose, expectedPayloadHash }) {
    const loaded = await loadForm(form);
    const { formConfig, formObj } = loaded;
    const { values, skipped, warnings: storedWarnings } = await overStored(form, given, storedJob, givenSkips, loaded);
    // a stored job can change between what was shown and the launch : the confirmed payload is
    // the one launched, or none
    if (storedJob && !expectedPayloadHash) {
      throw new ToolError('Launching or planning from a stored job needs the expectedPayloadHash resolve_field returned for it, '
        + 'so what runs is what was confirmed', 'invalid_request');
    }
    if (formObj.type === 'subform') {
      throw new ToolError(`'${formObj.name}' is a subform and cannot be launched on its own`, 'unsupported');
    }
    if (verbose && !user?.options?.allowVerboseMode) {
      throw new ToolError('You do not have permission to run jobs in verbose mode', 'access_denied');
    }
    if (isWizard(formObj)) return readyWizard({ loaded, values, skipped, storedWarnings, verbose, expectedPayloadHash });
    const res = await resolveForm({
      form: formObj,
      constants: formConfig.constants || {},
      vars: formObj.vars || {},
      user,
      values: values || {},
      services: servicesFor(formConfig, formObj),
      allRows: true,
    });
    if (!res.complete) throw incomplete(res);
    const files = res._fields.filter((f) => f.type === 'file' && res._visibility[f.name]
      && res._values[f.name] !== undefined && res._values[f.name] !== null && res._values[f.name] !== '');
    if (files.length) {
      throw new ToolError(`File fields cannot be filled through MCP (${files.map((f) => f.name).join(', ')})`,
        'unsupported', { fields: files.map((f) => f.name) });
    }
    const { extravars, credentials, payloadHash } = launchPayload(res, formObj);
    // the resolution changed since it was approved : a query answered differently, the
    // form was edited, or other values were sent
    if (expectedPayloadHash && expectedPayloadHash !== payloadHash) {
      throw new ToolError('The payload differs from the one that was resolved - resolve the form again and have it confirmed.',
        'payload_mismatch', { expectedPayloadHash, payloadHash });
    }
    if (verbose) extravars.__verbose__ = true;
    return { formObj, extravars, credentials, payloadHash, rawFormData: filterRawFormData(res._fields, res._values), warnings: [...(res.warnings || []), ...storedWarnings] };
  }

  /** readyToLaunch for a wizard : its steps resolved in order, their output merged. */
  async function readyWizard({ loaded, values, skipped, storedWarnings, verbose, expectedPayloadHash }) {
    const { formObj } = loaded;
    const { res, drafts, skipped: skips } = await resolveWizardFor({ form: formObj.name, values, skipped }, loaded);
    if (!res.complete) throw incomplete(res);
    // a file field is never in a wizard's drafts : resolveWizard drops it
    const { extravars, credentials, payloadHash } = wizardPayload(res, formObj);
    if (expectedPayloadHash && expectedPayloadHash !== payloadHash) {
      throw new ToolError('The payload differs from the one that was resolved - resolve the form again and have it confirmed.',
        'payload_mismatch', { expectedPayloadHash, payloadHash });
    }
    if (verbose) extravars.__verbose__ = true;
    return { formObj, extravars, credentials, payloadHash, rawFormData: wizardRawFormData(formObj, drafts, skips), warnings: [...(res.warnings || []), ...storedWarnings] };
  }

  return {
    async listForms() {
      const cfg = await Form.load(roles);
      return {
        forms: (cfg?.forms || []).filter(offered).map((f) => ({
          name: f.name,
          description: f.description || '',
          categories: f.categories || [],
          // the chat assistant's allowlist and its button (Approve for change, Launch for read)
          enableForChat: f.enableForChat === true,
        })),
      };
    },

    async getForm({ name }) {
      const { formConfig, formObj } = await loadForm(name);
      const fields = normalizeFields(formObj.fields);
      const known = [...Object.keys(formConfig.constants || {}), ...Object.keys(formObj.vars || {}), '__user__'];
      const graph = scanDependencies(fields, known);
      // a wizard's fields are its steps' : each step's subform fields, as the step shows them
      const steps = isWizard(formObj) ? wizardSteps(formObj).map((step) => {
        const sub = (formObj.subforms || []).find((s) => s?.name === step.subform);
        const stepFields = normalizeFields(sub?.fields || []);
        const stepGraph = scanDependencies(stepFields, [...known, '__parent__']);
        return {
          name: step.name, subform: step.subform, optional: step.optional, ...(step.when ? { when: step.when } : {}),
          fields: stepFields.map((f) => ({ ...f, dynamic: isDynamicField(f), dependsOn: stepGraph.dependsOn[f.name] || [] })),
        };
      }) : undefined;
      return {
        ...formObj,
        fields: fields.map((f) => ({ ...f, dynamic: isDynamicField(f), dependsOn: graph.dependsOn[f.name] || [] })),
        ...(steps ? { steps } : {}),
        constants: formConfig.constants || {},
        supported: true,
        errors: formConfig.errors || [],
        warnings: [...(formConfig.warnings || []), ...graph.warnings],
      };
    },

    async resolveField(args) {
      // a stored job's values, for the whole form (not a subform's row)
      if (args.subform && args.storedJob) {
        throw new ToolError('A stored job holds the values of a whole form: resolve it without `subform`', 'invalid_request');
      }
      const loaded = await loadForm(args.form);
      if (!args.subform && isWizard(loaded.formObj)) return resolveWizardField(args, loaded);
      const fromStored = await overStored(args.form, args.values, args.storedJob);
      const { res, formObj } = await resolveFor({ ...args, values: fromStored.values }, loaded);
      const out = publicResolution(res);
      if (fromStored.warnings.length) out.warnings = [...(out.warnings || []), ...fromStored.warnings];
      // the exact launch payload, only where it is one : a whole root form, resolved
      out.formFingerprint = sha256(formObj);
      if (res.complete && !args.subform && !args.field) {
        const payload = launchPayload(res, formObj);
        out.modeledExtravars = payload.preview;
        // the same, the word a Rundeck job uses
        out.modeledPayload = payload.preview;
        out.credentials = payload.credentials;
        out.payloadHash = payload.payloadHash;
      }
      return out;
    },

    async launchJob({ form, values, skipped, storedJob, verbose, expectedPayloadHash }) {
      refuseWhenReadOnly();
      const ready = await readyToLaunch({ form, values, skipped, storedJob, verbose, expectedPayloadHash });
      const job = await Job.launch({
        form: ready.formObj.name,
        user,
        credentials: ready.credentials,
        extravars: ready.extravars,
        rawFormData: ready.rawFormData,
        fromClient: true,
        // resolved and validated above ; the REST launch guard need not do it again
        validated: true,
      });
      return { id: job?.id, form: ready.formObj.name, payloadHash: ready.payloadHash, warnings: ready.warnings };
    },

    async planJob({ form, values, skipped, storedJob, run_at: runAt, name, verbose, expectedPayloadHash }) {
      refuseWhenReadOnly('jobs cannot be planned through it');
      if (!mayPlan) throw new ToolError('You do not have permission to plan jobs (the allowPlannedJobs role option)', 'access_denied');
      const when = momentOf(runAt);
      if (!String(name ?? '').trim()) throw new ToolError('A planned job needs a name', 'invalid_request');
      const ready = await readyToLaunch({ form, values, skipped, storedJob, verbose, expectedPayloadHash });
      // Run later on the form : a one-time run as this user, checked again when it fires
      const id = await stored(String(name).trim(), () => Schedule.plan(user, {
        name: String(name).trim(),
        form: ready.formObj.name,
        one_time_run: true,
        run_at: when.toISOString(),
        extra_vars: yaml.stringify(ready.extravars),
        raw_form_data: ready.rawFormData,
      }));
      const row = await registered(id);
      return { id: row.id, name: row.name, form: ready.formObj.name, ...(await bothClocks(when)), payloadHash: ready.payloadHash, warnings: ready.warnings };
    },

    async createSchedule({ form, name, cron: cronGiven, run_at: runAt, extraVars }) {
      refuseWhenReadOnly('schedules cannot be created through it');
      // a blank cron is none : it would store a schedule that never runs
      const cronExpr = String(cronGiven ?? '').trim();
      if (!mayManage) throw new ToolError('You do not have permission to create schedules (the allowScheduledJobs role option)', 'access_denied');
      if (!String(name ?? '').trim()) throw new ToolError('A schedule needs a name', 'invalid_request');
      if (!!cronExpr === !!runAt) throw new ToolError('Give one of cron (a recurring schedule) or run_at (one run), not both and not neither', 'invalid_request');
      const { formObj } = await loadForm(form);
      if (formObj.type === 'subform') throw new ToolError(`'${formObj.name}' is a subform and cannot be scheduled on its own`, 'unsupported');
      const data = { name: String(name).trim(), form: formObj.name, extra_vars: yaml.stringify(extraVars || {}) };
      let when = null;
      if (cronExpr) {
        const problem = cronError(cronExpr);
        if (problem) throw new ToolError(`Not a cron schedule: ${problem}`, 'invalid_request');
        Object.assign(data, { cron: cronExpr, one_time_run: false });
      } else {
        when = momentOf(runAt);
        Object.assign(data, { one_time_run: true, run_at: when.toISOString() });
      }
      const row = await registered(await stored(data.name, () => Schedule.create(data)));
      return { ...scheduleSummary(row), ...(when ? await bothClocks(when) : {}) };
    },

    async listSchedules({ form } = {}) {
      if (!mayManage && !mayPlan) throw new ToolError('You do not have permission to see schedules', 'access_denied');
      const names = await offeredFormNames();
      const rows = (await Schedule.findAll()) || [];
      const schedules = rows
        .filter((r) => mayManage || isMine(r))
        .filter((r) => !names || names.has(r.form))
        .filter((r) => !form || r.form === form)
        .map(scheduleSummary);
      return { schedules, scope: mayManage ? 'all' : 'mine' };
    },

    async getSchedule({ id }) {
      const row = await visibleSchedule(id);
      // its extra vars as a job's are shown : secret-looking keys and the form's password fields masked
      let stored;
      try {
        stored = yaml.parse(row.extra_vars || '{}') || {};
      } catch {
        stored = {};
      }
      const extravars = parseJson(await Job.maskExtravars(row.form, JSON.stringify(stored)), {});
      return { ...scheduleSummary(row), extravars, output: row.output || '' };
    },

    async deleteSchedule({ id }) {
      refuseWhenReadOnly('schedules cannot be deleted through it');
      const row = await visibleSchedule(id);
      await Schedule.delete(row.id);
      cron?.removeSchedule?.(row.id);
      return { id: row.id, name: row.name, deleted: true };
    },

    async listStoredJobs({ form } = {}) {
      if (!mayStore) throw new ToolError('You do not have permission to use stored jobs (the allowStoredJobs role option)', 'access_denied');
      const names = await offeredFormNames();
      const rows = (await StoredJobs.findAll()) || [];
      // what can be started from : a stored job of a form this user may launch (one stored from a
      // subform's tab holds a subform's values)
      const forms = (await Form.load(roles))?.forms || [];
      const launchable = new Set(forms.filter((f) => offered(f) && f.type !== 'subform').map((f) => f.name));
      // another user's shared one : of a form this user may open (storedJobScope.seesShared)
      const formsByName = new Map(forms.map((f) => [f.name, f]));
      const shared = (r) => r.username !== me && seesShared(user, r, formsByName.get(r.form_name));
      const storedJobs = rows
        .filter((r) => seesAllStored || r.username === me || shared(r))
        .filter((r) => !names || names.has(r.form_name))
        .filter((r) => !form || r.form_name === form)
        .map((r) => ({ ...storedSummary(r), usable: launchable.has(r.form_name) && (r.username === me || shared(r)) }));
      return { storedJobs, scope: seesAllStored ? 'all' : 'mine' };
    },

    async getStoredJob({ id, form, name }) {
      const row = await visibleStored({ id, form, name });
      // the form's password fields left out, in list rows too (the browser kept those in its rows),
      // then secret-looking values masked as a job's are. A row of a form that cannot be loaded
      // (one stored from a subform) keeps no list or object value : it could hold any secret.
      let values = storedValues(row);
      try {
        const { formObj } = await loadForm(row.form_name);
        // a wizard's are its step drafts, each filtered by its step's subform
        values = isWizard(formObj)
          ? (values.__wizard__ === true ? wizardRawFormData(formObj, values.drafts, values.skipped) : {})
          : filterRawFormData(normalizeFields(formObj.fields), values, formObj.subforms || []);
      } catch {
        values = Object.fromEntries(Object.entries(values).filter(([, v]) => v === null || typeof v !== 'object'));
      }
      return { ...storedSummary(row), values: parseJson(await Job.maskExtravars(row.form_name, JSON.stringify(values)), {}) };
    },

    async storeJob({ form, name, values, skipped, description, expires_at: expiresAt }) {
      refuseWhenReadOnly('jobs cannot be stored through it');
      if (!mayStore) throw new ToolError('You do not have permission to use stored jobs (the allowStoredJobs role option)', 'access_denied');
      if (!String(name ?? '').trim()) throw new ToolError('A stored job needs a name', 'invalid_request');
      const loaded = await loadForm(form);
      const { formObj } = loaded;
      // the values as the form reads them (a choice as its whole option record, so Load in the
      // browser finds it) ; then kept as the Store dialog keeps them : no password (in a list row
      // neither), nothing the form does not have, only what was given
      const { kept, stored: storedNames, passwords, unknown, other } = isWizard(formObj)
        ? await wizardToStore(loaded, values, skipped)
        : await plainToStore(loaded, values);
      const expires = expiresAt ? momentOf(expiresAt, 'expires_at') : null;
      const storedName = String(name).trim();
      let id;
      try {
        id = await StoredJobs.create({
          name: storedName,
          description: description ? String(description) : '',
          form_name: formObj.name,
          username: me,
          form_data: JSON.stringify(kept),
          expires_at: expires ? expires.toISOString() : null,
        });
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(err?.message || '')) {
          throw new ToolError(`You already have a stored job named '${storedName}' for form '${formObj.name}'`, 'conflict', { name: storedName });
        }
        throw err;
      }
      const warnings = [];
      if (passwords.length) warnings.push(`Password fields are never stored, supply them when you launch: ${passwords.join(', ')}`);
      if (unknown.length) warnings.push(`Not fields of the form, left out: ${unknown.join(', ')}`);
      if (other.length) warnings.push(`Not stored (constants and reserved fields): ${other.join(', ')}`);
      return {
        id, name: storedName, form: formObj.name, expiresAt: expires ? expires.toISOString() : null,
        stored: storedNames, leftOut: { passwords, unknown, other }, warnings,
      };
    },

    async deleteStoredJob({ id }) {
      refuseWhenReadOnly('stored jobs cannot be deleted through it');
      const row = await visibleStored({ id });
      // one shared with this user is seen, not theirs to delete
      if (!seesAllStored && row.username !== me) {
        throw new ToolError(`Stored job ${row.id} is ${row.username}'s ; you can only delete your own`, 'access_denied');
      }
      await StoredJobs.delete(row.id);
      return { id: row.id, name: row.name, deleted: true };
    },

    async relaunchJob({ id, values, verbose, preview, expectedPayloadHash }) {
      if (!preview) refuseWhenReadOnly();
      // the job's form must be one MCP offers
      if (policy.chatFormsOnly) {
        const job = await Job.findById(user, id, true, true);
        await loadForm(job.form);
      }
      if (verbose && !user?.options?.allowVerboseMode) {
        throw new ToolError('You do not have permission to run jobs in verbose mode', 'access_denied');
      }
      const out = await Job.relaunchWithValues({ user, id, values: values || {}, verbose: !!verbose, preview: !!preview, expectedPayloadHash });
      if (preview) {
        const { extravars, ...rest } = out;
        return { job: id, ...rest, modeledExtravars: extravars, modeledPayload: extravars };
      }
      return { id: out?.id, relaunchOf: id, payloadHash: out?.payloadHash, warnings: out?.warnings || [] };
    },

    async getJob({ id, tail }) {
      const job = await Job.findById(user, id, true, true);
      // a job of a form MCP does not offer is not found either
      if (policy.chatFormsOnly) await loadForm(job.form).catch(() => {
        throw new ToolError(`Job ${id} not found or you do not have access to it`, 'not_found');
      });
      return {
        id: job.id,
        form: job.form,
        status: job.status,
        step: job.step,
        start: job.start,
        end: job.end,
        user: job.user,
        job_type: job.job_type,
        parent_id: job.parent_id,
        subjobs: String(job.subjobs || '').split(',').filter((x) => x !== '').map((x) => parseInt(x, 10)),
        // masked by findById(logSafe) ; credentials are never part of the answer
        extravars: parseJson(job.extravars, {}),
        // the same, the word a Rundeck job uses
        payload: parseJson(job.extravars, {}),
        output: lastLines(job.output || '', tail),
      };
    },
  };
}

const valuesSchema = z.record(z.string(), z.any())
  .describe('Raw field values keyed by field name. A choice field takes the selected option record, a partial record or its valueColumn value (an array of those when multiple). '
    + 'For a wizard form (get_form lists its `steps`), the values per step: { <step>: { <field>: value } }.');

// the optional steps of a wizard skipped, as Skip does in the browser
const skippedSchema = z.record(z.string(), z.boolean()).optional()
  .describe('Wizard forms only: the optional steps to skip, { <step>: true }. A step not skipped must be complete.');

// a stored job to start from (#1070) : what Load does on the form
const storedJobSchema = z.object({
  id: z.number().int().positive().optional().describe('Stored job id, from list_stored_jobs'),
  name: z.string().optional().describe('Or its name: one of your own stored jobs of this form'),
}).optional().describe('Start from the values of one of your own stored jobs, or one shared with you ; `values` are laid over them (per step for a wizard, '
  + 'and a step given values for is no longer skipped). Password fields are not stored: supply them in `values`. '
  + 'launch_job and plan_job then need the expectedPayloadHash resolve_field returned.');

/**
 * Wrap a handler : the result as JSON text and as structured content, a refusal as a tool
 * error carrying `{ code, message, ...details }`, no stack traces.
 */
/**
 * A handler's refusal as `{ code, message, ...details }` - the MCP tool error, and what the
 * chat assistant hands its model. One mapping, so both speak the same codes.
 */
export function describeError(err) {
  if (err instanceof ToolError) {
    return { code: err.code, message: err.message, ...err.details };
  }
  if (typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) && KNOWN_ERRORS[err?.name]) {
    // a model error that names its own tool code (Job.relaunchWithValues)
    return { code: err.code, message: err.message, ...(err.details || {}) };
  }
  if (KNOWN_ERRORS[err?.name]) {
    return { code: KNOWN_ERRORS[err.name], message: err.message };
  }
  if (err?.statusCode) {
    return { code: err.statusCode === 403 ? 'access_denied' : err.statusCode === 404 ? 'not_found' : 'invalid_request', message: err.message };
  }
  return { code: 'internal_error', message: `Internal error: ${err?.message || err}` };
}

function wrap(fn) {
  return async (args) => {
    try {
      const result = await fn(args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      const error = describeError(err);
      return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: error };
    }
  };
}

/**
 * Register every tool on an McpServer, bound to one user's handlers. Read only (the MCP
 * settings), the tools that launch, plan or change are not offered at all - the handlers refuse
 * them too. The schedule tools are offered as the user's role options allow them.
 */
export function registerTools(server, handlers, policy = {}, user = {}) {
  const options = user?.options || {};
  server.registerTool('list_forms', {
    title: 'List forms',
    description: 'The forms the authenticated user may use, with their description and categories.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(() => handlers.listForms()));

  server.registerTool('get_form', {
    title: 'Get form',
    description: 'The full definition of one form: its fields (type, label, required, regex, default, '
      + 'dependencies, and per field `dynamic` and `dependsOn`), subforms, constants and varsFiles data. '
      + 'A wizard form has no fields of its own: `steps` lists its steps in order (name, optional, when) '
      + 'with their fields. Use it to understand the form ; use resolve_field to evaluate it.',
    inputSchema: { name: z.string().describe('Form name, as returned by list_forms') },
    annotations: { readOnlyHint: true },
  }, wrap((a) => handlers.getForm(a)));

  server.registerTool('resolve_field', {
    title: 'Resolve form fields',
    description: 'Evaluate a form for the values filled in so far, in dependency order: which fields are '
      + 'visible, their defaults, computed expression and query values, and the options of every choice '
      + 'field. Fields whose inputs are not there yet come back as `waiting` with `waitingFor`. '
      + '`missing` lists fields that need a value from you ; `invalid` lists choices that are not among the '
      + 'options and fields that fail a validation rule of the form (regex, minValue/maxValue, '
      + 'minLength/maxLength, sameAs, in/notIn, validIf/validIfNot, ...), each described in `validationErrors` '
      + 'with the message the browser shows ; `complete` is true when the form can be launched. A choice may be sent as the option '
      + 'record, a partial record or its valueColumn value - it is replaced by the full option. When '
      + 'complete, the answer holds `modeledExtravars` (passwords masked) and `credentials` exactly as '
      + 'launch_job will submit them, and a `payloadHash` to pass to launch_job. Pass `field` to resolve '
      + 'only that field and what it depends on. Call it again after every answer. A wizard form is resolved '
      + 'step by step as the browser walks it - a step reads the earlier ones as __parent__ - and its fields '
      + 'and errors are named `<step>.<field>` ; `steps` says per step whether it is shown, skipped and complete.',
    inputSchema: {
      form: z.string().describe('Form name'),
      values: valuesSchema.optional(),
      skipped: skippedSchema,
      storedJob: storedJobSchema,
      field: z.string().optional().describe('Resolve only this field (and its dependencies)'),
      subform: z.string().optional().describe('Resolve a subform of the form (a list row or wizard step)'),
      parent: valuesSchema.optional().describe('Parent form values, available to a subform as __parent__'),
      maxOptions: z.number().int().positive().max(5000).optional().describe('Cap on options returned per field (default 200)'),
    },
    annotations: { readOnlyHint: true },
  }, wrap((a) => handlers.resolveField(a)));

  if (!policy.readOnly) server.registerTool('launch_job', {
    title: 'Launch job',
    description: 'Launch the form with the given values, exactly as a browser submission would: the form '
      + 'is resolved and validated first and the launch is refused while fields are missing, invalid, fail '
      + 'validation or are unresolved '
      + '(code `form_incomplete`), or when `expectedPayloadHash` no longer matches (code '
      + '`payload_mismatch`). Returns the job id. Runs the automation behind the form - confirm the '
      + 'modeledExtravars from resolve_field with the user before calling it.',
    inputSchema: {
      form: z.string().describe('Form name'),
      values: valuesSchema.optional(),
      skipped: skippedSchema,
      storedJob: storedJobSchema,
      verbose: z.boolean().optional().describe('Verbose ansible output (needs the allowVerboseMode role option)'),
      expectedPayloadHash: z.string().optional().describe('The payloadHash resolve_field returned for the approved values ; the launch is refused when the payload differs'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, wrap((a) => handlers.launchJob(a)));

  if (!policy.readOnly) server.registerTool('relaunch_job', {
    title: 'Relaunch job with changes',
    description: 'Launch a job again with some fields changed: the values the job was launched with, '
      + 'with `values` laid over them, are resolved and validated like launch_job and launched as a new '
      + 'job by you. Uploads of the original are reused. Without `values` it replays the job as it ran '
      + '(unless the form is under launch validation enforce). A relaunch through the check is refused '
      + 'for a password field the form shows - passwords are never stored with the values. Call it with `preview: true` '
      + 'first: that returns `modeledExtravars` (passwords masked), `credentials` and a `payloadHash` '
      + 'without launching - confirm them with the user, then call again with `expectedPayloadHash`. '
      + 'Refused while fields are missing, invalid or fail validation (code `form_incomplete`), for a '
      + 'shown password field (`unsupported`), with changes for a job that stored no form values, such as one a schedule launched (`no_form_data`), or when the payload changed (`payload_mismatch`).',
    inputSchema: {
      id: z.number().int().positive().describe('Id of the job to relaunch'),
      values: valuesSchema.optional().describe('Only the fields to change, as raw values (per step for a wizard: { <step>: { <field>: value } }) ; the rest is taken from the job'),
      verbose: z.boolean().optional().describe('Verbose ansible output (needs the allowVerboseMode role option)'),
      preview: z.boolean().optional().describe('Resolve and build the payload only, do not launch'),
      expectedPayloadHash: z.string().optional().describe('The payloadHash of the confirmed preview ; the relaunch is refused when the payload differs'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, wrap((a) => handlers.relaunchJob(a)));

  // ─── schedules (#1069) ───
  if (!policy.readOnly && options.allowPlannedJobs) server.registerTool('plan_job', {
    title: 'Plan a job (Run later)',
    description: 'Run the form once, later, as you: what Run later does on the form. The values are resolved '
      + 'and validated like launch_job now, and checked again when the run fires. `run_at` is an ISO 8601 '
      + 'time WITH its offset or Z (2026-10-15T22:00:00+02:00) ; a time without a zone is refused. The answer '
      + 'gives the run time in UTC and on the app\'s clock. Refused while the form is incomplete (code '
      + '`form_incomplete`) or when `expectedPayloadHash` no longer matches (`payload_mismatch`). Confirm the '
      + 'modeledExtravars from resolve_field and the time with the user before calling it.',
    inputSchema: {
      form: z.string().describe('Form name'),
      values: valuesSchema.optional(),
      skipped: skippedSchema,
      storedJob: storedJobSchema,
      run_at: z.string().describe('When to run it: ISO 8601 with its offset or Z'),
      name: z.string().min(1).max(255).describe('A name for the planned run, as listed under Jobs > Scheduled ; names are unique'),
      verbose: z.boolean().optional().describe('Verbose ansible output (needs the allowVerboseMode role option)'),
      expectedPayloadHash: z.string().optional().describe('The payloadHash resolve_field returned for the approved values'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, wrap((a) => handlers.planJob(a)));

  if (!policy.readOnly && options.allowScheduledJobs) server.registerTool('create_schedule', {
    title: 'Create schedule',
    description: 'A schedule of a form, as in Settings > Schedules: recurring with `cron` (five fields, such as '
      + '"0 22 * * 1-5"), or one run with `run_at` (ISO 8601 with its offset or Z). It runs as the Schedule '
      + 'Service with the given extra vars, NOT as you and without the form\'s validation - to run a form '
      + 'once as yourself, use plan_job.',
    inputSchema: {
      form: z.string().describe('Form name'),
      name: z.string().min(1).max(255).describe('A name for the schedule ; names are unique'),
      cron: z.string().optional().describe('A cron expression, for a recurring schedule'),
      run_at: z.string().optional().describe('One run at this time: ISO 8601 with its offset or Z'),
      extraVars: z.record(z.string(), z.any()).optional().describe('The extra vars the job gets'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, wrap((a) => handlers.createSchedule(a)));

  if (options.allowPlannedJobs || options.allowScheduledJobs) {
    server.registerTool('list_schedules', {
      title: 'List schedules',
      description: 'The schedules you may see: with allowScheduledJobs all of them, else the runs you planned. '
        + 'Per schedule its form, when it runs (runAt or cron, nextRun), whether it runs as you (planned) and how '
        + 'its last run went.',
      inputSchema: { form: z.string().optional().describe('Only the schedules of this form') },
      annotations: { readOnlyHint: true },
    }, wrap((a) => handlers.listSchedules(a)));

    server.registerTool('get_schedule', {
      title: 'Get schedule',
      description: 'One schedule, with its extra vars (secret-looking ones masked) and the output of its last run.',
      inputSchema: { id: z.number().int().positive().describe('Schedule id') },
      annotations: { readOnlyHint: true },
    }, wrap((a) => handlers.getSchedule(a)));

    if (!policy.readOnly) server.registerTool('delete_schedule', {
      title: 'Delete schedule',
      description: 'Cancel a planned run or delete a schedule you may see ; it does not run any more.',
      inputSchema: { id: z.number().int().positive().describe('Schedule id') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, wrap((a) => handlers.deleteSchedule(a)));
  }

  // ─── stored jobs (#1070) ───
  if (options.allowStoredJobs) {
    server.registerTool('list_stored_jobs', {
      title: 'List stored jobs',
      description: 'The stored jobs you may see (values saved under a name with Store on a form): your own and the ones '
        + 'other users shared with you, or everyone\'s for a settings user. Name, description, form, owner when not '
        + 'yours, created and expiry ; not the values - get_stored_job has them. One marked `usable` (your own or a '
        + 'shared one, of a form you may launch) can be passed as '
        + '`storedJob` to resolve_field, launch_job or plan_job to start from it.',
      inputSchema: { form: z.string().optional().describe('Only the stored jobs of this form') },
      annotations: { readOnlyHint: true },
    }, wrap((a) => handlers.listStoredJobs(a)));

    server.registerTool('get_stored_job', {
      title: 'Get stored job',
      description: 'One stored job with its values (the form\'s password fields left out, secret-looking values masked). '
        + 'Name it by `id`, or by `form` and `name` among your own.',
      inputSchema: {
        id: z.number().int().positive().optional().describe('Stored job id'),
        form: z.string().optional().describe('Its form, with name'),
        name: z.string().optional().describe('Its name, with form'),
      },
      annotations: { readOnlyHint: true },
    }, wrap((a) => handlers.getStoredJob(a)));

    if (!policy.readOnly) server.registerTool('store_job', {
      title: 'Store job',
      description: 'Save values of a form under a name, as the Store dialog does, to launch from later (yours or '
        + 'the user\'s in the browser, with Load). Password fields are not stored ; the answer says which '
        + 'fields were left out. A wizard form stores its values per step, with the optional steps skipped. '
        + '`expires_at` (optional) is ISO 8601 with its offset or Z.',
      inputSchema: {
        form: z.string().describe('Form name'),
        name: z.string().min(1).max(255).describe('A name, unique among your stored jobs of this form'),
        values: valuesSchema,
        skipped: skippedSchema,
        description: z.string().optional().describe('What these values are for'),
        expires_at: z.string().optional().describe('When it expires: ISO 8601 with its offset or Z ; none, it does not'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, wrap((a) => handlers.storeJob(a)));

    if (!policy.readOnly) server.registerTool('delete_stored_job', {
      title: 'Delete stored job',
      description: 'Delete one of your own stored jobs (a settings user: anyone\'s).',
      inputSchema: { id: z.number().int().positive().describe('Stored job id') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, wrap((a) => handlers.deleteStoredJob(a)));
  }

  server.registerTool('get_job', {
    title: 'Get job',
    description: 'Status and output of a job. Secret-looking extravars are masked ; credentials are never returned.',
    inputSchema: {
      id: z.number().int().positive().describe('Job id'),
      tail: z.number().int().positive().optional().describe('Only the last N lines of output'),
    },
    annotations: { readOnlyHint: true },
  }, wrap((a) => handlers.getJob(a)));
}

export default { createHandlers, registerTools, describeError, ToolError };
