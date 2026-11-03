// Writing a credential's secret to a secret store (secrets/providers writeSecret, the Vault
// provider's write) : against a fake Vault on a local port.
//   the rules    writing on, a write prefix, the path below it, KV v1 and v2 bodies
//   overwrite    a secret there replaced only when asked (409 secretExists otherwise)
//   refusals     a dynamic engine's path, the token's policy (403) - said with the path, never
//                the secret
//   the cache    the next read gets what was written
import { test, describe, beforeAll, afterAll, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import http from "http";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

let storeRows = {};
vi.mock("../src/models/crud.model.js", () => ({
  default: class {
    static getCache() {
      return null;
    }
    static async findByName(modelName, name) {
      return storeRows[name] ? { ...storeRows[name] } : undefined;
    }
    static async findAll() {
      return Object.values(storeRows);
    }
    static async findById() {
      return undefined;
    }
  },
}));

// the fake Vault : the secrets by API path, the writes recorded, a status to answer writes with
let secrets = {};
const writes = [];
let writeStatus = 200;
let readStatus = 200;
let readErrors = ["1 error occurred:\n\t* permission denied\n\n"];
let mountTypes = {};
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.startsWith("/v1/sys/internal/ui/mounts/")) {
    const mount = decodeURIComponent(req.url.slice("/v1/sys/internal/ui/mounts/".length));
    if (!(mount in mountTypes)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ errors: [] }));
    }
    return res.end(JSON.stringify({ data: { type: mountTypes[mount] } }));
  }
  const path = req.url.replace(/^\/v1\//, "");
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      writes.push({ path, body: JSON.parse(body || "{}") });
      res.statusCode = writeStatus;
      if (writeStatus !== 200) return res.end(JSON.stringify({ errors: ["permission denied"] }));
      const parsed = JSON.parse(body || "{}");
      secrets[path] = path.includes("/data/") ? { data: { data: parsed.data } } : { data: parsed };
      res.end(JSON.stringify({ data: {} }));
    });
    return;
  }
  if (readStatus !== 200) {
    res.statusCode = readStatus;
    return res.end(JSON.stringify({ errors: readErrors }));
  }
  if (!(path in secrets)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ errors: [] }));
  }
  return res.end(JSON.stringify(secrets[path]));
});

let url;
beforeAll(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

const Registry = await import("../src/secrets/providers/index.js");
const { logicalPath, withinWritePrefix, clearMountTypeCache } = await import("../src/secrets/providers/vault.js");

const vaultRow = (over = {}) => ({
  id: 1,
  name: "vault",
  type: "vault",
  url,
  token: "hvs.test",
  kv_version: 2,
  default_mount: "secret",
  cache_ttl_seconds: 60,
  write_enabled: 1,
  write_prefix: "secret/ansibleforms",
  ...over,
});
const LOGIN = { username: "svc-db", password: "s3cret!" };

beforeEach(() => {
  storeRows = { vault: vaultRow() };
  secrets = {};
  writes.length = 0;
  writeStatus = 200;
  readStatus = 200;
  readErrors = ["1 error occurred:\n\t* permission denied\n\n"];
  mountTypes = {};
  clearMountTypeCache();
  Registry.clearSecretCache();
});

describe("the write prefix", () => {
  test("paths compared as written below their mount, whatever the KV version", () => {
    assert.equal(logicalPath("secret/data/ansibleforms/db/", "secret"), "secret/ansibleforms/db");
    assert.equal(logicalPath("db", "kv"), "kv/db");
    const store = { write_prefix: "secret/ansibleforms/", default_mount: "secret" };
    assert.equal(withinWritePrefix(store, "secret/ansibleforms/db"), true);
    assert.equal(withinWritePrefix(store, "secret/data/ansibleforms/db"), true);
    assert.equal(withinWritePrefix(store, "secret/ansibleforms"), true);
    assert.equal(withinWritePrefix(store, "secret/ansibleforms-other/db"), false);
    assert.equal(withinWritePrefix(store, "secret/teams/db"), false);
    assert.equal(withinWritePrefix({ write_prefix: "" }, "secret/x"), false);
    // a prefix of one segment : the whole mount, the default one or another
    assert.equal(withinWritePrefix({ write_prefix: "secret", default_mount: "secret" }, "secret/teams/db"), true);
    assert.equal(withinWritePrefix({ write_prefix: "secret/", default_mount: "secret" }, "db"), true);
    assert.equal(withinWritePrefix({ write_prefix: "kv", default_mount: "secret" }, "secret/db"), false);
  });

  test("refused without writing on, without a prefix, or outside it - Vault never asked", async () => {
    storeRows.vault = vaultRow({ write_enabled: 0 });
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), /does not allow writing/);
    storeRows.vault = vaultRow({ write_prefix: "" });
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), /has no write prefix/);
    storeRows.vault = vaultRow();
    await assert.rejects(Registry.writeSecret("vault", "secret/teams/db", LOGIN), /outside what secret store 'vault' may write to/);
    assert.equal(writes.length, 0);
  });
});

describe("writing", () => {
  test("KV v2 : the pairs under data, at the data path ; read back from the store", async () => {
    const done = await Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN);
    assert.deepEqual(done, { store: "vault", ref: "secret/ansibleforms/db", replaced: false });
    assert.deepEqual(writes, [{ path: "secret/data/ansibleforms/db", body: { data: LOGIN } }]);
    const read = await Registry.readSecret("vault", "secret/ansibleforms/db");
    assert.deepEqual(Registry.mapPayloadToCredential(read), { ...LOGIN, user: "svc-db", password: "s3cret!" });
  });

  test("KV v1 : the pairs as they are", async () => {
    storeRows.vault = vaultRow({ kv_version: 1 });
    await Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN);
    assert.deepEqual(writes, [{ path: "secret/ansibleforms/db", body: LOGIN }]);
  });

  test("a secret there : refused (secretExists) unless overwrite is asked ; the new one read after", async () => {
    secrets["secret/data/ansibleforms/db"] = { data: { data: { username: "old", password: "old" } } };
    await Registry.readSecret("vault", "secret/ansibleforms/db");
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), (e) => e.status === 409 && e.code === "secretExists");
    assert.equal(writes.length, 0);
    const done = await Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN, { overwrite: true });
    assert.equal(done.replaced, true);
    // the cache emptied : the new password, not the one read before
    assert.equal((await Registry.readSecret("vault", "secret/ansibleforms/db")).password, "s3cret!");
  });

  test("a dynamic engine's path is never written", async () => {
    storeRows.vault = vaultRow({ write_prefix: "database/creds" });
    mountTypes.database = "database";
    await assert.rejects(Registry.writeSecret("vault", "database/creds/app", LOGIN), /dynamic secret engine/);
    assert.equal(writes.length, 0);
  });

  test("the token's policy refusing : said with the path and the capabilities, never the secret", async () => {
    writeStatus = 403;
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), (e) => {
      assert.match(e.message, /refused to write secret\/data\/ansibleforms\/db \(403\).*read, create and update/);
      assert.doesNotMatch(e.message, /s3cret/);
      return true;
    });
  });

  test("Vault's answers said plainly : a token revoked, no secret there, Vault unreachable", async () => {
    readStatus = 403;
    readErrors = ["2 errors occurred:\n\t* permission denied\n\t* invalid token\n\n"];
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), /refused the token of secret store 'vault': it is invalid, expired or revoked/);
    readStatus = 200;
    await assert.rejects(Registry.readSecret("vault", "secret/ansibleforms/none"), /No secret at secret\/data\/ansibleforms\/none in secret store 'vault'/);
    storeRows.vault = vaultRow({ url: "http://127.0.0.1:1" });
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), /Vault at http:\/\/127.0.0.1:1 could not be reached: ECONNREFUSED/);
  });

  test("the token's policy refusing the check before the write : said with the capabilities", async () => {
    readStatus = 403;
    await assert.rejects(Registry.writeSecret("vault", "secret/ansibleforms/db", LOGIN), (e) => {
      assert.match(e.message, /refused to read secret\/data\/ansibleforms\/db \(403\).*read, create and update/);
      return true;
    });
    assert.equal(writes.length, 0);
  });
});
