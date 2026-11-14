// An Entra ID credential's certificate is checked on save as the mail sender checks it
// (lib/microsoftMail.js readCertificate) : an RSA key, and a certificate inside its validity
// dates. An EC certificate, an expired one or one not valid yet was taken on save, and every mail
// then failed with "is not an RSA key" or "expired". A valid RSA certificate is still taken.
import { describe, test, expect, vi, beforeAll, afterEach } from "vitest";
import { makeCertificate, CERTIFICATE_TIMEOUT_MS } from "./helpers/certificates.mjs";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { default: Credential } = await import("../src/models/credential.model.v2.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");
const mail = await import("../src/lib/microsoftMail.js");

// ─── the certificates ─────────────────────────────────────────────────────────

const DAY_MS = 24 * 3600 * 1000;

let rsa;
let ec;
let expired;
let notYetValid;

beforeAll(() => {
  const now = Date.now();
  rsa = makeCertificate({ cn: "af-entra-rsa", keyType: "rsa" });
  ec = makeCertificate({ cn: "af-entra-ec" });
  expired = makeCertificate({ cn: "af-entra-expired", keyType: "rsa", notBefore: new Date(now - 10 * DAY_MS), notAfter: new Date(now - DAY_MS) });
  notYetValid = makeCertificate({ cn: "af-entra-later", keyType: "rsa", notBefore: new Date(now + DAY_MS), notAfter: new Date(now + 10 * DAY_MS) });
}, CERTIFICATE_TIMEOUT_MS);

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Runs a step and gives the error it was refused with, or null when it passed.
 *
 * Args:
 *   run (function): the step (sync or async).
 *
 * Returns:
 *   Promise<Error|null>: the refusal, or null.
 */
async function refusal(run) {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

/**
 * A new Entra ID credential with a certificate and its key, as a create sends it.
 *
 * Args:
 *   pair (object): { cert, key } as makeCertificate returns them.
 *
 * Returns:
 *   object: the record.
 */
function entraRecord(pair) {
  return { name: "m365", credential_type: "entraid", tenant_id: "t", user: "client", client_cert: pair.cert, client_key: pair.key };
}

// ─── on create ────────────────────────────────────────────────────────────────

describe("an Entra ID credential's certificate on create", () => {
  test("a valid RSA certificate and its key : taken", async () => {
    expect(await refusal(() => Credential.prepareCreate(entraRecord(rsa)))).toBeNull();
  });

  test("an EC certificate : refused with a 400, as the sender would refuse it", async () => {
    const err = await refusal(() => Credential.prepareCreate(entraRecord(ec)));
    expect(err?.status).toBe(400);
    expect(err.name).toBe("BadRequestError");
    expect(err.message).toMatch(/is not an RSA key: Microsoft Entra ID signs in with an RSA certificate/);
    expect(err.message).not.toContain(ec.key.split("\n")[1]);
    // the sender refuses the same certificate
    expect(() => mail.readCertificate(ec.cert, ec.key, "m365")).toThrow(/is not an RSA key/);
  });

  test("an expired certificate : refused with a 400, its end date in the message", async () => {
    const err = await refusal(() => Credential.prepareCreate(entraRecord(expired)));
    expect(err?.status).toBe(400);
    expect(err.message).toMatch(/certificate of a Microsoft Entra ID credential expired on .*: upload a new one/);
    expect(() => mail.readCertificate(expired.cert, expired.key, "m365")).toThrow(/expired on/);
  });

  test("a certificate not valid yet : refused with a 400, its start date in the message", async () => {
    const err = await refusal(() => Credential.prepareCreate(entraRecord(notYetValid)));
    expect(err?.status).toBe(400);
    expect(err.message).toMatch(/certificate of a Microsoft Entra ID credential is not valid before /);
    expect(() => mail.readCertificate(notYetValid.cert, notYetValid.key, "m365")).toThrow(/is not valid before/);
  });

  test("a CyberArk credential's client certificate is not held to Entra ID's rules", async () => {
    const record = { name: "ca", credential_type: "cyberark", user: "app", url: "https://cyberark.example", client_cert: ec.cert, client_key: ec.key };
    expect(await refusal(() => Credential.prepareCreate(record))).toBeNull();
  });
});

// ─── on update ────────────────────────────────────────────────────────────────

describe("an Entra ID credential's certificate on update", () => {
  /**
   * Stubs the stored credential and the write, so an update runs without a database.
   *
   * Args:
   *   stored (object): the stored credential (its key decrypted, as findById gives it).
   *
   * Returns:
   *   object: the update spy.
   */
  function stubStored(stored) {
    vi.spyOn(Credential, "findById").mockResolvedValue({ id: 7, name: "m365", credential_type: "entraid", tenant_id: "t", ...stored });
    return vi.spyOn(CrudModel, "update").mockResolvedValue(true);
  }

  test("an expired certificate and its key in one write : refused, nothing written", async () => {
    const saved = stubStored({ client_cert: rsa.cert, client_key: rsa.key });
    const err = await refusal(() => Credential.update({ client_cert: expired.cert, client_key: expired.key }, 7));
    expect(err?.status).toBe(400);
    expect(err.message).toMatch(/expired on/);
    expect(saved).not.toHaveBeenCalled();
  });

  test("an expired certificate alone over a stored key, the type not sent : refused", async () => {
    const saved = stubStored({ client_cert: rsa.cert, client_key: expired.key });
    const err = await refusal(() => Credential.update({ client_cert: expired.cert }, 7));
    expect(err?.message).toMatch(/expired on/);
    expect(saved).not.toHaveBeenCalled();
  });

  test("an EC key alone over a stored certificate : refused", async () => {
    const saved = stubStored({ client_cert: ec.cert, client_key: rsa.key });
    const err = await refusal(() => Credential.update({ credential_type: "entraid", client_key: ec.key }, 7));
    expect(err?.message).toMatch(/is not an RSA key/);
    expect(saved).not.toHaveBeenCalled();
  });

  test("a valid RSA certificate and its key : saved", async () => {
    const saved = stubStored({ client_cert: expired.cert, client_key: expired.key });
    expect(await refusal(() => Credential.update({ client_cert: rsa.cert, client_key: rsa.key }, 7))).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });
});
