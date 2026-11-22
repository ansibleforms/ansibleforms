'use strict';
// The Syslog type of the repository-backed objects (lib/repoObjects/engine.js) : the syslog servers
// of the syslog: lists of a repository's files, in the config seed's format (an item of its
// syslog_servers section) : where the server log and the audit entries are sent.
import SyslogServer from "../../models/syslogServer.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "syslog",
  section: "syslog_servers",
  model: "syslogserver",
  Model: SyslogServer,
  title: "Syslog servers",
  noun: "syslog server",
  // turned off is what a file says : on is the default
  keepFalse: ["enabled"],
  // syslog_servers.description has no default in the table ; its message format, none given, is
  // the one its model gives a new server
  defaults: { description: "", type: "BSD" },
});
