// A builder's page and a database's page (pages/admin/builder.vue, database.vue) : their tables
// (Builds, Used by) are searched by the page's own search, in the title line. They were given
// `search || null`, and an empty search is null to the table, which then shows a search box of
// its own : two boxes on the page.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(__dirname, '../src/pages/admin/builder.vue'), 'utf8');

describe("a builder's page", () => {
  it("gives its Builds table the page's search, never null", () => {
    expect(page).toMatch(/<AppLinkedTable\s+:search="search"/);
    expect(page).not.toMatch(/:search="search \|\| null"/);
  });
});

describe("a database's page", () => {
  it("gives its Used by table the page's search, never null", () => {
    const db = readFileSync(join(__dirname, '../src/pages/admin/database.vue'), 'utf8');
    expect(db).toMatch(/:search="search"/);
    expect(db).not.toMatch(/:search="search \|\| null"/);
  });
});
