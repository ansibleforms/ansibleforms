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
/*      aligned: Boolean - each option a row like a  */
/*          horizontal form's fields : the radio in  */
/*          the label column (col-sm-2), its hint    */
/*          where their inputs start (col-sm-10)     */
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
  aligned: {
    type: Boolean,
    default: false,
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
    <!-- aligned : each option a row like a horizontal form's fields -->
    <template v-if="aligned">
      <div v-for="opt in options" v-show="shown(opt)" :key="String(opt.value)" class="row af-aligned-radio">
        <div class="col-sm-2">
          <div class="form-check mb-0">
            <input
              :id="inputId(name, opt.value)"
              v-model="model"
              class="form-check-input"
              type="radio"
              :name="name"
              :value="opt.value"
              :disabled="disabled"
            />
            <label class="form-check-label" :for="inputId(name, opt.value)">{{ opt.label }}</label>
          </div>
        </div>
        <label
          v-if="opt.hint"
          class="col-sm-10 text-body-secondary small af-aligned-hint"
          :for="inputId(name, opt.value)"
          >{{ opt.hint }}</label
        >
      </div>
    </template>
    <!-- not aligned : each option its label, then its hint in a column of their own -->
    <template v-else>
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
    </template>
    <slot />
  </div>
</template>

<style scoped>
/* an option among the others : the list tight */
.af-aligned-radio,
.af-short-check {
  margin-bottom: 0.6rem;
}
/* the hint of an aligned option : on the line of its label */
.af-aligned-hint {
  padding-top: 0.15rem;
}
/* the labels one width, so their grey hints line up in a column */
.af-short-label {
  display: inline-block;
  min-width: 12rem;
}
</style>
