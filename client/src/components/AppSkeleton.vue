<script>
// ------------------------------------------------------------------
// the placeholders on screen, shared by every AppSkeleton : how many show, on which page, and
// when the last one went. A page that loads in steps (its title, then its record) swaps one
// for the next in the same moment : the next shows at once instead of waiting its delay again
// ------------------------------------------------------------------
const seen = { visible: 0, path: null, at: 0 };
// how long after the last one went the next one still follows it, in milliseconds
const FOLLOW_MS = 400;

/**
 * Whether placeholders show, or just went, on this page.
 *
 * Args:
 *   path (string): the page's address.
 *
 * Returns:
 *   boolean: true when a new placeholder takes over from one on screen.
 */
function followsShown(path) {
  return seen.path === path && (seen.visible > 0 || Date.now() - seen.at < FOLLOW_MS);
}
</script>

<script setup>
/******************************************************************/
/*                                                                */
/*  A page's content while it loads, as grey placeholders         */
/*                                                                */
/*  The shape of what comes (the forms' tiles, a table's rows, a  */
/*  record's fields, a job's output) in grey bars with a light    */
/*  shimmer, in place of a spinner : the page's layout is already */
/*  there, and the real content takes the same spot. The colours  */
/*  are the theme's (light, dark, colour) ; the shimmer stops for */
/*  a user who asks the system for reduced motion.                */
/*                                                                */
/*  Nothing shows for a short moment first (delay) : the space is */
/*  kept, so a page that loads fast never flashes its placeholders*/
/*  ; one that takes longer shows them, in the same spot. Once    */
/*  placeholders show on a page, the next ones of the same page   */
/*  show at once (the title read, then the record) : they follow  */
/*  each other without a blank moment between.                    */
/*                                                                */
/*  @props:                                                       */
/*      shape: String - the shape of what comes :                 */
/*             'tiles'  the forms page's grid of tiles            */
/*             'table'  a list : its header and rows              */
/*             'lines'  text                                      */
/*             'form'   fields : a label over each field (a form, */
/*                      a record's tab, a settings page)          */
/*             'detail' label and value rows (a profile, checks)  */
/*             'facts'  a job's heading and its framed facts      */
/*             'output' a job's output panel : its toolbar, then  */
/*                      numbered lines                            */
/*             'editor' lines beside a gutter (the designer, the  */
/*                      server log)                               */
/*             'tabs'   a row of tabs, the first one open         */
/*             'inline' one bar in a line of text (a title that   */
/*                      is not known yet)                         */
/*             'badge'  a left menu's count, a grey pill (its     */
/*                      number not known yet)                     */
/*             'buttons' a page's buttons on its title line, each */
/*                      as tall as a button : the line keeps its  */
/*                      height (and its wrap) until they come     */
/*             'login'  the sign-in card's form : the username    */
/*                      and password fields, Sign in, then count  */
/*                      single sign-on buttons (none : 0)         */
/*             'sso'    the single sign-on part alone : the "or"  */
/*                      divider and count buttons                 */
/*      count: Number - how many tiles, rows, fields, lines...    */
/*      delay: Number - milliseconds before anything shows (0 :   */
/*             at once, as the start-up screen)                   */
/*      width: String - the bar's width, for 'inline'             */
/*      widths: Array - the buttons' widths in pixels, for        */
/*              'buttons' (as their labels make them), 'search'   */
/*              for a table's search box ; none : count buttons   */
/*              of usual widths                                   */
/*                                                                */
/*  The fields of 'form' are at most 40rem wide, as the settings  */
/*  pages' ; --af-sk-field-max on a parent changes it (a form's   */
/*  fields take the whole card : none).                           */
/*                                                                */
/******************************************************************/

import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';

// INIT

const { t } = useI18n();

// PROPS

const props = defineProps({
  shape: { type: String, default: 'lines' },
  count: { type: Number, default: 6 },
  delay: { type: Number, default: 150 },
  width: { type: String, default: '8em' },
  widths: { type: Array, default: null },
});

// ------------------------------------------------------------------
// the delay : hidden (its space kept) until it passed, unless placeholders already show on
// this page (seen) - then at once
// ------------------------------------------------------------------
const path = window.location.pathname;
const shown = ref(props.delay <= 0 || followsShown(path));
let timer = null;
let counted = false;
// shown : counted as on screen, for the placeholders that come next on the page
function show() {
  shown.value = true;
  counted = true;
  seen.visible++;
  seen.path = path;
}
onMounted(() => {
  if (shown.value) show();
  else timer = setTimeout(show, props.delay);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  if (!counted) return;
  seen.visible--;
  seen.at = Date.now();
});

// ------------------------------------------------------------------
// the bars' widths : uneven, as real text is, the same on every load
// ------------------------------------------------------------------
const WIDTHS = ['72%', '48%', '85%', '60%', '38%', '66%', '54%', '78%'];
const share = (i) => WIDTHS[i % WIDTHS.length];
// a label is a word or two : a width in rem rather than a share of the row
const LABELS = ['7rem', '10rem', '6rem', '9rem', '12rem', '8rem', '5.5rem', '11rem'];
const label = (i) => LABELS[i % LABELS.length];
// a title line's buttons : Save last, Delete before it, the page's own actions first (Test
// connection, Change password) wider
const button = (i) => (i === props.count ? '5.5rem' : i === props.count - 1 ? '6.5rem' : '10.5rem');
// each a width in pixels, or 'search' : a table's search box (20rem, down to 10rem)
const buttonWidths = computed(() =>
  props.widths
    ? props.widths.map((w) => (w === 'search' ? 'search' : `${w}px`))
    : Array.from({ length: props.count }, (_, i) => button(i + 1)),
);
// a code line's indent, in steps of two characters : the nesting of yaml
const INDENTS = [0, 1, 1, 2, 2, 2, 1, 2, 3, 3, 1, 0, 1, 1, 2, 2];
const indent = (i) => `${INDENTS[i % INDENTS.length] * 1.5}rem`;

// 'inline' and 'badge' sit in a line of text (a title, a menu entry) : a span, the others a block
const inline = computed(() => ['inline', 'badge'].includes(props.shape));
</script>

<template>
  <component
    :is="inline ? 'span' : 'div'"
    class="af-skeleton"
    :class="[`af-skeleton-${shape}`, { 'af-sk-waiting': !shown }]"
    role="status"
    aria-busy="true"
  >
    <span class="visually-hidden">{{ t('common.loading') }}</span>
    <!-- a word of a title : one bar, as tall as the text's small letters -->
    <span v-if="shape === 'badge'" class="af-sk af-sk-badge"></span>
    <span v-else-if="inline" class="af-sk af-sk-inline" :style="{ width }"></span>
    <!-- the forms page : its grid of tiles, an icon square and two lines in each -->
    <div v-else-if="shape === 'tiles'" class="row align-content-stretch g-4">
      <div v-for="i in count" :key="i" class="col-md-6 col-lg-4 col-xxl-3">
        <div class="card h-100 p-4">
          <div class="d-flex gap-3">
            <div class="af-sk af-sk-icon"></div>
            <div class="flex-grow-1">
              <div class="af-sk af-sk-title" :style="{ width: share(i) }"></div>
              <div class="af-sk af-sk-line"></div>
              <div class="af-sk af-sk-line" :style="{ width: share(i + 3) }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- a list : the frame of its table, the header, then rows of three cells -->
    <div v-else-if="shape === 'table'" class="af-sk-table">
      <div class="af-sk-row af-sk-head">
        <div class="af-sk af-sk-cell" style="width: 18%"></div>
        <div class="af-sk af-sk-cell" style="width: 12%"></div>
        <div class="af-sk af-sk-cell" style="width: 26%"></div>
      </div>
      <div v-for="i in count" :key="i" class="af-sk-row">
        <div class="af-sk af-sk-cell" :style="{ width: `calc(${share(i)} * 0.28)` }"></div>
        <div class="af-sk af-sk-cell" :style="{ width: `calc(${share(i + 2)} * 0.18)` }"></div>
        <div class="af-sk af-sk-cell" :style="{ width: `calc(${share(i + 5)} * 0.45)` }"></div>
      </div>
    </div>
    <!-- fields : a label, the field under it, as BsInput lays them out -->
    <div v-else-if="shape === 'form'">
      <div v-for="i in count" :key="i" class="af-sk-field">
        <div class="af-sk af-sk-label" :style="{ width: label(i) }"></div>
        <div class="af-sk af-sk-input"></div>
      </div>
    </div>
    <!-- label and value rows : the label in a column of its own, a line between the rows -->
    <div v-else-if="shape === 'detail'">
      <div v-for="i in count" :key="i" class="af-sk-pair">
        <div class="af-sk-pair-label">
          <div class="af-sk af-sk-cell" :style="{ width: label(i) }"></div>
        </div>
        <div class="af-sk af-sk-cell af-sk-pair-value" :style="{ width: `calc(${share(i + 1)} * 0.6)` }"></div>
      </div>
    </div>
    <!-- a job at a glance : its name and two pills, then its facts in a framed grid -->
    <div v-else-if="shape === 'facts'" class="af-sk-facts-wrap">
      <div class="af-sk-heading">
        <div class="af-sk af-sk-heading-title"></div>
        <div class="af-sk af-sk-pill"></div>
        <div class="af-sk af-sk-pill"></div>
      </div>
      <div class="af-sk-facts">
        <div v-for="i in count" :key="i" class="af-sk-fact">
          <div class="af-sk af-sk-fact-label" :style="{ width: label(i + 2) }"></div>
          <div class="af-sk af-sk-cell" :style="{ width: share(i) }"></div>
        </div>
      </div>
    </div>
    <!-- an output : its panel, the toolbar on top, then numbered lines in a gutter -->
    <div v-else-if="shape === 'output'" class="af-sk-panel">
      <div class="af-sk-toolbar">
        <div class="af-sk af-sk-cell" style="width: 6rem"></div>
        <div class="af-sk af-sk-cell ms-auto" style="width: 5rem"></div>
        <div class="af-sk af-sk-cell" style="width: 5rem"></div>
        <div class="af-sk af-sk-cell" style="width: 6rem"></div>
      </div>
      <div class="af-sk-lines">
        <div v-for="i in count" :key="i" class="af-sk-code">
          <div class="af-sk-gutter"><div class="af-sk af-sk-number"></div></div>
          <div class="af-sk af-sk-mono" :style="{ width: `calc(${share(i * 3)} * 0.9)` }"></div>
        </div>
      </div>
    </div>
    <!-- code : a gutter of line numbers, the lines indented as yaml nests -->
    <div v-else-if="shape === 'editor'" class="af-sk-editor af-sk-lines">
      <div v-for="i in count" :key="i" class="af-sk-code">
        <div class="af-sk-gutter"><div class="af-sk af-sk-number"></div></div>
        <div class="af-sk af-sk-mono" :style="{ marginLeft: indent(i), width: `calc(${share(i * 5)} * 0.55)` }"></div>
      </div>
    </div>
    <!-- buttons : on the title line, each one of its controls (the box itself takes no room) -->
    <template v-else-if="shape === 'buttons'">
      <span
        v-for="(w, i) in buttonWidths"
        :key="i"
        class="af-sk af-sk-button"
        :class="{ 'af-sk-search': w === 'search' }"
        :style="w === 'search' ? null : { width: w }"
      ></span>
    </template>
    <!-- tabs : the page's own tab bar, a grey word in each, the first one open -->
    <ul v-else-if="shape === 'tabs'" class="nav nav-tabs mb-0">
      <li v-for="i in count" :key="i" class="nav-item">
        <span class="nav-link af-sk-tab" :class="{ active: i === 1 }">
          <span class="af-sk af-sk-inline" :style="{ width: label(i + 5) }"></span>
        </span>
      </li>
    </ul>
    <!-- the sign-in card's form (pages/login.vue) : its two fields, Sign in, its single sign-on -->
    <div v-else-if="shape === 'login'">
      <div class="af-sk af-sk-login-field"></div>
      <div class="af-sk af-sk-login-field"></div>
      <div class="af-sk af-sk-login-button"></div>
      <template v-if="count > 0">
        <div class="af-sk-divider">
          <span>{{ t('common.orDivider') }}</span>
        </div>
        <div class="af-sk-sso">
          <div v-for="i in count" :key="i" class="af-sk af-sk-sso-button"></div>
        </div>
      </template>
    </div>
    <!-- the single sign-on part of the sign-in card : the divider, then the providers' buttons -->
    <div v-else-if="shape === 'sso'">
      <div class="af-sk-divider">
        <span>{{ t('common.orDivider') }}</span>
      </div>
      <div class="af-sk-sso">
        <div v-for="i in count" :key="i" class="af-sk af-sk-sso-button"></div>
      </div>
    </div>
    <!-- text -->
    <div v-else>
      <div v-for="i in count" :key="i" class="af-sk af-sk-line" :style="{ width: share(i) }"></div>
    </div>
  </component>
</template>

<style scoped>
/* ------------------------------------------------------------------ */
/* a bar : the theme's secondary background, a lighter band sweeping  */
/* across it                                                          */
/* ------------------------------------------------------------------ */
.af-sk {
  border-radius: 0.375rem;
  background: linear-gradient(90deg, var(--bs-secondary-bg) 0%, var(--bs-tertiary-bg) 40%, var(--bs-secondary-bg) 80%);
  background-size: 300% 100%;
  animation: af-sk-shimmer 1.4s ease-in-out infinite;
}
@keyframes af-sk-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .af-sk {
    animation: none;
  }
}
/* the delay : the space taken, nothing seen */
.af-sk-waiting {
  visibility: hidden;
}
/* ------------------------------------------------------------------ */
/* the tiles and text                                                 */
/* ------------------------------------------------------------------ */
.af-sk-icon {
  width: 3rem;
  height: 3rem;
  flex-shrink: 0;
}
.af-sk-title {
  height: 1rem;
  margin-bottom: 0.9rem;
}
.af-sk-line {
  height: 0.75rem;
  margin-bottom: 0.6rem;
}
/* ------------------------------------------------------------------ */
/* a list's frame, as the tables' (af-list-frame)                     */
/* ------------------------------------------------------------------ */
.af-sk-table {
  border: 1px solid var(--bs-border-color);
  border-radius: 0.375rem;
  overflow: hidden;
}
.af-sk-row {
  display: flex;
  gap: 2rem;
  align-items: center;
  padding: 0.85rem 1rem;
  border-top: 1px solid var(--bs-border-color);
}
.af-sk-head {
  border-top: 0;
  background: var(--bs-tertiary-bg);
}
.af-sk-cell {
  height: 0.75rem;
}
/* ------------------------------------------------------------------ */
/* a field : the label's line (24px and its 8px margin), the field    */
/* (38px) and the 16px under it, as BsInput's                         */
/* ------------------------------------------------------------------ */
.af-sk-field {
  margin-bottom: 1rem;
}
.af-sk-field:last-child {
  margin-bottom: 0;
}
.af-sk-label {
  height: 0.8rem;
  margin: 0.35rem 0 0.85rem;
}
.af-sk-input {
  height: 2.375rem;
  max-width: var(--af-sk-field-max, 40rem);
}
/* ------------------------------------------------------------------ */
/* label and value rows                                               */
/* ------------------------------------------------------------------ */
.af-sk-pair {
  display: flex;
  align-items: center;
  min-height: 3.5rem;
  border-top: 1px solid var(--bs-border-color);
}
.af-sk-pair:first-child {
  border-top: 0;
}
.af-sk-pair-label {
  flex: 0 0 12rem;
}
.af-sk-pair-label .af-sk {
  max-width: calc(100% - 1.5rem);
}
.af-sk-pair-value {
  flex: 0 1 auto;
}
/* ------------------------------------------------------------------ */
/* a job's facts : the grid of its summary (pages/jobs.vue)           */
/* ------------------------------------------------------------------ */
.af-sk-facts-wrap {
  margin-bottom: 1.25rem;
}
.af-sk-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  min-height: 2.25rem;
}
.af-sk-heading-title {
  width: 16rem;
  height: 1.4rem;
  margin-right: 0.25rem;
}
.af-sk-pill {
  width: 4rem;
  height: 1.2rem;
  border-radius: 1rem;
}
.af-sk-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  overflow: hidden;
}
.af-sk-fact {
  padding: 0.95rem 1.125rem 1.1rem;
  box-shadow:
    -1px 0 0 var(--bs-border-color),
    0 -1px 0 var(--bs-border-color);
}
.af-sk-fact-label {
  height: 0.6rem;
  margin-bottom: 0.85rem;
}
/* ------------------------------------------------------------------ */
/* an output's panel and code lines                                   */
/* ------------------------------------------------------------------ */
.af-sk-panel {
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  overflow: hidden;
}
.af-sk-toolbar {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  height: 2.75rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--bs-border-color);
  background: var(--bs-tertiary-bg);
}
.af-sk-code {
  display: flex;
  align-items: center;
  height: 1.3rem;
}
.af-sk-gutter {
  flex: 0 0 4rem;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 1rem;
  margin-right: 0.75rem;
  border-right: 1px solid var(--bs-border-color);
}
.af-sk-lines {
  padding: 0.5rem 0;
}
.af-sk-number {
  width: 1rem;
  height: 0.6rem;
}
.af-sk-mono {
  height: 0.65rem;
  border-radius: 0.2rem;
}
/* the designer's editor : the card's height, the lines cut at its bottom */
.af-sk-editor {
  flex: 1 1 auto;
  min-height: 12rem;
  overflow: hidden;
}
.af-skeleton-editor {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
/* ------------------------------------------------------------------ */
/* the sign-in card : its floating fields (58px and the 16px under),  */
/* Sign in (42px), the divider and the providers' buttons, as         */
/* pages/login.vue lays them out                                      */
/* ------------------------------------------------------------------ */
.af-sk-login-field {
  height: 58px;
  margin-bottom: 1rem;
}
.af-sk-login-button {
  height: 42px;
}
/* the divider's "or" is the card's own word (it is not data) */
.af-sk-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--bs-secondary-color);
  font-size: 0.875rem;
  margin: 1.25rem 0 1rem;
  &::before,
  &::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--af-field-border);
  }
}
.af-sk-sso {
  display: flex;
  justify-content: center;
  gap: 0.75rem;
}
.af-sk-sso-button {
  width: 4.5rem;
  height: 3rem;
}
/* ------------------------------------------------------------------ */
/* a menu's count : the size of its pill (AppMenuBadge) with one or   */
/* two digits                                                         */
/* ------------------------------------------------------------------ */
.af-skeleton-badge {
  display: inline-flex;
  flex-shrink: 0;
}
.af-sk-badge {
  display: inline-block;
  width: 2.25rem;
  height: 18px;
  border-radius: 50rem;
  /* on the menu's own grey (tertiary) : the border's grey, to be seen there */
  background-image: linear-gradient(
    90deg,
    var(--bs-border-color) 0%,
    var(--bs-secondary-bg) 40%,
    var(--bs-border-color) 80%
  );
}
/* ------------------------------------------------------------------ */
/* a page's buttons : the controls of the title line (.af-title-      */
/* controls), its box taking no room, each bar a button's height      */
/* ------------------------------------------------------------------ */
.af-skeleton-buttons {
  display: contents;
}
.af-sk-button {
  display: inline-block;
  /* a button's height (Bootstrap's : its line, its padding, its border), whatever the font around */
  height: calc(1.5rem + 0.75rem + 2px);
  min-width: 6rem;
}
/* a table's search box on the title line : as .af-table-search (styles/tables.scss) */
.af-sk-search {
  flex: 1 1 8rem;
  max-width: 20rem;
  min-width: 8rem;
}
/* ------------------------------------------------------------------ */
/* a tab and a word of a title                                        */
/* ------------------------------------------------------------------ */
.af-sk-tab {
  cursor: default;
}
.af-sk-inline {
  display: inline-block;
  height: 0.7em;
  vertical-align: middle;
}
</style>
