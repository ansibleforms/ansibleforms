<script setup>
/******************************************************************/
/*                                                                */
/*  A credential's dropdown with its New credential button under  */
/*  it, as every screen shows them (the wizards' createWith,      */
/*  AppAdminMulti) : the button on a line of its own below the    */
/*  field, never beside it. A credential made with it is chosen.  */
/*                                                                */
/*  Props                                                         */
/*    modelValue   the credential chosen ('' : none)              */
/*    options      the credentials' names to choose from          */
/*    type         the type a new one gets (registry, ssh...)     */
/*    noneLabel    the empty choice's words                       */
/*    emptyText    with it, no empty choice : this greyed line    */
/*                 when there is no credential, else the first    */
/*                 one chosen when none is                        */
/*    disabled     nothing can be changed                         */
/*    id           the dropdown's id (its label's for)            */
/*                                                                */
/*  Emits                                                         */
/*    update:modelValue  the credential chosen                    */
/*    created            a credential was made (its name) : the   */
/*                       list to read again                       */
/*                                                                */
/******************************************************************/
import { watch } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  type: { type: String, default: '' },
  noneLabel: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  // the New button's words, when the kind says it better than New credential
  newLabel: { type: String, default: '' },
  // the icon in front of the dropdown, as the Designer's fields have
  icon: { type: String, default: '' },
  id: { type: String, default: undefined },
  // a credential is needed : no empty choice, this line (No registries configured yet) when there
  // is none to choose, the first one chosen when none is
  emptyText: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'created']);

// one needed and none chosen while some exist : the first, as the dropdown shows it
watch(
  () => [props.emptyText, props.modelValue, props.options],
  () => {
    if (props.emptyText && !props.modelValue && props.options.length) emit('update:modelValue', props.options[0]);
  },
  { immediate: true },
);

/**
 * A credential just made : said, and chosen.
 *
 * Args:
 *   name (string): its name.
 */
function onCreated(name) {
  emit('created', name);
  emit('update:modelValue', name);
}
</script>

<template>
  <div>
    <!-- its icon in front when it has one, as every field of the Designer -->
    <div :class="{ 'input-group': icon }">
      <span v-if="icon" class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" :icon="icon" /></span>
      <select
        :id="id"
        class="form-select"
        :value="modelValue"
        :disabled="disabled"
        @change="emit('update:modelValue', $event.target.value)"
      >
        <!-- one needed : no empty choice, a greyed line while there is none -->
        <option v-if="emptyText && !options.length" value="" disabled>{{ emptyText }}</option>
        <option v-else-if="!emptyText" value="">{{ noneLabel }}</option>
        <option v-for="name in options" :key="name" :value="name">{{ name }}</option>
      </select>
    </div>
    <!-- a new one, under the dropdown -->
    <div class="mt-2">
      <AppNewCredentialButton :type="type" :label="newLabel" :disabled="disabled" @created="onCreated" />
    </div>
  </div>
</template>
