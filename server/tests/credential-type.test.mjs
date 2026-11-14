// A credential's type says what it is for (userpass, ssh, git, api, database...) and keeps the older
// is_database flag in step, so a client or a seed that only knows the flag still works.
import { test, describe } from "vitest";
import assert from "node:assert/strict";

process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

const { default: Credential } = await import("../src/models/credential.model.v2.js");

describe("a credential's type and its is_database flag", () => {
  test("the type sets the flag", () => {
    assert.equal(Credential.mirrorType({ credential_type: "database" }).is_database, 1);
    for (const type of ["userpass", "ssh", "git", "api"]) assert.equal(Credential.mirrorType({ credential_type: type }).is_database, 0);
  });

  test("the flag alone sets the type: database, or userpass on a create", () => {
    assert.equal(Credential.mirrorType({ is_database: 1 }).credential_type, "database");
    assert.equal(Credential.mirrorType({ is_database: 0 }, true).credential_type, "userpass");
    assert.equal(Credential.mirrorType({ is_database: 0 }).credential_type, undefined, "an update leaves the stored type");
  });

  test("a create with neither is a database credential, as the column's default", () => {
    assert.equal(Credential.mirrorType({}, true).credential_type, "database");
  });

  test("an unknown type is refused", () => {
    assert.throws(() => Credential.mirrorType({ credential_type: "kerberos" }), /Unknown credential type 'kerberos'/);
  });
});

describe("an Entra ID credential's tenant", () => {
  test("a create without one is refused, an update that empties it too", () => {
    assert.throws(() => Credential.requireTypeFields({ credential_type: "entraid" }, true), /needs its tenant ID/);
    assert.throws(() => Credential.requireTypeFields({ credential_type: "entraid", tenant_id: " " }), /needs its tenant ID/);
  });

  test("one with it keeps it, trimmed ; an update that does not send it leaves the stored one", () => {
    assert.equal(Credential.requireTypeFields({ credential_type: "entraid", tenant_id: " t-1 " }, true).tenant_id, "t-1");
    assert.equal(Credential.requireTypeFields({ credential_type: "entraid" }).tenant_id, undefined);
  });

  test("another type keeps none: an Open ID one, a type changed away from Entra ID", () => {
    assert.equal(Credential.requireTypeFields({ credential_type: "oidc", issuer: "https://id.example.com", tenant_id: "t-1" }, true).tenant_id, null);
    assert.equal(Credential.requireTypeFields({ credential_type: "userpass", tenant_id: "t-1" }).tenant_id, null);
  });
});

describe("an Open ID credential's issuer, an smtp one's host", () => {
  test("an Open ID one needs its issuer ; another type keeps none", () => {
    assert.throws(() => Credential.requireTypeFields({ credential_type: "oidc" }, true), /needs its issuer/);
    assert.equal(Credential.requireTypeFields({ credential_type: "oidc", issuer: " https://id.example.com " }, true).issuer, "https://id.example.com");
    assert.equal(Credential.requireTypeFields({ credential_type: "entraid", tenant_id: "t", issuer: "x" }, true).issuer, null);
  });

  test("an smtp one needs its mail server", () => {
    assert.throws(() => Credential.requireTypeFields({ credential_type: "smtp" }, true), /needs its mail server/);
    assert.equal(Credential.requireTypeFields({ credential_type: "smtp", host: "smtp.example.com" }, true).host, "smtp.example.com");
  });

  test("an smtp one without a login (a relay): only its server, port and TLS, saved as they are", async () => {
    const { vi } = await import("vitest");
    const { default: CrudModel } = await import("../src/models/crud.model.js");
    const saved = vi.spyOn(CrudModel, "create").mockResolvedValue(11);
    const relay = { name: "relay", description: "d", credential_type: "smtp", host: "relay.example.com", port: "25", secure: 0, user: "", password: "" };
    assert.equal(await Credential.create(relay), 11);
    assert.deepEqual(
      (({ user, password, host, port }) => ({ user, password, host, port }))(saved.mock.calls[0][1]),
      { user: "", password: "", host: "relay.example.com", port: 25 },
    );
    vi.restoreAllMocks();
  });
});

describe("an SSO credential's redirect URL", () => {
  test("an Entra ID or Open ID one keeps it, trimmed, empty as none ; another type keeps none", () => {
    assert.equal(Credential.requireTypeFields({ credential_type: "entraid", tenant_id: "t", redirect_uri: " https://f/cb " }, true).redirect_uri, "https://f/cb");
    assert.equal(Credential.requireTypeFields({ credential_type: "oidc", issuer: "https://i", redirect_uri: "" }, true).redirect_uri, null);
    assert.equal(Credential.requireTypeFields({ credential_type: "userpass", redirect_uri: "https://f/cb" }, true).redirect_uri, null);
  });
});

describe("a credential keeps the type it was made as", () => {
  test("an update to another type is refused ; the same type, or none sent, goes on ; the seed may change it", async () => {
    const { vi } = await import("vitest");
    vi.spyOn(Credential, "findById").mockResolvedValue({ name: "smtp-office365", credential_type: "smtp" });
    await assert.rejects(Credential.update({ credential_type: "api" }, 5), /keeps the type it was made as: 'smtp-office365' is smtp/);
    const { default: CrudModel } = await import("../src/models/crud.model.js");
    const saved = vi.spyOn(CrudModel, "update").mockResolvedValue(true);
    await Credential.update({ credential_type: "smtp", host: "smtp.example.com" }, 5);
    await Credential.update({ description: "d" }, 5);
    await Credential.update({ credential_type: "api" }, 5, { fromSeed: true });
    assert.equal(saved.mock.calls.length, 3);
    vi.restoreAllMocks();
  });
});

describe("an ldap credential's servers", () => {
  test("an ldap one needs its directory servers", () => {
    assert.throws(() => Credential.requireTypeFields({ credential_type: "ldap" }, true), /needs its directory servers/);
    assert.equal(Credential.requireTypeFields({ credential_type: "ldap", host: "ldap1, ldap2" }, true).host, "ldap1, ldap2");
  });
});

describe("a credential's server address", () => {
  test("a runner's or a secret store's keeps it, trimmed and without a trailing slash", () => {
    assert.equal(Credential.requireTypeFields({ credential_type: "vault", url: " https://vault:8200/ " }, true).url, "https://vault:8200");
    assert.equal(Credential.requireTypeFields({ credential_type: "jenkins", url: "http://jenkins" }, true).url, "http://jenkins");
    assert.equal(Credential.requireTypeFields({ credential_type: "cyberark", url: "https://ccp" }, true).url, "https://ccp");
  });

  test("they need it ; the config seed may leave it out", () => {
    // an RTE's is optional since 7.3 : an outbound RTE dials the app, nobody dials it
    assert.equal(Credential.requireTypeFields({ credential_type: "rte" }, true).url ?? null, null);
    for (const type of ["awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault", "cyberark"]) {
      assert.throws(() => Credential.requireTypeFields({ credential_type: type }, true), /needs its server/);
    }
    assert.throws(() => Credential.requireTypeFields({ credential_type: "awx", url: " " }), /needs its server/);
    assert.equal(Credential.requireTypeFields({ credential_type: "rte" }, true, { fromSeed: true }).url, undefined);
  });

  test("another type has none", () => {
    assert.equal(Credential.requireTypeFields({ credential_type: "api", url: "https://x" }, true).url, null);
    assert.equal(Credential.requireTypeFields({ credential_type: "userpass", url: "https://x" }, true).url, null);
    assert.equal(Credential.requireTypeFields({ credential_type: "database" }, true).url, null);
  });

  test("the runner and secret store types are known", () => {
    for (const type of ["rte", "awx", "aap", "ascender", "semaphore", "rundeck", "jenkins", "vault"]) {
      assert.equal(Credential.mirrorType({ credential_type: type }).is_database, 0);
    }
  });
});

describe("the RTE's pin (rte_cert_sha256)", () => {
  test("never written through the API nor the seed ; the RTE hub writes it", () => {
    assert.equal("rte_cert_sha256" in Credential.guardRtePin({ rte_cert_sha256: "x" }, null), false);
    assert.equal("rte_cert_sha256" in Credential.guardRtePin({ rte_cert_sha256: "x" }, null, { fromSeed: true }), false);
    assert.equal(Credential.guardRtePin({ rte_cert_sha256: "x" }, null, { fromRte: true }).rte_cert_sha256, "x");
  });

  test("a ca_bundle changed by anyone else clears it ; the same bundle sent back keeps it", () => {
    const stored = { ca_bundle: "PEM-A", rte_cert_sha256: "abc" };
    assert.equal(Credential.guardRtePin({ ca_bundle: "PEM-B" }, stored).rte_cert_sha256, null);
    assert.equal(Credential.guardRtePin({ ca_bundle: "" }, stored).rte_cert_sha256, null);
    assert.equal("rte_cert_sha256" in Credential.guardRtePin({ ca_bundle: " PEM-A " }, stored), false, "unchanged : left as it is");
    assert.equal("rte_cert_sha256" in Credential.guardRtePin({ name: "x" }, stored), false);
  });
});
