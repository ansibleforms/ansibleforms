// Server log files are kept 90 days by default (LOG_RETENTION_DAYS, log.config) : unset or not a
// number, 60 ; 0 keeps every file ; the help the Settings page shows, and falls back to on a
// cleared field, says the same.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import { parseRetentionDays } from "../config/log.config.js";

describe("log file retention", () => {
  test("90 days when unset or not a whole number, 0 kept, any other value as given", () => {
    assert.equal(parseRetentionDays(undefined), 90);
    assert.equal(parseRetentionDays(""), 90);
    assert.equal(parseRetentionDays("abc"), 90);
    assert.equal(parseRetentionDays("-3"), 90);
    assert.equal(parseRetentionDays("0"), 0);
    assert.equal(parseRetentionDays("14"), 14);
  });

  test("the help's default, what a cleared Settings field falls back to, is 90", () => {
    const help = YAML.parse(fs.readFileSync(new URL("../help.yaml", import.meta.url), "utf8"));
    const entry = JSON.parse(JSON.stringify(help).match(/\{"name":"LOG_RETENTION_DAYS"[^{}]*\}/)[0]);
    assert.equal(entry.default, "90");
  });
});
