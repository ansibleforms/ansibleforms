// An SSH credential's private key sent alone on an update (PUT /api/v2/credential/12
// {"client_key":"not a key"}, the type left out) is checked as a create checks it : the stored type
// says it is an SSH credential. Any text was stored as the key, and the failure only showed when a
// job connected. A CyberArk or an Entra ID credential's client key is still not an SSH key.
import { describe, test, expect, vi, afterEach } from "vitest";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { default: Credential } = await import("../src/models/credential.model.v2.js");
const { default: CrudModel } = await import("../src/models/crud.model.js");

// a key as a user pastes it : not a real one, but shaped like one
const KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stubs the stored credential (findById) and the write (CrudModel.update), so an update runs
 * without a database.
 *
 * Args:
 *   type (string): the stored credential's type.
 *
 * Returns:
 *   object: { found, saved } : the findById and the update spies.
 */
function stubStored(type) {
  const found = vi.spyOn(Credential, "findById").mockResolvedValue({ id: 12, name: "login", credential_type: type, url: "https://x.example", tenant_id: "t" });
  const saved = vi.spyOn(CrudModel, "update").mockResolvedValue(true);
  return { found, saved };
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
    await Credential.update(data, 12);
    return null;
  } catch (e) {
    return e;
  }
}

describe("an SSH credential's private key sent alone on an update", () => {
  test("text that is not a private key : refused with a 400, nothing written", async () => {
    const { saved } = stubStored("ssh");
    const err = await refusal({ client_key: "not a key" });
    expect(err?.status).toBe(400);
    expect(err.name).toBe("BadRequestError");
    expect(err.message).toMatch(/PEM or OpenSSH private key/);
    expect(saved).not.toHaveBeenCalled();
  });

  test("a private key : saved", async () => {
    const { saved } = stubStored("ssh");
    expect(await refusal({ client_key: KEY })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  test("the mask sent back, an empty key or none : the stored type not even read", async () => {
    for (const data of [{ client_key: "**********" }, { client_key: "" }, { name: "renamed" }]) {
      const { found, saved } = stubStored("ssh");
      expect(await refusal(data)).toBeNull();
      expect(found).not.toHaveBeenCalled();
      expect(saved).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });

  test("the type sent with it : checked as before", async () => {
    stubStored("ssh");
    expect((await refusal({ credential_type: "ssh", client_key: "not a key" }))?.status).toBe(400);
  });

  test("a CyberArk or an Entra ID credential's client key is not checked as an SSH key", async () => {
    // a CyberArk one's client key is written as it was sent
    const { saved } = stubStored("cyberark");
    expect(await refusal({ client_key: "not an ssh key" })).toBeNull();
    expect(saved).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    // an Entra ID one's is held to its own rules (a PEM private key), never the SSH one's
    stubStored("entraid");
    const err = await refusal({ client_key: "not an ssh key" });
    expect(err?.message).toMatch(/Microsoft Entra ID credential/);
    expect(err.message).not.toMatch(/SSH/);
  });
});
