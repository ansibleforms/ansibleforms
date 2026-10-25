'use strict';
import { describeError } from '../mcp/tools.js';
import { describeRowErrors } from '../lib/launchValidation.js';
import { describeForm, fieldsBySlot, score, chatForms } from './forms.js';
import { mask, operatorText, typedByOperator, checkOperatorSlots } from './policy.js';
import { createPlan } from './plans.js';

/**
 * The tools the model may call. There is NO launch or execute tool : a ready form becomes a
 * sealed plan, and only the operator's click on /chat/approve launches it. Every tool runs
 * through the MCP handlers (the same form engine as the browser), as the logged-in user.
 */
export const TOOLS = [
  {
    name: 'catalog',
    description: 'List the forms this user may run in this chat, ranked against the question.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'resolve',
    description: 'Evaluate a form with the answers so far: missing fields, choices, errors. When complete it stores a summary the operator can approve. Does not launch.',
    parameters: {
      type: 'object',
      properties: { form: { type: 'string' }, answers: { type: 'object' } },
      required: ['form', 'answers'],
    },
  },
  {
    name: 'plan',
    description: 'Same as resolve for a form you believe is complete: stores the summary the operator can approve. Does not launch.',
    parameters: {
      type: 'object',
      properties: { form: { type: 'string' }, answers: { type: 'object' } },
      required: ['form', 'answers'],
    },
  },
  {
    name: 'relaunch',
    description: 'Preview running an existing job again, optionally changing some fields. Does not launch.',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'integer' }, values: { type: 'object' } },
      required: ['job_id'],
    },
  },
  {
    name: 'job',
    description: 'Read the status of a job.',
    parameters: { type: 'object', properties: { job_id: { type: 'integer' } }, required: ['job_id'] },
  },
];
export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const MAX_CHOICES = 100;
const MAX_CATALOG = 25;

const error = (code, message, extra = {}) => ({ status: 'error', error: { code, message, ...extra } });

const MAX_CARD_FIELDS = 20;
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** a short value for the model : option records by their name, long text cut */
function brief(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'name' in value) return value.name;
  if (Array.isArray(value) && value.length && value.every((v) => v && typeof v === 'object' && 'name' in v)) return value.map((v) => v.name);
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}...`;
  return value;
}

/** one option as a choice : the value to send back, and a few columns to recognise it by */
function choice(option, def) {
  if (option === null || typeof option !== 'object') return { value: option };
  const vc = def?.valueColumn;
  const value = (vc && option[vc] !== undefined) ? option[vc] : (option.name ?? option.value ?? Object.values(option)[0]);
  const out = { value };
  for (const [k, v] of Object.entries(option)) {
    if (Object.keys(out).length >= 4) break;
    if (v === value || k === vc || (v !== null && typeof v === 'object')) continue;
    out[k] = v;
  }
  return mask(out);
}

/**
 * The context of one tool call.
 * @typedef {object} ToolContext
 * @property {object} handlers   createHandlers({ user, deps }) of the MCP server
 * @property {object} user       req.user.user
 * @property {object} session    the conversation (operatorMessages, selections, id)
 * @property {object} settings   the chat settings row
 */

/**
 * Run one tool call. Returns { payload (for the model), choices?, proposal?, job? }.
 * An unknown tool or broken arguments never reach AnsibleForms.
 */
export async function runTool(name, args, ctx) {
  if (!TOOL_NAMES.has(name)) return { payload: error('unknown_tool', `'${name}' is not available`) };
  if (!args || typeof args !== 'object' || args.__invalid_json__) return { payload: error('invalid_arguments', 'Tool arguments were not a JSON object') };
  try {
    if (name === 'catalog') return await catalog(args, ctx);
    if (name === 'relaunch') return await relaunch(args, ctx);
    if (name === 'job') return await job(args, ctx);
    return await resolve(args, ctx, name === 'plan');
  } catch (err) {
    const d = describeError(err);
    return { payload: error(d.code, d.message) };
  }
}

async function catalog(args, ctx) {
  const query = typeof args.query === 'string' ? args.query : '';
  let forms = (await chatForms(ctx.handlers)).map((f) => ({
    form: f.name,
    description: String(f.description || '').trim(),
    ...(query ? { score: score(query, [f.name, f.description]) } : {}),
  }));
  if (query) forms.sort((a, b) => b.score - a.score);
  const total = forms.length;
  forms = forms.slice(0, MAX_CATALOG);
  return { payload: { status: 'ok', forms, total, ...(total > forms.length ? { left_out: total - forms.length } : {}) } };
}

/** the definition of a chat form this user may use, or a refusal payload */
async function chatForm(name, ctx) {
  const allowed = (await chatForms(ctx.handlers)).find((f) => f.name === name);
  if (!allowed) return { refused: error('unsupported_form', `'${name}' is not a form this chat may use. Call catalog for the forms it can.`) };
  const def = await ctx.handlers.getForm({ name });
  if (def.supported === false) return { refused: error('unsupported_form', `'${name}' ${def.unsupportedReason || 'cannot be used in the chat'}`) };
  return { def, info: describeForm(def) };
}

/** slot answers -> form values ; unknown slots refused before AnsibleForms is asked */
function prepareValues(info, answers) {
  const unknown = Object.keys(answers).filter((k) => !info.slots.includes(k));
  if (unknown.length) {
    return { errors: unknown.map((k) => ({ slot: k, code: 'unknown_answer', message: `'${k}' is not a slot of ${info.form} ; use one of: ${info.slots.join(', ')}` })) };
  }
  const values = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === null || v === '' || v === undefined) continue;
    let value = v;
    if (info.listSlots.includes(k) && typeof value === 'string') value = /^(all|__all__)$/i.test(value) ? '__all__' : [value];
    values[k] = value;
  }
  if (!info.steps) return { values, flat: values };
  // a wizard : the answers per step, and an optional step nobody answered for skipped
  const steps = {};
  const skipped = {};
  for (const step of info.steps) {
    const given = Object.fromEntries(Object.entries(values)
      .filter(([k]) => step.slots.includes(k)).map(([k, v]) => [k.slice(step.name.length + 1), v]));
    if (Object.keys(given).length) steps[step.name] = given;
    else if (step.optional) skipped[step.name] = true;
  }
  return { values: steps, skipped, flat: values };
}

/** the slot a list row error is about : its field, `<step>.<field>` in a wizard */
function rowSlot(info, line) {
  return info.slots.find((slot) => line.startsWith(`${slot}[`) || line.startsWith(`${slot}.`)) || line.split(/[[.]/)[0];
}

function summaryOf(info, fields, values) {
  const byName = Object.fromEntries((fields || []).map((f) => [f.name, f]));
  const parts = [];
  for (const s of info.summaryFields) {
    const v = brief(byName[s.name]?.value ?? values[s.name]);
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${s.label} ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return parts.length ? `${info.form}: ${parts.join(', ')}` : info.form;
}

async function resolve(args, ctx, planOnly) {
  const formName = args.form;
  const answers = args.answers && typeof args.answers === 'object' && !Array.isArray(args.answers) ? args.answers : null;
  if (typeof formName !== 'string' || !answers) return { payload: error('invalid_arguments', 'form and answers are required') };
  const { def, info, refused } = await chatForm(formName, ctx);
  if (refused) return { payload: refused };

  const text = operatorText(ctx.session.operatorMessages);
  const denied = checkOperatorSlots(info.operatorSlots, answers, text, ctx.session.selections);
  if (denied) return { payload: { status: 'error', error: denied } };
  const { values, skipped, flat, errors } = prepareValues(info, answers);
  if (errors) return { payload: { status: 'needs_input', form: info.form, validation_errors: errors } };

  const res = await ctx.handlers.resolveField({ form: info.form, values, ...(skipped ? { skipped } : {}) });
  const defs = fieldsBySlot(def);
  // a wizard's optional step left out : said, so the model can offer it
  const skippedSteps = Object.keys(skipped || {});
  const stepNote = skippedSteps.length ? `Optional steps skipped because nothing was answered for them: ${skippedSteps.join(', ')}.` : '';
  const pending = new Set([...(res.missing || []), ...(res.waiting || [])]);
  const byName = Object.fromEntries((res.fields || []).map((f) => [f.name, f]));

  // every pending field is reported ; one the chat cannot fill (a password, a file) says so,
  // so the model sends the operator to the browser instead of asking for it
  const missing = [...pending].map((n) => ({
    slot: n,
    ...(info.slots.includes(n) ? {} : { answerable: false }),
    prompt: byName[n]?.label || defs[n]?.label || n,
    kind: byName[n]?.type || defs[n]?.type || 'text',
    ...(defs[n]?.multiple ? { multiple: true } : {}),
    ...(byName[n]?.waitingFor?.length ? { waiting_for: byName[n].waitingFor } : {}),
  }));
  const choices = {};
  for (const n of pending) {
    const opts = byName[n]?.options;
    if (Array.isArray(opts) && opts.length) choices[n] = opts.slice(0, MAX_CHOICES).map((o) => choice(o, defs[n]));
  }
  const other = (res.fields || []).filter((f) => info.slots.includes(f.name) && !pending.has(f.name) && f.visible !== false)
    .map((f) => ({ slot: f.name, prompt: f.label || f.name, kind: f.type, value: brief(mask(f.value)), ...(f.type === 'checkbox' ? { switch: true } : {}) }));
  const validationErrors = [
    ...Object.entries(res.validationErrors || {}).flatMap(([slot, errs]) => errs.map((e) => ({ slot, code: e.type, message: e.description || e.type }))),
    ...(res.invalid || []).filter((n) => !(n in (res.validationErrors || {})) && !(n in (res.rowErrors || {})))
      .map((n) => ({ slot: n, code: 'invalid_choice', message: `'${brief(flat[n])}' is not one of the available choices` })),
    ...describeRowErrors(res.rowErrors).map((line) => ({ slot: rowSlot(info, line), code: 'row_error', message: line })),
    ...(res.fields || []).filter((f) => f.status === 'error' && f.error).map((f) => ({ slot: f.name, code: 'field_error', message: f.error })),
  ];

  if (!res.complete || !res.payloadHash) {
    const payload = {
      status: 'needs_input', form: info.form, missing_fields: missing, choices,
      validation_errors: validationErrors, other_fields: other,
      ...(Object.keys(info.slotHelp).length ? { slot_help: info.slotHelp } : {}),
      ...(res.warnings?.length ? { warnings: res.warnings.slice(0, 5) } : {}),
    };
    const list = Object.entries(choices).map(([slot, options]) => ({ slot, label: byName[slot]?.label || defs[slot]?.label || slot, options }));
    const notes = [planOnly ? 'The form is not complete yet ; ask for the missing fields.' : '', stepNote].filter(Boolean);
    if (notes.length) payload.note = notes.join(' ');
    return { payload, choices: list };
  }

  // complete : the summary the operator can approve - never launched from here
  const optionalSwitches = other.filter((o) => o.switch && o.value !== true).map((o) => ({ slot: o.slot, prompt: o.prompt, ...(info.slotHelp[o.slot] ? { help: info.slotHelp[o.slot] } : {}) }));
  const label = 'Launch';
  // what the card shows as a table : every field with a value, a switch only when it is on
  const chosen = other.filter((o) => (o.switch ? o.value === true : !isEmpty(o.value)))
    .slice(0, MAX_CARD_FIELDS).map((o) => ({ label: o.prompt, value: o.switch ? true : o.value }));
  const summary = summaryOf(info, res.fields, flat);
  const plan = createPlan({
    username: ctx.user.username, userType: ctx.user.type, sessionId: ctx.session.id,
    form: info.form, values, ...(skipped ? { skipped } : {}), payloadHash: res.payloadHash, formFingerprint: res.formFingerprint,
    summary, label,
  });
  const extravars = mask(res.modeledExtravars || {});
  return {
    payload: {
      status: 'planned', form: info.form, plan_id: plan.planId, summary,
      expires_at: new Date(plan.expiresAt).toISOString(),
      ...(optionalSwitches.length ? { optional_switches: optionalSwitches } : {}),
      ...(stepNote ? { note: stepNote } : {}),
    },
    proposal: {
      planId: plan.planId, label, form: info.form, summary, fields: chosen, extravars,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      ...(optionalSwitches.length ? { optionalSwitches } : {}),
    },
  };
}

async function relaunch(args, ctx) {
  let id = args.job_id;
  if (typeof id === 'string' && /^\d+$/.test(id)) id = parseInt(id, 10);
  if (!Number.isInteger(id) || id < 1) return { payload: error('invalid_arguments', 'job_id must be a positive integer') };
  const values = args.values ?? {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { payload: error('invalid_arguments', 'values must be an object') };
  const text = operatorText(ctx.session.operatorMessages);
  if (!typedByOperator(String(id), text)) return { payload: error('operator_choice_required', 'Type the id of the job you want to run again', { slot: 'job_id' }) };

  const job = await ctx.handlers.getJob({ id, tail: 1 });
  const { info, refused } = await chatForm(job.form, ctx);
  if (refused) return { payload: refused };
  const denied = checkOperatorSlots(info.operatorSlots, values, text, ctx.session.selections);
  if (denied) return { payload: { status: 'error', error: denied } };
  const { values: prepared, flat, errors } = prepareValues(info, values);
  if (errors) return { payload: { status: 'needs_input', form: info.form, validation_errors: errors } };

  const preview = await ctx.handlers.relaunchJob({ id, values: prepared, preview: true });
  if (!preview?.payloadHash) return { payload: error('bad_response', 'The relaunch preview did not return a payload') };
  const changed = Object.keys(flat);
  const summary = `Relaunch job ${id} (${info.form})${changed.length ? `, changing ${changed.join(', ')}` : ''}`;
  const plan = createPlan({
    username: ctx.user.username, userType: ctx.user.type, sessionId: ctx.session.id,
    form: info.form, values: prepared, payloadHash: preview.payloadHash, summary, label: 'Relaunch',
    sourceJobId: id,
  });
  return {
    payload: { status: 'planned', form: info.form, source_job_id: id, plan_id: plan.planId, summary, expires_at: new Date(plan.expiresAt).toISOString() },
    proposal: {
      planId: plan.planId, label: 'Relaunch', form: info.form, summary, sourceJobId: id,
      extravars: mask(preview.modeledExtravars || {}), expiresAt: new Date(plan.expiresAt).toISOString(),
    },
  };
}

async function job(args, ctx) {
  if (!ctx.settings?.allow_job_status) return { payload: error('not_allowed', 'Reading job status is switched off for this chat') };
  const id = typeof args.job_id === 'string' && /^\d+$/.test(args.job_id) ? parseInt(args.job_id, 10) : args.job_id;
  if (!Number.isInteger(id) || id < 1) return { payload: error('invalid_arguments', 'job_id must be a positive integer') };
  const j = await ctx.handlers.getJob({ id, tail: 1 });
  // the status only : never the extravars, never the output
  const out = { id: j.id, form: j.form, status: j.status, start: j.start, end: j.end, user: j.user };
  return { payload: { status: 'ok', job: out }, job: out };
}

export default { TOOLS, TOOL_NAMES, runTool };
