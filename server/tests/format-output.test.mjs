// tests for Helpers.formatOutput ; run with `npm test` (node --test)
// covers the classic ansible output coloring (regression) and the
// awx workflow status lines coloring (issue #420)
const { test } = await import("vitest");
import assert from "node:assert/strict";

// minimal env so the config modules load without a real setup
process.env.LOG_PATH = process.env.LOG_PATH || "/tmp/ansibleforms-test-logs";
process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.DB_PORT || "3306";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";

const { default: Helpers } = await import("../src/lib/common.js");

function record(output, output_type = "stdout", timestamp = "2026-01-01 10:00:00") {
  return { output, output_type, timestamp };
}

test("classic ansible output coloring is unchanged", () => {
  const out = Helpers.formatOutput(
    [
      record("PLAY [all] " + "*".repeat(64)),
      record("TASK [copy] " + "*".repeat(60) + "\nok: [host1]\nchanged: [host2]\nskipping: [host3]"),
      record("[WARNING]: something odd"),
      record("[ERROR]: something bad"),
      record("fatal: [host3]: FAILED! => {\"msg\": \"boom\"}", "stderr"),
      record("localhost : ok=2 changed=1 unreachable=0 failed=1 skipped=1"),
    ],
    false
  );
  assert.match(out, /has-text-weight-bold'>PLAY \[all\]/);
  assert.match(out, /has-text-success'>ok: \[host1\]/);
  assert.match(out, /has-text-warning'>changed: \[host2\]/);
  assert.match(out, /has-text-info'>skipping: \[host3\]/);
  assert.match(out, /has-text-purple'>\[WARNING\]: something odd/);
  assert.match(out, /has-text-danger'>\[ERROR\]: something bad/);
  assert.match(out, /has-text-danger'>fatal: \[host3\]/);
  assert.match(out, /tag is-success'>ok=2/);
  assert.match(out, /tag is-danger'>failed=1/);
  // the host red : it failed
  assert.match(out, /has-text-danger'>localhost<\/span> :/);
});

test("workflow node status lines are colored by status", () => {
  const out = Helpers.formatOutput(
    [
      record("WORKFLOW NODE [node one] (successful) " + "*".repeat(40)),
      record("WORKFLOW NODE [node two] (failed)"),
      record("WORKFLOW NODE [node three] (error)"),
      record("WORKFLOW NODE [node four] (canceled)"),
      record("WORKFLOW NODE [node five] (skipped)"),
      record("WORKFLOW NODE [node six] (pending)"),
      record("WORKFLOW NODE [node seven] (running)"),
      record("WORKFLOW [my workflow] (failed) " + "*".repeat(40)),
    ],
    false
  );
  assert.match(out, /has-text-weight-bold has-text-success'>WORKFLOW NODE \[node one\] \(successful\)/);
  assert.match(out, /has-text-weight-bold has-text-danger'>WORKFLOW NODE \[node two\] \(failed\)/);
  assert.match(out, /has-text-weight-bold has-text-danger'>WORKFLOW NODE \[node three\] \(error\)/);
  assert.match(out, /has-text-weight-bold has-text-warning'>WORKFLOW NODE \[node four\] \(canceled\)/);
  assert.match(out, /has-text-weight-bold has-text-info'>WORKFLOW NODE \[node five\] \(skipped\)/);
  assert.match(out, /has-text-weight-bold has-text-info'>WORKFLOW NODE \[node six\] \(pending\)/);
  // running has no status color, just bold
  assert.match(out, /has-text-weight-bold'>WORKFLOW NODE \[node seven\] \(running\)/);
  // the workflow summary line itself
  assert.match(out, /has-text-weight-bold has-text-danger'>WORKFLOW \[my workflow\] \(failed\)/);
});

test("workflow banner does not bleed its color into the next lines", () => {
  const out = Helpers.formatOutput(
    [record("WORKFLOW NODE [node one] (failed) " + "*".repeat(40) + "\nplain output line")],
    false
  );
  // the plain line after the banner must not be red
  assert.match(out, /<span class=''>plain output line<\/span>/);
});

test("workflow lines stay plain in text mode (download)", () => {
  const out = Helpers.formatOutput(
    [record("WORKFLOW NODE [node one] (successful) ****")],
    true
  );
  assert.equal(out.includes("<span"), false);
  assert.match(out, /WORKFLOW NODE \[node one\] \(successful\)/);
});

test("a workflow summary's lines : black, the status alone in its colour, the statuses in one column", async () => {
  const { workflowSummaryLines } = await import("../src/lib/workflowSummary.js");
  const lines = workflowSummaryLines([
    { id: 1, name: "validate-request", status: "successful" },
    { id: 13, name: "create-dns-records", status: "failed" },
    { id: 2, name: "rollback", status: "skipped" },
  ]);
  assert.deepEqual(lines, [
    "WORKFLOW NODE #1  [validate-request]   : successful",
    "WORKFLOW NODE #13 [create-dns-records] : failed",
    "WORKFLOW NODE #2  [rollback]           : skipped",
  ]);
  // a long name : every status still starts in the same column, after it
  const long = workflowSummaryLines([
    { id: 1, name: "x".repeat(80), status: "successful" },
    { id: 2, name: "short", status: "failed" },
  ]);
  assert.equal(long[0].indexOf(" : "), long[1].indexOf(" : "));
  const out = Helpers.formatOutput(lines.map((l) => record(l)));
  assert.match(out, /<span class=''>WORKFLOW NODE #1 {2}\[validate-request\] {3}: <\/span><span class='has-text-success'>successful<\/span>/);
  assert.match(out, /<span class='has-text-danger'>failed<\/span>/);
  assert.match(out, /<span class='has-text-info'>skipped<\/span>/);
});

// an RTE build's output (job_type build) : BuildKit's steps, a blank line before each, coloured
test("an RTE build's steps come out in blocks, coloured", () => {
  const out = Helpers.formatOutput(
    [
      record("ok: [Building runtime environment x]"),
      record("Building localhost:5000/af/x:7.9.0 on builder 'b'"),
      record("\x1b[1m#1 [internal] load <Dockerfile>\x1b[0m\n#1 transferring\n#1 DONE 0.1s"),
      record("#2 FROM base\n#2 CACHED"),
      record("#3 RUN false\n#3 ERROR: exit code: 1\n#4 RUN x\n#4 CANCELED"),
      record("ERROR: failed to solve\n\nPushed localhost:5000/af/x@sha256:1"),
      record("Signed localhost:5000/af/x@sha256:1"),
      record("the build failed", "stderr"),
    ],
    false,
    "build",
  );
  assert.deepEqual(out.split("\r\n"), [
    "<span class='has-text-success'>ok: [Building runtime environment x]</span>",
    "<span class=''>Building localhost:5000/af/x:7.9.0 on builder &#39;b&#39;</span>",
    "",
    "<span class='has-text-weight-bold'>#1 [internal] load &lt;Dockerfile&gt;</span>",
    "<span class=''>#1 transferring</span>",
    "<span class='has-text-success'>#1 DONE 0.1s</span>",
    "",
    "<span class='has-text-weight-bold'>#2 FROM base</span>",
    "<span class='has-text-info'>#2 CACHED</span>",
    "",
    "<span class='has-text-weight-bold'>#3 RUN false</span>",
    "<span class='has-text-danger'>#3 ERROR: exit code: 1</span>",
    "",
    "<span class='has-text-weight-bold'>#4 RUN x</span>",
    "<span class='has-text-danger'>#4 CANCELED</span>",
    "",
    "<span class='has-text-danger'>ERROR: failed to solve</span>",
    "<span class='has-text-warning'>Pushed localhost:5000/af/x@sha256:1</span>",
    "<span class='has-text-warning'>Signed localhost:5000/af/x@sha256:1</span>",
    "<span class='has-text-danger'>the build failed</span>",
  ]);
});

test("a build's output as text is left as it is", () => {
  assert.equal(Helpers.formatOutput([record("#1 DONE 0.1s")], true, "build"), "#1 DONE 0.1s");
});

// BuildKit says a step again as it does more of it, and a layer's progress every few hundred ms
test("an RTE build's step comes out once, its layers' progress and DONE their last line only", () => {
  const d = "sha256:" + "a".repeat(64);
  const out = Helpers.formatOutput(
    [
      record("#8 [stage-1 1/12] FROM base\n#8 " + d + " 1MB / 9MB 0.2s\n#7 [uv 1/1] FROM uv\n#8 ..."),
      record("#8 " + d + " 9MB / 9MB 0.9s done\n#8 DONE 1.0s\n#7 DONE 0.5s"),
      record("#8 [stage-1 1/12] FROM base\n#8 extracting " + d + "\n#8 extracting " + d + " 1.3s done\n#8 DONE 2.4s"),
    ],
    false,
    "build",
  );
  assert.deepEqual(out.split("\r\n"), [
    "<span class='has-text-weight-bold'>#8 [stage-1 1/12] FROM base</span>",
    `<span class=''>#8 ${d} 9MB / 9MB 0.9s done</span>`,
    `<span class=''>#8 extracting ${d} 1.3s done</span>`,
    "<span class='has-text-success'>#8 DONE 2.4s</span>",
    "",
    "<span class='has-text-weight-bold'>#7 [uv 1/1] FROM uv</span>",
    "<span class='has-text-success'>#7 DONE 0.5s</span>",
  ]);
});
