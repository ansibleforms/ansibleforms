// A job names the stored job it was launched from (#1437) : the job page shows it among the job's
// facts, its name a link to the stored job's page, when the server sends it (GET /api/v2/job/:id
// storedJob, only to a viewer who sees that stored job, none once it is deleted). Read from the
// page's source, as the other page tests do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withoutComments } from './vueSource.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = withoutComments(readFileSync(path.join(here, '..', 'src/pages/jobs.vue'), 'utf8'));

describe('the stored job of a job', () => {
  it('is a fact of the job only when the server names one', () => {
    expect(page).toMatch(/<div v-if="job\.storedJob" class="af-job-fact">/);
  });

  it("links its name to the stored job's page, under the stored job's label", () => {
    const fact = page.slice(page.indexOf('v-if="job.storedJob"'));
    expect(fact).toMatch(/t\('settings\.storedJobs\.label'\)/);
    expect(fact).toMatch(
      /<router-link :to="`\/jobs\/stored\/\$\{job\.storedJob\.id\}`">\{\{ job\.storedJob\.name \}\}<\/router-link>/,
    );
  });
});
