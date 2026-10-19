'use strict';
// The schedules of the schedules repositories (use_for_schedules) : one schedule per file in a
// repository's `schedules` folder, as YAML (lib/scheduleFiles.js), timed by its
// iCal rrule (lib/scheduleRrule.js), run as the Schedule Service as every recurring schedule.
//
// Two ways, as the designer's forms :
//   git to app  : after each pull (or clone, reset) of a schedules repository, at the worker's
//                 start and when a repository is made one, its files are read into the schedule
//                 table (syncRepository) - new files make schedules, changed ones change them,
//                 a removed file removes its schedule (its past jobs stay). A file that is
//                 not a valid schedule is refused alone : said in the repository's pull
//                 output and the server log with its name, the others still sync.
//   app to git  : a schedule of a repository edited, created or deleted in the app writes or
//                 removes its file in the repository's working tree, under the repository's
//                 write claim ; the change goes to git as a designer save does, with the
//                 repository's Push (its Push column says it has changes to push).
//
// The scheduler always runs from the database ; the repository is a source kept in step with it.
// There is one schedules repository at most. Made one (activate), its files are read in - a file
// named as a recurring schedule of the app takes that schedule over, git's version wins - and the
// app's other recurring schedules are written to it, a cron as the rrule that fires at the same
// moments ; the crons a rrule cannot express and the one-time "Run later" jobs stay in the app.
// No longer one, or deleted (deactivate), its schedules stay, unlinked, on their rrule ; the files
// in git are left as they are. What runs a schedule (its state, last run, output, queue) stays in
// the database, never in the file.
import fs from "fs";
import path from "path";
import YAML from "yaml";
import logger from "../lib/logger.js";
import mysql from "./db.model.js";
import CrudModel from "./crud.model.js";
import Repo from "./repo.model.js";
import Repository from "./repository.model.js";
import Form from "./form.model.js";
import Errors from "../lib/errors.js";
import {
  SCHEDULES_FOLDER,
  SCHEDULE_FILE,
  parseScheduleFile,
  updateScheduleFile,
  newScheduleFile,
  fileNameFor,
  extraDataOf,
} from "../lib/scheduleFiles.js";
import { validateRrule, normalizeRrule } from "../lib/scheduleRrule.js";
import { cronToRrule } from "../lib/cronToRrule.js";
import logConfig from "../../config/log.config.js";

const MODEL = "schedule";

// ===========================================================================
// HELPERS
// ===========================================================================

/**
 * The schedules folder of a repository.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   string: the folder (it may not exist).
 */
function schedulesFolderOf(name) {
  return path.join(Repo.folderOf(name), SCHEDULES_FOLDER);
}

/**
 * The absolute path of a schedule's file, checked to be in its repository's schedules folder.
 *
 * Args:
 *   repository (string): the repository.
 *   repoFile (string): the file, relative to the repository (schedules/nightly.yaml).
 *
 * Returns:
 *   string: the path.
 *
 * Raises:
 *   Error: a file outside the schedules folder.
 */
function fileOf(repository, repoFile) {
  const folder = schedulesFolderOf(repository);
  const abs = path.resolve(Repo.folderOf(repository), String(repoFile || ""));
  if (path.dirname(abs) !== folder || !SCHEDULE_FILE.test(abs)) {
    throw new Error(`'${repoFile}' is not a schedule file of repository '${repository}'`);
  }
  return abs;
}

/**
 * The schedule files of a repository : the yaml files right in its schedules folder, sorted ;
 * a link that leads outside the repository, a folder or anything else is left out.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   string[]: the files, relative to the repository (schedules/nightly.yaml).
 */
function scheduleFilesOf(name) {
  const repoDir = Repo.folderOf(name);
  const folder = schedulesFolderOf(name);
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!SCHEDULE_FILE.test(entry.name)) continue;
    const abs = path.join(folder, entry.name);
    try {
      // a link is followed only when it stays in the repository
      const real = fs.realpathSync(abs);
      if (!real.startsWith(fs.realpathSync(repoDir) + path.sep)) continue;
      if (!fs.statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    files.push(`${SCHEDULES_FOLDER}/${entry.name}`);
  }
  return files.sort();
}

/**
 * Extra data as the schedule table keeps them : YAML text, empty for none.
 *
 * Args:
 *   data (object): the extra data.
 *
 * Returns:
 *   string: the text.
 */
function extraVarsText(data) {
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
function launchOptionsText(options) {
  return options && Object.keys(options).length ? JSON.stringify(options) : "";
}

/**
 * The names of the forms there are, to check the form a schedule runs ; null when they cannot be
 * read (the schedule is then taken, its launch says so if the form is missing).
 *
 * Returns:
 *   Promise<Set<string>|null>: the names.
 */
async function formNames() {
  try {
    const config = await Form.load(["admin"]);
    return new Set((config?.forms || []).map((f) => f.name));
  } catch (e) {
    logger.warning(`The forms could not be read to check the forms of the schedules: ${e.message || e}`);
    return null;
  }
}

/**
 * A schedule's name as the schedule table compares names (case does not count).
 *
 * Args:
 *   name (string): the name.
 *
 * Returns:
 *   string: the key.
 */
const nameKey = (name) => String(name || "").trim().toLowerCase();

// ===========================================================================
// GIT TO APP
// ===========================================================================

const ScheduleRepo = {};

/**
 * The repositories used for schedules.
 *
 * Returns:
 *   Promise<string[]>: their names, sorted.
 */
ScheduleRepo.repositories = async function () {
  const rows = await mysql.do("SELECT name FROM AnsibleForms.`repositories` WHERE use_for_schedules ORDER BY name");
  return (rows || []).map((r) => r.name).filter((n) => Repo.isValidName(n));
};

/**
 * Reads a schedules repository's files into the schedule table : a new file makes a schedule, a
 * changed one changes its definition (name, description, form, rrule, enabled, extra data, its
 * prompts), a removed one (or one saying state: absent) removes it. A refused file - one
 * that is not a valid schedule, a form that does not exist, a name another schedule has - changes nothing : a
 * schedule it made before stays as it was, a new one is not made. What runs a schedule (state,
 * last run, output) is never touched.
 *
 * Args:
 *   name (string): the repository.
 *   opts (object): { forms (Set of form names, read when not given) }.
 *
 * Returns:
 *   Promise<object>: { created, updated, deleted, unchanged (counts), refused: [{ file, reasons }],
 *     ignored: [{ file, keys }] }.
 */
ScheduleRepo.syncRepository = async function (name, opts = {}) {
  const summary = { created: 0, updated: 0, deleted: 0, unchanged: 0, matched: [], refused: [], ignored: [] };
  const forms = opts.forms !== undefined ? opts.forms : await formNames();
  // step 1 : the files, read and checked on their own
  const files = scheduleFilesOf(name).map((file) => {
    let text;
    try {
      text = fs.readFileSync(path.join(Repo.folderOf(name), file), "utf8");
    } catch (e) {
      return { file, errors: [`cannot be read: ${e.code || e.message}`], schedule: null, absent: false };
    }
    const parsed = parseScheduleFile(text);
    if (parsed.schedule && forms && !forms.has(parsed.schedule.form)) {
      parsed.errors = [`the form '${parsed.schedule.form}' (unified_job_template.name) does not exist`];
      parsed.schedule = null;
    }
    return { file, ...parsed };
  });
  // step 2 : the schedules there are : this repository's by file, the names of the others
  const rows = await mysql.do(
    "SELECT id, name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, owner, one_time_run FROM AnsibleForms.`schedule`",
  );
  const own = new Map();
  const taken = new Map(); // name key -> where it is taken
  // the app's recurring schedules (no repository, not a planned job) : a file of that name takes
  // it over, git's version wins, its runs and state kept
  const adoptable = new Map();
  for (const row of rows || []) {
    if (row.repository === name && row.repo_file) own.set(row.repo_file, row);
    else if (!row.repository && !row.owner && !Number(row.one_time_run)) adoptable.set(nameKey(row.name), row);
    else taken.set(nameKey(row.name), row.repository ? `repository '${row.repository}' (${row.repo_file})` : "a one-time job of this app");
  }
  // a refused file that is still there keeps its schedule, and that schedule its name
  const kept = new Set();
  for (const f of files) {
    if (!f.schedule && !f.absent && own.has(f.file)) {
      kept.add(f.file);
      taken.set(nameKey(own.get(f.file).name), `${f.file} (refused, kept as it was)`);
    }
  }
  // step 3 : the names, in file order : the first file to name a schedule has it ; a file that has
  // no schedule yet and names an app's recurring one takes it over
  for (const f of files) {
    if (!f.schedule) continue;
    const key = nameKey(f.schedule.name);
    if (!taken.has(key) && adoptable.has(key)) {
      if (own.has(f.file)) taken.set(key, "a schedule of this app");
      else {
        f.adopt = adoptable.get(key);
        adoptable.delete(key);
      }
    }
    if (taken.has(key)) {
      f.errors = [`the name '${f.schedule.name}' is the name of another schedule: ${taken.get(key)}`];
      f.schedule = null;
      if (own.has(f.file)) kept.add(f.file);
      continue;
    }
    taken.set(key, `${name}/${f.file}`);
  }
  // step 4 : the schedules whose file is gone (or absent) go first, then the changed, then the new
  const present = new Set(files.filter((f) => f.schedule || kept.has(f.file)).map((f) => f.file));
  for (const [file, row] of own) {
    if (present.has(file)) continue;
    await mysql.do("DELETE FROM AnsibleForms.`schedule` WHERE id = ?", [row.id]);
    logger.notice(`Removed schedule '${row.name}': its file ${name}/${file} is gone`);
    summary.deleted++;
  }
  for (const f of files) {
    if (!f.schedule) {
      if (f.errors?.length) {
        summary.refused.push({ file: f.file, reasons: f.errors });
        logger.warning(`Refused schedule file ${name}/${f.file}: ${f.errors.join("; ")}`);
      }
      continue;
    }
    const s = f.schedule;
    if (s.ignored.length) summary.ignored.push({ file: f.file, keys: s.ignored });
    const values = {
      name: s.name,
      description: s.description,
      form: s.form,
      rrule: s.rrule,
      enabled: s.enabled ? 1 : 0,
      extra_vars: extraVarsText(s.extraData),
      launch_options: launchOptionsText(s.launchOptions),
    };
    const row = own.get(f.file);
    try {
      if (f.adopt) {
        // git's version replaces the app's definition ; its runs, state and history stay
        await mysql.do(
          "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=?, repository=?, repo_file=?, cron=NULL, one_time_run=0, run_at=NULL WHERE id=?",
          [values.name, values.description, values.form, values.rrule, values.enabled, values.extra_vars, values.launch_options, name, f.file, f.adopt.id],
        );
        summary.matched.push(values.name);
        logger.notice(`Schedule '${values.name}' of the app now follows ${name}/${f.file}: git's version replaced it`);
      } else if (row) {
        const changed = Object.keys(values).some((k) => String(row[k] ?? "") !== String(values[k] ?? ""));
        if (!changed) {
          summary.unchanged++;
          continue;
        }
        await mysql.do(
          "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=?, cron=NULL, one_time_run=0, run_at=NULL WHERE id=?",
          [values.name, values.description, values.form, values.rrule, values.enabled, values.extra_vars, values.launch_options, row.id],
        );
        summary.updated++;
      } else {
        await mysql.do(
          "INSERT INTO AnsibleForms.`schedule` (name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, one_time_run, state) VALUES (?,?,?,?,?,?,?,?,?,0,'idle')",
          [values.name, values.description, values.form, values.rrule, values.enabled, values.extra_vars, values.launch_options, name, f.file],
        );
        summary.created++;
      }
    } catch (e) {
      // two files swapping their names in one pull, or a schedule made meanwhile : said, the
      // others go on
      summary.refused.push({ file: f.file, reasons: [`not saved: ${e.message || e}`] });
      logger.warning(`Could not save the schedule of ${name}/${f.file}: ${e.message || e}`);
    }
  }
  if (summary.created || summary.updated || summary.deleted || summary.matched.length) CrudModel.changed(MODEL);
  logger.info(
    `Schedules of repository '${name}': ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.refused.length} refused`,
  );
  return summary;
};

/**
 * What a sync did, as lines for the repository's pull output : the counts, each refused file
 * with why, and the fields a file gives that AnsibleForms keeps but does not use.
 *
 * Args:
 *   summary (object): syncRepository's result.
 *
 * Returns:
 *   string: the lines, starting with a newline.
 */
ScheduleRepo.summaryText = function (summary) {
  const lines = [
    `Schedules: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted, ${summary.unchanged} unchanged, ${summary.refused.length} refused`,
  ];
  if (summary.matched.length) lines.push(`Replaced by the file of the same name: ${summary.matched.join(", ")}`);
  for (const r of summary.refused) lines.push(`Refused ${r.file}: ${r.reasons.join("; ")}`);
  for (const i of summary.ignored) lines.push(`${i.file}: kept in the file, not used by AnsibleForms: ${i.keys.join(", ")}`);
  return "\n" + lines.join("\n");
};

/**
 * Syncs a repository's schedules after git changed its working tree (a pull, a clone, a reset) :
 * what it did, for its pull output. A failure is said there too, never thrown : the git
 * operation itself worked.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<string>: the lines for the pull output.
 */
ScheduleRepo.afterGit = async function (name) {
  try {
    return ScheduleRepo.summaryText(await ScheduleRepo.syncRepository(name));
  } catch (e) {
    logger.error(`The schedules of repository '${name}' could not be synchronized: ${e.message || e}`);
    return `\nSchedules not synchronized: ${e.message || e}`;
  }
};

/**
 * Syncs every schedules repository that is cloned (the worker's start), each under its write
 * claim ; one busy (a pull is running, it syncs itself) or failing does not stop the others.
 *
 * Returns:
 *   Promise<void>
 */
ScheduleRepo.syncAll = async function () {
  let names;
  try {
    names = await ScheduleRepo.repositories();
  } catch (e) {
    logger.error(`Could not read the schedules repositories: ${e.message || e}`);
    return;
  }
  const forms = names.length ? await formNames() : null;
  for (const name of names) {
    if (!fs.existsSync(Repo.folderOf(name))) continue;
    let prior;
    try {
      prior = await Repository.claimForWrite(name);
    } catch (e) {
      logger.debug(`Schedules of '${name}' not synchronized now: ${e.message}`);
      continue;
    }
    try {
      await ScheduleRepo.syncRepository(name, { forms });
    } catch (e) {
      logger.error(`The schedules of repository '${name}' could not be synchronized: ${e.message || e}`);
    } finally {
      await Repository.releaseWrite(name, prior).catch((e) => logger.error(`Failed to release write-lock on '${name}': ${e.message}`));
    }
  }
};

/**
 * Unlinks a repository's schedules (it is no longer used for schedules, or it is deleted) : they
 * stay in the app with everything they have (name, form, rrule, values, enabled, job options)
 * and keep running on their rrule ; only where they came from is cleared. The files in git are
 * not touched.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<number>: how many were unlinked.
 */
ScheduleRepo.unlinkRepository = async function (name) {
  const res = await mysql.do("UPDATE AnsibleForms.`schedule` SET repository = NULL, repo_file = NULL WHERE repository = ?", [name]);
  const unlinked = res?.affectedRows || 0;
  if (unlinked) {
    CrudModel.changed(MODEL);
    logger.notice(`Unlinked the ${unlinked} schedule(s) of repository '${name}': they stay in the app, on their rrule`);
  }
  return unlinked;
};

/**
 * The schedules repository, if there is one (there is one at most).
 *
 * Returns:
 *   Promise<string|null>: its name.
 */
ScheduleRepo.activeRepository = async function () {
  return (await ScheduleRepo.repositories())[0] || null;
};

/**
 * The app's recurring schedules a schedules repository would take : every recurring schedule
 * kept in the app (no repository, not a planned "Run later" job), each with the rrule it would be
 * written with - its own, or its cron as the rrule that fires at the same moments in the
 * scheduler's zone - or why it stays in the app.
 *
 * Returns:
 *   Promise<object[]>: { row, rrule } or { row, reason }.
 */
async function appRecurring() {
  const rows = await mysql.do(
    "SELECT id, name, description, form, cron, rrule, enabled, extra_vars, launch_options FROM AnsibleForms.`schedule` WHERE repository IS NULL AND owner IS NULL AND COALESCE(one_time_run,0) = 0 ORDER BY name",
  );
  return (rows || []).map((row) => {
    if (row.rrule && !validateRrule(row.rrule).length) return { row, rrule: normalizeRrule(row.rrule) };
    if (!row.cron) return { row, reason: "it has no cron nor rrule" };
    const converted = cronToRrule(row.cron, logConfig.tz || "UTC");
    return converted.rrule ? { row, rrule: converted.rrule } : { row, reason: converted.reason };
  });
}

/**
 * What making a repository the schedules repository would do, changing nothing : the app's
 * recurring schedules it would take (written as files), those whose cron a rrule cannot express
 * (staying in the app), the files whose name an app's schedule has (git's version would win), and
 * the one-time jobs that stay in the app.
 *
 * Args:
 *   name (string|null): the repository (its working copy read when it is cloned), null for one
 *     not made yet.
 *
 * Returns:
 *   Promise<object>: { repository, active, recurring, written: [name], kept: [{ name, cron,
 *     reason }], clashes: [name], files, planned, linked }.
 */
ScheduleRepo.preview = async function (name) {
  const recurring = await appRecurring();
  // the files there are now, by name (a pull before the activation may bring more)
  const fileNames = new Set();
  let files = 0;
  if (name && Repo.isValidName(name) && fs.existsSync(Repo.folderOf(name))) {
    for (const file of scheduleFilesOf(name)) {
      try {
        const parsed = parseScheduleFile(fs.readFileSync(path.join(Repo.folderOf(name), file), "utf8"));
        if (parsed.schedule) {
          files++;
          fileNames.add(nameKey(parsed.schedule.name));
        }
      } catch {
        // an unreadable file is refused by the sync, said then
      }
    }
  }
  const clashes = recurring.filter((r) => fileNames.has(nameKey(r.row.name))).map((r) => r.row.name);
  const clash = new Set(clashes);
  const planned = await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`schedule` WHERE repository IS NULL AND (owner IS NOT NULL OR COALESCE(one_time_run,0) = 1)");
  const linked = name ? await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`schedule` WHERE repository = ?", [name]) : [{ n: 0 }];
  return {
    repository: name || null,
    active: (await ScheduleRepo.activeRepository()) || null,
    recurring: recurring.length,
    written: recurring.filter((r) => r.rrule && !clash.has(r.row.name)).map((r) => r.row.name),
    kept: recurring.filter((r) => !r.rrule).map((r) => ({ name: r.row.name, cron: r.row.cron, reason: r.reason })),
    clashes,
    files,
    planned: Number(planned?.[0]?.n || 0),
    linked: Number(linked?.[0]?.n || 0),
  };
};

/**
 * Makes a repository the schedules repository, once its flag is saved : pulls it (clones it when
 * it is not yet), reads its files in (a file named as an app's recurring schedule takes it over,
 * git wins), then writes every other recurring schedule of the app to it as a new file, its cron
 * as the rrule that fires at the same moments, for its Push. The crons a rrule cannot express and
 * the one-time jobs stay in the app. A pull that fails is said and the working copy used as it is.
 *
 * Args:
 *   name (string): the repository.
 *   opts (object): { pull (false : the caller cloned it just now) }.
 *
 * Returns:
 *   Promise<object>: { repository, pull ('pulled', 'cloned', or why not), created, matched: [name],
 *     written: [name], kept: [{ name, reason }], refused: [{ file, reasons }], planned }.
 */
ScheduleRepo.activate = async function (name, { pull = true } = {}) {
  const report = { repository: name, pull: "", created: 0, matched: [], written: [], kept: [], refused: [], planned: 0 };
  // step 1 : the latest files (a pull of a schedules repository reads them in itself)
  if (pull) {
    try {
      if (fs.existsSync(Repo.folderOf(name))) {
        await Repository.pull(name);
        report.pull = "pulled";
      } else {
        await Repository.clone(name);
        report.pull = "cloned";
      }
    } catch (e) {
      report.pull = `not pulled: ${e.message || e}`;
      logger.warning(`Repository '${name}' could not be pulled to take the schedules, its working copy is used as it is: ${e.message || e}`);
    }
  }
  if (!fs.existsSync(Repo.folderOf(name))) {
    report.pull = report.pull || "not cloned";
    logger.warning(`Repository '${name}' is not cloned: its schedules are read in once it is`);
    return report;
  }
  // step 2 : its files read in (again : the pull may not have run), git wins on a name
  const summary = await ScheduleRepo.syncRepository(name);
  report.created = summary.created;
  report.matched = summary.matched;
  report.refused = summary.refused;
  // step 3 : the app's other recurring schedules, each a new file
  const candidates = await appRecurring();
  await withWriteClaim(name, async () => {
    const folder = schedulesFolderOf(name);
    for (const { row, rrule, reason } of candidates) {
      if (!rrule) {
        report.kept.push({ name: row.name, cron: row.cron, reason });
        continue;
      }
      try {
        fs.mkdirSync(folder, { recursive: true });
        const file = fileNameFor(row.name, (f) => fs.existsSync(path.join(folder, f)));
        const extraData = extraDataOf(row.extra_vars || "");
        fs.writeFileSync(
          path.join(folder, file),
          newScheduleFile({ name: row.name, description: row.description || "", rrule, enabled: Number(row.enabled ?? 1) !== 0, form: row.form || "", extraData }),
          "utf8",
        );
        await mysql.do("UPDATE AnsibleForms.`schedule` SET rrule=?, cron=NULL, repository=?, repo_file=? WHERE id=?", [rrule, name, `${SCHEDULES_FOLDER}/${file}`, row.id]);
        report.written.push(row.name);
      } catch (e) {
        report.kept.push({ name: row.name, cron: row.cron, reason: `not written: ${e.message || e}` });
      }
    }
  });
  const planned = await mysql.do("SELECT COUNT(*) AS n FROM AnsibleForms.`schedule` WHERE repository IS NULL AND (owner IS NOT NULL OR COALESCE(one_time_run,0) = 1)");
  report.planned = Number(planned?.[0]?.n || 0);
  if (report.written.length || report.matched.length) CrudModel.changed(MODEL);
  logger.notice(
    `Repository '${name}' holds the schedules now: ${report.created} read from its files, ${report.matched.length} replaced by a file of the same name, ${report.written.length} written to it (waiting for Push), ${report.kept.length} kept in the app${report.kept.length ? ` (${report.kept.map((k) => `${k.name}: ${k.reason}`).join("; ")})` : ""}`,
  );
  return report;
};

/**
 * Lets a repository go as the schedules repository (its flag taken off, or it is deleted) :
 * pulls it once more and reads its files in, so the schedules match the latest files (a pull that
 * fails is said, the working copy read as it is), then unlinks every schedule of it : they stay in
 * the app, on their rrule. The files in git are not touched.
 *
 * Args:
 *   name (string): the repository.
 *
 * Returns:
 *   Promise<object>: { repository, pull ('pulled' or why not), unlinked }.
 */
ScheduleRepo.deactivate = async function (name) {
  const report = { repository: name, pull: "", unlinked: 0 };
  if (Repo.isValidName(name) && fs.existsSync(Repo.folderOf(name))) {
    try {
      await Repository.pull(name);
      report.pull = "pulled";
    } catch (e) {
      report.pull = `not pulled: ${e.message || e}`;
      logger.warning(`Repository '${name}' could not be pulled before its schedules are unlinked, its working copy is read as it is: ${e.message || e}`);
    }
    try {
      await ScheduleRepo.syncRepository(name);
    } catch (e) {
      logger.error(`The schedules of repository '${name}' could not be read in before they are unlinked: ${e.message || e}`);
    }
  } else {
    report.pull = "not cloned";
  }
  report.unlinked = await ScheduleRepo.unlinkRepository(name);
  return report;
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
  const res = await mysql.do("UPDATE AnsibleForms.`schedule` SET repository = ? WHERE repository = ?", [to, from]);
  if (res?.affectedRows) CrudModel.changed(MODEL);
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
    if (forms && !forms.has(values.form)) throw new Errors.BadRequestError(`The form '${values.form}' does not exist.`);
  }
  if (values.rrule !== undefined) {
    const errors = validateRrule(values.rrule);
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
 * Runs a write in a repository's working tree under its write claim (no pull, sync or clone on
 * it meanwhile).
 *
 * Args:
 *   repository (string): the repository.
 *   write (function): the write.
 *
 * Returns:
 *   Promise<any>: what the write returns.
 */
async function withWriteClaim(repository, write) {
  const prior = await Repository.claimForWrite(repository);
  try {
    return await write();
  } finally {
    if (prior !== undefined) await Repository.releaseWrite(repository, prior).catch((e) => logger.error(`Failed to release write-lock on '${repository}': ${e.message}`));
  }
}

/**
 * Makes a schedule in a schedules repository : a new YAML file in its schedules folder, the
 * export form of one schedule, named after the schedule, and its row ; pushed with the repository's Push.
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
 *   Errors.ConflictError: the name of another schedule.
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
    const folder = schedulesFolderOf(repository);
    fs.mkdirSync(folder, { recursive: true });
    const file = fileNameFor(values.name, (f) => fs.existsSync(path.join(folder, f)));
    const abs = path.join(folder, file);
    const text = newScheduleFile({ ...values, extraData });
    const parsed = parseScheduleFile(text);
    fs.writeFileSync(abs, text, "utf8");
    try {
      const res = await mysql.do(
        "INSERT INTO AnsibleForms.`schedule` (name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, one_time_run, state) VALUES (?,?,?,?,?,?,?,?,?,0,'idle')",
        [values.name, values.description, values.form, values.rrule, values.enabled ? 1 : 0, extraVarsText(extraData), launchOptionsText(parsed.schedule?.launchOptions), repository, `${SCHEDULES_FOLDER}/${file}`],
      );
      CrudModel.changed(MODEL);
      logger.info(`Created schedule '${values.name}' in ${repository}/${SCHEDULES_FOLDER}/${file}`);
      return res.insertId;
    } catch (e) {
      // no file left behind for a schedule that was not made
      fs.rmSync(abs, { force: true });
      throw e;
    }
  });
};

/**
 * Saves the edit of a repository's schedule into its file - only the fields changed, the rest of
 * the file (its prompts, the keys AnsibleForms does not use, its comments) kept - and its row.
 * A file that is gone meanwhile is written again, whole.
 *
 * Args:
 *   row (object): the schedule as it is.
 *   data (object): any of { name, description, form, rrule, enabled, extra_vars }.
 *
 * Returns:
 *   Promise<void>
 *
 * Raises:
 *   Errors.BadRequestError: a value refused, or a file that is not a valid schedule any more.
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
  await withWriteClaim(row.repository, async () => {
    const abs = fileOf(row.repository, row.repo_file);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    let text;
    if (before === null) {
      const current = { name: row.name, description: row.description || "", form: row.form, rrule: row.rrule, enabled: !!Number(row.enabled ?? 1), extraData: extraDataOf(row.extra_vars || "") };
      text = newScheduleFile({ ...current, ...edits });
    } else {
      try {
        text = updateScheduleFile(before, edits);
      } catch (e) {
        throw new Errors.BadRequestError(`The file ${row.repository}/${row.repo_file} is not a valid schedule: ${e.message}`);
      }
    }
    const parsed = parseScheduleFile(text);
    if (!parsed.schedule) {
      throw new Errors.BadRequestError(`The file ${row.repository}/${row.repo_file} is not a valid schedule, fix it in git: ${parsed.errors.join("; ")}`);
    }
    if (text !== before) fs.writeFileSync(abs, text, "utf8");
    const s = parsed.schedule;
    try {
      await mysql.do(
        "UPDATE AnsibleForms.`schedule` SET name=?, description=?, form=?, rrule=?, enabled=?, extra_vars=?, launch_options=? WHERE id=?",
        [s.name, s.description, s.form, s.rrule, s.enabled ? 1 : 0, extraVarsText(s.extraData), launchOptionsText(s.launchOptions), row.id],
      );
    } catch (e) {
      // the file back as it was : it and the row say the same
      if (before === null) fs.rmSync(abs, { force: true });
      else fs.writeFileSync(abs, before, "utf8");
      throw e;
    }
    CrudModel.changed(MODEL);
    logger.info(`Saved schedule '${s.name}' into ${row.repository}/${row.repo_file}`);
  });
};

/**
 * Deletes a repository's schedule : its file, and its row ; pushed with the repository's Push.
 *
 * Args:
 *   row (object): the schedule.
 *
 * Returns:
 *   Promise<void>
 */
ScheduleRepo.delete = async function (row) {
  await withWriteClaim(row.repository, async () => {
    const abs = fileOf(row.repository, row.repo_file);
    fs.rmSync(abs, { force: true });
    await mysql.do("DELETE FROM AnsibleForms.`schedule` WHERE id = ?", [row.id]);
    CrudModel.changed(MODEL);
    logger.info(`Deleted schedule '${row.name}' and its file ${row.repository}/${row.repo_file}`);
  });
};

export default ScheduleRepo;
