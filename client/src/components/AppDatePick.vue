<script setup>
/******************************************************************/
/*                                                                */
/*  A year, a month and a day as three dropdowns, the first       */
/*  controls of a page's filter row : the Server log's day, the   */
/*  Audit log's period. The months are named in the page's        */
/*  language (Intl), the days are those of the chosen month       */
/*  (February 29 in a leap year only), and a day beyond a new     */
/*  month's length becomes its last day.                          */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: Object - { year, month, day }, numbers, or     */
/*                  null for All                                  */
/*      years: Array - the years offered, in the order shown      */
/*      allowAll: Boolean - each dropdown starts with All : the   */
/*                  month only once a year is chosen, the day     */
/*                  once a month is ; without it, always a day    */
/*                                                                */
/*  @emits:                                                       */
/*      update:modelValue - the new pick                          */
/*      change - the new pick, once the person changed one        */
/*                                                                */
/******************************************************************/
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { clampPick, daysInMonth, monthNames } from '@/lib/datePick';

const props = defineProps({
  modelValue: { type: Object, default: () => ({ year: null, month: null, day: null }) },
  years: { type: Array, default: () => [] },
  allowAll: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'change']);

const { t, locale } = useI18n();

// the pick, made whole (a finer part goes with a coarser All)
const pick = computed(() => clampPick(props.modelValue));
// the months in the page's language, January first
const months = computed(() => monthNames(locale.value));
// the days of the chosen month : none while no month is chosen
const days = computed(() => {
  const { year, month } = pick.value;
  if (year === null || month === null) return [];
  return Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1);
});
// the years offered, the chosen one included even when the list does not have it
const yearOptions = computed(() => {
  const list = [...props.years];
  const year = pick.value.year;
  if (year !== null && !list.includes(year)) list.unshift(year);
  return list;
});

/**
 * Sets one part of the pick and hands the whole pick on : a coarser part set to All clears
 * the finer ones, and a day beyond the new month's length becomes its last day.
 *
 * Args:
 *   part (string): 'year', 'month' or 'day'.
 *   raw (string): the dropdown's value ; '' for All.
 */
function set(part, raw) {
  // step 1 : the value as a number, or null for All
  const value = raw === '' ? null : Number(raw);
  // step 2 : the new pick, its finer parts cleared with a coarser All
  const next = { ...pick.value, [part]: value };
  if (part === 'year' && value === null) Object.assign(next, { month: null, day: null });
  if (part === 'month' && value === null) next.day = null;
  // step 3 : made whole (the day clamped to its month) and handed on
  const whole = clampPick(next);
  emit('update:modelValue', whole);
  emit('change', whole);
}
</script>

<template>
  <!-- three compact dropdowns, as wide as their longest option, on the filter row -->
  <div class="d-flex align-items-center gap-2 af-date-pick">
    <select
      class="form-select"
      style="width: auto"
      :aria-label="t('datePick.year')"
      :value="pick.year ?? ''"
      @change="set('year', $event.target.value)"
    >
      <option v-if="allowAll" value="">{{ t('datePick.allYears') }}</option>
      <option v-for="y in yearOptions" :key="'y-' + y" :value="y">{{ y }}</option>
    </select>
    <select
      class="form-select"
      style="width: auto"
      :aria-label="t('datePick.month')"
      :value="pick.month ?? ''"
      :disabled="pick.year === null"
      @change="set('month', $event.target.value)"
    >
      <option v-if="allowAll" value="">{{ t('datePick.allMonths') }}</option>
      <option v-for="(name, i) in months" :key="'m-' + i" :value="i + 1">{{ name }}</option>
    </select>
    <select
      class="form-select"
      style="width: auto"
      :aria-label="t('datePick.day')"
      :value="pick.day ?? ''"
      :disabled="pick.month === null"
      @change="set('day', $event.target.value)"
    >
      <option v-if="allowAll" value="">{{ t('datePick.allDays') }}</option>
      <option v-for="d in days" :key="'d-' + d" :value="d">{{ d }}</option>
    </select>
  </div>
</template>
