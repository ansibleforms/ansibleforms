// One SSO provider of each type is in use : the one its login button signs in with. Putting a
// provider in use switches the other providers of its type off, and a seed-managed provider in
// use cannot be displaced from the API (403).
//
// An update names only the fields it changes, and both steps read the type from the request
// alone. A PUT without `provider` bound it as NULL, which matched no row : the seed guard did not
// fire and nothing was switched off, so two providers of one type stayed in use and sign-in took
// the lowest id. Moving an in-use provider to another type did the same, and `enable: "0"` (a
// truthy string) switched every other provider off and then stored 0, leaving none in use.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the oauth2_providers table the mocked database answers from
let rows = [];

// SQL NULL semantics : provider = NULL matches no row
const eq = (a, b) => b !== undefined && b !== null && a === b;

vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (q, v = []) => {
      // the seed guard : the type's provider in use, when the seed manages it
      if (/SELECT name FROM .*enable = 1 AND managed = 1 AND provider = \?/.test(q)) {
        return rows.filter((r) => r.enable && r.managed && eq(r.provider, v[0]));
      }
      // the exclusivity step : the other providers of this type are switched off
      if (/UPDATE .*SET enable = 0 WHERE provider = \?/.test(q)) {
        rows.filter((r) => eq(r.provider, v[0]) && (!/managed = 0/.test(q) || !r.managed)).forEach((r) => { r.enable = 0; });
        return { affectedRows: 1 };
      }
      // CrudModel.checkExist and CrudModel.assertNotManaged
      if (/SELECT 1 FROM/.test(q)) return rows.filter((r) => r.id == v[2]).map(() => ({ 1: 1 }));
      if (/SELECT managed FROM/.test(q)) return rows.filter((r) => r.id == v[2]);
      // CrudModel.update's write
      if (/^UPDATE \S+ SET \? WHERE id = \?/.test(q)) {
        Object.assign(rows.find((r) => r.id == v[1]), v[0]);
        return { affectedRows: 1 };
      }
      // the stored row
      if (/SELECT .* WHERE id=\?/.test(q)) return rows.filter((r) => r.id == v[0]);
      return [];
    },
  },
}));
vi.mock("../src/auth/auth_entraid.js", () => ({ isSingleTenant: () => true, default: {} }));

const { default: OAuth2 } = await import("../src/models/oauth2.model.js");

// the names of the providers of a type in use
const inUse = (provider) => rows.filter((r) => r.enable && r.provider === provider).map((r) => r.name);

describe("updating an SSO provider keeps one provider of each type in use", () => {
  beforeEach(() => {
    rows = [
      { id: 1, name: "seeded", provider: "azuread", enable: 1, managed: 1, auto_login: 0, tenant_id: "contoso.com", client_id: "a", client_secret: "s" },
      { id: 2, name: "mine", provider: "azuread", enable: 0, managed: 0, auto_login: 0, tenant_id: "contoso.com", client_id: "b", client_secret: "s" },
      { id: 3, name: "idp-a", provider: "oidc", enable: 1, managed: 0, auto_login: 0, client_id: "c", client_secret: "s" },
      { id: 4, name: "entra", provider: "azuread", enable: 0, managed: 0, auto_login: 0, tenant_id: "contoso.com", client_id: "d", client_secret: "s" },
    ];
  });

  test("enabling without naming the type is refused when the seed's provider is in use", async () => {
    await assert.rejects(OAuth2.update({ enable: 1, provider: "azuread" }, 2), /managed by the config seed/);
    await assert.rejects(OAuth2.update({ enable: 1 }, 2), /managed by the config seed/);
    assert.deepEqual(inUse("azuread"), ["seeded"]);
  });

  test("enabling without naming the type switches the others of its type off", async () => {
    rows.find((r) => r.id === 1).managed = 0;
    await OAuth2.update({ enable: 1 }, 2);
    assert.deepEqual(inUse("azuread"), ["mine"]);
  });

  test("moving a provider in use to another type switches the others of that type off", async () => {
    rows.find((r) => r.id === 1).enable = 0;
    rows.find((r) => r.id === 4).enable = 1;
    await OAuth2.update({ provider: "oidc" }, 4);
    assert.deepEqual(inUse("oidc"), ["entra"]);
  });

  test("moving a provider not in use to another type leaves that type's provider in use", async () => {
    await OAuth2.update({ provider: "oidc" }, 4);
    assert.deepEqual(inUse("oidc"), ["idp-a"]);
  });

  test("enable '0' takes the provider out of use and leaves the others alone", async () => {
    await OAuth2.update({ enable: "0" }, 3);
    assert.equal(rows.find((r) => r.id === 3).enable, 0);
    rows.find((r) => r.id === 3).enable = 1;
    rows.find((r) => r.id === 1).enable = 0;
    rows.find((r) => r.id === 2).enable = 1;
    await OAuth2.update({ enable: "0" }, 4);
    assert.deepEqual(inUse("azuread"), ["mine"]);
    assert.equal(rows.find((r) => r.id === 4).enable, 0);
  });
});
