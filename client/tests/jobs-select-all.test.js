// The jobs list's selection, as every other table's (BsDataTable, AppLinkedTable).
//
// Its header checkbox ticked the jobs of the page only, with no Select all, no count and no
// Clear selection : deleting 50 failed jobs on 5 pages took 5 pages of ticking. It now has
// the other tables' three, Select all covering every job the list shows (its status and its
// search) on all pages that can be deleted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '../src/pages/jobs.vue'), 'utf8');

describe('the jobs list selection', () => {
  it('selects every job of the list that can be deleted, on all pages', () => {
    expect(page).toMatch(/const allSelectable = computed\(\(\) => parentJobs\.value\.filter\(canDelete\)\)/);
    expect(page).toMatch(
      /function selectAll\(\) \{\s*selected\.value = new Set\(allSelectable\.value\.map\(\(j\) => j\.id\)\);/,
    );
  });

  it('shows the count, Clear selection and Select all as the other tables', () => {
    expect(page).toContain("t('dataTable.selected', selected.size)");
    expect(page).toContain("t('dataTable.clearSelection')");
    expect(page).toContain("t('dataTable.selectAll', { count: allSelectable.length })");
    // offered only while something is left to tick
    expect(page).toContain('v-if="allSelectable.length && selected.size < allSelectable.length"');
  });
});
