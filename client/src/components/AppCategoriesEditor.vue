<script setup>
/******************************************************************/
/*                                                                */
/*  The categories as a table : the designer's visual editor of   */
/*  its categories, beside their YAML, on the same text (saved    */
/*  with the designer's Save).                                    */
/*                                                                */
/*  @props:                                                       */
/*      modelValue: String - the categories' YAML (a list)        */
/*      readOnly: Boolean - shown, not editable                   */
/*  @emits:                                                       */
/*      update:modelValue - the YAML, rewritten from the table    */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEFAULT_CATEGORY_ICON,
  nextUid,
  stampUids,
  normalizeCategories,
  buildCategories,
} from '@/composables/useFormsConfig';
import { useYamlModel } from '@/composables/useYamlModel';
import { availableIcons } from '@/config/icons';
import {
  isDefaultCategory,
  flattenCategories,
  canMoveUp,
  canMoveDown,
  canIndent,
  canOutdent,
  moveCategoryUp,
  moveCategoryDown,
  indentCategory,
  outdentCategory,
  movedCategoryPaths,
} from '@/config/categories';

const props = defineProps({
  modelValue: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

// ─── the YAML as rows ─────────────────────────────────────────────────────────
const { rows: categories, error } = useYamlModel(props, emit, {
  toRows(value) {
    if (value != null && !Array.isArray(value)) throw new Error(t('designer.visualNotAList'));
    const tree = normalizeCategories(value || []);
    stampUids(tree, ['items']);
    return tree;
  },
  fromRows: buildCategories,
});

const locked = computed(() => props.readOnly || !!error.value);
const flatCats = computed(() => flattenCategories(categories.value));

// the tree as it was first read : a category is addressed by its PATH, so a move or a rename
// leaves the forms pointing at the old path - said, not refused (reorganizing is the point)
const firstTree = ref(JSON.parse(JSON.stringify(categories.value)));
const movedPaths = computed(() => movedCategoryPaths(firstTree.value, categories.value));

// ─── what the server would refuse : said here, as the row is typed ───────────
// the schema's category name (server/schema/base_schema.json) : 2 to 50 characters, no slash ;
// 'u' counts code points, as ajv does
const categoryNameRegex = /^[^/]{2,50}$/u;

const invalidCategory = computed(() => {
  const list = flatCats.value;
  for (let i = 0; i < list.length; i++) {
    const name = (list[i].cat.name || '').trim();
    if (!categoryNameRegex.test(name)) return { row: i + 1, name };
  }
  return null;
});

// siblings share a path when they share a name : the menu cannot tell them apart
function findDuplicate(cats) {
  const seen = new Set();
  for (const cat of cats) {
    const name = (cat.name || '').trim();
    if (name) {
      if (seen.has(name)) return name;
      seen.add(name);
    }
    if (cat.items?.length) {
      const duplicate = findDuplicate(cat.items);
      if (duplicate) return duplicate;
    }
  }
  return null;
}
const duplicateCategory = computed(() => findDuplicate(categories.value));

// ─── editing ──────────────────────────────────────────────────────────────────
const newCategory = ref(null);

// where the dialog's category goes : after a row (its menu's Add category), else at the end
const insertAfter = ref(null);

/**
 * Opens the New category dialog on an empty category with the default icon.
 *
 * Args:
 *   after (object): { cat } - the category it goes after, at that one's level (its menu's Add
 *     category) ; none, the end of the tree (the toolbar's +).
 */
function addCategory(after = null) {
  // the table cannot be edited (read only, or its YAML cannot be read) : nothing added
  if (locked.value) return;
  insertAfter.value = after && after.cat ? after.cat : null;
  newCategory.value = { _uid: nextUid(), name: '', icon: DEFAULT_CATEGORY_ICON };
}

/**
 * The list a category is in : the tree's, or a parent category's items.
 *
 * Args:
 *   target (object): the category.
 *   list (object[]): the list to look in, the whole tree by default.
 *
 * Returns:
 *   object[]|null: its list, or null when it is not in the tree.
 */
function listOf(target, list = categories.value) {
  if (list.includes(target)) return list;
  for (const item of list) {
    const found = item.items && listOf(target, item.items);
    if (found) return found;
  }
  return null;
}

/**
 * Adds the dialog's category (saved with the designer's Save) : right after the category its
 * menu was opened on, or at the end of the tree.
 */
function createCategory() {
  const after = insertAfter.value;
  const list = after ? listOf(after) : null;
  if (list) list.splice(list.indexOf(after) + 1, 0, newCategory.value);
  else categories.value.push(newCategory.value);
  newCategory.value = null;
  insertAfter.value = null;
}

/**
 * Removes a category (and its subcategories) from the tree.
 *
 * Args:
 *   cat (object): the category.
 *   list (object[]): the list to look in, the whole tree by default.
 *
 * Returns:
 *   boolean: true when it was found and removed.
 */
function removeCategory(cat, list = categories.value) {
  const idx = list.indexOf(cat);
  if (idx >= 0) {
    list.splice(idx, 1);
    return true;
  }
  return list.some((item) => item.items && removeCategory(cat, item.items));
}

/**
 * Whether a row may be changed : not the default category, not a locked tree.
 *
 * Args:
 *   row (object): { cat, depth }.
 *
 * Returns:
 *   boolean: true when it may.
 */
function editable(row) {
  return !locked.value && !isDefaultCategory(row.cat, row.depth);
}

/**
 * A row's moves, as the buttons show them : ← out a level, → into the category above, ↑ ↓ among
 * its own ; each pressable or not.
 *
 * Args:
 *   row (object): { cat, depth }.
 *
 * Returns:
 *   object[]: [{ icon, title, can, run }].
 */
function moves(row) {
  const ok = editable(row);
  const cats = categories.value;
  return [
    {
      icon: 'arrow-left',
      title: t('settings.settingsPage.outdentCategory'),
      can: ok && canOutdent(cats, row.cat),
      run: () => outdentCategory(cats, row.cat),
    },
    {
      icon: 'arrow-right',
      title: t('settings.settingsPage.indentCategory'),
      can: ok && canIndent(cats, row.cat),
      run: () => indentCategory(cats, row.cat),
    },
    {
      icon: 'arrow-up',
      title: t('settings.settingsPage.moveUp'),
      can: ok && canMoveUp(cats, row.cat),
      run: () => moveCategoryUp(cats, row.cat),
    },
    {
      icon: 'arrow-down',
      title: t('settings.settingsPage.moveDown'),
      can: ok && canMoveDown(cats, row.cat),
      run: () => moveCategoryDown(cats, row.cat),
    },
  ];
}

// the designer's toolbar adds a row (its + button)
defineExpose({ add: addCategory, locked });
</script>
<template>
  <BsModal v-if="newCategory" size="lg" @close="newCategory = null" icon="folder-tree">
    <template #title> {{ t('settings.settingsPage.newCategory') }} </template>
    <template #default>
      <BsInput :isFloating="false" v-model="newCategory.name" :label="t('settings.settingsPage.name')" icon="heading" />
      <label class="form-label fw-bold">{{ t('settings.settingsPage.icon') }}</label>
      <div class="input-group">
        <span class="input-group-text"><FaIcon :icon="newCategory.icon || 'question'" class="fa-fw" /></span>
        <select class="form-select" v-model="newCategory.icon">
          <option v-for="ic in availableIcons" :key="ic" :value="ic">{{ ic }}</option>
        </select>
      </div>
    </template>
    <template #footer>
      <BsButton icon="plus" :disabled="!newCategory.name.trim()" @click="createCategory()">{{
        t('designer.addCategory')
      }}</BsButton>
    </template>
  </BsModal>
  <div class="af-visual-editor">
    <!-- the YAML cannot be read as categories : said, and nothing editable until fixed there -->
    <div v-if="error" class="alert alert-danger py-2 mb-3" role="alert">
      <FaIcon icon="triangle-exclamation" class="me-2" />{{ t('designer.visualYamlError') }} : {{ error }}
    </div>
    <div v-if="!error && invalidCategory" class="alert alert-warning py-2 mb-3" role="alert">
      {{ t('settings.settingsPage.invalidCategoryName', invalidCategory) }}
    </div>
    <div v-if="!error && duplicateCategory" class="alert alert-warning py-2 mb-3" role="alert">
      {{ t('settings.settingsPage.duplicateCategoryName', { name: duplicateCategory }) }}
    </div>
    <div v-if="!error && movedPaths.length > 0" class="alert alert-warning py-2 mb-3" role="alert">
      {{ t('settings.settingsPage.categoryPathsChanged', { paths: movedPaths.join(', ') }) }}
    </div>
    <div v-if="categories.length === 0" class="empty-state">
      <FaIcon icon="folder-tree" class="empty-state-icon" />
      <span>{{ t('settings.settingsPage.noCategories') }}</span>
    </div>
    <!-- an outline, as Settings > Appearance > Links : a row per category, its standard fields,
         its moves as one group of buttons (→ makes it a subcategory), then Delete -->
    <div v-else class="af-cats">
      <div class="af-cats-row af-cats-head">
        <span>{{ t('settings.settingsPage.icon') }}</span>
        <span>{{ t('settings.settingsPage.name') }}</span>
        <span></span>
      </div>
      <div v-for="row in flatCats" :key="row.cat._uid" class="af-cats-row">
        <!-- the icon, indented with its depth (the nested icon before a subcategory) -->
        <div class="d-flex align-items-center" :style="{ paddingLeft: row.depth * 1.5 + 'rem' }">
          <FaIcon
            v-if="row.depth > 0"
            icon="level-up-alt"
            class="text-muted me-2 fa-rotate-90"
            style="font-size: 0.75rem"
          />
          <div class="input-group flex-grow-1">
            <span class="input-group-text"><FaIcon :fixedwidth="true" :icon="row.cat.icon || 'question'" /></span>
            <select
              class="form-select"
              v-model="row.cat.icon"
              :disabled="isDefaultCategory(row.cat, row.depth) || locked"
              :aria-label="t('settings.settingsPage.icon')"
            >
              <!-- a hand-written icon not in the list : offered, so it stays visible -->
              <option v-if="row.cat.icon && !availableIcons.includes(row.cat.icon)" :value="row.cat.icon">
                {{ row.cat.icon }}
              </option>
              <option v-for="ic in availableIcons" :key="ic" :value="ic">{{ ic }}</option>
            </select>
          </div>
        </div>
        <div class="input-group">
          <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="heading" /></span>
          <input
            class="form-control"
            v-model="row.cat.name"
            :disabled="isDefaultCategory(row.cat, row.depth) || locked"
            :aria-label="t('settings.settingsPage.name')"
          />
        </div>
        <!-- the default category and a locked tree : no actions -->
        <div class="d-flex gap-2 justify-content-end">
          <div class="btn-group" role="group" :aria-label="t('settings.interface.linkMoves')">
            <button
              v-for="m in moves(row)"
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
            :class="editable(row) ? 'btn-outline-danger' : 'btn-outline-secondary'"
            :disabled="!editable(row)"
            :title="t('common.delete')"
            @click="removeCategory(row.cat)"
          >
            <FaIcon icon="trash" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped lang="scss">
/* the outline : one row each, the same columns for the header line, as Settings > Appearance >
   Links ; a pane narrower than them scrolls sideways rather than squeezing the fields */
.af-cats {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  overflow-x: auto;
  padding-bottom: 0.5rem;
}
.af-cats-row {
  display: grid;
  /* the last : as wide as its buttons (four 2.5rem moves, the 0.5rem gap, Delete) */
  grid-template-columns: 14.5rem minmax(12rem, 1fr) 13rem;
  gap: 0.75rem;
  align-items: center;
  min-width: 44rem;
}
/* the column names : as a field's label */
.af-cats-head {
  font-weight: 700;
}
</style>
