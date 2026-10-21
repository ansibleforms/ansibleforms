// The launch options of a schedule and the prompts of its file, both ways through one table
// (lib/scheduleFiles.js PROMPTS) : a pull reads limit, job_tags ... as __limit__, __tags__ ..., the
// app writes them back as the same prompts - on turning the Schedules usage on, and on an edit,
// only the prompts that change. A credential map is written by name ; an option no prompt gives
// stays in the app only, and the question asked first says so. A round trip changes nothing.
import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

// the statements run, with their values
const statements = [];
vi.mock("../src/models/db.model.js", () => ({ default: { do: async (sql, vars) => statements.push({ sql, vars }) } }));
vi.mock("../src/lib/logger.js", async () => await import("./__mocks__/logger.js"));

const { default: schedules } = await import("../src/lib/repoObjects/schedules.js");
const { parseScheduleFile, newScheduleFile, updateScheduleFile, promptsOf, PROMPTS } = await import("../src/lib/scheduleFiles.js");

// every launch option a prompt gives
const ALL = {
  __limit__: "webservers",
  __tags__: "deploy,report",
  __skipTags__: "slow",
  __scmBranch__: "release",
  __verbosity__: 3,
  __diff__: true,
  __check__: true,
  __inventory__: "Production",
  __executionEnvironment__: "ee-default",
  __instanceGroups__: ["east", "west"],
  __credentials__: { "vault-prod": "vault-prod", "ssh-ops": "ssh-ops" },
};
const BASE = { name: "Nightly cleanup", description: "", rrule: "DTSTART;TZID=UTC:20261021T023000 RRULE:FREQ=DAILY;INTERVAL=1", enabled: true, form: "Nightly", extraData: {} };

/** The row an UPDATE statement leaves, from the columns it sets. */
function rowAfter(row, { sql, vars }) {
  const out = { ...row };
  let i = 0;
  for (const part of sql.match(/SET (.*) WHERE/)[1].split(",")) {
    const [col, value] = part.trim().split("=");
    if (value === "?") out[col] = vars[i++];
    else out[col] = null;
  }
  return out;
}

describe("one table, both ways", () => {
  test("every prompt written is read back as the same launch option", () => {
    assert.equal(PROMPTS.length, 11);
    const text = newScheduleFile({ ...BASE, launchOptions: ALL });
    const file = YAML.parse(text);
    assert.equal(file.limit, "webservers");
    assert.equal(file.job_type, "check");
    assert.deepEqual(file.credentials, ["vault-prod", "ssh-ops"]);
    assert.deepEqual(parseScheduleFile(text).schedule.launchOptions, ALL);
  });

  test("an option no prompt gives stays in the app only : a credential map under other names, an unknown one", () => {
    const { fields, kept } = promptsOf(JSON.stringify({ __limit__: "db", __credentials__: { vault: "vault-prod" }, __custom__: 1 }));
    assert.deepEqual(fields, { limit: "db" });
    assert.deepEqual(kept, { __credentials__: { vault: "vault-prod" }, __custom__: 1 });
  });
});

describe("turning the Schedules usage on", () => {
  test("the options written as prompts, the rest kept in the app ; the next pull finds it unchanged", async () => {
    const options = { ...ALL, __custom__: "x" };
    const row = { id: 3, name: "Nightly cleanup", description: "", form: "Nightly", cron: "30 2 * * *", rrule: null, enabled: 1, extra_vars: "", launch_options: JSON.stringify(options) };
    const c = schedules.candidateOf(row);
    assert.deepEqual(schedules.appOnlyOptions([c]), ["Nightly cleanup (__custom__)"]);
    const text = schedules.newFileText(c);
    assert.equal(YAML.parse(text).limit, "webservers");
    statements.length = 0;
    await schedules.linkCandidate(c, "ops", "schedules/nightly-cleanup.yaml");
    const stored = rowAfter(row, statements[0]);
    assert.deepEqual(JSON.parse(stored.launch_options), options);
    // the pull : the file read, the row compared and left as it is
    assert.equal(schedules.store.changed(stored, parseScheduleFile(text).schedule), false);
  });
});

describe("an app edit of the launch options", () => {
  test("only the prompts that change rewritten, one no longer given removed, the rest byte for byte", () => {
    const text = "name: Nightly        # ours\nlimit: webservers    # the web tier\njob_tags: deploy\nverbosity: 1\nteam_owner: platform # our key\nunified_job_template: Nightly\nrrule: DTSTART;TZID=UTC:20261021T023000 RRULE:FREQ=DAILY;INTERVAL=1\n";
    const out = updateScheduleFile(text, { launchOptions: { __limit__: "dbservers", __verbosity__: 1 } });
    assert.equal(out, text.replace("limit: webservers    # the web tier", "limit: dbservers    # the web tier").replace("job_tags: deploy\n", ""));
    // the same options : nothing rewritten
    assert.equal(updateScheduleFile(text, { launchOptions: { __limit__: "webservers", __tags__: "deploy", __verbosity__: 1 } }), text);
  });
});
