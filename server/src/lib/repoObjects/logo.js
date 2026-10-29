'use strict';
// The Logo type of the repository-backed objects : Settings > Appearance > Logo under the logo: key
// of a repository's file - what that page saves, and only that : the logo, an image file of the
// repository its map names relative to that file (the logo: key of its map, logo.png), read and
// written as binary. One of the appearance types (lib/repoObjects/appearanceType.js), one key per
// page.
import { logoSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "logo",
  section: logoSection,
  title: "Logo",
  noun: "logo",
  images: ["logo"],
});
