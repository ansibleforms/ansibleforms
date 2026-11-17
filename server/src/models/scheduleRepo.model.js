'use strict';
// The schedules of the schedules repository (use_for_schedules) : the entries of the schedules:
// lists of its YAML files, any name, any folder (lib/scheduleFiles.js), each timed as an app
// schedule is - its iCal rrule (lib/scheduleRrule.js), its cron, or once (one_time_run) - and run as
// the Schedule Service as the app's schedule of that timing.
//
// The Schedules type of the repository-backed objects : the engine (lib/repoObjects/engine.js)
// reads the entries into the schedule table after each pull, takes the app's schedules (each with
// its own timing) when a repository is made the schedules repository and lets them go, unlinked,
// when it is no longer one ; the type's descriptor (lib/repoObjects/schedules.js) says how a file
// reads and a row is stored. What is the schedules' own stays here : a schedule made, edited or
// deleted in the app is checked as a schedule (its form, its timing : rrule, cron or one_time_run) and
// saved into its entry under the repository's write claim, the file put back when the database
// refuses it.
//
// The scheduler always runs from the database ; the repository is a source kept in step with it.
// What runs a schedule (its state, last run, output, queue) stays in the database, never in the
// file.
import fs from "fs";
import logger from "../lib/logger.js";
import mysql from "./db.model.js";
import CrudModel from "./crud.model.js";
import Repo from "./repo.model.js";
import Errors from "../lib/errors.js";
import { parseSchedule, updateScheduleText, newScheduleEntry, scheduleEntryOf, extraDataOf } from "../lib/scheduleFiles.js";
import { validateRruleAsync, normalizeRrule } from "../lib/scheduleRrule.js";
import { cronError } from "../lib/cronValidate.js";
import { parseMoment, oneTimeRunOf } from "../lib/oneTimeRun.js";
import Engine, { withWriteClaim, fileOf, writeEntries, entryFileOf, removeEntry, nameKey, filesNow, assertTypeReadable } from "../lib/repoObjects/engine.js";
import schedules, { extraVarsText, formNames, valuesOf, timingOfRow } from "../lib/repoObjects/schedules.js";
import { checkEnd, endOfRow, END_FIELDS } from "../lib/scheduleEnd.js";

const MODEL = "schedule";

// ===========================================================================
// GIT TO APP : the engine, for the Schedules type
// ===========================================================================

const ScheduleRepo = {
  // the repositories used for schedules, their names sorted
  repositories: () => Engine.repositories(schedules),
  // the schedules repository, if there is one (there is one at most)
  activeRepository: () => Engine.activeRepository(schedules),
  // a repository's schedules: entries read into the schedule table
  syncRepository: (name, opts) => Engine.syncRepository(schedules, name, opts),
  // what a sync did, as lines for the pull output
  summaryText: (summary) => Engine.summaryText(schedules, summary),
  // a repository's schedules synced after git changed its working tree, the lines for its output
  afterGit: (name) => Engine.syncText(schedules, name),
  // every schedules repository synced (the worker's start), each under its write claim
  syncAll: () => Engine.syncAllOf(schedules),
  // its schedules unlinked : they stay in the app, on their own timing
  unlinkRepository: (name) => Engine.unlinkRepository(schedules, name),
  // what making a repository the schedules repository would do, changing nothing
  preview: (name) => Engine.preview(schedules, name),
  // made the schedules repository : pulled, its entries read in, the app's schedules written to it
  activate: (name, opts) => Engine.activate(schedules, name, opts),
  // no longer one : pulled once more, read in, its schedules unlinked
  deactivate: (name, opts) => Engine.deactivate(schedules, name, opts),
};

/**
 * Follows a repository's new name : its schedules say they come from it.
 *
 * Args:
 *   from (string): the old name.
 *   to (string): the new name.
 *
 * Returns:
 *   Promise<void>
 */
ScheduleRepo.renameRepository = async function (from, to) {
  if (await schedules.store.rename(from, to)) CrudModel.changed(MODEL);
};

// ===========================================================================
// APP TO GIT
// ===========================================================================

/**
 * Checks what a schedule of a repository is given in the app : a name no other schedule has, a
 * form that exists, a valid timing (a rrule, a cron as the app checks one, or a moment as the app
 * reads one), extra vars that are a dictionary.
 *
 * Args:
 *   values (object): { name, form, rrule, cron, oneTimeRun, extra_vars } (those given).
 *   id (number|null): the schedule itself, null for a new one.
 *
 * Returns:
 *   Promise<object>: { extraData (the extra vars as a dictionary, when given) }.
 *
 * Raises:
 *   Errors.BadRequestError: a value refused.
 *   Errors.ConflictError: the name of another schedule.
 */
async function checkValues(values, id) {
  const out = {};
  if (values.name !== undefined) {
    if (!String(values.name).trim()) throw new Errors.BadRequestError("A schedule needs a name.");
    const rows = await mysql.do("SELECT id FROM AnsibleForms.`schedule` WHERE LOWER(name) = ? AND (? IS NULL OR id <> ?)", [nameKey(values.name), id, id]);
    if (rows?.length) throw new Errors.ConflictError(`A schedule named '${values.name}' exists already.`);
  }
  if (values.form !== undefined) {
    if (!values.form) throw new Errors.BadRequestError("A schedule needs a form.");
    const forms = await formNames();
    // the forms not readable (the configuration not valid) : refused, never taken unchecked
    if (forms === null) throw new Errors.ConflictError(`The forms could not be read to check the form '${values.form}': fix the configuration first (see the server log).`);
    if (!forms.has(values.form)) throw new Errors.BadRequestError(`The form '${values.form}' does not exist.`);
  }
  if (values.rrule) {
    const errors = await validateRruleAsync(values.rrule);
    if (errors.length) throw new Errors.BadRequestError(`The rrule is refused: ${errors.join(" ")}`);
  }
  if (values.cron) {
    const problem = cronError(values.cron);
    if (problem) throw new Errors.BadRequestError(`Invalid cron expression: ${problem}`);
  }
  if (values.oneTimeRun) {
    const { error } = parseMoment(values.oneTimeRun, "one_time_run");
    if (error) throw new Errors.BadRequestError(`The one-time run is refused: ${error}`);
  }
  if (values.extra_vars !== undefined) {
    try {
      out.extraData = extraDataOf(values.extra_vars || "");
    } catch (e) {
      throw new Errors.BadRequestError(`Extra vars is not a valid dictionary: ${e.message}`);
    }
  }
  return out;
}

/**
 * The timing a request gives a schedule of a repository, as the app takes it for its own
 * (models/schedule.model.js checkAppTiming) : a one time run by its moment (one_time_run ; the pair
 * before 7.8.0 read already, lib/oneTimeRun.js), else a rrule, which wins over a cron sent with
 * it, else a cron ; a rrule sent with a one time run is refused. Nothing given (an edit of its
 * other fields) : undefined, its timing stays.
 *
 * Args:
 *   data (object): the request body ({ one_time_run, rrule, cron }, those given).
 *   current (object|null): the schedule as it is (an edit), null for a new one.
 *
 * Returns:
 *   object|undefined: { rrule, cron, oneTimeRun } (the one given, the others null) ; undefined
 *     when the request gives none.
 *
 * Raises:
 *   Errors.BadRequestError: a rrule with a one time run, or a new schedule (or one no longer run
 *     once) without a timing.
 */
function timingOfRequest(data, current = null) {
  const text = (v) => (v === undefined || v === null ? "" : v instanceof Date ? v.toISOString() : String(v).trim());
  const was = current ? timingOfRow(current) : null;
  if (text(data.one_time_run)) {
    if (text(data.rrule)) throw new Errors.BadRequestError("A one time run has no rrule: send either, not both.");
    return { rrule: null, cron: null, oneTimeRun: text(data.one_time_run) };
  }
  if (text(data.rrule)) return { rrule: normalizeRrule(data.rrule), cron: null, oneTimeRun: null };
  if (text(data.cron)) return { rrule: null, cron: text(data.cron), oneTimeRun: null };
  // a new one, or one no longer run once, without what else it runs on : refused
  const offOnce = data.one_time_run !== undefined && was?.oneTimeRun;
  if (!current || offOnce) throw new Errors.BadRequestError("A schedule needs a cron, a rrule or a one time run.");
  // nothing said of its timing : it stays
  return undefined;
}

/**
 * The end a request gives a schedule of a repository (lib/scheduleEnd.js checkEnd : checked, merged
 * with the end it had), as its entry writes it ; undefined when the request gives none of it.
 *
 * Args:
 *   data (object): the request body.
 *   current (object|null): the schedule's row as it is (an update), null for a new one.
 *   once (boolean): whether it is timed by a one-time run after the request.
 *
 * Returns:
 *   object|undefined: { ends, endAt, endCount, endAction, removeAfterRun }.
 *
 * Raises:
 *   Errors.BadRequestError: an end refused.
 */
function endOfRequest(data, current, once) {
  if (!END_FIELDS.some((k) => data[k] !== undefined)) return undefined;
  const given = Object.fromEntries(END_FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  checkEnd(given, current, once);
  return endOfRow({ ends: "never", end_action: "disable", remove_after_run: 1, ...(current || {}), ...given });
}

/**
 * Makes a schedule in a schedules repository : a new entry (newScheduleEntry), at the end of
 * the first file holding schedules: (else schedules.yaml, made), and its row ; pushed with
 * the repository's Push.
 *
 * Args:
 *   repository (string): the repository.
 *   data (object): { name, description, form, its timing (rrule, cron or one_time_run :
 *     timingOfRequest), enabled, extra_vars, its end (ends, end_at, end_count, end_action,
 *     remove_after_run : endOfRequest) }.
 *
 * Returns:
 *   Promise<number>: the new schedule's id.
 *
 * Raises:
 *   Errors.BadRequestError: no schedules repository of that name, not cloned yet, or a value refused.
 *   Errors.ConflictError: the name of another schedule, the name an entry of the repository declares
 *     (refused or not read in yet), or a file of the repository giving schedules: that cannot be read.
 */
ScheduleRepo.create = async function (repository, data) {
  const rows = await mysql.do("SELECT name, use_for_schedules FROM AnsibleForms.`repositories` WHERE name = ?", [repository]);
  if (!rows?.length || !rows[0].use_for_schedules) throw new Errors.BadRequestError(`'${repository}' is not a schedules repository.`);
  if (!Repo.isValidName(repository) || !fs.existsSync(Repo.folderOf(repository))) {
    throw new Errors.BadRequestError(`Repository '${repository}' is not cloned yet, pull it first.`);
  }
  const values = {
    name: String(data.name ?? "").trim(),
    description: String(data.description ?? ""),
    form: data.form || "",
    // its timing, written as it is given : a rrule, a cron, or one run at its moment (the pair
    // before 7.8.0, one_time_run true with run_at, read as that moment)
    ...timingOfRequest(oneTimeRunOf(data, "api")),
    enabled: data.enabled === undefined || data.enabled === null ? true : data.enabled === true || Number(data.enabled) === 1,
    extra_vars: data.extra_vars ?? "",
  };
  // how it ends, written to its entry : never when the request says nothing of it
  Object.assign(values, endOfRequest(data, null, !!values.oneTimeRun) || {});
  const { extraData } = await checkValues(values, null);
  return withWriteClaim(repository, async () => {
    // a file that may declare it cannot be read, or an entry of the repository declaring its name
    // (refused, waiting, not pulled yet) : refused - never a second entry of that name beside it
    assertTypeReadable(schedules, repository);
    const now = await filesNow(schedules, repository);
    if (now.names.has(nameKey(values.name))) {
      throw new Errors.ConflictError(`An entry of repository '${repository}' is named '${values.name}' already (see its pull output): choose another name, or fix that entry in git.`);
    }
    const entry = newScheduleEntry({ ...values, extraData });
    const parsed = parseSchedule(structuredClone(entry));
    const file = now.file;
    const abs = fileOf(repository, file);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    writeEntries(schedules, repository, file, [entry]);
    try {
      // stored as a pull reads its entry back : its timing's columns, its moment in UTC
      const v = valuesOf(parsed.schedule);
      const res = await mysql.do(
        "INSERT INTO AnsibleForms.`schedule` (name, description, form, rrule, cron, one_time_run, enabled, extra_vars, launch_options, ends, end_at, end_count, end_action, remove_after_run, repository, repo_file, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'idle')",
        [v.name, v.description, v.form, v.rrule, v.cron, v.one_time_run, v.enabled, extraVarsText(extraData), v.launch_options, v.ends, v.end_at, v.end_count, v.end_action, v.remove_after_run, repository, file],
      );
      CrudModel.changed(MODEL);
      logger.info(`Created schedule '${values.name}' in ${repository}/${file}`);
      return res.insertId;
    } catch (e) {
      // no entry left behind for a schedule that was not made
      if (before === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, before, "utf8");
      throw e;
    }
  });
};

/**
 * Saves the edit of a repository's schedule into its entry, where it is now - only the fields
 * changed, the rest of the file (its prompts, the keys AnsibleForms does not use, its comments, the
 * file's other keys and entries) kept - and its row. An entry gone meanwhile is written again,
 * whole, in the file it is linked to.
 *
 * Args:
 *   row (object): the schedule as it is.
 *   data (object): any of { name, description, form, its timing (rrule, cron or one_time_run :
 *     timingOfRequest ; a change of kind rewrites the entry's timing key), enabled,
 *     its end (ends, end_at, end_count, end_action, remove_after_run : endOfRequest),
 *     extra_vars, launch_options
 *     (an object, or its JSON : written as the prompts that give them, those no prompt gives kept
 *     in the app only) }.
 *
 * Returns:
 *   Promise<void>
 *
 * Raises:
 *   Errors.BadRequestError: a value refused, or an entry that is not a valid schedule any more.
 *   Errors.ConflictError: the name of another schedule.
 */
ScheduleRepo.update = async function (row, data) {
  const values = {};
  if (data.name !== undefined) values.name = String(data.name).trim();
  if (data.description !== undefined) values.description = String(data.description ?? "");
  if (data.form !== undefined) values.form = data.form;
  // its timing, when the edit gives one : the one given written, the entry's other two keys removed
  const timing = timingOfRequest(oneTimeRunOf(data, "api"), row);
  if (timing) Object.assign(values, timing);
  if (data.enabled !== undefined) values.enabled = data.enabled === true || Number(data.enabled) === 1;
  if (data.extra_vars !== undefined) values.extra_vars = data.extra_vars ?? "";
  // how it ends, when the edit says : for its timing after the edit
  const once = timing ? !!timing.oneTimeRun : !!row.one_time_run;
  Object.assign(values, endOfRequest(data, row, once) || {});
  const { extraData } = await checkValues(values, row.id);
  const edits = { ...values, extraData };
  delete edits.extra_vars;
  if (extraData === undefined) delete edits.extraData;
  if (data.launch_options !== undefined) edits.launchOptions = data.launch_options ?? "";
  await withWriteClaim(row.repository, async () => {
    // the row read again under the claim : a pull that held it may have removed the schedule (its
    // entry gone from git) or moved it, and its entry must not be written back for it
    const fresh = (await mysql.do("SELECT * FROM AnsibleForms.`schedule` WHERE id = ?", [row.id]))?.[0];
    if (!fresh) throw new Errors.NotFoundError(`The schedule '${row.name}' is gone: a pull removed it meanwhile.`);
    if (fresh.repository !== row.repository || fresh.repo_file !== row.repo_file) {
      throw new Errors.ConflictError(`The schedule '${row.name}' was changed by a pull meanwhile: reload it and save again.`);
    }
    // the options no prompt gives : the row's, or the edit's when it gives them
    const kept = { ...fresh, launch_options: edits.launchOptions ?? fresh.launch_options };
    // its entry where it is now ; gone : written again, whole, in the file it is linked to
    const file = entryFileOf(schedules, fresh.repository, fresh.name, fresh.repo_file) || fresh.repo_file;
    const abs = fileOf(fresh.repository, file);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    const current = { name: fresh.name, description: fresh.description || "", form: fresh.form, ...timingOfRow(fresh), enabled: !!Number(fresh.enabled ?? 1), extraData: extraDataOf(fresh.extra_vars || ""), launchOptions: fresh.launch_options || "", ...endOfRow(fresh) };
    let text;
    try {
      text = updateScheduleText(before ?? "", fresh.name, edits, newScheduleEntry({ ...current, ...edits }));
    } catch (e) {
      throw new Errors.BadRequestError(`The file ${fresh.repository}/${file} cannot hold the schedule: ${e.message}`);
    }
    const parsed = parseSchedule(scheduleEntryOf(text, edits.name ?? fresh.name));
    if (!parsed.schedule) {
      throw new Errors.BadRequestError(`The schedule '${fresh.name}' of ${fresh.repository}/${file} is not a valid schedule, fix it in git: ${parsed.errors.join("; ")}`);
    }
    if (text !== before) fs.writeFileSync(abs, text, "utf8");
    const v = valuesOf(parsed.schedule, kept);
    try {
      await mysql.do(
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, cron=?, one_time_run=?, enabled=?, extra_vars=?, launch_options=?, ends=?, end_at=?, end_count=?, end_action=?, remove_after_run=?, repo_file=? WHERE id=?",
        [v.name, v.description, v.form, v.rrule, v.cron, v.one_time_run, v.enabled, v.extra_vars, v.launch_options, v.ends, v.end_at, v.end_count, v.end_action, v.remove_after_run, file, fresh.id],
      );
    } catch (e) {
      // the file back as it was : it and the row say the same
      if (before === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, before, "utf8");
      throw e;
    }
    CrudModel.changed(MODEL);
    logger.info(`Saved schedule '${v.name}' into ${fresh.repository}/${file}`);
  });
};

/**
 * Deletes a repository's schedule : its entry (its file when it holds nothing more), and its row ;
 * pushed with the repository's Push.
 *
 * Args:
 *   row (object): the schedule.
 *
 * Returns:
 *   Promise<void>
 */
ScheduleRepo.delete = async function (row) {
  await withWriteClaim(row.repository, async () => {
    const file = removeEntry(schedules, row.repository, row.name, row.repo_file);
    await mysql.do("DELETE FROM AnsibleForms.`schedule` WHERE id = ?", [row.id]);
    CrudModel.changed(MODEL);
    logger.info(`Deleted schedule '${row.name}' and its entry in ${row.repository}/${file || row.repo_file}`);
  });
};

export default ScheduleRepo;
