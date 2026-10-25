'use strict';
import logger from '../lib/logger.js';
import appConfig from '../../config/app.config.js';
import ChatSettings from '../models/chatSettings.model.js';
import Audit from '../models/audit.model.js';
import { createHandlers, describeError } from '../mcp/tools.js';
import { ChatError } from './errors.js';
import { complete as providerComplete } from './providers/index.js';
import { openSession, getSession, dropSession, countTurn } from './sessions.js';
import { takePlan, markLaunched, PlanError } from './plans.js';
import { runTurn } from './turn.js';
import { chatForms } from './forms.js';

/**
 * The chat assistant, for one request. `deps` are the models the MCP server uses (Form,
 * Job, Expression, Query, resolveFormQuery) : the chat calls the same form service in
 * process - it never HTTP-calls its own MCP endpoint, and has no form engine of its own.
 */
export function createChatService({
  deps,
  complete = providerComplete,
  loadSettings = () => ChatSettings.findResolved(),
  audit = (entry) => Audit.log(entry),
  enabled = () => appConfig.enableChat,
} = {}) {
  async function readySettings() {
    if (!enabled()) throw new ChatError('chat_disabled', 'The chat assistant is not enabled', 404);
    const settings = await loadSettings();
    if (!ChatSettings.isConfigured(settings)) throw new ChatError('chat_not_configured', 'No chat model provider is configured', 503);
    return settings;
  }

  return {
    /**
     * what the page may know : on or off, the provider and model - never the key - and a
     * few of this user's chat forms, so the welcome names real examples
     */
    async config(user) {
      if (!enabled()) return { enabled: false };
      const settings = await loadSettings().catch(() => null);
      const ok = ChatSettings.isConfigured(settings);
      if (!ok) return { enabled: false };
      let examples = [];
      if (user) {
        examples = await chatForms(createHandlers({ user, deps })).then((forms) => forms.slice(0, 3).map((f) => f.name)).catch(() => []);
      }
      return { enabled: true, provider: settings.provider, model: settings.model, maxTurns: settings.max_turns, jobStatus: settings.allow_job_status !== 0, examples };
    },

    async openSession(user) {
      await readySettings();
      const s = openSession(user);
      return { sessionId: s.id };
    },

    async message(user, body) {
      const settings = await readySettings();
      const session = getSession(body?.sessionId, user);
      if (session.busy) throw new ChatError('busy', 'The previous message is still being answered', 409);
      countTurn(user);
      session.busy = true;
      try {
        const handlers = createHandlers({ user, deps });
        return await runTurn({ session, message: body?.message, selection: body?.selection, settings, handlers, user, complete });
      } finally {
        session.busy = false;
        // the notes of a click that landed while this turn ran go in now, after the
        // turn's tool_use / tool_result pairs (see addOperatorNote)
        flushOperatorNotes(session);
      }
    },

    /**
     * The operator's click. Launches exactly the payload hash the summary showed, once :
     * the form is resolved again and refused when the payload moved (a query answered
     * differently, the form changed) - then ask again.
     */
    async approve(user, body, ip) {
      await readySettings();
      const session = getSession(body?.sessionId, user);
      // A click while a turn is being answered is refused BEFORE the plan is taken (so
      // the button still works once the turn ends) : the note the launch adds to the
      // conversation would otherwise land between a tool_use and its tool_result, which
      // the providers reject - and the conversation was broken for good.
      if (session.busy) throw new ChatError('busy', 'The previous message is still being answered - try again when it is done', 409);
      const plan = takePlan(body?.planId, { username: user.username, userType: user.type, sessionId: session.id });
      const handlers = createHandlers({ user, deps });
      let launched;
      try {
        if (plan.sourceJobId) {
          const preview = await handlers.relaunchJob({ id: plan.sourceJobId, values: plan.values, preview: true });
          if (preview?.payloadHash !== plan.payloadHash) throw new ChatError('plan_stale', 'The job changed since the summary was made - ask again', 409);
          launched = await handlers.relaunchJob({ id: plan.sourceJobId, values: plan.values, expectedPayloadHash: plan.payloadHash });
        } else {
          const res = await handlers.resolveField({ form: plan.form, values: plan.values, skipped: plan.skipped });
          if (!res.complete || res.payloadHash !== plan.payloadHash) {
            throw new ChatError('plan_stale', 'The form resolves differently now than when the summary was made - ask again', 409);
          }
          if (plan.formFingerprint && res.formFingerprint !== plan.formFingerprint) {
            throw new ChatError('plan_stale', 'The form was changed since the summary was made - ask again', 409);
          }
          launched = await handlers.launchJob({ form: plan.form, values: plan.values, skipped: plan.skipped, expectedPayloadHash: plan.payloadHash });
        }
      } catch (err) {
        if (err instanceof ChatError) throw err;
        const d = describeError(err);
        const status = { access_denied: 403, not_found: 404, form_incomplete: 409, payload_mismatch: 409, unsupported: 400, no_form_data: 400 }[d.code] || 500;
        throw new ChatError(d.code, d.message, status);
      }
      const jobId = launched?.id ?? null;
      markLaunched(plan, jobId);
      // the conversation learns what the click did : "did it work ?" can then be answered
      // (the job tool), and the operator may refer to this job without retyping its id
      if (jobId) {
        addOperatorNote(session, `[The operator clicked ${plan.label}: job ${jobId} was launched for the form '${plan.form}'.]`);
        session.operatorMessages.push(`job ${jobId}`);
      }
      logger.notice(`Chat: ${user.username} launched '${plan.form}' as job ${jobId} (plan ${plan.planId})`);
      audit({
        user, ip, action: 'chat.launch', targetType: 'job', target: jobId,
        detail: { form: plan.form, provider: (await loadSettings().catch(() => ({})))?.provider, payloadHash: plan.payloadHash, planId: plan.planId, relaunchOf: plan.sourceJobId || undefined },
      });
      return { job: { id: jobId }, form: plan.form, summary: plan.summary, label: plan.label };
    },

    reset(user, body) {
      dropSession(body?.sessionId, user);
      return { ok: true };
    },
  };
}

/**
 * Adds an operator note (what a click did) to the conversation.
 *
 * The launch is awaited, so a new message can start a turn while it runs : the note
 * is then queued and added when that turn ends (flushOperatorNotes), never in the
 * middle of the turn's tool calls.
 *
 * Args:
 *   session (object): The chat session.
 *   text (string): The note, as a user message.
 *
 * Returns:
 *   void
 */
function addOperatorNote(session, text) {
  if (session.busy) {
    (session.pendingNotes ||= []).push(text);
    return;
  }
  session.messages.push({ role: 'user', text });
}

/**
 * Adds the notes queued while a turn ran (addOperatorNote) to the conversation.
 *
 * Args:
 *   session (object): The chat session, no longer busy.
 *
 * Returns:
 *   void
 */
function flushOperatorNotes(session) {
  const notes = session.pendingNotes || [];
  session.pendingNotes = [];
  for (const text of notes) session.messages.push({ role: 'user', text });
}

/** a chat / plan error as the route answers it */
export function errorStatus(err) {
  if (err instanceof ChatError || err instanceof PlanError) return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  return null;
}

export default { createChatService, errorStatus };
