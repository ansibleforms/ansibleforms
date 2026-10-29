<script setup>
/****************************************************/
/*                                                  */
/*  Bootstrap Pagination Component                  */
/*                                                  */
/*  @props:                                         */
/*      dataList: Array - List of items to paginate  */
/*      perPage: Number - Initial items per page      */
/*        (default 10). Without a size the user      */
/*        picked (a cookie), the largest size offered  */
/*        that fits the screen wins over it            */
/*        (lib/tableFit.js)                            */
/*      buttonsShown: Number - Number of buttons     */
/*      index: Number - Index of the item to show    */
/*      currentPage: Number - the page shown, from   */
/*        outside (a page's address)                 */
/*                                                  */
/*  @emit:                                          */
/*      change: Array - List of items to show        */
/*                                                  */
/****************************************************/

import { watch, ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { measureFit, fitSize, nearestSize } from '@/lib/tableFit';
import Helpers from '@/lib/Helpers';
import { useI18n } from 'vue-i18n';

// INIT

const { t } = useI18n();
const emit = defineEmits(['change']);

// PROPS

const props = defineProps({
  dataList: { type: Array },
  perPage: { type: Number, default: 10 },
  buttonsShown: { type: Number },
  index: { type: Number },
  name: { type: String, default: null },
  // the page shown, when its owner keeps it (a record page's tab : in the address)
  currentPage: { type: Number, default: null },
});

// DATA

const page = ref(0);
// the prop only seeds the initial page size : a perPage the user picked
// before is restored from the cookie on mount and wins over it
const pageSize = ref(props.perPage);
// the sizes offered, as PatternFly's and so the Ansible Automation Platform's : the screen picks
// among them too, never a size of its own
const SIZES = [10, 20, 50, 100];
// the page size follows the screen until the user picks one (or picked one before)
const fitting = ref(true);
const navEl = ref(null);

// METHODS

function setPage(p) {
  page.value = p;
  change();
}
function paginate(list) {
  let from = page.value * pageSize.value - pageSize.value;
  let to = page.value * pageSize.value;
  return list.slice(from, to);
}
function change() {
  // Do not emit a slice taken with an out-of-range page.
  //
  // displayedItems recomputes as soon as pageSize changes, while `page` is still
  // the old, now too-large number - and the watcher that clamps `page` is a
  // separate one that runs afterwards. So raising rows-per-page on the last page
  // emitted an EMPTY slice first (page 10 at 100/page = rows 900-1000 of 250) and
  // only then the corrected one. On the audit page each emit starts its own
  // request, so two were in flight at once and whichever answered last won: the
  // table could settle on rows 0-24 while the pager highlighted page 3.
  //
  // Skipping here is safe because the clamp watcher calls setPage(), which emits
  // again with a valid page. Checked explicitly rather than relying on the two
  // watchers' registration order.
  if (pages.value.length && page.value > pages.value.length) return;
  // Second argument: what the pager currently IS. A listener cannot work the page
  // size out from the slice alone - a short slice means either "the last page" or
  // "the user picked a smaller size", and audit.vue guessed wrong, so choosing a
  // SMALLER rows-per-page did nothing at all. Existing listeners that take only the
  // slice are unaffected.
  emit('change', displayedItems.value, { page: page.value, pageSize: pageSize.value, pages: pages.value.length });
}

// COMPUTED

const displayedItems = computed(() => {
  return paginate(props.dataList);
});

const displayedPages = computed(() => {
  var result;
  let from = page.value - 1;
  if (from == 0) from = 1;
  let to = page.value + props.buttonsShown;
  if (page.value >= pages.value.length - props.buttonsShown) {
    from = pages.value.length - props.buttonsShown - 1;
  }
  if (to - from != props.buttonsShown) to = props.buttonsShown + from;

  if (props.buttonsShown >= pages.value.length) {
    result = pages.value;
  } else {
    result = pages.value.slice(from, to);
  }
  return result;
});

const showFirstPage = computed(() => {
  return pages.value.length > 0 && !displayedPages.value.includes(1);
});

const showLastPage = computed(() => {
  return pages.value.length > 1 && !displayedPages.value.includes(pages.value.length);
});

const showFirstEllipsis = computed(() => {
  return page.value > 2 && pages.value.length >= 2 && !displayedPages.value.includes(2);
});

const showLastEllipsis = computed(() => {
  return !displayedPages.value.includes(pages.value.length - 1) && page.value < pages.value.length - 1;
});

const pages = computed(() => {
  // an empty list still has one (empty) page, so the pager shows an active "1"
  let numberOfPages = Math.max(1, Math.ceil(props.dataList.length / pageSize.value));
  return Array.from(Array(numberOfPages), (_, x) => x + 1);
});

const pageByIndex = computed(() => {
  if (!(props.index > 0)) return 1;
  let x = props.index / pageSize.value;
  let target = Math.floor(x + 1);
  // clamp defensively: a stale/inconsistent index must never resolve to a
  // page outside the valid range (which would render an empty slice)
  return Math.min(Math.max(target, 1), pages.value.length);
});

// WATCHERS

watch(displayedItems, () => {
  change();
});

// keep `page` inside the valid range whenever the page count shrinks:
// raising perPage, deleting the last rows of the last page or a filter that
// narrows the list would otherwise leave `page` beyond `pages.length` and
// paginate() would slice past the end, rendering an empty table
watch(pages, (list) => {
  if (page.value > list.length) {
    setPage(list.length);
  } else if (page.value < 1) {
    setPage(1);
  }
});

// the size the user picks : kept (a cookie, when the pager has a name), and the screen no longer
// sets it
function pickSize() {
  fitting.value = false;
  if (props.name) {
    try {
      Helpers.setCookie(`pagination_${props.name}_perPage`, String(pageSize.value), 365);
    } catch (e) {}
  }
}

// the rows that fit the screen, measured once the table shows rows : the pager's block (the range
// and the boxes) and the table above it. Rows not there yet (a list still loading) : tried again
// a little later, a few times
let fitTimer = null;
function fitToScreen(tries = 10) {
  clearTimeout(fitTimer);
  if (!fitting.value) return;
  nextTick(() => {
    if (!fitting.value || !navEl.value) return;
    const count = measureFit(navEl.value.closest('.af-table-pager') || navEl.value);
    if (count) {
      // the largest size offered that fits, else the smallest
      const size = fitSize(count, SIZES);
      if (size !== pageSize.value) pageSize.value = size;
    } else if (tries > 0) {
      fitTimer = setTimeout(() => fitToScreen(tries - 1), 300);
    }
  });
}
// the window resized : fitted again, a moment after the last change
let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => fitToScreen(0), 200);
}

// EVENTS

onMounted(() => {
  // restore perPage from cookie when a name is provided
  if (props.name) {
    const saved = Helpers.getCookie(`pagination_${props.name}_perPage`);
    if (saved && !isNaN(parseInt(saved))) {
      // a size no longer offered (25, before 20 replaced it) : the nearest one
      pageSize.value = nearestSize(parseInt(saved), SIZES);
      fitting.value = false;
    }
  }
  setPage(props.currentPage > 0 ? Math.min(props.currentPage, pages.value.length) : pageByIndex.value);
  fitToScreen();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  clearTimeout(fitTimer);
  clearTimeout(resizeTimer);
  window.removeEventListener('resize', onResize);
});

// the list arriving (it was empty while loading) : its rows to measure now
watch(
  () => props.dataList?.length > 0,
  (has) => {
    if (has) fitToScreen();
  },
);

// the page set from outside (Back to an address with another page)
watch(
  () => props.currentPage,
  (p) => {
    if (p > 0 && p !== page.value) setPage(Math.min(p, pages.value.length));
  },
);
</script>
<template>
  <!-- the page size, then the page boxes : the size outside the list, so Previous is its first
       box and gets the rounded left corners, as Next the right ones -->
  <nav ref="navEl" :aria-label="t('common.pagination')" class="af-pager-nav">
    <select class="form-select af-page-size" v-model="pageSize" :aria-label="t('common.pageSize')" @change="pickSize">
      <option v-for="size in SIZES" :key="size" :value="size">{{ size }}</option>
    </select>
    <ul class="pagination justify-content-end user-select-none">
      <!-- Previous and Next disabled at either end : no button there, no pointer -->
      <li :role="page <= 1 ? null : 'button'" class="page-item" :class="{ disabled: page <= 1 }">
        <a class="page-link" @click="setPage(page - 1)"
          ><FaIcon icon="angles-left" class="af-pager-arrow me-1" />{{ t('common.previous') }}</a
        >
      </li>
      <li role="button" class="page-item" :class="{ active: 1 == page }">
        <a class="page-link" v-if="showFirstPage" @click="setPage(1)" :aria-label="t('common.goToPage', { n: 1 })">1</a>
      </li>
      <li class="page-item" v-if="showFirstEllipsis">
        <span class="page-link">&hellip;</span>
      </li>
      <li
        role="button"
        class="page-item"
        :class="{ active: pageNumber == page }"
        v-for="pageNumber in displayedPages"
        :key="pageNumber"
      >
        <a class="page-link" @click="setPage(pageNumber)" :aria-label="t('common.goToPage', { n: pageNumber })">{{
          pageNumber
        }}</a>
      </li>
      <li class="page-item" v-if="showLastEllipsis">
        <span class="page-link">&hellip;</span>
      </li>
      <li role="button" class="page-item" :class="{ active: page == pages.length }">
        <a
          class="page-link"
          v-if="showLastPage"
          @click="setPage(pages.length)"
          :aria-label="t('common.goToPage', { n: pages.length })"
          >{{ pages.length }}</a
        >
      </li>
      <li :role="page >= pages.length ? null : 'button'" class="page-item" :class="{ disabled: page >= pages.length }">
        <a class="page-link" @click="setPage(page + 1)"
          >{{ t('common.next') }}<FaIcon icon="angles-right" class="af-pager-arrow ms-1"
        /></a>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
/* Bootstrap's .pagination is a <ul>, so it inherits the list reset's 1rem bottom
   margin. Stacked on the card body's own 1rem padding that made every paginated card
   sit 32px clear of its bottom edge, while a card without a pager sits at 16px. Zero
   it here so ALL tables match - the alternative is every consumer remembering a
   compensating class. */
.pagination {
  margin-bottom: 0;
}
/* the page size and the boxes on one line, at the right */
.af-pager-nav {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}
.af-page-size {
  width: auto;
}
/* Previous and Next : a double arrow on their outer side, a little smaller than the words */
.af-pager-arrow {
  font-size: 0.8em;
}
</style>
