<script setup>
/******************************************************************/
/*                                                                */
/*  A repository's Usage step : what the app reads from it, its   */
/*  usage types under their five headings (lib/repositoryUsage.js */
/*  USAGE_CATEGORIES), side by side, one per line on a narrow     */
/*  screen. Each heading's box ticks or unticks every type of it  */
/*  that can be ticked (three states : all, some, none) ; a type  */
/*  another repository has is greyed with that repository's name. */
/*  Used by the repository's dialog (AppAdminMulti, field type    */
/*  'usage') and its page (pages/admin/repository.vue).           */
/*                                                                */
/*  Props                                                         */
/*    modelValue  the repository as edited (its use_for_* flags,  */
/*                its id and name) ; a change emits a copy        */
/*    others      the repositories as saved : who has a one-only  */
/*                type                                            */
/*    readonly    nothing can be changed (a user who is not an    */
/*                admin)                                          */
/*    shown       (flag) => whether a type is shown (the page's   */
/*                search) ; every type when not given             */
/*                                                                */
/******************************************************************/
import { useI18n } from 'vue-i18n';
import {
  USAGE_CATEGORIES,
  typesOf,
  usageLabel,
  usageHint,
  takenBy,
  available,
  categoryState,
  setCategory,
  flagOn,
} from '@/lib/repositoryUsage';

const props = defineProps({
  modelValue: { type: Object, required: true },
  others: { type: Array, default: () => [] },
  readonly: { type: Boolean, default: false },
  shown: { type: Function, default: null },
});
const emit = defineEmits(['update:modelValue']);
const { t } = useI18n();

/**
 * Whether a type is shown (the page's search narrows them).
 *
 * Args:
 *   type (object): the type.
 *
 * Returns:
 *   boolean: true when it is.
 */
const typeShown = (type) => !props.shown || props.shown(type.flag);

/**
 * Whether a heading is shown : one of its types is.
 *
 * Args:
 *   category (string): the category.
 *
 * Returns:
 *   boolean: true when it is.
 */
const categoryShown = (category) => typesOf(category).some(typeShown);

/**
 * Ticks or unticks one type.
 *
 * Args:
 *   type (object): the type.
 *   on (boolean): ticked.
 */
function setType(type, on) {
  emit('update:modelValue', { ...props.modelValue, [type.flag]: on });
}

/**
 * Ticks or unticks every type of a heading that can be.
 *
 * Args:
 *   category (string): the category.
 *   on (boolean): ticked.
 */
function setAll(category, on) {
  const next = { ...props.modelValue };
  setCategory(category, next, props.others, on);
  emit('update:modelValue', next);
}

/**
 * A type's grey note : the repository that has it, when another one does.
 *
 * Args:
 *   type (object): the type.
 *
 * Returns:
 *   string: the note, '' for none.
 */
function noteOf(type) {
  const other = takenBy(type, props.modelValue, props.others);
  return other ? t('settings.common.takenBy', { name: other }) : '';
}

/**
 * A type's tooltip : why it cannot be ticked, else what it holds.
 *
 * Args:
 *   type (object): the type.
 *
 * Returns:
 *   string: the tooltip.
 */
const titleOf = (type) => noteOf(type) || usageHint(t, type.key);
</script>

<template>
  <div class="af-usage">
    <section
      v-for="category in USAGE_CATEGORIES"
      v-show="categoryShown(category)"
      :key="category"
      class="af-usage-group"
      :data-category="category"
    >
      <!-- the heading : its box ticks or unticks every type of it that can be ticked -->
      <div class="form-check af-usage-heading">
        <input
          :id="'af-usage-all-' + category"
          class="form-check-input"
          type="checkbox"
          :checked="categoryState(category, modelValue, others).checked"
          :indeterminate.prop="categoryState(category, modelValue, others).indeterminate"
          :disabled="readonly || categoryState(category, modelValue, others).disabled"
          :title="
            t('settings.repositories.usageCategoryAll', {
              category: t(`settings.repositories.usageCategories.${category}`),
            })
          "
          @change="setAll(category, $event.target.checked)"
        />
        <label class="form-check-label" :for="'af-usage-all-' + category">{{
          t(`settings.repositories.usageCategories.${category}`)
        }}</label>
      </div>
      <!-- its types, one per row ; one that cannot be ticked greyed, why beside its name -->
      <div class="af-usage-types">
        <div
          v-for="type in typesOf(category)"
          v-show="typeShown(type)"
          :key="type.key"
          class="form-check af-short-check"
          :class="{ 'af-taken': !available(type, modelValue, others) }"
          :title="titleOf(type)"
        >
          <input
            :id="'af-usage-' + type.flag"
            class="form-check-input"
            type="checkbox"
            :checked="flagOn(modelValue[type.flag])"
            :disabled="readonly || !available(type, modelValue, others)"
            @change="setType(type, $event.target.checked)"
          />
          <label class="form-check-label" :for="'af-usage-' + type.flag">
            <span class="af-short-label">{{ usageLabel(t, type.key) }}</span>
            <span v-if="noteOf(type)" class="af-usage-note">{{ noteOf(type) }}</span>
            <span class="text-body-secondary small">{{ usageHint(t, type.key) }}</span>
          </label>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* a heading, then its types under it, one per row as the Type tabs' options (.af-short-check,
   .af-short-label, .af-taken : global), a little apart from the next heading */
.af-usage-group + .af-usage-group {
  margin-top: 1rem;
}
.af-usage-heading .form-check-label {
  font-weight: 600;
}
.af-usage-types {
  margin: 0.6rem 0 0 1.5rem;
}
/* its options closer together than a Type tab's : nineteen of them in one list */
.af-usage-types .af-short-check {
  margin-bottom: 0.25rem;
}
/* the last option : no space of its own under it, the card's padding is enough */
.af-usage-group:last-child .af-short-check:last-child {
  margin-bottom: 0;
}
/* why it cannot be ticked, beside its name, small and slanted */
.af-usage-note {
  margin-right: 0.6rem;
  font-size: 0.8rem;
  font-style: italic;
}
</style>
