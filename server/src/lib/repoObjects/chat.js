'use strict';
// The Chat type of the repository-backed objects (lib/repoObjects/engine.js, its single-file mode) :
// the chat assistant's settings in a repository's chat.yaml, in the config seed's format (its chat
// section, every field optional : what the file does not declare is left alone). Its api key is an
// ${ENV} reference only, or left out (the database's stays) ; a credential it names (an api one,
// whose password is the key) waits when it is not there yet. A pull applies it as the chat page's
// save does : the credential checked, the fields converted by the model.
import ChatSettings from "../../models/chatSettings.model.js";
import { chatFileItem } from "../seed-schema.js";
import { differs } from "../seedCompare.js";
import { singleType } from "./singleType.js";

export default singleType({
  key: "chat",
  file: "chat.yaml",
  section: chatFileItem,
  title: "Chat assistant",
  noun: "chat assistant",
  secrets: ["api_key"],
  references: [{ field: "credential", type: "credentials" }],
  // allowed to read the jobs' status is the default : off is what a file says
  keepFalse: ["allow_job_status"],
  // the row as stored, its key decrypted
  current: () => ChatSettings.find(),
  // compared as the seed compares : its extra headers as the model keeps them
  changed: (declared, current) => differs(ChatSettings.declared(declared).cfg, current || {}),
  apply: async (declared, current) => {
    // the config seed's : read only, as on the chat page
    if (current?.managed) throw new Error("the chat assistant is managed by the config seed");
    await ChatSettings.assertCredentialUsable(declared.credential);
    await ChatSettings.update(ChatSettings.declared(declared).record);
  },
});
