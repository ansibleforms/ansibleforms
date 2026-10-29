'use strict';
// The General type of the repository-backed objects (lib/repoObjects/envType.js) : the System >
// General settings under the general: key of a repository's file, keyed by their environment variable names -
// the variables that page itself changes, never one another page or the deployment owns
// (lib/envSettings.js OWNED_ELSEWHERE), a refused one, one set in the real environment, nor one a
// repository may never set (a command the server runs, the database, a path ... : lib/envSave.js
// REPOSITORY_REFUSED), which the page alone changes. What
// the app writes to it : the variables saved from the page.
import { envType } from "./envType.js";

export default envType({
  key: "general",
  title: "General",
  noun: "general settings",
  page: "Settings > System > General",
});
