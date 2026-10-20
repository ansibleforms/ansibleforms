'use strict';
// The Branding type of the repository-backed objects : Settings > Appearance's Defaults, Name, Logo
// and Icon in a repository's branding.yaml - the app's name, the defaults (theme, colour, forms
// view, time zone, date format, language) and the logo and the website icon as image files beside
// it (logo.png, icon.svg). One of the appearance types (lib/repoObjects/appearanceType.js), as the
// header's links (links.yaml).
import { brandingSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "branding",
  file: "branding.yaml",
  section: brandingSection,
  title: "Branding",
  noun: "branding",
  rowFields: ["app_name", "default_theme", "default_theme_color", "forms_view", "default_timezone", "default_date_format"],
  envFields: ["default_language"],
  images: ["logo", "icon"],
});
