<script setup>
/******************************************************************/
/*                                                                */
/*  The constants as an outline, as the categories : the          */
/*  designer's visual editor of its constants, beside their YAML, */
/*  on the same text (saved with the designer's Save). A key's    */
/*  ← → ↑ ↓ move it ; → puts it under the key above (then holding */
/*  subkeys, not a value).                                        */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the constants' YAML (a map)          */
/*      readOnly: Boolean - shown, not editable                   */
/*  @emits:                                                       */
/*      update:modelValue - the YAML, rewritten from the table    */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { nextUid, stampUids } from '@/composables/useFormsConfig';
import { useYamlModel } from '@/composables/useYamlModel';
import {
  constantsToArray,
  arrayToConstants,
  flattenConstants,
  constantValueError,
  constantValueRows,
  canMoveConstant,
  moveConstant,
  canIndentConstant,
  indentConstant,
  canOutdentConstant,
  outdentConstant,
} from '@/config/constants';

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

// ─── the YAML as rows ─────────────────────────────────────────────────────────
const { rows: constants, error } = useYamlModel(props, emit, {
  toRows(value) {
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(t('designer.visualNotAMap'));
    }
    const tree = constantsToArray(value || {});
    stampUids(tree, ['children']);
    return tree;
  },
  fromRows: arrayToConstants,
});

const locked = computed(() => props.readOnly || !!error.value);
const flatConstants = computed(() => flattenConstants(constants.value));

/**
 * Whether a row holds subkeys rather than a value.
 *
 * Args:
 *   row (object): the row.
 *
 * Returns:
 *   boolean: true when it has subkeys.
 */
function isParent(row) {
  return row.children && row.children.length > 0;
}

// ─── what would be lost or refused : said here, as the row is typed ──────────
// a row without a key is dropped from the YAML, value and all
const keylessRow = computed(() => {
  const list = flatConstants.value;
  for (let i = 0; i < list.length; i++) if (!(list[i].row.key || '').trim()) return i + 1;
  return null;
});

// two siblings with one key collapse into one
function findDuplicate(rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = (row.key || '').trim();
    if (key) {
      if (seen.has(key)) return key;
      seen.add(key);
    }
    if (isParent(row)) {
      const duplicate = findDuplicate(row.children);
      if (duplicate) return duplicate;
    }
  }
  return null;
}
const duplicateKey = computed(() => findDuplicate(constants.value));

// a value meant as a list or a map that is no valid YAML would be stored as its text
function findInvalidValue(rows) {
  for (const row of rows) {
    if (!isParent(row)) {
      const message = constantValueError(row.value);
      if (message) return { key: (row.key || '').trim(), error: message };
    } else {
      const invalid = findInvalidValue(row.children);
      if (invalid) return invalid;
    }
  }
  return null;
}
const invalidValue = computed(() => findInvalidValue(constants.value));

// ─── editing ──────────────────────────────────────────────────────────────────
const newConstant = ref(null);

// where the dialog's key goes : after a row (its menu's Add key), else at the end of the table
const insertAfter = ref(null);

/**
 * Opens the New constant dialog on an empty constant.
 *
 * Args:
 *   after (object): the row it goes after, at that row's level (its menu's Add key) ; none,
 *     the end of the table (the toolbar's +).
 */
function addConstant(after = null) {
  // the table cannot be edited (read only, or its YAML cannot be read) : nothing added
  if (locked.value) return;
  insertAfter.value = after && after.row ? after : null;
  newConstant.value = { _uid: nextUid(), key: '', value: '', children: [] };
}

/**
 * The list a row is in : the table's, or a parent row's children.
 *
 * Args:
 *   target (object): the row.
 *   list (object[]): the list to look in, the whole table by default.
 *
 * Returns:
 *   object[]|null: its list, or null when it is not in the table.
 */
function listOf(target, list = constants.value) {
  if (list.includes(target)) return list;
  for (const item of list) {
    const found = item.children && listOf(target, item.children);
    if (found) return found;
  }
  return null;
}

/**
 * Adds the dialog's constant (saved with the designer's Save) : right after the row its menu
 * was opened on, or at the end of the table.
 */
function createConstant() {
  const after = insertAfter.value?.row;
  const list = after ? listOf(after) : null;
  if (list) list.splice(list.indexOf(after) + 1, 0, newConstant.value);
  else constants.value.push(newConstant.value);
  newConstant.value = null;
  insertAfter.value = null;
}

/**
 * Removes a row (and its subkeys).
 *
 * Args:
 *   target (object): the row.
 *   list (object[]): the list to look in, the whole table by default.
 *
 * Returns:
 *   boolean: true when it was found and removed.
 */
function removeConstant(target, list = constants.value) {
  const idx = list.indexOf(target);
  if (idx !== -1) {
    list.splice(idx, 1);
    return true;
  }
  return list.some((item) => item.children && removeConstant(target, item.children));
}

/**
 * A row's moves, as the buttons show them : ← out from under its key, → under the key above, ↑ ↓
 * among its own ; each pressable or not.
 *
 * Args:
 *   row (object): the row.
 *
 * Returns:
 *   object[]: [{ icon, title, can, run }].
 */
function moves(row) {
  const ok = !locked.value;
  const tree = constants.value;
  return [
    {
      icon: 'arrow-left',
      title: t('settings.settingsPage.outdentConstant'),
      can: ok && canOutdentConstant(tree, row),
      run: () => outdentConstant(tree, row),
    },
    {
      icon: 'arrow-right',
      title: t('settings.settingsPage.indentConstant'),
      can: ok && canIndentConstant(tree, row),
      run: () => indentConstant(tree, row),
    },
    {
      icon: 'arrow-up',
      title: t('settings.settingsPage.moveUp'),
      can: ok && canMoveConstant(tree, row, -1),
      run: () => moveConstant(tree, row, -1),
    },
    {
      icon: 'arrow-down',
      title: t('settings.settingsPage.moveDown'),
      can: ok && canMoveConstant(tree, row, 1),
      run: () => moveConstant(tree, row, 1),
    },
  ];
}

// the designer's toolbar adds a row (its + button)
defineExpose({ add: addConstant, locked });
</script>
<template>
  <BsModal v-if="newConstant" size="lg" @close="newConstant = null" icon="sliders-h">
    <template #title> {{ t('settings.settingsPage.newConstant') }} </template>
    <template #default>
      <BsInput :isFloating="false" v-model="newConstant.key" :label="t('settings.settingsPage.key')" icon="tag" />
      <label class="form-label fw-bold">{{ t('settings.settingsPage.value') }}</label>
      <div class="input-group">
        <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="pen" /></span>
        <textarea
          class="form-control"
          :rows="Math.max(3, constantValueRows(newConstant.value))"
          v-model="newConstant.value"
          :placeholder="t('settings.settingsPage.constantValuePlaceholder')"
        ></textarea>
      </div>
    </template>
    <template #footer>
      <BsButton icon="plus" :disabled="!newConstant.key.trim()" @click="createConstant()">{{
        t('designer.addConstant')
      }}</BsButton>
    </template>
  </BsModal>
  <div class="af-visual-editor">
    <div v-if="error" class="alert alert-danger py-2 mb-3" role="alert">
      <FaIcon icon="triangle-exclamation" class="me-2" />{{ t('designer.visualYamlError') }} : {{ error }}
    </div>
    <div v-if="!error && keylessRow" class="alert alert-warning py-2 mb-3" role="alert">
      {{ t('settings.settingsPage.constantKeyRequired', { row: keylessRow }) }}
    </div>
    <div v-if="!error && duplicateKey" class="alert alert-warning py-2 mb-3" role="alert">
      {{ t('settings.settingsPage.duplicateConstantKey', { key: duplicateKey }) }}
    </div>
    <div v-if="!error && invalidValue" class="alert alert-warning py-2 mb-3" role="alert">
      {{ t('settings.settingsPage.constantValueInvalid', invalidValue) }}
    </div>
    <div v-if="constants.length === 0" class="empty-state">
      <FaIcon icon="sliders-h" class="empty-state-icon" />
      <span>{{ t('settings.settingsPage.noConstants') }}</span>
    </div>
    <!-- an outline, as the categories : a row per key, its standard fields, its moves as one
         group of buttons (→ puts it under the key above), then Delete -->
    <div v-else class="af-cats">
      <div class="af-cats-row af-cats-head">
        <span>{{ t('settings.settingsPage.key') }}</span>
        <span>{{ t('settings.settingsPage.value') }}</span>
        <span></span>
      </div>
      <div v-for="entry in flatConstants" :key="entry.row._uid" class="af-cats-row">
        <!-- the key, indented with its depth (the nested icon before a subkey) -->
        <div class="d-flex align-items-center" :style="{ paddingLeft: entry.depth * 1.5 + 'rem' }">
          <FaIcon
            v-if="entry.depth > 0"
            icon="level-up-alt"
            class="text-muted me-2 fa-rotate-90"
            style="font-size: 0.75rem"
          />
          <div class="input-group flex-grow-1">
            <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="key" /></span>
            <input
              class="form-control"
              v-model="entry.row.key"
              :disabled="locked"
              :aria-label="t('settings.settingsPage.key')"
            />
          </div>
        </div>
        <!-- a textarea : a list or a map is written as YAML, on several lines ; a key with
             subkeys has no value, it says how many it holds -->
        <textarea
          v-if="!isParent(entry.row)"
          class="form-control"
          :rows="constantValueRows(entry.row.value)"
          v-model="entry.row.value"
          :disabled="locked"
          :placeholder="t('settings.settingsPage.constantValuePlaceholder')"
          :aria-label="t('settings.settingsPage.value')"
        ></textarea>
        <span v-else class="text-muted fst-italic small align-self-center">{{
          t('settings.settingsPage.subkeyCount', entry.row.children.length)
        }}</span>
        <div class="d-flex gap-2 justify-content-end">
          <div class="btn-group" role="group" :aria-label="t('settings.interface.linkMoves')">
            <button
              v-for="m in moves(entry.row)"
              :key="m.icon"
              type="button"
              class="btn af-row-btn"
              :class="m.can ? 'btn-outline-primary' : 'btn-outline-secondary'"
              :disabled="!m.can"
              :title="m.title"
              @click="m.run()"
            >
              <FaIcon :icon="m.icon" />
            </button>
          </div>
          <button
            type="button"
            class="btn af-row-btn"
            :class="!locked ? 'btn-outline-danger' : 'btn-outline-secondary'"
            :disabled="locked"
            :title="t('common.delete')"
            @click="removeConstant(entry.row)"
          >
            <FaIcon icon="trash" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped lang="scss">
/* the outline : one row each, the same columns for the header line, as the categories' ; a pane
   narrower than them scrolls sideways rather than squeezing the fields */
.af-cats {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}
.af-cats-row {
  display: grid;
  /* the key and the value as wide as each other ; the last as wide as its buttons (four 2.5rem
     moves, the 0.5rem gap, Delete) */
  grid-template-columns: minmax(14rem, 1fr) minmax(14rem, 1fr) 13rem;
  gap: 0.75rem;
  /* a value on several lines : the key and the buttons at its top */
  align-items: start;
  min-width: 44rem;
}
/* the column names : as a field's label */
.af-cats-head {
  font-weight: 700;
}
</style>
