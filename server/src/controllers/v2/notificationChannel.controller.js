"use strict";
// Connections > Notifications : the channels notifications go to (models/notificationChannel),
// and a test notification through one (lib/notifiers). A Slack or Teams webhook address is a
// secret : every answer hands it back masked.
import NotificationChannel from "../../models/notificationChannel.model.js";
import { send } from "../../lib/notifiers.js";
import RestResult from "../../models/restResult.model.v2.js";
import Errors from "../../lib/errors.js";
import Helpers from "../../lib/common.js";
import i18n from "../../lib/i18n.js";
import CredentialModel from "../../models/credential.model.v2.js";
import { isAdminRequest } from "../../lib/adminGrants.js";

// the fields that say where a channel sends the credential it names, by type : a mail channel's
// own server (used while its credential has none), a webhook's url and a telegram bot's API
// address ; a certificate check turned off counts too
const CHANNEL_TARGETS = { mail: ["server", "port", "secure"], webhook: ["url", "verify_tls"], telegram: ["api_url"] };
const FLAG_FIELDS = ["secure", "verify_tls"];
// the fields a channel names a credential in
const CHANNEL_CREDENTIALS = ["credential", "token_credential"];

/**
 * Whether a write sends a channel's credential to another place : one of its type's target fields
 * sent with another value than the stored one.
 *
 * Args:
 *   existing (object): the channel as it is.
 *   data (object): the fields written.
 *
 * Returns:
 *   boolean: true when the write points it elsewhere.
 */
function channelTargetChanged(existing, data) {
  const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
  const flag = (v) => v === true || Number(v) === 1;
  return (CHANNEL_TARGETS[existing.type] || []).some((f) => {
    if (data[f] === undefined) return false;
    return FLAG_FIELDS.includes(f) ? flag(data[f]) !== flag(existing[f]) : text(data[f]) !== text(existing[f]);
  });
}

/**
 * Keeps a user who is not an admin from sending a credential's secret where they choose. A channel
 * posts its token (a webhook's bearer, a telegram bot's) or signs in with its login (mail) at an
 * address the user types : they may only name credentials that are not an admin's
 * (models/credential.model.v2.js isAdminGuarded), and moving a channel to another address drops the
 * credential it names, unless another one is chosen with it. An admin's write is left as it is.
 *
 * Args:
 *   req (object): the request (its body is changed in place).
 *   existing (object|null): the channel as it is, null on a create.
 *
 * Returns:
 *   Promise<void>: settles when the write may go on.
 *
 * Raises:
 *   Errors.AccessDeniedError: a credential named is an admin's.
 */
async function guardChannelCredentials(req, existing) {
  if (isAdminRequest(req)) return;
  const data = req.body;
  // the credentials this write chooses : the ones it names that the channel did not already
  const chosen = CHANNEL_CREDENTIALS.filter((k) => data[k] && data[k] !== existing?.[k]).map((k) => data[k]);
  const guarded = await CredentialModel.firstAdminGuarded(chosen);
  if (guarded) throw new Errors.AccessDeniedError(i18n.t(req, "resources.credentialNotAllowed", { name: guarded }));
  // a mail channel through Microsoft 365 sends as the mailbox it names, with the app's token : the
  // mailbox and the way are the admin's to change, as its entraid credential is
  if (existing?.type === "mail" && existing.credential && (data.credential === undefined || data.credential === existing.credential)) {
    const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
    const moved = ["from_address", "send_through"].some((f) => data[f] !== undefined && text(data[f]) !== text(existing[f]));
    if (moved && (await CredentialModel.findRowByName(existing.credential))?.credential_type === "entraid") {
      throw new Errors.AccessDeniedError(i18n.t(req, "resources.credentialNotAllowed", { name: existing.credential }));
    }
  }
  // moved elsewhere : the credential it keeps stays behind
  if (existing && channelTargetChanged(existing, data)) {
    for (const k of CHANNEL_CREDENTIALS) {
      const kept = data[k] === undefined ? existing[k] : data[k];
      if (kept && kept === existing[k]) data[k] = "";
    }
  }
}

const find = async (req, res) => {
  try {
    if (req.query.name) {
      const [channel] = await NotificationChannel.withServer([await NotificationChannel.findByName(req.query.name)]);
      return res.json(RestResult.single(NotificationChannel.masked(channel)));
    }
    const channels = await NotificationChannel.withServer(await NotificationChannel.findAll());
    return res.json(RestResult.list(channels.map((c) => NotificationChannel.masked(c))));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const create = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    await guardChannelCredentials(req, null);
    const id = await NotificationChannel.create(req.body);
    return res.status(201).json(RestResult.single({ message: i18n.t(req, "success.created", { resource: "Notification channel" }), id }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const findById = async (req, res) => {
  try {
    const channel = await NotificationChannel.findById(req.params.id);
    if (!channel) throw new Errors.NotFoundError(`No notification channel with id ${req.params.id}`);
    const [shown] = await NotificationChannel.withServer([channel]);
    return res.json(RestResult.single(NotificationChannel.masked(shown)));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const update = async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) {
      throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    }
    const existing = await NotificationChannel.findById(req.params.id);
    if (!existing) throw new Errors.NotFoundError(`No notification channel with id ${req.params.id}`);
    await guardChannelCredentials(req, existing);
    await NotificationChannel.update(req.body, req.params.id);
    return res.json(RestResult.single({ message: i18n.t(req, "success.updated", { resource: "Notification channel" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

const deleteChannel = async (req, res) => {
  try {
    await NotificationChannel.delete(req.params.id);
    return res.json(RestResult.single({ message: i18n.t(req, "success.deleted", { resource: "Notification channel" }) }));
  } catch (err) {
    Errors.ReturnError(res, err);
  }
};

// Send test : a notification through the saved channel, turned off or not, in the admin's
// language, naming who sent it ; a mail channel to the address given
const test = async (req, res) => {
  try {
    const channel = await NotificationChannel.findById(req.params.id);
    if (!channel) throw new Errors.NotFoundError(`No notification channel with id ${req.params.id}`);
    if (channel.type === "mail" && !req.body?.to) throw new Errors.BadRequestError(i18n.t(req, "errors.requiredFields"));
    const who = req.user?.user?.username || "someone";
    const message = {
      title: req.body?.subject || i18n.t(req, "email.test.subject"),
      text: i18n.t(req, "notifications.testText", { who, name: channel.name }),
      html: channel.type === "mail" ? req.body?.body || i18n.t(req, "email.test.body") : undefined,
      status: "test",
      event: "test",
      job: { id: 0, form: "", user: who },
      link: "",
    };
    const id = await send(channel, message, channel.type === "mail" ? [req.body.to] : []);
    const text = channel.type === "mail" ? i18n.t(req, "resources.mailSent", { id }) : i18n.t(req, "notifications.testSent", { name: channel.name });
    return res.json(RestResult.single({ message: text }));
  } catch (err) {
    if (err instanceof Errors.BadRequestError || err instanceof Errors.NotFoundError) return Errors.ReturnError(res, err);
    return res.status(500).json(RestResult.error(i18n.t(req, "notifications.testFailed"), Helpers.getError(err)));
  }
};

export default { find, create, findById, update, delete: deleteChannel, test };
