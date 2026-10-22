'use strict';
// The Runners type of the repository-backed objects (lib/repoObjects/engine.js) : one runner per
// YAML file in a repository's `runners` folder, in the config seed's format (an item of its runners
// section) : its type, address, mode, the RTE settings, whether it is the default and enabled. It
// names its credential by name : a runner whose credential is not there yet waits, and is read
// again when the credentials are next pulled. Its own token or password, if any, is an ${ENV}
// reference only. What runs on it (its socket, its node, a join waiting for approval) stays in the
// database : a runner its RTE registered, or one waiting for approval, stays in the app.
import Runner from "../../models/runner.model.js";
import Credential from "../../models/credential.model.v2.js";
import { stripTrailingSlashes } from "../url.js";
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
  // one default runner per type
  oneOnly: [{ field: "is_default", label: "the default", by: "type" }],
  // runners.description has no default in the table
  defaults: { description: "" },
  keptReason: (row) => (Number(row.pending) ? "pending" : row.node_id ? "registered" : null),
  // its address as its model keeps it (no slash at its end), the file's and the app's alike
  canonical: (o) => (typeof o.uri === "string" ? { ...o, uri: stripTrailingSlashes(o.uri.trim()) } : o),
  // a credential that carries the address : the one place for it, as the model keeps it - the
  // runner's own address and TLS taken out, said
  adjust: async (o) => {
    const own = ["uri", "ignore_certs", "ca_bundle"].filter((k) => o[k] !== undefined && o[k] !== "" && o[k] !== null);
    if (!own.length || !(await Credential.connectionOf(o.credential).catch(() => null))) return { object: o, notes: [] };
    const object = { ...o, uri: "", ignore_certs: false, ca_bundle: null };
    return { object, notes: [`${own.join(", ")} not used: its credential '${o.credential}' gives its address, declare it there`] };
  },
});
