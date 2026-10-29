'use strict';
// The Icon type of the repository-backed objects : Settings > Appearance > Icon in a repository's
// icon.yaml - what that page saves, and only that : the website icon, an image file beside it the
// YAML names (icon: icon.svg), read and written as binary. One of the appearance types
// (lib/repoObjects/appearanceType.js), one file per page.
import { iconSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "icon",
  file: "icon.yaml",
  section: iconSection,
  title: "Icon",
  noun: "icon",
  images: ["icon"],
});
