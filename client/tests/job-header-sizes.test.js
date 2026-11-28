// A job's page has its headers one size, 1rem : the job's title, a multistep's step titles, the
// output's and the workflow graph's toolbars, the output's sections (the body's size).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '../src', f), 'utf8');
const rule = (src, selector) => {
  const at = src.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf('}', at));
};

describe("a job page's headers", () => {
  it('are 1rem each', () => {
    const jobs = read('pages/jobs.vue');
    expect(rule(jobs, '.af-job-number')).toMatch(/font-size: 1rem;/);
    expect(rule(jobs, '\n.af-job-title')).toMatch(/font-size: 1rem;/);
    expect(rule(read('styles/jobOutput.scss'), '.af-output-label')).toMatch(/font-size: 1rem;/);
    const graph = read('components/AppAwxWorkflow.vue');
    expect(graph).toMatch(/\.awx-workflow-label \{\n\s+display: flex;[^}]*font-size: 1rem;/);
    // the sections' name : the body's size, none of its own
    expect(rule(read('components/AppAnsibleOutput.vue'), '.af-node-name')).not.toMatch(/font-size/);
  });
});
