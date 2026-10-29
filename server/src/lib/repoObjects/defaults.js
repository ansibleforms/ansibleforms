'use strict';
// The Defaults type of the repository-backed objects : Settings > Appearance > Defaults under the
// defaults: key of a repository's file - what that page saves, and only that : the theme and its colour, the
// forms view, the time zone, the date format (the settings row) and the language (an environment
// setting). One of the appearance types (lib/repoObjects/appearanceType.js), one key per page.
import { defaultsSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "defaults",
  section: defaultsSection,
  title: "Defaults",
  noun: "defaults",
  rowFields: ["default_theme", "default_theme_color", "forms_view", "default_timezone", "default_date_format"],
  envFields: ["default_language"],
});
