// A schedule file of a schedules repository (lib/scheduleFiles.js) : one schedule in YAML, in the
// export form (foreign keys as natural keys, credentials under related, its own natural_key), the
// module form (names instead of natural keys) or a controller_schedules list of one. Read into what
// AnsibleForms runs, refused where it is not a valid schedule, and written back with everything the
// file says kept.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";
import { parseScheduleFile, updateScheduleFile, newScheduleFile, fileNameFor, launchOptionsOf } from "../src/lib/scheduleFiles.js";

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

// a controller_schedules list of one item
const CONTROLLER = `---
controller_schedules:
  - name: ExampleOrg CasC_Objects_Cleanup
    description: CasC_Ojbects_Cleanup
    unified_job_template: ExampleOrg CasC_JobTemplates_AAP_Desired_State
    rrule: DTSTART;TZID=Europe/Madrid:20220127T163000 RRULE:INTERVAL=1;FREQ=DAILY
    job_tags: desired_state
    enabled: false
    extra_data:
      ansible_python_interpreter: /usr/bin/python3
      env: dev
    organization: ExampleOrg
...
`;

describe("reading a schedule file", () => {
  test("the export's object : its template's name is the form, its prompts are the job's reserved extra vars", () => {
    const { errors, schedule } = parseScheduleFile(EXPORTED);
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
    const { errors, schedule } = parseScheduleFile(MODULE);
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

  test("a controller_schedules list of one, and an export's schedules list of one", () => {
    const one = parseScheduleFile(CONTROLLER);
    assert.deepEqual(one.errors, []);
    assert.equal(one.schedule.name, "ExampleOrg CasC_Objects_Cleanup");
    assert.equal(one.schedule.enabled, false);
    // an export writes { schedules: [...] } around them
    const exported = parseScheduleFile(YAML.stringify({ schedules: [YAML.parse(EXPORTED)] }));
    assert.deepEqual(exported.errors, []);
    assert.equal(exported.schedule.form, "Nightly Workflow");
  });

  test("job_type check is a check run", () => {
    assert.deepEqual(launchOptionsOf({ job_type: "check" }).options, { __check__: true });
  });

  test("state: absent holds no schedule", () => {
    const parsed = parseScheduleFile("name: gone\nstate: absent\n");
    assert.equal(parsed.absent, true);
    assert.equal(parsed.schedule, null);
  });
});

describe("a file that is not a valid schedule is refused, saying why", () => {
  const base = { name: "x", rrule: "DTSTART;TZID=UTC:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1", unified_job_template: { name: "Form" } };
  const refused = (obj, reason) => {
    const parsed = parseScheduleFile(typeof obj === "string" ? obj : YAML.stringify(obj));
    assert.equal(parsed.schedule, null, "refused");
    assert.ok(parsed.errors.some((e) => e.includes(reason)), `${parsed.errors.join(" | ")} says ${reason}`);
  };
  test("no name", () => refused({ ...base, name: "" }, "name is required"));
  test("a name longer than the schedule table keeps", () => refused({ ...base, name: "n".repeat(256) }, "longer than 255"));
  test("no rrule", () => refused({ ...base, rrule: undefined }, "rrule is required"));
  test("a refused rrule", () => refused({ ...base, rrule: "DTSTART:20300101T000000Z RRULE:FREQ=SECONDLY;INTERVAL=1" }, "SECONDLY is not supported"));
  test("a naive DTSTART", () => refused({ ...base, rrule: "DTSTART:20300101T000000 RRULE:FREQ=DAILY;INTERVAL=1" }, "naive"));
  test("no unified_job_template name", () => refused({ ...base, unified_job_template: { type: "job_template" } }, "unified_job_template.name"));
  test("extra_data that are no dictionary", () => refused({ ...base, extra_data: [1, 2] }, "extra_data is not a dictionary"));
  test("a verbosity that does not exist", () => refused({ ...base, verbosity: 7 }, "verbosity must be one of"));
  test("a job type that does not exist", () => refused({ ...base, job_type: "scan" }, "job_type must be one of"));
  test("negative forks", () => refused({ ...base, forks: -1 }, "forks must be"));
  test("credentials that are no list", () => refused({ ...base, credentials: "one" }, "credentials must be a list"));
  test("enabled that is no yes or no", () => refused({ ...base, enabled: "sometimes" }, "enabled must be true or false"));
  test("more than one schedule in a file", () => refused({ controller_schedules: [base, { ...base, name: "y" }] }, "one schedule per file"));
  test("not YAML", () => refused("name: [unclosed", "not valid YAML"));
  test("not a dictionary", () => refused("- a\n- b\n", "not a schedule"));
});

describe("writing a schedule file", () => {
  test("nothing changed : the file stays byte for byte", () => {
    const { schedule } = parseScheduleFile(EXPORTED);
    const text = updateScheduleFile(EXPORTED, {
      name: schedule.name,
      description: schedule.description,
      rrule: schedule.rrule,
      enabled: schedule.enabled,
      form: schedule.form,
      extraData: schedule.extraData,
    });
    assert.equal(text, EXPORTED);
  });

  test("a rrule written on several lines stays so while it does not change", () => {
    const source = `name: Nightly
unified_job_template: Nightly Workflow
rrule: |
  DTSTART;TZID=Europe/Brussels:20261020T020000
  RRULE:FREQ=DAILY;INTERVAL=1
`;
    // the app sends it back on one line, as it keeps it, with the field it changed
    const { schedule } = parseScheduleFile(source);
    const text = updateScheduleFile(source, { name: "Nightly rotation", rrule: schedule.rrule });
    assert.equal(text, source.replace("name: Nightly\n", "name: Nightly rotation\n"));
    // changed, it is written
    const changed = updateScheduleFile(source, { rrule: "DTSTART;TZID=Europe/Brussels:20261020T030000 RRULE:FREQ=DAILY;INTERVAL=1" });
    assert.equal(YAML.parse(changed).rrule, "DTSTART;TZID=Europe/Brussels:20261020T030000 RRULE:FREQ=DAILY;INTERVAL=1");
  });

  test("an edit changes those keys only : prompts, unknown keys, comments and the order are kept", () => {
    const source = `# kept by the platform team
name: Nightly
custom_note: keep me # an AnsibleForms-unknown key
unified_job_template: Nightly Workflow
forks: 5
rrule: DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1
`;
    const text = updateScheduleFile(source, {
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
    const obj = YAML.parse(text);
    assert.equal(obj.name, "Nightly rotation");
    // the module's shape is kept : the template stays a name
    assert.equal(obj.unified_job_template, "Other Form");
    assert.equal(obj.enabled, false);
    // the new keys at their place in the export's order, after the last key that comes before them :
    // description and extra_data after name, enabled after the template's prompts
    assert.deepEqual(Object.keys(obj), ["name", "description", "extra_data", "custom_note", "unified_job_template", "forks", "enabled", "rrule"]);
  });

  test("the export's natural keys follow the name and the form", () => {
    const text = updateScheduleFile(EXPORTED, { name: "Renamed", form: "Another Form" });
    const obj = YAML.parse(text);
    assert.equal(obj.unified_job_template.name, "Another Form");
    assert.equal(obj.unified_job_template.type, "workflow_job_template");
    assert.equal(obj.natural_key.name, "Renamed");
    assert.equal(obj.natural_key.unified_job_template.name, "Another Form");
    // everything else untouched
    assert.deepEqual(obj.related, YAML.parse(EXPORTED).related);
    assert.equal(obj.limit, "webservers");
  });

  test("a schedule in a controller_schedules list stays in it", () => {
    const text = updateScheduleFile(CONTROLLER, { enabled: true });
    const obj = YAML.parse(text);
    assert.equal(obj.controller_schedules.length, 1);
    assert.equal(obj.controller_schedules[0].enabled, true);
    assert.equal(obj.controller_schedules[0].organization, "ExampleOrg");
  });

  test("a new file : the export's form, nothing of AnsibleForms' own, read back the same (round trip)", () => {
    const values = {
      name: "Weekly report",
      description: "",
      rrule: "DTSTART;TZID=Europe/Brussels:20261020T060000  RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
      enabled: true,
      form: "Report",
      extraData: { to: "ops@example.com" },
    };
    const text = newScheduleFile(values);
    const obj = YAML.parse(text);
    assert.deepEqual(Object.keys(obj), ["name", "description", "extra_data", "unified_job_template", "enabled", "rrule", "natural_key"]);
    assert.deepEqual(obj.unified_job_template, { name: "Report", type: "job_template" });
    assert.deepEqual(obj.natural_key, { name: "Weekly report", type: "schedule", unified_job_template: { name: "Report", type: "job_template" } });
    assert.ok(!/\b(user|cron|owner|repository)\b:/.test(text), "no AnsibleForms field");
    // the rrule on one line
    assert.ok(text.includes("rrule: DTSTART;TZID=Europe/Brussels:20261020T060000 RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO\n"));
    const back = parseScheduleFile(text).schedule;
    assert.equal(back.name, values.name);
    assert.equal(back.form, values.form);
    assert.deepEqual(back.extraData, values.extraData);
    // and saved again unchanged, byte for byte
    assert.equal(updateScheduleFile(text, { name: back.name, form: back.form, rrule: back.rrule, enabled: true, extraData: back.extraData }), text);
  });
});

describe("a new schedule's file name", () => {
  test("its name in lower case, dashes between the words", () => {
    assert.equal(fileNameFor("Nightly Log Rotation!"), "nightly-log-rotation.yaml");
    assert.equal(fileNameFor("Café équipe"), "cafe-equipe.yaml");
    assert.equal(fileNameFor("***"), "schedule.yaml");
  });
  test("a number added when the name is taken", () => {
    const taken = new Set(["nightly.yaml", "nightly-2.yaml"]);
    assert.equal(fileNameFor("Nightly", (f) => taken.has(f)), "nightly-3.yaml");
  });
});
