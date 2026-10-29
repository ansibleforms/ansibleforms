'use strict';
// The Icon type of the repository-backed objects : Settings > Appearance > Icon under the icon: key
// of a repository's file - what that page saves, and only that : the website icon, an image file of
// the repository its map names relative to that file (the icon: key of its map, icon.svg), read
// and written as binary. One of the appearance types (lib/repoObjects/appearanceType.js), one key
// per page.
import { iconSection } from "../seed-schema.js";
import { appearanceType } from "./appearanceType.js";

export default appearanceType({
  key: "icon",
  section: iconSection,
  title: "Icon",
  noun: "icon",
  images: ["icon"],
});
