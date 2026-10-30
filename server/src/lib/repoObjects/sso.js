'use strict';
// The SSO type of the repository-backed objects (lib/repoObjects/engine.js) : the SSO providers of
// the sso: lists of a repository's files, in the config seed's format (an item of its oauth2
// section, by name). It names its credential (its client) by name : a provider whose credential is
// not there yet waits, and is read again when the credentials are next pulled. Its own client
// secret, if any, is an ${ENV} reference only ; a provider of the app is written without it, kept
// in the database. Used for sign-in is what its entry says (enable: true) : one that leaves it out is
// not, as the config seed's oauth2 items - an entry never takes sign-in over by leaving a field out.
// Its type is provider: entraid for Microsoft Entra ID, stored azuread (its name of before, the
// sign-in's and the API's) : read so, and written so by the app ; provider: azuread is still read,
// deprecated, said in the pull output.
import OAuth2 from "../../models/oauth2.model.js";
import { ssoProviderItem, OAUTH2_VALUES } from "../seed-schema.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "sso",
  section: ssoProviderItem,
  model: "oauth2",
  Model: OAuth2,
  title: "SSO providers",
  noun: "SSO provider",
  secrets: ["client_secret"],
  // entraid in a file, azuread stored (azuread in a file : deprecated, read the same)
  values: OAUTH2_VALUES,
  references: [{ field: "credential", type: "credentials" }],
  // one provider of a type used for sign-in ; one provider of all the login page skips to (the
  // model turns it off on every other provider on save, whatever their type)
  oneOnly: [
    { field: "enable", label: "used for sign-in", by: "provider" },
    { field: "auto_login", label: "the provider the login page skips to" },
  ],
});
