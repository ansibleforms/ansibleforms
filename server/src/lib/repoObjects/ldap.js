'use strict';
// The LDAP type of the repository-backed objects (lib/repoObjects/engine.js) : one LDAP directory
// per YAML file in a repository's `ldap` folder, in the config seed's format (its ldap section,
// with the directory's name, place and domains : lib/seed-schema.js ldapDirectoryItem). It names its
// ldap credential by name : a directory whose credential is not there yet waits, and is read again
// when the credentials are next pulled. Its bind password, if any, is an ${ENV} reference only.
// The main directory keeps its rules : it is never deleted nor renamed, so its file removed is
// refused while it is linked. The directories keep their lookup order (position).
import Ldap from "../../models/ldap.model.js";
import { DEFAULT_NAME } from "../ldapDirectories.js";
import { ldapDirectoryItem } from "../seed-schema.js";
import { seedType } from "./seedType.js";

// the directories are written as a save from the app writes them : the declared fields only,
// converted (Ldap.declared)
const LdapModel = {
  create: (d) => Ldap.create({ ...Ldap.declared(d), managed: 0 }),
  update: (d, id) => Ldap.updateById(id, Ldap.declared(d)),
  delete: (id) => Ldap.deleteById(id),
};

export default seedType({
  key: "ldap",
  folder: "ldap",
  section: ldapDirectoryItem,
  model: "ldap",
  Model: LdapModel,
  // read as the app reads them : every column, the bind password decrypted
  read: { all: () => Ldap.findAll(), byId: (id) => Ldap.findById(id) },
  title: "LDAP directories",
  noun: "LDAP directory",
  secrets: ["bind_user_pw"],
  references: [{ field: "credential", type: "credentials" }],
  undeletable: (row) => (row.name === DEFAULT_NAME ? `the directory '${DEFAULT_NAME}' is never deleted (turn it off instead)` : null),
  order: "position",
});
