<script setup>
/******************************************************************/
/*                                                                */
/*  How a schedule ends : its page's Schedule tab                 */
/*  (pages/schedule.vue) and the New schedule wizard              */
/*  (config/settings.js). Timed by a cron or a rrule : Ends -     */
/*  never, on a date (its picker under it, with its time zone) or */
/*  after a number of runs (AppEndChoice, as a stored job's       */
/*  removal) - then, once it ends, Disable it or Remove it. A     */
/*  one-time run : only the switch Remove after it runs. The      */
/*  server checks it again (lib/scheduleEnd.js).                  */
/*                                                                */
/*  @props:                                                       */
/*    modelValue  { ends, end_at, end_count, end_action,          */
/*                remove_after_run } (lib/scheduleEnd.js endOf)   */
/*    once        timed by a one-time run                         */
/*    repository  a schedules repository's : only ever disabled   */
/*    runCount    the jobs it started (none : a new schedule)     */
/*    disabled    nothing changes                                 */
/*    labelClass  the titles' classes                             */
/*                                                                */
/******************************************************************/
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const props = defineProps({
  modelValue: { type: Object, required: true },
  once: { type: Boolean, default: false },
  repository: { type: Boolean, default: false },
  runCount: { type: [Number, String], default: null },
  disabled: { type: Boolean, default: false },
  labelClass: { type: String, default: 'form-label fw-bold' },
});
const emit = defineEmits(['update:modelValue']);

// the ids of its inputs and its radio group's name, two of them on one page never mixed
const uid = `af-schedule-end-${useId()}`;

/**
 * Sets one part of the end, the rest kept.
 *
 * Args:
 *   key (string): ends, end_at, end_count, end_action or remove_after_run.
 *   value (any): its value.
 */
function set(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

// the words of Ends' three choices
const labels = computed(() => ({
  never: t('settings.schedules.endsNever'),
  date: t('settings.schedules.endsOnDate'),
  count: t('settings.schedules.endsAfter'),
  unit: t('settings.schedules.endsRuns'),
  countAria: t('settings.schedules.endsCount'),
}));
// after a number of runs : how many it started so far (a schedule that exists)
const help = computed(() =>
  props.modelValue.ends === 'count' && props.runCount !== null && props.runCount !== undefined
    ? t('settings.schedules.endsRunsSoFar', { n: Number(props.runCount) || 0 })
    : '',
);
// what happens once it ends : turned off, or removed
const ACTIONS = computed(() => [
  { value: 'disable', label: t('settings.schedules.endDisable') },
  { value: 'remove', label: t('settings.schedules.endRemove') },
]);
</script>

<template>
  <!-- a one-time run : removed after its run or kept, turned off ; its title above it -->
  <div v-if="once">
    <label :class="[labelClass, 'd-block']" :for="uid + '-remove'">{{ t('settings.schedules.removeAfterRun') }}</label>
    <div class="form-check form-switch mb-0">
      <input
        :id="uid + '-remove'"
        class="form-check-input"
        type="checkbox"
        role="switch"
        :checked="modelValue.remove_after_run"
        :disabled="disabled"
        @change="(e) => set('remove_after_run', e.target.checked)"
      />
    </div>
    <div class="form-text">
      {{ repository ? t('settings.schedules.removeAfterRunRepository') : t('settings.schedules.removeAfterRunHelp') }}
    </div>
  </div>
  <!-- timed by a cron or a rrule : when it ends, then what happens -->
  <div v-else>
    <AppEndChoice
      :mode="modelValue.ends"
      :date="modelValue.end_at"
      :count="modelValue.end_count"
      :title="t('settings.schedules.ends')"
      :labels="labels"
      :help="help"
      :disabled="disabled"
      :labelClass="labelClass"
      @update:mode="(v) => set('ends', v)"
      @update:date="(v) => set('end_at', v)"
      @update:count="(v) => set('end_count', v)"
    />
    <div v-if="modelValue.ends !== 'never'" class="mt-3">
      <div :class="labelClass">{{ t('settings.schedules.endAction') }}</div>
      <div role="radiogroup" :aria-label="t('settings.schedules.endAction')">
        <div v-for="a in ACTIONS" :key="a.value" class="form-check af-end-row">
          <input
            :id="uid + '-' + a.value"
            class="form-check-input"
            type="radio"
            :name="uid + '-action'"
            :checked="modelValue.end_action === a.value"
            :disabled="disabled"
            @change="set('end_action', a.value)"
          />
          <label class="form-check-label" :for="uid + '-' + a.value">{{ a.label }}</label>
        </div>
      </div>
      <!-- a repository's : its file manages it, an end only disables it -->
      <div v-if="repository && modelValue.end_action === 'remove'" class="form-text">
        {{ t('settings.schedules.endRepositoryHint') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* each choice a row of the same height, as Ends' own (AppEndChoice) */
.af-end-row {
  display: flex;
  align-items: center;
  min-height: 2rem;
  margin-bottom: 0;
}
/* the radio in the row's middle, as Bootstrap floats it otherwise */
.af-end-row .form-check-input {
  margin-top: 0;
}
/* its label where Bootstrap puts it beside a floated radio */
.af-end-row .form-check-label {
  margin-left: 0.5em;
}
</style>
