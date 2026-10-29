'use strict';
// The Repositories type of the repository-backed objects (lib/repoObjects/engine.js) : the other
// repositories, the entries of the repositories: lists of a repository's files, in the config
// seed's format (its repositories section : name, uri, branch, description, credential
// by name, the use_for_* flags, the pull schedule ...), one repository at most holding it. A
// repository made from the file is cloned as one made in the app is, and takes the objects of its
// usages as if they were ticked (git wins, no question : the file is the decision).
//
// Its guard rails :
//   the holder    the repository holding the entries is never made, changed nor deleted by them : an
//                 entry of its name is not imported (said), and it is never written to its files
//   no chains     an entry never sets use_for_repositories on another repository : refused (said),
//                 its other fields applied
//   usages taken  a usage another repository holds already (one repository per type) : refused
//                 for that repository (said), its other usages applied
//   references    its credential by name : it waits while that credential is not there ; the
//                 credentials are read before the repositories, every other type after them
//   delete        an entry gone deletes its repository as the app's delete does (its objects
//                 unlinked, its working copy removed) - never the holder, never one with changes
//                 not pushed yet (refused, kept, said) ; no file giving repositories: at all
//                 unlinks them instead, kept in the app
//   the seed      a repository the config seed manages stays the seed's
//   secrets       a credential by name only : a password, or a user and token in its uri, refused
//   use_for_config  deprecated : applied as use_for_roles, use_for_categories and use_for_constants,
//                 said, as the config seed folds it
import mysql from "../../models/db.model.js";
import Repository from "../../models/repository.model.js";
import { seedType } from "./seedType.js";
import { ONE_ONLY_FLAGS, typeOfFlag, flagOn } from "./types.js";
import { foldConfigItem } from "../seed-schema.js";
import { uriCarriesSecret } from "./secrets.js";

// the repositories as the app saves them, by their name (the model works by name)
const RepositoryModel = {
  create: (d, opts) => Repository.create(d, opts),
  update: async (d, id, opts) => Repository.update(d, (await Repository.findById(id)).name, opts),
  delete: async (id, opts) => Repository.delete((await Repository.findById(id)).name, opts),
};

export default seedType({
  key: "repositories",
  section: "repositories",
  // no file giving repositories: at all : they stay in the app, unlinked - never each one deleted
  noKeyUnlinks: true,
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
    ...(uriCarriesSecret(o.uri) ? ["uri must not carry a user or a token: give the repository's credential by name"] : []),
  ],
  // the holder itself : never its own entries'
  notImported: (o, holder) => (holder && o.name === holder ? "the repository holding this file" : null),
  // the holder : by its flag, or by its name before the flag is saved (the question asked first) ;
  // one whose uri carries a user or a token : its secret never goes to git
  keptReason: (row, holder) => (Number(row.use_for_repositories) || (holder && row.name === holder) ? "holder" : uriCarriesSecret(row.uri) ? "uriSecret" : null),
  // no chains, and no usage another repository holds
  adjust: async (o) => {
    // use_for_config (deprecated since 7.5.0, removed in 8) : the three flags it is now, as the
    // config seed folds it - the one-repository rule below applies to them
    const out = { ...foldConfigItem(o) };
    const notes = [];
    if (o.use_for_config !== undefined) {
      notes.push("use_for_config is deprecated since 7.5.0 and removed in 8: applied as use_for_roles, use_for_categories and use_for_constants, declare those instead");
    }
    if (flagOn(out.use_for_repositories)) {
      delete out.use_for_repositories;
      notes.push("use_for_repositories refused: a repository listed under repositories: cannot hold repositories itself");
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
