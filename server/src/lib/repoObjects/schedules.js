'use strict';
// The Schedules type of the repository-backed objects (lib/repoObjects/engine.js) : the entries of
// the schedules: lists of a repository's files, read by lib/scheduleFiles.js (its own format, the
// export form of one schedule), timed as an app schedule is - by its iCal rrule
// (lib/scheduleRrule.js), its cron, or once at its one_time_run - stored and run as the app's schedule of
// that timing, as the Schedule Service. What is the schedules' own is here : how a file reads (its
// form must exist), how a row is stored, which app schedules a repository takes (every one, with
// its own timing, never converted ; only the "Run later" jobs a user planned stay in the app : they
// are that user's jobs, not schedules). A one-time entry whose one_time_run is past and that the app no
// longer waits to run (it ran : the app deleted it, as it deletes every one-time schedule after
// its run) is not imported, said in the pull output, never brought back. Making a schedule in the
// app, editing and deleting it go through models/scheduleRepo.model.js.
import YAML from "yaml";
import logger from "../logger.js";
import mysql from "../../models/db.model.js";
import Form from "../../models/form.model.js";
import { KEY_ORDER, parseSchedule, newScheduleEntry, extraDataOf, promptsOf, timingOf } from "../scheduleFiles.js";
import { isoMoment, dbMoment } from "../oneTimeRun.js";
import { linkStore, classifyRow, nameKey } from "./engine.js";

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
 * read (the configuration not valid, a key file broken) : fail closed, a schedule is then never
 * taken unchecked - an entry is refused (kept as it was, read again by the next pull :
 * schedules.parseEntry),
 * a save of the app refused (models/scheduleRepo.model.js checkValues).
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
 * The one-time schedules the app still waits to run (no run yet : the app deletes one after its
 * run, or turns it off with its last run when it cannot), as nameKey keys their names : an entry of
 * that name whose run_at is past is still read in, the run it waits for kept.
 *
 * Returns:
 *   Promise<Set<string>|null>: the names ; null when they cannot be read (an entry whose run_at is
 *     past is then refused, kept as it was : schedules.parseEntry).
 */
export async function pendingNames() {
  try {
    const rows = await mysql.do("SELECT name FROM AnsibleForms.`schedule` WHERE one_time_run = 1 AND last_run IS NULL");
    return new Set((rows || []).map((r) => nameKey(r.name)));
  } catch (e) {
    logger.warning(`The one-time schedules could not be read to check the entries whose run_at is past: ${e.message || e}`);
    return null;
  }
}

/**
 * The timing columns of a schedule as the schedule table keeps them, from its timing (one of rrule,
 * cron, oneTimeRun) : stored as the app stores a schedule of that timing.
 *
 * Args:
 *   s (object): { rrule, cron, oneTimeRun }.
 *
 * Returns:
 *   object: { rrule, cron, one_time_run, run_at } (the others null, one_time_run 0 or 1).
 */
export function timingColumns(s) {
  if (s.oneTimeRun) return { rrule: null, cron: null, one_time_run: 1, run_at: dbMoment(s.oneTimeRun) };
  if (s.cron) return { rrule: null, cron: s.cron, one_time_run: 0, run_at: null };
  return { rrule: s.rrule || null, cron: null, one_time_run: 0, run_at: null };
}

/**
 * A schedule's timing as a row has it, the app's own rule : a one-time run by its run_at, else its
 * rrule, else its cron ; { rrule, cron, oneTimeRun } the one it has, the others null.
 *
 * Args:
 *   row (object): the schedule.
 *
 * Returns:
 *   object: { rrule, cron, oneTimeRun }.
 */
export function timingOfRow(row) {
  if (Number(row.one_time_run) === 1 || row.one_time_run === true) return { rrule: null, cron: null, oneTimeRun: isoMoment(row.run_at) || row.run_at || null };
  if (row.rrule && String(row.rrule).trim()) return { rrule: row.rrule, cron: null, oneTimeRun: null };
  return { rrule: null, cron: row.cron && String(row.cron).trim() ? row.cron : null, oneTimeRun: null };
}

/**
 * A schedule of an entry as the schedule table keeps it : its launch options the entry's, and those
 * of its row no prompt of a file can give, kept in the app only (promptsOf).
 *
 * Args:
 *   s (object): the schedule, as lib/scheduleFiles.js reads it.
 *   row (object): its row as it is, if any.
 *
 * Returns:
 *   object: { name, description, form, rrule, cron, one_time_run, run_at, enabled, extra_vars,
 *     launch_options }.
 */
export function valuesOf(s, row = null) {
  return {
    name: s.name,
    description: s.description,
    form: s.form,
    ...timingColumns(s),
    enabled: s.enabled ? 1 : 0,
    extra_vars: extraVarsText(s.extraData),
    launch_options: launchOptionsText({ ...s.launchOptions, ...promptsOf(row?.launch_options).kept }),
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
  nameField: "name",
  keyOrder: KEY_ORDER,
  title: "Schedules",
  noun: "schedule",
  references: [],
  secrets: [],

  // the forms there are and the one-time schedules waiting for their run, read once per sync
  context: async () => ({ forms: await formNames(), pending: await pendingNames() }),
  // a preview counting the files : the forms not checked
  previewContext: async () => ({ pending: await pendingNames() }),

  /**
   * Reads a schedule entry ; its form must exist. The forms not readable (null, formNames) :
   * refused, never taken unchecked - a schedule of it the app has is kept as it was. A one-time
   * entry whose one_time_run is past says whether the app still waits to run it (pending) : one it does
   * not wait for is not imported (notImported) ; the one-time schedules not readable, it is refused,
   * kept as it was.
   *
   * Args:
   *   raw (object): the entry, as its file gives it.
   *   ctx (object|undefined): { forms (Set<string>|null|undefined : the forms there are ; null :
   *     they could not be read, the file refused ; undefined : not checked), pending
   *     (Set<string>|null : pendingNames) } ; undefined : nothing checked.
   *
   * Returns:
   *   object: { errors, absent, object (the schedule, null when refused), raw (the name a refused
   *     one declares, whatever it is refused for), ignored }.
   */
  parseEntry(raw, ctx) {
    const forms = ctx?.forms;
    const parsed = parseSchedule(raw);
    // past : the app waits to run it still (no run yet), or it ran and is not brought back
    if (parsed.schedule?.oneTimeRun && Date.parse(parsed.schedule.oneTimeRun) <= Date.now()) {
      if (ctx?.pending === null) {
        return { errors: [`the one-time schedules could not be read to check its past one_time_run: kept as it was until they can be (see the server log)`], absent: false, object: null, raw: { name: parsed.schedule.name } };
      }
      parsed.schedule.pending = !!ctx?.pending?.has(nameKey(parsed.schedule.name));
    }
    // a refused one's name kept, whatever it is refused for : no schedule of the app is written
    // beside it under that name (lib/repoObjects/engine.js declaredName)
    if (parsed.schedule && forms === null) {
      return { errors: [`the forms could not be read to check its form '${parsed.schedule.form}': kept as it was until they can be (see the server log)`], absent: false, object: null, raw: { name: parsed.schedule.name } };
    }
    if (parsed.schedule && forms && !forms.has(parsed.schedule.form)) {
      return { errors: [`the form '${parsed.schedule.form}' (unified_job_template.name) does not exist`], absent: false, object: null, raw: { name: parsed.schedule.name } };
    }
    if (!parsed.schedule) return { errors: parsed.errors, absent: parsed.absent, object: null, ignored: [], ...(parsed.name ? { raw: { name: parsed.name } } : {}) };
    return { errors: parsed.errors, absent: parsed.absent, object: parsed.schedule, ignored: parsed.schedule.ignored || [] };
  },

  // a one-time run already done (its one_time_run past, the app no longer waiting to run it) : not
  // imported, its entry left in git as it is ; the app's schedule of it, if any, goes
  notImported: (s) => (s.oneTimeRun && Date.parse(s.oneTimeRun) <= Date.now() && !s.pending ? "its one_time_run is past (already run)" : null),

  store: {
    ...links,
    rows: () =>
      mysql.do(
        "SELECT id, name, description, form, rrule, cron, run_at, enabled, extra_vars, launch_options, repository, repo_file, owner, one_time_run, last_run FROM AnsibleForms.`schedule`",
      ),
    names: async () => ((await mysql.do("SELECT name FROM AnsibleForms.`schedule`")) || []).map((r) => r.name),
    // the app's schedules (no repository, not a job a user planned) can be taken over
    classify: (row, name) => classifyRow(row, name, row.owner ? "a one-time job of this app" : null),
    changed: (row, s) => {
      const values = valuesOf(s, row);
      // a run_at as the table gives it (a Date, or its text) compared in UTC to the second
      const now = { ...row, run_at: dbMoment(row.run_at), one_time_run: Number(row.one_time_run ?? 0) };
      return Object.keys(values).some((k) => String(now[k] ?? "") !== String(values[k] ?? ""));
    },
    insert: (s, name, file) => {
      const v = valuesOf(s);
      return mysql.do(
        "INSERT INTO AnsibleForms.`schedule` (name, description, form, rrule, cron, one_time_run, run_at, enabled, extra_vars, launch_options, repository, repo_file, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'idle')",
        [v.name, v.description, v.form, v.rrule, v.cron, v.one_time_run, v.run_at, v.enabled, v.extra_vars, v.launch_options, name, file],
      );
    },
    update: (row, s) => {
      const v = valuesOf(s, row);
      return mysql.do(
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, cron=?, one_time_run=?, run_at=?, enabled=?, extra_vars=?, launch_options=? WHERE id=?",
        [v.name, v.description, v.form, v.rrule, v.cron, v.one_time_run, v.run_at, v.enabled, v.extra_vars, v.launch_options, row.id],
      );
    },
    // git's version replaces the app's definition ; its runs, state and history stay
    adopt: (row, s, name, file) => {
      const v = valuesOf(s, row);
      return mysql.do(
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, cron=?, one_time_run=?, run_at=?, enabled=?, extra_vars=?, launch_options=?, repository=?, repo_file=? WHERE id=?",
        [v.name, v.description, v.form, v.rrule, v.cron, v.one_time_run, v.run_at, v.enabled, v.extra_vars, v.launch_options, name, file, row.id],
      );
    },
    // its past jobs stay
    remove: (row) => mysql.do("DELETE FROM AnsibleForms.`schedule` WHERE id = ?", [row.id]),
    // the app's schedules, whatever their timing : no repository, not a "Run later" job a user
    // planned (owner : that user's job, run as them, never a schedule of a repository)
    appRows: () =>
      mysql.do(
        "SELECT id, name, description, form, cron, rrule, one_time_run, run_at, enabled, extra_vars, launch_options FROM AnsibleForms.`schedule` WHERE repository IS NULL AND owner IS NULL ORDER BY name",
      ),
  },

  /**
   * An app's schedule as a repository would take it : with its own timing (its cron, its rrule or
   * its one-time run_at), written as it is, never converted - or why it stays in the app (no valid
   * timing).
   *
   * Args:
   *   row (object): the schedule.
   *
   * Returns:
   *   object: { row, timing ({ rrule, cron, oneTimeRun }) } or { row, code (noSchedule), reason }.
   */
  candidateOf(row) {
    const timing = timingOfRow(row);
    const key = timing.oneTimeRun ? "one_time_run" : timing.cron ? "cron" : "rrule";
    const checked = timingOf({ [key]: timing.oneTimeRun || timing.cron || timing.rrule || "" });
    // why it stays in the app, with its code : the question says it in the app's language
    if (!checked.timing) return { row, code: "noSchedule", reason: `it has no valid cron, rrule or one_time_run (${checked.errors.join("; ")})` };
    return { row, timing: checked.timing };
  },

  /**
   * The launch options of the schedules a repository would take that no prompt of an entry gives :
   * kept in the app only, said before the usage is turned on.
   *
   * Args:
   *   list (object[]): the candidates (written or kept).
   *
   * Returns:
   *   string[]: each schedule with its options (Nightly (__custom__)).
   */
  appOnlyOptions(list) {
    return list
      .filter((c) => !c.reason)
      .map((c) => [c.row.name, Object.keys(promptsOf(c.row.launch_options).kept)])
      .filter(([, kept]) => kept.length)
      .map(([name, kept]) => `${name} (${kept.join(", ")})`);
  },

  // a new entry in the export form of one schedule, with the schedule's own timing
  entryOf: ({ row, timing }) =>
    newScheduleEntry({
      name: row.name,
      description: row.description || "",
      ...timing,
      enabled: Number(row.enabled ?? 1) !== 0,
      form: row.form || "",
      extraData: extraDataOf(row.extra_vars || ""),
      launchOptions: row.launch_options || "",
    }),

  /**
   * Links an app's schedule to the file its entry was just written to, the row stored as a pull
   * reads that entry (its extra vars as YAML text, its timing as written) : the next pull finds it
   * unchanged.
   *
   * Args:
   *   c (object): the candidate ({ row, timing }).
   *   name (string): the repository.
   *   file (string): the file, relative to the repository.
   *
   * Returns:
   *   Promise: the update.
   */
  linkCandidate: (c, name, file) => {
    const v = valuesOf(parseSchedule(structuredClone(schedules.entryOf(c))).schedule, c.row);
    return mysql.do(
      "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, cron=?, one_time_run=?, run_at=?, enabled=?, extra_vars=?, launch_options=?, repository=?, repo_file=? WHERE id=?",
      [v.name, v.description, v.form, v.rrule, v.cron, v.one_time_run, v.run_at, v.enabled, v.extra_vars, v.launch_options, name, file, c.row.id],
    );
  },

  // the jobs users planned ("Run later"), which stay in the app
  reportExtra: async () => {
    const planned = await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`schedule` WHERE repository IS NULL AND owner IS NOT NULL");
    return { planned: Number(planned?.[0]?.n || 0) };
  },
  previewExtra: async (name, list) => ({ recurring: list.length, appOnly: schedules.appOnlyOptions(list), ...(await schedules.reportExtra()) }),
};

export default schedules;
