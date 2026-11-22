'use strict';
// The Credentials type of the repository-backed objects (lib/repoObjects/engine.js) : the entries of
// the credentials: lists of a repository's files, each in the config seed's format (an item of its
// credentials section). Its secrets - the password (a token, a client secret), a client
// certificate's private key (an ssh one's) and its passphrase - are never plain in git : ${ENV} references only, and an app
// credential is written without them, kept in the database. A credential's entry removed while
// a runner, a repository, a secret store, a channel or a sign-in still uses it is refused.
import Credential from "../../models/credential.model.v2.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "credentials",
  section: "credentials",
  model: "credential",
  Model: Credential,
  title: "Credentials",
  noun: "credential",
  // the password (or the token, the client secret it stands for), a client certificate's key (an
  // ssh one's private key) and that key's passphrase
  secrets: ["password", "client_key", "key_passphrase"],
  // what it is besides its name : a rename changing one of them is another credential
  identity: ["credential_type", "host", "user"],
  // is_database follows its type ; vault_path is deprecated (secret_store and secret_ref)
  skip: ["is_database", "vault_path"],
  // credentials.description has no default in the table
  defaults: { description: "" },
  usersOf: (row) => Credential.usersOf(row.name),
});
