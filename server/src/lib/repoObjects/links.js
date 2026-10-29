'use strict';
// The Links type of the repository-backed objects : Settings > Appearance > Links in a repository's
// links.yaml - the header's own links (header_links : label, url, icon, newTab, id, parent each) and
// whether the Designer's shows (show_designer). One of the appearance types
// (lib/repoObjects/appearanceType.js), one file per page, as the defaults (defaults.yaml).
import { linksSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "links",
  file: "links.yaml",
  section: linksSection,
  title: "Links",
  noun: "links",
  rowFields: ["header_links"],
  envFields: ["show_designer"],
  // the Designer's link hidden is what a file says : shown is the default
  keepFalse: ["show_designer"],
});
