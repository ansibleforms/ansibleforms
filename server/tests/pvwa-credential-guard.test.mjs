// 7.6 gave a CyberArk secret store a PVWA API user (secret_stores.pvwa_credential) : the userpass
// credential every write to the vault goes through. It was neither counted as a use (its Used by
// tab left the store out, and a delete or a rename went through, breaking the store's writes) nor
// guarded : a connections user could name it in a repository or a notification channel of theirs
// and receive its user and password at the address of their choosing.
import { describe, test, expect, vi, beforeEach } from "vitest";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the stores and the runners there are, and every statement run
const stores = [{ name: "cyberark", credential: "ccp-app", pvwa_credential: "pvwa-api" }];
const runners = [{ name: "awx1", credential: "runner-login" }];
const statements = [];
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => {
      statements.push(sql);
      const name = Array.isArray(vars) ? vars[0] : vars;
      if (/FROM AnsibleForms.`runners` WHERE credential = \?/.test(sql)) {
        return runners.filter((r) => r.credential === name).map((r) => ({ name: r.name }));
      }
      if (/FROM AnsibleForms.`secret_stores` WHERE pvwa_credential = \?/.test(sql)) {
        return stores.filter((s) => s.pvwa_credential === name).map((s) => ({ name: s.name }));
      }
      // usageCounts : each column of a store it reads counted, as the union does
      if (/GROUP BY name/.test(sql)) {
        const names = [];
        if (/SELECT credential AS name FROM AnsibleForms.`secret_stores`/.test(sql)) names.push(...stores.map((s) => s.credential));
        if (/SELECT pvwa_credential FROM AnsibleForms.`secret_stores`/.test(sql)) names.push(...stores.map((s) => s.pvwa_credential));
        const counts = new Map();
        for (const n of names.filter(Boolean)) counts.set(n, (counts.get(n) || 0) + 1);
        return [...counts].map(([n, c]) => ({ name: n, n: c }));
      }
      return [];
    },
  },
}));

const { default: CredentialModel } = await import("../src/models/credential.model.v2.js");

beforeEach(() => { statements.length = 0; });

describe("the PVWA API user of a CyberArk store", () => {
  test("counts as a use: its Used by count, a delete or a rename refused", async () => {
    expect(await CredentialModel.usageOf("pvwa-api")).toBe(1);
    expect((await CredentialModel.usageCounts()).get("ccp-app")).toBe(1);
  });

  test("names the store that writes with it", async () => {
    expect(await CredentialModel.storesWritingWith("pvwa-api")).toEqual(["cyberark"]);
    expect(await CredentialModel.storesWritingWith("other")).toEqual([]);
    expect(await CredentialModel.storesWritingWith("")).toEqual([]);
  });

  test("is admin-guarded, whatever its type", async () => {
    expect(await CredentialModel.isAdminGuarded({ name: "pvwa-api", credential_type: "userpass" })).toBe(true);
    expect(await CredentialModel.isAdminGuarded({ name: "pvwa-api", credential_type: "api" })).toBe(true);
  });

  test("so a repository or a channel may not name it for a connections user", async () => {
    vi.spyOn(CredentialModel, "findRowByName").mockImplementation(async (name) => ({ name, credential_type: "userpass" }));
    expect(await CredentialModel.firstAdminGuarded(["plain", "pvwa-api"])).toBe("pvwa-api");
  });

  test("a credential no store nor runner names stays open", async () => {
    expect(await CredentialModel.isAdminGuarded({ name: "plain", credential_type: "userpass" })).toBe(false);
  });
});
