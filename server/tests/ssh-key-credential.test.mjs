// An SSH credential logs in with a private key (issue #1345) : stored encrypted in client_key,
// its passphrase in key_passphrase, both shown masked by the API, resolved for a job as
// private_key and private_key_passphrase (an SSH one only, never a CyberArk one's client key),
// handed to the RTE as the ansible login's privateKey and passphrase, and masked in the output
// line by line.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the credentials table : rows by name, the resolver's REGEXP emulated with RegExp
let rows = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      if (/WHERE name REGEXP \?/.test(sql)) {
        const re = new RegExp(Array.isArray(vars) ? vars[0] : vars);
        return rows.filter((r) => re.test(r.name)).map((r) => ({ ...r }));
      }
      return [];
    },
  },
}));

const appConfig = (await import("./__mocks__/app.config.js")).default;
appConfig.encryptionSecret ||= "0123456789abcdef0123456789abcdef";
const crypto = (await import("../src/lib/crypto.js")).default;
const Credential = (await import("../src/models/credential.model.v2.js")).default;
const { default: CrudModel } = await import("../src/models/crud.model.js");
const { resolveJobSecrets } = await import("../src/lib/jobSecrets.js");
const { registerJobSecrets, forgetJobSecrets, maskOutput, secretLines, collectSecrets, MASK } = await import("../src/lib/outputMask.js");

// a key as a user pastes it : not a real one, but shaped like one
const KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACBkZXZlbG9wZXJrZXlleGFtcGxlZm9ydGVzdHNvbmx5AAAAmAAAAAAAAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

beforeEach(() => {
  Credential.getCache("credential")?.flushAll();
  rows = [];
});

describe("an SSH credential's private key, on a write", () => {
  test("a PEM or an OpenSSH private key is taken", () => {
    assert.doesNotThrow(() => Credential.checkSshKey({ credential_type: "ssh", client_key: KEY }, true));
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    assert.doesNotThrow(() => Credential.checkSshKey({ credential_type: "ssh", client_key: pem }, true));
  });

  test("anything else is refused, saying what a key looks like", () => {
    assert.throws(() => Credential.checkSshKey({ credential_type: "ssh", client_key: "ssh-ed25519 AAAA public" }, true), /PEM or OpenSSH private key/);
    assert.throws(() => Credential.checkSshKey({ credential_type: "ssh", client_key: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" }, true), /PRIVATE KEY/);
  });

  test("the mask sent back, or no key, is left alone", () => {
    assert.doesNotThrow(() => Credential.checkSshKey({ credential_type: "ssh", client_key: "**********" }));
    assert.doesNotThrow(() => Credential.checkSshKey({ credential_type: "ssh" }, true));
  });

  test("a CyberArk or an Entra ID credential's client key is left to its own rules", () => {
    const cert = { credential_type: "entraid", client_key: "not checked as an ssh key", tenant_id: "t" };
    assert.doesNotThrow(() => Credential.checkSshKey(cert, true));
    assert.equal(cert.client_key, "not checked as an ssh key");
    assert.equal(Credential.checkSshKey({ credential_type: "cyberark", client_key: "x" }, true).client_key, "x");
  });

  test("a passphrase belongs to an SSH credential only", () => {
    assert.equal(Credential.checkSshKey({ credential_type: "cyberark", key_passphrase: "x" }, true).key_passphrase, null);
    assert.equal(Credential.checkSshKey({ credential_type: "ssh", key_passphrase: "keep me" }, true).key_passphrase, "keep me");
    assert.equal(Credential.checkSshKey({ credential_type: "userpass" }).key_passphrase, undefined, "an update that sends none leaves it");
  });

  test("the passphrase is stored encrypted, and its mask sent back keeps it", () => {
    const out = CrudModel.getFieldValues("credential", { key_passphrase: "my phrase" }, true);
    assert.ok(out.key_passphrase && out.key_passphrase !== "my phrase");
    assert.equal(crypto.decrypt(out.key_passphrase), "my phrase");
    assert.equal("key_passphrase" in CrudModel.getFieldValues("credential", { key_passphrase: "**********" }, true), false);
  });
});

describe("an SSH credential's private key, resolved", () => {
  const sshRow = (over = {}) => ({
    name: "deploy", user: "ansible", password: "", credential_type: "ssh",
    client_key: crypto.encrypt(KEY), key_passphrase: crypto.encrypt("open sesame"), ...over,
  });

  test("its key and passphrase come decrypted, the stored columns and the type do not", async () => {
    rows = [sshRow()];
    const c = await Credential.resolveCredential("deploy");
    assert.equal(c.private_key, KEY);
    assert.equal(c.private_key_passphrase, "open sesame");
    for (const k of ["client_key", "key_passphrase", "credential_type"]) assert.equal(k in c, false, k);
  });

  test("a key without a passphrase : no passphrase", async () => {
    rows = [sshRow({ key_passphrase: null })];
    const c = await Credential.resolveCredential("deploy");
    assert.equal(c.private_key, KEY);
    assert.equal("private_key_passphrase" in c, false);
  });

  test("a CyberArk credential's client key never comes with it", async () => {
    rows = [{ name: "ccp", user: "AppID", password: "", credential_type: "cyberark", client_key: crypto.encrypt(KEY), key_passphrase: null }];
    const c = await Credential.resolveCredential("ccp");
    assert.equal("private_key" in c, false);
    assert.equal("client_key" in c, false);
  });

  test("an Entra ID credential's certificate key never comes with it either", async () => {
    rows = [{ name: "m365", user: "client-id", password: "", credential_type: "entraid", client_key: crypto.encrypt(KEY), key_passphrase: null }];
    const c = await Credential.resolveCredential("m365");
    assert.equal("private_key" in c, false);
    assert.equal("client_key" in c, false);
  });

  test("a credential map names the key as a secret, so the output masks it", async () => {
    rows = [sshRow()];
    const map = await Credential.resolveCredentialMap({ login: "deploy" });
    const secrets = collectSecrets(map);
    assert.ok(secrets.includes(KEY));
    assert.ok(secrets.includes("open sesame"));
  });

  test("the job's ansible login carries the key and the passphrase for the RTE", async () => {
    rows = [sshRow({ password: crypto.encrypt("pw-1234") })];
    const { ansible } = await resolveJobSecrets({ __ansibleCredentials__: "deploy" }, {});
    assert.deepEqual(ansible, { user: "ansible", password: "pw-1234", privateKey: KEY, passphrase: "open sesame" });
    rows = [sshRow({ client_key: null })];
    Credential.getCache("credential")?.flushAll();
    const plain = await resolveJobSecrets({ __ansibleCredentials__: "deploy" }, {});
    assert.equal("privateKey" in plain.ansible, false, "no key, nothing more than before");
    assert.equal("passphrase" in plain.ansible, false, "a passphrase without a key is never sent");
  });
});

describe("a private key in a job's output", () => {
  test("its lines are secrets of their own, the armour lines are not", () => {
    assert.deepEqual(secretLines(KEY), [KEY.split("\n")[1], KEY.split("\n")[2]]);
    assert.deepEqual(secretLines("one-line-secret"), []);
  });

  test("the whole key, a line of it and the passphrase are masked", () => {
    registerJobSecrets(77, [KEY, "open sesame"]);
    try {
      const line = KEY.split("\n")[1];
      assert.equal(maskOutput(77, `key: ${JSON.stringify(KEY)}`), `key: "${MASK}"`);
      assert.equal(maskOutput(77, `ok: ${line}`), `ok: ${MASK}`);
      assert.equal(maskOutput(77, "pass open sesame"), `pass ${MASK}`);
    } finally {
      forgetJobSecrets(77);
    }
  });
});
