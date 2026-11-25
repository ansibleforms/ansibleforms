// A job that ends needing attention : the contract a playbook writes (lib/jobAttention.js)
import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ATTENTION_KEY, takeStatusFile, attentionFromArtifacts, withoutAttention, MESSAGE_MAX, DETAIL_MAX } from "../src/lib/jobAttention.js";

describe("attentionFromArtifacts", () => {
  test("nothing asked is null", () => {
    assert.equal(attentionFromArtifacts({}), null);
    assert.equal(attentionFromArtifacts(null), null);
    assert.equal(attentionFromArtifacts({ other: 1 }), null);
  });

  test("attention with a message and a detail", () => {
    const r = attentionFromArtifacts({ [ATTENTION_KEY]: { status: "attention", message: "3 items wait\n", detail: [{ id: 1 }] } });
    assert.deepEqual(r, { attention: true, message: "3 items wait", detail: [{ id: 1 }], detailDropped: false });
  });

  test("warning is a synonym, case does not matter", () => {
    assert.equal(attentionFromArtifacts({ [ATTENTION_KEY]: { status: "Warning", message: "x" } }).attention, true);
  });

  test("success asks for nothing to change", () => {
    assert.deepEqual(attentionFromArtifacts({ [ATTENTION_KEY]: { status: "success" } }), { attention: false });
  });

  test("a folded message is one line, cut at its maximum", () => {
    const r = attentionFromArtifacts({ [ATTENTION_KEY]: { status: "attention", message: "a\n  b\n" + "c".repeat(MESSAGE_MAX * 2) } });
    assert.ok(r.message.startsWith("a b c"));
    assert.equal(r.message.length, MESSAGE_MAX);
  });

  test("an unknown status, no message or no object is an error", () => {
    assert.ok(attentionFromArtifacts({ [ATTENTION_KEY]: { status: "failed", message: "x" } }).error);
    assert.ok(attentionFromArtifacts({ [ATTENTION_KEY]: { status: "attention" } }).error);
    assert.ok(attentionFromArtifacts({ [ATTENTION_KEY]: "attention" }).error);
    assert.ok(attentionFromArtifacts({ [ATTENTION_KEY]: [] }).error);
  });

  test("a detail too large is dropped, the attention stays", () => {
    const r = attentionFromArtifacts({ [ATTENTION_KEY]: { status: "attention", message: "x", detail: "d".repeat(DETAIL_MAX + 1) } });
    assert.equal(r.attention, true);
    assert.equal(r.detail, null);
    assert.equal(r.detailDropped, true);
  });

  test("withoutAttention leaves the other artifacts", () => {
    assert.deepEqual(withoutAttention({ a: 1, [ATTENTION_KEY]: { status: "attention" } }), { a: 1 });
    const same = { a: 1 };
    assert.equal(withoutAttention(same), same);
  });
});

describe("takeStatusFile", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-attention-"));
    fs.mkdirSync(path.join(dir, ".joblogs"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("no file is null", () => {
    assert.equal(takeStatusFile(dir, 7), null);
    assert.equal(takeStatusFile("", 7), null);
  });

  test("reads .yml and removes it", () => {
    const file = path.join(dir, ".joblogs", "job_status_7.yml");
    fs.writeFileSync(file, "status: attention\nmessage: >\n  Follow-up required\ndetail:\n  - id: 1\n");
    assert.deepEqual(takeStatusFile(dir, 7), { value: { status: "attention", message: "Follow-up required\n", detail: [{ id: 1 }] } });
    assert.equal(fs.existsSync(file), false);
  });

  test("reads .yaml too", () => {
    fs.writeFileSync(path.join(dir, ".joblogs", "job_status_7.yaml"), "status: attention\nmessage: m\n");
    assert.equal(takeStatusFile(dir, 7).value.message, "m");
  });

  test("another job's file is left alone", () => {
    const other = path.join(dir, ".joblogs", "job_status_8.yml");
    fs.writeFileSync(other, "status: attention\n");
    assert.equal(takeStatusFile(dir, 7), null);
    assert.equal(fs.existsSync(other), true);
  });

  test("invalid YAML is an error, and the file goes", () => {
    const file = path.join(dir, ".joblogs", "job_status_7.yml");
    fs.writeFileSync(file, "status: [unclosed\n");
    assert.ok(takeStatusFile(dir, 7).error);
    assert.equal(fs.existsSync(file), false);
  });
});
