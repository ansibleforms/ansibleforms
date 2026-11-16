// A form name defined in two forms repositories : each repository's page (pages/admin/repository.vue)
// says which copy is used and which one is skipped, one warning line for each name, from the
// formDuplicates the server sends with the repository (GET /api/v2/repository/:name). The line
// names both copies, in every language.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '../src/pages/admin/repository.vue'), 'utf8');

// every language of the app
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

describe('a form name defined in two forms repositories', () => {
  it("each repository's page says which copy is used and which skipped", () => {
    expect(page).toContain('v-for="d in repo.formDuplicates || []"');
    expect(page).toContain(
      "t('settings.repositories.formDuplicate', { name: d.name, used: d.used.place, skipped: d.skipped.place })",
    );
  });

  it('the warning names the form and both copies, in every language', async () => {
    for (const lang of LANGS) {
      const r = (await import(`../src/locales/${lang}.js`)).default.settings.repositories;
      for (const p of ['{name}', '{used}', '{skipped}']) expect(r.formDuplicate, lang).toContain(p);
    }
  });
});
