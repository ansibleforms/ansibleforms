// How a notification reaches a channel of Connections > Notifications, one sender per type,
// one interface : send(channel, message, recipients).
//
//   message : { title, text, html (mail only, else the text is used), status, event, link,
//               job: { id, form, user } }
//
//   mail      through the channel's SMTP server, to the recipients (the form's
//             notifications.recipients, or an approval's notifications)
//   slack     an incoming webhook : text, and blocks (a section, a button to the job)
//   teams     a message with an Adaptive Card attachment : what Teams' Workflows webhooks (the
//             "post to a channel when a webhook request is received" template) take, and what
//             the incoming webhooks of before take too - the older MessageCard is retired
//   telegram  the Bot API's sendMessage, HTML parse mode, every text escaped
//   webhook   the channel's JSON template (renderPayload), with its headers and bearer token
//
// Every request has a timeout, a webhook's address and a bot token are never logged (both are
// secrets : the address is the key), and a failure is logged and handed back : it never fails
// a job or an approval.
import https from "https";
import axios from "axios";
import logger from "./logger.js";
import NotificationChannel, { renderPayload } from "../models/notificationChannel.model.js";
import Settings from "../models/settings.model.js";

// how long a channel may take to answer
const TIMEOUT_MS = 10000;
// Telegram's longest message ; Slack and Teams take more, a notification is short anyway
const TELEGRAM_MAX = 4000;
// the longest (escaped) title of a Telegram message
const TELEGRAM_TITLE_MAX = 256;

/**
 * A text escaped for HTML (Telegram's parse mode, a mail built from a text).
 *
 * Args:
 *   value (string): the text.
 *
 * Returns:
 *   string: the text, & < > " escaped.
 */
export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A text escaped for HTML and cut so that the ESCAPED result fits a length.
 *
 * The raw text is cut, never the escaped one, so an entity (&amp; &lt; ...) is never
 * split ; a cut text ends in '...'. Characters are taken whole (a surrogate pair is
 * never split either).
 *
 * Args:
 *   value (string): the raw text.
 *   max (number): the longest escaped result allowed.
 *
 * Returns:
 *   string: the escaped text, at most `max` characters long.
 */
export function escapeTruncated(value, max) {
  const escaped = escapeHtml(value);
  if (escaped.length <= max) return escaped;
  const budget = Math.max(0, max - 3);
  let out = "";
  for (const ch of String(value ?? "")) {
    const piece = escapeHtml(ch);
    if (out.length + piece.length > budget) break;
    out += piece;
  }
  return max >= 3 ? `${out}...` : out;
}

/**
 * A text escaped for Slack's mrkdwn : & < > only, as Slack asks.
 *
 * Args:
 *   value (string): the text.
 *
 * Returns:
 *   string: the text escaped.
 */
export function escapeSlack(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * What a failed request is said as : its status, never its address (a webhook's address, a
 * bot's token in the path, is the secret).
 *
 * Args:
 *   err (Error): the error axios threw.
 *
 * Returns:
 *   string: the reason.
 */
function reasonOf(err) {
  if (err?.response) {
    const body = typeof err.response.data === "string" ? err.response.data : JSON.stringify(err.response.data ?? "");
    return `answered ${err.response.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  }
  if (err?.code === "ECONNABORTED") return `no answer within ${TIMEOUT_MS / 1000}s`;
  return err?.code || err?.message || String(err);
}

// ─── the bodies, one per type (pure : the tests read them) ────────────────────

/**
 * The JSON a Slack incoming webhook takes : the text (its fallback, in notifications), and
 * blocks - the title in bold, the text, a button to the job.
 *
 * Args:
 *   message (object): the notification.
 *   buttonLabel (string): the button's label.
 *
 * Returns:
 *   object: the body.
 */
export function slackBody(message, buttonLabel = "Open") {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(message.title)}*\n${escapeSlack(message.text)}` } },
  ];
  if (message.link) {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: buttonLabel }, url: message.link }] });
  }
  return { text: `${message.title}\n${message.text}`, blocks };
}

/**
 * The JSON a Microsoft Teams webhook takes : a message with one Adaptive Card - the title, the
 * text, a button to the job.
 *
 * Args:
 *   message (object): the notification.
 *   buttonLabel (string): the button's label.
 *
 * Returns:
 *   object: the body.
 */
export function teamsBody(message, buttonLabel = "Open") {
  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", text: String(message.title ?? ""), weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text: String(message.text ?? ""), wrap: true },
    ],
    actions: message.link ? [{ type: "Action.OpenUrl", title: buttonLabel, url: message.link }] : [],
  };
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] };
}

/**
 * The JSON Telegram's sendMessage takes : the chat, the title in bold, the text, a link to the
 * job - HTML, escaped, cut to Telegram's length.
 *
 * Args:
 *   message (object): the notification.
 *   chatId (string): the chat.
 *   buttonLabel (string): the link's label.
 *
 * Returns:
 *   object: the body.
 */
export function telegramBody(message, chatId, buttonLabel = "Open") {
  const link = message.link ? `\n<a href="${escapeHtml(message.link)}">${escapeHtml(buttonLabel)}</a>` : "";
  // the title is limited too : a huge one left no room (or a negative one) for the text
  const title = escapeTruncated(message.title, TELEGRAM_TITLE_MAX);
  const room = TELEGRAM_MAX - link.length - title.length - 10;
  // cut the RAW text, then escape : cutting the escaped text could split an entity
  // ('&am...') and Telegram refuses the whole message as invalid HTML
  const text = escapeTruncated(message.text, room);
  return {
    chat_id: chatId,
    text: `<b>${title}</b>\n${text}${link}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
}

/**
 * The placeholders a webhook's template is filled with.
 *
 * Args:
 *   message (object): the notification.
 *
 * Returns:
 *   object: title, text, status, event, statusMessage, jobId, form, user, link.
 */
export function payloadValues(message) {
  return {
    title: message.title,
    text: message.text,
    status: message.status,
    event: message.event,
    // why a job needs attention (status warning) ; empty otherwise
    statusMessage: message.statusMessage || "",
    jobId: message.job?.id,
    form: message.job?.form,
    user: message.job?.user,
    link: message.link,
  };
}

// ─── sending ──────────────────────────────────────────────────────────────────

/**
 * Sends a notification to one channel, by its type.
 *
 * Args:
 *   channel (object): the channel, as stored (decrypted).
 *   message (object): the notification.
 *   recipients (string[]): a mail channel's addresses ; the others ignore them.
 *
 * Returns:
 *   Promise<string>: what was sent (the mail's id, or "sent").
 *
 * Raises:
 *   Error: it could not be sent (the reason, without secrets).
 */
export async function send(channel, message, recipients = []) {
  const label = message.buttonLabel || "Open";
  const post = async (url, body, options = {}) => {
    try {
      await axios({ url, method: options.method || "POST", data: body, timeout: TIMEOUT_MS, headers: { "Content-Type": "application/json", ...(options.headers || {}) }, httpsAgent: options.httpsAgent });
    } catch (err) {
      throw new Error(`${channel.type} channel '${channel.name}' ${reasonOf(err)}`, { cause: err });
    }
    return "sent";
  };
  switch (channel.type) {
    case "mail": {
      const to = (recipients || []).filter(Boolean);
      if (!to.length) throw new Error(`mail channel '${channel.name}': no address to send to`);
      const config = await NotificationChannel.toMailConfig(channel);
      const html = message.html || `<p><b>${escapeHtml(message.title)}</b></p><p>${escapeHtml(message.text).replace(/\n/g, "<br>")}</p>${message.link ? `<p><a href="${escapeHtml(message.link)}">${escapeHtml(label)}</a></p>` : ""}`;
      const id = await Settings.maildo(config, to.join(","), message.title, html);
      if (!id) throw new Error(`mail channel '${channel.name}' has no server`);
      return id;
    }
    case "slack":
      return post(channel.webhook_url, slackBody(message, label));
    case "teams":
      return post(channel.webhook_url, teamsBody(message, label));
    case "telegram": {
      const cred = await NotificationChannel.resolveCredential(channel.token_credential);
      if (!cred?.password) throw new Error(`telegram channel '${channel.name}': its bot token credential '${channel.token_credential}' is not found`);
      const base = String(channel.api_url || "https://api.telegram.org").replace(/\/+$/, "");
      return post(`${base}/bot${cred.password}/sendMessage`, telegramBody(message, channel.chat_id, label));
    }
    case "webhook": {
      let headers = {};
      if (String(channel.headers || "").trim()) headers = JSON.parse(channel.headers);
      if (channel.token_credential) {
        const cred = await NotificationChannel.resolveCredential(channel.token_credential);
        if (!cred?.password) throw new Error(`webhook channel '${channel.name}': its token credential '${channel.token_credential}' is not found`);
        headers.Authorization = `Bearer ${cred.password}`;
      }
      const body = renderPayload(channel.payload, payloadValues(message));
      // the certificate checked unless the channel turns it off (an endpoint with a self-signed
      // certificate), as a runner's ignore_certs does
      const verifyTls = !(channel.verify_tls === 0 || channel.verify_tls === false);
      const httpsAgent = new https.Agent({ rejectUnauthorized: verifyTls });
      return post(channel.url, body, { method: channel.method || "POST", headers, httpsAgent });
    }
    default:
      throw new Error(`channel '${channel.name}' has an unknown type '${channel.type}'`);
  }
}

/**
 * Sends a notification to channels named by a form (its notifications, its approval) : each
 * by its name, turned off ones and unknown ones skipped (said in the log), a failure logged.
 * Never throws : a notification never fails a job.
 *
 * Args:
 *   names (string[]): the channels' names.
 *   message (object): the notification.
 *   recipients (string[]): the addresses a mail channel sends to.
 *   context (string): what it is, for the log ("Status notification", "Approval").
 *
 * Returns:
 *   Promise<object[]>: { name, ok, error } per channel.
 */
export async function sendToChannels(names, message, recipients = [], context = "Notification") {
  const results = [];
  for (const name of [...new Set((Array.isArray(names) ? names : [names]).filter(Boolean).map(String))]) {
    try {
      const channel = await NotificationChannel.findByName(name);
      if (!channel) {
        logger.warning(`${context}: there is no notification channel named '${name}' (Connections > Notifications), skipped`);
        results.push({ name, ok: false, error: "no such channel" });
        continue;
      }
      if (!channel.enabled) {
        logger.notice(`${context}: the notification channel '${name}' is turned off, skipped`);
        results.push({ name, ok: false, error: "turned off" });
        continue;
      }
      const id = await send(channel, message, recipients);
      logger.notice(`${context} sent to the ${channel.type} channel '${name}'${channel.type === "mail" ? ` (${id})` : ""}`);
      results.push({ name, ok: true });
    } catch (err) {
      logger.error(`${context} could not be sent to the channel '${name}': ${err.message}`);
      results.push({ name, ok: false, error: err.message });
    }
  }
  return results;
}

export default { send, sendToChannels, slackBody, teamsBody, telegramBody, payloadValues, escapeHtml, escapeSlack };
