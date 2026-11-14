/******************************************************************/
/*                                                                */
/*  The key the stored secrets are encrypted with                 */
/*  (ENCRYPTION_SECRET)                                           */
/*                                                                */
/*  An admin sets ENCRYPTION_SECRET by hand. When it changes (the */
/*  first time from the public default, later from a key named in */
/*  ENCRYPTION_SECRET_PREVIOUS), every stored secret is           */
/*  re-encrypted with it on the next start, in one transaction :  */
/*  nothing is lost and nothing is half done.                     */
/*                                                                */
/*  AES-CTR never fails on a wrong key, it gives other bytes, so  */
/*  which key a value was encrypted with is known from a check    */
/*  value (settings.encryption_check : a known text encrypted     */
/*  with it), or, before there is one, from the secrets           */
/*  themselves : the key they read back as text with.             */
/*                                                                */
/******************************************************************/
import mysql from "../models/db.model.js";
import crypto from "./crypto.js";
import logger from "./logger.js";
import appConfig from "../../config/app.config.js";
import crudConfigs from "../../config/crud.config.js";

// the text the check value holds
export const CHECK_TEXT = "AnsibleForms encryption key check";

/**
 * Every column that holds an encrypted secret : those crud.config.js marks isEncrypted (by the
 * row's id), and the single-row tables' (by the value itself).
 *
 * Returns:
 *   object[]: { table, column, key } ; key the id column, or null for a single-row table.
 */
export function secretColumns() {
  const columns = [];
  for (const config of Object.values(crudConfigs)) {
    const table = String(config.table || "").replace(/^AnsibleForms\./, "");
    for (const field of config.fields || []) {
      if (field.isEncrypted) columns.push({ table, column: field.name, key: "id" });
    }
  }
  columns.push({ table: "chat_settings", column: "api_key", key: null });
  return columns;
}

/**
 * Whether bytes read back as a stored secret would : text, no control characters but line ends
 * and tabs. A value decrypted with a wrong key is random bytes, which almost never are.
 *
 * Args:
 *   bytes (Buffer): a decrypted value.
 *
 * Returns:
 *   boolean: true when it reads as text.
 */
export function readsAsText(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return false; // not valid utf-8
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // line ends and tabs are text ; any other control character, or a replacement mark, is not
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127 || code === 0xfffd) return false;
  }
  return true;
}

const ENCRYPTED = /^[0-9a-f]+\.[0-9a-f]{32}$/;

/**
 * Which of the keys the stored secrets were encrypted with : from the check value, else the one
 * most of them read back as text with (the current key on a tie, or when there are none).
 *
 * Args:
 *   check (string|null): the stored check value.
 *   values (string[]): the stored secrets.
 *   keys (object[]): { name, key } to try, the current one first.
 *
 * Returns:
 *   object|null: the key found ; null when the check value matches none of them.
 */
export function keyOfStore(check, values, keys) {
  const opens = (key, value) => {
    try {
      return crypto.decryptWith(key, value);
    } catch {
      return null;
    }
  };
  if (check) return keys.find((k) => opens(k.key, check)?.toString("utf8") === CHECK_TEXT) || null;
  const encrypted = values.filter((v) => ENCRYPTED.test(String(v || "")));
  if (!encrypted.length) return keys[0];
  const score = (k) => encrypted.filter((v) => {
    const bytes = opens(k.key, v);
    return bytes && readsAsText(bytes);
  }).length;
  let best = keys[0];
  let bestScore = score(best);
  for (const k of keys.slice(1)) {
    const s = score(k);
    if (s > bestScore) {
      best = k;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Re-encrypts the stored secrets with ENCRYPTION_SECRET when they were encrypted with another
 * key (the public default, or ENCRYPTION_SECRET_PREVIOUS), in one transaction, and keeps the
 * check value up to date. Run by the worker at start, before anything writes a secret.
 *
 * Returns:
 *   Promise<object>: { changed: number } the secrets re-encrypted, or { unknownKey: true } when
 *     they were encrypted with a key that is not given (nothing is touched then).
 */
export async function rotateEncryptionKey() {
  const current = { name: appConfig.encryptionSecret === appConfig.encryptionSecretDefault ? "the default key" : "ENCRYPTION_SECRET", key: appConfig.encryptionSecret };
  const keys = [current];
  if (appConfig.encryptionSecretPrevious && appConfig.encryptionSecretPrevious !== current.key) {
    keys.push({ name: "ENCRYPTION_SECRET_PREVIOUS", key: appConfig.encryptionSecretPrevious });
  }
  if (appConfig.encryptionSecretDefault !== current.key) {
    keys.push({ name: "the default key", key: appConfig.encryptionSecretDefault });
  }

  const columns = secretColumns();
  const rows = [];
  for (const c of columns) {
    const found = await mysql.do(
      c.key
        ? `SELECT \`${c.key}\` AS k, \`${c.column}\` AS v FROM AnsibleForms.\`${c.table}\` WHERE COALESCE(\`${c.column}\`, '') <> ''`
        : `SELECT \`${c.column}\` AS v FROM AnsibleForms.\`${c.table}\` WHERE COALESCE(\`${c.column}\`, '') <> ''`,
    );
    for (const r of found || []) rows.push({ ...c, id: r.k, value: r.v });
  }
  const check = (await mysql.do("SELECT encryption_check AS c FROM AnsibleForms.`settings` LIMIT 1"))?.[0]?.c || null;

  const from = keyOfStore(check, rows.map((r) => r.value), keys);
  if (!from) {
    logger.error(
      "[SECURITY] The stored secrets were encrypted with a key that is not ENCRYPTION_SECRET: set ENCRYPTION_SECRET_PREVIOUS to the key they were encrypted with, and they are re-encrypted with ENCRYPTION_SECRET on the next start. Nothing was changed.",
    );
    return { unknownKey: true };
  }
  if (from === current) {
    if (!check) await mysql.do("UPDATE AnsibleForms.`settings` SET encryption_check = ?", [crypto.encryptWith(current.key, CHECK_TEXT)]);
    return { changed: 0 };
  }

  const changed = await mysql.transaction(async (run) => {
    let n = 0;
    for (const r of rows) {
      if (!ENCRYPTED.test(String(r.value))) continue; // not one of ours (an old plain value)
      const plain = crypto.decryptWith(from.key, r.value).toString("utf8");
      const again = crypto.encryptWith(current.key, plain);
      if (r.key) await run(`UPDATE AnsibleForms.\`${r.table}\` SET \`${r.column}\` = ? WHERE \`${r.key}\` = ?`, [again, r.id]);
      else await run(`UPDATE AnsibleForms.\`${r.table}\` SET \`${r.column}\` = ? WHERE \`${r.column}\` = ?`, [again, r.value]);
      n++;
    }
    await run("UPDATE AnsibleForms.`settings` SET encryption_check = ?", [crypto.encryptWith(current.key, CHECK_TEXT)]);
    return n;
  });
  logger.notice(`[SECURITY] Re-encrypted ${changed} stored secrets from ${from.name} with ${current.name}`);
  return { changed };
}
