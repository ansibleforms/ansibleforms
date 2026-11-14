<script setup>
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from 'vue-sonner';
import axios from 'axios';
import Profile from '@/lib/Profile';
import Helpers from '@/lib/Helpers.js';
import { PILL } from '@/lib/tableCells';
import { periodOf, pickLabel, yearRange } from '@/lib/datePick';

const { t, te, locale } = useI18n();

const authenticated = ref(false);
const loading = ref(false);
const records = ref([]);
const total = ref(0);
const offset = ref(0);
// seeded to match BsPagination's :perPage below, so its first emit is a no-op rather
// than an immediate refetch at a different size
const pageSize = ref(10);
// the (offset:limit) we last ASKED the server for. Comparing against what has already
// arrived is not enough : the pager can emit twice before the first response lands,
// and both emits would then pass the guard and fire duplicate requests.
const lastRequest = ref('');
const expanded = ref({});
const facets = ref({ actions: [], actors: [] });
// a failed load must not read as 'nothing has ever been recorded'
const loadFailed = ref(false);
// bumped to remount BsPagination so a filter change really does go back to page 1
const filterVersion = ref(0);

// filters : these decide WHAT the card shows, so they live in the header slot -
// the action buttons stay under the card (see AppSettings)
const filterActor = ref('');
const filterAction = ref('');
const filterOutcome = ref('');
// the period, first of the filters : a year, a month of it, a day of that (AppDatePick), All by
// default. The browser's own calendar : its first and next first moments are sent as [from, to).
const period = ref({ year: null, month: null, day: null });
// the period in words of the page's language, for the empty table : November 2026
const periodLabel = computed(() => pickLabel(period.value, locale.value));
// the years offered : from the oldest entry's (facets) to this one, the newest first
const years = computed(() => {
  const now = new Date().getFullYear();
  const oldest = facets.value.oldest ? new Date(facets.value.oldest).getFullYear() : now;
  return yearRange([Number.isInteger(oldest) ? oldest : now, now]);
});

// ─── sorting ──────────────────────────────────────────────────────────────────
// The headers sort as the Job history's do : a first click sorts up, the next one down, and so
// on ; no column sorted is the newest first, as always. The table is paged on the server, so the
// server sorts (sort, dir), on its whitelist of columns with the id as the tiebreaker, and the
// download follows the same order.
const sortKey = ref(null);
const sortDir = ref(1); // 1 asc, -1 desc

/**
 * Sorts on a column : up on a first click, then the other way on each next one. Back to page 1.
 *
 * Args:
 *   key (string): the column, as the server takes it : time, actor, action, target, outcome, ip.
 */
function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = -sortDir.value;
  } else {
    sortKey.value = key;
    sortDir.value = 1;
  }
  applyFilters();
}

/**
 * A column's aria-sort : how it is sorted, for a screen reader.
 *
 * Args:
 *   key (string): the column.
 *
 * Returns:
 *   string: ascending, descending or none.
 */
function ariaSort(key) {
  if (sortKey.value !== key) return 'none';
  return sortDir.value === 1 ? 'ascending' : 'descending';
}

// Null-prototype maps with explicit fallbacks. A plain object literal resolves
// `constructor` and `__proto__` to inherited members, which are truthy - so a row with
// outcome 'constructor' handed a function to t() and blanked the entire table. And an
// unrecognised outcome must never be DISPLAYED AS SUCCESS in an audit trail.
// the outcome as a pill of the shared tables (styles/tables.scss, lib/tableCells.js)
const outcomeBadge = Object.assign(Object.create(null), {
  success: PILL.green,
  failure: PILL.red,
  denied: PILL.amber,
});
const outcomeLabelKey = Object.assign(Object.create(null), {
  success: 'audit.outcomeSuccess',
  failure: 'audit.outcomeFailure',
  denied: 'audit.outcomeDenied',
});
// Actions are stored as machine strings ('settings.config.update') because that is what
// the filter matches on and what a support conversation quotes. This turns them into a
// sentence for reading. Every action the routes can produce has an entry ; anything that
// does not - a route added later - falls back to the raw string rather than a blank cell,
// which is also the only place the machine name is still shown.
function actionLabel(action) {
  if (!action) return '';
  const key = 'audit.actionLabels.' + String(action).replace(/[.-]/g, '_');
  return te(key) ? t(key) : action;
}

function badgeClass(outcome) {
  return outcomeBadge[outcome] || PILL.grey;
}
function outcomeText(outcome) {
  const key = outcomeLabelKey[outcome];
  // show the raw value rather than inventing a friendlier one we do not recognise
  return key ? t(key) : String(outcome ?? '');
}

// BsPagination is client side by design : it slices whatever dataList it is handed.
// The audit table is the one place in this app where loading every row is not an
// option, so it is fed the row INDEXES instead of the rows. It then renders the page
// buttons and the per-page selector exactly as every other table does, and the slice
// it emits tells us precisely which absolute rows to fetch from the server.
const pageIndexes = computed(() => Array.from({ length: total.value }, (_, i) => i));
// the rows shown, for the footer : 1-25 of 140
const pageRange = computed(() => {
  if (!total.value || !records.value.length) return t('dataTable.rangeOf', { from: 0, to: 0, total: total.value });
  return t('dataTable.rangeOf', {
    from: offset.value + 1,
    to: offset.value + records.value.length,
    total: total.value,
  });
});

async function onPageChange(slice, meta) {
  const nextOffset = slice.length ? slice[0] : 0;
  // The page size comes from the PAGER, not from the slice length.
  //
  // A slice shorter than the current size is ambiguous - it is either the last page or a
  // smaller size the user just chose - and the old `slice.length > pageSize` test resolved
  // that ambiguity one way only. So picking a LARGER size worked and picking a SMALLER one
  // did nothing: 10 is not > 25, the limit stayed 25, and the request was even suppressed
  // as a duplicate. The table then rendered 25 rows while the selector read 10, and every
  // page repeated 15 rows of the one before. BsPagination now reports its own state.
  const nextLimit = meta?.pageSize || (slice.length > pageSize.value ? slice.length : pageSize.value);
  // the pager re-emits whenever its slice recomputes - including immediately after
  // our own load() changed `total`. Without this guard that is an endless loop.
  if (`${nextOffset}:${nextLimit}` === lastRequest.value) return;
  offset.value = nextOffset;
  pageSize.value = nextLimit;
  await load();
}

/**
 * The filters, the period and the order as the server takes them : the same for a page and for
 * the download, so the file holds what the table shows, all of it.
 *
 * Returns:
 *   URLSearchParams: actor, action, outcome, from and to, sort and dir, those that are set.
 */
function filterParams() {
  const params = new URLSearchParams();
  if (filterActor.value) params.set('actor', filterActor.value);
  if (filterAction.value) params.set('action', filterAction.value);
  if (filterOutcome.value) params.set('outcome', filterOutcome.value);
  // the period as instants, [from, to)
  const range = periodOf(period.value);
  if (range) {
    params.set('from', range.from);
    params.set('to', range.to);
  }
  if (sortKey.value) {
    params.set('sort', sortKey.value);
    params.set('dir', sortDir.value === 1 ? 'asc' : 'desc');
  }
  return params;
}

// the audit table is the one place in this app where loading every row is not an
// option, so paging happens server side
async function load() {
  loading.value = true;
  lastRequest.value = `${offset.value}:${pageSize.value}`;
  try {
    const params = filterParams();
    params.set('limit', String(pageSize.value));
    params.set('offset', String(offset.value));
    const res = await axios.get(`/api/v2/audit?${params.toString()}`);
    const data = res.data?.records !== undefined ? res.data : res.data?.result;
    records.value = data?.records || [];
    total.value = data?.total || 0;
    loadFailed.value = false;
    // Recover from an offset past the end. The retention sweep (or another admin) can
    // shrink the table under us; the empty branch then unmounts BsPagination, which is
    // the only thing that could have moved the offset - so the page would sit on
    // "nothing recorded yet" for ever, Refresh included. Step back to the last page
    // that exists and re-fetch.
    if (records.value.length === 0 && total.value > 0 && offset.value >= total.value) {
      offset.value = Math.max(0, (Math.ceil(total.value / pageSize.value) - 1) * pageSize.value);
      loading.value = false;
      return await load();
    }
  } catch (err) {
    loadFailed.value = true;
    toast.error(Helpers.parseAxiosResponseError(err, t('audit.failedLoad')));
  } finally {
    loading.value = false;
  }
}

async function loadFacets() {
  try {
    const res = await axios.get('/api/v2/audit/facets');
    facets.value = res.data?.actions !== undefined ? res.data : res.data?.result || { actions: [], actors: [] };
  } catch {
    facets.value = { actions: [], actors: [] };
  }
}

/**
 * Picks the period : back to page 1, as any filter.
 *
 * Args:
 *   value (object): the pick, { year, month, day }, null for All.
 */
async function onPeriod(value) {
  period.value = value;
  await applyFilters();
}

/**
 * Downloads every entry the filters and the period select, in the order shown, as a CSV file :
 * all of them, not only the page shown. Named after the period (audit-2026-11.csv).
 */
async function download() {
  try {
    const params = filterParams();
    const range = periodOf(period.value);
    if (range) params.set('period', range.name);
    await Helpers.downloadFile(`/api/v2/audit/download?${params.toString()}`);
  } catch (err) {
    // the server's reason (downloadFile decodes its error body), else a translated fallback
    toast.error(Helpers.parseAxiosResponseError(err, t('common.downloadFailed')));
  }
}

// changing a filter has to reset to the first page, or you can end up on an offset
// past the end of the newly filtered set and see nothing
async function applyFilters() {
  offset.value = 0;
  // remounting the pager is what actually resets it : resetting `offset` alone left the
  // pager holding its old page, which it then re-emitted and overrode us with. Same
  // trick BsDataTable uses for its filter row.
  filterVersion.value++;
  await load();
}

// the filters back to every period, user, action and outcome, the newest first ; nothing to do
// when they are already
const filtered = computed(
  () =>
    !!(filterActor.value || filterAction.value || filterOutcome.value) ||
    period.value.year !== null ||
    sortKey.value !== null,
);
async function resetFilters() {
  filterActor.value = '';
  filterAction.value = '';
  filterOutcome.value = '';
  period.value = { year: null, month: null, day: null };
  sortKey.value = null;
  sortDir.value = 1;
  await applyFilters();
}

function toggle(id) {
  expanded.value[id] = !expanded.value[id];
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (authenticated.value) {
    await Promise.all([load(), loadFacets()]);
  }
});
</script>

<template>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="clipboard-list"
      :title="t('audit.title')"
      :description="t('audit.description')"
    >
      <!-- the filters on the title line, as the other tables have their search and columns. The
           actors' and the actions' at least as wide as their names make them once read : they do
           not widen (and push the table down) when the first page of entries comes -->
      <template #headerActions>
        <!-- the filters : one group that wraps within itself (af-filter-group), so on a narrow row
             they take a second line and the buttons stay together at the right -->
        <div class="d-flex flex-wrap align-items-center gap-2 af-filter-group">
          <!-- the period first : a year, a month of it, a day of that, All by default -->
          <AppDatePick :model-value="period" :years="years" allow-all @change="onPeriod" />
          <select
            v-model="filterActor"
            class="form-select"
            style="width: auto; max-width: 14rem"
            @change="applyFilters"
          >
            <option value="">{{ t('audit.allUsers') }}</option>
            <option v-for="a in facets.actors" :key="'ac-' + a" :value="a">{{ a }}</option>
          </select>
          <select
            v-model="filterAction"
            class="form-select"
            style="width: auto; max-width: 14rem"
            @change="applyFilters"
          >
            <option value="">{{ t('audit.allActions') }}</option>
            <option v-for="a in facets.actions" :key="'an-' + a" :value="a">{{ actionLabel(a) }}</option>
          </select>
          <select v-model="filterOutcome" class="form-select" style="width: auto" @change="applyFilters">
            <option value="">{{ t('audit.allOutcomes') }}</option>
            <option value="success">{{ t('audit.outcomeSuccess') }}</option>
            <option value="failure">{{ t('audit.outcomeFailure') }}</option>
            <option value="denied">{{ t('audit.outcomeDenied') }}</option>
          </select>
        </div>
        <!-- the filters at the left of the controls' row, Reset (the funnel crossed out, as the job
             output's Remove filter) and Refresh at its right -->
        <BsButton
          cssClass="text-nowrap"
          icon="filter-circle-xmark"
          :title="t('audit.resetHint')"
          :disabled="!filtered"
          @click="resetFilters()"
          >{{ t('audit.reset') }}</BsButton
        >
        <AppRefreshButton :action="load" :label="t('audit.refresh')" />
      </template>
      <!-- the page's button : every entry the filters select, as a CSV file, as the Server log's
           Download -->
      <template #actions>
        <BsButton class="text-nowrap" icon="download" @click="download()">{{ t('logs.download') }}</BsButton>
      </template>
      <template #default>
        <!-- the first load : the table's rows as grey placeholders (a reload keeps them shown) -->
        <AppSkeleton v-if="loading && records.length === 0" shape="table" :count="10" />
        <div v-else-if="loadFailed" class="text-center text-muted py-4">
          <div class="fw-bold">{{ t('audit.failedLoad') }}</div>
        </div>
        <!-- a period without entries is said by its name ; without a period, the trail's start -->
        <div v-else-if="records.length === 0 && periodLabel" class="text-center text-muted py-4">
          <div class="fw-bold">{{ t('audit.noEntriesFor', { period: periodLabel }) }}</div>
        </div>
        <div v-else-if="records.length === 0" class="text-center text-muted py-4">
          <div class="fw-bold">{{ t('audit.empty') }}</div>
          <small>{{ t('audit.emptyHint') }}</small>
        </div>
        <template v-else>
          <!-- the shared look of the tables (styles/tables.scss) : running to the card's
             edges, a grey header bar, the pager in a footer bar -->
          <div class="af-table-frame">
            <div class="table-responsive" style="overflow: visible">
              <table v-fit-columns class="table table-sm table-hover mb-0 af-table audit-table">
                <thead>
                  <tr>
                    <!-- the time in full, its zone included : its own width, never cut -->
                    <th
                      class="is-clickable"
                      data-fit-keep
                      :aria-sort="ariaSort('time')"
                      :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                      @click="toggleSort('time')"
                    >
                      {{ t('audit.time') }}
                      <span class="text-muted ms-1" style="font-size: 0.7em">
                        <font-awesome-icon v-if="sortKey === 'time'" :icon="sortDir === 1 ? 'sort-up' : 'sort-down'" />
                        <font-awesome-icon v-else icon="sort" class="opacity-25" />
                      </span>
                    </th>
                    <!-- the row's detail unfolds : its caret after the time, as the jobs list's (styles/tables.scss) -->
                    <th class="af-expand-col"></th>
                    <th
                      class="is-clickable"
                      :aria-sort="ariaSort('actor')"
                      :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                      @click="toggleSort('actor')"
                    >
                      {{ t('audit.actor') }}
                      <span class="text-muted ms-1" style="font-size: 0.7em">
                        <font-awesome-icon v-if="sortKey === 'actor'" :icon="sortDir === 1 ? 'sort-up' : 'sort-down'" />
                        <font-awesome-icon v-else icon="sort" class="opacity-25" />
                      </span>
                    </th>
                    <th
                      class="is-clickable"
                      :aria-sort="ariaSort('action')"
                      :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                      @click="toggleSort('action')"
                    >
                      {{ t('audit.action') }}
                      <span class="text-muted ms-1" style="font-size: 0.7em">
                        <font-awesome-icon
                          v-if="sortKey === 'action'"
                          :icon="sortDir === 1 ? 'sort-up' : 'sort-down'"
                        />
                        <font-awesome-icon v-else icon="sort" class="opacity-25" />
                      </span>
                    </th>
                    <th
                      class="is-clickable"
                      :aria-sort="ariaSort('target')"
                      :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                      @click="toggleSort('target')"
                    >
                      {{ t('audit.target') }}
                      <span class="text-muted ms-1" style="font-size: 0.7em">
                        <font-awesome-icon
                          v-if="sortKey === 'target'"
                          :icon="sortDir === 1 ? 'sort-up' : 'sort-down'"
                        />
                        <font-awesome-icon v-else icon="sort" class="opacity-25" />
                      </span>
                    </th>
                    <th
                      class="is-clickable"
                      data-fit-keep="9rem"
                      :aria-sort="ariaSort('outcome')"
                      :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                      @click="toggleSort('outcome')"
                    >
                      {{ t('audit.outcome') }}
                      <span class="text-muted ms-1" style="font-size: 0.7em">
                        <font-awesome-icon
                          v-if="sortKey === 'outcome'"
                          :icon="sortDir === 1 ? 'sort-up' : 'sort-down'"
                        />
                        <font-awesome-icon v-else icon="sort" class="opacity-25" />
                      </span>
                    </th>
                    <th
                      class="is-clickable"
                      data-fit-keep="10rem"
                      :aria-sort="ariaSort('ip')"
                      :style="{ userSelect: 'none', whiteSpace: 'nowrap' }"
                      @click="toggleSort('ip')"
                    >
                      {{ t('audit.ip') }}
                      <span class="text-muted ms-1" style="font-size: 0.7em">
                        <font-awesome-icon v-if="sortKey === 'ip'" :icon="sortDir === 1 ? 'sort-up' : 'sort-down'" />
                        <font-awesome-icon v-else icon="sort" class="opacity-25" />
                      </span>
                    </th>
                    <th class="af-fit-spacer"></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="r in records" :key="r.id">
                    <tr class="audit-row">
                      <td class="font-monospace">{{ Helpers.formatServerDate(r.created_at) }}</td>
                      <!-- a row with a detail unfolds it : right, down while open, as the jobs list's steps -->
                      <td
                        class="af-expand-col text-center"
                        :role="r.detail ? 'button' : null"
                        @click="r.detail && toggle(r.id)"
                      >
                        <FaIcon
                          v-if="r.detail"
                          :icon="expanded[r.id] ? 'angle-down' : 'angle-right'"
                          :fixedwidth="true"
                        />
                      </td>
                      <td>
                        <span v-if="r.actor">{{ r.actor }}</span>
                        <span v-else class="text-muted fst-italic">{{ t('audit.system') }}</span>
                      </td>
                      <td>{{ actionLabel(r.action) }}</td>
                      <td class="audit-target">{{ r.target }}</td>
                      <td>
                        <span class="badge rounded-pill fw-semibold af-pill" :class="badgeClass(r.outcome)"
                          ><span class="af-pill-label">{{ outcomeText(r.outcome) }}</span></span
                        >
                      </td>
                      <td class="font-monospace small text-muted">{{ r.ip }}</td>
                      <td class="af-fit-spacer"></td>
                    </tr>
                    <tr v-if="expanded[r.id] && r.detail">
                      <td colspan="8" class="bg-body-tertiary">
                        <pre class="mb-0 font-monospace fs-6 audit-detail">{{ JSON.stringify(r.detail, null, 2) }}</pre>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </template>
      <!-- the pager : the rows shown, the page size and boxes, under the card as every table's -->
      <template #footer>
        <div class="af-table-pager">
          <span class="af-table-count">{{ pageRange }}</span>
          <BsPagination
            :key="filterVersion"
            :dataList="pageIndexes"
            :perPage="10"
            :buttonsShown="7"
            name="audit"
            @change="onPageChange"
          />
        </div>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>

<style scoped>
/* the audit table : the shared look (styles/tables.scss) ; its detail row keeps its text
   whole and wrapped */
.audit-detail {
  white-space: pre-wrap;
  word-break: break-word;
  text-box: none;
}
.audit-row td {
  white-space: nowrap;
}
</style>
