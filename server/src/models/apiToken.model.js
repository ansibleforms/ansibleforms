// The API tokens issued (Profile > API token) : one row per token, under its session id (sid),
// so a user sees theirs and an admin a user's, with when each was made, when it ends and when it
// was last used, and either can revoke one. Revoking ends the token's session
// (lib/tokenRevocation.js) ; the row goes with it. A token ended another way (a password change,
// its user blocked) is no longer listed : isRevoked says so.
// the database on first use : the jwt strategy loads this module, and must load without one
// (lib/tokenRevocation.js does the same)
const db = async () => (await import("./db.model.js")).default;
import { isRevoked, revokeSession } from "../lib/tokenRevocation.js";
import logger from "../lib/logger.js";

// a token's last use is written at most this often (ms) : not once per request
const TOUCH_EVERY_MS = 60 * 1000;
const touched = new Map();

const ApiToken = {};

/**
 * Records a token just issued.
 *
 * Args:
 *   token (object): { sid, username, type, name, createdAt (Date), expiresAt (Date) }.
 *
 * Returns:
 *   Promise<void>: settles once stored.
 */
ApiToken.record = async function ({ sid, username, type, name, createdAt, expiresAt }) {
  await (await db()).do(
    "INSERT INTO AnsibleForms.`api_tokens` (sid, username, username_type, name, created_at, expires_at) VALUES (?,?,?,?,?,?)",
    [sid, String(username).slice(0, 250), type, name ? String(name).slice(0, 100) : null, createdAt, expiresAt]
  );
};

/**
 * Whether a row still stands for a token that works : not expired (the query), not ended by a
 * password change or a block of its user.
 */
async function live(row) {
  const payload = { sid: row.sid, iat: Math.floor(new Date(row.created_at).getTime() / 1000), user: { username: row.username, type: row.username_type } };
  return !(await isRevoked(payload));
}

/**
 * A user's tokens that still work, the newest first.
 *
 * Args:
 *   username (string): the username.
 *   type (string): local, ldap, azuread, oidc.
 *
 * Returns:
 *   Promise<object[]>: [{ sid, name, created_at, expires_at, last_used_at }].
 */
ApiToken.findForUser = async function (username, type) {
  const rows = await (await db()).do(
    "SELECT sid, username, username_type, name, created_at, expires_at, last_used_at FROM AnsibleForms.`api_tokens` " +
      "WHERE username_type = ? AND username = ? AND expires_at > UTC_TIMESTAMP() ORDER BY created_at DESC",
    [type, username]
  );
  const out = [];
  for (const row of rows || []) {
    if (await live(row)) out.push({ sid: row.sid, name: row.name, created_at: row.created_at, expires_at: row.expires_at, last_used_at: row.last_used_at });
  }
  return out;
};

/**
 * Revokes one of a user's tokens : its session ends at once, on every node.
 *
 * Args:
 *   sid (string): the token's session id.
 *   username (string): its user (a token of another user is not found).
 *   type (string): its user's type.
 *
 * Returns:
 *   Promise<boolean>: false when the user has no such token.
 */
ApiToken.revoke = async function (sid, username, type) {
  const rows = await (await db()).do(
    "SELECT sid, expires_at FROM AnsibleForms.`api_tokens` WHERE sid = ? AND username_type = ? AND username = ?",
    [String(sid), type, username]
  );
  if (!rows?.length) return false;
  // the column holds UTC, read as UTC by the driver : not UNIX_TIMESTAMP(), which reads it in the
  // database's own zone and ended the revocation hours early on a server not in UTC
  await revokeSession(rows[0].sid, new Date(rows[0].expires_at).getTime());
  await (await db()).do("DELETE FROM AnsibleForms.`api_tokens` WHERE sid = ?", [rows[0].sid]);
  touched.delete(rows[0].sid);
  return true;
};

/**
 * Notes a token's use : at most once a minute per token, and never in the request's way.
 *
 * Args:
 *   sid (string): the token's session id.
 */
ApiToken.touch = function (sid) {
  if (!sid) return;
  const now = Date.now();
  if (now - (touched.get(sid) || 0) < TOUCH_EVERY_MS) return;
  touched.set(sid, now);
  db()
    .then((mysql) => mysql.do("UPDATE AnsibleForms.`api_tokens` SET last_used_at = UTC_TIMESTAMP() WHERE sid = ?", [sid]))
    .catch((err) => logger.debug(`Could not note the use of an api token: ${err.message || err}`));
};

/**
 * Forgets the tokens that expired.
 *
 * Returns:
 *   Promise<number>: the tokens forgotten.
 *
 * Raises:
 *   Error: when the database refuses the delete (logged here, recorded by the daily token
 *     cleanup's run).
 */
ApiToken.purge = async function () {
  try {
    const res = await (await db()).do("DELETE FROM AnsibleForms.`api_tokens` WHERE expires_at < UTC_TIMESTAMP()");
    return res?.affectedRows || 0;
  } catch (err) {
    logger.debug(`Could not purge the expired api tokens: ${err.message || err}`);
    throw err;
  } finally {
    touched.clear();
  }
};

export default ApiToken;
