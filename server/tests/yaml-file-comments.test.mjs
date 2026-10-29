// The object files written back by the app (lib/repoObjects/yamlFile.js) : every line an edit does
// not change kept byte for byte - its inline comment as far from its value as it was, its trailing
// spaces, the file's other keys and entries - and a changed line keeping its comment's spacing. The
// YAML writer alone re-spaced every inline comment of the file.
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";
import { updateMapFile, editListEntry, editMapEntry, applyEdits, keepUntouchedLines, parseMapFile, appendListEntries, removeListEntry } from "../src/lib/repoObjects/yamlFile.js";
import { updateScheduleText } from "../src/lib/scheduleFiles.js";

// an entry of a type's list edited field by field, as the engine writes an app edit
const updateListEntry = (text, key, name, edits, keyOrder = []) => editListEntry(text, key, name, (doc, map) => applyEdits(doc, map, edits, keyOrder));

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

  test("a schedule entry", () => {
    const text = "controller_schedules:\n  - name: Nightly          # the schedule\n    description: old       # what it does\n    rrule: DTSTART;TZID=UTC:20261021T023000 RRULE:FREQ=DAILY;INTERVAL=1\n    team_owner: platform   # our own key\n    unified_job_template: Nightly\n";
    const out = updateScheduleText(text, "Nightly", { description: "new" });
    assert.equal(out, text.replace("description: old       # what it does", "description: new       # what it does"));
  });

  test("a type's map among other keys : only its changed field, the other keys as they were", () => {
    const text = "# the platform's settings\n# shown beside the logo\nlabels:\n  - name: PROD\ndefaults:\n  # the house style\n  default_theme: dark     # always\n  forms_view: grid\nnotes: kept\n";
    const out = editMapEntry(text, "defaults", (doc, map) => applyEdits(doc, map, { forms_view: "list" }));
    assert.equal(out, text.replace("forms_view: grid", "forms_view: list"));
    // a key the file does not give yet : made at its end
    const made = editMapEntry("labels: []\n", "name", (doc, map) => applyEdits(doc, map, { app_name: "X" }));
    assert.deepEqual(YAML.parse(made), { labels: [], name: { app_name: "X" } });
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

  test("an empty map ({}) written into : its keys one below the other, never on one line", () => {
    assert.equal(updateMapFile("{}\n", { app_name: "X", theme: "dark" }), "app_name: X\ntheme: dark\n");
    assert.equal(updateMapFile("# the name\n{}\n", { app_name: "X" }), "# the name\napp_name: X\n");
  });
});

describe("a type's list in a file", () => {
  test("an entry removed takes the comment right above it with it ; one apart from it stays", () => {
    const text = "# top\nrepositories:\n  # about a\n  - name: a\n    uri: x\n  # about b\n  - name: b\n    uri: y\n";
    assert.deepEqual(removeListEntry(text, "repositories", "a"), { text: "# top\nrepositories:\n  # about b\n  - name: b\n    uri: y\n", empty: false });
    assert.deepEqual(removeListEntry(text, "repositories", "b"), { text: "# top\nrepositories:\n  # about a\n  - name: a\n    uri: x\n", empty: false });
  });

  test("its last entry removed : its key goes, and the file when it holds nothing more", () => {
    assert.deepEqual(removeListEntry("labels:\n  - name: a\ncredentials:\n  - name: c\n", "credentials", "c"), { text: "labels:\n  - name: a\n", empty: false });
    assert.deepEqual(removeListEntry("credentials:\n  - name: c\n", "credentials", "C"), { text: "", empty: true });
  });

  test("its key with nothing after it is an empty list, added to ; a file without it gets it at its end", () => {
    assert.deepEqual(YAML.parse(appendListEntries("repositories:\n", "repositories", [{ name: "a" }])).repositories, [{ name: "a" }]);
    assert.equal(appendListEntries("# ours\nlabels: []\n", "credentials", [{ name: "a" }]), "# ours\nlabels: []\ncredentials:\n  - name: a\n");
  });

  test("an entry found by its type's name field, case aside : a disclaimer version by its number", () => {
    const text = "disclaimer:\n  - version: 2\n    title: Old\n";
    assert.equal(updateListEntry(text, "disclaimer", "2", { title: "New" }).includes("title: New"), false, "by name : none");
    const out = editListEntry(text, "disclaimer", "2", (doc, map) => applyEdits(doc, map, { title: "New" }), { nameField: "version" });
    assert.equal(out, "disclaimer:\n  - version: 2\n    title: New\n");
  });
});

describe("a file shared with other keys written in flow style", () => {
  test("an entry edited : the other keys' flow lists and maps kept as they were written", () => {
    const text = "controller_credentials:\n  - name: a\n    user: bot\nowners: [ops@x]\nother: {a: 1,b: [x,y]}\nq: \"[ a ]\"\n";
    assert.equal(updateListEntry(text, "controller_credentials", "a", { user: "bot2" }), text.replace("user: bot\n", "user: bot2\n"));
    const added = appendListEntries(text, "controller_credentials", [{ name: "b" }]);
    assert.ok(added.includes("owners: [ops@x]\nother: {a: 1,b: [x,y]}\n"), added);
  });
});

describe("entries added to a list", () => {
  test("one whose name is there already : left as it is, its name said to the caller", () => {
    const skipped = [];
    const out = appendListEntries("credentials:\n  - name: a\n", "credentials", [{ name: "A" }, { name: "b" }], [], "name", skipped);
    assert.equal(out, "credentials:\n  - name: a\n  - name: b\n");
    assert.deepEqual(skipped, ["A"]);
  });
});

describe("an entry another one takes a value from by an alias", () => {
  const TEXT = "credentials:\n  - name: a\n    credential_type: git\n    user: &u bot\n  - name: b\n    credential_type: git\n    user: *u\n";

  test("removed : the alias made a copy of its value, the file valid YAML", () => {
    const out = removeListEntry(TEXT, "credentials", "a").text;
    assert.equal(out, "credentials:\n  - name: b\n    credential_type: git\n    user: bot\n");
  });

  test("its anchored value edited : the other entry keeps the value it had ; another field edited : the alias stays", () => {
    assert.equal(updateListEntry(TEXT, "credentials", "a", { user: "alice" }), TEXT.replace("&u bot", "alice").replace("*u", "bot"));
    assert.equal(updateListEntry(TEXT, "credentials", "a", { description: "x" }), TEXT.replace("user: &u bot\n", "user: &u bot\n    description: x\n"));
  });

  test("an entry whose name is an alias : found by the name it stands for, never added again", () => {
    const text = "x_names:\n  n: &n gitcred\ncredentials:\n  - name: *n\n    user: bot\n";
    assert.equal(updateListEntry(text, "credentials", "gitcred", { user: "bot2" }), text.replace("user: bot", "user: bot2"));
    const skipped = [];
    assert.equal(appendListEntries(text, "credentials", [{ name: "GitCred" }], [], "name", skipped), text);
    assert.deepEqual(skipped, ["GitCred"]);
    assert.equal(removeListEntry(text, "credentials", "gitcred").text, "x_names:\n  n: &n gitcred\n");
  });

  test("a whole entry anchored and merged into another : removed, the other keeps what it took", () => {
    const text = "credentials:\n  - &base\n    name: a\n    user: bot\n  - <<: *base\n    name: b\n";
    const out = removeListEntry(text, "credentials", "a").text;
    const doc = YAML.parseDocument(out);
    assert.deepEqual(doc.errors, []);
    assert.deepEqual(doc.toJS().credentials, [{ "<<": { name: "a", user: "bot" }, name: "b" }]);
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

describe("the lists and maps the app writes : block style, never flow", () => {
  // a file of the user's own, its lists and maps in flow style
  const FLOW = "controller_credentials: [{name: a, owners: [ops, dev]}]\nlabels: [web, db]   # ours\nextra: {a: 1, b: [x, y]}\n";

  test("a new entry : written in block style, the list it joins too ; the entries and keys it leaves as written", () => {
    const out = appendListEntries(FLOW, "controller_credentials", [{ name: "b", owners: ["ops"], tags: { env: "prod" } }]);
    assert.equal(
      out,
      "controller_credentials:\n  - {name: a, owners: [ops, dev]}\n  - name: b\n    owners:\n      - ops\n    tags:\n      env: prod\nlabels: [web, db]   # ours\nextra: {a: 1, b: [x, y]}\n",
    );
  });

  test("a value the app edits that the file writes as a flow list : the new value in block style", () => {
    const text = "controller_roles:\n  - name: admin\n    groups: [local/admins]\n    users: [root]   # who\n";
    const out = updateListEntry(text, "controller_roles", "admin", { groups: ["local/admins", "local/ops"] });
    assert.equal(out, "controller_roles:\n  - name: admin\n    groups:\n      - local/admins\n      - local/ops\n    users: [root]   # who\n");
    // a list emptied : [], the only way YAML writes an empty one
    assert.match(updateListEntry(text, "controller_roles", "admin", { users: [] }), /\n {4}users: \[\] {3}# who\n$/);
  });

  test("an entry written as one flow map : edited, it is written in block style, its lists too", () => {
    const text = "controller_roles:\n  - {name: admin, groups: [local/admins], users: [root]}\n  - {name: ops, groups: [local/ops]}\n";
    const out = updateListEntry(text, "controller_roles", "admin", { groups: ["local/admins", "corp/admins"], users: ["root", "bob"] });
    assert.equal(
      out,
      "controller_roles:\n  - name: admin\n    groups:\n      - local/admins\n      - corp/admins\n    users:\n      - root\n      - bob\n  - {name: ops, groups: [local/ops]}\n",
    );
  });

  test("a type's single map holding a list : the map and the list in block style, a flow map in it left as written", () => {
    const text = "controller_links: {show_designer: true, header_links: [], style: {x: 1}}\n";
    const out = editMapEntry(text, "controller_links", (doc, map) => applyEdits(doc, map, { header_links: [{ id: "docs", label: "Docs", url: "https://d", newTab: true }] }));
    assert.equal(out, "controller_links:\n  show_designer: true\n  header_links:\n    - id: docs\n      label: Docs\n      url: https://d\n      newTab: true\n  style: {x: 1}\n");
    // a map file (a whole type's file) : the same
    assert.equal(updateMapFile("a: 1\nb: [x]\nc: [y]\n", { b: ["x", "z"] }), "a: 1\nb:\n  - x\n  - z\nc: [y]\n");
  });

  test("several objects written at once (a usage turned on) : each in block style, new file or not", () => {
    const entries = [
      { name: "a", owners: ["ops"], extra: { k: [1, 2] } },
      { name: "b", owners: ["dev", "qa"] },
    ];
    const block = "controller_credentials:\n  - name: a\n    owners:\n      - ops\n    extra:\n      k:\n        - 1\n        - 2\n  - name: b\n    owners:\n      - dev\n      - qa\n";
    assert.equal(appendListEntries("", "controller_credentials", entries), block);
    assert.equal(appendListEntries("controller_credentials: []\n", "controller_credentials", entries), block);
    assert.equal(appendListEntries("# ours\nnotes: [kept]\n", "controller_credentials", entries), `# ours\nnotes: [kept]\n${block}`);
  });

  test("a file written padded ([ a ]) : a flow node kept on a rewritten line padded as the file pads them", () => {
    const text = "controller_roles:\n  - { name: admin, groups: [ local/admins ], users: [ root ] }\n";
    assert.equal(updateListEntry(text, "controller_roles", "admin", { groups: ["x"] }), "controller_roles:\n  - name: admin\n    groups:\n      - x\n    users: [ root ]\n");
  });

  test("flow style still read, and a file saved with nothing changed byte for byte", () => {
    assert.deepEqual(parseMapFile(FLOW).object, { controller_credentials: [{ name: "a", owners: ["ops", "dev"] }], labels: ["web", "db"], extra: { a: 1, b: ["x", "y"] } });
    assert.equal(updateListEntry(FLOW, "controller_credentials", "a", { owners: ["ops", "dev"] }), FLOW);
  });
});
