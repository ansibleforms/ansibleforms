'use strict';
// The descriptor of an object type whose entries are in the config seed's format (lib/seed-schema.js)
// - the credentials, the runners, and the types of the later versions : each entry of its list in a
// repository's files (a "- " item under credentials:) one item of the seed's section, so a seed item and a
// repository entry are interchangeable. Read and checked as
// the seed checks its items, ${ENV} references resolved as the seed resolves them (the secret rule,
// lib/repoObjects/secrets.js), compared with the row as the seed compares (lib/seedCompare.js), and
// written through the type's model, as a save from the app.
//
// A type says only what is its own : its section, its model, its secret fields, what it names, the
// fields its entries leave out, and why an object of the app stays in the app.
import mysql from "../../models/db.model.js";
import CrudModel from "../../models/crud.model.js";
import { differs } from "../seedCompare.js";
import { fieldSet } from "./fields.js";
import { linkStore, classifyRow, columnDefaults, nameKey } from "./engine.js";
import { typeOf } from "./types.js";

/**
 * An object without some of its fields.
 *
 * Args:
 *   obj (object): the object.
 *   keys (string[]): the fields left out ; none : the object as it is.
 *
 * Returns:
 *   object: a copy without them.
 */
const omit = (obj, keys = []) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/**
 * A name not taken yet : the name, else the name with the first free suffix (Name (2), Name (3)
 * ...), recorded as taken.
 *
 * Args:
 *   name (string): the name wanted.
 *   taken (Set<string>|null): the names taken, as nameKey keys them ; none : the name as it is.
 *
 * Returns:
 *   string: the name.
 */
function uniqueName(name, taken) {
  if (!taken) return name;
  let unique = name;
  for (let n = 2; taken.has(nameKey(unique)); n++) unique = `${name} (${n})`;
  taken.add(nameKey(unique));
  return unique;
}

// what a repository's write tells the models : not a request's, nor the seed's
export const FROM_REPO = { fromRepo: true };

// why an object of the app stays in the app, by its code (the client says it in its language)
export const KEPT_REASONS = {
  seed: "managed by the config seed",
  registered: "registered by its RTE",
  pending: "waiting for approval",
  holder: "it holds the repositories itself, never in its own file",
  uriSecret: "its uri carries a user or a token: give it a credential instead",
};

/**
 * The descriptor of a seed-format object type.
 *
 * Args:
 *   spec (object):
 *     key (string): the type (credentials).
 *     section (string|object): its section of the seed (credentials), or its item's own schema
 *       (an LDAP directory's, lib/seed-schema.js ldapDirectoryItem).
 *     model (string): its crud model (credential).
 *     Model (class): its model, which writes a row (create, update, delete), as the app saves it.
 *     title, noun (string): how the pull output names it (Credentials, credential).
 *     secrets (string[]): its secret fields, never plain in git.
 *     references (object[]): what its objects name : [{ field, type }].
 *     skip (string[]): the fields its files leave out (one that follows another, a deprecated one).
 *     keepFalse (string[]): the yes or no fields written when off (on is their default) ; the
 *       others only when on.
 *     keptReason (function): (row, holder) => why an object of the app stays in the app (a code of
 *       KEPT_REASONS), or null ; holder is the repository that would take it.
 *     usersOf (function): (row) => Promise<string[]> - what uses an object : its file removed while
 *       one does is refused.
 *     defaults (object): the values a new row is made with when its file leaves them out.
 *     read (object): { all, byId } - how its rows are read when its model does not read them
 *       through the crud model (the LDAP directories) ; decrypted, as the seed compares them.
 *     undeletable (function): (row) => why an object can never be deleted (the main LDAP
 *       directory), or null : its file removed is refused with that reason.
 *     order (string): its field of a place in an order (a label's, a directory's position) : the
 *       app's objects are written in that order, and a move in the app rewrites the places.
 *     table (string): its table, when its model is no crud model (the announcements) ; idColumn
 *       (string) the column its rows are found by ('id' when not said : a disclaimer's version).
 *     canonical (function): (object) => the object as it is compared and written (a moment as an
 *       ISO text), the file's and the app's alike.
 *     nameFor (function): (row) => the name an object of the app without one is written with (an
 *       announcement : the start of its message) ; it keeps that name from then on.
 *     nameColumn (string): the column its name is in ('name' when not said : a disclaimer's is its
 *       version).
 *     notImported (function): (object) => why a file's object is not imported (an announcement already
 *       ended), or null : said in the pull output, never refused ; the app's object of it goes.
 *     noKeyUnlinks (boolean): no file of the repository holding its key at all : its objects
 *       unlinked and kept in the app, never deleted (the repositories : each one deleted would lose
 *       its working copy) ; otherwise each one goes, as any entry gone.
 *     validate (function): (object) => what the type refuses of an object besides the schema (a
 *       secret in an address) : string[].
 *     adjust (function): async (object, repository) => { object, notes } - what a file's object
 *       may not set taken out before it is saved, each said (a usage another repository holds).
 *     notCompared (string[]): the fields a file gives that are no field of the object (a
 *       disclaimer's ask_again : how a changed text is applied) : never compared.
 *     renameRefused (string): why its objects never change their name (a disclaimer version keeps
 *       its number) : an entry renamed in its file is refused with it, its object kept.
 *     identity (string[]): the fields that tell what an object is besides its name (a credential's
 *       type, host and user) : an entry renamed in its file whose identity changed too is another
 *       object, never the rename of the one gone (its secrets never handed to it).
 *     oneOnly (object[]): the yes or no fields one object at most has on (lib/repoObjects/engine.js
 *       oneOnlyClashes) : [{ field, label (what it makes the object : the default), by (the field
 *       each one is per : a runner's type), when ((object) => whether the rule is the object's) }].
 *
 * Returns:
 *   object: the descriptor (lib/repoObjects/engine.js).
 */
export function seedType(spec) {
  const { key, model, Model, secrets = [], references = [], keptReason = () => null, defaults = {} } = spec;
  // its rows, decrypted : through the crud model, unless the type reads them its own way
  const read = spec.read || { all: () => CrudModel.findAll(model), byId: (id) => CrudModel.findById(model, id) };
  // the app's objects in their order : by their place when they have one, else by name
  const byOrder = (a, b) => (spec.order ? Number(a[spec.order] ?? 0) - Number(b[spec.order] ?? 0) : 0) || String(a.name).localeCompare(String(b.name));
  const fields = fieldSet(spec);
  const table = spec.table || CrudModel.getConfig(model).table;
  const links = linkStore(table, spec.idColumn || "id");
  // changed : compared as the seed compares, on the canonical object
  const canonical = spec.canonical || ((o) => o);
  // a checked object's other rules (spec.validate) : refused when it breaks one
  const withRules = (checked) => {
    const errors = checked.object && spec.validate ? spec.validate(checked.object) : [];
    return errors.length ? { errors, object: null } : checked;
  };

  return {
    key,
    flag: typeOf(key).flag,
    model,
    title: spec.title,
    noun: spec.noun,
    secrets,
    references,
    keyOrder: fields.keys,
    // the field an entry names its object by (a disclaimer version's number) : what it is found by,
    // and the name a refused entry declares (lib/repoObjects/engine.js declaredName)
    nameField: spec.nameColumn || "name",
    noKeyUnlinks: !!spec.noKeyUnlinks,
    // an object as the seed (or an entry) declares it, checked (lib/repoObjects/fields.js), then
    // what the type refuses besides
    check: (raw, opts) => withRules(fields.check(raw, opts)),
    // an entry of a file : checked, state: absent holding no object
    parseEntry: (raw) => {
      const parsed = fields.read(raw);
      return parsed.object ? { ...parsed, ...withRules(parsed) } : parsed;
    },
    adjust: spec.adjust,

    store: {
      ...links,
      // decrypted, as the seed compares them
      rows: () => read.all(),
      names: async () => ((await mysql.do(`SELECT ${spec.nameColumn || "name"} AS name FROM ${table}`)) || []).map((r) => String(r.name ?? "")).filter(Boolean),
      byId: (id) => read.byId(id),
      // an object of the app is taken over by a file of its name, unless the config seed manages it
      // or it stays in the app for a reason of its own
      classify: (row, name) => {
        const code = row.managed ? "seed" : keptReason(row, name);
        return classifyRow(row, name, code ? `an object of this app (${KEPT_REASONS[code] || code})` : null);
      },
      changed: (row, obj) => differs(omit(obj, spec.notCompared), canonical({ ...row })),
      // the fields its file no longer declares : the value a new object made from the file gets -
      // the type's default, else its column's, else a yes or no off (on for one written when off),
      // else empty where the column allows it
      removed: async (row, obj) => {
        const columns = await columnDefaults(table);
        return fields.removedOf({ ...row }, obj, (k) => {
          if (defaults[k] !== undefined) return defaults[k];
          const column = columns.get(k);
          if (column?.value !== null && column?.value !== undefined) return column.value;
          if (fields.booleans.has(k)) return (spec.keepFalse || []).includes(k);
          if (!column || column.nullable) return null;
          return fields.strings.has(k) ? "" : undefined;
        });
      },
      insert: async (obj, name, file) => {
        const id = await Model.create({ ...defaults, ...obj }, FROM_REPO);
        if (name) await links.link(id, name, file);
        CrudModel.changed(model);
        return id;
      },
      update: (row, obj) => Model.update({ ...obj }, row.id, FROM_REPO),
      adopt: async (row, obj, name, file) => {
        await Model.update({ ...obj }, row.id, FROM_REPO);
        await links.link(row.id, name, file);
      },
      remove: (row) => Model.delete(row.id, FROM_REPO),
      // the app's own : no repository
      appRows: async () => ((await read.all()) || []).filter((r) => !r.repository).sort(byOrder),
    },

    /**
     * An object of the app as a repository would take it : its entry's fields (without its
     * secrets), or why it stays in the app. One without a name (an announcement made in the app)
     * is written with the one nameFor gives it, made unique among the names taken (a suffix : the
     * second "Planned maintenance" is "Planned maintenance (2)") - a pull finds each by its name.
     *
     * Args:
     *   row (object): the row.
     *   holder (string|null): the repository that would take it.
     *   taken (Set<string>|null): the names taken, as nameKey keys them (the type's, and those
     *     given meanwhile) ; the name given is added to it.
     *
     * Returns:
     *   object: { row, object, withoutSecret, named } or { row, code, reason }.
     */
    candidateOf(row, holder = null, taken = null) {
      const code = row.managed ? "seed" : keptReason(row, holder);
      if (code) return { row, code, reason: KEPT_REASONS[code] || code };
      const named = !row.name && spec.nameFor ? { ...row, name: uniqueName(spec.nameFor(row), taken) } : row;
      return { row: named, named: named !== row, ...fields.toFile(named) };
    },

    // its new entry : its fields, in the seed's order
    entryOf: (c) => c.object,
    // linked to its file ; a name given for its entry kept by the object too
    linkCandidate: async (c, name, file) => {
      await links.link(c.row.id, name, file);
      if (c.named) await Model.update({ name: c.row.name }, c.row.id, FROM_REPO);
    },

    // an app edit : only the fields it changed, written into its entry (lib/repoObjects/fields.js
    // editsOf)
    entryEdits: (row, before) => fields.editsOf(row, before),

    usersOf: spec.usersOf,
    renameRefused: spec.renameRefused,
    identity: spec.identity || [],
    undeletable: spec.undeletable,
    notImported: spec.notImported,
    canonical,
    order: spec.order,
    oneOnly: spec.oneOnly,
  };
}
