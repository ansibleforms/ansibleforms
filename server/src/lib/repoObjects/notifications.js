'use strict';
// The Notifications type of the repository-backed objects (lib/repoObjects/engine.js) : one
// notification channel per YAML file in a repository's `notifications` folder, in the config seed's
// format (an item of its notification_channels section). A mail channel names its smtp credential,
// a webhook or a telegram one the credential of its token, by name : a channel whose credential is
// not there yet waits, and is read again when the credentials are next pulled. A Slack or Teams
// webhook address carries its secret : an ${ENV} reference only.
import NotificationChannel from "../../models/notificationChannel.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "notifications",
  folder: "notifications",
  section: "notification_channels",
  model: "notificationchannel",
  Model: NotificationChannel,
  title: "Notifications",
  noun: "notification channel",
  // a Slack or Teams incoming webhook's address is its secret
  secrets: ["webhook_url"],
  references: [
    { field: "credential", type: "credentials" },
    { field: "token_credential", type: "credentials" },
  ],
  // turned off is what a file says : on is the default
  keepFalse: ["enabled"],
  // notification_channels.description has no default in the table
  defaults: { description: "" },
});
