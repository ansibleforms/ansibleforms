<script setup>
/******************************************************************/
/*                                                                */
/*  An LDAP or SSO group's page (/settings/groups/<source>/<name>)*/
/*  opened from the groups list : a group seen at a sign-in or    */
/*  named by a role, read only - its directory owns it - in tabs, */
/*  the tab kept in the address ; a row of a tab opens its item : */
/*  Details - its name and source, read only                      */
/*  Users - the users seen in it at their last sign-in            */
/*  Roles - the roles that name it                                */
/*  Forms - the forms those roles open                            */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import { formPath } from '@/lib/formsPath';
import { sourceLabel } from '@/config/settings';
import { useRouteTab } from '@/composables/useRouteTab';
import { useRoleAssignments } from '@/composables/useRoleAssignments';
import { useRoleMembership } from '@/composables/useRoleMembership';
import { useFormLinks } from '@/composables/useFormLinks';
import { useRecordSearch } from '@/composables/useRecordSearch';

const { t } = useI18n();
const route = useRoute();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the group ────────────────────────────────────────────────────────────────
const source = computed(() => String(route.params.type || ''));
const groupName = computed(() => String(route.params.name || ''));
const group = ref(null); // { id, source, name, members, user_count, role_count }
const sourceName = computed(() => sourceLabel(t, source.value));

/**
 * Loads the group ; none when it was neither seen at a sign-in nor named by a role.
 */
async function load() {
  try {
    const res = await axios.get(
      `/api/v2/directory/groups/${encodeURIComponent(source.value)}/${encodeURIComponent(groupName.value)}`,
    );
    group.value = res.data.records ? res.data.records[0] : res.data;
  } catch {
    group.value = null;
  }
  loaded.value = true;
}

// its users seen at their last sign-in ; a row opens the user's page
const members = computed(() => (group.value?.members || []).map((username) => ({ username })));
const memberColumns = computed(() => [{ key: 'username', label: t('settings.fields.username') }]);

// ─── Roles, Forms ─────────────────────────────────────────────────────────────
// the roles that name the group ; a row opens the role
const { loadRoles, rolesOfGroup } = useRoleAssignments();

// ─── Add role / Remove from role ──────────────────────────────────────────────
// Add role names it in a role of the forms config ; the roles ticked are taken out of those
// that name it ; both saved at once, as the roles' pages save
const { roleNames, readOnly: rolesReadOnly, addTo, removeFrom } = useRoleMembership();
const addingRole = ref(false);
// the roles it can be added to : those it is not named in yet
const roleChoices = computed(() => {
  const named = new Set(groupRoles.value.map((r) => r.name));
  return roleNames.value.filter((n) => !named.has(n));
});
/**
 * Names it in the role picked, then reads the roles again.
 *
 * Args:
 *   roleName (string): the role.
 */
async function addRole(roleName) {
  if (await addTo(roleName, 'groups', source.value, group.value.name)) {
    addingRole.value = false;
    await loadRoles();
  }
}
/**
 * Takes it out of the roles ticked that name it, then reads the roles again.
 *
 * Args:
 *   rows (object[]): the rows ticked.
 */
async function removeRoles(rows) {
  const names = rows.map((r) => r.name);
  if (names.length && (await removeFrom(names, 'groups', source.value, group.value.name))) await loadRoles();
}
const groupRoles = computed(() => (group.value ? rolesOfGroup(group.value.name, source.value) : []));
const roleColumns = computed(() => [
  { key: 'name', label: t('settings.common.role') },
  { key: 'description', label: t('settings.fields.description') },
]);
// the forms those roles open, and through which ; a row opens the form
const { loadForms, formsOfRoles } = useFormLinks();
const groupForms = computed(() => formsOfRoles(groupRoles.value.map((r) => r.name)));
const formColumns = computed(() => [
  { key: 'name', label: t('settings.fields.form') },
  { key: 'through', label: t('settings.linked.throughRoles'), value: (f) => f.through.join(', ') },
  { key: 'description', label: t('settings.fields.description') },
]);

// ─── tabs ─────────────────────────────────────────────────────────────────────
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'users', label: t('settings.settingsPage.users'), icon: 'user', count: members.value.length },
  { key: 'roles', label: t('settings.settingsPage.roles'), icon: 'user-shield', count: groupRoles.value.length },
  { key: 'forms', label: t('settings.linked.forms'), icon: 'rectangle-list', count: groupForms.value.length },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Groups › <name>, each step a link, and the open tab last
const crumbs = computed(() => {
  const base = [
    { title: t('sidebar.groups'), icon: 'users', to: '/settings/groups' },
    {
      title: groupName.value,
      icon: 'users',
      to: `/settings/groups/${encodeURIComponent(source.value)}/${encodeURIComponent(groupName.value)}`,
    },
  ];
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...base, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : base;
});

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the facts of Details whose label or value has it, the users, roles and forms with it in one
// of their cells (AppLinkedTable's search), each under its tab's name, the tabs set aside
// meanwhile.
const { search, searching, matchingKeys, tableMatches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => (key === 'details' ? shownFields.value.length : rowsMatch(key)),
});
// read only, so a fact's value counts as its label does
const shownFields = computed(() =>
  matchingKeys([
    ['note', t('settings.directory.groupReadOnlyNote', { source: sourceName.value })],
    ['name', t('settings.fields.name'), group.value?.name],
    ['source', t('settings.directory.source'), sourceName.value],
  ]),
);
const fieldShown = (key) => shownFields.value.includes(key);
// a user, a role or a form with the text in one of the cells its table shows (lib/recordSearch.js)
const tabTables = {
  users: [members, memberColumns],
  roles: [groupRoles, roleColumns],
  forms: [groupForms, formColumns],
};
const rowsMatch = (key) => tableMatches(tabTables[key][0].value, tabTables[key][1].value);

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadRoles(), loadForms()]);
});
</script>
<template>
  <AppAddRoleDialog v-if="addingRole" :choices="roleChoices" @save="addRole" @close="addingRole = false" />
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="users"
      :title="groupName"
      :crumbs="crumbs"
      :description="t('settings.groups.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="group" #headerActions>
        <BsSearch v-model="search" />
      </template>
      <template v-if="group && !searching" #tabs>
        <ul class="nav nav-tabs mb-0">
          <li v-for="tab in tabs" :key="tab.key" class="nav-item">
            <a
              class="nav-link"
              :class="{ active: activeTab === tab.key }"
              href="#"
              @click.prevent="activeTab = tab.key"
            >
              <FaIcon :icon="tab.icon" class="me-1" />
              {{ tab.label }}
              <span v-if="tab.count !== undefined" class="badge af-tab-count ms-1">{{ tab.count }}</span>
            </a>
          </li>
        </ul>
      </template>
      <!-- the record loading : its tabs as grey placeholders -->
      <template v-else-if="!loaded && !searching" #tabs>
        <AppSkeleton shape="tabs" :count="tabs.length" />
      </template>
      <template #default>
        <div v-if="loaded && !group" class="empty-state">
          <FaIcon icon="users" class="empty-state-icon" />
          <span>{{ t('settings.directory.groupNotFound', { name: groupName, source: sourceName }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !group" shape="form" :count="3" />
        <template v-else-if="group">
          <!-- Details : where it comes from (its users are those seen in it), read only -->
          <div v-if="tabShown('details')" class="af-group-details">
            <h6
              v-if="searching && searchHead('details')"
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('details').first }"
            >
              <FaIcon :icon="searchHead('details').tab.icon" class="me-1" />{{ searchHead('details').tab.label }}
            </h6>
            <div v-show="fieldShown('note')" class="alert alert-secondary py-2">
              <FaIcon icon="circle-info" class="me-2" />{{
                t('settings.directory.groupReadOnlyNote', { source: sourceName })
              }}
            </div>
            <BsInput
              class="af-group-field"
              v-show="fieldShown('name')"
              :modelValue="group.name"
              icon="heading"
              :isFloating="false"
              :disabled="true"
              :label="t('settings.fields.name')"
            />
            <BsInput
              class="af-group-field"
              v-show="fieldShown('source')"
              :modelValue="sourceName"
              icon="right-to-bracket"
              :isFloating="false"
              :disabled="true"
              :label="t('settings.directory.source')"
            />
          </div>
          <!-- Users : the users seen in it ; a row opens the user -->
          <template v-if="tabShown('users')">
            <template v-if="searching && searchHead('users')">
              <hr v-if="!searchHead('users').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('users').first }"
              >
                <FaIcon :icon="searchHead('users').tab.icon" class="me-1" />{{ searchHead('users').tab.label }}
              </h6>
            </template>
            <AppLinkedTable
              :search="search"
              :exportName="`${groupName}-users`"
              :columns="memberColumns"
              :rows="members"
              rowKey="username"
              :to="(m) => `/settings/users/${encodeURIComponent(source)}/${encodeURIComponent(m.username)}`"
              :empty="t('settings.directory.noMember')"
            />
          </template>
          <!-- Roles : the roles that name it ; a row opens the role -->
          <template v-if="tabShown('roles')">
            <template v-if="searching && searchHead('roles')">
              <hr v-if="!searchHead('roles').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('roles').first }"
              >
                <FaIcon :icon="searchHead('roles').tab.icon" class="me-1" />{{ searchHead('roles').tab.label }}
              </h6>
            </template>
            <AppLinkedTable
              :search="search"
              selectable
              :rowActions="[
                {
                  title: t('settings.settingsPage.removeFromRole'),
                  icon: 'trash',
                  danger: true,
                  run: (r) => removeRoles([r]),
                },
              ]"
              :exportName="`${groupName}-roles`"
              :columns="roleColumns"
              :rows="groupRoles"
              rowKey="name"
              :to="(r) => `/settings/roles/${encodeURIComponent(r.name)}`"
              :empty="t('settings.groups.noRole')"
            >
              <!-- the roles ticked that name it : taken out of them -->
              <template #bulk-actions="{ selected, count }">
                <BsButton v-if="count" icon="trash" :disabled="rolesReadOnly" @click="removeRoles(selected)"
                  >{{ t('settings.settingsPage.removeFromRole') }} ({{ count }})</BsButton
                >
              </template>
            </AppLinkedTable>
          </template>
          <!-- Forms : the forms those roles open ; a row opens the form -->
          <template v-if="tabShown('forms')">
            <template v-if="searching && searchHead('forms')">
              <hr v-if="!searchHead('forms').first" class="mt-4 mb-0 af-search-line" />
              <h6
                class="fw-bold text-body-secondary af-search-tab"
                :class="{ 'af-search-first': searchHead('forms').first }"
              >
                <FaIcon :icon="searchHead('forms').tab.icon" class="me-1" />{{ searchHead('forms').tab.label }}
              </h6>
            </template>
            <AppLinkedTable
              :search="search"
              :exportName="`${groupName}-forms`"
              :columns="formColumns"
              :rows="groupForms"
              rowKey="name"
              :to="(f) => formPath(f.name)"
              :empty="t('settings.linked.noFormGroup')"
            />
          </template>
          <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
        </template>
      </template>
      <!-- always there once the group is : the tab tables put their controls in this toolbar, so a
           slot that comes and goes with the tab tore it down under them and froze the tabs -->
      <template v-if="group" #actions>
        <BsButton v-if="tabShown('roles')" icon="plus" :disabled="rolesReadOnly" @click="addingRole = true">{{
          t('settings.settingsPage.addRole')
        }}</BsButton>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a local group's */
.af-group-field :deep(.input-group) {
  max-width: 40rem;
}
.af-group-details {
  padding-bottom: 0.5rem;
}
/* the count of a tab : small and grey, as the menus' badges */
.af-tab-count {
  background: var(--bs-secondary-bg);
  color: var(--bs-secondary-color);
  font-weight: 600;
}
</style>
<route lang="yaml">
meta:
  layout: settings
</route>
