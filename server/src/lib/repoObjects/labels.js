'use strict';
// The Labels type of the repository-backed objects (lib/repoObjects/engine.js) : the labels beside
// the header's logo, the entries of the labels: lists of a repository's files, in the config seed's
// format (an item of its labels section) : its text, colour, whether it is shown, and its place
// among the others (position), kept both ways : a label moved in the app rewrites the places.
import Label from "../../models/label.model.js";
import { seedType } from "./seedType.js";

export default seedType({
  key: "labels",
  section: "labels",
  model: "label",
  Model: Label,
  title: "Labels",
  noun: "label",
  // hidden is what a file says : shown is the default
  keepFalse: ["enabled"],
  order: "position",
});
