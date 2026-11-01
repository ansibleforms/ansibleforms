<script setup>
/******************************************************************/
/*                                                                */
/*  App Admin Single component                                    */
/*  Create a single admin page with a form and update/save button */
/*                                                                */
/*  @props:                                                       */
/*      settings: Object - its type (the api path), fields and    */
/*            actions ; a record of a list (an LDAP directory)    */
/*            adds parentCrumbs (the steps before it, the list's) */
/*            and recordTitle (the field naming it in the title)  */
/*            ; a field's disabledWhen (item, saved) and an       */
/*            action's showWhen (item) decide from the record ;   */
/*            togglesLast puts a tab's switches under its fields  */
/*      tabs: Array of { key, label, icon, count } - the form in  */
/*            tabs (count : a badge after the label) :            */
/*            each field names its tab (field.tab, the first tab  */
/*            when it names none) ; a slot tab-top-<key> above a  */
/*            tab's fields (searching, matches and active : that  */
/*            tab is the one shown). The tab is kept in the       */
/*            address                                             */
/*      locked: Boolean - every field read only (the feature the  */
/*            form configures is switched off)                    */
/*      extraDirty: Boolean - more to save with the form (the     */
/*            page's own fields, in a tab-top slot) : Save emits  */
/*            saveExtra as well                                   */
/*      searchable: Boolean - a search box on the title line : it */
/*            narrows every tab at once, as Settings > General's  */
/*            (the fields that match by label, help or name, each */
/*            tab under its name, the tabs set aside meanwhile)   */
/*      searchTopMatches: Object - { <tab key>: true } : the page */
/*            has a match in that tab's tab-top slot (the slot    */
/*            gets `searching` and `matches(...texts)`)           */
/*                                                                */
/*  @model search: String - the text searched (v-model:search)    */
/*                                                                */
/*  @emits:                                                       */
/*      test: Function                                            */
/*      import: Function                                          */
/*      saved: Function (after a successful update)               */
/*      loaded: the record, each time it is read (its page lists  */
/*            what uses it : a database's Used by)                */
/*      saveExtra: Save was pressed with extraDirty               */
/*      delete: the record's Delete action (its page deletes it)  */
/*                                                                */
/*  field.valuesFrom: { url, filter?(record) } - a dropdown whose  */
/*      choices are records of the api (a credential), by name,    */
/*      an empty choice first                                     */
/*                                                                */
/******************************************************************/

import { ref, onMounted, computed, watch } from 'vue';
import axios from 'axios';
import Helpers from '@/lib/Helpers';
import { toast } from 'vue-sonner';
import { useVuelidate } from '@vuelidate/core';
import { required, helpers, email, sameAs } from '@vuelidate/validators';
import { useI18n } from 'vue-i18n';
import { useRouteTab } from '@/composables/useRouteTab';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { textsMatch } from '@/lib/recordSearch';
import { useRoute } from 'vue-router';

const { t } = useI18n();

const props = defineProps({
  settings: Object,
  apiVersion: {
    type: [String, Number],
    default: 2,
  },
  tabs: {
    type: Array,
    default: () => [],
  },
  locked: {
    type: Boolean,
    default: false,
  },
  extraDirty: {
    type: Boolean,
    default: false,
  },
  searchable: {
    type: Boolean,
    default: false,
  },
  searchTopMatches: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits(['test', 'import', 'saved', 'saveExtra', 'delete', 'loaded']);

// the tab shown, kept in the address (/settings/ldap/server, composables/useRouteTab.js)
const firstTab = computed(() => props.tabs[0]?.key || '');
const route = useRoute();
const { activeTab, tabLink } = props.tabs.length
  ? useRouteTab(
      () => firstTab.value,
      (key) => props.tabs.some((x) => x.key === key),
    )
  : { activeTab: ref(''), tabLink: () => route.path };
// a page in tabs says its tab in the title : LDAP › Server, each step a link (the page to its
// plain address, the tab to itself)
const crumbs = computed(() => {
  const tab = props.tabs.find((x) => x.key === activeTab.value);
  if (!tab) return [];
  // a record of a list : the list's steps first, then the record by its name (a grey bar until
  // it is read) ; else the page's own title
  const title = props.settings.recordTitle
    ? (originalItem.value?.[props.settings.recordTitle] ?? null)
    : props.settings.pageTitle || objectLabel.value;
  return [
    ...(props.settings.parentCrumbs || []),
    { title, icon: objectIcon.value, to: tabLink(firstTab.value) },
    { title: tab.label, icon: tab.icon, to: tabLink(tab.key) },
  ];
});
// the tab a field is in : the one it names, or the first
const tabOf = (field) => field.tab || firstTab.value;

// ─── search (searchable) ─────────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once : the fields that match it,
// by label, help or name, each tab under its name, the tabs set aside meanwhile.
const search = defineModel('search', { type: String, default: '' });
const searching = computed(() => props.searchable && !!search.value.trim());
/**
 * Whether some texts have the text searched, whatever its case (true when nothing is searched).
 *
 * Args:
 *   texts (...string): a field's label, help, name.
 *
 * Returns:
 *   boolean: true when one of them has it.
 */
function matches(...texts) {
  return textsMatch(search.value, texts);
}
const fieldMatches = (field) => matches(field.label, field.help, field.description, field.key);
// a tab has something to show while searching : a field of it that matches, or its top slot's
function tabMatches(tabKey) {
  if (props.searchTopMatches[tabKey]) return true;
  return fields.value.some((f) => tabOf(f) === tabKey && isVisible(f) && fieldMatches(f));
}
// the tabs shown : the active one, or while searching every one with a match
const shownTabs = computed(() =>
  searching.value
    ? props.tabs.filter((tab) => tabMatches(tab.key))
    : props.tabs.filter((tab) => tab.key === activeTab.value),
);

const objectLabel = computed(() => props.settings?.label || '');
const objectIcon = computed(() => props.settings?.icon || '');
const objectDescription = computed(() => props.settings?.description || '');
const objectType = computed(() => props.settings?.type || '');
const fields = computed(() => props.settings?.fields || []);
const actions = computed(() => props.settings?.actions || []);
const toggleFields = computed(() => fields.value.filter((f) => f.isToggle));

// make a dictionary of the fields with the key as the key of the field and the value as the field itself
const fieldsDict = computed(() =>
  fields.value.reduce((acc, field) => {
    acc[field.key] = field;
    return acc;
  }, {}),
);

// validation
// the messages are translated, the field's label in them (settings.common.field*), and read
// when shown : a change of language follows without rebuilding the rules
function getRules() {
  const ruleObj = { item: {} };
  fields.value.forEach((field) => {
    var rule = {};
    if (field.required) {
      rule.required = helpers.withMessage(() => t('settings.common.fieldRequired', { field: field.label }), required);
    }
    if (field.type == 'email') {
      rule.email = helpers.withMessage(() => t('settings.common.fieldEmail', { field: field.label }), email);
    }
    if (field.type == 'checkbox' && field.required) {
      rule.checkboxRequired = helpers.withMessage(
        () => t('settings.common.fieldRequired', { field: field.label }),
        sameAs(computed(() => true)),
      );
    }
    ruleObj.item[field.key] = rule;
  });
  return ruleObj;
}
const item = ref({});
const originalItem = ref(null);
const isDirty = computed(() => {
  if (originalItem.value === null) return false;
  return JSON.stringify(item.value) !== JSON.stringify(originalItem.value);
});
const rules = computed(() => getRules());

const $v = useVuelidate(rules, { item });

function objectTitle(prefix = '', suffix = '') {
  return `${prefix} ${objectLabel.value} ${suffix}`.trim();
}

async function loadItem() {
  try {
    const result = await axios.get(`/api/v${props.apiVersion}/${objectType.value}/`);
    item.value = result.data;
    for (const field of fields.value) {
      if (field.type == 'checkbox') {
        item.value[field.key] = !!item.value[field.key]; // convert to boolean
      }
    }
    originalItem.value = JSON.parse(JSON.stringify(item.value));
    emit('loaded', originalItem.value);
  } catch (err) {
    console.log(objectTitle('Error loading'));
    toast.error(Helpers.parseAxiosResponseError(err, 'Failed to load item'));
  }
}

function doEmit(action) {
  $v.value.item.$touch();
  if (action == 'test' && isInvalid.value) {
    return;
  }
  emit(action, item.value);
}

async function updateItem() {
  if (!isInvalid.value) {
    try {
      await axios.put(`/api/v${props.apiVersion}/${objectType.value}/`, item.value);
      toast.success(t('settings.common.nameUpdated', { name: objectTitle('') }));
      emit('saved', item.value);
      loadItem();
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err));
    }
  } else {
    $v.value.item.$touch();
  }
}

function isDisabled(field) {
  // a rule of the record's own (the default LDAP directory keeps its name)
  if (typeof field.disabledWhen === 'function' && field.disabledWhen(item.value, originalItem.value || {})) {
    return true;
  }
  if (!field.dependency) {
    return false;
  }
  const dependencyField = fieldsDict.value[field.dependency];
  if (!dependencyField) {
    return true;
  }
  let isCurrentFieldDisabled;
  if (field.negateDependency) {
    isCurrentFieldDisabled = item.value[dependencyField.key];
  } else {
    isCurrentFieldDisabled = !item.value[dependencyField.key];
  }
  const isParentFieldDisabled = isDisabled(dependencyField);
  return isCurrentFieldDisabled || isParentFieldDisabled;
}

const isInvalid = computed(() => {
  // check if any field is invalid, but only check the ones that are not disabled
  for (const field of fields.value) {
    if (!disabledFields.value[field.key] && $v.value.item[field.key].$invalid) {
      return true;
    }
  }
  return false;
});

// Opt-in per settings definition. Hiding a field whose dependency is not met is the
// default and stays that way ; LDAP asks to show them greyed instead, so an admin can
// see the whole shape of the configuration before switching it on.
const showDisabled = computed(() => !!props.settings?.showDisabledFields);

// Whether a field appears at all. showDisabledFields greys unmet fields instead of
// hiding them, but a field can opt back out with hideWhenDisabled - used for the TLS
// certificate chain, where a certificate box is meaningless until TLS is switched on.
function isVisible(field) {
  if (!disabledFields.value[field.key]) return true;
  // A seed-managed record disables every field. That must not also HIDE them -
  // visibility is about an unmet dependency, and on a page without
  // showDisabledFields the whole form would otherwise vanish.
  if (isManaged.value && !isDisabled(field)) return true;
  return showDisabled.value && !field.hideWhenDisabled;
}

// Owned by the declarative config seed (https://ansibleforms.com/seed). The API answers 403, and the
// seed re-applies on every start, so an editable form here could only mislead. The
// values stay visible - an operator still needs to read what is in force.
const isManaged = computed(() => !!item.value?.managed);
// leaving with the form changed and unsaved asks first : its fields (not when the seed owns
// them, nothing can be saved) or what the page adds to it (extraDirty)
useUnsavedGuard(
  computed(() => (isDirty.value && !isManaged.value) || props.extraDirty),
  () => t('settings.common.unsavedChanges'),
  () => saveAll(),
);

const disabledFields = computed(() => {
  const disabledFields = {};
  for (const field of fields.value) {
    disabledFields[field.key] = props.locked || isManaged.value || isDisabled(field);
  }
  return disabledFields;
});

// the rows of a tab (or of the whole form, without tabs)
function rowsOf(tab) {
  const rows = [];
  for (const field of fields.value) {
    if (tab && tabOf(field) !== tab) continue;
    // toggles render above the rows, so they are not part of the grid.
    // 'isAction' was also skipped here : that flag is gone, since the only
    // fields that carried it are on AppAdminMulti pages which never read it
    if (field.isToggle) {
      continue;
    }
    const line = field.line || 0;
    if (!rows[line]) {
      rows[line] = [];
    }
    rows[line].push(field);
  }
  return rows;
}
const rows = computed(() => rowsOf(''));

// Save : the form when it changed, and what the page adds to it (extraDirty) - one press
async function saveAll() {
  if (props.extraDirty) emit('saveExtra');
  if (isDirty.value && !isManaged.value) await updateItem();
}

for (const field of fields.value) {
  if (field.onChange) {
    watch(
      () => item.value[field.key],
      (newVal, oldVal) => {
        if (oldVal !== undefined) field.onChange(newVal, item.value);
      },
    );
  }
}

// the choices of the dropdowns that load them (field.valuesFrom), by field key
const loadedValues = ref({});

/**
 * Loads the choices of the dropdowns that name an api list (field.valuesFrom) : the records'
 * names, an empty choice first (none).
 */
async function loadValues() {
  for (const field of props.settings.fields.filter((f) => f.valuesFrom)) {
    const res = await axios.get(field.valuesFrom.url).catch(() => null);
    const records = (res?.data?.records || []).filter((r) => !field.valuesFrom.filter || field.valuesFrom.filter(r));
    loadedValues.value[field.key] = [
      { value: '', label: '' },
      ...records.map((r) => ({ value: r.name, label: r.name })),
    ];
  }
}

// its credential dropdown, if it has one (createWith credentials) : Add credential top right
const credentialField = computed(() => props.settings.fields.find((f) => f.createWith === 'credentials') || null);

/**
 * The credential type Add credential presets for a dropdown (its createDefaults).
 *
 * Args:
 *   field (object): the dropdown's field.
 *
 * Returns:
 *   string: the type, empty for none.
 */
function createType(field) {
  const defaults = typeof field.createDefaults === 'function' ? field.createDefaults(item.value) : field.createDefaults;
  return defaults?.credential_type || '';
}

/**
 * Chooses the credential just made with Add credential : the dropdowns read again, it chosen.
 *
 * Args:
 *   field (object): the dropdown's field.
 *   name (string): the new credential's name.
 */
async function onCredentialCreated(field, name) {
  await loadValues();
  item.value[field.key] = name;
}

// the record read once : until then its fields as grey placeholders (a save reads it again with
// the fields kept on screen)
const loaded = ref(false);
onMounted(async () => {
  await Promise.all([loadItem(), loadValues()]);
  loaded.value = true;
});

/**
 * Forgets the changes on the form : the record is gone (deleted by the page), so there is nothing
 * left to save and leaving must not offer to.
 */
function forget() {
  originalItem.value = null;
}

defineExpose({
  loadItem,
  forget,
});
</script>
<template>
  <AppSettings
    :icon="objectIcon"
    :title="settings.pageTitle || objectLabel"
    :crumbs="crumbs"
    :description="objectDescription"
  >
    <!-- narrows every tab at once ; the search box of the other pages -->
    <template v-if="searchable" #headerActions>
      <BsSearch v-model="search" />
    </template>
    <template v-if="tabs.length && !searching" #tabs>
      <ul class="nav nav-tabs mb-0">
        <li v-for="tab in tabs" :key="tab.key" class="nav-item">
          <a class="nav-link" :class="{ active: activeTab === tab.key }" href="#" @click.prevent="activeTab = tab.key">
            <FaIcon :icon="tab.icon" class="me-1" />
            {{ tab.label }}
            <!-- what the tab lists, as the record pages count theirs (a credential's Used by) -->
            <span v-if="tab.count !== undefined" class="badge af-tab-count ms-1">{{ tab.count }}</span>
          </a>
        </li>
      </ul>
    </template>
    <template #actions>
      <!-- Add credential, first as every page's Add, while the tab of its credential dropdown is
           open : a new credential of its type, chosen once made -->
      <AppNewCredentialButton
        v-if="credentialField && (!tabs.length || activeTab === tabOf(credentialField))"
        :type="createType(credentialField)"
        :disabled="!!disabledFields[credentialField.key] || isManaged"
        @created="(name) => onCredentialCreated(credentialField, name)"
      />
      <!-- the action bar holds buttons only : the 'isAction' checkbox row that
                 used to render here reached nothing, because the only fields carrying
                 that flag live in the runners and oauth2_providers blocks, and both of
                 those pages use AppAdminMulti, which never had this slot -->
      <BsButton
        v-for="action in actions"
        :key="action.name"
        v-show="(!action.dependency || item[action.dependency]) && (!action.showWhen || action.showWhen(item))"
        :icon="action.icon"
        @click="doEmit(action.name)"
        >{{ action.title }}</BsButton
      >
      <BsButton icon="save" :disabled="(!isDirty || isManaged) && !extraDirty" @click="saveAll()">{{
        t('settings.common.save')
      }}</BsButton>
    </template>
    <!-- in tabs : each tab its slot, then its toggles and its rows -->
    <template v-if="tabs.length" #default>
      <!-- the first load : the fields as grey placeholders, in their place -->
      <AppSkeleton v-if="!loaded" shape="form" :count="4" />
      <div v-if="loaded && searching && !shownTabs.length" class="text-body-secondary fst-italic">
        {{ t('settings.settingsPage.searchNone') }}
      </div>
      <div
        v-for="tab in tabs"
        v-show="loaded && shownTabs.includes(tab)"
        :key="tab.key"
        :class="{ 'af-wide-tab': (settings.wideTabs || []).includes(tab.key) }"
      >
        <!-- searching : the matches of every tab, each under its tab's name (as Settings > General) -->
        <template v-if="searching">
          <hr v-if="shownTabs.indexOf(tab) > 0" class="mt-4 mb-0 af-search-line" />
          <h6
            class="fw-bold text-body-secondary af-search-tab"
            :class="{ 'af-search-first': shownTabs.indexOf(tab) === 0 }"
          >
            <FaIcon :icon="tab.icon" class="me-1" />{{ tab.label }}
          </h6>
        </template>
        <div v-if="isManaged && (!searching || shownTabs.indexOf(tab) === 0)" class="alert alert-secondary py-2">
          <FaIcon icon="lock" class="me-2" />
          {{ t('settings.common.seedManagedNotice') }}
        </div>
        <!-- active : the tab is the one shown (the tabs stay mounted, hidden) ; content that puts its
             controls elsewhere (a linked table's toolbar and pager) shows only while it is -->
        <slot
          :name="'tab-top-' + tab.key"
          :searching="searching"
          :matches="matches"
          :active="activeTab === tab.key"
        ></slot>
        <!-- a toggle as the switches of the MCP and chat pages : its title, the switch, its help ; above
             the tab's fields, or under them (settings.togglesLast : a record's Enabled under its name,
             as an SSO provider's Active) -->
        <template v-if="!settings.togglesLast">
          <div
            v-for="field in toggleFields.filter((f) => tabOf(f) === tab.key && (!searching || fieldMatches(f)))"
            :key="field.key"
            class="mb-3"
          >
            <label class="form-label fw-bold af-toggle-title" :for="'tg-' + field.key">{{ field.label }}</label>
            <div class="form-check form-switch mb-0">
              <input
                :id="'tg-' + field.key"
                v-model="item[field.key]"
                class="form-check-input"
                type="checkbox"
                role="switch"
                :disabled="isManaged || locked"
              />
            </div>
            <div v-if="field.help" class="form-text">{{ field.help }}</div>
          </div>
        </template>
        <template v-for="(cols, rIdx) in rowsOf(tab.key)" :key="rIdx">
          <div v-if="cols && cols.some((f) => isVisible(f) && (!searching || fieldMatches(f)))" class="row">
            <div
              :class="field.type === 'checkbox' ? 'col-auto' : 'col'"
              v-for="field in cols"
              :key="field.key"
              v-show="isVisible(field) && (!searching || fieldMatches(field))"
            >
              <!-- several values, one per input (an LDAP directory's servers) -->
              <BsInputList
                v-if="field.type === 'list'"
                v-model="$v.item[field.key].$model"
                :label="field.label"
                :help="field.help"
                :icon="field.icon"
                :placeholder="field.placeholder"
                :required="field.required"
                :addLabel="field.addLabel"
                :disabled="disabledFields[field.key]"
                :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty && !disabledFields[field.key]"
                :errors="$v.item[field.key].$errors"
              />
              <BsInput
                v-else
                :isFloating="false"
                :placeholder="field.placeholder"
                :description="field.description"
                :style="field.style"
                :icon="field.icon"
                :help="field.help"
                :type="field.type"
                :values="loadedValues[field.key] || field.values"
                :liveSync="field.type === 'editor'"
                v-model="$v.item[field.key].$model"
                :disabled="disabledFields[field.key]"
                :label="field.label"
                :required="field.required"
                :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty && !disabledFields[field.key]"
                :errors="$v.item[field.key].$errors"
              />
            </div>
          </div>
        </template>
        <template v-if="settings.togglesLast">
          <div
            v-for="field in toggleFields.filter((f) => tabOf(f) === tab.key && (!searching || fieldMatches(f)))"
            :key="field.key"
            class="mb-3"
          >
            <label class="form-label fw-bold af-toggle-title" :for="'tg-' + field.key">{{ field.label }}</label>
            <div class="form-check form-switch mb-0">
              <input
                :id="'tg-' + field.key"
                v-model="item[field.key]"
                class="form-check-input"
                type="checkbox"
                role="switch"
                :disabled="isManaged || locked"
              />
            </div>
            <div v-if="field.help" class="form-text">{{ field.help }}</div>
          </div>
        </template>
      </div>
    </template>
    <template v-else #default>
      <!-- the first load : the fields as grey placeholders, in their place -->
      <AppSkeleton v-if="!loaded" shape="form" :count="4" />
      <template v-else>
        <div v-if="isManaged" class="alert alert-secondary py-2">
          <FaIcon icon="lock" class="me-2" />
          {{ t('settings.common.seedManagedNotice') }}
        </div>
        <!-- a toggle as the switches of the MCP and chat pages : its title, the switch, its help -->
        <div v-for="field in toggleFields" :key="field.key" class="mb-3">
          <label class="form-label fw-bold af-toggle-title" :for="'tg-' + field.key">{{ field.label }}</label>
          <div class="form-check form-switch mb-0">
            <input
              :id="'tg-' + field.key"
              v-model="item[field.key]"
              class="form-check-input"
              type="checkbox"
              role="switch"
              :disabled="isManaged || locked"
            />
          </div>
          <div v-if="field.help" class="form-text">{{ field.help }}</div>
        </div>
        <template v-for="(cols, rIdx) in rows" :key="rIdx">
          <div v-if="cols && cols.some((f) => isVisible(f))" class="row">
            <div
              :class="field.type === 'checkbox' ? 'col-auto' : 'col'"
              v-for="field in cols"
              :key="field.key"
              v-show="isVisible(field)"
            >
              <!-- several values, one per input (an LDAP directory's servers) -->
              <BsInputList
                v-if="field.type === 'list'"
                v-model="$v.item[field.key].$model"
                :label="field.label"
                :help="field.help"
                :icon="field.icon"
                :placeholder="field.placeholder"
                :required="field.required"
                :addLabel="field.addLabel"
                :disabled="disabledFields[field.key]"
                :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty && !disabledFields[field.key]"
                :errors="$v.item[field.key].$errors"
              />
              <BsInput
                v-else
                :isFloating="false"
                :placeholder="field.placeholder"
                :description="field.description"
                :style="field.style"
                :icon="field.icon"
                :help="field.help"
                :type="field.type"
                :values="loadedValues[field.key] || field.values"
                :liveSync="field.type === 'editor'"
                v-model="$v.item[field.key].$model"
                :disabled="disabledFields[field.key]"
                :label="field.label"
                :required="field.required"
                :hasError="$v.item[field.key].$invalid && $v.item[field.key].$dirty && !disabledFields[field.key]"
                :errors="$v.item[field.key].$errors"
              />
            </div>
          </div>
        </template>
      </template>
    </template>
    <template #footer>
      <slot></slot>
    </template>
  </AppSettings>
</template>
<style scoped>
/* the count of a tab : small and grey, as the record pages' */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
/* every field one width, as on the other settings pages : across the whole card, its value sat
   far from its label, and two or three to a row they were each another width. 20rem fits the
   narrowest column (three to a row), so the fields of a tab line up */
:deep(.card-body .input-group) {
  max-width: 20rem;
}
/* a tab of long values (an LDAP directory's search bases, its DNs) : its fields twice as wide,
   all of them one width (settings.wideTabs) */
.af-wide-tab :deep(.input-group) {
  max-width: 40rem;
}
/* and their placeholders while the record loads (AppSkeleton) */
:deep(.card-body .af-sk-input) {
  max-width: 20rem;
}
:deep(.card-body) {
  padding-top: 1.25rem;
  /* 1rem, and nothing added on top of it. This used to be 0.5rem plus a 1.25rem
     padding-bottom on the last row, which put 28px below the last field while a plain
     card sat at 16px. One padding, zero trailing margin - measured equal on every page. */
  padding-bottom: 1rem;
}
/* the last row's fields end the card : no margin of their own under them, a switch's column
   (col-auto) as well as a field's */
:deep(.card-body > .row:last-child > .col > .mb-3),
:deep(.card-body > .row:last-child > .col-auto > .mb-3),
:deep(.card-body > div > .row:last-child > .col > .mb-3),
:deep(.card-body > div > .row:last-child > .col-auto > .mb-3) {
  margin-bottom: 0 !important;
}
:deep(.card-body .mb-3:has(.form-check) > .form-label) {
  display: none;
}
/* a toggle's title stays : it is not the empty label a switch leaves above it */
.af-toggle-title {
  display: inline-block !important;
}
:deep(.card-body > .mb-3:has(.form-check) > p) {
  margin-top: 0;
  margin-bottom: 0.25rem;
}
</style>
