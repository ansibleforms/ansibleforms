<script setup>
/*****************************************************/
/*                                                   */
/*  Bootstrap Radio Choice Component                 */
/*                                                   */
/*  One choice among a few options, each its label   */
/*  and a few grey words (hint) : what a credential  */
/*  signs in with (Entra ID : Client secret or       */
/*  Certificate ; SSH : Password or Private key).     */
/*                                                   */
/*  @model: the value chosen                         */
/*  @props:                                          */
/*      options: Array - { value, label, hint }      */
/*      name: String - the radio group's name, its   */
/*          inputs' ids made from it                 */
/*      title: String - a label above the options    */
/*          (none : no title)                        */
/*      shown: Function - (option) => Boolean, an    */
/*          option hidden when false (a search)      */
/*      disabled: Boolean - every option disabled    */
/*                                                   */
/*****************************************************/

// MODEL

const model = defineModel();

// PROPS

defineProps({
  options: {
    type: Array,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    default: '',
  },
  shown: {
    type: Function,
    default: () => true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
});

/**
 * The id of an option's input : the group's name and the option's value.
 *
 * Args:
 *   name (string): the radio group's name.
 *   value (*): the option's value.
 *
 * Returns:
 *   string: the id.
 */
function inputId(name, value) {
  return `af-radio-${name}-${value}`;
}
</script>

<template>
  <div class="mb-3 af-radio-choice" role="radiogroup" :aria-label="title || name">
    <label v-if="title" class="form-label">{{ title }}</label>
    <!-- each option its label, then its hint in a column of their own -->
    <div v-for="opt in options" v-show="shown(opt)" :key="String(opt.value)" class="form-check af-short-check">
      <input
        :id="inputId(name, opt.value)"
        v-model="model"
        class="form-check-input"
        type="radio"
        :name="name"
        :value="opt.value"
        :disabled="disabled"
      />
      <label class="form-check-label" :for="inputId(name, opt.value)">
        <span class="af-short-label">{{ opt.label }}</span>
        <span v-if="opt.hint" class="text-body-secondary small">{{ opt.hint }}</span>
      </label>
    </div>
    <slot />
  </div>
</template>

<style scoped>
/* an option among the others : the list tight */
.af-short-check {
  margin-bottom: 0.6rem;
}
/* the labels one width, so their grey hints line up in a column */
.af-short-label {
  display: inline-block;
  min-width: 12rem;
}
</style>
