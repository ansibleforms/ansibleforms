// A job's own card (a playbook, a build) ends at its PLAY RECAP, else before AnsibleForms' own lines
// at the output's end : a build's closing line (ok: [RTE image ... built and pushed]) shows under
// the card, as a playbook's does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../src/components/AppAnsibleOutput.vue'), 'utf8');

describe("a job's own card", () => {
  it('ends at the recap, else before the closing own lines', () => {
    expect(src).toMatch(/if \(recap >= 0\) end = all\[recap\]\.end;/);
    expect(src).toMatch(
      /else while \(end > start && \(ownLine\(all\[end - 1\]\) \|\| !plain\(all\[end - 1\]\.html\)\)\) end--;/,
    );
  });
});
