// The object files written back by the app (lib/repoObjects/yamlFile.js) : every line an edit does
// not change kept byte for byte - its inline comment as far from its value as it was, its trailing
// spaces - and a changed line keeping its comment's spacing. The YAML writer alone re-spaced every
// inline comment of the file.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { updateMapFile, updateListEntry, keepUntouchedLines, parseMapFile, parseListFile, appendListEntries, removeListEntry } from "../src/lib/repoObjects/yamlFile.js";
import { updateScheduleFile } from "../src/lib/scheduleFiles.js";

const ALIGNED = [
  "# the runner of the edge site",
  "name: rte-edge          # its name in the app",
  "type: rte               # always rte",
  "rte_mode: outbound      # it dials the app",
  "rte_max_jobs: 4         # keep it low",
  "enabled: true           # on",
  "",
].join("\n");

describe("a map file full of aligned inline comments, one value changed", () => {
  test("every other line byte for byte, the changed one keeping its comment's place", () => {
    const out = updateMapFile(ALIGNED, { rte_max_jobs: 6 });
    assert.equal(out, ALIGNED.replace("rte_max_jobs: 4         # keep it low", "rte_max_jobs: 6         # keep it low"));
  });

  test("a value of another length : the comment as many spaces after it as before", () => {
    const out = updateMapFile(ALIGNED, { rte_max_jobs: 1200 });
    assert.match(out, /^rte_max_jobs: 1200 {9}# keep it low$/m);
    assert.match(out, /^type: rte {15}# always rte$/m);
  });

  test("trailing spaces of an untouched line kept ; a new key added, the rest as it was", () => {
    const text = "name: a   # n\noptions:\n  x: true      \n";
    const out = updateMapFile(text, { description: "d" }, ["name", "description", "options"]);
    assert.equal(out, "name: a   # n\ndescription: d\noptions:\n  x: true      \n");
  });
});

describe("the other writers keep untouched lines too", () => {
  test("an entry of a list file", () => {
    const text = "repositories:\n  - name: a      # first\n    branch: main # its branch\n  - name: b      # second\n    branch: dev  # its branch\n";
    const out = updateListEntry(text, "repositories", "b", { branch: "prod" });
    assert.equal(out, text.replace("branch: dev  # its branch", "branch: prod  # its branch"));
  });

  test("a schedule file", () => {
    const text = "name: Nightly          # the schedule\ndescription: old       # what it does\nrrule: DTSTART;TZID=UTC:20261021T023000 RRULE:FREQ=DAILY;INTERVAL=1\nteam_owner: platform   # our own key\nunified_job_template: Nightly\n";
    const out = updateScheduleFile(text, { description: "new" });
    assert.equal(out, text.replace("description: old       # what it does", "description: new       # what it does"));
  });

  test("lines the writer did not change are the file's ; lines it changed are its own", () => {
    assert.equal(keepUntouchedLines("a: 1    # x\nb: 2\n", "a: 1 # x\nb: 3\n"), "a: 1    # x\nb: 3\n");
  });
});

describe("the file's own form kept, whatever it is", () => {
  test("a CRLF file stays CRLF, the changed line too", () => {
    const out = updateMapFile("# head\r\nname: a\r\nuser: bob # who\r\nurl: x\r\n", { user: "alice" });
    assert.equal(out, "# head\r\nname: a\r\nuser: alice # who\r\nurl: x\r\n");
  });

  test("its byte order mark kept", () => {
    assert.equal(updateMapFile("﻿# head\nname: a\nuser: bob\n", { user: "alice" }), "﻿# head\nname: a\nuser: alice\n");
  });

  test("a value changed only in its spaces before a # is a changed line", () => {
    const out = updateMapFile('name: a\ndescription: "see  #3"\n', { description: "see #3" });
    assert.equal(parseMapFile(out).object.description, "see #3");
  });

  test("an aligned comment after a quoted value with a # in it is still kept as it was", () => {
    const text = 'name: a\nurl: "http://x/#top"     # the page\nuser: b\n';
    assert.equal(updateMapFile(text, { user: "c" }), text.replace("user: b", "user: c"));
  });
});

describe("a list file", () => {
  test("an entry removed takes the comment right above it with it ; one apart from it stays", () => {
    const text = "# top\nrepositories:\n  # about a\n  - name: a\n    uri: x\n  # about b\n  - name: b\n    uri: y\n";
    assert.equal(removeListEntry(text, "repositories", "a"), "# top\nrepositories:\n  # about b\n  - name: b\n    uri: y\n");
    assert.equal(removeListEntry(text, "repositories", "b"), "# top\nrepositories:\n  # about a\n  - name: a\n    uri: x\n");
  });

  test("its key with nothing after it is an empty list, read and added to", () => {
    assert.deepEqual(parseListFile("repositories:\n", "repositories"), { errors: [], items: [] });
    assert.deepEqual(parseListFile(appendListEntries("repositories:\n", "repositories", [{ name: "a" }]), "repositories").items, [{ name: "a" }]);
  });
});

describe("a large file", () => {
  test("its lines compared in memory linear in its length", () => {
    let text = "repositories:\n";
    for (let i = 0; i < 6000; i++) text += `  - name: r${i}\n    branch: main\n`;
    const rendered = text.replace("  - name: r5\n    branch: main\n", "  - name: r5\n    branch: dev\n");
    const before = process.memoryUsage().rss;
    assert.equal(keepUntouchedLines(text, rendered), rendered);
    // a table of every pair of lines : 12,000 x 12,000 numbers, 576 MB
    assert.ok(process.memoryUsage().rss - before < 100 * 1024 * 1024);
    assert.equal(updateListEntry(text, "repositories", "r5", { branch: "dev" }, ["name", "branch"]), rendered);
  });
});
