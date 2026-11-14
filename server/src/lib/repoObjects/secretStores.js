'use strict';
// The Secret stores type of the repository-backed objects (lib/repoObjects/engine.js) : the secret
// stores of the secret_stores: lists of a repository's files, in the config seed's format (an item
// of its secret_stores section). It names the credential it logs in with (a Vault's token) by
// name : a store whose credential is not there yet waits, and is read again when the credentials
// are next pulled. Its own token and client key, if any, are ${ENV} references only.
import SecretStore from "../../models/secretStore.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "secret_stores",
  section: "secret_stores",
  model: "secretstore",
  Model: SecretStore,
  title: "Secret stores",
  noun: "secret store",
  // its own token, and a CyberArk client certificate's key
  secrets: ["token", "client_key"],
  // what it is besides its name : a rename changing one of them is another store
  identity: ["type", "url"],
  // the credential it logs in with, and a CyberArk store's PVWA API credential (its writes)
  references: [
    { field: "credential", type: "credentials" },
    { field: "pvwa_credential", type: "credentials" },
  ],
  // secret_stores.description has no default in the table
  defaults: { description: "" },
});
