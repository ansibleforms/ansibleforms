// The schedules of a schedules repository (models/scheduleRepo.model.js), both ways :
//   git to app : a pull reads its schedules: entries into the schedule table - new names make
//                schedules, changed entries change them, removed ones remove them ; a refused entry
//                (its rrule is refused, its form does not exist, its name is taken) is said and
//                changes nothing, the others still sync.
//   app to git : a schedule of a repository edited, made or deleted in the app writes or removes
//                its entry in the working tree, under the repository's write claim, for its Push.
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
    // the app's schedules, whatever their timing, not the jobs users planned (activation)
    if (/WHERE repository IS NULL AND owner IS NULL ORDER BY name/.test(sql)) {
      return rows.filter((r) => !r.repository && !r.owner).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r }));
    }
    if (/^SELECT COUNT\(\*\) AS n FROM AnsibleForms.`schedule` WHERE repository IS NULL AND owner IS NOT NULL/.test(sql)) {
      return [{ n: rows.filter((r) => !r.repository && r.owner).length }];
    }
    // the one-time schedules waiting for their run
    if (/^SELECT name FROM AnsibleForms.`schedule` WHERE one_time_run = 1 AND last_run IS NULL/.test(sql)) {
      return rows.filter((r) => Number(r.one_time_run) === 1 && !r.last_run).map((r) => ({ name: r.name }));
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
      // the columns it sets, in its order, each with its value
      const columns = sql.match(/SET (.*) WHERE/)[1].split(",").map((c) => c.trim().replace(/=\?$/, ""));
      columns.forEach((c, i) => (row[c] = params[i]));
      return { affectedRows: 1 };
    }
    if (/^INSERT INTO AnsibleForms.`schedule`/.test(sql)) {
      unique(params[0], null);
      const columns = sql.match(/\(([^)]*)\) VALUES/)[1].split(",").map((c) => c.trim());
      const id = nextId++;
      const row = { id, last_run: null };
      columns.forEach((c, i) => (row[c] = i < params.length ? params[i] : "idle"));
      rows.push(row);
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
// ... null : the configuration not readable (its roles not valid), the load throws
vi.mock("../src/models/form.model.js", () => ({
  default: {
    load: async () => {
      if (forms === null) throw new Error("Role 'admin', .groups must be equal to constant");
      return { forms: forms.map((name) => ({ name })) };
    },
  },
}));
const changed = [];
vi.mock("../src/models/crud.model.js", () => ({ default: { changed: (m) => changed.push(m) } }));

const { default: ScheduleRepo } = await import("../src/models/scheduleRepo.model.js");

// ─── helpers ───────────────────────────────────────────────────────────────────
const RRULE = "DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1";
// a file holding one schedule, as an entry of its schedules: list
const scheduleYaml = (name, extra = {}) => YAML.stringify({ controller_schedules: [{ name, form: "Nightly", rrule: RRULE, ...extra }] });
// the schedule a file's text holds (its first entry, or the one of a name)
const entryOf = (text, name) => (YAML.parse(text).controller_schedules || []).find((e) => name === undefined || e.name === name);
function writeFile(repo, file, text) {
  const dir = path.join(ROOT, repo, "schedules");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
const readFile = (repo, file) => fs.readFileSync(path.join(ROOT, repo, "schedules", file), "utf8");
const readFile_ = (repo, file) => fs.readFileSync(path.join(ROOT, repo, file), "utf8");
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
describe("a pull reads the schedules: entries into the schedule table", () => {
  test("new files make schedules, timed by their rrule, run as the Schedule Service (no owner)", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs", { extra_data: { days: 14 }, limit: "web" }));
    writeFile("ops", "b.yml", scheduleYaml("Clean tmp", { enabled: false }));
    // any file giving schedules:, whatever its name or folder ; a file that does not is none of theirs
    fs.writeFileSync(path.join(ROOT, "ops", "other.yaml"), scheduleYaml("Elsewhere"));
    fs.writeFileSync(path.join(ROOT, "ops", "playbook.yaml"), YAML.stringify([{ hosts: "all", tasks: [] }]));
    fs.writeFileSync(path.join(ROOT, "ops", "vars.yaml"), YAML.stringify({ name: "Not a schedule", rrule: RRULE }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 3);
    assert.deepEqual(summary.refused, []);
    assert.equal(rows.find((r) => r.name === "Elsewhere").repo_file, "other.yaml");
    const [a, b] = own("ops").filter((r) => r.repo_file.startsWith("schedules/"));
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
    writeFile("ops", "no-form.yaml", YAML.stringify({ controller_schedules: [{ name: "No form", form: "Missing", rrule: RRULE }] }));
    writeFile("ops", "z.yaml", scheduleYaml("Last one"));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 2);
    assert.deepEqual(summary.refused.map((r) => r.file), ["schedules/bad-rrule.yaml#Bad", "schedules/no-form.yaml#No form"]);
    assert.ok(summary.refused[0].reasons[0].includes("naive"));
    assert.ok(summary.refused[1].reasons[0].includes("the form 'Missing'"));
    const text = ScheduleRepo.summaryText(summary);
    assert.ok(text.includes("Schedules: 2 created"));
    assert.ok(text.includes("Refused schedules/bad-rrule.yaml#Bad:"));
  });

  test("the forms not readable (the configuration not valid) : every entry refused, never imported unchecked ; its schedule kept as it was", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    forms = null;
    writeFile("ops", "a.yaml", scheduleYaml("Rotate all logs"));
    writeFile("ops", "ghost.yaml", YAML.stringify({ controller_schedules: [{ name: "Ghost", form: "Does not exist", rrule: RRULE }] }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 0);
    assert.equal(summary.deleted, 0);
    assert.deepEqual(summary.refused.map((r) => r.file), ["schedules/a.yaml#Rotate all logs", "schedules/ghost.yaml#Ghost"]);
    assert.match(summary.refused[1].reasons[0], /the forms could not be read/);
    assert.deepEqual(own("ops").map((r) => r.name), ["Rotate logs"]);
    // a save of the app : refused too
    await assert.rejects(ScheduleRepo.create("ops", { name: "x", form: "Report", rrule: RRULE }), { name: "ConflictError" });
    // readable again : the next pull takes the files
    forms = ["Nightly", "Report"];
    const after = await ScheduleRepo.syncRepository("ops");
    assert.equal(after.updated, 1);
    assert.deepEqual(after.refused.map((r) => r.file), ["schedules/ghost.yaml#Ghost"]);
    assert.match(after.refused[0].reasons[0], /the form 'Does not exist'/);
  });

  test("the form is the entry's form: key ; an entry naming it by unified_job_template only has no form, refused and said", async () => {
    writeFile("ops", "a.yaml", YAML.stringify({ controller_schedules: [{ name: "Old shape", unified_job_template: { name: "Nightly", type: "job_template" }, rrule: RRULE }] }));
    writeFile("ops", "b.yaml", YAML.stringify({ controller_schedules: [{ name: "Both", form: "Report", unified_job_template: { name: "Nightly" }, rrule: RRULE }] }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.deepEqual(summary.refused.map((r) => r.file), ["schedules/a.yaml#Old shape"]);
    assert.match(summary.refused[0].reasons[0], /form \(the form it runs\) is required/);
    // beside a form : a key it does not know, kept in the file, the form the form: key
    assert.equal(rows.find((r) => r.name === "Both").form, "Report");
    await ScheduleRepo.update(rows.find((r) => r.name === "Both"), { form: "Nightly" });
    const e = entryOf(readFile("ops", "b.yaml"));
    assert.deepEqual([e.form, e.unified_job_template], ["Nightly", { name: "Nightly" }]);
  });

  test("a file that becomes bad keeps its schedule as it was", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    writeFile("ops", "a.yaml", "controller_schedules:\n  - name: [broken");
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.deleted, 0);
    assert.equal(summary.refused.length, 1);
    assert.equal(own("ops")[0].name, "Rotate logs");
  });

  test("a duplicate name is refused : two entries of it, both ; another repository's, or a one-time job's", async () => {
    rows.push({ id: 90, name: "App made", repository: null, repo_file: null, owner: '{"username":"bob"}', one_time_run: 1 });
    nextId = 100;
    writeFile("team", "x.yaml", scheduleYaml("Shared name"));
    await ScheduleRepo.syncRepository("team");
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    writeFile("ops", "b.yaml", scheduleYaml("rotate LOGS"));
    writeFile("ops", "c.yaml", scheduleYaml("Shared name"));
    writeFile("ops", "d.yaml", scheduleYaml("App made"));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 0);
    assert.deepEqual(summary.refused.map((r) => r.file), ["schedules/a.yaml#Rotate logs", "schedules/b.yaml#rotate LOGS", "schedules/c.yaml#Shared name", "schedules/d.yaml#App made"]);
    assert.match(summary.refused[0].reasons[0], /the name 'Rotate logs' is given twice: here \(schedules\/a\.yaml, entry 1\) and in schedules\/b\.yaml \(entry 1\)/);
    assert.ok(summary.refused[2].reasons[0].includes("repository 'team'"));
    assert.ok(summary.refused[3].reasons[0].includes("a one-time job of this app"));
  });

  test("the fields AnsibleForms does not use are said in the pull output", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs", { forks: 5, labels: ["x"] }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.ok(ScheduleRepo.summaryText(summary).includes("schedules/a.yaml#Rotate logs: kept in the file, not used by AnsibleForms: forks, labels"));
  });

  test("an entry named as a recurring schedule of the app takes it over : git wins, its runs kept", async () => {
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
describe("made the schedules repository, it takes the app's schedules, each with its own timing", () => {
  const appRows = () => {
    rows.push(
      { id: 1, name: "Every five", form: "Report", cron: "*/5 * * * *", rrule: null, enabled: 1, extra_vars: "a: 1\n", repository: null, owner: null, one_time_run: 0 },
      { id: 2, name: "Weekdays", form: "Report", cron: "0 8 * * 1-5", rrule: null, enabled: 0, extra_vars: "", repository: null, owner: null, one_time_run: 0 },
      // a cron no rrule could express : handed over as it is all the same
      { id: 3, name: "First or Monday", form: "Report", cron: "0 0 1 * 1", rrule: null, enabled: 1, extra_vars: "", repository: null, owner: null, one_time_run: 0 },
      // a job a user planned ("Run later") : that user's, it stays
      { id: 4, name: "Run later", form: "Report", cron: null, run_at: "2030-01-01 00:00:00", repository: null, owner: '{"username":"bob"}', one_time_run: 1 },
      { id: 5, name: "Clash", form: "Report", cron: "0 4 * * *", rrule: null, enabled: 1, repository: null, owner: null, one_time_run: 0, last_run: "2026-10-19 04:00:00" },
      { id: 6, name: "Weekly", form: "Report", cron: null, rrule: "DTSTART;TZID=UTC:20300101T080000 RRULE:FREQ=WEEKLY;INTERVAL=1", enabled: 1, extra_vars: "", repository: null, owner: null, one_time_run: 0 },
      // a one-time schedule of the app (no owner) : handed over, a one-time run still
      { id: 7, name: "Once", form: "Report", cron: null, rrule: null, run_at: "2030-02-03 04:05:00", enabled: 1, extra_vars: "", repository: null, owner: null, one_time_run: 1, last_run: null },
    );
    nextId = 10;
    writeFile("ops", "clash.yaml", scheduleYaml("Clash"));
  };

  test("the preview counts what it would do, changing nothing : every schedule written, none kept for its timing", async () => {
    appRows();
    const before = JSON.stringify(rows);
    const preview = await ScheduleRepo.preview("ops");
    assert.equal(preview.recurring, 6);
    assert.deepEqual(preview.written, ["Every five", "First or Monday", "Once", "Weekdays", "Weekly"]);
    assert.deepEqual(preview.kept, []);
    assert.deepEqual(preview.clashes, ["Clash"]);
    assert.equal(preview.planned, 1);
    assert.equal(preview.files, 1);
    assert.equal(JSON.stringify(rows), before);
    assert.deepEqual(pulls, []);
  });

  test("a schedule with no valid timing stays in the app, said with its code", async () => {
    appRows();
    rows.push({ id: 8, name: "No time", form: "Report", cron: null, rrule: null, enabled: 1, repository: null, owner: null, one_time_run: 0 });
    const preview = await ScheduleRepo.preview("ops");
    assert.deepEqual(preview.kept.map((k) => [k.name, k.code]), [["No time", "noSchedule"]]);
    assert.equal(preview.kept[0].cron, undefined);
  });

  test("activation : pulled, git wins on a clash, every app schedule handed over with its own timing, unchanged", async () => {
    appRows();
    const report = await ScheduleRepo.activate("ops");
    assert.deepEqual(pulls, ["ops"]);
    assert.equal(report.pull, "pulled");
    assert.deepEqual(report.matched, ["Clash"]);
    assert.deepEqual(report.written, ["Every five", "First or Monday", "Once", "Weekdays", "Weekly"]);
    assert.deepEqual(report.kept, []);
    assert.equal(report.planned, 1);
    // the clash : the file's definition, its history kept
    const clash = rows.find((r) => r.id === 5);
    assert.equal(clash.repo_file, "schedules/clash.yaml");
    assert.equal(clash.last_run, "2026-10-19 04:00:00");
    // each entry with its own timing key, the other two absent
    const text = readFile("ops", "clash.yaml");
    assert.deepEqual(YAML.parse(text).controller_schedules.map((e) => e.name), ["Clash", "Every five", "First or Monday", "Once", "Weekdays", "Weekly"]);
    const timing = (name) => {
      const e = entryOf(text, name);
      return { rrule: e.rrule, cron: e.cron, one_time_run: e.one_time_run };
    };
    assert.deepEqual(timing("Every five"), { rrule: undefined, cron: "*/5 * * * *", one_time_run: undefined });
    assert.deepEqual(timing("First or Monday"), { rrule: undefined, cron: "0 0 1 * 1", one_time_run: undefined });
    assert.deepEqual(timing("Weekly"), { rrule: "DTSTART;TZID=UTC:20300101T080000 RRULE:FREQ=WEEKLY;INTERVAL=1", cron: undefined, one_time_run: undefined });
    assert.deepEqual(timing("Once"), { rrule: undefined, cron: undefined, one_time_run: "2030-02-03T04:05:00Z" });
    assert.deepEqual(entryOf(text, "Every five").extra_data, { a: 1 });
    assert.equal(entryOf(text, "Weekdays").enabled, false);
    // each row linked, its timing as it was
    const row = (id) => rows.find((r) => r.id === id);
    assert.deepEqual([row(1).repository, row(1).cron, row(1).rrule, row(1).one_time_run], ["ops", "*/5 * * * *", null, 0]);
    assert.deepEqual([row(3).repository, row(3).cron], ["ops", "0 0 1 * 1"]);
    assert.deepEqual([row(6).cron, row(6).rrule], [null, "DTSTART;TZID=UTC:20300101T080000 RRULE:FREQ=WEEKLY;INTERVAL=1"]);
    assert.deepEqual([row(7).repository, row(7).one_time_run, row(7).run_at, row(7).cron, row(7).rrule], ["ops", 1, "2030-02-03 04:05:00", null, null]);
    // the planned job stays in the app, never written
    assert.equal(row(4).repository, null);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, "ops", "schedules")).sort(), ["clash.yaml"]);
    // and the next pull finds them all unchanged
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.updated, 0);
    assert.equal(summary.created, 0);
    assert.equal(summary.unchanged, 6);
  });

  test("a pull that fails is said, the working copy used as it is", async () => {
    appRows();
    pullFails = true;
    const report = await ScheduleRepo.activate("ops");
    assert.match(report.pull, /^not pulled: remote unreachable/);
    assert.deepEqual(report.written, ["Every five", "First or Monday", "Once", "Weekdays", "Weekly"]);
  });

  test("no file holding schedules: : written to schedules.yaml at the root, never over a file of that name that is not theirs", async () => {
    rows.push({ id: 1, name: "Every five", form: "Report", cron: "*/5 * * * *", rrule: null, enabled: 1, extra_vars: "", repository: null, owner: null, one_time_run: 0 });
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "ops", "schedules.yaml"), "not: a schedule\n");
    await ScheduleRepo.activate("ops", { pull: false });
    assert.equal(rows.find((r) => r.id === 1).repo_file, "schedules-2.yaml");
    assert.equal(fs.readFileSync(path.join(ROOT, "ops", "schedules.yaml"), "utf8"), "not: a schedule\n");
  });

  test("an entry refused for its rrule declares its name : the app's schedule of that name stays in the app, never a second entry", async () => {
    rows.push({ id: 1, name: "Every five", form: "Report", cron: "*/5 * * * *", rrule: null, enabled: 1, extra_vars: "", repository: null, owner: null, one_time_run: 0 });
    nextId = 10;
    // its DTSTART without a time zone : refused
    writeFile("ops", "every-five.yaml", scheduleYaml("Every five", { rrule: "DTSTART:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1" }));
    const preview = await ScheduleRepo.preview("ops");
    assert.deepEqual(preview.clashes, ["Every five"]);
    assert.deepEqual(preview.written, []);
    const report = await ScheduleRepo.activate("ops", { pull: false });
    assert.deepEqual(report.written, []);
    assert.deepEqual(report.kept.map((k) => k.name), ["Every five"]);
    assert.match(report.kept[0].reason, /^ops\/schedules\/every-five\.yaml#Every five has its name but is not read in/);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, "ops", "schedules")), ["every-five.yaml"]);
    // the file fixed in git : the next pull takes the app's schedule over
    writeFile("ops", "every-five.yaml", scheduleYaml("Every five"));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.deepEqual(summary.matched, ["Every five"]);
    assert.equal(rows.find((r) => r.id === 1).repo_file, "schedules/every-five.yaml");
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
describe("an edit in the app goes to its entry", () => {
  test("a new schedule in a repository : a new entry, its form by name, in schedules.yaml made, and its row", async () => {
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    const id = await ScheduleRepo.create("ops", { name: "Weekly Report", form: "Report", rrule: RRULE, extra_vars: "to: ops\n" });
    const row = rows.find((r) => r.id === id);
    assert.equal(row.repo_file, "schedules.yaml");
    assert.equal(row.repository, "ops");
    const obj = entryOf(fs.readFileSync(path.join(ROOT, "ops", "schedules.yaml"), "utf8"), "Weekly Report");
    assert.equal(obj.name, "Weekly Report");
    assert.equal(obj.form, "Report");
    assert.deepEqual(obj.extra_data, { to: "ops" });
    assert.equal(obj.rrule, RRULE);
    assert.deepEqual(claims, [["claim", "ops"], ["release", "ops"]]);
    // and a pull reads it back unchanged
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.unchanged, 1);
  });

  test("a new schedule of each timing is written and stored with it, as given : a cron stays a cron, a one time run one", async () => {
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    const hourly = await ScheduleRepo.create("ops", { name: "Hourly", form: "Report", cron: "0 * * * *" });
    const odd = await ScheduleRepo.create("ops", { name: "Odd", form: "Report", cron: "0 0 1 * 1", one_time_run: 0 });
    const weekly = await ScheduleRepo.create("ops", { name: "Weekly", form: "Report", rrule: RRULE });
    const once = await ScheduleRepo.create("ops", { name: "Once", form: "Report", one_time_run: 1, run_at: "2030-01-02T03:04:00.000Z" });
    const row = (id) => rows.find((r) => r.id === id);
    assert.deepEqual([row(hourly).cron, row(hourly).rrule, row(hourly).one_time_run, row(hourly).run_at], ["0 * * * *", null, 0, null]);
    assert.equal(row(odd).cron, "0 0 1 * 1");
    assert.deepEqual([row(weekly).cron, row(weekly).rrule], [null, RRULE]);
    assert.deepEqual([row(once).cron, row(once).rrule, row(once).one_time_run, row(once).run_at], [null, null, 1, "2030-01-02 03:04:00"]);
    const text = readFile_("ops", "schedules.yaml");
    assert.equal(entryOf(text, "Hourly").cron, "0 * * * *");
    assert.equal(entryOf(text, "Weekly").rrule, RRULE);
    assert.equal(entryOf(text, "Once").one_time_run, "2030-01-02T03:04:00Z");
    for (const name of ["Hourly", "Odd", "Weekly", "Once"]) {
      const keys = Object.keys(entryOf(text, name)).filter((k) => ["cron", "rrule", "one_time_run", "run_at"].includes(k));
      assert.equal(keys.length, 1, `${name}: one timing key`);
    }
    // a pull reads them back unchanged
    assert.equal((await ScheduleRepo.syncRepository("ops")).unchanged, 4);
    // refused : a cron the app refuses, no timing, a one time run without its moment or one with a rrule
    await assert.rejects(ScheduleRepo.create("ops", { name: "Bad", form: "Report", cron: "99 * * * *" }), /Invalid cron expression/);
    await assert.rejects(ScheduleRepo.create("ops", { name: "None", form: "Report" }), /needs a cron, a rrule or a one time run/);
    await assert.rejects(ScheduleRepo.create("ops", { name: "No time", form: "Report", one_time_run: 1 }), { name: "BadRequestError" });
    await assert.rejects(ScheduleRepo.create("ops", { name: "Both", form: "Report", one_time_run: 1, run_at: "2030-01-02T03:04:00Z", rrule: RRULE }), /either, not both/);
    await assert.rejects(ScheduleRepo.create("ops", { name: "No zone", form: "Report", one_time_run: 1, run_at: "2030-01-02T03:04:00" }), /without a zone/);
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
    assert.equal(fs.existsSync(path.join(ROOT, "ops", "schedules.yaml")), false);
  });

  test("a new schedule named as a refused entry of the repository : refused, nothing written nor made", async () => {
    fs.mkdirSync(path.join(ROOT, "ops"), { recursive: true });
    // an entry whose form does not exist : refused by the pull, no row
    const text = YAML.stringify({ controller_schedules: [{ name: "Weekly Report", form: "Gone form", rrule: RRULE }] });
    fs.writeFileSync(path.join(ROOT, "ops", "schedules.yaml"), text);
    assert.equal((await ScheduleRepo.syncRepository("ops")).refused.length, 1);
    await assert.rejects(ScheduleRepo.create("ops", { name: "weekly report", form: "Report", rrule: RRULE }), (e) => e.name === "ConflictError" && /is named 'weekly report' already/.test(e.message));
    assert.equal(rows.length, 0);
    assert.equal(fs.readFileSync(path.join(ROOT, "ops", "schedules.yaml"), "utf8"), text);
  });

  test("an edit writes the changed fields into its entry, keeping what AnsibleForms does not use", async () => {
    writeFile("ops", "a.yaml", `# owned by ops\n${scheduleYaml("Rotate logs", { forks: 5, limit: "web", custom: { a: 1 } })}`);
    await ScheduleRepo.syncRepository("ops");
    await ScheduleRepo.update(rows[0], { name: "Rotate", enabled: 0, extra_vars: "days: 3", rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=WEEKLY;INTERVAL=1" });
    const text = readFile("ops", "a.yaml");
    assert.ok(text.startsWith("# owned by ops\n"));
    const obj = entryOf(text);
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

  test("a delete removes the entry, the file it empties, and the row", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Rotate logs"));
    await ScheduleRepo.syncRepository("ops");
    await ScheduleRepo.delete(rows[0]);
    assert.equal(fileExists("ops", "a.yaml"), false);
    assert.deepEqual(rows, []);
  });
});

// ─── the timing of an entry : cron, rrule or one_time_run ─────────────────────
describe("an entry is timed by exactly one of cron, rrule and one_time_run, as an app schedule", () => {
  test("each kind read, stored as the app stores it ; none or two refused, said in the pull output", async () => {
    writeFile("ops", "a.yaml", scheduleYaml("Cron one", { rrule: undefined, cron: "30 2 * * 1-5" }));
    writeFile("ops", "b.yaml", scheduleYaml("Rrule one"));
    writeFile("ops", "c.yaml", scheduleYaml("Once", { rrule: undefined, one_time_run: "2030-05-06T07:08:00+02:00" }));
    writeFile("ops", "d.yaml", scheduleYaml("Seconds", { rrule: undefined, cron: "0 30 2 * * *" }));
    writeFile("ops", "e.yaml", scheduleYaml("No timing", { rrule: undefined }));
    writeFile("ops", "f.yaml", scheduleYaml("Two", { cron: "0 1 * * *" }));
    writeFile("ops", "g.yaml", scheduleYaml("Bad cron", { rrule: undefined, cron: "61 * * * *" }));
    writeFile("ops", "h.yaml", scheduleYaml("No zone", { rrule: undefined, one_time_run: "2030-05-06T07:08:00" }));
    const summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 4);
    const row = (name) => rows.find((r) => r.name === name);
    assert.deepEqual([row("Cron one").cron, row("Cron one").rrule, row("Cron one").one_time_run, row("Cron one").run_at], ["30 2 * * 1-5", null, 0, null]);
    assert.equal(row("Seconds").cron, "0 30 2 * * *");
    assert.deepEqual([row("Rrule one").cron, row("Rrule one").rrule, row("Rrule one").one_time_run], [null, RRULE, 0]);
    // its moment in UTC, as the app stores a one time run
    assert.deepEqual([row("Once").cron, row("Once").rrule, row("Once").one_time_run, row("Once").run_at], [null, null, 1, "2030-05-06 05:08:00"]);
    const refused = Object.fromEntries(summary.refused.map((r) => [r.file.split("#")[1], r.reasons.join(" ")]));
    assert.deepEqual(Object.keys(refused).sort(), ["Bad cron", "No timing", "No zone", "Two"]);
    assert.match(refused["No timing"], /one of rrule, cron or one_time_run/);
    assert.match(refused.Two, /give one of rrule, cron or one_time_run, not rrule and cron/);
    assert.match(refused["Bad cron"], /^cron: /);
    assert.match(refused["No zone"], /without a zone is ambiguous/);
    assert.ok(ScheduleRepo.summaryText(summary).includes("Refused schedules/f.yaml#Two"));
    // read again : nothing changes
    assert.equal((await ScheduleRepo.syncRepository("ops")).unchanged, 4);
  });

  test("an edit writes the timing the row has, the other two keys removed ; a change of kind rewrites the entry", async () => {
    writeFile("ops", "a.yaml", `# kept\n${scheduleYaml("Rotate logs", { forks: 5 })}`);
    await ScheduleRepo.syncRepository("ops");
    // to a cron
    await ScheduleRepo.update(rows[0], { cron: "0 3 * * *", rrule: "", one_time_run: 0, run_at: null });
    let e = entryOf(readFile("ops", "a.yaml"));
    assert.deepEqual([e.cron, e.rrule, e.one_time_run, e.forks], ["0 3 * * *", undefined, undefined, 5]);
    assert.deepEqual([rows[0].cron, rows[0].rrule, rows[0].one_time_run], ["0 3 * * *", null, 0]);
    assert.equal((await ScheduleRepo.syncRepository("ops")).unchanged, 1);
    // to a one time run
    await ScheduleRepo.update(rows[0], { one_time_run: 1, run_at: "2030-01-01T10:00:00.000Z", cron: "" });
    e = entryOf(readFile("ops", "a.yaml"));
    assert.deepEqual([e.cron, e.rrule, e.one_time_run], [undefined, undefined, "2030-01-01T10:00:00Z"]);
    assert.deepEqual([rows[0].cron, rows[0].one_time_run, rows[0].run_at], [null, 1, "2030-01-01 10:00:00"]);
    assert.equal((await ScheduleRepo.syncRepository("ops")).unchanged, 1);
    // its moment only
    await ScheduleRepo.update(rows[0], { run_at: "2030-01-01T11:00:00.000Z" });
    assert.equal(entryOf(readFile("ops", "a.yaml")).one_time_run, "2030-01-01T11:00:00Z");
    // back to a rrule
    await ScheduleRepo.update(rows[0], { rrule: RRULE, one_time_run: 0 });
    e = entryOf(readFile("ops", "a.yaml"));
    assert.deepEqual([e.cron, e.rrule, e.one_time_run], [undefined, RRULE, undefined]);
    assert.deepEqual([rows[0].rrule, rows[0].one_time_run, rows[0].run_at], [RRULE, 0, null]);
    assert.ok(readFile("ops", "a.yaml").startsWith("# kept\n"));
    // an edit of another field leaves the timing as it is
    await ScheduleRepo.update(rows[0], { description: "x" });
    assert.equal(entryOf(readFile("ops", "a.yaml")).rrule, RRULE);
    // no longer run once without what else to run on : refused
    await ScheduleRepo.update(rows[0], { one_time_run: 1, run_at: "2030-01-01T10:00:00Z" });
    await assert.rejects(ScheduleRepo.update(rows[0], { one_time_run: 0 }), /needs a cron, a rrule or a one time run/);
  });

  test("a one-time entry whose run is past : not imported once the app ran it, never brought back ; still read while the app waits to run it", async () => {
    const PAST = "2020-01-01T00:00:00Z";
    // the app still waits to run it (its moment passed while the server was down) : read in, kept
    writeFile("ops", "a.yaml", scheduleYaml("Late", { rrule: undefined, one_time_run: "2030-01-01T00:00:00Z" }));
    await ScheduleRepo.syncRepository("ops");
    writeFile("ops", "a.yaml", scheduleYaml("Late", { rrule: undefined, one_time_run: PAST }));
    let summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.updated, 1);
    assert.equal(rows[0].run_at, "2020-01-01 00:00:00");
    // it ran : the app deleted it (Schedule.endOneTime) ; the entry stays in git
    rows.length = 0;
    summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.created, 0);
    assert.deepEqual(rows, []);
    assert.deepEqual(summary.skipped, [{ file: "schedules/a.yaml#Late", name: "Late", reason: "its one_time_run is past (already run)" }]);
    assert.ok(ScheduleRepo.summaryText(summary).includes("Not imported, its one_time_run is past (already run): Late (schedules/a.yaml#Late)"));
    // turned off instead of deleted (its delete failed) : it ran, it goes
    rows.push({ id: 30, name: "Late", form: "Nightly", one_time_run: 1, run_at: "2020-01-01 00:00:00", last_run: "2020-01-01 00:00:05", enabled: 0, repository: "ops", repo_file: "schedules/a.yaml" });
    summary = await ScheduleRepo.syncRepository("ops");
    assert.equal(summary.deleted, 1);
    assert.deepEqual(rows, []);
    // a new moment ahead : read in again
    writeFile("ops", "a.yaml", scheduleYaml("Late", { rrule: undefined, one_time_run: "2031-01-01T00:00:00Z" }));
    assert.equal((await ScheduleRepo.syncRepository("ops")).created, 1);
  });
});
