'use strict';
import crypto from 'crypto';
import { canonicalJson } from '../lib/formEngine/output.js';

/**
 * Approval plans : what the operator was shown, sealed, one use, for a short while. The model
 * cannot launch anything ; the Launch button hands a plan id to /chat/approve, which launches
 * only this plan's payload hash, for this user, from this conversation, once.
 *
 * In memory on purpose : a plan lives minutes, and a restart only means "ask again".
 */
export const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_PLANS = 2000;

const plans = new Map();

const seal = (body) => crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');

function sweep(now = Date.now()) {
  for (const [id, p] of plans) if (p.expiresAt <= now || p.usedAt) plans.delete(id);
  // never unbounded : the oldest go first
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
}

export class PlanError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} p  { username, userType, sessionId, form, values, payloadHash, formFingerprint,
 *                      summary, label, sourceJobId }
 */
export function createPlan(p, now = Date.now()) {
  sweep(now);
  const body = {
    planId: crypto.randomBytes(8).toString('hex'),
    username: p.username,
    userType: p.userType || '',
    sessionId: p.sessionId,
    form: p.form,
    values: p.values || {},
    // a wizard's optional steps skipped
    skipped: p.skipped || {},
    payloadHash: p.payloadHash,
    formFingerprint: p.formFingerprint || '',
    summary: p.summary || p.form,
    label: p.label,
    sourceJobId: p.sourceJobId ?? null,
    createdAt: now,
    expiresAt: now + PLAN_TTL_MS,
  };
  const plan = { ...body, sealed: seal(body), usedAt: null, jobId: null };
  plans.set(plan.planId, plan);
  return plan;
}

/**
 * The plan behind a Launch click, marked used right away - a second click, or two clicks
 * racing, can never launch twice. Refuses anything not made for this user and conversation.
 */
export function takePlan(planId, { username, userType, sessionId }, now = Date.now()) {
  if (typeof planId !== 'string' || !/^[0-9a-f]{16}$/.test(planId)) throw new PlanError('plan_invalid', 'Not a plan id', 400);
  const plan = plans.get(planId);
  if (!plan) throw new PlanError('plan_not_found', 'This summary is no longer known - ask again', 404);
  const { usedAt, jobId, sealed, ...body } = plan; // eslint-disable-line no-unused-vars
  if (seal(body) !== sealed) throw new PlanError('plan_tampered', 'This plan was changed after it was made', 409);
  if (plan.username !== username || (plan.userType || '') !== (userType || '')) throw new PlanError('plan_wrong_user', 'This summary was made for another user', 403);
  if (plan.sessionId !== sessionId) throw new PlanError('plan_wrong_session', 'This summary belongs to another conversation', 403);
  if (plan.usedAt) throw new PlanError('plan_used', `This summary was already used${plan.jobId ? ` - job ${plan.jobId}` : ''}`, 409);
  if (plan.expiresAt <= now) throw new PlanError('plan_expired', 'This summary expired - ask again', 410);
  plan.usedAt = now;
  return plan;
}

export function markLaunched(plan, jobId) {
  plan.jobId = jobId ?? null;
}

/** for the tests */
export function clearPlans() {
  plans.clear();
}

export default { createPlan, takePlan, markLaunched, clearPlans, PlanError, PLAN_TTL_MS };
