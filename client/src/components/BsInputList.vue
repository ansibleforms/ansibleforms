<script setup>
/********************************************************/
/*                                                      */
/*  Bootstrap Input List Component                      */
/*  A field of several values, one per input (an LDAP   */
/*  directory's servers) : each with its X (the last    */
/*  one left is emptied, not removed), and an add       */
/*  button under the last. The value is one text, the   */
/*  values comma separated, as it is stored.            */
/*                                                      */
/*  @model: String - the values, comma separated        */
/*                                                      */
/*  @props:                                             */
/*      label, help, icon, placeholder, required,       */
/*      disabled, hasError, errors - as BsInput's       */
/*      addLabel: String - the add button's text        */
/*                                                      */
/********************************************************/
import { ref, watch, getCurrentInstance } from 'vue';
import { useI18n } from 'vue-i18n';

const model = defineModel({ type: String, default: '' });
defineProps({
  label: { type: String, default: '' },
  help: { type: String, default: '' },
  icon: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  required: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  hasError: { type: Boolean, default: false },
  errors: { type: Array, default: () => [] },
  addLabel: { type: String, default: '' },
});
const { t } = useI18n();
const { uid } = getCurrentInstance();

/**
 * The values of the stored text : one per comma (or space), at least one input.
 *
 * Args:
 *   text (string): the values, comma separated.
 *
 * Returns:
 *   string[]: the values.
 */
function split(text) {
  const values = String(text ?? '')
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length ? values : [''];
}

// the inputs, kept as typed (an empty one added stays until it is filled or removed)
const values = ref(split(model.value));
// the stored text changed from outside (the record read again) : the inputs follow
watch(model, (text) => {
  if (text !== join(values.value)) values.value = split(text);
});

/**
 * The stored text of the inputs : the filled ones, comma separated.
 *
 * Args:
 *   list (string[]): the inputs.
 *
 * Returns:
 *   string: the text.
 */
function join(list) {
  return list
    .map((v) => v.trim())
    .filter(Boolean)
    .join(', ');
}

function update(index, value) {
  values.value[index] = value;
  model.value = join(values.value);
}
function add() {
  values.value.push('');
}
// the X of a value : that input removed ; the last one left is emptied, never removed
function remove(index) {
  if (values.value.length > 1) values.value.splice(index, 1);
  else values.value[0] = '';
  model.value = join(values.value);
}
</script>
<template>
  <div class="mb-3">
    <label :for="`${uid}-0`" class="form-label fw-bold"
      >{{ label }}<span v-if="required" class="text-danger ms-1">*</span></label
    >
    <div>
      <div v-for="(value, i) in values" :key="i" class="input-group af-input-list-row">
        <span v-if="icon" class="input-group-text text-gray-500">
          <FaIcon :fixedwidth="true" :icon="icon" />
        </span>
        <input
          :id="`${uid}-${i}`"
          :value="value"
          type="text"
          class="form-control"
          :class="{ 'is-invalid': hasError && !value }"
          :placeholder="placeholder"
          :disabled="disabled"
          @input="update(i, $event.target.value)"
        />
        <button
          type="button"
          class="btn btn-outline-secondary"
          :title="t('common.remove')"
          :aria-label="t('common.remove')"
          :disabled="disabled"
          @click="remove(i)"
        >
          <FaIcon icon="xmark" />
        </button>
      </div>
      <BsButton icon="plus" cssClass="mt-2" :disabled="disabled" @click="add">{{ addLabel }}</BsButton>
      <div v-if="hasError && errors.length > 0" class="invalid-feedback d-block">
        {{ errors[0].$message || errors[0] }}
      </div>
      <div v-if="help" class="form-text">{{ help }}</div>
    </div>
  </div>
</template>
<style scoped>
/* the inputs a little apart, as the rows of a list */
.af-input-list-row + .af-input-list-row {
  margin-top: 0.5rem;
}
</style>
