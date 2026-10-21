'use strict';
// The Repositories type of the repository-backed objects (lib/repoObjects/engine.js, its list mode)
// : the other repositories in a repository's repositories.yaml, a `repositories:` list of items in
// the config seed's format (its repositories section : name, uri, branch, description, credential
// by name, the use_for_* flags, the pull schedule ...), one repository at most holding it. A
// repository made from the file is cloned as one made in the app is, and takes the objects of its
// usages as if they were ticked (git wins, no question : the file is the decision).
//
// Its guard rails :
//   the holder    the repository holding the file is never made, changed nor deleted by it : an
//                 entry of its name is not imported (said), and it is never written to the file
//   no chains     a file never sets use_for_repositories on another repository : refused (said),
//                 its other fields applied
//   usages taken  a usage another repository holds already (one repository per type) : refused
//                 for that repository (said), its other usages applied
//   references    its credential by name : it waits while that credential is not there ; the
//                 credentials are read before the repositories, every other type after them
//   delete        an entry gone deletes its repository as the app's delete does (its objects
//                 unlinked, its working copy removed) - never the holder, never one with changes
//                 not pushed yet (refused, kept, said)
//   the seed      a repository the config seed manages stays the seed's
//   secrets       a credential by name only : a password, or a user and token in its uri, refused
import mysql from "../../models/db.model.js";
import Repository from "../../models/repository.model.js";
import { seedType } from "./seedType.js";
import { ONE_ONLY_FLAGS, typeOfFlag, flagOn } from "./types.js";

// the repositories as the app saves them, by their name (the model works by name)
const RepositoryModel = {
  create: (d, opts) => Repository.create(d, opts),
  update: async (d, id, opts) => Repository.update(d, (await Repository.findById(id)).name, opts),
  delete: async (id, opts) => Repository.delete((await Repository.findById(id)).name, opts),
};

// a user and a secret, or any user of an http address : a secret in the uri
const SECRET_IN_URI = /^https?:\/\/[^/@\s]+@|:\/\/[^/@:\s]+:[^/@\s]+@/i;

export default seedType({
  key: "repositories",
  section: "repositories",
  listFile: "repositories.yaml",
  listKey: "repositories",
  model: "repositories",
  Model: RepositoryModel,
  title: "Repositories",
  noun: "repository",
  references: [{ field: "credential", type: "credentials" }],
  // its own login of before and the deprecated alias : never in the file
  skip: ["user", "password", "use_for_config"],
  defaults: { description: "" },
  // a credential by name only
  validate: (o) => [
    ...(o.password !== undefined || o.user !== undefined ? ["user and password are refused: give the repository's credential by name"] : []),
    ...(SECRET_IN_URI.test(String(o.uri || "")) ? ["uri must not carry a user or a token: give the repository's credential by name"] : []),
  ],
  // the holder itself : never its own file's
  notImported: (o, holder) => (holder && o.name === holder ? "the repository holding this file" : null),
  // the holder : by its flag, or by its name before the flag is saved (the question asked first)
  keptReason: (row, holder) => (Number(row.use_for_repositories) || (holder && row.name === holder) ? "holder" : null),
  // no chains, and no usage another repository holds
  adjust: async (o) => {
    const out = { ...o };
    const notes = [];
    if (flagOn(out.use_for_repositories)) {
      delete out.use_for_repositories;
      notes.push("use_for_repositories refused: a repository of repositories.yaml cannot hold repositories itself");
    }
    for (const flag of ONE_ONLY_FLAGS) {
      if (!flagOn(out[flag])) continue;
      const rows = await mysql.do(`SELECT name FROM AnsibleForms.\`repositories\` WHERE ${flag} AND name <> ?`, [out.name]);
      if (!rows?.length) continue;
      delete out[flag];
      notes.push(`${flag} refused: repository '${rows[0].name}' holds the ${typeOfFlag(flag).label} already`);
    }
    return { object: out, notes };
  },
  // never the holder, never one with changes not pushed yet
  undeletable: async (row) => {
    if (Number(row.use_for_repositories)) return `'${row.name}' holds the repositories itself`;
    const [state] = await Repository.withUnpushed([{ name: row.name }]).catch(() => [{}]);
    return state?.unpushed ? `'${row.name}' has changes not pushed yet (push or reset it first)` : null;
  },
});
