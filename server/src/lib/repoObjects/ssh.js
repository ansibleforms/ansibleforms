'use strict';
// The SSH type of the repository-backed objects (lib/repoObjects/singleType.js) : Settings >
// Connections > SSH under the controller_ssh: key of a repository's file - the app's private key
// (an ${ENV} reference only, never written to the file ; its public key made from it, as the page
// makes it) and the known hosts, the servers the app trusts, one known_hosts line each. A file
// leaving one out leaves it as the app has it ; an empty known_hosts list clears them. The config
// seed's ssh: section takes the same map, made or changed, never locked.
import Ssh from "../../models/ssh.model.js";
import KnownHosts from "../../models/knownhosts.model.js";
import { sshSection } from "../seed-schema.js";
import { singleType } from "./singleType.js";

// a known_hosts line : an optional marker, the hosts (names, addresses, or a hashed |1|...), the key
// type and the key in base64, an optional comment ; one line, never two
const KNOWN_HOST = /^(@(cert-authority|revoked) )?[^\s@]\S* (ssh-[a-z0-9-]+|ecdsa-sha2-nistp(256|384|521)|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
// a private key in PEM or OpenSSH text
const PRIVATE_KEY = /^-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----[\s\S]+-----END ([A-Z0-9]+ )*PRIVATE KEY-----\s*$/;

// a key as compared : its text without the spaces around it
const keyText = (key) => String(key ?? "").trim();
// the known hosts as compared : each line trimmed, the empty ones left out
const hostLines = (lines) => (lines || []).map((l) => String(l).trim()).filter(Boolean);

/**
 * A file's map checked : its key a private key, each known host one known_hosts line.
 *
 * Args:
 *   declared (object): { private_key, known_hosts }, its key resolved.
 *
 * Returns:
 *   object: the same, the hosts trimmed.
 *
 * Raises:
 *   Error: what is wrong, every line named.
 */
export function checkSsh(declared) {
  const problems = [];
  if (declared.private_key !== undefined && !PRIVATE_KEY.test(keyText(declared.private_key))) {
    problems.push("private_key is not a private key (PEM or OpenSSH text)");
  }
  const out = { ...declared };
  if (declared.known_hosts !== undefined) {
    out.known_hosts = hostLines(declared.known_hosts);
    for (const line of out.known_hosts) {
      if (!KNOWN_HOST.test(line)) problems.push(`known_hosts: '${line.slice(0, 60)}' is not a known_hosts line (hosts, key type, key)`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  return out;
}

/**
 * What a declaration changes : the key when it gives another one, the hosts when it gives other
 * lines (their order counts, as ssh reads them).
 *
 * Args:
 *   declared (object): the declaration.
 *   current (object): the app's.
 *
 * Returns:
 *   object: { key (boolean), hosts (boolean) }.
 */
function changesOf(declared, current) {
  const key = declared.private_key !== undefined && keyText(declared.private_key) !== keyText(current?.private_key);
  const hosts =
    declared.known_hosts !== undefined && JSON.stringify(hostLines(declared.known_hosts)) !== JSON.stringify(hostLines(current?.known_hosts));
  return { key, hosts };
}

export default singleType({
  key: "ssh",
  section: sshSection,
  title: "SSH",
  noun: "SSH key and known hosts",
  secrets: ["private_key"],
  current: async () => ({ private_key: await Ssh.privateKey(), known_hosts: hostLines(await KnownHosts.findAll()) }),
  fromFile: async (declared) => checkSsh(declared),
  changed: (declared, current) => {
    const c = changesOf(declared, current);
    return c.key || c.hosts;
  },
  // as the page saves them : the key written and its public key made, the hosts written
  apply: async (declared, current) => {
    const c = changesOf(declared, current);
    if (c.key) await Ssh.update({ key: keyText(declared.private_key) + "\n" });
    if (c.hosts) await KnownHosts.replaceAll(hostLines(declared.known_hosts));
    return [];
  },
});
