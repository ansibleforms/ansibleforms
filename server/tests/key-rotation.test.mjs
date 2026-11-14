// ENCRYPTION_SECRET set by hand : every stored secret is re-encrypted with it on the next start
// (lib/keyRotation.js), from the public default the first time and from ENCRYPTION_SECRET_PREVIOUS
// after that, in one transaction ; a key that is neither changes nothing.
import { test, describe, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

// a database of a few tables, in memory : the rows keyRotation reads and writes
let tables;
let committed;
let failCheckWrite = false;
function run(sql, vars = []) {
  let m = sql.match(/^SELECT `(\w+)` AS k, `(\w+)` AS v FROM AnsibleForms\.`(\w+)`/);
  if (m) return (tables[m[3]] || []).filter((r) => r[m[2]]).map((r) => ({ k: r[m[1]], v: r[m[2]] }));
  m = sql.match(/^SELECT `(\w+)` AS v FROM AnsibleForms\.`(\w+)`/);
  if (m) return (tables[m[2]] || []).filter((r) => r[m[1]]).map((r) => ({ v: r[m[1]] }));
  if (/^SELECT encryption_check/.test(sql)) return [{ c: tables.settings[0].encryption_check ?? null }];
  if (/^UPDATE AnsibleForms\.`settings` SET encryption_check/.test(sql)) {
    if (failCheckWrite) throw new Error("connection lost");
    tables.settings[0].encryption_check = vars[0];
    return {};
  }
  m = sql.match(/^UPDATE AnsibleForms\.`(\w+)` SET `(\w+)` = \? WHERE `(\w+)` = \?/);
  if (m) {
    for (const r of tables[m[1]] || []) if (r[m[3]] === vars[1]) r[m[2]] = vars[0];
    return {};
  }
  throw new Error("unexpected query " + sql);
}
vi.mock("../src/models/db.model.js", () => ({
  default: {
    do: async (sql, vars) => run(sql, vars),
    // all or nothing : the writes land on a copy, kept only when the callback returns
    transaction: async (fn) => {
      const before = JSON.stringify(tables);
      try {
        const out = await fn(async (sql, vars) => run(sql, vars));
        committed = true;
        return out;
      } catch (e) {
        tables = JSON.parse(before);
        throw e;
      }
    },
  },
}));

const appConfig = (await import("./__mocks__/app.config.js")).default;
const crypto = (await import("../src/lib/crypto.js")).default;
const { rotateEncryptionKey, keyOfStore, readsAsText, secretColumns, CHECK_TEXT } = await import("../src/lib/keyRotation.js");

const key = (s) => ((s || "undefinedvOVH6sdmpNWjRRIqCc7rdxs") + "vOVH6sdmpNWjRRIqCc7rdxs01lwHzfr3").substring(0, 32);
const DEFAULT = key("");
const OLD = key("old-secret-of-the-admin");
const NEW = key("new-secret-of-the-admin");
const read = (k, v) => crypto.decryptWith(k, v).toString("utf8");

function storeWith(k) {
  tables = {
    credentials: [
      { id: 1, password: crypto.encryptWith(k, "s3cret-password"), client_key: "" },
      { id: 2, password: crypto.encryptWith(k, "another one, with spaces and ünïcode") },
    ],
    runners: [{ id: 7, token: crypto.encryptWith(k, "rte-token-1234"), password: null }],
    settings: [{ encryption_check: null }],
    chat_settings: [{ api_key: "" }],
  };
}

beforeEach(() => {
  committed = false;
  failCheckWrite = false;
  appConfig.encryptionSecretDefault = DEFAULT;
  appConfig.encryptionSecretPrevious = null;
});

describe("the columns that hold a secret", () => {
  test("every isEncrypted field of crud.config.js and the chat key, not the mail password of before 7.6", () => {
    const names = secretColumns().map((c) => `${c.table}.${c.column}`);
    for (const n of ["credentials.password", "credentials.client_key", "runners.token", "runners.password", "secret_stores.token",
      "repositories.password", "ldap.bind_user_pw", "oauth2_providers.client_secret", "notification_channels.webhook_url",
      "chat_settings.api_key"]) {
      assert.ok(names.includes(n), n);
    }
    // the settings' mail columns are dropped in 7.6 : reading them would fail the rotation
    assert.ok(!names.includes("settings.mail_password"));
  });
});

describe("which key the store was encrypted with", () => {
  test("text reads as text, a wrong key's bytes do not", () => {
    const v = crypto.encryptWith(OLD, "a password of some length");
    assert.equal(readsAsText(crypto.decryptWith(OLD, v)), true);
    assert.equal(readsAsText(crypto.decryptWith(NEW, v)), false);
  });

  test("the check value names it ; one that matches no key gives none", () => {
    const keys = [{ name: "new", key: NEW }, { name: "default", key: DEFAULT }];
    assert.equal(keyOfStore(crypto.encryptWith(DEFAULT, CHECK_TEXT), [], keys).name, "default");
    assert.equal(keyOfStore(crypto.encryptWith(OLD, CHECK_TEXT), [], keys), null);
  });
});

describe("setting ENCRYPTION_SECRET re-encrypts every stored secret", () => {
  test("the first time : from the default key, nothing lost", async () => {
    storeWith(DEFAULT);
    appConfig.encryptionSecret = NEW;
    const out = await rotateEncryptionKey();
    assert.equal(out.changed, 3);
    assert.equal(committed, true);
    assert.equal(read(NEW, tables.credentials[0].password), "s3cret-password");
    assert.equal(read(NEW, tables.credentials[1].password), "another one, with spaces and ünïcode");
    assert.equal(read(NEW, tables.runners[0].token), "rte-token-1234");
    assert.equal(read(NEW, tables.settings[0].encryption_check), CHECK_TEXT);
  });

  test("the next start changes nothing", async () => {
    storeWith(DEFAULT);
    appConfig.encryptionSecret = NEW;
    await rotateEncryptionKey();
    const after = JSON.stringify(tables);
    committed = false;
    assert.deepEqual(await rotateEncryptionKey(), { changed: 0 });
    assert.equal(JSON.stringify(tables), after);
    assert.equal(committed, false);
  });

  test("a key of the admin's to another : from ENCRYPTION_SECRET_PREVIOUS", async () => {
    storeWith(DEFAULT);
    appConfig.encryptionSecret = OLD;
    await rotateEncryptionKey();
    appConfig.encryptionSecret = NEW;
    appConfig.encryptionSecretPrevious = OLD;
    assert.equal((await rotateEncryptionKey()).changed, 3);
    assert.equal(read(NEW, tables.runners[0].token), "rte-token-1234");
  });

  test("changed again without ENCRYPTION_SECRET_PREVIOUS : nothing is touched, the log says what to set", async () => {
    storeWith(DEFAULT);
    appConfig.encryptionSecret = OLD;
    await rotateEncryptionKey();
    const before = JSON.stringify(tables);
    appConfig.encryptionSecret = NEW;
    assert.deepEqual(await rotateEncryptionKey(), { unknownKey: true });
    assert.equal(JSON.stringify(tables), before);
  });

  test("an install that set its key from the start gets its check value, nothing re-encrypted", async () => {
    storeWith(NEW);
    appConfig.encryptionSecret = NEW;
    assert.deepEqual(await rotateEncryptionKey(), { changed: 0 });
    assert.equal(read(NEW, tables.credentials[0].password), "s3cret-password");
    assert.equal(read(NEW, tables.settings[0].encryption_check), CHECK_TEXT);
  });

  test("a write that fails part way leaves every secret as it was", async () => {
    storeWith(DEFAULT);
    appConfig.encryptionSecret = NEW;
    const before = JSON.stringify(tables);
    // the secrets are written, then the check value fails : all of it is rolled back
    failCheckWrite = true;
    await assert.rejects(rotateEncryptionKey(), /connection lost/);
    assert.equal(JSON.stringify(tables), before);
    assert.equal(read(DEFAULT, tables.credentials[0].password), "s3cret-password");
  });
});
