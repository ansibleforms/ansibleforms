'use strict';
// The Chat assistant type of the repository-backed objects (lib/repoObjects/engine.js, its
// single mode) : what Settings > Connections > Chat assistant saves, under the chat_assistant: key of a
// repository's file - its switch (enable_chat : the ENABLE_CHAT environment setting, as the
// Defaults page's default_language is one of its map, lib/repoObjects/envFields.js) and the
// settings in the config seed's format (its chat section, every field optional : what the file
// does not declare is left alone). Its api key is an ${ENV} reference only, or left out (the
// database's stays) ; a credential it names (an api one, whose password is the key) waits when it
// is not there yet. A pull applies it as the chat page's save does : the switch checked and saved
// as its Save does (applied at once), the credential checked, the fields converted by the model.
// The switch set in the real environment is never written to the file, and a file giving it is
// refused, as General refuses such a variable. Settings the config seed manages stay with the
// seed : never written to the file, the file not applied (said) - the switch with them.
import ChatSettings from "../../models/chatSettings.model.js";
import { chatFileItem } from "../seed-schema.js";
import { differs } from "../seedCompare.js";
import { singleType } from "./singleType.js";
import { KEPT_REASONS } from "./seedType.js";
import { envFieldSet } from "./envFields.js";

// the page's switch, an environment setting : read and saved as the page's Save does
const env = envFieldSet(["enable_chat"]);

/**
 * A declaration's fields of the chat settings row : its environment ones (the switch) left out.
 *
 * Args:
 *   declared (object): the declaration (a file's).
 *
 * Returns:
 *   object: the row's fields it declares.
 */
const rowOf = (declared) => Object.fromEntries(Object.entries(declared || {}).filter(([k]) => !env.has(k)));

/**
 * The environment fields a declaration changes : those it gives whose value is not the app's -
 * one set in the real environment never (its file is refused before, lib/repoObjects/envFields.js).
 *
 * Args:
 *   declared (object): the declaration.
 *   current (object): the app's object (current).
 *
 * Returns:
 *   string[]: the fields.
 */
const envChanged = (declared, current) =>
  env.fields.filter((k) => declared?.[k] !== undefined && !(current?._envSet || []).includes(k) && !!declared[k] !== !!current?.[k]);

export default singleType({
  key: "chat_assistant",
  section: chatFileItem,
  title: "Chat assistant",
  noun: "chat assistant",
  secrets: ["api_key"],
  references: [{ field: "credential", type: "credentials" }],
  // allowed to read the jobs' status is the default : off is what a file says
  // the switch is written off too : the value the app hands over
  keepFalse: ["enable_chat", "allow_job_status"],
  // the row as stored, its key decrypted, and the page's switch : none when the real environment
  // sets it (_envSet : never written to the repository)
  current: async () => {
    const row = await ChatSettings.find();
    const { values, envSet } = await env.read();
    const out = { ...row, ...values };
    Object.defineProperty(out, "_envSet", { value: envSet });
    return out;
  },
  // the switch set in the real environment : a file giving it refused, as General refuses such a
  // variable (the config seed never gives it : its chat section has no switch)
  fromFile: async (declared, opts = {}) => {
    if (!opts.fromSeed) await env.refuseOverridden(declared);
    return declared;
  },
  // the config seed's chat section : the settings stay with the seed, read only, as on the chat
  // page - never written to the repository's file, its file not applied (said)
  heldBySeed: (current) => !!Number(current?.managed ?? 0),
  kept: (current) => (Number(current?.managed ?? 0) ? [{ name: "Chat assistant", whole: true, code: "seed", reason: KEPT_REASONS.seed }] : []),
  // compared as the seed compares, each field as the model keeps it (a number clamped, its extra
  // headers) - its key as declared, the stored one encrypted anew on every write
  changed: (declared, current) => {
    const { cfg, record } = ChatSettings.declared(rowOf(declared));
    return envChanged(declared, current).length > 0 || differs({ ...record, api_key: cfg.api_key }, current || {});
  },
  // a file that moves the chat to another provider, base url or certificate check without giving
  // its key (or its credential) : the stored one stays behind, as on the chat page - it never goes
  // to a place the file chose
  apply: async (declared, current, opts = {}) => {
    // the switch checked first, as the page's Save checks it : a file refused whole, never applied
    // by halves
    const updates = env.updates(envChanged(declared, current), declared);
    await env.check(updates, opts);
    await ChatSettings.assertCredentialUsable(declared.credential);
    const { record } = ChatSettings.declared(rowOf(declared));
    const notes = [];
    if (!opts.fromSeed && !ChatSettings.sameTarget(current, { ...current, ...declared })) {
      if (declared.api_key === undefined && current?.api_key) {
        record.api_key = "";
        notes.push("Its stored api key was cleared: the file moves the chat to another provider or address, give its api_key there (an ${ENV} reference)");
      }
      if (declared.credential === undefined && current?.credential) {
        record.credential = null;
        notes.push(`Its credential '${current.credential}' was let go: the file moves the chat to another provider or address, name its credential there`);
      }
    }
    if (Object.keys(record).length) await ChatSettings.update(record);
    // the switch, as the page saves it : applied at once (the chat's route, button and service
    // read it per request)
    return [...notes, ...(await env.save(updates, opts))];
  },
});
