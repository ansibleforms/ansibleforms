// A stored job lists its runs (#1437) : a Runs tab on its page, the jobs launched from it as the
// server's jobs list narrows them (GET /api/v2/job/?stored_job=<id>, only the jobs this user may
// see), in the table and columns of the other record pages' job tabs (a runner's, a user's) : a
// count on the tab, the job's number, who launched it, its status as a pill, its start and end,
// its duration to the right. Read from the page's source, as the other page tests do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = withoutComments(readFileSync(path.join(here, '..', 'src/pages/stored-job.vue'), 'utf8'));
const LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

describe('the Runs tab of a stored job', () => {
  it('is a tab with the count of its runs', () => {
    expect(page).toMatch(
      /key: 'runs', label: t\('settings\.storedJobs\.tabRuns'\), icon: 'history', count: runs\.value\.length/,
    );
    expect(page).toMatch(
      /<span v-if="tab\.count !== undefined" class="badge af-tab-count ms-1">\{\{ tab\.count \}\}<\/span>/,
    );
  });

  it("reads the jobs launched from it, the server's list narrowed to it, a multistep's steps left under their job", () => {
    expect(page).toMatch(
      /axios\.get\(`\/api\/v2\/job\/\?stored_job=\$\{encodeURIComponent\(storedId\.value\)\}&records=\$\{RUNS_SHOWN\}`\)/,
    );
    expect(page).toMatch(/\.filter\(\(j\) => !j\.parent_id\)/);
  });

  it('shows them as the other job tabs do : a linked table, a status pill, each row opening its job', () => {
    const tab = page.slice(page.indexOf('v-if="tabShown(\'runs\')"'));
    expect(tab).toMatch(/<AppLinkedTable/);
    expect(tab).toMatch(/:to="\(j\) => `\/jobs\/\$\{j\.id\}`"/);
    expect(tab).toMatch(/<template #cell-status="\{ row \}"><AppStatusPill :status="row\.status" \/><\/template>/);
  });

  it('has the columns of the job tabs : number, who, start, end, the duration to the right, then status', () => {
    const columns = page.slice(page.indexOf('const runColumns'), page.indexOf('async function loadRuns'));
    const keys = [...columns.matchAll(/key: '(\w+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(['id', 'user', 'start', 'end', 'duration', 'status']);
    expect(columns).toMatch(/key: 'duration',\s*label: t\('jobs\.duration'\),\s*keep: true,\s*class: 'text-end'/);
  });

  it('is named in every language, a word or two', async () => {
    for (const lang of LANGUAGES) {
      const texts = (await import(`../src/locales/${lang}.js`)).default;
      const label = texts.settings.storedJobs.tabRuns;
      expect(label, lang).toBeTruthy();
      expect(label.length, lang).toBeLessThanOrEqual(16);
    }
  });
});
