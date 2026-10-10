// The forms of a file are parsed once per content (models/form.model.js getFormsFromFile) : a
// changed file is read again, and every caller gets its own copy.
import { describe, test, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_PORT ||= "3306";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
vi.mock("../src/models/db.model.js", () => ({ default: { do: async () => [] } }));

const { getFormsFromFile } = await import("../src/models/form.model.js");

describe("the form file cache", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-forms-"));
  const file = path.join(dir, "demo.yaml");

  test("read once, and again when the file changes", () => {
    fs.writeFileSync(file, "- name: One\n  type: ansible\n");
    const read = vi.spyOn(fs, "readFileSync");
    expect(getFormsFromFile(dir, "demo.yaml")[0].name).toBe("One");
    expect(getFormsFromFile(dir, "demo.yaml")[0].name).toBe("One");
    expect(read.mock.calls.filter((c) => String(c[0]) === file)).toHaveLength(1);
    fs.writeFileSync(file, "- name: Two, renamed\n  type: ansible\n");
    // a new size (and mtime) : read again
    expect(getFormsFromFile(dir, "demo.yaml")[0].name).toBe("Two, renamed");
    read.mockRestore();
  });

  test("every caller gets its own copy", () => {
    const a = getFormsFromFile(dir, "demo.yaml");
    a[0].name = "changed by a caller";
    expect(getFormsFromFile(dir, "demo.yaml")[0].name).toBe("Two, renamed");
  });

  test("the file it came from is kept on each form, never enumerated", () => {
    const [form] = getFormsFromFile(dir, "demo.yaml");
    expect(form.source).toBe("demo.yaml");
    expect(Object.keys(form)).not.toContain("__cacheKey");
    expect(JSON.stringify(form)).not.toContain("__cacheKey");
  });
});
