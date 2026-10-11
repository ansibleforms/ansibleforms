<script setup>
/******************************************************************/
/*                                                                */
/*  Bootstrap Search component                                    */
/*  A search box : a magnifying glass, the input, and an X that   */
/*  clears it once something is typed. The placeholder hides as   */
/*  soon as the box is focused.                                   */
/*                                                                */
/*  @model: String - the search text                              */
/*                                                                */
/*  @props:                                                       */
/*      placeholder: String                                       */
/*                                                                */
/******************************************************************/

import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

// MODEL & PROPS

const search = defineModel({ type: String, default: '' });

defineProps({
  placeholder: { type: String, default: '' },
  // the icon in the grey box at the left : a magnifier, or a filter for a regex
  icon: { type: String, default: 'search' },
});

// INIT

const { t } = useI18n();
const input = ref(null);

// METHODS

// empty the box and keep the cursor in it, to type the next search right away
function clear() {
  search.value = '';
  input.value?.focus();
}
</script>

<template>
  <div class="input-group af-search">
    <span class="input-group-text">
      <FaIcon :icon="icon" />
    </span>
    <input
      ref="input"
      v-model="search"
      type="text"
      class="form-control"
      :class="{ 'af-search-has-clear': search }"
      :placeholder="placeholder"
      @keydown.esc="clear"
    />
    <button
      v-if="search"
      type="button"
      class="btn af-search-clear"
      :title="t('common.clear')"
      :aria-label="t('common.clear')"
      @click="clear"
    >
      <FaIcon icon="xmark" />
    </button>
  </div>
</template>

<style scoped>
/* the magnifying glass in the normal text color (the muted grey is all but invisible) */
.input-group-text {
  color: var(--bs-body-color);
}
/* the placeholder only says what to type : it goes as soon as the box is focused (the
   themes set the placeholder color with !important, see bootstrap-override.scss) */
.form-control:focus::placeholder {
  color: transparent !important;
}
/* the X inside the input, over its right padding, with no border of its own : the input's border
   goes around the whole box in every theme and state (resting, focused, typed in), so the X can
   never show another border than the input's */
.af-search-has-clear {
  padding-right: 2.25rem;
  /* the end of the box : its round corners, which Bootstrap takes from a field followed by
     something in its group (here the X, laid over it) */
  border-top-right-radius: var(--bs-border-radius) !important;
  border-bottom-right-radius: var(--bs-border-radius) !important;
}
.af-search-clear {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  border: 0;
  background: transparent;
  color: var(--bs-secondary-color);
  padding: 0 0.75rem;
}
.af-search-clear:hover {
  color: var(--bs-body-color);
}
</style>
