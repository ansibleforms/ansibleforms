<script setup>
/******************************************************************/
/*                                                                */
/*  Bootstrap rrule editor component                              */
/*                                                                */
/*  The iCal rrule a schedule of a schedules repository is timed  */
/*  by, written on one line (DTSTART;TZID=... RRULE:...)          */
/*  : a text box, why it would be refused, and its next three runs */
/*  in its own time zone, as the server works them out            */
/*  (GET /api/v2/schedule/rrule) - the badges of BsCron.          */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the rrule                            */
/*      hasError: Boolean - the field is invalid (red border)     */
/*      end: Object - the schedule's end (lib/scheduleEnd.js      */
/*           endOf) : the runs shown stop at it                   */
/*      runCount: Number - the jobs the schedule started          */
/*      icon: String - an icon before the box, as BsCron's (none  */
/*            when empty)                                         */
/*                                                                */
/*  @emits:                                                       */
/*      update:modelValue: String - the rrule typed               */
/*                                                                */
/******************************************************************/
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import axios from 'axios';
import { useI18n } from 'vue-i18n';
import { rruleProblem } from '@/config/rrule';
import { intlZone } from '@/lib/rruleRules';

const { t, locale } = useI18n();
const emit = defineEmits(['update:modelValue']);
const props = defineProps({
  modelValue: { type: String, default: '' },
  hasError: { type: Boolean, default: false },
  end: { type: Object, default: null },
  runCount: { type: [Number, String], default: 0 },
  icon: { type: String, default: '' },
});

// what the server said : its next runs, its zone, or why it is refused
const next = ref([]);
const zone = ref('');
const serverErrors = ref([]);
const checked = ref(false);
// the schedule's end, not the rule, left fewer runs (or none) : no "never fires" then
const ended = ref(false);
let timer = null;
let asked = 0;

// the reason on the text alone, at once ; the server's after it answered
const textProblem = computed(() => rruleProblem(props.modelValue));
const problem = computed(() => textProblem.value || serverErrors.value[0] || '');

/**
 * The schedule's end as the preview takes it : its date, or its runs and the ones started.
 *
 * Returns:
 *   object: { end_at } or { end_count, run_count } ; {} when it never ends.
 */
function endParams() {
  const e = props.end;
  if (e?.ends === 'date' && e.end_at) return { end_at: new Date(e.end_at).toISOString() };
  if (e?.ends === 'count' && Number(e.end_count) >= 1)
    return { end_count: Number(e.end_count), run_count: Number(props.runCount) || 0 };
  return {};
}

/**
 * Asks the server for the rrule's check and next runs ; an answer to an older text is dropped.
 */
async function preview() {
  const rrule = String(props.modelValue || '').trim();
  const mine = ++asked;
  if (!rrule || textProblem.value) {
    next.value = [];
    serverErrors.value = [];
    checked.value = false;
    return;
  }
  try {
    const res = await axios.get('/api/v2/schedule/rrule', { params: { rrule, ...endParams() } });
    if (mine !== asked) return;
    next.value = (res.data?.next || []).map((d) => new Date(d));
    ended.value = !!res.data?.ended;
    zone.value = res.data?.timezone || '';
    serverErrors.value = res.data?.errors || [];
    checked.value = true;
  } catch {
    if (mine !== asked) return;
    next.value = [];
    serverErrors.value = [];
    checked.value = false;
  }
}

watch(
  () => [props.modelValue, props.end?.ends, props.end?.end_at, props.end?.end_count, props.runCount],
  () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(preview, 300);
  },
);
onMounted(preview);
onUnmounted(() => {
  if (timer) clearTimeout(timer);
  timer = null;
});

// over several years, the year is shown too
const showYear = computed(() => new Set(next.value.map((d) => d.getUTCFullYear())).size > 1);

/**
 * A run as a badge, in the rrule's own zone.
 *
 * Args:
 *   d (Date): the run.
 *
 * Returns:
 *   string: the date and time.
 */
function formatDate(d) {
  const options = {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(showYear.value ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat(locale.value, { ...options, timeZone: intlZone(zone.value || 'UTC') }).format(d);
  } catch {
    return new Intl.DateTimeFormat(locale.value, options).format(d);
  }
}
</script>
<template>
  <div class="bs-rrule">
    <!-- its icon before it (a dialog's field), as BsCron's expression -->
    <div :class="{ 'input-group': icon }">
      <span v-if="icon" class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" :icon="icon" /></span>
      <textarea
        class="form-control font-monospace af-rrule-input"
        :class="{ 'is-invalid': hasError || !!problem }"
        rows="2"
        spellcheck="false"
        :value="modelValue"
        placeholder="DTSTART;TZID=Europe/Brussels:20261020T020000 RRULE:FREQ=DAILY;INTERVAL=1"
        @input="emit('update:modelValue', $event.target.value.replace(/\s*\n\s*/g, ' '))"
      ></textarea>
    </div>
    <small v-if="problem" class="text-danger d-block mt-1">{{
      t('settings.schedules.rruleInvalid', { reason: problem })
    }}</small>
    <small v-else-if="checked && !next.length && !ended" class="text-muted d-block mt-1">{{
      t('settings.schedules.rruleNoRuns')
    }}</small>
    <div v-if="!problem && next.length" class="mt-2">
      <small class="text-muted">{{ t('settings.cron.nextRunsIn', { tz: zone }) }}</small>
      <div class="d-flex flex-wrap gap-2 mt-1">
        <span v-for="(run, i) in next" :key="i" class="badge bg-body-secondary text-body-secondary border">
          {{ formatDate(run) }}
        </span>
      </div>
    </div>
  </div>
</template>
<style scoped>
/* the frame of BsCron */
.bs-rrule {
  border: 1px solid var(--bs-border-color);
  border-radius: 0.375rem;
  padding: 0.75rem;
  background-color: var(--bs-body-bg);
}
.af-rrule-input {
  font-size: 0.875rem;
  resize: vertical;
}
</style>
