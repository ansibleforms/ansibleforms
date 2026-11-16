<script setup>
/******************************************************************/
/*                                                                */
/*  When a stored job is removed : one choice of three - never,   */
/*  on a date, or when unused for some days (#1437). The Store    */
/*  dialog (form.vue) and the stored job's page (stored-job.vue). */
/*  Never is not offered while the setting STORED_JOB_UNUSED_DAYS */
/*  is above 0, and the days stay at most that many ; a date then */
/*  says the setting's days still remove it (lib/storedJobUnused) */
/*                                                                */
/*  @props:                                                       */
/*    modelValue  { mode, expires_at, unused_days } (removalOf)   */
/*    setting     the setting's days (0 : none)                   */
/*    disabled    nothing changes                                 */
/*    labelClass  its title's classes (bold on a record page)     */
/*                                                                */
/******************************************************************/
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { unusedDaysMax } from '@/lib/storedJobUnused';

const { t } = useI18n();
const props = defineProps({
  modelValue: { type: Object, required: true },
  setting: { type: [Number, String], default: 0 },
  disabled: { type: Boolean, default: false },
  labelClass: { type: String, default: 'form-label' },
});
const emit = defineEmits(['update:modelValue']);

// a radio group's name of its own, two of them on one page never mixed
const uid = `af-removal-${useId()}`;
const max = computed(() => unusedDaysMax(props.setting));

/**
 * Sets one part of the removal, the rest kept.
 *
 * Args:
 *   key (string): mode, expires_at or unused_days.
 *   value (any): its value.
 */
function set(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

/**
 * Chooses how it is removed ; the days start at the setting's when there are none yet.
 *
 * Args:
 *   mode (string): never, date or unused.
 */
function choose(mode) {
  const next = { ...props.modelValue, mode };
  if (mode === 'unused' && String(next.unused_days ?? '').trim() === '' && max.value) next.unused_days = max.value;
  emit('update:modelValue', next);
}

// the line under the choices : what the days do, at most the setting's ; a date that the
// setting's days still apply
const help = computed(() => {
  const m = props.modelValue.mode;
  if (m === 'unused')
    return max.value
      ? t('settings.storedJobs.unusedDaysHelpMax', { days: max.value })
      : t('settings.storedJobs.removedHelp');
  if (m === 'date' && max.value) return t('settings.storedJobs.removedAlsoUnused', { days: max.value });
  return '';
});
</script>

<template>
  <div>
    <div :class="labelClass">{{ t('settings.storedJobs.removed') }}</div>
    <!-- never : only without a setting -->
    <div v-if="!max" class="form-check af-removal-row">
      <input
        :id="uid + '-never'"
        class="form-check-input"
        type="radio"
        :name="uid"
        :checked="modelValue.mode === 'never'"
        :disabled="disabled"
        @change="choose('never')"
      />
      <label class="form-check-label" :for="uid + '-never'">{{ t('settings.storedJobs.removedNever') }}</label>
    </div>
    <!-- on a date : its picker under it once chosen -->
    <div class="form-check af-removal-row">
      <input
        :id="uid + '-date'"
        class="form-check-input"
        type="radio"
        :name="uid"
        :checked="modelValue.mode === 'date'"
        :disabled="disabled"
        @change="choose('date')"
      />
      <label class="form-check-label" :for="uid + '-date'">{{ t('settings.storedJobs.removedOnDate') }}</label>
    </div>
    <div v-if="modelValue.mode === 'date'" class="af-removal-date mb-3">
      <BsDateTime
        :modelValue="modelValue.expires_at"
        icon="calendar"
        dateType="datetime"
        :convertToUtc="true"
        teleport
        :disabled="disabled"
        @update:modelValue="(v) => set('expires_at', v)"
      />
    </div>
    <!-- when unused for some days : the number in the line -->
    <div class="form-check af-removal-row">
      <input
        :id="uid + '-unused'"
        class="form-check-input"
        type="radio"
        :name="uid"
        :checked="modelValue.mode === 'unused'"
        :disabled="disabled"
        @change="choose('unused')"
      />
      <label class="form-check-label" :for="uid + '-unused'">{{ t('settings.storedJobs.removedWhenUnused') }}</label>
      <input
        :value="modelValue.unused_days"
        type="number"
        min="1"
        :max="max || undefined"
        step="1"
        class="form-control form-control-sm af-removal-days mx-2"
        :aria-label="t('settings.storedJobs.unusedDays')"
        :disabled="disabled || modelValue.mode !== 'unused'"
        @input="(e) => set('unused_days', e.target.value)"
      />
      <span>{{ t('settings.storedJobs.removedDays') }}</span>
    </div>
    <div v-if="help" class="form-text">{{ help }}</div>
  </div>
</template>

<style scoped>
/* every choice a row of the same height, the one with the days' field in it : the same space
   between them whichever is chosen */
.af-removal-row {
  display: flex;
  align-items: center;
  min-height: 2rem;
  margin-bottom: 0;
}
/* the radio in the row's middle, as Bootstrap floats it otherwise */
.af-removal-row .form-check-input {
  margin-top: 0;
}
/* its label where Bootstrap puts it beside a floated radio : the radio no longer floats in the
   row, so it takes back the space Bootstrap leaves between them */
.af-removal-row .form-check-label {
  margin-left: 0.5em;
}
/* the date under its choice, in line with the choices' labels */
.af-removal-date {
  margin-left: 1.5rem;
  margin-top: 0.25rem;
}
/* the days : a few digits */
.af-removal-days {
  width: 5.5rem;
}
</style>
