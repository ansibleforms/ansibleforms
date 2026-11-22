'use strict';
// The Notifications type of the repository-backed objects (lib/repoObjects/engine.js) : the
// notification channels of the notifications: lists of a repository's files, in the config seed's
// format (an item of its notification_channels section). A mail channel names its smtp credential,
// a webhook or a telegram one the credential of its token, by name : a channel whose credential is
// not there yet waits, and is read again when the credentials are next pulled. A Slack or Teams
// webhook address carries its secret : an ${ENV} reference only.
import NotificationChannel from "../../models/notificationChannel.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "notifications",
  section: "notification_channels",
  model: "notificationchannel",
  Model: NotificationChannel,
  title: "Notifications",
  noun: "notification channel",
  // a Slack or Teams incoming webhook's address is its secret
  secrets: ["webhook_url"],
  // what it is besides its name : a rename changing it is another channel
  identity: ["type"],
  references: [
    { field: "credential", type: "credentials" },
    { field: "token_credential", type: "credentials" },
  ],
  // turned off is what a file says : on is the default (a webhook's certificate checked too)
  keepFalse: ["enabled", "verify_tls"],
  // one active mail channel
  oneOnly: [{ field: "is_active", label: "the active mail channel", when: (o) => o.type === "mail" }],
  // notification_channels.description has no default in the table
  defaults: { description: "" },
});
