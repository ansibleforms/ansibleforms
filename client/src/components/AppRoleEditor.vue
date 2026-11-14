<script setup>
/******************************************************************/
/*                                                                */
/*  One role of the forms config, in three tabs : General (its    */
/*  name and options), Users and Groups (each with the auth       */
/*  provider it comes from). Shown under an opened role of the    */
/*  roles page, and in the New role dialog. The role is edited    */
/*  in place.                                                     */
/*                                                                */
/*  @model role: the role edited ({ _uid, _required, _default,     */
/*      name, groups, users, options })                           */
/*  @emits removed: a user or a group was removed (the page saves)*/
/*  @props:                                                       */
/*      readOnly: Boolean - the config cannot be saved now        */
/*      authProviders: Array - the providers a group or a user    */
/*         may come from (local, ldap, ...)                       */
/*      localGroups: Array - the local group names, sorted        */
/*      localUsers: Array - the local user names, sorted          */
/*      optionKeys: Array - the role options, in their order      */
/*      optionLabel: Function - an option's label                 */
/*      nextUid: Function - a new _uid for a group or a user      */
/*      tab: String - the tab shown, chosen by the page (its tabs */
/*         in its title line, the role's page) : no tab strip of  */
/*         its own then                                           */
/*                                                                */
/******************************************************************/

import { ref, computed, h } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  requiredRoleDescription,
  roleOptionGroups,
  roleOptionIncludedIn,
  roleOptionNeeds,
  roleOptionDescription,
  providerPrefix,
} from '@/config/roles';
import { useAdminDefaults } from '@/composables/useAdminDefaults';

const props = defineProps({
  readOnly: { type: Boolean, default: false },
  authProviders: { type: Array, default: () => [] },
  localGroups: { type: Array, default: () => [] },
  localUsers: { type: Array, default: () => [] },
  optionKeys: { type: Array, default: () => [] },
  optionLabel: { type: Function, required: true },
  nextUid: { type: Function, required: true },
  tab: { type: String, default: '' },
});

// the options in their groups (config/roles.js), each with its title, only those the page passes
// (optionKeys) ; an option in no group, last, under none
/**
 * The option that already gives this one, when it is on (Show all settings gives the parts).
 *
 * Args:
 *   key (string): the option.
 *
 * Returns:
 *   string|null: the option that gives it, or null.
 */
function includedBy(key) {
  const by = roleOptionIncludedIn[key];
  return by && role.value.options?.[by] ? by : null;
}

/**
 * The option another one needs, when that one is off (the Edit options need Show Designer).
 *
 * Args:
 *   key (string): the option.
 *
 * Returns:
 *   string|null: the option it needs, or null.
 */
function missing(key) {
  const needs = roleOptionNeeds[key];
  return needs && !role.value.options?.[needs] ? needs : null;
}

/**
 * The popover of an option : what it gives (config/roles.js) and, for a part of the settings, that
 * Show all settings includes it.
 *
 * Args:
 *   key (string): the option.
 *
 * Returns:
 *   string: the text ; '' for none.
 */
function optionHelp(key) {
  const description = roleOptionDescription(t, te, key);
  const by = roleOptionIncludedIn[key];
  const included = by ? t('settings.settingsPage.roleOptionIncluded', { option: props.optionLabel(by) }) + '.' : '';
  const needs = roleOptionNeeds[key];
  const needed = needs ? t('settings.settingsPage.roleOptionNeeds', { option: props.optionLabel(needs) }) + '.' : '';
  return [description, included, needed].filter(Boolean).join(' ');
}

const optionGroups = computed(() => {
  const keys = props.optionKeys;
  const groups = roleOptionGroups
    .map((g) => ({ name: g.name, title: t(g.title), keys: g.keys.filter((k) => keys.includes(k)) }))
    .filter((g) => g.keys.length);
  const grouped = new Set(roleOptionGroups.flatMap((g) => g.keys));
  const rest = keys.filter((k) => !grouped.has(k));
  if (rest.length) groups.push({ name: 'other', title: '', keys: rest });
  return groups;
});

// what holds the tabs' content : under the editor's own tab strip (a dialog), a card the tabs
// open into, as a settings page's ; with the page's tabs (tab given), the content as it is
const TabCard = (_, { slots }) =>
  h('div', { class: 'card tab-card-flush-card' }, [h('div', { class: 'card-body' }, slots.default?.())]);
const Bare = (_, { slots }) => slots.default?.();

const role = defineModel('role', { type: Object, required: true });
// a user or a group removed (its X) : the page may save at once
const emit = defineEmits(['removed']);

const { t, te } = useI18n();

// ─── the Admin option ─────────────────────────────────────────────────────────
// fixed on the admin role (always admins) and on the default role (never : everyone's), greyed out
const adminFixed = computed(() => (role.value._required ? !role.value._default : null));
// turned on or off by hand : the options an admin gets by default follow it, unless one was set
// apart from that default (it keeps its own value). Another role opened in the editor is no change
// of its Admin option : its options stay as they are (composables/useAdminDefaults.js)
useAdminDefaults(role);

// ─── tabs ─────────────────────────────────────────────────────────────────────
// the role in three tabs : General (its name and options), its users and its groups, each of
// those with its count (the default role is everyone's : no count)
const ownTab = ref('general');
// the page's tab when it chooses one, else the editor's own strip
const activeTab = computed({
  get: () => props.tab || ownTab.value,
  set: (key) => (ownTab.value = key),
});
const tabs = computed(() => [
  { key: 'general', label: t('settings.common.tabDetails'), icon: 'sliders' },
  {
    key: 'users',
    label: t('settings.settingsPage.users'),
    icon: 'user',
    count: role.value._default ? undefined : role.value.users.length,
  },
  {
    key: 'groups',
    label: t('settings.settingsPage.groups'),
    icon: 'users',
    count: role.value._default ? undefined : role.value.groups.length,
  },
]);

// ─── groups and users ─────────────────────────────────────────────────────────

/**
 * Resets a group or a user to the first local name when it moves to the local provider,
 * and empties it for any other provider (its names are typed there).
 *
 * Args:
 *   entry (object): the group or the user changed.
 *   type (string): 'group' or 'user'.
 */
function onProviderChange(entry, type) {
  entry.name = entry.provider === 'local' ? (type === 'group' ? props.localGroups[0] : props.localUsers[0]) || '' : '';
}

/**
 * Adds a group to the role, the first local group by default.
 */
function addGroup() {
  role.value.groups.push({ _uid: props.nextUid(), provider: 'local', name: props.localGroups[0] || '' });
}

/**
 * Adds a user to the role, the first local user by default.
 */
function addUser() {
  role.value.users.push({ _uid: props.nextUid(), provider: 'local', name: props.localUsers[0] || '' });
}

/**
 * Removes a group from the role.
 *
 * Args:
 *   index (number): the group's position.
 */
function removeGroup(index) {
  role.value.groups.splice(index, 1);
  emit('removed');
}

/**
 * Removes a user from the role.
 *
 * Args:
 *   index (number): the user's position.
 */
function removeUser(index) {
  role.value.users.splice(index, 1);
  emit('removed');
}
</script>

<template>
  <!-- three tabs : the role itself (its name and options), its users, its groups -->
  <ul v-if="!tab" class="nav nav-tabs af-role-tabs mb-0">
    <li v-for="tab in tabs" :key="tab.key" class="nav-item">
      <a class="nav-link" :class="{ active: activeTab === tab.key }" href="#" @click.prevent="activeTab = tab.key"
        ><FaIcon :icon="tab.icon" class="me-1" />{{ tab.label
        }}<span v-if="tab.count !== undefined" class="badge af-role-tab-count ms-2">{{ tab.count }}</span></a
      >
    </li>
  </ul>

  <component :is="tab ? Bare : TabCard">
    <!-- General : the name and the options -->
    <template v-if="activeTab === 'general'">
      <BsInput
        class="af-role-name"
        :isFloating="false"
        v-model="role.name"
        :label="t('settings.settingsPage.name')"
        :placeholder="t('settings.settingsPage.roleNamePlaceholder')"
        :disabled="role._required || readOnly"
      />
      <!-- admin and default : a fixed description, greyed out as their name -->
      <BsInput
        v-if="role._required"
        class="af-role-description"
        :isFloating="false"
        :modelValue="requiredRoleDescription(t, role.name)"
        :label="t('settings.fields.description')"
        :disabled="true"
      />
      <BsInput
        v-else
        class="af-role-description"
        :isFloating="false"
        v-model="role.description"
        :label="t('settings.fields.description')"
        :placeholder="t('settings.settingsPage.roleDescriptionPlaceholder')"
        :disabled="readOnly"
      />
      <label class="form-label fw-bold af-role-options-title">{{ t('settings.settingsPage.options') }}</label>
      <!-- the options in their groups (config/roles.js), each under its title -->
      <div v-for="group in optionGroups" :key="group.name" class="af-role-option-group">
        <div class="af-role-option-group-title">{{ group.title }}</div>
        <div class="row row-cols-2 row-cols-md-3 g-0 role-options">
          <div v-for="optKey in group.keys" :key="optKey" class="col">
            <!-- given by another option that is on (Show all settings) : on, greyed out, its own value
                 kept for when that one is turned off -->
            <div class="af-role-option">
              <!-- Admin on the admin role (on) or the default role (off) : fixed, greyed out -->
              <BsInput
                v-if="optKey === 'admin' && adminFixed !== null"
                type="checkbox"
                :isSwitch="true"
                :modelValue="adminFixed"
                :label="optionLabel(optKey)"
                :disabled="true"
              />
              <BsInput
                v-else-if="includedBy(optKey)"
                type="checkbox"
                :isSwitch="true"
                :modelValue="true"
                :label="optionLabel(optKey)"
                :disabled="true"
              />
              <!-- needs another option that is off (Show Designer for the Edit ones) : off and greyed
                   out, its own value kept for when that one is turned on -->
              <BsInput
                v-else-if="missing(optKey)"
                type="checkbox"
                :isSwitch="true"
                :modelValue="false"
                :label="optionLabel(optKey)"
                :disabled="true"
              />
              <BsInput
                v-else
                type="checkbox"
                :isSwitch="true"
                v-model="role.options[optKey]"
                :label="optionLabel(optKey)"
                :disabled="readOnly"
              />
              <!-- what it gives, and when another option covers it, that it does -->
              <AppInfoPopover v-if="optionHelp(optKey)" :text="optionHelp(optKey)" placement="top" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Users : the users of the role, each with the provider they sign in with -->
    <template v-else-if="activeTab === 'users'">
      <p v-if="role._default" class="text-muted small mb-3">{{ t('settings.settingsPage.defaultEveryone') }}</p>
      <p v-else-if="!tab && role.users.length === 0" class="text-muted small mb-3">
        {{ t('settings.settingsPage.roleNoUsers') }}
      </p>
      <div v-for="(usr, uIdx) in tab ? [] : role.users" :key="usr._uid" class="d-flex align-items-center gap-2 mb-2">
        <select
          class="form-select provider-select"
          v-model="usr.provider"
          :disabled="readOnly || role._default"
          @change="onProviderChange(usr, 'user')"
        >
          <option v-for="p in authProviders" :key="p" :value="p">{{ providerPrefix(p) }}</option>
        </select>
        <select
          v-if="usr.provider === 'local'"
          class="form-select"
          v-model="usr.name"
          :disabled="readOnly || role._default"
        >
          <option v-for="u in localUsers" :key="u" :value="u">{{ u }}</option>
        </select>
        <input
          v-else
          class="form-control"
          v-model="usr.name"
          placeholder="username"
          :disabled="readOnly || role._default"
        />
        <button v-if="!readOnly" class="btn btn-outline-danger align-self-stretch af-remove" @click="removeUser(uIdx)">
          <FaIcon icon="times" />
        </button>
      </div>
      <!-- the page has its own Add user (top right) : the dialog keeps this one -->
      <div v-if="!tab && !readOnly && !role._default" :class="[role.users.length > 0 ? 'mt-3' : 'mt-1', 'mb-3']">
        <BsButton icon="plus" @click="addUser()">{{ t('settings.settingsPage.addUser') }}</BsButton>
      </div>
    </template>

    <!-- Groups : the groups of the role, each with the provider it comes from -->
    <template v-else>
      <p v-if="role._default" class="text-muted small mb-3">{{ t('settings.settingsPage.defaultEveryone') }}</p>
      <p v-else-if="!tab && role.groups.length === 0" class="text-muted small mb-3">
        {{ t('settings.settingsPage.roleNoGroups') }}
      </p>
      <div v-for="(grp, gIdx) in tab ? [] : role.groups" :key="grp._uid" class="d-flex align-items-center gap-2 mb-2">
        <select
          class="form-select provider-select"
          v-model="grp.provider"
          :disabled="readOnly || role._default"
          @change="onProviderChange(grp, 'group')"
        >
          <option v-for="p in authProviders" :key="p" :value="p">{{ providerPrefix(p) }}</option>
        </select>
        <select
          v-if="grp.provider === 'local'"
          class="form-select"
          v-model="grp.name"
          :disabled="readOnly || role._default"
        >
          <option v-for="g in localGroups" :key="g" :value="g">{{ g }}</option>
        </select>
        <input
          v-else
          class="form-control"
          v-model="grp.name"
          placeholder="groupname"
          :disabled="readOnly || role._default"
        />
        <button v-if="!readOnly" class="btn btn-outline-danger align-self-stretch af-remove" @click="removeGroup(gIdx)">
          <FaIcon icon="times" />
        </button>
      </div>
      <div v-if="!tab && !readOnly && !role._default" :class="[role.groups.length > 0 ? 'mt-3' : 'mt-1', 'mb-3']">
        <BsButton icon="plus" @click="addGroup()">{{ t('settings.settingsPage.addGroup') }}</BsButton>
      </div>
    </template>
  </component>
</template>

<style scoped>
/* the wide fields' width of the settings pages (AppEnvField, a path or a command) : the name and
   its description alike, room for a sentence */
.af-role-name :deep(input),
.af-role-description :deep(input) {
  max-width: 40rem;
}
.af-role-tabs .nav-link {
  cursor: pointer;
}
/* the count of a tab : small and grey, as the menus' badges */
.af-role-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
.provider-select {
  width: 130px;
  flex-shrink: 0;
}
/* the remove button of a group or a user : as tall as the dropdowns beside it, and square */
.af-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.75rem;
}
/* a toggle and its (i) right after the label, on one line : the switch without its own bottom
   margin, the row's room given by the option itself */
.af-role-option {
  display: flex;
  align-items: center;
  gap: 0.1rem;
  padding: 0.4rem 0;
}
.role-options .af-role-option :deep(.mb-3) {
  margin-bottom: 0 !important;
}
.af-role-option :deep(.form-check) {
  margin-bottom: 0;
}
/* BsInput's field label is empty for a switch (its label is the switch's own) : not drawn here, so
   the row is the switch, its label and the (i), centred together */
.af-role-option :deep(.form-label) {
  display: none;
}
/* the (i) of a page title is sized and raised for the title : here, beside a label, its own size
   and centred on the label's line */
.af-role-option :deep(.af-info-btn) {
  align-self: center;
  margin: 0;
  padding: 0 0.15rem;
  font-size: 0.8rem;
  vertical-align: middle;
}
.role-options {
  /* the switches take back their own margin : this gives the group its room at the bottom */
  padding-bottom: 0.5rem;
}
/* a group of options : its title small, in capitals and grey, as the settings menu's sections */
/* room above each group, its title close to its options ; the first one, under the options'
   heading, only a little */
.af-role-option-group {
  margin-top: 0.75rem;
  padding-top: 0.25rem;
}
.af-role-options-title + .af-role-option-group {
  margin-top: 0;
  padding-top: 0.6rem;
}
.af-role-option-group-title {
  margin: 0.25rem 0 0.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--bs-secondary-color);
}
.af-role-option-group:last-child .role-options {
  padding-bottom: 0.75rem;
}
.role-options :deep(.mb-3) {
  margin-bottom: -0.5rem !important;
}
</style>
