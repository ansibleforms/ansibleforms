'use strict';
// The Name type of the repository-backed objects : Settings > Appearance > Name in a repository's
// name.yaml - what that page saves, and only that : the app's name (app_name). One of the
// appearance types (lib/repoObjects/appearanceType.js), one file per page.
import { nameSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "name",
  file: "name.yaml",
  section: nameSection,
  title: "Name",
  noun: "name",
  rowFields: ["app_name"],
});
