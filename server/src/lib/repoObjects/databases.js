'use strict';
// The Databases type of the repository-backed objects (lib/repoObjects/engine.js) : the databases
// forms query (Connections > Databases), the entries of the controller_databases: lists of a
// repository's files, in the config seed's format (an item of its databases section) : its name,
// what it is and the credential it connects with. It names its credential by name, one of type
// database : a database whose credential is not there yet waits, and is read again when the
// credentials are next pulled. A database holds no secret and no address : its engine, server,
// database and login are its credential's (models/database.model.js).
import Database from "../../models/database.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "databases",
  section: "databases",
  model: "database",
  Model: Database,
  title: "Databases",
  noun: "database",
  // none of its own : its login is its credential's
  secrets: [],
  // what it is besides its name : a rename changing it is another database
  identity: ["credential"],
  references: [{ field: "credential", type: "credentials" }],
  // databases.description has no default in the table
  defaults: { description: "" },
});
