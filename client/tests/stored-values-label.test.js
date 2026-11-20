// A stored job's values (its page and its New dialog) : the tab says Values, the field's bold title
// Values (YAML), as a schedule's Extra vars (YAML).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import getSettings from '@/config/settings';

const page = readFileSync(resolve(__dirname, '../src/pages/stored-job.vue'), 'utf8');
const all = getSettings((key) => key);

describe("a stored job's values", () => {
  it('are titled Values (YAML), the tab still Values', () => {
    expect(page).toMatch(/:label="t\('settings\.storedJobs\.valuesLabel'\)"/);
    expect(page).toMatch(/\{ key: 'values', label: t\('settings\.storedJobs\.tabValues'\), icon: 'code' \}/);
    expect(all.stored_jobs.fields.find((f) => f.key === 'form_data').label).toBe('settings.storedJobs.valuesLabel');
  });

  it('say (YAML) in every language', async () => {
    for (const lang of ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl']) {
      const { default: m } = await import(`../src/locales/${lang}.js`);
      expect(m.settings.storedJobs.valuesLabel, lang).toMatch(/YAML/);
    }
  });
});
