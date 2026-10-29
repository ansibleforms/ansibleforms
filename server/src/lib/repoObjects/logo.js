'use strict';
// The Logo type of the repository-backed objects : Settings > Appearance > Logo in a repository's
// logo.yaml - what that page saves, and only that : the logo, an image file beside it the YAML
// names (logo: logo.png), read and written as binary. One of the appearance types
// (lib/repoObjects/appearanceType.js), one file per page.
import { logoSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "logo",
  file: "logo.yaml",
  section: logoSection,
  title: "Logo",
  noun: "logo",
  images: ["logo"],
});
