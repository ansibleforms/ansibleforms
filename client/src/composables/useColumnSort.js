/******************************************************************/
/*                                                                */
/*  A table of a form's enum field (a dropdown table, a left-     */
/*  right selector) sorted by clicking a column's header : a      */
/*  first click sorts it A to Z (0 to 9), a second Z to A, a      */
/*  third goes back to the order the values came in (the          */
/*  expression's, the query's). Numbers sort as numbers, text as  */
/*  people read it (kvm-9 before kvm-10), empty cells always      */
/*  last.                                                         */
/*                                                                */
/*  Display only : each row keeps its index in the values, which  */
/*  the selection, the check all and the value sent go by. The    */
/*  rows are filtered first (the search box), then sorted.        */
/*                                                                */
/******************************************************************/
import { ref, computed, unref } from 'vue';

/**
 * Whether a cell is empty : nothing, null or an empty text.
 *
 * Args:
 *   x (any): the cell.
 *
 * Returns:
 *   boolean: true when it is.
 */
const isEmpty = (x) => x === undefined || x === null || (typeof x === 'string' && x.trim() === '');

/**
 * Compares two cells, A to Z : two numbers (or texts that are numbers) as numbers, else as text
 * with its numbers in it read as numbers (kvm-9 before kvm-10), regardless of case and accents.
 * Empty cells are not compared here (sortRows puts them last).
 *
 * Args:
 *   a (any): a cell.
 *   b (any): another.
 *
 * Returns:
 *   number: below 0 when a comes first, above 0 when b does, 0 when alike.
 */
export function compareCells(a, b) {
  const na = typeof a === 'number' ? a : Number(String(a).trim());
  const nb = typeof b === 'number' ? b : Number(String(b).trim());
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const text = (x) => (typeof x === 'object' ? JSON.stringify(x) : String(x));
  return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The rows sorted by a column : its cells compared (compareCells), A to Z or Z to A, the empty
 * ones last either way ; rows alike keep the order they came in.
 *
 * Args:
 *   rows (object[]): the rows, each { index, value } (its place in the values, its object).
 *   column (string): the column ('' : the order they came in).
 *   dir (number): 1 A to Z, -1 Z to A, 0 the order they came in.
 *
 * Returns:
 *   object[]: a new list, the rows themselves unchanged.
 */
export function sortRows(rows, column, dir) {
  if (!column || !dir) return rows;
  const cell = (row) => (row.value && typeof row.value === 'object' ? row.value[column] : undefined);
  return [...rows].sort((x, y) => {
    const a = cell(x);
    const b = cell(y);
    const emptyA = isEmpty(a);
    const emptyB = isEmpty(b);
    if (emptyA || emptyB) return emptyA === emptyB ? x.index - y.index : emptyA ? 1 : -1;
    return compareCells(a, b) * dir || x.index - y.index;
  });
}

/**
 * A table's sort by its headers.
 *
 * Args:
 *   rows (Ref|ComputedRef): the rows as shown before sorting (filtered), each { index, value }.
 *   sortable (function): whether the headers sort (the field's sortable, true by default).
 *
 * Returns:
 *   object: { sortColumn, sortDir, toggleSort, sortIcon, sorted } :
 *     sortColumn, sortDir: the column sorted by and its direction (1, -1 ; '' and 0 : none) ;
 *     toggleSort(column): a header clicked : A to Z, Z to A, then the order they came in ;
 *     sortIcon(column): the arrow its header shows (sort-up, sort-down), '' for none ;
 *     sorted: the rows sorted.
 */
export function useColumnSort(rows, sortable = () => true) {
  const sortColumn = ref('');
  const sortDir = ref(0);

  function toggleSort(column) {
    if (!sortable()) return;
    if (sortColumn.value !== column) {
      sortColumn.value = column;
      sortDir.value = 1;
    } else if (sortDir.value === 1) {
      sortDir.value = -1;
    } else {
      sortColumn.value = '';
      sortDir.value = 0;
    }
  }

  const sortIcon = (column) =>
    sortColumn.value === column && sortDir.value ? (sortDir.value === 1 ? 'sort-up' : 'sort-down') : '';

  const sorted = computed(() => (sortable() ? sortRows(unref(rows), sortColumn.value, sortDir.value) : unref(rows)));

  return { sortColumn, sortDir, toggleSort, sortIcon, sorted };
}

export default useColumnSort;
