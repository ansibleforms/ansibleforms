'use strict';
// The Announcements type of the repository-backed objects (lib/repoObjects/engine.js) : one
// announcement under the header per YAML file in a repository's `announcements` folder, in the
// config seed's format (an item of its announcements section) : its name (what it is found by),
// message, type, switch, and when it starts and ends showing. An announcement made in the app has
// no name : it is written with the start of its message as one, and keeps it. A file whose end is
// past is not imported (said in the pull output, never refused) and the app's announcement of it
// goes ; the app's own clean-up of an ended announcement leaves its file in git as it is.
import mysql from "../../models/db.model.js";
import Announcement from "../../models/announcement.model.js";
import { seedType } from "./seedType.js";

const TABLE = "AnsibleForms.`announcements`";
const COLUMNS = "id, name, message, level, enabled, start_at, end_at, repository, repo_file";

/**
 * A moment as files write it : an ISO text in UTC, to the second.
 *
 * Args:
 *   v (any): a date, or a text (a stored one, UTC without its zone).
 *
 * Returns:
 *   string|null: the moment (2026-11-01T08:00:00Z), null for none.
 */
function isoMoment(v) {
  if (v === null || v === undefined || v === "") return null;
  const text = v instanceof Date ? v.toISOString() : String(v);
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(text) || v instanceof Date ? text : text.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? String(v) : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// written as the announcements page saves them
const AnnouncementModel = {
  create: (d) => Announcement.create(d, "repository"),
  update: (d, id) => Announcement.update(id, d),
  delete: (id) => Announcement.delete(id),
};

export default seedType({
  key: "announcements",
  folder: "announcements",
  section: "announcements",
  model: "announcement",
  table: TABLE,
  Model: AnnouncementModel,
  read: {
    all: async () => {
      await Announcement.purgeEnded();
      return mysql.do(`SELECT ${COLUMNS} FROM ${TABLE}`);
    },
    byId: async (id) => (await mysql.do(`SELECT ${COLUMNS} FROM ${TABLE} WHERE id = ?`, [id]))?.[0] || null,
  },
  title: "Announcements",
  noun: "announcement",
  // shown is the default : off is what a file says
  keepFalse: ["enabled"],
  // its moments as ISO texts in UTC, the file's and the stored ones alike
  canonical: (o) => ({ ...o, ...(o.start_at !== undefined ? { start_at: isoMoment(o.start_at) } : {}), ...(o.end_at !== undefined ? { end_at: isoMoment(o.end_at) } : {}) }),
  // ended : not imported, its file left in git as it is
  notImported: (o) => (o.end_at && Date.parse(o.end_at) <= Date.now() ? "already ended" : null),
  // one made in the app : the start of its message
  nameFor: (row) => String(row.message || "").replace(/\s+/g, " ").trim().slice(0, 40).trim() || `announcement ${row.id}`,
});
