'use strict';
// The Runners type of the repository-backed objects (lib/repoObjects/engine.js) : one runner per
// YAML file in a repository's `runners` folder, in the config seed's format (an item of its runners
// section) : its type, address, mode, the RTE settings, whether it is the default and enabled. It
// names its credential by name : a runner whose credential is not there yet waits, and is read
// again when the credentials are next pulled. Its own token or password, if any, is an ${ENV}
// reference only. What runs on it (its socket, its node, a join waiting for approval) stays in the
// database : a runner its RTE registered, or one waiting for approval, stays in the app.
import Runner from "../../models/runner.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "runners",
  section: "runners",
  model: "runner",
  Model: Runner,
  title: "Runners",
  noun: "runner",
  // its own secrets, deprecated in favour of its credential
  secrets: ["token", "password"],
  references: [{ field: "credential", type: "credentials" }],
  // turned off is what a file says : on is the default
  keepFalse: ["enabled"],
  // runners.description has no default in the table
  defaults: { description: "" },
  keptReason: (row) => (Number(row.pending) ? "pending" : row.node_id ? "registered" : null),
});
