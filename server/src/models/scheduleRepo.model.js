'use strict';
// The schedules of the schedules repository (use_for_schedules) : the entries of the schedules:
// lists of its YAML files, any name, any folder (lib/scheduleFiles.js), timed by its iCal rrule
// (lib/scheduleRrule.js), run as the Schedule Service as every recurring schedule.
//
// The Schedules type of the repository-backed objects : the engine (lib/repoObjects/engine.js)
// reads the entries into the schedule table after each pull, takes the app's recurring schedules
// when a repository is made the schedules repository and lets them go, unlinked, when it is no
// longer one ; the type's descriptor (lib/repoObjects/schedules.js) says how a file reads and a row
// is stored. What is the schedules' own stays here : a schedule made, edited or deleted in the app
// is checked as a schedule (its form, its rrule, a cron written as a rrule) and saved into its entry
// under the repository's write claim, the file put back when the database refuses it.
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
import { cronToRrule } from "../lib/cronToRrule.js";
import logConfig from "../../config/log.config.js";
import Engine, { withWriteClaim, fileOf, writeEntries, entryFileOf, removeEntry, nameKey, filesNow, assertTypeReadable } from "../lib/repoObjects/engine.js";
import schedules, { extraVarsText, launchOptionsText, formNames, valuesOf } from "../lib/repoObjects/schedules.js";

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
  // its schedules unlinked : they stay in the app, on their rrule
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
 * form that exists, a valid rrule, extra vars that are a dictionary.
 *
 * Args:
 *   values (object): { name, form, rrule, extra_vars } (those given).
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
  if (values.rrule !== undefined) {
    const errors = await validateRruleAsync(values.rrule);
    if (errors.length) throw new Errors.BadRequestError(`The rrule is refused: ${errors.join(" ")}`);
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
 * A cron as the rrule that fires at the same moments in the scheduler's zone, for a new schedule
 * sent with a cron while a schedules repository is used.
 *
 * Args:
 *   cron (string): the cron.
 *
 * Returns:
 *   string: the rrule ('' for no cron).
 *
 * Raises:
 *   Errors.BadRequestError: a cron a rrule cannot express.
 */
function cronRrule(cron) {
  if (!cron || !String(cron).trim()) return "";
  const converted = cronToRrule(cron, logConfig.tz || "UTC");
  if (!converted.rrule) throw new Errors.BadRequestError(`The cron '${cron}' cannot be written as a rrule: ${converted.reason}. Give a rrule.`);
  return converted.rrule;
}

/**
 * Makes a schedule in a schedules repository : a new entry, the export form of one schedule, at the
 * end of the first file holding schedules: (else schedules.yaml, made), and its row ; pushed with
 * the repository's Push.
 *
 * Args:
 *   repository (string): the repository.
 *   data (object): { name, description, form, rrule, enabled, extra_vars }.
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
    // its rrule ; a cron sent instead is written as the rrule that fires at the same moments
    rrule: normalizeRrule(data.rrule) || cronRrule(data.cron),
    enabled: data.enabled === undefined || data.enabled === null ? true : data.enabled === true || Number(data.enabled) === 1,
    extra_vars: data.extra_vars ?? "",
  };
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
      const res = await mysql.do(
        "INSERT INTO AnsibleForms.`schedule` (name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, one_time_run, state) VALUES (?,?,?,?,?,?,?,?,?,0,'idle')",
        [values.name, values.description, values.form, values.rrule, values.enabled ? 1 : 0, extraVarsText(extraData), launchOptionsText(parsed.schedule?.launchOptions), repository, file],
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
 *   data (object): any of { name, description, form, rrule, enabled, extra_vars, launch_options
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
  if (data.rrule !== undefined) values.rrule = normalizeRrule(data.rrule);
  if (data.enabled !== undefined) values.enabled = data.enabled === true || Number(data.enabled) === 1;
  if (data.extra_vars !== undefined) values.extra_vars = data.extra_vars ?? "";
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
    const current = { name: fresh.name, description: fresh.description || "", form: fresh.form, rrule: fresh.rrule, enabled: !!Number(fresh.enabled ?? 1), extraData: extraDataOf(fresh.extra_vars || ""), launchOptions: fresh.launch_options || "" };
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
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=?, repo_file=? WHERE id=?",
        [v.name, v.description, v.form, v.rrule, v.enabled, v.extra_vars, v.launch_options, file, fresh.id],
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
