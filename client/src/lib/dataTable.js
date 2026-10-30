// Pure helpers of BsDataTable, here so they can be tested without mounting it.

// Numeric column filter : ">50", "<=20", "=0", "36", "10-50" (comma decimals ok).
// Returns a predicate, or null when the input is not a numeric expression - the caller
// then falls back to the plain "contains" text filter.
export function parseNumberFilter(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/,/g, '.')
    .replace(/\s+/g, '');
  if (!s) return null;
  const range = s.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/);
  if (range) {
    const a = Number(range[1]),
      b = Number(range[2]);
    const lo = Math.min(a, b),
      hi = Math.max(a, b);
    return (v) => v >= lo && v <= hi;
  }
  // a bare number means "equals" ("36,00" is 36)
  const op = s.match(/^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/);
  if (!op) return null;
  const n = Number(op[2]);
  return {
    '>': (v) => v > n,
    '>=': (v) => v >= n,
    '<': (v) => v < n,
    '<=': (v) => v <= n,
    '=': (v) => Math.abs(v - n) < 0.005,
  }[op[1] || '='];
}

// The plain text of render() HTML, for filtering, sorting, tooltips and export. A tag-stripping
// regex is not enough : "<scr<script>ipt>" leaves "<script>" behind. DOMParser builds an inert
// document - no script runs, no image loads - and textContent is text, never markup, so callers
// must keep using it as text (a binding or a CSV cell, never v-html).
export function htmlToText(html) {
  const s = String(html ?? '');
  if (!/[<&]/.test(s)) return s;
  return new DOMParser().parseFromString(s, 'text/html').body.textContent || '';
}

const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
export function csvCell(text) {
  let v = String(text ?? '').replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => HTML_ENTITIES[m]);
  // a cell starting with = + - @ would run as a formula in Excel : keep it text. A plain
  // negative number is not a formula and stays a number.
  if (/^[=+\-@\t\r]/.test(v) && !/^-\d+([.,]\d+)?$/.test(v)) v = "'" + v;
  return /[",;\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/**
 * Whether a column sorts : every column with a name does (a click on its header : A to Z, then Z
 * to A) ; one without (a caret's, a checkbox's, a row menu's) does not.
 *
 * Args:
 *   col (object): the column ({ key, label, ... }).
 *
 * Returns:
 *   boolean: true when its header sorts the rows.
 */
export function isSortable(col) {
  return !!col && String(col.label ?? '').trim() !== '';
}

/**
 * Two rows in a column's order : by its sortValue(row) when it has one (a date), else by its raw
 * value when both are numbers or yes / no, else by their text, alphabetically - case aside, and
 * "file2" before "file10".
 *
 * Args:
 *   a (object): a row.
 *   b (object): another row.
 *   col (object): the column sorted by.
 *   dir (number): 1 ascending (A to Z), -1 descending.
 *   textOf (Function): (row, col) => the cell's text.
 *
 * Returns:
 *   number: negative when a comes first, positive when b does, 0 when equal.
 */
export function compareRows(a, b, col, dir, textOf) {
  const raw = (row) => (col.sortValue ? col.sortValue(row) : row[col.key]);
  let ra = raw(a);
  let rb = raw(b);
  if (typeof ra === 'boolean') ra = Number(ra);
  if (typeof rb === 'boolean') rb = Number(rb);
  if (typeof ra === 'number' && typeof rb === 'number') return (ra - rb) * dir;
  const ta = String(textOf(a, col) ?? '');
  const tb = String(textOf(b, col) ?? '');
  return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' }) * dir;
}
