/******************************************************************/
/*                                                                */
/*  useWizard : the steps of a New dialog walked as a wizard      */
/*                                                                */
/*  The pattern of the list pages' wizards (AppAdminMulti) : the  */
/*  step shown, the furthest one reached, Previous always, Next   */
/*  only when the step shown is valid and never past the step     */
/*  after the furthest reached, Save on the last step. Drawn with */
/*  AppWizardSteps (the step strip goes back to the steps        */
/*  reached).                                                     */
/*                                                                */
/******************************************************************/
import { ref, computed, unref } from 'vue';

/**
 * A wizard over a list of steps.
 *
 * Args:
 *   steps (Ref<object[]>|object[]): the steps, [{ key, label }], in their order.
 *   canLeave (Function): (step) => boolean, whether the step shown may be left forward ; it
 *     shows why not itself (an error under a field).
 *
 * Returns:
 *   object: { stepIndex, stepReached, step, isLastStep, goToStep, reset }.
 */
export function useWizard(steps, canLeave = () => true) {
  // the step shown, and the furthest step reached : the strip goes back to those, not past them
  const stepIndex = ref(0);
  const stepReached = ref(0);
  const count = computed(() => unref(steps).length);
  // the step shown ({ key, label })
  const step = computed(() => unref(steps)[stepIndex.value]);
  // Save on the last step only
  const isLastStep = computed(() => stepIndex.value === count.value - 1);

  /**
   * Moves to a step : forward only when the step shown may be left, and never past the step
   * after the furthest one reached ; back always.
   *
   * Args:
   *   index (number): the step to show.
   *
   * Returns:
   *   boolean: whether the step shown is now that one.
   */
  function goToStep(index) {
    if (index < 0 || index >= count.value) return false;
    if (index === stepIndex.value) return true;
    if (index > stepIndex.value) {
      if (!canLeave(step.value)) return false;
      if (index > stepReached.value + 1) return false;
    }
    stepIndex.value = index;
    stepReached.value = Math.max(stepReached.value, index);
    return true;
  }

  /**
   * Back to the first step, none reached past it (a new dialog).
   */
  function reset() {
    stepIndex.value = 0;
    stepReached.value = 0;
  }

  return { stepIndex, stepReached, step, isLastStep, goToStep, reset };
}
