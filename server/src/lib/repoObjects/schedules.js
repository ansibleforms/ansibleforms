'use strict';
// The Schedules type of the repository-backed objects (lib/repoObjects/engine.js) : one schedule per
// YAML file in a repository's `schedules` folder, read by lib/scheduleFiles.js (its own format, the
// export form of one schedule), timed by its iCal rrule (lib/scheduleRrule.js), run as the Schedule
// Service as every recurring schedule. What is the schedules' own is here : how a file reads (its
// form must exist), how a row is stored, which app schedules a repository takes (the recurring
// ones : a cron is written as the rrule that fires at the same moments ; the crons a rrule cannot
// express and the one-time "Run later" jobs stay in the app). Making a schedule in the app, editing
// and deleting it go through models/scheduleRepo.model.js.
import YAML from "yaml";
import logger from "../logger.js";
import mysql from "../../models/db.model.js";
import Form from "../../models/form.model.js";
import { SCHEDULES_FOLDER, parseScheduleFile, newScheduleFile, extraDataOf } from "../scheduleFiles.js";
import { validateRrule, normalizeRrule } from "../scheduleRrule.js";
import { cronToRrule } from "../cronToRrule.js";
import logConfig from "../../../config/log.config.js";
import { linkStore, classifyRow } from "./engine.js";

// the schedule table
const TABLE = "AnsibleForms.`schedule`";

// ===========================================================================
// HELPERS
// ===========================================================================

/**
 * Extra data as the schedule table keeps them : YAML text, empty for none.
 *
 * Args:
 *   data (object): the extra data.
 *
 * Returns:
 *   string: the text.
 */
export function extraVarsText(data) {
  return data && Object.keys(data).length ? YAML.stringify(data, { lineWidth: 0 }) : "";
}

/**
 * Launch options as the schedule table keeps them : JSON, empty for none.
 *
 * Args:
 *   options (object): the reserved extra vars.
 *
 * Returns:
 *   string: the text.
 */
export function launchOptionsText(options) {
  return options && Object.keys(options).length ? JSON.stringify(options) : "";
}

/**
 * The names of the forms there are, to check the form a schedule runs ; null when they cannot be
 * read (the schedule is then taken, its launch says so if the form is missing).
 *
 * Returns:
 *   Promise<Set<string>|null>: the names.
 */
export async function formNames() {
  try {
    const config = await Form.load(["admin"]);
    return new Set((config?.forms || []).map((f) => f.name));
  } catch (e) {
    logger.warning(`The forms could not be read to check the forms of the schedules: ${e.message || e}`);
    return null;
  }
}

/**
 * A schedule of a file as the schedule table keeps it.
 *
 * Args:
 *   s (object): the schedule, as lib/scheduleFiles.js reads it.
 *
 * Returns:
 *   object: { name, description, form, rrule, enabled, extra_vars, launch_options }.
 */
function valuesOf(s) {
  return {
    name: s.name,
    description: s.description,
    form: s.form,
    rrule: s.rrule,
    enabled: s.enabled ? 1 : 0,
    extra_vars: extraVarsText(s.extraData),
    launch_options: launchOptionsText(s.launchOptions),
  };
}

// ===========================================================================
// THE DESCRIPTOR
// ===========================================================================

const links = linkStore(TABLE);

const schedules = {
  key: "schedules",
  flag: "use_for_schedules",
  model: "schedule",
  folder: SCHEDULES_FOLDER,
  title: "Schedules",
  noun: "schedule",
  references: [],
  secrets: [],

  // the forms there are, read once per sync
  context: () => formNames(),

  /**
   * Reads a schedule file ; its form must exist (when the forms could be read).
   *
   * Args:
   *   text (string): the file's text.
   *   forms (Set<string>|null|undefined): the forms there are ; none : not checked.
   *
   * Returns:
   *   object: { errors, absent, object (the schedule, null when refused), ignored }.
   */
  parse(text, forms) {
    const parsed = parseScheduleFile(text);
    if (parsed.schedule && forms && !forms.has(parsed.schedule.form)) {
      return { errors: [`the form '${parsed.schedule.form}' (unified_job_template.name) does not exist`], absent: false, object: null };
    }
    return { errors: parsed.errors, absent: parsed.absent, object: parsed.schedule, ignored: parsed.schedule?.ignored || [] };
  },

  store: {
    ...links,
    rows: () =>
      mysql.do(
        "SELECT id, name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, owner, one_time_run FROM AnsibleForms.`schedule`",
      ),
    names: async () => ((await mysql.do("SELECT name FROM AnsibleForms.`schedule`")) || []).map((r) => r.name),
    // the app's recurring schedules (no repository, not a planned job) can be taken over
    classify: (row, name) => classifyRow(row, name, row.owner || Number(row.one_time_run) ? "a one-time job of this app" : null),
    changed: (row, s) => {
      const values = valuesOf(s);
      return Object.keys(values).some((k) => String(row[k] ?? "") !== String(values[k] ?? ""));
    },
    insert: (s, name, file) => {
      const v = valuesOf(s);
      return mysql.do(
        "INSERT INTO AnsibleForms.`schedule` (name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, one_time_run, state) VALUES (?,?,?,?,?,?,?,?,?,0,'idle')",
        [v.name, v.description, v.form, v.rrule, v.enabled, v.extra_vars, v.launch_options, name, file],
      );
    },
    update: (row, s) => {
      const v = valuesOf(s);
      return mysql.do(
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=?, cron=NULL, one_time_run=0, run_at=NULL WHERE id=?",
        [v.name, v.description, v.form, v.rrule, v.enabled, v.extra_vars, v.launch_options, row.id],
      );
    },
    // git's version replaces the app's definition ; its runs, state and history stay
    adopt: (row, s, name, file) => {
      const v = valuesOf(s);
      return mysql.do(
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=?, repository=?, repo_file=?, cron=NULL, one_time_run=0, run_at=NULL WHERE id=?",
        [v.name, v.description, v.form, v.rrule, v.enabled, v.extra_vars, v.launch_options, name, file, row.id],
      );
    },
    // its past jobs stay
    remove: (row) => mysql.do("DELETE FROM AnsibleForms.`schedule` WHERE id = ?", [row.id]),
    // the app's recurring schedules : no repository, not a planned "Run later" job
    appRows: () =>
      mysql.do(
        "SELECT id, name, description, form, cron, rrule, enabled, extra_vars, launch_options FROM AnsibleForms.`schedule` WHERE repository IS NULL AND owner IS NULL AND COALESCE(one_time_run,0) = 0 ORDER BY name",
      ),
  },

  /**
   * An app's recurring schedule as a repository would take it : with the rrule it would be written
   * with - its own, or its cron as the rrule that fires at the same moments in the scheduler's zone
   * - or why it stays in the app.
   *
   * Args:
   *   row (object): the schedule.
   *
   * Returns:
   *   object: { row, rrule } or { row, reason }.
   */
  candidateOf(row) {
    if (row.rrule && !validateRrule(row.rrule).length) return { row, rrule: normalizeRrule(row.rrule) };
    if (!row.cron) return { row, reason: "it has no cron nor rrule" };
    const converted = cronToRrule(row.cron, logConfig.tz || "UTC");
    return converted.rrule ? { row, rrule: converted.rrule } : { row, reason: converted.reason };
  },

  // a cron that stays in the app is said with its cron
  keptExtra: (c) => ({ cron: c.row.cron }),

  // a new file in the export form of one schedule
  newFileText: ({ row, rrule }) =>
    newScheduleFile({
      name: row.name,
      description: row.description || "",
      rrule,
      enabled: Number(row.enabled ?? 1) !== 0,
      form: row.form || "",
      extraData: extraDataOf(row.extra_vars || ""),
    }),

  /**
   * Links an app's schedule to the file just written for it, the row stored as a pull reads that
   * file (its extra vars as YAML text, its rrule as written, no cron) : the next pull finds it
   * unchanged.
   *
   * Args:
   *   c (object): the candidate ({ row, rrule }).
   *   name (string): the repository.
   *   file (string): the file, relative to the repository.
   *
   * Returns:
   *   Promise: the update.
   */
  linkCandidate: (c, name, file) => {
    const v = valuesOf(parseScheduleFile(schedules.newFileText(c)).schedule);
    return mysql.do(
      "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=?, cron=NULL, repository=?, repo_file=? WHERE id=?",
      [v.name, v.description, v.form, v.rrule, v.enabled, v.extra_vars, v.launch_options, name, file, c.row.id],
    );
  },

  // the one-time jobs, which stay in the app
  reportExtra: async () => {
    const planned = await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`schedule` WHERE repository IS NULL AND (owner IS NOT NULL OR COALESCE(one_time_run,0) = 1)");
    return { planned: Number(planned?.[0]?.n || 0) };
  },
  previewExtra: async (name, list) => ({ recurring: list.length, ...(await schedules.reportExtra()) }),
};

export default schedules;
