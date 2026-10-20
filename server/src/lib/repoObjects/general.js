'use strict';
// The General type of the repository-backed objects (lib/repoObjects/envType.js) : the System >
// General settings in a repository's general.yaml, keyed by their environment variable names -
// the variables that page itself changes, never one another page or the deployment owns
// (lib/envSettings.js OWNED_ELSEWHERE), a refused one, nor one set in the real environment. What
// the app writes to it : the variables saved from the page.
import { envType } from "./envType.js";

export default envType({
  key: "general",
  file: "general.yaml",
  title: "General",
  noun: "general settings",
  page: "Settings > System > General",
});
