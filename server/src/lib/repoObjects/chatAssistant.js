'use strict';
// The Chat assistant type of the repository-backed objects (lib/repoObjects/engine.js, its
// single-file mode) : the chat assistant's settings in a repository's chat-assistant.yaml, in the
// config seed's format (its chat section, every field optional : what the file does not declare is left alone). Its api key is an
// ${ENV} reference only, or left out (the database's stays) ; a credential it names (an api one,
// whose password is the key) waits when it is not there yet. A pull applies it as the chat page's
// save does : the credential checked, the fields converted by the model. Settings the config seed
// manages stay with the seed : never written to the file, the file not applied (said).
import ChatSettings from "../../models/chatSettings.model.js";
import { chatFileItem } from "../seed-schema.js";
import { differs } from "../seedCompare.js";
import { singleType } from "./singleType.js";
import { KEPT_REASONS } from "./seedType.js";

export default singleType({
  key: "chat_assistant",
  file: "chat-assistant.yaml",
  section: chatFileItem,
  title: "Chat assistant",
  noun: "chat assistant",
  secrets: ["api_key"],
  references: [{ field: "credential", type: "credentials" }],
  // allowed to read the jobs' status is the default : off is what a file says
  keepFalse: ["allow_job_status"],
  // the row as stored, its key decrypted
  current: () => ChatSettings.find(),
  // the config seed's chat section : the settings stay with the seed, read only, as on the chat
  // page - never written to the repository's file, its file not applied (said)
  heldBySeed: (current) => !!Number(current?.managed ?? 0),
  kept: (current) => (Number(current?.managed ?? 0) ? [{ name: "Chat assistant", whole: true, code: "seed", reason: KEPT_REASONS.seed }] : []),
  // compared as the seed compares : its extra headers as the model keeps them
  changed: (declared, current) => differs(ChatSettings.declared(declared).cfg, current || {}),
  apply: async (declared) => {
    await ChatSettings.assertCredentialUsable(declared.credential);
    await ChatSettings.update(ChatSettings.declared(declared).record);
  },
});
