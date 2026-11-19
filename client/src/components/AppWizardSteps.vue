<script setup>
/******************************************************************/
/*                                                                */
/*  The steps of a wizard dialog : numbered, joined by a line,    */
/*  the one shown in the primary colour, those passed with a      */
/*  check ; a step already reached is clicked to go back to it.   */
/*  The look of the list pages' wizards (AppAdminMulti).          */
/*                                                                */
/*  @props:                                                       */
/*      steps: Array - [{ key, label, count }] ; count, optional, */
/*         a number shown beside the label (a role's users)       */
/*      current: Number - the step shown                          */
/*      reached: Number - the furthest step reached (clickable    */
/*         up to it)                                              */
/*  @emits:                                                       */
/*      go (index) - a reachable step clicked                     */
/*                                                                */
/******************************************************************/

const props = defineProps({
  steps: { type: Array, required: true },
  current: { type: Number, default: 0 },
  reached: { type: Number, default: 0 },
});
const emit = defineEmits(['go']);

/**
 * Goes to a step the user has already reached.
 *
 * Args:
 *   i (number): the step.
 */
function go(i) {
  if (i <= props.reached && i !== props.current) emit('go', i);
}
</script>
<template>
  <ol class="af-wizard-steps mb-0">
    <li
      v-for="(step, i) in steps"
      :key="step.key"
      :class="{ active: i === current, done: i < current, reachable: i <= reached && i !== current }"
      @click="go(i)"
    >
      <span class="af-wizard-n"
        ><FaIcon v-if="i < current" icon="check" /><template v-else>{{ i + 1 }}</template></span
      >
      <span class="af-wizard-label">{{ step.label }}</span>
      <span v-if="step.count !== undefined && step.count !== null" class="badge af-wizard-count">{{ step.count }}</span>
    </li>
  </ol>
</template>
<style scoped>
.af-wizard-steps {
  display: flex;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
  margin-left: 0;
}
.af-wizard-steps li {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.6rem;
  border-bottom: 3px solid var(--bs-border-color);
  color: var(--bs-secondary-color);
  white-space: nowrap;
  min-width: 0;
}
.af-wizard-steps li.reachable {
  cursor: pointer;
}
.af-wizard-steps li.done {
  border-bottom-color: rgba(var(--bs-primary-rgb), 0.45);
  color: var(--bs-body-color);
}
.af-wizard-steps li.active {
  border-bottom-color: var(--bs-primary);
  color: var(--bs-primary);
  font-weight: 600;
}
.af-wizard-n {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 0.8rem;
}
.af-wizard-steps li.active .af-wizard-n {
  background: var(--bs-primary);
  border-color: var(--bs-primary);
  color: #fff;
}
.af-wizard-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* the count of a step : small and grey, as the tabs' counts */
.af-wizard-count {
  flex-shrink: 0;
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
</style>
