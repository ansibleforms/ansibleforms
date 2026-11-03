// Writing a credential's user and password to CyberArk through its PVWA (the CCP only reads) :
// against a fake PVWA on a local port.
//   the safes     only those of the store's write prefix ; the reference names the safe and object
//   a new account added on the store's platform ; an account there replaced only with overwrite :
//                 its user name patched, its password changed in the Vault only
//   the session   logged on as the store's API user (its method), logged off whatever happened
//   refusals      the logon, a new account without a platform - never with the password
import { test, describe, beforeAll, afterAll, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import http from "http";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

// the stores and the credentials by name
let storeRows = {};
let credentials = {};
vi.mock("../src/models/crud.model.js", () => ({
  default: class {
    static getCache() {
      return null;
    }
    static async findByName(modelName, name) {
      const rows = modelName === "credential" ? credentials : storeRows;
      return rows[name] ? { ...rows[name] } : undefined;
    }
    static async findAll() {
      return Object.values(storeRows);
    }
    static async findById() {
      return undefined;
    }
  },
}));

// the fake PVWA : its accounts, the requests it got, what the logon answers
let accounts = [];
const calls = [];
let logonStatus = 200;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, data });
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/PasswordVault/API/auth/")) {
      res.statusCode = logonStatus;
      return res.end(JSON.stringify(logonStatus === 200 ? "pvwa-token" : { ErrorCode: "ITATS004E", ErrorMessage: "Authentication failure." }));
    }
    if (req.url === "/PasswordVault/API/Auth/Logoff") return res.end("{}");
    if (req.method === "GET" && req.url.startsWith("/PasswordVault/API/Accounts?")) {
      const q = new URL(req.url, "http://x").searchParams;
      const safe = q.get("filter").replace(/^safeName eq /, "");
      return res.end(JSON.stringify({ value: accounts.filter((a) => a.safeName === safe && a.name.includes(q.get("search"))) }));
    }
    if (req.method === "POST" && req.url === "/PasswordVault/API/Accounts") {
      accounts.push({ id: `${accounts.length + 1}_1`, ...data });
      return res.end(JSON.stringify({ id: "new" }));
    }
    return res.end("{}");
  });
});

let url;
beforeAll(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

const Registry = await import("../src/secrets/providers/index.js");
const { writeTarget, withinWritePrefix, pvwaBase } = await import("../src/secrets/providers/cyberark_ccp.js");

const cyberarkRow = (over = {}) => ({
  id: 2,
  name: "cyberark",
  type: "cyberark_ccp",
  url,
  app_id: "AnsibleForms",
  write_enabled: 1,
  write_prefix: "Linux, DB",
  pvwa_url: `${url}/PasswordVault/`,
  pvwa_credential: "pvwa-api",
  pvwa_auth: "ldap",
  platform_id: "UnixSSH",
  ...over,
});
const LOGIN = { username: "root", password: "s3cret!" };
const REF = "Safe=Linux;Object=srv01-root;Address=srv01";

beforeEach(() => {
  storeRows = { cyberark: cyberarkRow() };
  credentials = { "pvwa-api": { name: "pvwa-api", user: "af-api", password: "api-pass" } };
  accounts = [];
  calls.length = 0;
  logonStatus = 200;
  Registry.clearSecretCache();
});

describe("where a CyberArk write goes", () => {
  test("the safe and the object of its reference ; only the safes of the store's prefix", () => {
    assert.deepEqual(writeTarget(REF), { safe: "Linux", object: "srv01-root", address: "srv01" });
    assert.throws(() => writeTarget("Object=x"), /Safe=<safe>;Object=<account name>/);
    const store = { write_prefix: "Linux, DB" };
    assert.equal(withinWritePrefix(store, "Safe=linux;Object=x"), true);
    assert.equal(withinWritePrefix(store, "Safe=Windows;Object=x"), false);
    assert.equal(pvwaBase({ pvwa_url: "https://pvwa.example.com/PasswordVault/" }), "https://pvwa.example.com");
  });

  test("a safe outside the prefix : refused, the PVWA never asked", async () => {
    await assert.rejects(Registry.writeSecret("cyberark", "Safe=Windows;Object=x", LOGIN), /outside what secret store 'cyberark' may write to/);
    assert.equal(calls.length, 0);
  });
});

describe("writing", () => {
  test("a new account : logged on as the API user (LDAP), added on the platform, logged off", async () => {
    const done = await Registry.writeSecret("cyberark", REF, LOGIN);
    assert.equal(done.replaced, false);
    const logon = calls.find((c) => c.url.startsWith("/PasswordVault/API/auth/"));
    assert.equal(logon.url, "/PasswordVault/API/auth/LDAP/Logon");
    assert.deepEqual(logon.data, { username: "af-api", password: "api-pass", concurrentSession: true });
    const add = calls.find((c) => c.method === "POST" && c.url === "/PasswordVault/API/Accounts");
    assert.equal(add.auth, "pvwa-token");
    assert.deepEqual(add.data, { name: "srv01-root", safeName: "Linux", platformId: "UnixSSH", address: "srv01", userName: "root", secretType: "password", secret: "s3cret!" });
    // the exists check and the write, each its own session, each logged off
    assert.equal(calls.filter((c) => c.url === "/PasswordVault/API/Auth/Logoff").length, 2);
  });

  test("an account there : refused without overwrite ; with it, its user name patched and its password changed in the Vault", async () => {
    accounts = [{ id: "12_3", name: "srv01-root", safeName: "Linux", userName: "old" }];
    await assert.rejects(Registry.writeSecret("cyberark", REF, LOGIN), (e) => e.status === 409 && e.code === "secretExists");
    calls.length = 0;
    const done = await Registry.writeSecret("cyberark", REF, LOGIN, { overwrite: true });
    assert.equal(done.replaced, true);
    const patch = calls.find((c) => c.method === "PATCH");
    assert.equal(patch.url, "/PasswordVault/API/Accounts/12_3");
    assert.deepEqual(patch.data, [{ op: "replace", path: "/userName", value: "root" }]);
    const update = calls.find((c) => c.url === "/PasswordVault/API/Accounts/12_3/Password/Update");
    assert.deepEqual(update.data, { ChangeEntireGroup: false, NewCredentials: "s3cret!" });
  });

  test("a new account without a platform : refused, logged off", async () => {
    storeRows.cyberark = cyberarkRow({ platform_id: "" });
    await assert.rejects(Registry.writeSecret("cyberark", REF, LOGIN), /no platform for new accounts/);
    assert.ok(calls.some((c) => c.url === "/PasswordVault/API/Auth/Logoff"));
  });

  test("the logon refused : said with the API user and the PVWA's answer, never a password", async () => {
    logonStatus = 401;
    await assert.rejects(Registry.writeSecret("cyberark", REF, LOGIN), (e) => {
      assert.match(e.message, /refused the logon of 'af-api' \(LDAP, HTTP 401: ITATS004E Authentication failure\.\)/);
      assert.doesNotMatch(e.message, /api-pass|s3cret/);
      return true;
    });
  });
});
