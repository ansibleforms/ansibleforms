<script setup>
/******************************************************************/
/*                                                                */
/*  A record's type on its page's Type tab, read only : the       */
/*  options as radios, each its label and a few grey words, the   */
/*  record's own checked and none of them clickable. A record     */
/*  keeps the type it was made with (credentials, notification    */
/*  channels, secret stores, SSO providers, runners and an RTE's  */
/*  mode), so every Type tab shows it the same way.               */
/*                                                                */
/*  @props:                                                       */
/*      options: Array - { value, label, hint }, in their order   */
/*      selected: String - the record's value                     */
/*      name: String - the radios' group, unique on the page      */
/*      shown: Function - (value) => boolean : an option shown    */
/*             (the page's search), all by default                */
/*                                                                */
/******************************************************************/
defineProps({
  options: { type: Array, required: true },
  selected: { type: [String, Number, null], default: null },
  name: { type: String, required: true },
  shown: { type: Function, default: () => true },
});
</script>
<template>
  <div
    v-for="option in options"
    v-show="shown(option.value)"
    :key="option.value"
    class="form-check af-short-check af-type-option"
  >
    <input
      :id="`af-${name}-${option.value}`"
      :checked="option.value === selected"
      class="form-check-input"
      type="radio"
      :name="`af-${name}`"
      :value="option.value"
      disabled
    />
    <label class="form-check-label" :for="`af-${name}-${option.value}`">
      <span class="af-short-label">{{ option.label }}</span>
      <span class="text-body-secondary small">{{ option.hint }}</span>
    </label>
  </div>
</template>
