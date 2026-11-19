<script setup>
/******************************************************************/
/*                                                                */
/*  A vars file as a tree of its variables : a value changed in   */
/*  place (a switch for yes / no, a number, text), a key or a     */
/*  list item added or deleted - on the file's own text, so its   */
/*  comments stay (saved with the designer's Save). A list or a   */
/*  map folds ; a key's name opens the YAML on its line.          */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the file's YAML (a map)              */
/*      readOnly: Boolean - shown, not editable                   */
/*  @emits:                                                       */
/*      update:modelValue - the file, changed                     */
/*      reveal: the line to open the YAML on                      */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import YAML from 'yaml';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import { varsRows, setVar, deleteVar, addVar, renameVar } from '@/config/varsFile';
import BsSwitch from './BsSwitch.vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'reveal']);
const { t } = useI18n();

// ─── the rows ─────────────────────────────────────────────────────────────────
const rows = computed(() => varsRows(props.modelValue));
// a list or a map somewhere : the rows keep the fold arrow's room, so the keys line up
const folds = computed(() => rows.value.some((r) => r.type === 'map' || r.type === 'seq'));
const folded = ref(new Set());
// a row shows unless a map or a list above it is folded
const shown = computed(() =>
  rows.value.filter(
    (row) =>
      !row.path.some((_, i) => i < row.path.length - 1 && folded.value.has(JSON.stringify(row.path.slice(0, i + 1)))),
  ),
);
function toggle(row) {
  const next = new Set(folded.value);
  if (next.has(row.id)) next.delete(row.id);
  else next.add(row.id);
  folded.value = next;
}

// ─── changes ──────────────────────────────────────────────────────────────────
/**
 * Sets a value : a number typed in a number field stays a number, an emptied one is nothing
 * (null), text stays text.
 */
function change(row, raw) {
  if (props.readOnly) return;
  let value = raw;
  if (row.type === 'number') value = raw === '' ? null : Number(raw);
  if (row.type === 'null') value = raw === '' ? null : raw;
  if (value === row.value) return;
  emit('update:modelValue', setVar(props.modelValue, row.path, value));
}
/** Renames a key (not a list's item) : an empty or an existing name is refused, the key kept. */
function rename(row, event) {
  const name = String(event.target.value || '').trim();
  if (props.readOnly || name === row.key) return;
  if (!name) {
    event.target.value = row.key;
    return;
  }
  try {
    emit('update:modelValue', renameVar(props.modelValue, row.path, name));
  } catch {
    toast.warning(t('designer.files.keyExists', { key: name }));
    event.target.value = row.key;
  }
}
function remove(row) {
  if (props.readOnly) return;
  emit('update:modelValue', deleteVar(props.modelValue, row.path));
}

// a new key (in a map) or item (in a list) : its value typed as YAML, so 80 is a number,
// true a yes, [a, b] a list and anything else text
const adding = ref(null); // { path, isList, key, value }
function startAdd(row = null) {
  adding.value = { path: row ? row.path : [], isList: row?.type === 'seq', key: '', value: '' };
}
function add() {
  const a = adding.value;
  if (!a.isList && !a.key.trim()) return;
  let value;
  try {
    value = a.value.trim() === '' ? null : YAML.parse(a.value);
  } catch {
    value = a.value;
  }
  try {
    emit('update:modelValue', addVar(props.modelValue, a.path, a.key.trim(), value));
    if (a.path.length) {
      const next = new Set(folded.value);
      next.delete(JSON.stringify(a.path));
      folded.value = next;
    }
    adding.value = null;
  } catch {
    toast.warning(t('designer.files.keyExists', { key: a.key.trim() }));
  }
}
const addTarget = computed(() =>
  adding.value?.path.length ? adding.value.path.join(' › ') : t('designer.files.topLevel'),
);

defineExpose({ add: () => startAdd() });
</script>
<template>
  <div>
    <div v-if="rows.length === 0" class="empty-state">
      <FaIcon icon="file-lines" class="empty-state-icon" />
      <span>{{ t('designer.files.noVars') }}</span>
    </div>
    <div v-else class="af-vars">
      <div class="af-vars-row af-vars-head">
        <span>{{ t('settings.settingsPage.key') }}</span>
        <span>{{ t('settings.settingsPage.value') }}</span>
        <span></span>
      </div>
      <div v-for="row in shown" :key="row.id" class="af-vars-row">
        <!-- the key, indented with its depth ; a list's item by its place -->
        <div class="d-flex align-items-center min-w-0" :style="{ paddingLeft: row.depth * 1.5 + 'rem' }">
          <span v-if="row.type === 'map' || row.type === 'seq'" role="button" class="af-caret me-1" @click="toggle(row)"
            ><FaIcon :icon="folded.has(row.id) ? 'caret-right' : 'caret-down'"
          /></span>
          <!-- room for the fold arrow, only when something in the file folds -->
          <span v-else-if="folds" class="af-caret me-1"></span>
          <!-- a key : its name edited in place ; a list's item : its place, which opens the YAML -->
          <input
            v-if="typeof row.key !== 'number'"
            class="form-control af-key"
            :value="row.key"
            :disabled="readOnly"
            :aria-label="t('settings.settingsPage.key')"
            @change="rename(row, $event)"
            @keyup.enter="$event.target.blur()"
          />
          <span
            v-else
            class="text-truncate af-key text-body-secondary"
            role="button"
            :title="t('designer.files.showInYaml')"
            @click="emit('reveal', row.line)"
            >- {{ row.key + 1 }}</span
          >
        </div>
        <!-- the value : as its type -->
        <span v-if="row.type === 'map' || row.type === 'seq'" class="text-muted fst-italic small align-self-center">{{
          row.type === 'map' ? t('designer.files.keysCount', row.count) : t('designer.files.itemsCount', row.count)
        }}</span>
        <BsSwitch
          v-else-if="row.type === 'boolean'"
          :model-value="row.value"
          :disabled="readOnly"
          :aria-label="String(row.key)"
          @change="change(row, $event.target.checked)"
          class="align-self-center mb-0"
        />
        <input
          v-else
          class="form-control"
          :type="row.type === 'number' ? 'number' : 'text'"
          :value="row.value ?? ''"
          :disabled="readOnly || row.type === 'alias'"
          :placeholder="row.type === 'null' ? 'null' : ''"
          :aria-label="String(row.key)"
          @change="change(row, $event.target.value)"
          @keyup.enter="$event.target.blur()"
        />
        <!-- Delete first, so it stands in the same place on every row ; a list's or a map's + after it -->
        <div class="d-flex gap-2">
          <button
            type="button"
            class="btn af-row-btn"
            :class="readOnly ? 'btn-outline-secondary' : 'btn-outline-danger'"
            :disabled="readOnly"
            :title="t('common.delete')"
            @click="remove(row)"
          >
            <FaIcon icon="trash" />
          </button>
          <button
            v-if="row.type === 'map' || row.type === 'seq'"
            type="button"
            class="btn af-row-btn"
            :class="readOnly ? 'btn-outline-secondary' : 'btn-outline-primary'"
            :disabled="readOnly"
            :title="row.type === 'map' ? t('designer.files.addKey') : t('designer.files.addItem')"
            @click="startAdd(row)"
          >
            <FaIcon icon="plus" />
          </button>
        </div>
      </div>
    </div>

    <!-- a new key, or a list's new item -->
    <BsModal v-if="adding" size="md" icon="plus" @close="adding = null">
      <template #title>{{ adding.isList ? t('designer.files.addItem') : t('designer.files.addKey') }}</template>
      <template #default>
        <p class="text-body-secondary mb-3">{{ t('designer.files.addTo', { where: addTarget }) }}</p>
        <BsInput
          v-if="!adding.isList"
          :isFloating="false"
          v-model="adding.key"
          :label="t('settings.settingsPage.key')"
          icon="key"
        />
        <BsInput
          :isFloating="false"
          v-model="adding.value"
          :label="t('settings.settingsPage.value')"
          icon="pen"
          :help="t('designer.files.valueHelp')"
          @keyup_enter="add()"
        />
      </template>
      <template #footer>
        <BsButton icon="plus" :disabled="!adding.isList && !adding.key.trim()" @click="add()">{{
          t('designer.files.create')
        }}</BsButton>
      </template>
    </BsModal>
  </div>
</template>
<style scoped lang="scss">
/* a row per key, as the constants' outline : key, value, buttons */
.af-vars {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}
.af-vars-row {
  display: grid;
  /* the key and the value take the room up to the buttons, which take what they need */
  grid-template-columns: minmax(12rem, 1fr) minmax(14rem, 1.4fr) auto;
  gap: 0.75rem;
  align-items: center;
  min-width: 36rem;
}
.af-vars-head {
  font-weight: 700;
}
.af-caret {
  display: inline-block;
  width: 1rem;
  text-align: center;
  color: var(--bs-secondary-color);
}
span.af-key:hover {
  text-decoration: underline;
}
.min-w-0 {
  min-width: 0;
}
</style>
