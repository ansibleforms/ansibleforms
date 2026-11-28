// An RTE build's page : its first row of facts names the image it builds, the builder it ran on and
// who launched it ; its second row when it started, ended and how long it took.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '../src/pages/jobs.vue'), 'utf8');
const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

describe("an RTE build's facts", () => {
  it('shows the image and the builder in place of the form', () => {
    const build = page.indexOf('v-else-if="job.job_type == \'build\'"');
    const form = page.indexOf("t('jobs.form') }}</dt>", build);
    expect(build).toBeGreaterThan(0);
    const block = page.slice(build, form);
    expect(block).toMatch(/t\('jobs\.rteName'\)[\s\S]*job\.target/);
    expect(block).toMatch(/t\('jobs\.rteBuilder'\)[\s\S]*job\.runner/);
  });

  it('puts launched by third, then start, end and duration', () => {
    const order = [
      "t('jobs.rteBuilder')",
      "t('jobs.launchedBy')",
      "t('jobs.startTime')",
      "t('jobs.endTime')",
      "t('jobs.duration')",
    ];
    const start = page.indexOf('v-else-if="job.job_type == \'build\'"');
    const at = order.map((k) => page.indexOf(k, start));
    expect(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]))).toBe(true);
  });

  it('names both facts in every language', async () => {
    for (const l of LANGS) {
      const { default: m } = await import(`../src/locales/${l}.js`);
      expect(m.jobs.rteName, l).toBeTruthy();
      expect(m.jobs.rteBuilder, l).toBeTruthy();
    }
  });
});
