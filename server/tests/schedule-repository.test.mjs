// The schedules of a schedules repository (models/scheduleRepo.model.js), both ways :
//   git to app : a pull reads its schedules folder into the schedule table - new files make
//                schedules, changed ones change them, removed ones remove them ; a refused file
//                (its rrule is refused, its form does not exist, its name is taken) is said and
//                changes nothing, the others still sync.
//   app to git : a schedule of a repository edited, made or deleted in the app writes or removes
//                its file in the working tree, under the repository's write claim, for its Push.
import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// ─── a schedule table in memory, for the statements the model runs ─────────────
let rows;
let nextId;
let repositories;
const db = {
  do: async (sql, params = []) => {
    if (/^SELECT name FROM AnsibleForms.`repositories` WHERE use_for_schedules/.test(sql)) return repositories.filter((r) => r.use_for_schedules);
    if (/^SELECT name, use_for_schedules FROM AnsibleForms.`repositories` WHERE name = \?/.test(sql)) return repositories.filter((r) => r.name === params[0]);
    if (/^SELECT id FROM AnsibleForms.`schedule` WHERE LOWER\(name\) = \?/.test(sql)) {
      return rows.filter((r) => r.name.toLowerCase() === params[0] && (params[1] === null || r.id !== params[2]));
    }
    if (/^SELECT .* FROM AnsibleForms.`schedule`$/.test(sql)) return rows.map((r) => ({ ...r }));
    if (/^SELECT \* FROM AnsibleForms.`schedule` WHERE id = \?$/.test(sql)) return rows.filter((r) => r.id === params[0]).map((r) => ({ ...r }));
    // the app's recurring schedules (activation)
    if (/WHERE repository IS NULL AND owner IS NULL AND COALESCE\(one_time_run,0\) = 0/.test(sql)) {
      return rows.filter((r) => !r.repository && !r.owner && !Number(r.one_time_run)).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r }));
    }
    if (/^SELECT COUNT\(\*\) AS n FROM AnsibleForms.`schedule` WHERE repository IS NULL AND \(owner/.test(sql)) {
      return [{ n: rows.filter((r) => !r.repository && (r.owner || Number(r.one_time_run))).length }];
    }
    if (/^SELECT COUNT\(\*\) AS n FROM AnsibleForms.`schedule` WHERE repository = \?/.test(sql)) return [{ n: rows.filter((r) => r.repository === params[0]).length }];
    if (/^UPDATE AnsibleForms.`schedule` SET repository = NULL, repo_file = NULL WHERE repository = \?/.test(sql)) {
      const hit = rows.filter((r) => r.repository === params[0]);
      hit.forEach((r) => Object.assign(r, { repository: null, repo_file: null }));
      return { affectedRows: hit.length };
    }
    if (/^UPDATE AnsibleForms.`schedule` SET rrule=\?, cron=NULL, repository=\?, repo_file=\? WHERE id=\?/.test(sql)) {
      Object.assign(rows.find((r) => r.id === params[3]), { rrule: params[0], cron: null, repository: params[1], repo_file: params[2] });
      return { affectedRows: 1 };
    }
    if (/^DELETE FROM AnsibleForms.`schedule` WHERE id = \?/.test(sql)) {
      rows = rows.filter((r) => r.id !== params[0]);
      return { affectedRows: 1 };
    }
    if (/^DELETE FROM AnsibleForms.`schedule` WHERE repository = \?/.test(sql)) {
      const before = rows.length;
      rows = rows.filter((r) => r.repository !== params[0]);
      return { affectedRows: before - rows.length };
    }
    if (/^UPDATE AnsibleForms.`schedule` SET repository = \?/.test(sql)) {
      rows.filter((r) => r.repository === params[1]).forEach((r) => (r.repository = params[0]));
      return { affectedRows: 1 };
    }
    const unique = (name, id) => {
      if (rows.some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) throw new Error(`Duplicate entry '${name}' for key 'uk_schedule_natural_key'`);
    };
    if (/^UPDATE AnsibleForms.`schedule` SET name=\?/.test(sql)) {
      const id = params[params.length - 1];
      unique(params[0], id);
      const row = rows.find((r) => r.id === id);
      const [name, description, form, rrule, enabled, extra_vars, launch_options] = params;
      Object.assign(row, { name, description, form, rrule, enabled, extra_vars, launch_options });
      // a file taking an app's schedule over : it is linked, its cron gone
      if (params.length === 10) Object.assign(row, { repository: params[7], repo_file: params[8], cron: null });
      return { affectedRows: 1 };
    }
    if (/^INSERT INTO AnsibleForms.`schedule`/.test(sql)) {
      unique(params[0], null);
      const [name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file] = params;
      const id = nextId++;
      rows.push({ id, name, description, form, rrule, enabled, extra_vars, launch_options, repository, repo_file, state: "idle", last_run: null });
      return { insertId: id, affectedRows: 1 };
    }
    throw new Error(`unexpected statement: ${sql}`);
  },
  tryDo: async () => [],
};
vi.mock("../src/models/db.model.js", () => ({ default: db }));

// the repositories' working trees in a folder of their own
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "af-schedules-"));
vi.mock("../src/models/repo.model.js", () => ({
  default: { folderOf: (name) => path.join(ROOT, name), isValidName: (name) => /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(name || "") },
}));

// the write claim, counted
const claims = [];
let pullFails = false;
const pulls = [];
vi.mock("../src/models/repository.model.js", () => ({
  default: {
    pull: async (name) => {
      pulls.push(name);
      if (pullFails) throw new Error("remote unreachable");
    },
    clone: async () => {},
    claimForWrite: async (name) => {
      claims.push(["claim", name]);
      return "success";
    },
    releaseWrite: async (name) => {
      claims.push(["release", name]);
    },
  },
}));

// the forms there are
let forms;
vi.mock("../src/models/form.model.js", () => ({ default: { load: async () => ({ forms: forms.map((name) => ({ name })) }) } }));
const changed = [];
vi.mock("../src/models/crud.model.js", () => ({ default: { changed: (m) => changed.push(m) } }));

const { default: ScheduleRepo } = await import("../src/models/scheduleRepo.model.js");

// ─── helpers ───────────────────────────────────────────────────────────────────
const RRULE = "DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1";
const scheduleYaml = (name, extra = {}) => YAML.stringify({ name, unified_job_template: { name: "Nightly", type: "job_template" }, rrule: RRULE, ...extra });
function writeFile(repo, file, text) {
  const dir = path.join(ROOT, repo, "schedules");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
const readFile = (repo, file) => fs.readFileSync(path.join(ROOT, repo, "schedules", file), "utf8");
const fileExists = (repo, file) => fs.existsSync(path.join(ROOT, repo, "schedules", file));
const own = (repo) => rows.filter((r) => r.repository === repo).sort((a, b) => a.repo_file.localeCompare(b.repo_file));

beforeEach(() => {
  rows = [];
  nextId = 1;
  repositories = [
    { name: "ops", use_for_schedules: 1 },
    { name: "team", use_for_schedules: 1 },
    { name: "forms", use_for_schedules: 0 },
  ];
  forms = ["Nightly", "Report"];
  claims.length = 0;
  changed.length = 0;
  pulls.length = 0;
  pullFails = false;
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});
afterEach(() => vi.restoreAllMocks());

// ─── git to app ────────────────────────────────────────────────────────────────
describe("a pull reads the schedules folder into the schedule table", () => {
  test("new files make schedules, timed by their rrule, run as the Schedule Service (no owner)", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs", { extra_data: { days: 14 }, limit: "web" }));
    writeFile("ops", "b.yml", scheduleYaml("Clean tmp", { enabled: false }));
    // nothing outside the schedules folder is read
    fs.writeFileSync(path.join(ROOT, "ops", "other.yaml"), scheduleYaml("Not a schedule"));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 2);
    const [a, b] = own("ops");
    assert.equal(a.name, "Rotate logs");
    assert.equal(a.repo_file, "schedules/a.yaml");
    assert.equal(a.rrule, RRULE);
    assert.equal(a.extra_vars, "days: 14\n");
    assert.deepEqual(JSON.parse(a.launch_options), { __limit__: "web" });
    assert.equal(a.owner, undefined);
    assert.equal(b.enabled, 0);
    assert.deepEqual(changed, ["schedule"]);
  });

  test("a changed file changes its schedule's definition, never what runs it", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    Object.assign(rows[0], { state: "queued", last_run: "2026-10-19 02:00:00" });
    writeFile("ops", "a.yaml", scheduleYaml("Rotate all logs", { description: "every night" }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.updated, 1);
    assert.equal(rows[0].id, 1, "the same schedule");
    assert.equal(rows[0].name, "Rotate all logs");
    assert.equal(rows[0].description, "every night");
    assert.equal(rows[0].state, "queued");
    assert.equal(rows[0].last_run, "2026-10-19 02:00:00");
  });

  test("an unchanged file changes nothing", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    changed.length = 0;
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.unchanged, 1);
    assert.deepEqual(changed, []);
  });

  test("a removed file (or one saying state: absent) removes its schedule", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    writeFile("ops", "b.yaml", scheduleYaml("Clean tmp"));
    await ScheduleRepo.syncRepository("ops");
    fs.rmSync(path.join(ROOT, "ops", "schedules", "a.yaml"));
    writeFile("ops", "b.yaml", scheduleYaml("Clean tmp", { state: "absent" }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.deleted, 2);
    assert.deepEqual(own("ops"), []);
  });

  test("a bad file is refused alone, said with its name ; the others still sync", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    writeFile("ops", "bad-rrule.yaml", scheduleYaml("Bad", { rrule: "DTSTART:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1" }));
    writeFile("ops", "no-form.yaml", YAML.stringify({ name: "No form", unified_job_template: { name: "Missing" }, rrule: RRULE }));
    writeFile("ops", "z.yaml", scheduleYaml("Last one"));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 2);
    assert.deepEqual(summary.refused.map((r) => r.file), ["schedules/bad-rrule.yaml", "schedules/no-form.yaml"]);
    assert.ok(summary.refused[0].reasons[0].includes("naive"));
    assert.ok(summary.refused[1].reasons[0].includes("the form 'Missing'"));
    const text = ScheduleRepo.summaryText(summary);
    assert.ok(text.includes("Schedules: 2 created"));
    assert.ok(text.includes("Refused schedules/bad-rrule.yaml:"));
  });

  test("a file that becomes bad keeps its schedule as it was", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    writeFile("ops", "a.yaml", "name: [broken");
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.deleted, 0);
    assert.equal(summary.refused.length, 1);
    assert.equal(own("ops")[0].name, "Rotate logs");
  });

  test("a duplicate name is refused : in the same repository, in another one, or a one-time job's", async () => {
    rows.push({ id: 90, name: "App made", repository: null, repo_file: null, owner: '{"username":"bob"}', one_time_run: 1 });
    nextId = 100;
    writeFile("team", "x.yaml", scheduleYaml("Shared name"));
    await ScheduleRepo.syncRepository("team");
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    writeFile("ops", "b.yaml", scheduleYaml("rotate LOGS"));
    writeFile("ops", "c.yaml", scheduleYaml("Shared name"));
    writeFile("ops", "d.yaml", scheduleYaml("App made"));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 1);
    assert.deepEqual(summary.refused.map((r) => r.file), ["schedules/b.yaml", "schedules/c.yaml", "schedules/d.yaml"]);
    assert.ok(summary.refused[1].reasons[0].includes("repository 'team'"));
    assert.ok(summary.refused[2].reasons[0].includes("a one-time job of this app"));
  });

  test("the fields AnsibleForms does not use are said in the pull output", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs", { forks: 5, labels: ["x"] }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.ok(ScheduleRepo.summaryText(summary).includes("schedules/a.yaml: kept in the file, not used by AnsibleForms: forks, labels"));
  });

  test("a file named as a recurring schedule of the app takes it over : git wins, its runs kept", async () => {
    rows.push({ id: 40, name: "Rotate logs", form: "Report", cron: "0 3 * * *", repository: null, repo_file: null, owner: null, one_time_run: 0, state: "idle", last_run: "2026-10-19 03:00:00", status: "success" });
    nextId = 50;
    writeFile("ops", "a.yaml", scheduleYaml("rotate logs", { extra_data: { days: 3 } }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.deepEqual(summary.matched, ["rotate logs"]);
    assert.equal(summary.created, 0);
    const row = rows.find((r) => r.id === 40);
    assert.equal(row.repository, "ops");
    assert.equal(row.repo_file, "schedules/a.yaml");
    assert.equal(row.form, "Nightly", "git's definition");
    assert.equal(row.rrule, RRULE);
    assert.equal(row.cron, null);
    assert.equal(row.last_run, "2026-10-19 03:00:00", "its history kept");
    assert.equal(row.status, "success");
  });

  test("a rename of the repository follows", async () => {
    writeFile("team", "a.yaml", scheduleYaml("Team job"));
    await ScheduleRepo.syncRepository("team");
    await ScheduleRepo.renameRepository("team", "team2");
    assert.equal(own("team2").length, 1);
  });

  test("at the worker's start every cloned schedules repository is synced, under its write claim", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncAll();
    assert.equal(own("ops").length, 1);
    assert.deepEqual(claims, [["claim", "ops"], ["release", "ops"]]);
  });
});

// ─── activation and deactivation ───────────────────────────────────────────────
describe("made the schedules repository, it takes the app's recurring schedules", () => {
  const appRows = () => {
    rows.push(
      { id: 1, name: "Every five", form: "Report", cron: "*/5 * * * *", rrule: null, enabled: 1, extra_vars: "a: 1\n", repository: null, owner: null, one_time_run: 0 },
      { id: 2, name: "Weekdays", form: "Report", cron: "0 8 * * 1-5", rrule: null, enabled: 0, extra_vars: "", repository: null, owner: null, one_time_run: 0 },
      { id: 3, name: "First or Monday", form: "Report", cron: "0 0 1 * 1", rrule: null, enabled: 1, extra_vars: "", repository: null, owner: null, one_time_run: 0 },
      { id: 4, name: "Run later", form: "Report", cron: null, run_at: "2030-01-01", repository: null, owner: '{"username":"bob"}', one_time_run: 1 },
      { id: 5, name: "Clash", form: "Report", cron: "0 4 * * *", rrule: null, enabled: 1, repository: null, owner: null, one_time_run: 0, last_run: "2026-10-19 04:00:00" },
    );
    nextId = 10;
    writeFile("ops", "clash.yaml", scheduleYaml("Clash"));
  };

  test("the preview counts what it would do, changing nothing", async () => {
    appRows();
    const before = JSON.stringify(rows);
    const preview = await ScheduleRepo.preview("ops");
    assert.equal(preview.recurring, 4);
    assert.deepEqual(preview.written, ["Every five", "Weekdays"]);
    assert.deepEqual(preview.kept.map((k) => k.name), ["First or Monday"]);
    assert.ok(preview.kept[0].reason.includes("day of the month and the day of the week"));
    assert.deepEqual(preview.clashes, ["Clash"]);
    assert.equal(preview.planned, 1);
    assert.equal(preview.files, 1);
    assert.equal(JSON.stringify(rows), before);
    assert.deepEqual(pulls, []);
  });

  test("activation : pulled, git wins on a clash, convertible crons written as files, the rest kept in the app", async () => {
    appRows();
    const report = await ScheduleRepo.activate("ops");
    assert.deepEqual(pulls, ["ops"]);
    assert.equal(report.pull, "pulled");
    assert.deepEqual(report.matched, ["Clash"]);
    assert.deepEqual(report.written, ["Every five", "Weekdays"]);
    assert.deepEqual(report.kept.map((k) => k.name), ["First or Monday"]);
    assert.equal(report.planned, 1);
    // the clash : the file's definition, its history kept
    const clash = rows.find((r) => r.id === 5);
    assert.equal(clash.repo_file, "schedules/clash.yaml");
    assert.equal(clash.last_run, "2026-10-19 04:00:00");
    // the written ones : a file each, the row linked, on its rrule
    const five = rows.find((r) => r.id === 1);
    assert.equal(five.repository, "ops");
    assert.equal(five.repo_file, "schedules/every-five.yaml");
    assert.equal(five.cron, null);
    assert.match(five.rrule, /RRULE:FREQ=MINUTELY;INTERVAL=5$/);
    const file = YAML.parse(readFile("ops", "every-five.yaml"));
    assert.equal(file.name, "Every five");
    assert.equal(file.rrule, five.rrule);
    assert.deepEqual(file.extra_data, { a: 1 });
    assert.equal(YAML.parse(readFile("ops", "weekdays.yaml")).enabled, false);
    // the inconvertible cron and the planned job stay in the app, never written
    assert.equal(rows.find((r) => r.id === 3).repository, null);
    assert.equal(rows.find((r) => r.id === 3).cron, "0 0 1 * 1");
    assert.equal(rows.find((r) => r.id === 4).repository, null);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, "ops", "schedules")).sort(), ["clash.yaml", "every-five.yaml", "weekdays.yaml"]);
  });

  test("a pull that fails is said, the working copy used as it is", async () => {
    appRows();
    pullFails = true;
    const report = await ScheduleRepo.activate("ops");
    assert.match(report.pull, /^not pulled: remote unreachable/);
    assert.deepEqual(report.written, ["Every five", "Weekdays"]);
  });

  test("a file name taken gets a number", async () => {
    appRows();
    writeFile("ops", "every-five.yaml", "not: a schedule\n");
    await ScheduleRepo.activate("ops", { pull: false });
    assert.equal(rows.find((r) => r.id === 1).repo_file, "schedules/every-five-2.yaml");
  });
});

describe("no longer the schedules repository, its schedules stay in the app", () => {
  test("pulled once more, read in, then unlinked : everything kept, still on their rrule, the files untouched", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs", { limit: "web", extra_data: { days: 2 } }));
    await ScheduleRepo.syncRepository("ops");
    // a change in git the last pull brings
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs", { limit: "db", extra_data: { days: 2 } }));
    const before = readFile("ops", "a.yaml");
    const report = await ScheduleRepo.deactivate("ops");
    assert.deepEqual(pulls, ["ops"]);
    assert.equal(report.unlinked, 1);
    const row = rows[0];
    assert.equal(row.repository, null);
    assert.equal(row.repo_file, null);
    assert.equal(row.name, "Rotate logs");
    assert.equal(row.rrule, RRULE);
    assert.equal(row.form, "Nightly");
    assert.equal(row.extra_vars, "days: 2\n");
    assert.deepEqual(JSON.parse(row.launch_options), { __limit__: "db" });
    assert.equal(readFile("ops", "a.yaml"), before);
    // still due on its rrule
    const { nextRun } = await import("../src/lib/scheduleRrule.js");
    assert.ok(nextRun(row.rrule) instanceof Date);
  });

  test("a repository that cannot be reached is said, the schedules unlinked all the same", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    pullFails = true;
    const report = await ScheduleRepo.deactivate("ops");
    assert.match(report.pull, /^not pulled/);
    assert.equal(report.unlinked, 1);
  });
});

// ─── app to git ────────────────────────────────────────────────────────────────
describe("an edit in the app goes to the file", () => {
  test("a new schedule in a repository : a new file in the export's form, and its row", async () => {
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    const id = await ScheduleRepo.create("ops", { name: "Weekly Report", form: "Report", rrule: RRULE, extra_vars: "to: ops\n" });
    const row = rows.find((r) => r.id === id);
    assert.equal(row.repo_file, "schedules/weekly-report.yaml");
    assert.equal(row.repository, "ops");
    const obj = YAML.parse(readFile("ops", "weekly-report.yaml"));
    assert.equal(obj.name, "Weekly Report");
    assert.deepEqual(obj.unified_job_template, { name: "Report", type: "job_template" });
    assert.deepEqual(obj.extra_data, { to: "ops" });
    assert.equal(obj.rrule, RRULE);
    assert.deepEqual(claims, [["claim", "ops"], ["release", "ops"]]);
    // and a pull reads it back unchanged
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.unchanged, 1);
  });

  test("a new schedule sent with a cron is written with the rrule that fires at the same moments", async () => {
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    const id = await ScheduleRepo.create("ops", { name: "Hourly", form: "Report", cron: "0 * * * *" });
    assert.match(rows.find((r) => r.id === id).rrule, /RRULE:FREQ=HOURLY;INTERVAL=1$/);
    await assert.rejects(ScheduleRepo.create("ops", { name: "Odd", form: "Report", cron: "0 0 1 * 1" }), /cannot be written as a rrule/);
  });

  test("a new schedule is refused : not a schedules repository, a refused rrule, a taken name, an unknown form", async () => {
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    await assert.rejects(ScheduleRepo.create("forms", { name: "x", form: "Report", rrule: RRULE }), { name: "BadRequestError" });
    await assert.rejects(ScheduleRepo.create("ops", { name: "x", form: "Report", rrule: "DTSTART:20300101T000000Z RRULE:FREQ=SECONDLY;INTERVAL=1" }), {
      name: "BadRequestError",
    });
    await assert.rejects(ScheduleRepo.create("ops", { name: "x", form: "Nope", rrule: RRULE }), { name: "BadRequestError" });
    rows.push({ id: 50, name: "Taken", repository: null });
    await assert.rejects(ScheduleRepo.create("ops", { name: "taken", form: "Report", rrule: RRULE }), { name: "ConflictError" });
    assert.deepEqual(fs.existsSync(path.join(ROOT, "ops", "schedules")) ? fs.readdirSync(path.join(ROOT, "ops", "schedules")) : [], []);
  });

  test("an edit writes the changed fields into the file, keeping what AnsibleForms does not use", async () => {
    writeFile("ops", "a.yaml", `# owned by ops\n${scheduleYaml("Rotate logs", { forks: 5, limit: "web", custom: { a: 1 } })}`);
    await ScheduleRepo.syncRepository("ops");
    await ScheduleRepo.update(rows[0], { name: "Rotate", enabled: 0, extra_vars: "days: 3", rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=WEEKLY;INTERVAL=1" });
    const text = readFile("ops", "a.yaml");
    assert.ok(text.startsWith("# owned by ops\n"));
    const obj = YAML.parse(text);
    assert.equal(obj.name, "Rotate");
    assert.equal(obj.enabled, false);
    assert.deepEqual(obj.extra_data, { days: 3 });
    assert.equal(obj.rrule, "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=WEEKLY;INTERVAL=1");
    assert.equal(obj.forks, 5);
    assert.equal(obj.limit, "web");
    assert.deepEqual(obj.custom, { a: 1 });
    assert.equal(rows[0].name, "Rotate");
    assert.equal(rows[0].enabled, 0);
    assert.deepEqual(JSON.parse(rows[0].launch_options), { __limit__: "web" });
    // the next pull finds nothing to change
    assert.equal((await ScheduleRepo.syncRepository("ops")).unchanged, 1);
  });

  test("an edit the database refuses leaves the file as it was", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    const before = readFile("ops", "a.yaml");
    const original = db.do;
    db.do = async (sql, params) => {
      if (/^UPDATE AnsibleForms.`schedule` SET name=\?/.test(sql)) throw new Error("database gone");
      return original(sql, params);
    };
    try {
      await assert.rejects(ScheduleRepo.update(rows[0], { description: "new" }), /database gone/);
    } finally {
      db.do = original;
    }
    assert.equal(readFile("ops", "a.yaml"), before);
    assert.deepEqual(claims.slice(-1), [["release", "ops"]]);
  });

  test("an edit read before a pull that removed its schedule does not bring it back", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    // the schedule as the edit read it ...
    const stale = { ...rows[0] };
    // ... then a pull, its file gone from git : the schedule goes
    fs.rmSync(path.join(ROOT, "ops", "schedules", "a.yaml"));
    await ScheduleRepo.syncRepository("ops");
    assert.deepEqual(rows, []);
    await assert.rejects(ScheduleRepo.update(stale, { description: "new" }), { name: "NotFoundError" });
    // no file written back, the next pull makes nothing
    assert.equal(fileExists("ops", "a.yaml"), false);
    assert.equal((await ScheduleRepo.syncRepository("ops")).created, 0);
    assert.deepEqual(rows, []);
  });

  test("a delete removes the file and the row", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    await ScheduleRepo.delete(rows[0]);
    assert.equal(fileExists("ops", "a.yaml"), false);
    assert.deepEqual(rows, []);
  });
});
