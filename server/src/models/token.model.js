'use strict';
import mysql from "./db.model.js";
import logger from "../lib/logger.js";

var Token = function(){};

Token.store = function (username, username_type, refresh_token) {
  var record = {};
  record.username = username;
  record.username_type = username_type;
  record.refresh_token = refresh_token;
  logger.info(`Adding token for ${record.username} (${record.username_type})`);
  return mysql.do("INSERT INTO AnsibleForms.`tokens` set ?", record);
};

Token.delete = function (username, username_type, refresh_token) {
  // never the token itself : it is a credential, and the log is read, downloaded and shipped to syslog
  logger.info(`Deleting token for user ${username} (${username_type})`);
  return mysql.do("DELETE FROM AnsibleForms.`tokens` WHERE username=? AND username_type=? AND refresh_token=?", [username, username_type, refresh_token]);
};

Token.deleteAllForUser = function (username) {
  logger.info(`Deleting all tokens for user ${username}`);
  return mysql.do("DELETE FROM AnsibleForms.`tokens` WHERE username=?", [username]);
};

/**
 * Deletes the tokens older than a month, and the ones replaced by a refresh longer ago than the
 * grace (REPLACED_GRACE_SECONDS) : the daily token cleanup (Jobs > System).
 *
 * Returns:
 *   Promise<number>: the tokens deleted.
 *
 * Raises:
 *   Error: when the database refuses the delete (logged here, recorded by the cleanup's run).
 */
Token.cleanup = async function () {
  logger.info(`Deleting tokens older than a month, and the ones replaced by a refresh`);
  try {
    const res = await mysql.do("DELETE FROM AnsibleForms.`tokens` WHERE timestamp < NOW() - INTERVAL 30 DAY OR replaced_at < UTC_TIMESTAMP() - INTERVAL ? SECOND", [Token.REPLACED_GRACE_SECONDS]);
    logger.notice("Cleanup tokens finished");
    return res?.affectedRows || 0;
  } catch (err) {
    logger.error("Cleanup tokens failed. " + err);
    throw err;
  }
};

// replaced_at is written and compared in UTC : NOW() follows the database's time zone, and a
// clock change there would stretch the grace by an hour.
// How long a refresh token replaced by a refresh is still recognised as just replaced. A page
// has several requests in flight when its access token expires, and other tabs share its tokens
// (#1062) : the first refresh wins, the others arrive with the token it replaced. Inside this
// grace they are told so (409, the client then reads the tokens the winner stored) ; after it
// the token is unknown, as a reused single-use token should be.
Token.REPLACED_GRACE_SECONDS = 30;

// What the tokens table says of a refresh token : 'valid', 'replaced' (by a refresh, inside the
// grace) or 'unknown' (never stored, logged out, or replaced longer ago)
Token.check = function (username, username_type, refresh_token) {
  logger.debug(`Checking token for user ${username} (${username_type})`);
  return mysql
    .do(
      "SELECT replaced_at IS NULL AS current, replaced_at > UTC_TIMESTAMP() - INTERVAL ? SECOND AS recent FROM AnsibleForms.`tokens` WHERE username=? AND username_type=? AND refresh_token=? LIMIT 1",
      [Token.REPLACED_GRACE_SECONDS, username, username_type, refresh_token]
    )
    .then((res) => {
      const row = res?.[0];
      if (!row) return "unknown";
      if (Number(row.current)) return "valid";
      return Number(row.recent) ? "replaced" : "unknown";
    });
};

// Rotates a refresh token : the old one is marked replaced, the new one stored. The mark is taken
// with a conditional update, so of two refreshes with the same token only one rotates it ; the
// other gets false and is answered as a concurrent refresh. A failure storing the new token gives
// the old one back, so it cannot leave the user with no usable token at all.
Token.replace = async function (username, username_type, old_refresh_token, new_refresh_token) {
  const claim = await mysql.do(
    "UPDATE AnsibleForms.`tokens` SET replaced_at=UTC_TIMESTAMP() WHERE username=? AND username_type=? AND refresh_token=? AND replaced_at IS NULL",
    [username, username_type, old_refresh_token]
  );
  if (!claim?.affectedRows) return false;
  try {
    await Token.store(username, username_type, new_refresh_token);
  } catch (err) {
    await mysql
      .do("UPDATE AnsibleForms.`tokens` SET replaced_at=NULL WHERE username=? AND username_type=? AND refresh_token=?", [username, username_type, old_refresh_token])
      .catch(() => {});
    throw err;
  }
  // the user's tokens replaced longer ago than the grace serve nothing any more
  await mysql
    .do("DELETE FROM AnsibleForms.`tokens` WHERE username=? AND username_type=? AND replaced_at < UTC_TIMESTAMP() - INTERVAL ? SECOND", [username, username_type, Token.REPLACED_GRACE_SECONDS])
    .catch((err) => logger.warning(`Could not remove replaced tokens for ${username} (${username_type}): ${err}`));
  return true;
};

export default Token;
