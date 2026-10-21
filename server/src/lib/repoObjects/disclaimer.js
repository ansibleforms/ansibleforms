'use strict';
// The Disclaimer type of the repository-backed objects (lib/repoObjects/engine.js) : one disclaimer
// version per YAML file in a repository's `disclaimer` folder, in the config seed's format (an item
// of its disclaimer section) : its number (version, what it is found by), title, text, checkbox
// label, and whether it is the one in force (enabled : the disclaimer on, this version asked ; one
// at most). A changed title, text or label arriving from git is a correction of that version, as
// the app's save makes one ; with `ask_again: true` in its file, everyone who accepted it is asked
// again, as the app's "Ask everyone again" does. Who accepted what is the app's alone, never in git.
import Disclaimer from "../../models/disclaimer.model.js";
import { disclaimerItem } from "../seed-schema.js";
import { seedType } from "./seedType.js";

/**
 * A version as the files and the engine know it : named after its number.
 *
 * Args:
 *   o (object): the version.
 *
 * Returns:
 *   object: the version, its name its number.
 */
const named = (o) => (o && o.version !== undefined ? { ...o, name: String(o.version) } : o);

/**
 * A version as it is compared and written : named after its number, its words as the model stores
 * them (Disclaimer.cleanWords : a text ending on a line break is the stored text), the file's and
 * the seed's alike - never a correction, nor everyone asked again, on every read.
 *
 * Args:
 *   o (object): the version.
 *
 * Returns:
 *   object: the version.
 */
const canonical = (o) => (o ? named(Disclaimer.cleanWords(o)) : o);

// written as the disclaimer page saves them
const DisclaimerModel = {
  create: async (d) => {
    const version = await Disclaimer.createVersion(d, "repository");
    if (d.enabled) await Disclaimer.enableVersion(version, true, "repository");
    return version;
  },
  update: async (d, version) => {
    const current = await Disclaimer.version(version);
    const words = ["title", "text", "checkbox_label"];
    // a correction of its words, everyone asked again when the file says so
    if (words.some((k) => d[k] !== undefined && d[k] !== current[k])) {
      await Disclaimer.updateVersion(version, { ...Object.fromEntries(words.map((k) => [k, d[k] ?? current[k]])), askAgain: !!d.ask_again });
    }
    if (d.enabled !== undefined && !!d.enabled !== !!Number(current.enabled)) await Disclaimer.enableVersion(version, !!d.enabled, "repository");
  },
  delete: (version) => Disclaimer.deleteVersion(version),
};

export default seedType({
  key: "disclaimer",
  folder: "disclaimer",
  section: disclaimerItem,
  model: "disclaimer",
  table: "AnsibleForms.`disclaimer_versions`",
  idColumn: "version",
  nameColumn: "version",
  Model: DisclaimerModel,
  read: {
    all: async () => (await Disclaimer.versions()).map(named),
    byId: async (version) => named(await Disclaimer.version(version).catch(() => null)),
  },
  title: "Disclaimer versions",
  noun: "disclaimer version",
  // how a changed text is applied : never a field of the version, never written back
  skip: ["ask_again"],
  notCompared: ["ask_again"],
  canonical,
  order: "version",
});
