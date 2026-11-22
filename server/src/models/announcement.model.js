'use strict';
/******************************************************************/
/*                                                                */
/*  The announcements under the header (Settings > Appearance >   */
/*  Announcements) : a message, its type (info, warning, danger)  */
/*  whether it is enabled, and the moments it starts and ends showing. Several can show  */
/*  at once ; the public config carries those running now         */
/*  (routes/v2/app.routes.js). Once ended, one is deleted : the   */
/*  list keeps those to come and those showing only.              */
/*                                                                */
/******************************************************************/
import mysql from './db.model.js';
import Errors from '../lib/errors.js';

// ─── what an announcement may hold ───────────────────────────────────────────

// its types, as the page offers them
export const ANNOUNCEMENT_LEVELS = ['info', 'warning', 'danger'];
// the longest message kept (the column's size)
export const MAX_MESSAGE = 500;
// the longest name kept (the column's size)
export const MAX_NAME = 100;

/**
 * A moment as the database keeps it : UTC, YYYY-MM-DD HH:MM:SS.
 *
 * Args:
 *   value (string|Date|null): an ISO string with its zone, a Date, or none.
 *
 * Returns:
 *   string|null: the moment, or null when none.
 *
 * Raises:
 *   BadRequestError: a value that is no date.
 */
export function toDbMoment(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) throw new Errors.BadRequestError(`Not a date: ${value}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The fields of an announcement to write, checked : a message, a known type, an end after its
 * start.
 *
 * Args:
 *   data (object): what the page sent - message, level, enabled, start_at, end_at ; name (a seed's
 *     or a repository's announcement).
 *   partial (boolean): an update, where a field left out stays as it is.
 *
 * Returns:
 *   object: the columns to write.
 *
 * Raises:
 *   BadRequestError: no message, an unknown type, a date that is none, an end before its start
 *     or already past.
 */
export function announcementFields(data, partial = false) {
  const out = {};
  // step 0 : its name, when it has one (a seed's or a repository's announcement is named, so it
  // is found again ; one made in the app has none until a repository writes it)
  if (data.name !== undefined) out.name = String(data.name ?? '').trim().slice(0, MAX_NAME) || null;
  // step 1 : the message, trimmed and cut to its column
  if (!partial || data.message !== undefined) {
    const message = String(data.message ?? '').trim();
    if (!message) throw new Errors.BadRequestError('Missing required field: message');
    out.message = message.slice(0, MAX_MESSAGE);
  }
  // step 2 : its type, info when none is given
  if (!partial || data.level !== undefined) {
    const level = data.level || 'info';
    if (!ANNOUNCEMENT_LEVELS.includes(level)) throw new Errors.BadRequestError(`Unknown type: ${level}`);
    out.level = level;
  }
  // step 3 : enabled, unless switched off
  if (!partial || data.enabled !== undefined) {
    out.enabled = data.enabled === false || data.enabled === 0 || data.enabled === '0' ? 0 : 1;
  }
  // step 4 : its start and its end, each optional
  if (!partial || data.start_at !== undefined) out.start_at = toDbMoment(data.start_at);
  if (!partial || data.end_at !== undefined) out.end_at = toDbMoment(data.end_at);
  if (out.start_at && out.end_at && out.end_at <= out.start_at) {
    throw new Errors.BadRequestError('The end must come after the start');
  }
  // an end already past : it would be deleted at once
  if (out.end_at && out.end_at <= toDbMoment(new Date())) {
    throw new Errors.BadRequestError('The end must be in the future');
  }
  return out;
}

/**
 * A moment of the database as epoch ms : a Date (the driver's), or a string, UTC when it
 * carries no zone.
 *
 * Args:
 *   value (Date|string|null): the moment.
 *
 * Returns:
 *   number|null: epoch ms, or null when none.
 */
function epochOf(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  return new Date(hasZone ? text : text.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Whether an announcement shows at a moment : started (or no start) and not ended (or no end).
 *
 * Args:
 *   a (object): the announcement, its start_at and end_at as Dates, strings or null.
 *   now (number): the moment, epoch ms.
 *
 * Returns:
 *   boolean: true while it runs.
 */
export function isRunning(a, now = Date.now()) {
  const start = epochOf(a.start_at);
  const end = epochOf(a.end_at);
  if (start !== null && start > now) return false;
  if (end !== null && end <= now) return false;
  return true;
}

// ─── the table ──────────────────────────────────────────────────────────────

// its name, and the announcements repository and file it comes from (lib/repoObjects), with the rest
const COLUMNS = 'id, name, message, level, enabled, start_at, end_at, created_by, created_at, repository, repo_file';

const Announcement = {
  /**
   * Deletes those that ended : read before every list, so an ended one is never shown nor
   * listed, on whichever node reads first.
   */
  async purgeEnded() {
    await mysql.do('DELETE FROM AnsibleForms.`announcements` WHERE end_at IS NOT NULL AND end_at <= UTC_TIMESTAMP()');
  },

  /**
   * Every announcement not ended (those ended are deleted first), the latest first.
   *
   * Returns:
   *   Promise<object[]>: the announcements, each with its title.
   */
  async findAll() {
    await this.purgeEnded();
    // its title : the start of its message, what the list's delete dialog names it by
    return mysql.do(
      `SELECT ${COLUMNS}, LEFT(message, 60) AS title FROM AnsibleForms.\`announcements\` ORDER BY COALESCE(start_at, created_at) DESC, id DESC`,
    );
  },

  /**
   * One announcement.
   *
   * Args:
   *   id (number|string): its id.
   *
   * Returns:
   *   Promise<object>: the announcement.
   *
   * Raises:
   *   NotFoundError: no announcement has that id.
   */
  async findById(id) {
    const res = await mysql.do(`SELECT ${COLUMNS} FROM AnsibleForms.\`announcements\` WHERE id = ?`, [id]);
    if (!res.length) throw new Errors.NotFoundError(`No announcement with id ${id}`);
    return res[0];
  },

  /**
   * Those enabled and not ended yet, for the public config : which run now is decided per request, so one
   * scheduled to start shows without a save.
   *
   * Returns:
   *   Promise<object[]>: { message, level, start_at, end_at } of each, the latest first.
   */
  async findNotEnded() {
    await this.purgeEnded();
    return mysql.do(
      'SELECT id, message, level, start_at, end_at FROM AnsibleForms.`announcements` WHERE enabled = 1 AND (end_at IS NULL OR end_at > UTC_TIMESTAMP()) ORDER BY COALESCE(start_at, created_at) DESC, id DESC',
    );
  },

  /**
   * Adds an announcement.
   *
   * Args:
   *   data (object): message, level, enabled, start_at, end_at.
   *   user (string): who adds it.
   *
   * Returns:
   *   Promise<number>: its id.
   */
  async create(data, user) {
    const fields = announcementFields(data);
    fields.created_by = user || null;
    fields.created_at = toDbMoment(new Date());
    const res = await mysql.do('INSERT INTO AnsibleForms.`announcements` SET ?', fields);
    return res.insertId;
  },

  /**
   * Changes an announcement : the fields given.
   *
   * Args:
   *   id (number|string): its id.
   *   data (object): message, level, enabled, start_at, end_at.
   *
   * Raises:
   *   NotFoundError: no announcement has that id.
   */
  async update(id, data) {
    const current = await this.findById(id);
    const fields = announcementFields(data, true);
    // an end before the start kept : checked against the stored one too
    const start = fields.start_at !== undefined ? fields.start_at : current.start_at && toDbMoment(current.start_at);
    const end = fields.end_at !== undefined ? fields.end_at : current.end_at && toDbMoment(current.end_at);
    if (start && end && end <= start) throw new Errors.BadRequestError('The end must come after the start');
    if (!Object.keys(fields).length) return;
    await mysql.do('UPDATE AnsibleForms.`announcements` SET ? WHERE id = ?', [fields, id]);
  },

  /**
   * Deletes an announcement.
   *
   * Args:
   *   id (number|string): its id.
   *
   * Raises:
   *   NotFoundError: no announcement has that id.
   */
  async delete(id) {
    await this.findById(id);
    await mysql.do('DELETE FROM AnsibleForms.`announcements` WHERE id = ?', [id]);
  },
};

export default Announcement;
