<script setup>
/******************************************************************/
/*                                                                */
/*  Bootstrap Switch component                                    */
/*  A switch whose title sits above it, in a bold label of its    */
/*  own : the word beside it says where it stands, "On" or        */
/*  "Off", and changes with it as it is flipped. A switch that    */
/*  already has a text beside it keeps its own markup.            */
/*                                                                */
/*  @model: Boolean - the switch's position, on when truthy       */
/*                                                                */
/*  @props:                                                       */
/*      id: String - the input's id, the one the title above      */
/*          points at with `for` ; one of its own when none       */
/*      disabled: Boolean - shown but not usable : the word       */
/*          beside it is muted, as Bootstrap does                 */
/*      label: String - a text of one's own beside it, in place   */
/*          of "On" and "Off"                                     */
/*                                                                */
/*  @attrs:                                                       */
/*      class, style - on the switch's block (its margins, its    */
/*          alignment in a table cell)                            */
/*      anything else - on the input itself (aria-label, a        */
/*          @change handler that reads $event.target.checked)     */
/*                                                                */
/******************************************************************/

import { computed, useAttrs, useId } from 'vue';
import { useI18n } from 'vue-i18n';

// ------------------------------------------------------------------
// OPTIONS
// ------------------------------------------------------------------

// the attributes are split by hand : class and style on the block, the rest on the input
defineOptions({ inheritAttrs: false });

// ------------------------------------------------------------------
// MODEL & PROPS
// ------------------------------------------------------------------

// no type : a caller may bind a value that is only truthy (a variable's value), as `checked` took
const model = defineModel({ default: false });

const props = defineProps({
  id: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
});

// ------------------------------------------------------------------
// INIT
// ------------------------------------------------------------------

const { t } = useI18n();
const attrs = useAttrs();

// an id of its own when none is given : the word beside it must still point at the input
const ownId = `af-switch-${useId()}`;

// ------------------------------------------------------------------
// COMPUTED
// ------------------------------------------------------------------

/**
 * The input's id : the one given, else one of its own.
 *
 * Returns:
 *   string: the id the input carries and the word beside it points at.
 */
const inputId = computed(() => props.id || ownId);

/**
 * The attributes of the switch's block : the class and the style given to the component.
 *
 * Returns:
 *   object: { class, style }, each only when given.
 */
const blockAttrs = computed(() => {
  const out = {};
  if (attrs.class !== undefined) out.class = attrs.class;
  if (attrs.style !== undefined) out.style = attrs.style;
  return out;
});

/**
 * The attributes of the input : every one given but the class and the style.
 *
 * Returns:
 *   object: the attributes and listeners passed through to the input.
 */
const inputAttrs = computed(() => {
  // eslint-disable-next-line no-unused-vars
  const { class: _class, style: _style, ...rest } = attrs;
  return rest;
});

/**
 * The word beside the switch : the label given, else "On" or "Off" as it stands.
 *
 * Returns:
 *   string: the text of the label beside it.
 */
const word = computed(() => props.label || (model.value ? t('common.switchOn') : t('common.switchOff')));

// ------------------------------------------------------------------
// METHODS
// ------------------------------------------------------------------

/**
 * Follows the input as it is flipped : the model takes its new position, the word with it. A
 * @change handler given to the component runs after, on the same event.
 *
 * Args:
 *   event (Event): the input's change event.
 */
function onChange(event) {
  model.value = event.target.checked;
}
</script>
<template>
  <div class="form-check form-switch" v-bind="blockAttrs">
    <input
      :id="inputId"
      :checked="!!model"
      class="form-check-input"
      type="checkbox"
      role="switch"
      :disabled="disabled"
      @change="onChange"
      v-bind="inputAttrs"
    />
    <label class="form-check-label" :for="inputId">{{ word }}</label>
  </div>
</template>
<style scoped>
/* centred in a table cell (d-flex), the switch is no longer floated : the word keeps the gap
   Bootstrap leaves beside a floated switch */
.form-switch.d-flex {
  column-gap: 0.5em;
}
</style>
