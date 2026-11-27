<script setup>
/******************************************************************/
/*                                                                */
/*  Bootstrap Input Select Advanced Table component               */
/*                                                                */
/*  This component is a table based select component.             */
/*  It allows to select multiple items from a table.              */
/*  It is used standalone or as dropdown in advanded select       */
/*  It allows to filter as well and can show percentage           */
/*                                                                */
/*  @props:                                                       */
/*      values: Array                                             */
/*      modelValue: Object|Array|String                           */
/*      multiple: Boolean                                         */
/*      required: Boolean                                         */
/*      name: String                                              */
/*      defaultValue: String|Array|Object                         */
/*      status: String                                            */
/*      sizeClass: String                                         */
/*      columns: Array                                            */
/*      previewColumn: String                                     */
/*      valueColumn: String                                       */
/*      pctColumns: Array                                         */
/*      filterColumns: Array                                      */
/*      focus: String                                             */
/*      sortable: Boolean - a click on a column's header sorts the */
/*                rows (A to Z, Z to A, then as they came) ;      */
/*                true by default (composables/useColumnSort.js)  */
/*                                                                */
/******************************************************************/

import { useTemplateRef, computed, toRaw } from 'vue';
import Helpers from '@/lib/Helpers';
import { useI18n } from 'vue-i18n';
import { useColumnSort } from '@/composables/useColumnSort';

// INIT

const { t } = useI18n();

const emit = defineEmits(['update:modelValue', 'update:preview', 'isSelected', 'focusset', 'reset']);
const queryfilterRef = useTemplateRef('queryfilterRef');

// DATA

const selected = ref({});
const labels = ref([]);
const valueLabel = ref('');
const previewLabel = ref('');
const preview = ref('');
const queryfilter = ref('');
// Plain variable, not a ref: this only needs to survive across recalc() calls within
// this component instance, and must never itself be reactive (it's read/written inside
// the same synchronous function, not rendered).
let lastEmittedJson = undefined;

// PROPS

const props = defineProps({
  values: {
    type: Array,
    required: true,
  },
  modelValue: {
    type: [Object, Array, String],
    default: () => {},
  },
  multiple: { type: Boolean, default: false },
  required: { type: Boolean },
  name: { type: String, required: true },
  defaultValue: { type: [String, Array, Object, Number] },
  // The field's actual restored value - relaunch / load-from-store set it directly on
  // the form model, bypassing the click-a-row interaction that normally feeds `selected`,
  // so nothing here ever learned about it. Matched the same way defaultValue is, but
  // only when defaultValue itself didn't already pick something.
  initialValue: { type: [String, Array, Object, Number] },
  status: { type: String },
  sizeClass: { type: String },
  columns: { type: Array, default: () => [] },
  previewColumn: { type: String },
  valueColumn: { type: String },
  pctColumns: { type: Array, default: () => [] },
  filterColumns: { type: Array, default: () => [] },
  focus: { type: String },
  disabled: { type: Boolean, default: false },
  // a click on a column's header sorts the rows ; false keeps the order they came in
  sortable: { type: Boolean, default: true },
});

// COMPUTED

const selectedItems = computed(() => {
  return props.values.filter((v, i) => selected.value[i]);
});
const checkAll = computed(() => {
  var all = true;
  var BreakException = {};
  try {
    for (let i = 0; i < filtered.value.length; i++) {
      if (!selected.value[filtered.value[i].index]) {
        all = false;
      }
    }
  } catch (e) {
    if (e !== BreakException) throw e;
  }
  return all;
});
const filtered = computed(() => {
  var cols = [];
  // if filtercolumns, use them
  if (props.filterColumns.length > 0) {
    cols = props.filterColumns;
  } else {
    // if not, take the previewLabel
    if (previewLabel.value) {
      cols.push(previewLabel.value);
    }
  }
  return props.values.reduce(function (filtered, item, i) {
    var found = false;
    if (queryfilter.value) {
      // if the item exists
      if (item) {
        // console.log(item);
        // go over all filterColumns
        if (cols.length > 0) {
          for (const col of cols) {
            // if the column is present

            if (item[col]) {
              // check if the value contains our filter
              found ||= item[col].toString().toLowerCase().includes(queryfilter.value.toLowerCase());
            } else {
              // no item, always pass
              found = true;
            }
          }
        } else {
          // normal array
          found = item.toString().toLowerCase().includes(queryfilter.value.toLowerCase());
        }
      }
    } else {
      found = true;
    }
    if (found) {
      filtered.push({ index: i, value: item });
    }
    return filtered;
  }, []);
});

// the rows as shown : filtered (the search box), then sorted by a header clicked ; each keeps its
// index in the values, which the selection goes by
const { toggleSort, sortIcon, sorted } = useColumnSort(filtered, () => props.sortable);

// WATCHERS

watch(
  () => props.values,
  (_val) => {
    queryfilter.value = '';
    selected.value = {};
    getLabels();
    emit('reset');
    // recalc() is what emits update:modelValue. getLabels() wraps its whole body in
    // `if (props.values.length > 0)`, so when the list went from N rows to ZERO nothing
    // was emitted: the dropdown showed "No data" and an empty box while form[name] still
    // held the previously selected row, and that stale value was submitted as an
    // extravar. emit("reset") only clears the visible text. The sibling component
    // (BsInputSelectAdvancedTable2) has always called recalc() here.
    recalc();
  },
  { deep: true },
);

// initialValue can arrive after values already settled (e.g. a slower relaunch/store
// fetch) - re-derive the selection then too, but only while nothing is picked yet so
// this never overrides a real user click.
watch(
  () => props.initialValue,
  (_val) => {
    if (selectedItems.value.length === 0) getLabels();
  },
);

// Forget our "already told the parent" memory only when the parent's own value is
// OBSERVED to have actually changed to something other than what we last sent - i.e. an
// external reset (elsewhere in the dependency chain) blanked the parent's displayed
// value without going through our own emit. The next recalc() will then see a mismatch
// against the (now cleared) memory and re-emit, re-syncing the parent's preview text.
// Firing right after our OWN emit is harmless: by then props.modelValue matches
// lastEmittedJson exactly, so this is a no-op in that case.
watch(
  () => props.modelValue,
  (val) => {
    const incomingJson = JSON.stringify(toRaw(val?.values));
    if (incomingJson !== lastEmittedJson) {
      lastEmittedJson = undefined;
    }
  },
);

watch(
  () => props.focus,
  (val) => {
    if (val == 'content') {
      nextTick(() => {
        queryfilterRef.value.focus({ preventScroll: true });
        emit('focusset');
      });
    }
  },
);

// METHODS

function objectEqual(object1, object2) {
  // Unwrap Vue proxies to plain objects for comparison
  const obj1 = toRaw(object1);
  const obj2 = toRaw(object2);

  // valueColumn is the form author declaring WHICH column identifies a row, so match on
  // it rather than on the whole object. A value being restored (relaunch / load from
  // store) was serialised when the job ran and is compared against rows fetched again
  // now: JSON.stringify equality also requires the same key ORDER and the exact same set
  // of columns, so one extra column in the query - or a differently ordered row - left
  // the stored row matching nothing, and the select then reported "no selection" and
  // wiped the restored value. Without a valueColumn the strict comparison stands.
  const col = props.valueColumn;
  if (col && obj1 && obj2 && typeof obj1 === 'object' && typeof obj2 === 'object' && col in obj1 && col in obj2) {
    return obj1[col] === obj2[col];
  }

  // Deep equality check using JSON comparison
  // This handles nested objects properly
  return JSON.stringify(obj1) === JSON.stringify(obj2);
}

function highlightFilter(v, label = undefined) {
  var s = (v ?? '') + '';
  var cols = [];
  if (props.filterColumns.length > 0) {
    cols = props.filterColumns;
  } else {
    if (previewLabel.value) {
      cols.push(previewLabel.value);
    }
  }
  if (label && !cols.includes(label)) {
    return Helpers.htmlEncode(s);
  }
  var index;
  var search = queryfilter.value;
  var l = search.length;
  var p1, p2, p3;
  if (s && queryfilter.value) {
    index = s.toLowerCase().indexOf(search.toLowerCase());
    if (index >= 0) {
      p1 = s.slice(0, index);
      p2 = s.slice(index, index + l);
      p3 = s.slice(index + l);
      return `${Helpers.htmlEncode(p1)}<span class='fw-bold'>${Helpers.htmlEncode(p2)}</span>${Helpers.htmlEncode(p3)}`;
    } else {
      return Helpers.htmlEncode(s);
    }
  } else {
    // htmlEncode(s), not the raw v. This branch is taken whenever the search box is
    // EMPTY - i.e. the moment the dropdown opens - and its result goes to v-html, so an
    // option value coming from a datasource/query row (a CMDB description, a hostname)
    // executed in the browser of every user who opened the form. Every sibling branch
    // above already encodes; this one was the hole. `s` is just String(v).
    return Helpers.htmlEncode(s);
  }
}
function isPctColumn(label) {
  return props.pctColumns.includes(label);
}
function getProgressHtml(value) {
  var rounded;
  // isNaN("") and isNaN(null) are both FALSE (both coerce to 0), so an empty percentage
  // cell took the progress-bar branch and Math.round(parseInt("")) is NaN - the row
  // rendered an empty grey track with `width: NaN%`. Require an actual number.
  if (value !== null && value !== undefined && String(value).trim() !== '' && !isNaN(value)) {
    rounded = Math.round(parseInt(value));
    if (rounded < 0) rounded = 0;
    if (rounded > 100) rounded = 100;
    return `<div class="progress" role="progressbar" aria-label="Basic example" aria-valuenow="${rounded}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width: ${rounded}%"></div></div>`;
  } else {
    return Helpers.htmlEncode((value ?? '') + '');
  }
}
/**
 * @param fromUser false when this is a DEFAULT being applied, not a click.
 *
 * "isSelected" makes the parent close the dropdown and focus its input. select() is
 * also called non-interactively from getLabels() to apply a default, and getLabels()
 * re-runs from the props.values watcher every time the backing query resolves - so a
 * query landing while the user was typing in another field pulled the caret out of it
 * and the following keystrokes went into the readonly select input instead. Only a
 * real click should move focus.
 */
function select(i, fromUser = true) {
  if (props.multiple) {
    selected.value[i] = !selected.value[i];
  } else {
    var temp = !selected.value[i]; // if single just clear and invert selection
    selected.value = [];
    selected.value[i] = temp;
    if (fromUser) emit('isSelected');
  }
  recalc();
}
function recalc() {
  var l = selectedItems.value.length;
  var first = selectedItems.value.slice(0, 3);
  if (l > 0) {
    if (l > 3) {
      preview.value =
        first
          .map((i) => {
            return i ? (i[previewLabel.value] ?? i) : 'undefined';
          })
          .join(', ') +
        ', ... (' +
        l +
        ' items selected)';
    } else {
      preview.value = first
        .map((i) => {
          return i ? (i[previewLabel.value] ?? i) : 'undefined';
        })
        .join(', ');
    }
  } else {
    preview.value = '';
  }
  const newValues = props.multiple
    ? l > 0
      ? selectedItems.value
      : undefined
    : l > 0
      ? selectedItems.value[0]
      : undefined;
  // getLabels() re-runs (and calls select()) every time this field's OWN options
  // reload, which happens constantly in a chain of dependent fields - re-confirming a
  // selection that hasn't actually changed still emitted update:modelValue every time.
  // The form's @update:modelValue handler treats any emission as a real user change and
  // cascades an unprotected reset through every dependent field, which reloads their
  // options, which re-confirms their own unchanged selection, which emits again - an
  // infinite reset storm on any form with more than a couple of chained fields. Skip the
  // emit when it matches our own memory of what we last sent (lastEmittedJson).
  //
  // Comparing against props.modelValue directly here (instead of just lastEmittedJson)
  // was tried and reverted: a parent prop update lands on the NEXT tick, not
  // synchronously, so it's stale on essentially every call, not just rarely - that made
  // this skip almost nothing and reopened the storm. The watcher below handles the case
  // that comparison was for (the parent's displayed value getting cleared by something
  // else in between) without re-introducing the staleness race: it invalidates
  // lastEmittedJson only when props.modelValue is OBSERVED to have changed to something
  // other than what we last sent - i.e. only on a real external change, not every tick.
  // The label the parent displays travels on its own channel, because it has to be re-sent
  // in a case where the VALUE must not be: reloading the options makes us emit "reset",
  // which blanks the parent's preview, and then re-select the very same row - so the value
  // emit below is correctly skipped, and without this the parent would keep showing an
  // empty box over a field that is in fact still selected.
  emit('update:preview', preview.value);

  const newValuesJson = JSON.stringify(toRaw(newValues));
  if (newValuesJson === lastEmittedJson) {
    return;
  }
  lastEmittedJson = newValuesJson;
  emit('update:modelValue', { values: newValues, preview: preview.value });
}
function multicheck() {
  if (!checkAll.value) {
    for (let i = 0; i < filtered.value.length; i++) {
      selected.value[filtered.value[i].index] = true;
    }
  } else {
    for (let i = 0; i < filtered.value.length; i++) {
      selected.value[filtered.value[i].index] = false;
    }
  }
  recalc();
}
function reset() {
  for (let i = 0; i < filtered.value.length; i++) {
    selected.value[filtered.value[i].index] = false;
  }
}
function getLabels() {
  var previewLabels = [];
  var valueLabels = [];
  preview.value = '';
  previewLabel.value = '';
  valueLabel.value = '';
  if (props.values.length > 0) {
    // `props.values[0] &&` : typeof null is "object", so a null first entry fell into
    // the else and Object.keys(null) threw - the exception escaped the values watcher
    // and the select rendered with no labels and no rows at all. A null entry is a real
    // possibility (`values: [~, a, b]` in the form yaml, or a jq/expression result with
    // a null), which is why the rest of this file guards every other access.
    if (!props.values[0] || typeof props.values[0] !== 'object') {
      labels.value = [];
    } else {
      // get all labels
      labels.value = Object.keys(props.values[0]);

      // filter preview label
      previewLabels = labels.value.filter((item) => item == props.previewColumn);
      valueLabels = labels.value.filter((item) => item == props.valueColumn);
    }
    // reduct labels to the ones we want to show
    if (props.columns.length > 0) {
      // limit labels to provided columnslist
      labels.value = props.columns.filter((item) => labels.value.includes(item));
    }
    // if we found a preview label, use it
    if (previewLabels.length > 0) {
      // if we have a specific value column
      previewLabel.value = previewLabels[0]; // set it
    } else if (labels.value.length > 0) {
      // if we didn't find a preview label, use the first visible label
      previewLabel.value = labels.value[0];
    }
    // if we found a value label, use it
    if (valueLabels.length > 0) {
      // if we have a specific value column
      valueLabel.value = valueLabels[0]; // set it
    } else {
      if (labels.value.length > 0) valueLabel.value = labels.value[0];
    }
    // defaultValue wins when the form author set one; "__none__"/unset falls back to
    // initialValue (the restored value) so a relaunch/load-from-store prefill still
    // shows as selected even though it never went through select().
    const effectiveValue =
      props.defaultValue !== undefined && props.defaultValue !== '__none__' ? props.defaultValue : props.initialValue;
    if (props.defaultValue == '__auto__' && props.values.length > 0) {
      select(0, false); // if __auto__ select the first
    } else if (props.defaultValue == '__all__' && props.multiple) {
      // if all is set, we select all
      for (let i = 0; i < props.values.length; i++) {
        select(i, false);
      }
    } else if (effectiveValue !== undefined) {
      // if a regular default is set, we select it
      var obj;
      var defaulttype;
      try {
        obj = JSON.parse(effectiveValue);
        if (typeof obj == 'object') {
          defaulttype = 'object';
        }
      } catch (err) {
        obj = undefined;
      }

      if (props.multiple && !Array.isArray(effectiveValue || [])) {
        console.log("You can't set a default value for a multiple select that is not an array");
        return;
      }
      if (!props.multiple && Array.isArray(effectiveValue || '')) {
        console.log("You can't set a default value for a non multiple select that is an array");
        // this.$toast.error("You can't set a default value for a non multiple select that is an array")
        return;
      }

      if (typeof effectiveValue == 'object') {
        obj = effectiveValue;
        defaulttype = 'object';
      }
      if (defaulttype == 'object' && !Array.isArray(effectiveValue)) {
        // enum is of type object, we compare objects
        if (obj) {
          // loop all values
          for (let i = 0; i < props.values.length; i++) {
            if (objectEqual(obj, props.values[i])) {
              select(i, false);
            }
          }
        }
      } else if (
        props.multiple &&
        Array.isArray(effectiveValue) &&
        effectiveValue.length > 0 &&
        typeof effectiveValue[0] == 'object'
      ) {
        // multiple enum of type object // compare objects
        for (var i = 0; i < props.values.length; i++) {
          for (var j = 0; j < effectiveValue.length; j++) {
            if (objectEqual(props.values[i], effectiveValue[j])) {
              select(i, false);
            }
          }
        }
      } else {
        // we search for the value by string
        for (let i = 0; i < props.values.length; i++) {
          if (props.values[i] && effectiveValue == (props.values[i][valueLabel.value] || props.values[i])) {
            select(i, false);
          } else if (props.multiple && Array.isArray(effectiveValue) && effectiveValue.length > 0) {
            if (
              props.values[i] &&
              effectiveValue.includes(props.values[i][valueLabel.value] || props.values[i] || false)
            ) {
              select(i, false);
            }
          }
        }
      }
    } else {
      recalc();
    }
  }
}

// WATCHERS

// HOOKS

onMounted(() => {
  reset();
  getLabels();
});

// ON SHOW
</script>
<template>
  <!-- a margin above the search, none under the table : its last row and its scrollbar end on the
       dropdown's (the box's) edge -->
  <div class="mt-2">
    <div class="px-3 pb-2">
      <div class="input-group">
        <span class="input-group-text text-gray-500">
          <FaIcon icon="search" />
        </span>
        <input
          class="form-control"
          tabindex="0"
          ref="queryfilterRef"
          type="text"
          placeholder=""
          v-model="queryfilter"
        />
      </div>
    </div>
    <div class="table-container">
      <table class="table table-hover mb-0">
        <thead v-if="labels.length > 1">
          <tr :class="sizeClass">
            <th v-if="multiple" class="is-first">
              <font-awesome-icon
                v-show="checkAll"
                @click="disabled ? null : multicheck()"
                :icon="['far', 'check-square']"
              />
              <font-awesome-icon v-show="!checkAll" @click="disabled ? null : multicheck()" :icon="['far', 'square']" />
            </th>
            <th
              :key="l"
              v-for="l in labels"
              class="af-th-cell"
              :class="{ 'af-sortable': sortable }"
              @click.stop="toggleSort(l)"
            >
              <!-- its text cut first (…), its arrow always shown -->
              <span class="af-th">
                <span class="af-th-text">{{ l }}</span>
                <span v-if="sortable" class="af-th-sort ms-1">
                  <font-awesome-icon v-if="sortIcon(l)" :icon="sortIcon(l)" />
                  <font-awesome-icon v-else icon="sort" class="af-th-sort-idle" />
                </span>
              </span>
            </th>
          </tr>
        </thead>
        <thead v-if="labels.length <= 1 && multiple">
          <tr :class="sizeClass">
            <th v-if="multiple" class="is-first">
              <font-awesome-icon
                v-show="checkAll"
                @click="disabled ? null : multicheck()"
                :icon="['far', 'check-square']"
              />
              <font-awesome-icon v-show="!checkAll" @click="disabled ? null : multicheck()" :icon="['far', 'square']" />
            </th>
            <th>{{ t('common.name') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            :class="{
              'table-primary': selected[v.index],
              sizeClass: sizeClass,
            }"
            :key="v.index"
            v-for="(v, i) in sorted"
            @click="disabled ? null : select(v.index)"
          >
            <td v-if="multiple" class="is-first">
              <font-awesome-icon v-show="selected[v.index]" :icon="['far', 'check-square']" />
              <font-awesome-icon v-show="!selected[v.index]" :icon="['far', 'square']" />
              <small class="ms-1 text-body-tertiary user-select-none">{{ v.index }}</small>
            </td>
            <template v-for="(l, i) in labels">
              <td v-if="isPctColumn(l)" :key="l + i" class="af-td-bar" v-html="getProgressHtml(v.value[l])"></td>
              <td v-else v-html="highlightFilter(v.value[l], l)" :key="l"></td>
            </template>
            <td v-if="labels.length == 0" v-html="highlightFilter(v.value)" :class="{ 'border-top': i === 0 }"></td>
          </tr>
        </tbody>
      </table>
    </div>
    <!-- nothing to show : said under the header and its line, where the rows would be, in line with
         the cells' text -->
    <p v-if="values.length == 0" class="px-2 py-2 mb-0">{{ t('common.noData') }}</p>
    <p v-if="values.length > 0 && filtered.length == 0" class="px-2 py-2 mb-0">{{ t('common.noFilterMatch') }}</p>
  </div>
</template>
<style scoped>
/* a header that sorts : the hand over all of it, its arrow too ; its text not selected by the
   clicks. Its click stops there (.stop) : its arrow is replaced as it sorts, so the dropdown's
   click-outside would find the clicked element gone, outside the table, and close it */
th.af-sortable,
th.af-sortable * {
  cursor: pointer;
  user-select: none;
}
/* a header's text and its arrow on one line : the text cut (…) when the column is narrow, the
   arrow never */
.af-th {
  display: flex;
  align-items: baseline;
  min-width: 0;
}
.af-th-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.af-th-sort {
  flex-shrink: 0;
}
/* the arrow of the column sorted : the theme's secondary grey ; the others' its tertiary one, a
   step lighter, darker than the jobs list's faint one and still seen at a glance */
.af-th-sort {
  color: var(--bs-secondary-color);
}
.af-th-sort-idle {
  color: var(--bs-tertiary-color);
}
/* its arrow on the middle of the lowercase text, as a letter would sit : vertical-align middle
   puts its centre at the baseline plus half the text's x-height (the box keeps the text's size,
   only the arrow is smaller), not Font Awesome's -0.125em for an icon in running text */
.af-th-sort svg {
  font-size: 0.7em;
  vertical-align: middle;
}

.table td,
.table th {
  /* each cell's content in the middle of its row : Bootstrap's tables put it at the top
     (vertical-align: top), so a row taller than its text (a percentage bar, a checkbox) left
     all its room under the text */
  vertical-align: middle;
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  &::after {
    content: '\200B';
    display: inline-block;
    width: 0;
    height: 1em;
    visibility: hidden;
  }
}
/* a header (its text and arrow, a flex box) and a percentage cell (its bar, a block) have their
   height of their own : the zero-width space above, an empty cell's, went on a line of its own
   under them, which set the header and the bar at the top of a taller row */
.table th.af-th-cell::after,
.table td.af-td-bar::after {
  display: none;
}

table tbody {
  display: block;
  max-height: 300px;
  overflow-y: scroll;
}

table thead,
table tbody tr {
  display: table;
  width: calc(100% - 17px);
  table-layout: fixed;
}

table tbody tr {
  display: table;
  width: 100% !important;
  table-layout: fixed;
  cursor: pointer;
}
/* the line under the header set apart from the rows' : gray 500, two steps from their line in
   either theme (darker than the light theme's gray 300, lighter than the dark theme's gray 700).
   Drawn as the top of the rows' scrolling box, not under the header's cells : the header is the
   rows' width (the scrollbar's room taken off, its columns over theirs), so its line stopped short
   of the scrollbar ; the box's border runs over it, to the right end, and does not scroll */
table thead th {
  border-bottom-width: 0;
}
table thead + tbody {
  border-top: var(--bs-border-width) solid var(--bs-gray-500);
}
/* in the dark theme darker, half gray 600 : gray 500 alone stood out a
   little too much on the dark rows */
[data-bs-theme='dark'] table thead + tbody {
  border-top-color: color-mix(in srgb, var(--bs-gray-500) 50%, var(--bs-gray-600));
}
/* no line under the last row : the dropdown's (the table's) own edge ends it */
table tbody tr:last-child > td {
  border-bottom-width: 0;
}

table thead th.is-first,
table tbody td.is-first {
  width: 4em !important;
  max-width: 4em !important;
}
</style>
