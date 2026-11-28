// A job's page : its sections' buttons (a node's extravars and artifacts, every section's Copy
// output and Download output), the output toolbar without Refresh, and the toasts in the body so a
// toast said from a dialog shows over its backdrop.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, '../src', f), 'utf8');

describe("a job page's buttons", () => {
  it('every section copies and downloads its output, in words', () => {
    const out = read('components/AppAnsibleOutput.vue');
    expect(out).toMatch(/@click\.stop="copySection\(group\.node\)"[\s\S]*?t\('jobs\.copyOutput'\)/);
    expect(out).toMatch(/@click\.stop="downloadSection\(group\.node\)"[\s\S]*?t\('jobs\.downloadOutput'\)/);
    expect(out).toMatch(/@click\.stop="downloadLog"/);
    expect(out).not.toMatch(/copyLabel/);
  });

  it('the output toolbar has no Refresh', () => {
    expect(read('pages/jobs.vue')).not.toMatch(/refreshOutput/);
  });

  it('the toasts live in the body, over a dialog', () => {
    expect(read('App.vue')).toMatch(/<Teleport to="body">\s*<Toaster/);
  });
});
