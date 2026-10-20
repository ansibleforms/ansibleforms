'use strict';
// The SSO type of the repository-backed objects (lib/repoObjects/engine.js) : one SSO provider per
// YAML file in a repository's `sso` folder, in the config seed's format (an item of its oauth2
// section, by name). It names its credential (its client) by name : a provider whose credential is
// not there yet waits, and is read again when the credentials are next pulled. Its own client
// secret, if any, is an ${ENV} reference only ; a provider of the app is written without it, kept
// in the database.
import OAuth2 from "../../models/oauth2.model.js";
import { ssoProviderItem } from "../seed-schema.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "sso",
  folder: "sso",
  section: ssoProviderItem,
  model: "oauth2",
  Model: OAuth2,
  title: "SSO providers",
  noun: "SSO provider",
  secrets: ["client_secret"],
  references: [{ field: "credential", type: "credentials" }],
  // turned off (not used for sign-in) is what a file says
  keepFalse: ["enable"],
});
