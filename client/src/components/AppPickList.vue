<script setup>
/******************************************************************/
/*                                                                */
/*  A list of things picked one by one : a dropdown per pick,     */
/*  with its icon on the left and its red X on the right, and an  */
/*  Add button on its own line under them. The look of the New    */
/*  role wizard's Users and Groups steps (AppRoleEditor). Used by */
/*  the New group wizard for its users and its roles.             */
/*                                                                */
/*  @model: Array - the values picked, in their order             */
/*  @props:                                                       */
/*      choices: Array - [{ value, label }] that can be picked    */
/*      icon: String - the icon left of each dropdown             */
/*      addLabel: String - the Add button's text ("Add user")     */
/*      emptyText: String - what is said while nothing is picked */
/*                                                                */
/******************************************************************/

import { computed } from 'vue';

const props = defineProps({
  choices: { type: Array, default: () => [] },
  icon: { type: String, default: 'list' },
  addLabel: { type: String, default: '' },
  emptyText: { type: String, default: '' },
});
const picked = defineModel({ type: Array, default: () => [] });

// ─── what is left to pick ─────────────────────────────────────────────────────
// the choices not picked yet : the Add button only while one is left
const left = computed(() => props.choices.filter((c) => !picked.value.includes(c.value)));

/**
 * The choices of one row's dropdown : its own value, and those no other row has.
 *
 * Args:
 *   index (number): the row.
 *
 * Returns:
 *   object[]: the choices, [{ value, label }].
 */
function rowChoices(index) {
  const others = new Set(picked.value.filter((_, i) => i !== index));
  return props.choices.filter((c) => !others.has(c.value));
}

/**
 * Adds a row, on the first choice not picked yet.
 */
function add() {
  if (left.value.length) picked.value = [...picked.value, left.value[0].value];
}

/**
 * Changes the value of a row.
 *
 * Args:
 *   index (number): the row.
 *   value (any): its new value.
 */
function change(index, value) {
  picked.value = picked.value.map((v, i) => (i === index ? value : v));
}

/**
 * Removes a row.
 *
 * Args:
 *   index (number): the row.
 */
function remove(index) {
  picked.value = picked.value.filter((_, i) => i !== index);
}
</script>

<template>
  <p v-if="picked.length === 0" class="text-muted small mb-3">{{ emptyText }}</p>
  <div v-for="(value, index) in picked" :key="index" class="d-flex align-items-center gap-2 mb-2">
    <div class="input-group">
      <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" :icon="icon" /></span>
      <select
        class="form-select"
        :value="value"
        @change="change(index, rowChoices(index)[$event.target.selectedIndex].value)"
      >
        <option v-for="c in rowChoices(index)" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
    </div>
    <button type="button" class="btn btn-outline-danger align-self-stretch af-remove" @click="remove(index)">
      <FaIcon icon="times" />
    </button>
  </div>
  <!-- on its own line under the picks, while there is something left to pick -->
  <div v-if="left.length" :class="[picked.length > 0 ? 'mt-3' : 'mt-1']">
    <BsButton icon="plus" @click="add()">{{ addLabel }}</BsButton>
  </div>
</template>

<style scoped>
/* the remove button of a pick : as tall as the dropdown beside it, and square */
.af-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.75rem;
}
</style>
