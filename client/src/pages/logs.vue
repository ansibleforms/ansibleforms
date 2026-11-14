<script setup>
import axios from 'axios';
import ansiParse from '@/lib/AnsiParse';
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useFollowOutput } from '@/composables/useFollowOutput';
import { toast } from 'vue-sonner';
import Helpers from '@/lib/Helpers';

const { t } = useI18n();

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

// Clear empties the view, never the log : the last line shown then is remembered, and only the
// lines after it are shown from there on. Not among the lines read any more (more than LOG_VIEW_LINES
// were written since), every line read is newer. Reloading the page shows the last lines again.
const clearedAfter = ref(null);

/**
 * Empties the view : from now on only the lines written after this moment are shown.
 */
function clearView() {
  const lines = log.value.split('\n').filter((x) => x != '');
  clearedAfter.value = lines.length ? lines[lines.length - 1] : '';
}

const filtered = computed(() => {
  const match = filterMatcher.value;
  let lines = log.value.split('\n').filter((x) => x != '');
  if (clearedAfter.value !== null) {
    const at = clearedAfter.value === '' ? -1 : lines.lastIndexOf(clearedAfter.value);
    if (at >= 0) lines = lines.slice(at + 1);
  }
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
const { newLines, paused, jumpToEnd } = useFollowOutput(
  scroller,
  () => log.value,
  () => true,
);
let pollTimer = null;
let stopped = false;
// the reads that failed in a row : 0 while it answers
let failures = 0;

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
 * Reads the last lines of the log, then plans the next read.
 *
 * Args:
 *   force (boolean): Refresh, or the first read : read now, even while the tab is hidden.
 */
async function load(force = false) {
  if (isLoading.value) return;
  // a hidden tab reads nothing : the next visible poll catches up
  if (!force && document.hidden) return schedulePoll();
  isLoading.value = true;
  try {
    const result = await axios.get('/api/v2/log');
    // followed down by useFollowOutput, or said by AppFollowButton while scrolled up
    if (result.data != '...' && result.data !== log.value) log.value = result.data;
    failures = 0;
  } catch (err) {
    // said once per run of failures (not every few seconds), then tried again later
    if (!stopped && (failures === 0 || force)) toast.error(Helpers.parseAxiosResponseError(err));
    failures++;
  } finally {
    // always released, also when the server answered the "..." placeholder
    isLoading.value = false;
    firstRead.value = true;
  }
  schedulePoll();
}

async function download() {
  try {
    await Helpers.downloadFile(`/api/v2/log/download`);
  } catch (err) {
    // the server's reason (downloadFile decodes its error body), else a translated fallback
    toast.error(Helpers.parseAxiosResponseError(err, t('common.downloadFailed')));
  }
}
onMounted(() => load(true));
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
          <div>
            <!-- the search box of the other pages : the placeholder goes on click, an X clears it -->
            <BsSearch v-model="filter" style="width: 16rem" />
          </div>
          <!-- view controls only : these decide WHAT the card shows. Refresh re-reads the same
               view, it does not act on anything ; the download follows, with the page's buttons -->
          <AppRefreshButton class="ms-2" :action="() => load(true)" :label="t('jobs.refresh')" />
          <!-- empties the view, not the log : only the lines written after it show from then on -->
          <BsButton class="ms-2 text-nowrap" icon="eraser" :title="t('logs.clearHint')" @click="clearView()">{{
            t('logs.clear')
          }}</BsButton>
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
            <div v-else-if="clearedAfter !== null && !filtered.length" class="text-body-secondary fst-italic py-2">
              {{ t('logs.cleared') }}
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
