// A schedule of a schedules repository (lib/scheduleFiles.js) : an entry of a schedules: list in any
// YAML file of the repository, in the export form (foreign keys as natural keys, credentials under
// related, its own natural_key) or the module form (names instead of natural keys). Read into what
// AnsibleForms runs, refused where it is not a valid schedule, and written back with everything its
// entry and its file say kept.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";
import { parseSchedule, updateScheduleText, newScheduleEntry, scheduleEntryOf, launchOptionsOf } from "../src/lib/scheduleFiles.js";
import { appendListEntries } from "../src/lib/repoObjects/yamlFile.js";

// one schedule in the export form : its template, inventory and execution environment as natural
// keys, its credentials under related, and its own natural key
const EXPORTED = `name: Nightly log rotation
description: ''
extra_data:
  retention_days: 14
inventory:
  name: production
  organization:
    name: Default
    type: organization
  type: inventory
scm_branch: null
job_type: null
job_tags: rotate
skip_tags: null
limit: webservers
diff_mode: null
verbosity: 2
execution_environment:
  name: Default execution environment
  type: execution_environment
forks: null
job_slice_count: null
timeout: null
unified_job_template:
  name: Nightly Workflow
  organization:
    name: Default
    type: organization
  type: workflow_job_template
enabled: true
rrule: DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1
related:
  credentials:
    - name: Machine
      organization: null
      credential_type:
        name: Machine
        kind: ssh
        type: credential_type
      type: credential
natural_key:
  name: Nightly log rotation
  type: schedule
  unified_job_template:
    name: Nightly Workflow
    organization:
      name: Default
      type: organization
    type: workflow_job_template
`;

// one schedule in the module form, with every prompt
const MODULE = `name: sched2
state: present
organization: Default
unified_job_template: Demo Job Template
rrule: "DTSTART:20191219T130551Z RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=1"
description: "This hopefully will work"
extra_data:
  some: var
inventory: slice_inventory
scm_branch: asdf1234
credentials:
  - cred1
job_type: run
job_tags: other_tags
skip_tags: some_tags
limit: node1
diff_mode: true
verbosity: 4
enabled: true
execution_environment: ee1
forks: 10
instance_groups:
  - ig1
  - ig2
job_slice_count: 2
labels:
  - label1
  - label2
timeout: 10
`;

// a schedule's text as the only entry of a file's schedules: list, and a schedule of a text
const asFile = (text) => `controller_schedules:\n${text.trimEnd().split("\n").map((l, i) => (i === 0 ? `  - ${l}` : l ? `    ${l}` : l)).join("\n")}\n`;
const parse = (text) => parseSchedule(YAML.parse(text));
const entryIn = (text, i = 0) => YAML.parse(text).controller_schedules[i];

describe("reading a schedule file", () => {
  test("the export's object : its template's name is the form, its prompts are the job's reserved extra vars", () => {
    const { errors, schedule } = parse(EXPORTED);
    assert.deepEqual(errors, []);
    assert.equal(schedule.name, "Nightly log rotation");
    assert.equal(schedule.form, "Nightly Workflow");
    assert.equal(schedule.rrule, "DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1");
    assert.equal(schedule.enabled, true);
    assert.deepEqual(schedule.extraData, { retention_days: 14 });
    assert.deepEqual(schedule.launchOptions, {
      __limit__: "webservers",
      __tags__: "rotate",
      __verbosity__: 2,
      __inventory__: "production",
      __executionEnvironment__: "Default execution environment",
      __credentials__: { Machine: "Machine" },
    });
    assert.deepEqual(schedule.ignored, []);
  });

  test("the module's options : names instead of natural keys, every prompt mapped or kept", () => {
    const { errors, schedule } = parse(MODULE);
    assert.deepEqual(errors, []);
    assert.equal(schedule.form, "Demo Job Template");
    assert.deepEqual(schedule.launchOptions, {
      __limit__: "node1",
      __tags__: "other_tags",
      __skipTags__: "some_tags",
      __scmBranch__: "asdf1234",
      __verbosity__: 4,
      __diff__: true,
      __check__: false,
      __inventory__: "slice_inventory",
      __executionEnvironment__: "ee1",
      __instanceGroups__: ["ig1", "ig2"],
      __credentials__: { cred1: "cred1" },
    });
    // AnsibleForms has nothing to give these to : kept in the file, said
    assert.deepEqual(schedule.ignored.sort(), ["forks", "job_slice_count", "labels", "timeout"]);
  });

  test("several schedules in one file, beside other keys : each read from its entry", () => {
    const text = `${asFile(EXPORTED)}${asFile(MODULE).replace("controller_schedules:\n", "")}credentials:\n  - name: other\n`;
    assert.equal(YAML.parse(text).controller_schedules.length, 2);
    assert.equal(parseSchedule(entryIn(text, 0)).schedule.form, "Nightly Workflow");
    assert.equal(parseSchedule(entryIn(text, 1)).schedule.form, "Demo Job Template");
    assert.equal(scheduleEntryOf(text, "SCHED2").name, "sched2", "found by its name, case aside");
  });

  test("job_type check is a check run", () => {
    assert.deepEqual(launchOptionsOf({ job_type: "check" }).options, { __check__: true });
  });

  test("state: absent holds no schedule", () => {
    const parsed = parseSchedule({ name: "gone", state: "absent" });
    assert.equal(parsed.absent, true);
    assert.equal(parsed.schedule, null);
  });
});

describe("an entry that is not a valid schedule is refused, saying why", () => {
  const base = { name: "x", rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1", unified_job_template: { name: "Form" } };
  const refused = (obj, reason) => {
    const parsed = parseSchedule(obj);
    assert.equal(parsed.schedule, null, "refused");
    assert.ok(parsed.errors.some((e) => e.includes(reason)), `${parsed.errors.join(" | ")} says ${reason}`);
  };
  test("no name", () => refused({ ...base, name: "" }, "name is required"));
  test("a name longer than the schedule table keeps", () => refused({ ...base, name: "n".repeat(256) }, "longer than 255"));
  test("no timing", () => refused({ ...base, rrule: undefined }, "one of rrule, cron or one_time_run"));
  test("two timings", () => refused({ ...base, cron: "0 1 * * *" }, "give one of rrule, cron or one_time_run, not rrule and cron"));
  test("three timings", () => refused({ ...base, cron: "0 1 * * *", one_time_run: "2030-01-01T00:00:00Z" }, "not rrule and cron and one_time_run"));
  test("a cron the app refuses", () => refused({ ...base, rrule: undefined, cron: "0 0 30 2 *" }, "cron: "));
  test("a cron that is no text", () => refused({ ...base, rrule: undefined, cron: 5 }, "cron must be text"));
  test("a one_time_run without its zone", () => refused({ ...base, rrule: undefined, one_time_run: "2030-01-01T00:00:00" }, "without a zone"));
  test("a one_time_run on a day there is not", () => refused({ ...base, rrule: undefined, one_time_run: "2030-02-30T00:00:00Z" }, "is not a valid time"));
  test("a refused rrule", () => refused({ ...base, rrule: "DTSTART:20300101T000000Z RRULE:FREQ=SECONDLY;INTERVAL=1" }, "SECONDLY is not supported"));
  test("a naive DTSTART", () => refused({ ...base, rrule: "DTSTART:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1" }, "naive"));
  test("no unified_job_template name", () => refused({ ...base, unified_job_template: { type: "job_template" } }, "unified_job_template.name"));
  test("extra_data that are no dictionary", () => refused({ ...base, extra_data: [1, 2] }, "extra_data is not a dictionary"));
  test("a verbosity that does not exist", () => refused({ ...base, verbosity: 7 }, "verbosity must be one of"));
  test("a job type that does not exist", () => refused({ ...base, job_type: "scan" }, "job_type must be one of"));
  test("negative forks", () => refused({ ...base, forks: -1 }, "forks must be"));
  test("credentials that are no list", () => refused({ ...base, credentials: "one" }, "credentials must be a list"));
  test("enabled that is no yes or no", () => refused({ ...base, enabled: "sometimes" }, "enabled must be true or false"));
  test("not a dictionary", () => refused(["a", "b"], "a schedule must be a dictionary"));
});

describe("writing a schedule entry", () => {
  test("nothing changed : the file stays byte for byte", () => {
    const { schedule } = parse(EXPORTED);
    const file = asFile(EXPORTED);
    const text = updateScheduleText(file, schedule.name, {
      name: schedule.name,
      description: schedule.description,
      rrule: schedule.rrule,
      enabled: schedule.enabled,
      form: schedule.form,
      extraData: schedule.extraData,
    });
    assert.equal(text, file);
  });

  test("a rrule written on several lines stays so while it does not change", () => {
    const source = asFile(`name: Nightly
unified_job_template: Nightly Workflow
rrule: |
  DTSTART;TZID=Europe/Brussels:20261020T020000
  RRULE:FREQ=DAILY;INTERVAL=1
`);
    // the app sends it back on one line, as it keeps it, with the field it changed
    const { schedule } = parseSchedule(entryIn(source));
    const text = updateScheduleText(source, "Nightly", { name: "Nightly rotation", rrule: schedule.rrule });
    assert.equal(text, source.replace("  - name: Nightly\n", "  - name: Nightly rotation\n"));
    // changed, it is written
    const changed = updateScheduleText(source, "Nightly", { rrule: "DTSTART;TZID=Europe/Brussels:20261020T030000 RRULE:FREQ=DAILY;INTERVAL=1" });
    assert.equal(entryIn(changed).rrule, "DTSTART;TZID=Europe/Brussels:20261020T030000 RRULE:FREQ=DAILY;INTERVAL=1");
  });

  test("an edit changes those keys only : prompts, unknown keys, comments, the order and the other entries are kept", () => {
    const other = "  - name: Other\n    unified_job_template: Report\n    rrule: DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1\n";
    const source = `# kept by the platform team
${asFile(`name: Nightly
custom_note: keep me # an AnsibleForms-unknown key
unified_job_template: Nightly Workflow
forks: 5
rrule: DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1
`)}${other}`;
    const text = updateScheduleText(source, "Nightly", {
      name: "Nightly rotation",
      rrule: "DTSTART;TZID=Europe/Brussels:20261020T030000 RRULE:FREQ=DAILY;INTERVAL=1",
      enabled: false,
      description: "Rotates the logs",
      extraData: { retention_days: 7 },
      form: "Other Form",
    });
    assert.ok(text.startsWith("# kept by the platform team\n"));
    assert.ok(text.includes("custom_note: keep me # an AnsibleForms-unknown key"));
    assert.ok(text.includes("forks: 5"));
    assert.ok(text.endsWith(other), "the other entry byte for byte");
    const obj = entryIn(text);
    assert.equal(obj.name, "Nightly rotation");
    // the module's shape is kept : the template stays a name
    assert.equal(obj.unified_job_template, "Other Form");
    assert.equal(obj.enabled, false);
    // the new keys at their place in the export's order, after the last key that comes before them :
    // description and extra_data after name, enabled after the template's prompts
    assert.deepEqual(Object.keys(obj), ["name", "description", "extra_data", "custom_note", "unified_job_template", "forks", "enabled", "rrule"]);
  });

  test("the export's natural keys follow the name and the form", () => {
    const text = updateScheduleText(asFile(EXPORTED), "Nightly log rotation", { name: "Renamed", form: "Another Form" });
    const obj = entryIn(text);
    assert.equal(obj.unified_job_template.name, "Another Form");
    assert.equal(obj.unified_job_template.type, "workflow_job_template");
    assert.equal(obj.natural_key.name, "Renamed");
    assert.equal(obj.natural_key.unified_job_template.name, "Another Form");
    // everything else untouched
    assert.deepEqual(obj.related, YAML.parse(EXPORTED).related);
    assert.equal(obj.limit, "webservers");
  });

  test("an entry no file holds : added whole when given, the file left as it is otherwise", () => {
    const file = asFile(EXPORTED);
    assert.equal(updateScheduleText(file, "Missing", { enabled: false }), file);
    const added = updateScheduleText(file, "Missing", {}, newScheduleEntry({ name: "Missing", rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1", form: "Report" }));
    assert.deepEqual(YAML.parse(added).controller_schedules.map((e) => e.name), ["Nightly log rotation", "Missing"]);
  });

  test("a new entry : the export's form, nothing of AnsibleForms' own, read back the same (round trip)", () => {
    const values = {
      name: "Weekly report",
      description: "",
      rrule: "DTSTART;TZID=Europe/Brussels:20261020T060000  RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
      enabled: true,
      form: "Report",
      extraData: { to: "ops@example.com" },
    };
    const text = appendListEntries("", "controller_schedules", [newScheduleEntry(values)]);
    const obj = entryIn(text);
    assert.deepEqual(Object.keys(obj), ["name", "description", "extra_data", "unified_job_template", "enabled", "rrule", "natural_key"]);
    assert.deepEqual(obj.unified_job_template, { name: "Report", type: "job_template" });
    assert.deepEqual(obj.natural_key, { name: "Weekly report", type: "schedule", unified_job_template: { name: "Report", type: "job_template" } });
    assert.ok(!/\b(user|cron|owner|repository)\b:/.test(text), "no AnsibleForms field");
    // the rrule on one line
    assert.ok(text.includes("rrule: DTSTART;TZID=Europe/Brussels:20261020T060000 RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO\n"));
    const back = parseSchedule(entryIn(text)).schedule;
    assert.equal(back.name, values.name);
    assert.equal(back.form, values.form);
    assert.deepEqual(back.extraData, values.extraData);
    // and saved again unchanged, byte for byte
    assert.equal(updateScheduleText(text, back.name, { name: back.name, form: back.form, rrule: back.rrule, enabled: true, extraData: back.extraData }), text);
  });
});
