// An enum field's table (a dropdown table, a left-right selector) is sorted by clicking a column's
// header (issue #1526) : A to Z, Z to A, then the order the values came in. Numbers sort as
// numbers, text as it reads (kvm-9 before kvm-10), empty cells last either way. Display only :
// each row keeps its index, which the selection goes by. A field's `sortable: false` keeps the
// order the values came in.
import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareCells, sortRows, useColumnSort } from '@/composables/useColumnSort';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, '..', p), 'utf8');

// the rows as the tables hold them : { index, value }
const rowsOf = (values) => values.map((value, index) => ({ index, value }));
const column = (rows, key) => rows.map((r) => r.value[key]);

const HOSTS = [
  { name: 'kvm-10', ram: 64, guests: '12' },
  { name: 'kvm-9', ram: 128, guests: '' },
  { name: 'KVM-2', ram: 8, guests: '3' },
  { name: 'esx-1', ram: null, guests: '40' },
];

describe('the cells compared', () => {
  it('numbers as numbers, texts that are numbers too', () => {
    expect(compareCells(9, 10)).toBeLessThan(0);
    expect(compareCells('9', '10')).toBeLessThan(0);
    expect(compareCells(' 100 ', '20')).toBeGreaterThan(0);
  });

  it('text as it reads : its numbers as numbers, case and accents alike', () => {
    expect(compareCells('kvm-9', 'kvm-10')).toBeLessThan(0);
    expect(compareCells('KVM-2', 'kvm-9')).toBeLessThan(0);
    expect(compareCells('Éclair', 'eclair')).toBe(0);
  });
});

describe('the rows sorted by a column', () => {
  it('A to Z, Z to A, the order they came in without a column', () => {
    const rows = rowsOf(HOSTS);
    expect(column(sortRows(rows, 'name', 1), 'name')).toEqual(['esx-1', 'KVM-2', 'kvm-9', 'kvm-10']);
    expect(column(sortRows(rows, 'name', -1), 'name')).toEqual(['kvm-10', 'kvm-9', 'KVM-2', 'esx-1']);
    expect(sortRows(rows, '', 0)).toBe(rows);
    expect(sortRows(rows, 'name', 0)).toBe(rows);
  });

  it('numbers as numbers ; empty cells last whichever way', () => {
    const rows = rowsOf(HOSTS);
    expect(column(sortRows(rows, 'ram', 1), 'ram')).toEqual([8, 64, 128, null]);
    expect(column(sortRows(rows, 'ram', -1), 'ram')).toEqual([128, 64, 8, null]);
    expect(column(sortRows(rows, 'guests', 1), 'guests')).toEqual(['3', '12', '40', '']);
    expect(column(sortRows(rows, 'guests', -1), 'guests')).toEqual(['40', '12', '3', '']);
  });

  it('each row keeps its index (the selection goes by it), the rows themselves unchanged', () => {
    const rows = rowsOf(HOSTS);
    const sorted = sortRows(rows, 'ram', 1);
    expect(sorted.map((r) => r.index)).toEqual([2, 0, 1, 3]);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    for (const r of sorted) expect(r.value).toBe(HOSTS[r.index]);
  });

  it('rows alike keep the order they came in', () => {
    const rows = rowsOf([
      { k: 'b', n: 1 },
      { k: 'a', n: 2 },
      { k: 'b', n: 3 },
      { k: 'a', n: 4 },
    ]);
    expect(column(sortRows(rows, 'k', 1), 'n')).toEqual([2, 4, 1, 3]);
    expect(column(sortRows(rows, 'k', -1), 'n')).toEqual([1, 3, 2, 4]);
  });
});

describe('a header clicked', () => {
  it('A to Z, then Z to A, then the order they came in ; another column starts A to Z', async () => {
    const rows = ref(rowsOf(HOSTS));
    const { toggleSort, sortIcon, sorted, sortColumn, sortDir } = useColumnSort(rows);
    expect(sortIcon('name')).toBe('');
    toggleSort('name');
    expect(column(sorted.value, 'name')[0]).toBe('esx-1');
    expect(sortIcon('name')).toBe('caret-up');
    toggleSort('name');
    expect(column(sorted.value, 'name')[0]).toBe('kvm-10');
    expect(sortIcon('name')).toBe('caret-down');
    toggleSort('name');
    expect(sorted.value).toBe(rows.value);
    expect([sortColumn.value, sortDir.value]).toEqual(['', 0]);
    toggleSort('name');
    toggleSort('ram');
    expect([sortColumn.value, sortDir.value]).toEqual(['ram', 1]);
    expect(sortIcon('name')).toBe('');
  });

  it('the rows filtered again (the search box) : sorted the same way', async () => {
    const rows = ref(rowsOf(HOSTS));
    const { toggleSort, sorted } = useColumnSort(rows);
    toggleSort('ram');
    rows.value = rows.value.filter((r) => r.value.name.toLowerCase().startsWith('kvm'));
    await nextTick();
    expect(column(sorted.value, 'ram')).toEqual([8, 64, 128]);
  });

  it('not sortable : a click changes nothing, the order they came in', () => {
    const rows = ref(rowsOf(HOSTS));
    const { toggleSort, sorted, sortIcon } = useColumnSort(rows, () => false);
    toggleSort('name');
    expect(sorted.value).toBe(rows.value);
    expect(sortIcon('name')).toBe('');
  });
});

describe('the tables and the field', () => {
  for (const file of [
    'src/components/BsInputSelectAdvancedTable.vue',
    'src/components/BsInputSelectAdvancedTable2.vue',
  ]) {
    it(`${file.split('/').pop()} : its headers sort, its rows shown sorted, the selection by index`, () => {
      const src = read(file);
      expect(src).toMatch(/useColumnSort\(filtered, \(\) => props\.sortable\)/);
      expect(src).toMatch(/sortable: \{ type: Boolean, default: true \}/);
      // its click stops at the header : its arrow replaced as it sorts, the dropdown's click-outside
      // found the clicked element gone and closed the table
      expect(src).toMatch(/@click\.stop="toggleSort\(l\)"/);
      // the hand over the header, its arrow too
      expect(src).toMatch(/th\.af-sortable,\s*th\.af-sortable \* \{\s*cursor: pointer;/);
      // a narrow column cuts its text (…), never its arrow
      expect(src).toMatch(/<span class="af-th-text">\{\{ l \}\}<\/span>/);
      expect(src).toMatch(/\.af-th-text \{[^}]*text-overflow: ellipsis;/);
      expect(src).toMatch(/\.af-th-sort \{[^}]*flex-shrink: 0;/);
      // its arrow on the middle of the lowercase text : the header on the baseline, the arrow's
      // centre at half the text's x-height
      expect(src).toMatch(/\.af-th \{[^}]*align-items: baseline;/);
      // the sorted column's arrow the secondary grey, the others the tertiary, a step lighter
      expect(src).toMatch(/<font-awesome-icon v-else icon="sort" class="af-th-sort-idle" \/>/);
      expect(src).toMatch(/\.af-th-sort \{\s*color: var\(--bs-secondary-color\);/);
      expect(src).toMatch(/\.af-th-sort-idle \{\s*color: var\(--bs-tertiary-color\);/);
      expect(src).toMatch(/\.af-th-sort svg \{[^}]*font-size: 0\.7em;[^}]*vertical-align: middle;/);
      expect(src).toMatch(/<font-awesome-icon v-if="sortIcon\(l\)" :icon="sortIcon\(l\)" \/>/);
      expect(src).toMatch(/v-for="\(?v(, i\))? in sorted"/);
      expect(src).toMatch(/select\(v\.index\)/);
    });
  }

  it('a field passes sortable (on unless false) down to its table', () => {
    expect(read('src/components/AppForm.vue')).toMatch(/:sortable="field\.sortable !== false"/);
    for (const [file, n] of [
      ['src/components/BsInputForForm.vue', 1],
      ['src/components/BsInput.vue', 3],
      ['src/components/BsInputSelectAdvanced.vue', 4],
      ['src/components/BsInputSelectAdvanced2.vue', 2],
    ]) {
      expect((read(file).match(/:sortable="sortable"/g) || []).length, file).toBe(n);
    }
  });

  it('the Designer offers it, a switch, and the schema takes it as a boolean', () => {
    expect(read('src/config/fieldProperties.js')).toMatch(/key: 'sortable',\s*kind: 'switch'/);
    const schema = read('../server/schema/form_schema.json');
    expect(schema).toMatch(/"sortable": \{"type": "boolean"\}/);
  });
});
