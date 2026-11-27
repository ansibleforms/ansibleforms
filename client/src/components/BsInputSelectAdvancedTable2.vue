<script setup>
/******************************************************************/
/*                                                                */
/*  Bootstrap Table select component                              */
/*  It's used in the BsInputSelectAdvanced2 component             */
/*  To create a left-right selector                               */
/*  This component creates a table with selectable rows           */
/*                                                                */
/*  @props:                                                       */
/*      values: Array                                             */
/*      modelValue: Object                                        */
/*      required: Boolean                                         */
/*      status: String                                            */
/*      sizeClass: String                                         */
/*      columns: Array                                            */
/*      previewColumn: String                                     */
/*      valueColumn: String                                       */
/*      filterColumns: Array                                      */
/*      focus: String                                             */
/*      sortable: Boolean - a click on a column's header sorts the */
/*                rows (composables/useColumnSort.js), true by    */
/*                default                                         */
/*                                                                */
/*  @emit:                                                        */
/*      update:modelValue                                         */
/*      reset                                                     */
/*      focusset                                                   */
/*                                                                */
/******************************************************************/

import { useTemplateRef, computed } from 'vue';
import Helpers from '@/lib/Helpers';
import { useI18n } from 'vue-i18n';
import { useColumnSort } from '@/composables/useColumnSort';

// INIT

const { t } = useI18n();

const emit = defineEmits(['update:modelValue', 'reset', 'focusset']);
const queryfilterRef = useTemplateRef('queryfilterRef');

// DATA

const selected = ref({});
const labels = ref([]);
const valueLabel = ref('');
const previewLabel = ref('');
const preview = ref('');
const queryfilter = ref('');

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
  required: { type: Boolean },
  status: { type: String },
  sizeClass: { type: String },
  columns: { type: Array, default: () => [] },
  previewColumn: { type: String },
  valueColumn: { type: String },
  filterColumns: { type: Array, default: () => [] },
  focus: { type: String },
  // a click on a column's header sorts the rows ; false keeps the order they came in
  sortable: { type: Boolean, default: true },
});

// COMPUTED

const selectedItems = computed(() => {
  return props.values.filter((v, i) => selected.value[i]);
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
    recalc();
  },
  { deep: true },
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

function select(i) {
  selected.value[i] = !selected.value[i];
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
  emit('update:modelValue', { values: selectedItems.value, preview: preview.value });
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
  } else if (props.columns.length > 0) {
    // no rows (none yet, or all moved to the other side) : the header still shows, the columns the
    // field declares ; without them there is no row to read its columns from, the last ones stay
    labels.value = [...props.columns];
  }
}

// HOOKS

onMounted(() => {
  reset();
  getLabels();
});
</script>
<template>
  <!-- a column the side's full height, its space above inside it (a margin ran it past the side's
       end) : the message of no rows takes the room from the header's end down, in its middle -->
  <div class="pt-2 d-flex flex-column h-100">
    <div class="pb-2">
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
      <table class="table table-hover border mb-0">
        <thead v-if="labels.length > 1">
          <tr :class="sizeClass">
            <th :key="l" v-for="l in labels" :class="{ 'af-sortable': sortable }" @click.stop="toggleSort(l)">
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
        <thead v-if="labels.length == 1">
          <tr :class="sizeClass">
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
            v-for="v in sorted"
            @click="select(v.index)"
          >
            <td v-for="l in labels" v-html="highlightFilter(v.value[l], l)" :key="l"></td>
            <td v-if="labels.length == 0" v-html="highlightFilter(v.value)"></td>
          </tr>
        </tbody>
      </table>
    </div>
    <!-- nothing to show : said under the header and its line, where the rows would be, in line with
         the cells' text -->
    <p v-if="values.length == 0" class="af-no-rows">{{ t('common.noData') }}</p>
    <p v-if="values.length > 0 && filtered.length == 0" class="af-no-rows">{{ t('common.noFilterMatch') }}</p>
  </div>
</template>
<style scoped>
/* no rows : said in the middle of the room under the header, both ways */
.af-no-rows {
  flex-grow: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  margin: 0;
  padding: 0.5rem;
}

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
