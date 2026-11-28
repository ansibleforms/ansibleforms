// A workflow node's section has an icon after its caret, as a job's own section has its scroll :
// by what the node runs (the graph's node type), a job template's scroll when unknown.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../src/components/AppAnsibleOutput.vue'), 'utf8');

describe("a workflow node's icon", () => {
  it('follows what the node runs', () => {
    for (const [type, icon] of [
      ['job', 'scroll'],
      ['workflow_job', 'diagram-project'],
      ['workflow_approval', 'user-check'],
      ['project_update', 'code-branch'],
      ['inventory_update', 'server'],
    ])
      expect(src).toMatch(new RegExp(`${type}: '${icon}'`));
    expect(src).toMatch(/return NODE_ICONS\[type\] \|\| 'scroll';/);
    expect(src).toMatch(/type: graphNode\?\.type \?\? null,/);
  });

  it('shows in the header after the caret', () => {
    expect(src).toMatch(/v-else-if="group\.node\.kind == 'node'"\s+:icon="nodeIcon\(group\.node\.type\)"/);
  });
});
