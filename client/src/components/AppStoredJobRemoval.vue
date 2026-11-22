<script setup>
/******************************************************************/
/*                                                                */
/*  When a stored job is removed : one choice of three - never,   */
/*  on a date, or when unused for some days (#1437). The Store    */
/*  dialog (form.vue) and the stored job's page (stored-job.vue). */
/*  Never is not offered while the setting STORED_JOB_UNUSED_DAYS */
/*  is above 0, and the days stay at most that many ; a date then */
/*  says the setting's days still remove it (lib/storedJobUnused) */
/*  The choice itself is AppEndChoice's, as a schedule's end.     */
/*                                                                */
/*  @props:                                                       */
/*    modelValue  { mode, expires_at, unused_days } (removalOf)   */
/*    setting     the setting's days (0 : none)                   */
/*    disabled    nothing changes                                 */
/*    labelClass  its title's classes (bold on a record page)     */
/*                                                                */
/******************************************************************/
import { computed } from 'vue';
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

// the words of the three choices
const labels = computed(() => ({
  never: t('settings.storedJobs.removedNever'),
  date: t('settings.storedJobs.removedOnDate'),
  count: t('settings.storedJobs.removedWhenUnused'),
  unit: t('settings.storedJobs.removedDays'),
  countAria: t('settings.storedJobs.unusedDays'),
}));
// its three choices : never, on a date, or when unused for some days
const VALUES = { never: 'never', date: 'date', count: 'unused' };
</script>

<template>
  <!-- never only without a setting ; the days at most the setting's -->
  <AppEndChoice
    :mode="modelValue.mode"
    :date="modelValue.expires_at"
    :count="modelValue.unused_days"
    :values="VALUES"
    :title="t('settings.storedJobs.removed')"
    :labels="labels"
    :showNever="!max"
    :countMax="max || null"
    :help="help"
    :disabled="disabled"
    :labelClass="labelClass"
    @update:mode="choose"
    @update:date="(v) => set('expires_at', v)"
    @update:count="(v) => set('unused_days', v)"
  />
</template>
