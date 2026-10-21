// Every table's order (lib/dataTable.js) : a named column sorts, A to Z then Z to A, numbers and
// yes / no by value, text alphabetically with "file2" before "file10" ; and an empty cell is an en
// dash (lib/tableCells.js).
import { describe, it, expect } from 'vitest';
import { isSortable, compareRows } from '@/lib/dataTable';
import { orEmpty, EMPTY_CELL } from '@/lib/tableCells';
import { usageBadges, usageSortValue } from '@/lib/repositoryUsage';

const text = (row, col) => String(row[col.key] ?? '');
const sorted = (rows, col, dir = 1) => [...rows].sort((a, b) => compareRows(a, b, col, dir, text));

describe('the order of a table', () => {
  it('a column with a name sorts ; a caret, a checkbox or a menu column has none', () => {
    expect(isSortable({ key: 'name', label: 'Name' })).toBe(true);
    expect(isSortable({ key: 'caret', label: '' })).toBe(false);
    expect(isSortable({ key: 'x' })).toBe(false);
  });

  it('text alphabetically, case aside, numbers in it by value ; descending turns it round', () => {
    const col = { key: 'name', label: 'Name' };
    const rows = [{ name: 'file10' }, { name: 'File2' }, { name: 'alpha' }];
    expect(sorted(rows, col).map((r) => r.name)).toEqual(['alpha', 'File2', 'file10']);
    expect(sorted(rows, col, -1).map((r) => r.name)).toEqual(['file10', 'File2', 'alpha']);
  });

  it('numbers and yes / no by value ; a sortValue (a date) first', () => {
    expect(sorted([{ n: 10 }, { n: 2 }], { key: 'n', label: 'N' }).map((r) => r.n)).toEqual([2, 10]);
    expect(sorted([{ on: true }, { on: false }], { key: 'on', label: 'On' }).map((r) => r.on)).toEqual([false, true]);
    const col = { key: 'when', label: 'When', sortValue: (r) => Date.parse(r.when) };
    expect(sorted([{ when: '2026-10-15' }, { when: '2026-01-02' }], col).map((r) => r.when)).toEqual([
      '2026-01-02',
      '2026-10-15',
    ]);
  });

  it('a sortValue that is a text sorts by that text, not by the cell (a repository used for nothing last)', () => {
    const t = (k) => k;
    const col = {
      key: 'usage',
      label: 'Usage',
      render: (v, row) => usageBadges(t, row),
      sortValue: (row) => usageSortValue(t, row),
    };
    // the cell's text, as the table reads it (BsDataTable cellText : the badges' text)
    const cell = (row) => col.render(undefined, row).replace(/<[^>]+>/g, '');
    const rows = [{ name: 'none' }, { name: 'forms', use_for_forms: 1 }, { name: 'creds', use_for_credentials: 1 }];
    const order = (dir) => [...rows].sort((a, b) => compareRows(a, b, col, dir, cell)).map((r) => r.name);
    expect(order(1)).toEqual(['creds', 'forms', 'none']);
    expect(order(-1)).toEqual(['none', 'forms', 'creds']);
  });
});

describe('an empty cell', () => {
  it('is an en dash ; anything else is kept', () => {
    expect(orEmpty('')).toBe(EMPTY_CELL);
    expect(orEmpty('  ')).toBe(EMPTY_CELL);
    expect(orEmpty(null)).toBe(EMPTY_CELL);
    expect(orEmpty('<b>x</b>')).toBe('<b>x</b>');
  });
});
