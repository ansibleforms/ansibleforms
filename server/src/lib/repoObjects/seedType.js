'use strict';
// The descriptor of an object type whose files are in the config seed's format (lib/seed-schema.js)
// - the credentials, the runners, and the types of the later versions : one item of the seed's
// section per file, so a seed item and a repository file are interchangeable. Read and checked as
// the seed checks its items, ${ENV} references resolved as the seed resolves them (the secret rule,
// lib/repoObjects/secrets.js), compared with the row as the seed compares (lib/seedCompare.js), and
// written through the type's model, as a save from the app.
//
// A type says only what is its own : its section, its model, its secret fields, what it names, the
// fields its files leave out, and why an object of the app stays in the app.
import mysql from "../../models/db.model.js";
import CrudModel from "../../models/crud.model.js";
import { itemValidator } from "../seed-schema.js";
import { differs } from "../seedCompare.js";
import { parseMapFile, newMapFile, updateMapFile, same } from "./yamlFile.js";
import { resolveSecrets, withoutSecrets, given } from "./secrets.js";
import { linkStore, classifyRow } from "./engine.js";
import { typeOf } from "./types.js";

// what a repository's write tells the models : not a request's, nor the seed's
export const FROM_REPO = { fromRepo: true };

// why an object of the app stays in the app, by its code (the client says it in its language)
export const KEPT_REASONS = {
  seed: "managed by the config seed",
  registered: "registered by its RTE",
  pending: "waiting for approval",
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
 *     keptReason (function): (row) => why an object of the app stays in the app (a code of
 *       KEPT_REASONS), or null.
 *     usersOf (function): (row) => Promise<string[]> - what uses an object : its file removed while
 *       one does is refused.
 *     defaults (object): the values a new row is made with when its file leaves them out.
 *     read (object): { all, byId } - how its rows are read when its model does not read them
 *       through the crud model (the LDAP directories) ; decrypted, as the seed compares them.
 *     undeletable (function): (row) => why an object can never be deleted (the main LDAP
 *       directory), or null : its file removed is refused with that reason.
 *     order (string): its field of a place in an order (a label's, a directory's position) : the
 *       app's objects are written in that order, and a move in the app rewrites the places.
 *
 * Returns:
 *   object: the descriptor (lib/repoObjects/engine.js).
 */
export function seedType(spec) {
  const { key, section, model, Model, secrets = [], references = [], skip = [], keepFalse = [], keptReason = () => null, defaults = {} } = spec;
  // its rows, decrypted : through the crud model, unless the type reads them its own way
  const read = spec.read || { all: () => CrudModel.findAll(model), byId: (id) => CrudModel.findById(model, id) };
  // the app's objects in their order : by their place when they have one, else by name
  const byOrder = (a, b) => (spec.order ? Number(a[spec.order] ?? 0) - Number(b[spec.order] ?? 0) : 0) || String(a.name).localeCompare(String(b.name));
  const { validate, keys, schema } = itemValidator(section);
  const table = CrudModel.getConfig(model).table;
  const links = linkStore(table);
  const booleans = new Set(keys.filter((k) => schema.properties[k].type === "boolean"));
  // the fields a file holds, in the seed's order
  const fileKeys = keys.filter((k) => !skip.includes(k));

  /**
   * A row as its file gives it : the seed's fields that are set, its secrets left out.
   *
   * Args:
   *   row (object): the row (decrypted).
   *
   * Returns:
   *   object: { object, withoutSecret }.
   */
  function toFile(row) {
    const obj = {};
    for (const k of fileKeys) {
      const v = row[k];
      if (booleans.has(k)) {
        if (v === null || v === undefined) continue;
        const on = !!Number(v);
        if (on || keepFalse.includes(k)) obj[k] = on;
      } else if (given(v)) {
        obj[k] = v;
      }
    }
    return withoutSecrets(obj, secrets);
  }

  return {
    key,
    flag: typeOf(key).flag,
    model,
    folder: spec.folder || key,
    title: spec.title,
    noun: spec.noun,
    secrets,
    references,
    keyOrder: fileKeys,

    /**
     * Reads a file : one item of the seed's section, its secrets ${ENV} references only (resolved),
     * checked against the seed's schema. A file saying state: absent holds no object.
     *
     * Args:
     *   text (string): the file's text.
     *
     * Returns:
     *   object: { errors, absent, object (resolved, null when refused), raw (as the file gives it) }.
     */
    parse(text) {
      const { errors, object: raw } = parseMapFile(text);
      if (errors.length) return { errors, absent: false, object: null };
      if (raw.state === "absent") return { errors: [], absent: true, object: null };
      const resolved = resolveSecrets(raw, secrets);
      if (resolved.errors.length) return { errors: resolved.errors, absent: false, object: null, raw };
      const invalid = validate(resolved.object);
      if (invalid.length) return { errors: invalid, absent: false, object: null, raw };
      return { errors: [], absent: false, object: resolved.object, raw };
    },

    store: {
      ...links,
      // decrypted, as the seed compares them
      rows: () => read.all(),
      names: async () => ((await mysql.do(`SELECT name FROM ${table}`)) || []).map((r) => r.name),
      byId: (id) => read.byId(id),
      // an object of the app is taken over by a file of its name, unless the config seed manages it
      // or it stays in the app for a reason of its own
      classify: (row, name) => {
        const code = row.managed ? "seed" : keptReason(row);
        return classifyRow(row, name, code ? `an object of this app (${KEPT_REASONS[code] || code})` : null);
      },
      changed: (row, obj) => differs(obj, row),
      insert: async (obj, name, file) => {
        const id = await Model.create({ ...defaults, ...obj }, FROM_REPO);
        await links.link(id, name, file);
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
     * An object of the app as a repository would take it : its file's fields (without its
     * secrets), or why it stays in the app.
     *
     * Args:
     *   row (object): the row.
     *
     * Returns:
     *   object: { row, object, withoutSecret } or { row, code, reason }.
     */
    candidateOf(row) {
      const code = row.managed ? "seed" : keptReason(row);
      if (code) return { row, code, reason: KEPT_REASONS[code] || code };
      return { row, ...toFile(row) };
    },

    // a new file : the seed's fields in the seed's order
    newFileText: (c) => newMapFile(c.object, fileKeys),
    linkCandidate: (c, name, file) => links.link(c.row.id, name, file),

    /**
     * An app edit as the edits of its file : each field the edit changed (the row before and after
     * it, as a file gives them) written, a field emptied removed ; the others - the file's ${ENV}
     * references, the fields it does not declare - left as they are, the secrets never written.
     *
     * Args:
     *   text (string): the file's text.
     *   row (object): the row as saved (decrypted).
     *   before (object): the row before the edit.
     *
     * Returns:
     *   string: the file's new text (the same text when nothing changed).
     */
    fileEdits(text, row, before) {
      const next = toFile(row).object;
      const prev = toFile(before || {}).object;
      const edits = {};
      for (const k of fileKeys) {
        if (secrets.includes(k) || same(next[k], prev[k])) continue;
        // emptied in the app : no longer declared (a yes or no off is its default)
        edits[k] = next[k];
      }
      return Object.keys(edits).length ? updateMapFile(text, edits, fileKeys) : text;
    },

    usersOf: spec.usersOf,
    undeletable: spec.undeletable,
    order: spec.order,
  };
}
