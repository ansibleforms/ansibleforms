<script setup>
import axios from 'axios';
import ansiParse from '@/lib/AnsiParse';
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useFollowOutput } from '@/composables/useFollowOutput';
import { toast } from 'vue-sonner';
import Helpers from '@/lib/Helpers';
import { todayPick, samePick, isoDay, pickLabel } from '@/lib/datePick';

const { t, locale } = useI18n();

const log = ref('');
const isLoading = ref(false);
// the log read once (or its read failed) : until then its lines as grey placeholders
const firstRead = ref(false);
const filter = ref('');
const scroller = ref(null);
// how many of the last lines it reads : the server's setting (LOG_VIEW_LINES, Settings > System >
// General > Logging, 1000 by default), so none is asked here ; the whole log is its download

// The filter is a REGEX, which is the useful thing for a log - but String.match compiles
// its string argument, so a half typed one ('[', '(', '*', 'a{2,1}') threw a SyntaxError
// from inside this computed and took the whole page down. You cannot type '[abc]' without
// passing through '['. Compile it once here: while it is not valid yet, fall back to a
// plain case-insensitive substring match so the list keeps narrowing as you type.
const filterMatcher = computed(() => {
  const f = filter.value;
  if (!f) return null;
  try {
    const re = new RegExp(f);
    return (line) => re.test(line);
  } catch {
    const needle = f.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
});

// ─── the day shown ────────────────────────────────────────────────────────────
// The year, month and day dropdowns (AppDatePick) pick the day whose log is shown : today by
// default, followed as it is written ; another day is read once, as it was left. Today is the
// SERVER's today (its local date names the files, and may not be the browser's) : every read
// names its day (X-Log-Date), and while today is followed the dropdowns move with it, also past
// midnight. Until the first read, the browser's today stands in.
const pick = ref(todayPick());
// following today (no date asked : the server reads its today) ; false for a day picked apart
const followToday = ref(true);
// the server's today, as the last read while following named it
const serverToday = ref(null);
// the read day has no log file (X-Log-Missing) : said in the log's place
const missing = ref(false);
// the days that have a log file (GET /api/v2/log/dates), the newest first
const dates = ref([]);

// the years offered : those with a log file, and this year (no "All" : a log is one day)
const years = computed(() => {
  const set = new Set(dates.value.map((d) => Number(d.slice(0, 4))));
  set.add(new Date().getFullYear());
  if (pick.value.year) set.add(pick.value.year);
  return [...set].filter((y) => Number.isInteger(y)).sort((a, b) => b - a);
});
// the day shown, in words of the page's language : 14 November 2026
const pickedLabel = computed(() => pickLabel(pick.value, locale.value));

/**
 * The day a read named (X-Log-Date) as a pick.
 *
 * Args:
 *   day (string): YYYY-MM-DD.
 *
 * Returns:
 *   object|null: { year, month, day }, null when it is no such day.
 */
function pickOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

/**
 * Reads the days that have a log file, for the years offered. A failure leaves this year only.
 */
async function loadDates() {
  try {
    const result = await axios.get('/api/v2/log/dates');
    dates.value = result.data?.records || [];
  } catch {
    dates.value = [];
  }
}

/**
 * Shows the day picked : today is followed again, another day is read once.
 *
 * Args:
 *   value (object): the pick, { year, month, day }.
 */
function onPick(value) {
  pick.value = value;
  // step 1 : today (the server's, else the browser's) is followed, any other day is not
  followToday.value = samePick(value, serverToday.value || todayPick());
  // step 2 : the day's lines replace the others, the grey placeholders until they come
  log.value = '';
  missing.value = false;
  firstRead.value = false;
  load(true);
}

/**
 * Back to today, followed, with no search : the page as it opens.
 */
function resetView() {
  filter.value = '';
  onPick(serverToday.value || todayPick());
}
// nothing to reset while today is followed and nothing is searched
const changed = computed(() => !followToday.value || !!filter.value);

const filtered = computed(() => {
  const match = filterMatcher.value;
  const lines = log.value.split('\n').filter((x) => x != '');
  return (match ? lines.filter(match) : lines).map((x) => ansiParse(x));
});
// ─── following the log ────────────────────────────────────────────────────────
// The log is read again every 2 seconds, as a terminal follows a file : while the view is at
// its bottom it follows the new lines ; scrolled up to read an older one, it stays where it is
// and AppFollowButton takes it back down (useFollowOutput, as a running job's output). A failing
// read does not stop it : it is said once, then tried again later and later (doubling up to
// 30 seconds), and the reading goes on at its pace as soon as one answers ; Refresh tries at once.
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 30000;
// a past day is not live : read once, it has nothing to follow and no "New lines" to offer
const { newLines, paused, jumpToEnd } = useFollowOutput(
  scroller,
  () => log.value,
  () => followToday.value,
);
let pollTimer = null;
let stopped = false;
// the reads that failed in a row : 0 while it answers
let failures = 0;
// the reads asked, counted : an answer to an older one (another day, picked since) is dropped
let readCount = 0;

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/**
 * Plans the next read : in 2 seconds, or later after failed reads (2 s doubled per failure,
 * at most 30 s).
 */
function schedulePoll() {
  stopPolling();
  if (stopped) return;
  const delay = failures ? Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS) : POLL_MS;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    load();
  }, delay);
}

/**
 * Reads the last lines of the day's log, then plans the next read while today is followed.
 *
 * Args:
 *   force (boolean): Refresh, the first read or a day picked : read now, even while the tab is
 *     hidden or a read of another day is still under way (its answer is then dropped).
 */
async function load(force = false) {
  if (isLoading.value && !force) return;
  // a hidden tab reads nothing : the next visible poll catches up
  if (!force && document.hidden) return schedulePoll();
  const mine = ++readCount;
  stopPolling();
  isLoading.value = true;
  try {
    // step 1 : today's (the server's) while following, else the day picked
    const params = followToday.value ? {} : { date: isoDay(pick.value) };
    const result = await axios.get('/api/v2/log', { params });
    // another day was picked while it was read : its answer is not this day's
    if (mine !== readCount) return;
    // step 2 : the day read ; while following, the dropdowns move with the server's today
    const day = pickOf(result.headers?.['x-log-date']);
    if (followToday.value && day) {
      serverToday.value = day;
      if (!samePick(day, pick.value)) pick.value = day;
    }
    // step 3 : no file for that day is said, its lines are followed down by useFollowOutput
    // (or said by AppFollowButton while scrolled up)
    missing.value = result.headers?.['x-log-missing'] === 'true';
    if (result.data != '...' && result.data !== log.value) log.value = result.data;
    failures = 0;
  } catch (err) {
    if (mine !== readCount) return;
    // said once per run of failures (not every few seconds), then tried again later
    if (!stopped && (failures === 0 || force)) toast.error(Helpers.parseAxiosResponseError(err));
    failures++;
  } finally {
    // always released, also when the server answered the "..." placeholder ; by the latest read
    if (mine === readCount) {
      isLoading.value = false;
      firstRead.value = true;
    }
  }
  // a past day is read once ; today goes on being read
  if (mine === readCount && followToday.value) schedulePoll();
}

async function download() {
  try {
    // the day shown : its .log, or a past day's .log.gz as the server keeps it
    await Helpers.downloadFile(`/api/v2/log/download?date=${isoDay(pick.value)}`);
  } catch (err) {
    // the server's reason (downloadFile decodes its error body), else a translated fallback
    toast.error(Helpers.parseAxiosResponseError(err, t('common.downloadFailed')));
  }
}
onMounted(() => {
  loadDates();
  load(true);
});
onUnmounted(() => {
  stopped = true;
  stopPolling();
});
</script>
<template>
  <AppNav />
  <div class="af-fill-page">
    <main class="d-flex flex-nowrap af-settings-layout af-with-sidebar">
      <AppSidebar />
      <AppSettings :title="t('logs.title')" :description="t('logs.description')" icon="file-lines">
        <template #headerActions>
          <div class="ms-2">
            <!-- the day shown first : its year, month and day ; the search then looks in it -->
            <AppDatePick :model-value="pick" :years="years" @change="onPick" />
            <!-- the search box of the other pages : the placeholder goes on click, an X clears it -->
            <BsSearch v-model="filter" style="width: 16rem" />
          </div>
          <!-- view controls only : these decide WHAT the card shows. Reset (the funnel crossed out,
               as the Audit log's) goes back to today, followed, with no search ; Refresh re-reads
               the same view, it does not act on anything ; the download follows, with the page's
               buttons -->
          <BsButton
            cssClass="ms-2 text-nowrap"
            icon="filter-circle-xmark"
            :title="t('logs.resetHint')"
            :disabled="!changed"
            @click="resetView()"
            >{{ t('audit.reset') }}</BsButton
          >
          <AppRefreshButton class="ms-2" :action="() => load(true)" :label="t('jobs.refresh')" />
        </template>
        <template #actions>
          <BsButton class="text-nowrap" icon="download" @click="download()">{{ t('logs.download') }}</BsButton>
        </template>
        <template #default>
          <!-- tabindex : the scrolling box is the card body around us, and a
               scroll container is only driven by the arrow / page keys once
               something inside it holds the focus -->
          <div
            ref="scroller"
            id="scroller"
            class="font-monospace fs-6"
            tabindex="0"
            role="region"
            :aria-label="t('logs.title')"
          >
            <!-- the first read : the log's lines as grey placeholders, where they come -->
            <AppSkeleton v-if="!firstRead" shape="editor" :count="24" />
            <!-- the day has no log file : said in the log's place -->
            <div v-else-if="missing && !filtered.length" class="text-body-secondary fst-italic py-2 ps-3">
              {{ t('logs.noLog', { date: pickedLabel }) }}
            </div>
            <!-- a line : its number, then its text in a column of its own, so a long line wraps
                 under its own start and the number's grey runs down beside it -->
            <div v-for="(t, i) in filtered" :key="i" class="d-flex">
              <div class="text-end pe-1 me-3 af-line-no flex-shrink-0" style="width: 40px">{{ i + 1 }}</div>
              <div class="af-line-text">
                <span v-for="(s, si) in t" :key="si" v-text="s.text" :class="s.foreground || ''"></span>
              </div>
            </div>
            <!-- scrolled up : back to the bottom, following again -->
            <AppFollowButton :show="paused" :new-lines="newLines" @click="jumpToEnd" />
          </div>
        </template>
      </AppSettings>
    </main>
  </div>
</template>
<style scoped>
/* The viewport is filled by `af-fill-page` (the card body is the scrolling
   area), so the log itself only has to keep long lines from widening the page. */
#scroller {
  overflow-wrap: anywhere;
  /* the line numbers' grey column from the card's left border, and the lines from its top
     and bottom : the card body's padding taken back */
  margin: calc(-1 * var(--bs-card-spacer-y)) 0 calc(-1 * var(--bs-card-spacer-y)) calc(-1 * var(--bs-card-spacer-x));
}
/* the text column takes the rest of the row, and may shrink below its longest word */
.af-line-text {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
<route lang="yaml">
meta:
  layout: standard
</route>
