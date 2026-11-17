<script setup>
/******************************************************************/
/*                                                                */
/*  A local group's page (/settings/groups/<id>), opened from the */
/*  groups list, in tabs, the tab kept in the address             */
/*  (/users, /roles) ; a row of a tab opens its item :            */
/*  Details - name, description                                   */
/*  Users - the users in it : Add user, and a row's menu or the   */
/*          checkboxes remove one, never from its only group      */
/*  Roles - the roles that name the group                         */
/*  Forms - the forms those roles open                            */
/*  Delete top right, off for admins and while the group has      */
/*  users (the server refuses).                                   */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, useId } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';
import { toast } from 'vue-sonner';
import Helpers from '@/lib/Helpers';
import { useI18n } from 'vue-i18n';
import Profile from '@/lib/Profile';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRouteTab } from '@/composables/useRouteTab';
import { useRoleAssignments } from '@/composables/useRoleAssignments';
import { useRoleMembership } from '@/composables/useRoleMembership';
import BsDataTable from '@/components/BsDataTable.vue';
import { useFormLinks } from '@/composables/useFormLinks';
import { formPath } from '@/lib/formsPath';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

// ─── the group and the users ──────────────────────────────────────────────────
const groupId = computed(() => String(route.params.id || ''));
const groupIdNumber = computed(() => parseInt(groupId.value, 10));
const group = ref(null); // as saved
const edit = ref(null); // as edited : name, description
const users = ref([]); // every local user : { id, username, description, email, group_ids }

// the admins group keeps its name and is never deleted (the server refuses both)
const isAdmins = computed(() => group.value?.name === 'admins');
const dirty = computed(
  () =>
    !!group.value &&
    !!edit.value &&
    ['name', 'description'].some((k) => (edit.value[k] || '') !== (group.value[k] || '')),
);
// leaving with the details changed and unsaved asks first
useUnsavedGuard(
  dirty,
  () => t('settings.common.unsavedChanges'),
  () => saveDetails(),
);

// the users in the group (as their first group or another one), and the others
const members = computed(() => users.value.filter((u) => (u.group_ids || []).includes(groupIdNumber.value)));
const others = computed(() => users.value.filter((u) => !(u.group_ids || []).includes(groupIdNumber.value)));
// a user whose only group this is : not removed from it (a user keeps one group)
const onlyGroup = (u) => (u.group_ids || []).length <= 1;

/**
 * Loads the group and the local users.
 */
async function load() {
  try {
    const [g, u] = await Promise.all([
      axios.get(`/api/v2/group/${encodeURIComponent(groupId.value)}`),
      axios.get('/api/v2/user/'),
    ]);
    const record = g.data.records ? g.data.records[0] : g.data;
    group.value = record || null;
    edit.value = record ? { name: record.name || '', description: record.description || '' } : null;
    users.value = u.data.records || u.data;
  } catch {
    group.value = null;
  }
  loaded.value = true;
}

// ─── tabs ─────────────────────────────────────────────────────────────────────
// Details (name, description), Users, Roles, Forms ; the tab kept in the url
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  { key: 'users', label: t('settings.settingsPage.users'), icon: 'user' },
  { key: 'roles', label: t('settings.settingsPage.roles'), icon: 'user-shield' },
  { key: 'forms', label: t('settings.linked.forms'), icon: 'rectangle-list' },
]);

// ─── Roles ────────────────────────────────────────────────────────────────────
// the roles that name the group ; a row opens the role's page
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
  if (await addTo(roleName, 'groups', 'local', group.value.name)) {
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
  if (names.length && (await removeFrom(names, 'groups', 'local', group.value.name))) await loadRoles();
}
const groupRoles = computed(() => (group.value ? rolesOfGroup(group.value.name) : []));

// ─── Forms ────────────────────────────────────────────────────────────────────
// the forms the group's roles open, and through which ; a row opens the form
const { loadForms, formsOfRoles } = useFormLinks();
const groupForms = computed(() => formsOfRoles(groupRoles.value.map((r) => r.name)));
const formColumns = computed(() => [
  { key: 'name', label: t('settings.fields.form') },
  { key: 'through', label: t('settings.linked.throughRoles'), value: (f) => f.through.join(', ') },
  { key: 'description', label: t('settings.fields.description') },
]);
// the rows of the page shown of the Users and Roles tables (their pager under them)
// the Roles table : the role (a row opens it) and what it is for
const roleColumns = computed(() => [
  { key: 'name', label: t('settings.common.role') },
  { key: 'description', label: t('settings.fields.description') },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Groups › <name>, each step a link : Groups back to the list, the name to this page
const pageCrumbs = computed(() => [
  { title: t('sidebar.groups'), icon: 'users', to: '/settings/groups' },
  {
    title: group.value?.name || (loaded.value ? groupId.value : null),
    icon: 'users',
    to: `/settings/groups/${groupId.value}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── Details ──────────────────────────────────────────────────────────────────
/**
 * Saves the details : name and description.
 */
async function saveDetails() {
  const name = edit.value.name.trim();
  if (!name) {
    toast.warning(t('settings.groups.nameRequired'));
    return;
  }
  try {
    await axios.put(`/api/v2/group/${encodeURIComponent(groupId.value)}`, {
      name,
      description: edit.value.description.trim(),
    });
    toast.success(t('settings.common.nameUpdated', { name }));
    await load();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

// ─── Add user / remove users ──────────────────────────────────────────────────
// Add user : a dialog with the users not in the group ; saved at once. Removing (a row's menu,
// or the rows ticked) is saved at once too, except from a user's only group.
const addingUser = ref(null); // the user id picked, null while the dialog is closed
const selectedUsers = ref(new Set()); // the user rows ticked (their id)
// the Users table's controls (Select all, columns, export ; its search is the page's) on the
// title line, its pager under the card, as every list ; none : an en dash, as the other empty
// cells
const toolsId = `af-tools-${useId()}`;
const pagerId = `af-pager-${useId()}`;
const userColumns = computed(() => [
  { key: 'username', label: t('settings.fields.username'), filterable: true },
  { key: 'description', label: t('settings.fields.description'), filterable: true },
  { key: 'email', label: t('settings.fields.email'), filterable: true },
]);

/**
 * Adds the user picked to the group.
 */
async function saveAddUser() {
  try {
    await axios.post(`/api/v2/user/${addingUser.value}/groups`, { group_id: groupIdNumber.value });
    addingUser.value = null;
    await load();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

/**
 * Removes users from the group, one after the other ; a user's only group is left alone.
 *
 * Args:
 *   ids (number[]): the users.
 */
async function removeUsers(ids) {
  for (const uid of ids) {
    try {
      await axios.delete(`/api/v2/user/${uid}/groups/${groupIdNumber.value}`);
    } catch (err) {
      toast.error(Helpers.parseAxiosResponseError(err));
      break;
    }
  }
  selectedUsers.value = new Set();
  await load();
}

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// the fields of Details whose label has it, the users, roles and forms with it in one of their
// cells, each under its tab's name, the tabs set aside meanwhile.
const { search, searching, matches, matchingKeys, tableMatches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) =>
    key === 'details'
      ? shownFields.value.length
      : key === 'users'
        ? shownMembers.value.length
        : key === 'roles'
          ? tableMatches(groupRoles.value, roleColumns.value)
          : tableMatches(groupForms.value, formColumns.value),
});
const shownFields = computed(() =>
  matchingKeys([
    ['name', t('settings.fields.name')],
    ['description', t('settings.fields.description')],
  ]),
);
const fieldShown = (key) => shownFields.value.includes(key);
// the users in it with the text in one of the Users table's cells : the rows the table gets
const shownMembers = computed(() => members.value.filter((u) => matches(u.username, u.description, u.email)));

// ─── Delete ───────────────────────────────────────────────────────────────────
const confirmDelete = ref(false);

/**
 * Deletes the group, then goes back to the list.
 */
async function deleteGroup() {
  confirmDelete.value = false;
  try {
    const name = group.value?.name;
    await axios.delete(`/api/v2/group/${encodeURIComponent(groupId.value)}`);
    // gone : nothing left to save, so leaving does not offer to save it
    group.value = null;
    toast.success(t('settings.common.nameDeleted', { name }));
    router.push('/settings/groups');
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadRoles(), loadForms()]);
  // opened from the list's Add user : the dialog open at once, the url left clean
  if (route.query.add && group.value) {
    addingUser.value = others.value[0]?.id ?? '';
    const query = { ...route.query };
    delete query.add;
    router.replace({ path: route.path, query });
  }
});
</script>
<template>
  <AppAddRoleDialog v-if="addingRole" :choices="roleChoices" @save="addRole" @close="addingRole = false" />
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ group?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ group?.name }}</strong>?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteGroup()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <BsModal v-if="addingUser !== null" size="md" @close="addingUser = null" icon="user">
    <template #title> {{ t('settings.settingsPage.addUser') }} </template>
    <template #default>
      <label class="form-label fw-bold">{{ t('settings.fields.username') }}</label>
      <select v-model="addingUser" class="form-select">
        <option v-for="u in others" :key="u.id" :value="u.id">{{ u.username }}</option>
      </select>
      <div v-if="!others.length" class="text-muted small mt-1">{{ t('settings.groups.everyUserIn') }}</div>
    </template>
    <template #footer>
      <BsButton icon="save" :disabled="!addingUser" @click="saveAddUser()">{{ t('settings.common.save') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="users"
      :title="group?.name || groupId"
      :crumbs="crumbs"
      :description="t('settings.groups.description')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="group" #headerActions>
        <BsSearch v-model="search" />
        <!-- the Users table's Select all, columns and export, on the title line (no search box of
             its own : the page's narrows it, search="") -->
        <div :id="toolsId" class="af-title-flow"></div>
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
              <span v-if="tab.key === 'users'" class="badge af-tab-count ms-1">{{ members.length }}</span>
              <span v-if="tab.key === 'roles'" class="badge af-tab-count ms-1">{{ groupRoles.length }}</span>
              <span v-if="tab.key === 'forms'" class="badge af-tab-count ms-1">{{ groupForms.length }}</span>
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
          <span>{{ t('settings.groups.groupNotFound', { id: groupId }) }}</span>
        </div>
        <!-- the record loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !group" shape="form" :count="2" />
        <!-- Details : the name and the description -->
        <div v-if="group && tabShown('details')" class="af-group-details">
          <h6
            v-if="searching && searchHead('details')"
            class="fw-bold text-body-secondary af-search-tab"
            :class="{ 'af-search-first': searchHead('details').first }"
          >
            <FaIcon :icon="searchHead('details').tab.icon" class="me-1" />{{ searchHead('details').tab.label }}
          </h6>
          <BsInput
            class="af-group-field"
            v-model="edit.name"
            v-show="fieldShown('name')"
            icon="users"
            :isFloating="false"
            :required="true"
            :disabled="isAdmins"
            :label="t('settings.fields.name')"
          />
          <BsInput
            class="af-group-field"
            v-model="edit.description"
            v-show="fieldShown('description')"
            icon="info-circle"
            :isFloating="false"
            :label="t('settings.fields.description')"
          />
        </div>
        <!-- Users : the users in the group, a table as every list ; ticked, removed (not from a
             user's only group : a user keeps one) ; a row opens the user. While searching, its
             controls and pager in its own frame, as the other tabs' tables are shown with it -->
        <template v-if="group && tabShown('users')">
          <template v-if="searching && searchHead('users')">
            <hr v-if="!searchHead('users').first" class="mt-4 mb-0 af-search-line" />
            <h6
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('users').first }"
            >
              <FaIcon :icon="searchHead('users').tab.icon" class="me-1" />{{ searchHead('users').tab.label }}
            </h6>
          </template>
          <BsDataTable
            :key="searching ? 'search' : 'tab'"
            search=""
            framed
            :toolbarTo="searching ? null : '#' + toolsId"
            :pagerTo="searching ? null : '#' + pagerId"
            :items="shownMembers"
            :columns="userColumns"
            idKey="id"
            :rowClickSelects="false"
            :rowSelectable="(u) => !onlyGroup(u)"
            linkColumn="username"
            :selectedIds="selectedUsers"
            name="group-users"
            :exportName="`${group.name}-users`"
            :empty="t('settings.groups.noUsers')"
            @update:selectedIds="selectedUsers = $event"
            @row-click="(u) => router.push(`/settings/users/${u.id}`)"
          >
            <template #bulk-actions="{ count }">
              <BsButton v-if="count" icon="trash" @click="removeUsers([...selectedUsers])"
                >{{ t('settings.groups.removeFromGroup') }} ({{ count }})</BsButton
              >
            </template>
            <template #row-actions="{ item }">
              <div class="dropdown">
                <button
                  type="button"
                  class="bs-dt-row-menu px-2"
                  data-bs-toggle="dropdown"
                  data-bs-popper-config='{"strategy":"fixed"}'
                  :aria-label="t('common.actions')"
                >
                  <FaIcon icon="ellipsis-vertical" />
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                  <li>
                    <a
                      class="dropdown-item"
                      :class="onlyGroup(item) ? 'disabled text-muted' : 'text-danger'"
                      href="#"
                      @click.prevent="removeUsers([item.id])"
                    >
                      <FaIcon icon="trash" class="me-2" />{{ t('settings.groups.removeFromGroup') }}
                    </a>
                  </li>
                </ul>
              </div>
            </template>
          </BsDataTable>
        </template>
        <!-- Roles : the roles that name the group ; a row opens the role -->
        <template v-if="group && tabShown('roles')">
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
            :columns="roleColumns"
            :rows="groupRoles"
            rowKey="name"
            :to="(r) => `/settings/roles/${encodeURIComponent(r.name)}`"
            :exportName="`${group.name}-roles`"
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
        <!-- Forms : the forms its roles open ; a row opens the form -->
        <template v-if="group && tabShown('forms')">
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
            :columns="formColumns"
            :rows="groupForms"
            rowKey="name"
            :to="(f) => formPath(f.name)"
            :exportName="`${group.name}-forms`"
            :empty="t('settings.linked.noFormGroup')"
          />
        </template>
        <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
          {{ t('settings.settingsPage.searchNone') }}
        </div>
      </template>
      <!-- its pager, under the card -->
      <template #footer>
        <div :id="pagerId"></div>
      </template>
      <template v-if="group" #actions>
        <BsButton v-if="tabShown('roles')" icon="plus" :disabled="rolesReadOnly" @click="addingRole = true">{{
          t('settings.settingsPage.addRole')
        }}</BsButton>
        <BsButton
          v-if="tabShown('users')"
          icon="plus"
          :disabled="!others.length"
          @click="addingUser = others[0]?.id ?? null"
          >{{ t('settings.settingsPage.addUser') }}</BsButton
        >
        <!-- admins is never deleted, nor a group that still has users (the server refuses both) -->
        <BsButton
          icon="trash"
          :disabled="isAdmins || members.length > 0"
          :title="!isAdmins && members.length > 0 ? t('settings.groups.stillHasUsers') : null"
          @click="confirmDelete = true"
          >{{ t('common.delete') }}</BsButton
        >
        <BsButton v-if="tabShown('details')" icon="save" :disabled="!dirty" @click="saveDetails()">{{
          t('settings.common.save')
        }}</BsButton>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('groups', groupId)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
/* the wide fields' width of the settings pages, as a user's and a role's */
.af-group-field :deep(.input-group) {
  max-width: 40rem;
}
/* the details end a little above the card's edge : the card zeroes its last field's margin */
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
