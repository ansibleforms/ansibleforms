// An Entra ID credential's renewed certificate (or new private key) saved over a stored key (or
// certificate) : the pair is checked on the update, not only when both come in the same write,
// so a certificate that does not go with the stored key is refused at save time instead of every
// mail failing at send time. A CyberArk or an SSH credential's client key is left alone.
import { describe, test, expect, vi, beforeAll, afterEach } from "vitest";
import { makeCertificate, CERTIFICATE_TIMEOUT_MS } from "./helpers/certificates.mjs";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { default: Credential } = await import("../src/models/credential.model.v2.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");

// ─── the certificates ─────────────────────────────────────────────────────────

let certPem;
let keyPem;
let otherCertPem;
let otherKeyPem;

beforeAll(() => {
  ({ cert: certPem, key: keyPem } = makeCertificate({ cn: "af-entra-old", keyType: "rsa" }));
  ({ cert: otherCertPem, key: otherKeyPem } = makeCertificate({ cn: "af-entra-new", keyType: "rsa" }));
}, CERTIFICATE_TIMEOUT_MS);

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stubs the stored credential (findById, its key decrypted as the model gives it) and the write
 * (CrudModel.update), so an update runs without a database.
 *
 * Args:
 *   stored (object): the stored credential.
 *
 * Returns:
 *   object: the update spy, its calls holding what was written.
 */
function stubStored(stored) {
  vi.spyOn(Credential, "findById").mockResolvedValue({ id: 7, name: "m365", ...stored });
  return vi.spyOn(CrudModel, "update").mockResolvedValue(true);
}

/**
 * Runs an update and gives the error it was refused with, or null when it was saved.
 *
 * Args:
 *   data (object): the fields written.
 *
 * Returns:
 *   Promise<Error|null>: the refusal, or null.
 */
async function refusal(data) {
  try {
    await Credential.update(data, 7);
    return null;
  } catch (e) {
    return e;
  }
}

// ─── a new certificate, the stored key kept ───────────────────────────────────

describe("an Entra ID credential's renewed certificate and its stored key", () => {
  test("a certificate that does not go with the stored key : refused with a 400, the key never in the message", async () => {
    const saved = stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: keyPem });
    for (const kept of [undefined, "", "********", "**********"]) {
      const data = { credential_type: "entraid", tenant_id: "t", client_cert: otherCertPem };
      if (kept !== undefined) data.client_key = kept;
      const err = await refusal(data);
      expect(err?.status).toBe(400);
      expect(err.name).toBe("BadRequestError");
      expect(err.message).toMatch(/does not belong to the stored private key.*upload the matching private key/);
      expect(err.message).not.toContain("PRIVATE KEY-----");
      expect(err.message).not.toContain(keyPem.split("\n")[1]);
    }
    expect(saved).not.toHaveBeenCalled();
  });

  test("a certificate of the stored key : saved", async () => {
    const saved = stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: otherCertPem, client_key: keyPem });
    expect(await refusal({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: "**********" })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  test("the type not sent : the stored one says it is an Entra ID credential", async () => {
    stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: keyPem });
    expect((await refusal({ client_cert: otherCertPem }))?.message).toMatch(/does not belong to the stored private key/);
  });

  test("a certificate with no stored key : refused, the key asked for", async () => {
    stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: null, client_key: "" });
    expect((await refusal({ credential_type: "entraid", tenant_id: "t", client_cert: certPem }))?.message).toMatch(/needs the certificate's private key too: upload the matching private key/);
  });

  test("a certificate and its new key in one write : saved, the stored key not in the way", async () => {
    const saved = stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: keyPem });
    expect(await refusal({ credential_type: "entraid", tenant_id: "t", client_cert: otherCertPem, client_key: otherKeyPem })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });
});

// ─── a new key, the stored certificate kept ───────────────────────────────────

describe("an Entra ID credential's new key and its stored certificate", () => {
  test("a key of another certificate : refused, the certificate asked for", async () => {
    const saved = stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: keyPem });
    const err = await refusal({ credential_type: "entraid", tenant_id: "t", client_key: otherKeyPem });
    expect(err?.message).toMatch(/new private key does not belong to the stored certificate.*upload the matching certificate/);
    expect(err.message).not.toContain(otherKeyPem.split("\n")[1]);
    expect(saved).not.toHaveBeenCalled();
  });

  test("the key of the stored certificate : saved", async () => {
    const saved = stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: otherKeyPem });
    expect(await refusal({ credential_type: "entraid", tenant_id: "t", client_key: keyPem })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  test("the certificate removed in the same write : nothing stored to check against", async () => {
    const saved = stubStored({ credential_type: "entraid", tenant_id: "t", client_cert: certPem, client_key: keyPem });
    expect(await refusal({ credential_type: "entraid", tenant_id: "t", client_cert: null, client_key: otherKeyPem })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });
});

// ─── other types ──────────────────────────────────────────────────────────────

describe("the other types that keep a client key", () => {
  test("a CyberArk credential's certificate saved over another key : untouched", async () => {
    const saved = stubStored({ credential_type: "cyberark", url: "https://ccp.local", client_cert: certPem, client_key: keyPem });
    expect(await refusal({ credential_type: "cyberark", url: "https://ccp.local", client_cert: otherCertPem })).toBeNull();
    expect(await refusal({ client_key: otherKeyPem })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(2);
  });

  test("an SSH credential's new private key with a certificate stored : untouched", async () => {
    const saved = stubStored({ credential_type: "ssh", client_cert: certPem, client_key: keyPem });
    expect(await refusal({ credential_type: "ssh", client_key: otherKeyPem })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  test("an update without a certificate or a key never reads the stored credential for it", async () => {
    const read = vi.spyOn(Credential, "findById").mockResolvedValue({ id: 7, name: "m365", credential_type: "entraid", tenant_id: "t" });
    vi.spyOn(CrudModel, "update").mockResolvedValue(true);
    expect(await refusal({ description: "renamed" })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
