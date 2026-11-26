// A database's page (pages/admin/database.vue) : its Used by table is searched by the page's own
// search, in the title line. It was given `search || null`, and an empty search is null to the
// table, which then shows a search box of its own : two boxes on the page.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe("a database's page", () => {
  it("gives its Used by table the page's search, never null", () => {
    const db = readFileSync(join(__dirname, '../src/pages/admin/database.vue'), 'utf8');
    expect(db).toMatch(/:search="search"/);
    expect(db).not.toMatch(/:search="search \|\| null"/);
  });
});
