<script setup>
/******************************************************************/
/*                                                                */
/*  When something ends : one choice of three - never, on a date */
/*  (its date and time picker under it, with its time zone), or   */
/*  after a number (its field in the line, a word after it).      */
/*  Shared by the stored jobs' removal (AppStoredJobRemoval : on  */
/*  a date, or when unused for some days) and a schedule's end    */
/*  (AppScheduleEnd : on a date, or after some runs).             */
/*                                                                */
/*  @props:                                                       */
/*    mode        the choice : values.never, .date or .count      */
/*    date        the date, a moment sent as UTC                  */
/*    count       the number                                      */
/*    values      the choice's three values (never, date, count)  */
/*    title       the group's title ; none : no title line        */
/*    labels      { never, date, count (before the number), unit  */
/*                (after it), countAria (the number's name) }     */
/*    showNever   never offered                                   */
/*    countMax    the highest number (none : no limit)            */
/*    help        the line under the choices                      */
/*    disabled    nothing changes                                 */
/*    labelClass  its title's classes (bold on a record page)     */
/*                                                                */
/*  @emits:                                                       */
/*    update:mode, update:date, update:count                      */
/*                                                                */
/******************************************************************/
import { useId } from 'vue';

const props = defineProps({
  mode: { type: String, default: '' },
  date: { type: [String, Date], default: '' },
  count: { type: [Number, String], default: '' },
  values: { type: Object, default: () => ({ never: 'never', date: 'date', count: 'count' }) },
  title: { type: String, default: '' },
  labels: { type: Object, required: true },
  showNever: { type: Boolean, default: true },
  countMax: { type: [Number, String], default: null },
  help: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  labelClass: { type: String, default: 'form-label' },
});
const emit = defineEmits(['update:mode', 'update:date', 'update:count']);

// a radio group's name of its own, two of them on one page never mixed
const uid = `af-end-${useId()}`;
</script>

<template>
  <div>
    <div v-if="title" :class="labelClass">{{ title }}</div>
    <div role="radiogroup" :aria-label="title || undefined">
      <!-- never -->
      <div v-if="showNever" class="form-check af-end-row">
        <input
          :id="uid + '-never'"
          class="form-check-input"
          type="radio"
          :name="uid"
          :checked="mode === props.values.never"
          :disabled="disabled"
          @change="emit('update:mode', props.values.never)"
        />
        <label class="form-check-label" :for="uid + '-never'">{{ labels.never }}</label>
      </div>
      <!-- on a date : its picker under it once chosen -->
      <div class="form-check af-end-row">
        <input
          :id="uid + '-date'"
          class="form-check-input"
          type="radio"
          :name="uid"
          :checked="mode === props.values.date"
          :disabled="disabled"
          @change="emit('update:mode', props.values.date)"
        />
        <label class="form-check-label" :for="uid + '-date'">{{ labels.date }}</label>
      </div>
      <div v-if="mode === props.values.date" class="af-end-date mb-3">
        <BsDateTime
          :modelValue="date"
          icon="calendar"
          dateType="datetime"
          :convertToUtc="true"
          teleport
          :disabled="disabled"
          @update:modelValue="(v) => emit('update:date', v)"
        />
      </div>
      <!-- after a number : the number in the line -->
      <div class="form-check af-end-row">
        <input
          :id="uid + '-count'"
          class="form-check-input"
          type="radio"
          :name="uid"
          :checked="mode === props.values.count"
          :disabled="disabled"
          @change="emit('update:mode', props.values.count)"
        />
        <label class="form-check-label" :for="uid + '-count'">{{ labels.count }}</label>
        <input
          :value="count"
          type="number"
          min="1"
          :max="countMax || undefined"
          step="1"
          class="form-control form-control-sm af-end-count mx-2"
          :aria-label="labels.countAria"
          :disabled="disabled || mode !== props.values.count"
          @input="(e) => emit('update:count', e.target.value)"
        />
        <span>{{ labels.unit }}</span>
      </div>
    </div>
    <div v-if="help" class="form-text">{{ help }}</div>
  </div>
</template>

<style scoped>
/* every choice a row of the same height, the one with the number's field in it : the same space
   between them whichever is chosen */
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
/* its label where Bootstrap puts it beside a floated radio : the radio no longer floats in the
   row, so it takes back the space Bootstrap leaves between them */
.af-end-row .form-check-label {
  margin-left: 0.5em;
}
/* the date under its choice, in line with the choices' labels */
.af-end-date {
  margin-left: 1.5rem;
  margin-top: 0.25rem;
}
/* the number : a few digits */
.af-end-count {
  width: 5.5rem;
}
</style>
