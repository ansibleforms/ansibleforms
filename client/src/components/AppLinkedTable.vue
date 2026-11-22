<script setup>
/******************************************************************/
/*                                                                */
/*  A read-only table of the items linked to a settings page's    */
/*  record : a user's stored jobs, a role's forms, a runner's     */
/*  jobs... A row opens its item when `to` gives it an address ;  */
/*  none linked, a short note says so.                            */
/*                                                                */
/*  columns: [{ key, label, value?(row), html?(row), class?,      */
/*    keep? }] - keep : never cut (a date, a status), the others  */
/*    give way                                                    */
/*    end : at the table's right edge (an access, a state), the   */
/*    room left before it rather than after the last column       */
/*    value - the cell's text (default row[key]) ; html - its     */
/*    html instead, escaped by the caller (a cron and its hover)  */
/*    a cell slot #cell-<key>="{ row }" draws a cell itself (a    */
/*    status pill)                                                */
/*  rows: the items ; rowKey: the field that keys a row (id)      */
/*  to: (row) => an address, or null for a row that opens nothing */
/*    (such a row has no hover, unless it ticks or unfolds)       */
/*  empty: the note shown with no rows                            */
/*  children: (row) => its rows, or null - a row that has some    */
/*    unfolds them under it with a caret (a multistep job's       */
/*    steps), right while folded and down once they show ;        */
/*  childrenBefore: the column the caret's own column goes before */
/*    (the form), as the jobs list's                              */
/*  The rows a page at a time, the pager under the table          */
/*  (AppTablePager : the page in the address). Its controls, as a */
/*  list's, on the page's title line (AppSettings' 'afToolbarTo') */
/*  : a filter on every column, the columns shown, the export to  */
/*  CSV (named after exportName, else none).                      */
/*  exportName: the CSV file's name                               */
/*  selectable : each row its checkbox, as a list's - Select all  */
/*  and Clear selection on the title line, the export then of the */
/*  rows ticked ; a slot #bulk-actions="{ selected, count }" adds */
/*  what the page does with them (Remove, Delete). None on a      */
/*  table nothing is done with : its filter decides the export.   */
/*  search: the page's own search (a page that searches all its   */
/*    tabs at once) : the rows filtered on it, and no filter box  */
/*    of the table's ; none (null) : the table's own box          */
/*  rowActions: [{ title, icon, danger?, enabledWhen?(row),       */
/*    run(row) }] - each row's menu (⋮), the same actions one row */
/*    at a time (Remove from role, Delete)                        */
/*                                                                */
/******************************************************************/
import { ref, computed, inject, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCellPopovers } from '@/composables/useCellPopovers';
import { csvCell, isSortable, compareRows } from '@/lib/dataTable';
import { cellText } from '@/lib/recordSearch';
import { EMPTY_CELL, orEmpty } from '@/lib/tableCells';
import BsSearch from './BsSearch.vue';
import BsColumnPicker from './BsColumnPicker.vue';

const props = defineProps({
  columns: { type: Array, required: true },
  rows: { type: Array, required: true },
  rowKey: { type: String, default: 'id' },
  to: { type: Function, default: null },
  empty: { type: String, default: '' },
  children: { type: Function, default: null },
  childrenBefore: { type: String, default: '' },
  exportName: { type: String, default: '' },
  selectable: { type: Boolean, default: false },
  rowActions: { type: Array, default: () => [] },
  search: { type: String, default: null },
});
const { t } = useI18n();

// ─── the controls : on the page's title line, as a list's ─────────────────────
const toolbarTo = inject('afToolbarTo', null);
// the filter : a row is kept when one of its cells has the text (case aside)
const filter = ref('');
// the columns the picker hid
const hidden = ref(new Set());
const shownColumns = computed(() => props.columns.filter((c) => !hidden.value.has(c.key)));
// the first column held at the right edge (end) : the room left goes before it ; none, after the last
const endFrom = computed(() => shownColumns.value.find((c) => c.end)?.key || null);
// a cell's plain text : its column's html() without the tags, its value(), or its field ; the
// record pages' search reads the same (lib/recordSearch.js), so a tab matches by what it shows
const plain = cellText;
// the order : a named column's header clicked sorts by it, A to Z, again Z to A (lib/dataTable.js)
const sortKey = ref(null);
const sortDir = ref(1);
/**
 * Sorts by a column : the same one again turns the order round.
 *
 * Args:
 *   col (object): the column whose header was clicked.
 */
function toggleSort(col) {
  if (!isSortable(col)) return;
  if (sortKey.value === col.key) sortDir.value = -sortDir.value;
  else {
    sortKey.value = col.key;
    sortDir.value = 1;
  }
}
const filteredRows = computed(() => {
  const q = (props.search ?? filter.value).trim().toLowerCase();
  const rows = q
    ? props.rows.filter((row) => props.columns.some((col) => plain(col, row).toLowerCase().includes(q)))
    : props.rows;
  const col = props.columns.find((c) => c.key === sortKey.value);
  return col ? [...rows].sort((a, b) => compareRows(a, b, col, sortDir.value, (r, c) => plain(c, r))) : rows;
});
/**
 * Shows or hides a column (the picker's tick).
 *
 * Args:
 *   key (string): the column's key.
 */
function toggleColumn(key) {
  const set = new Set(hidden.value);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  hidden.value = set;
}
/**
 * Hides the columns of a preset of the picker.
 *
 * Args:
 *   keys (string[]): the columns it hides.
 */
function applyPreset(keys) {
  hidden.value = new Set(keys);
}
// ─── the rows ticked (their key), as a list's ─────────────────────────────────
const selected = ref(new Set());
// rows gone (deleted, read again) : no longer ticked
watch(
  () => props.rows,
  (rows) => {
    const keys = new Set(rows.map((r) => r[props.rowKey]));
    const kept = new Set([...selected.value].filter((k) => keys.has(k)));
    if (kept.size !== selected.value.size) selected.value = kept;
  },
);
const selectedRows = computed(() => props.rows.filter((r) => selected.value.has(r[props.rowKey])));
const allShownTicked = computed(
  () => shownRows.value.length > 0 && shownRows.value.every((r) => selected.value.has(r[props.rowKey])),
);
/**
 * Ticks or unticks a row.
 *
 * Args:
 *   row (object): the item.
 */
function tick(row) {
  const set = new Set(selected.value);
  const key = row[props.rowKey];
  if (set.has(key)) set.delete(key);
  else set.add(key);
  selected.value = set;
}
/**
 * The header's box : ticks the rows of the page shown, or unticks them when they all are.
 */
function tickPage() {
  const set = new Set(selected.value);
  const keys = shownRows.value.map((r) => r[props.rowKey]);
  if (allShownTicked.value) keys.forEach((k) => set.delete(k));
  else keys.forEach((k) => set.add(k));
  selected.value = set;
}
/**
 * Select all : every row the filter keeps.
 */
function selectAll() {
  selected.value = new Set(filteredRows.value.map((r) => r[props.rowKey]));
}

/**
 * Saves the rows as a CSV file, the columns shown : those ticked, else those the filter keeps.
 */
function exportCsv() {
  const cols = shownColumns.value;
  const lines = [cols.map((c) => csvCell(c.label)).join(',')];
  const rows = selectedRows.value.length ? selectedRows.value : filteredRows.value;
  for (const row of rows) lines.push(cols.map((c) => csvCell(plain(c, row))).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${props.exportName || 'export'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

const router = useRouter();
// the rows of the page shown (AppTablePager) ; the first page's until it says
const pageRows = ref(null);
// the page searching (a word in its search) : several tables may be on it at once, each with its
// controls in its own frame and every row it keeps, no pager (they would share the title line and
// the page in the address)
const inline = computed(() => !!(props.search && props.search.trim()));
const shownRows = computed(() =>
  inline.value ? filteredRows.value : (pageRows.value ?? filteredRows.value.slice(0, 25)),
);
// the rows unfolded (their key) ; the rows drawn : each row of the page, its children under it
// when unfolded
const unfolded = ref(new Set());
const drawnRows = computed(() => {
  const out = [];
  for (const row of shownRows.value) {
    out.push({ row, child: false });
    if (props.children && unfolded.value.has(row[props.rowKey])) {
      for (const c of props.children(row) || []) out.push({ row: c, child: true });
    }
  }
  return out;
});

/**
 * Whether a row unfolds : it has children.
 *
 * Args:
 *   row (object): the item.
 *
 * Returns:
 *   boolean: true when it has some.
 */
function foldable(row) {
  return !!props.children && (props.children(row) || []).length > 0;
}

/**
 * Unfolds a row's children, or folds them back.
 *
 * Args:
 *   row (object): the item.
 */
function toggle(row) {
  const set = new Set(unfolded.value);
  const key = row[props.rowKey];
  if (set.has(key)) set.delete(key);
  else set.add(key);
  unfolded.value = set;
}

// a cell that has more to say (data-af-popover, a cron's meaning) : its text on hover
const { onCellHover } = useCellPopovers();

/**
 * The address a row opens, if any.
 *
 * Args:
 *   row (object): the item.
 *
 * Returns:
 *   string|object|null: the address, or null.
 */
function target(row) {
  return props.to ? props.to(row) : null;
}

/**
 * Opens a row's item.
 *
 * Args:
 *   row (object): the item.
 */
function open(row) {
  const to = target(row);
  if (to) router.push(to);
}

/**
 * A cell's text : its column's value(), or the field of its key ; an en dash for none.
 *
 * Args:
 *   col (object): the column.
 *   row (object): the item.
 *
 * Returns:
 *   string: the text.
 */
function text(col, row) {
  const v = col.value ? col.value(row) : row[col.key];
  return v === null || v === undefined || String(v).trim() === '' ? EMPTY_CELL : String(v);
}
</script>
<template>
  <!-- the controls, on the title line : the filter at its left, the columns and the export ; while
       the page searches, over the table in its own frame (inline) -->
  <Teleport v-if="toolbarTo" defer :to="toolbarTo" :disabled="inline">
    <div
      class="d-flex align-items-center gap-2 flex-wrap"
      :class="inline ? 'af-linked-inline mb-2' : 'bs-dt-toolbar-moved'"
    >
      <BsSearch v-if="search === null" v-model="filter" class="af-table-search" />
      <!-- the selection : how many, Clear selection, Select all, and what the page does with them -->
      <span v-if="selectable && selected.size" class="text-muted small">{{
        t('dataTable.selected', selected.size)
      }}</span>
      <button v-if="selectable && selected.size" class="btn btn-outline-primary" @click="selected = new Set()">
        <FaIcon icon="xmark" class="me-1" />{{ t('dataTable.clearSelection') }}
      </button>
      <button
        v-if="selectable && selected.size < filteredRows.length"
        class="btn btn-outline-primary"
        @click="selectAll"
      >
        <FaIcon icon="check-double" class="me-1" />{{ t('dataTable.selectAll', { count: filteredRows.length }) }}
      </button>
      <slot v-if="selectable" name="bulk-actions" :selected="selectedRows" :count="selected.size" />
      <div class="ms-auto d-flex align-items-center gap-2">
        <BsColumnPicker
          :columns="columns"
          :hidden="hidden"
          buttonClass="btn-outline-primary"
          @toggle="toggleColumn"
          @apply="applyPreset"
        />
        <button v-if="exportName" class="btn btn-outline-primary" @click="exportCsv">
          <FaIcon icon="file-csv" class="me-1" />{{ t('dataTable.export') }}
        </button>
      </div>
    </div>
  </Teleport>
  <!-- always a table, as every list : none linked, its note in it -->
  <div class="af-table-frame">
    <table v-fit-columns class="table af-table" @mouseover="onCellHover">
      <thead>
        <tr>
          <!-- the page's rows ticked at once -->
          <th v-if="selectable" class="text-center bs-dt-select">
            <input
              type="checkbox"
              class="form-check-input"
              :checked="allShownTicked"
              :indeterminate="selected.size > 0 && !allShownTicked"
              @change="tickPage"
            />
          </th>
          <template v-for="col in shownColumns" :key="col.key">
            <!-- the caret's own column, before its column (a job's form) -->
            <th v-if="children && col.key === childrenBefore" class="af-expand-col"></th>
            <!-- the room left, before the columns held at the right edge (end) -->
            <th v-if="col.key === endFrom" class="af-fit-spacer"></th>
            <th
              :class="[col.class, { 'bs-dt-sortable': isSortable(col) }]"
              :data-fit-keep="col.keep ? '' : null"
              :role="isSortable(col) ? 'button' : null"
              @click="toggleSort(col)"
            >
              {{ col.label }}
              <!-- its order : the arrow of the one sorted by, the pair greyed on the others -->
              <span v-if="isSortable(col)" class="text-muted ms-1 af-sort-icon">
                <FaIcon v-if="sortKey === col.key" :icon="sortDir === 1 ? 'sort-up' : 'sort-down'" /><FaIcon
                  v-else
                  icon="sort"
                  class="opacity-25"
                />
              </span>
            </th>
          </template>
          <!-- the room left, after the last column (v-fit-columns) ; before the end ones, if any -->
          <th v-if="!endFrom" class="af-fit-spacer"></th>
          <th v-if="rowActions.length" class="af-row-menu-col"></th>
        </tr>
      </thead>
      <tbody>
        <!-- a row, and under it its children when unfolded (a step's first cell marked, as the
             jobs list's) -->
        <tr
          v-for="{ row, child } in drawnRows"
          :key="(child ? 'c/' : '') + row[rowKey]"
          :role="target(row) ? 'button' : null"
          :class="{
            'bs-dt-selected': !child && selected.has(row[rowKey]),
            'af-row-static': !target(row) && !selectable && !foldable(row),
          }"
          @click="open(row)"
        >
          <!-- its box (a step under a job has none : the job is ticked) -->
          <td v-if="selectable" class="text-center bs-dt-select" @click.stop>
            <input
              v-if="!child"
              type="checkbox"
              class="form-check-input"
              :checked="selected.has(row[rowKey])"
              @change="tick(row)"
            />
          </td>
          <template v-for="(col, i) in shownColumns" :key="col.key">
            <td v-if="col.key === endFrom" class="af-fit-spacer"></td>
            <!-- the caret : its cell unfolds the row (the rest of the row opens it) -->
            <td
              v-if="children && col.key === childrenBefore"
              class="af-expand-col text-center"
              :role="!child && foldable(row) ? 'button' : null"
              @click.stop="!child && foldable(row) ? toggle(row) : open(row)"
            >
              <FaIcon
                v-if="!child && foldable(row)"
                :icon="unfolded.has(row[rowKey]) ? 'angle-down' : 'angle-right'"
                :fixedwidth="true"
              />
            </td>
            <!-- the first cell names the item : a link's colour when the row opens it -->
            <td :class="[col.class, { 'af-row-open': i === 0 && target(row), 'af-child-row': i === 0 && child }]">
              <slot :name="`cell-${col.key}`" :row="row">
                <!-- eslint-disable-next-line vue/no-v-html -- html() is escaped by its column -->
                <span v-if="col.html" v-html="orEmpty(col.html(row))"></span>
                <template v-else>{{ text(col, row) }}</template>
              </slot>
            </td>
          </template>
          <td v-if="!endFrom" class="af-fit-spacer"></td>
          <!-- its menu : the actions of the rows ticked, for this one (none under a job's step) -->
          <td v-if="rowActions.length" class="bs-dt-row-actions" @click.stop>
            <div v-if="!child" class="dropdown">
              <button
                type="button"
                class="bs-dt-row-menu px-2"
                data-bs-toggle="dropdown"
                data-bs-popper-config='{"strategy":"fixed"}'
                :aria-label="t('common.actions')"
              >
                <FaIcon icon="ellipsis-vertical" />
              </button>
              <ul class="dropdown-menu dropdown-menu-end">
                <li v-for="action in rowActions" :key="action.title">
                  <a
                    class="dropdown-item"
                    :class="
                      action.enabledWhen && !action.enabledWhen(row)
                        ? 'disabled text-muted'
                        : action.danger
                          ? 'text-danger'
                          : ''
                    "
                    href="#"
                    @click.prevent="(!action.enabledWhen || action.enabledWhen(row)) && action.run(row)"
                  >
                    <FaIcon :icon="action.icon" class="me-2" />{{ action.title }}
                  </a>
                </li>
              </ul>
            </div>
          </td>
        </tr>
        <!-- none : the page's note (no job yet...), or none the filter keeps -->
        <tr v-if="!drawnRows.length">
          <td
            :colspan="shownColumns.length + (children ? 2 : 1) + (selectable ? 1 : 0) + (rowActions.length ? 1 : 0)"
            class="text-center text-muted py-3"
          >
            {{ rows.length ? t('common.noData') : empty || t('common.noData') }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- the rows shown, the page size and the pages, under the table as a list's -->
  <AppTablePager v-if="!inline" :items="filteredRows" @change="(r) => (pageRows = r)" />
</template>
<style scoped>
/* a row that opens nothing (no address, no box, no steps) : no hover, a grey hover says a click
   does something */
.af-table tbody tr.af-row-static:hover > td {
  background: none;
}
/* a header that sorts : the pointer, and its arrows small as every list's */
.bs-dt-sortable {
  cursor: pointer;
  user-select: none;
}
.af-sort-icon {
  font-size: 0.7em;
}
</style>
