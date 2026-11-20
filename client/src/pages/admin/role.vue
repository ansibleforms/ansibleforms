<script setup>
/******************************************************************/
/*                                                                */
/*  A role's page (/settings/roles/<name>), opened from the roles    */
/*  list : its Details tab (name and permissions), its Users, its */
/*  Groups and the Forms that name it, the tab kept in the        */
/*  address (/users). Saving writes                               */
/*  the forms config, as the list does ; a renamed role's page    */
/*  follows its new name.                                         */
/*                                                                */
/******************************************************************/
import { ref, computed, onMounted, watch, useId } from 'vue';
import BsDataTable from '@/components/BsDataTable.vue';
import { useRoute, useRouter } from 'vue-router';
import Profile from '@/lib/Profile';
import { useI18n } from 'vue-i18n';
import { useFormsConfig } from '@/composables/useFormsConfig';
import { providerPrefix, roleOptionGroups } from '@/config/roles';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRoleSupport } from '@/composables/useRoleSupport';
import { useRouteTab } from '@/composables/useRouteTab';
import { useFormLinks } from '@/composables/useFormLinks';
import { formPath } from '@/lib/formsPath';
import { recordButtons } from '@/lib/recordButtons';
import { useRecordSearch } from '@/composables/useRecordSearch';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const authenticated = ref(false);
const loaded = ref(false);

const {
  roles,
  load,
  save,
  isRolesDirty,
  parseError,
  isTemplated,
  loadError,
  nextUid,
  roleOptionKeys,
  roleOptionLabel,
  authProviders,
} = useFormsConfig();
const {
  sortedLocalGroups,
  sortedLocalUsers,
  localDescriptions,
  loadLocalNames,
  usersThroughGroups,
  stampRoleFlags,
  saveRoles,
} = useRoleSupport(roles, save);

// leaving with the role changed and unsaved asks first
useUnsavedGuard(isRolesDirty, () => saveRoles());

// read only when the config can't be loaded, can't be parsed or is a ytt template
const readOnly = computed(() => parseError.value || isTemplated.value || !!loadError.value);

// ─── the role of the page ─────────────────────────────────────────────────────
// found by the name it was loaded with (_sortName), so typing a new name does not lose it
const roleName = computed(() => String(route.params.name || ''));
const roleIndex = computed(() => roles.value.findIndex((r) => r._sortName === roleName.value));
const role = computed(() => (roleIndex.value >= 0 ? roles.value[roleIndex.value] : null));
// the local users it gets through its local groups (admin through admins)
const throughGroups = computed(() => usersThroughGroups(role.value));
// what the Users tab counts : the users named, and those through a group, each once
const userCount = computed(() => {
  if (!role.value) return 0;
  const names = new Set(role.value.users.map((u) => `${u.provider}/${u.name}`));
  for (const m of throughGroups.value) names.add(`local/${m.username}`);
  return names.size;
});

// ─── tabs ─────────────────────────────────────────────────────────────────────
// Details (the name, its description and the permissions), Users, Groups, Forms ; the tab kept in
// the url. Default has no count of users or groups : it is everyone's.
const tabs = computed(() => [
  { key: 'details', label: t('settings.common.tabDetails'), icon: 'sliders' },
  {
    key: 'users',
    label: t('settings.settingsPage.users'),
    icon: 'user',
    count: role.value?._default ? null : userCount.value,
  },
  {
    key: 'groups',
    label: t('settings.settingsPage.groups'),
    icon: 'users',
    count: role.value?._default ? null : role.value?.groups.length,
  },
  { key: 'forms', label: t('settings.linked.forms'), icon: 'rectangle-list', count: roleForms.value.length },
]);

// ─── Forms ────────────────────────────────────────────────────────────────────
// the forms that name the role (the admin role : every form) ; a row opens the form
const { loadForms, formsOfRoles } = useFormLinks();
const roleForms = computed(() => (role.value ? formsOfRoles([roleName.value]) : []));
// ─── the Users, Groups and Forms tables ───────────────────────────────────────
// each a table as every list : Select all, the columns and the export on the title line (the
// search is the page's), the pager under the card. Its users : those named in it (ticked to remove them), then
// those it gets through a local group (read only, From group says which)
const toolsId = `af-tools-${useId()}`;
const pagerId = `af-pager-${useId()}`;
const describe = (kind, member) =>
  (member.provider === 'local' ? localDescriptions.value[kind]?.[member.name] : '') || '';
const userRows = computed(() =>
  role.value
    ? [
        ...role.value.users.map((u) => ({
          key: u._uid,
          name: u.name,
          provider: providerPrefix(u.provider),
          description: describe('users', u),
          from: '',
          named: u,
        })),
        ...throughGroups.value.map((m) => ({
          key: `g/${m.username}/${m.group}`,
          name: m.username,
          provider: 'local',
          description: describe('users', { provider: 'local', name: m.username }),
          from: m.group,
        })),
      ]
    : [],
);
const groupRows = computed(() =>
  role.value
    ? role.value.groups.map((g) => ({
        key: g._uid,
        name: g.name,
        provider: providerPrefix(g.provider),
        description: describe('groups', g),
        named: g,
      }))
    : [],
);
const userColumns = computed(() => [
  { key: 'name', label: t('settings.settingsPage.name'), filterable: true },
  { key: 'provider', label: t('settings.settingsPage.provider'), filterable: true },
  { key: 'description', label: t('settings.fields.description'), filterable: true },
  { key: 'from', label: t('settings.settingsPage.roleMemberFrom'), filterable: true },
]);
const groupColumns = computed(() => [
  { key: 'name', label: t('settings.settingsPage.name'), filterable: true },
  { key: 'provider', label: t('settings.settingsPage.provider'), filterable: true },
  { key: 'description', label: t('settings.fields.description'), filterable: true },
]);
const formColumns = computed(() => [
  { key: 'name', label: t('settings.fields.form'), filterable: true },
  { key: 'description', label: t('settings.fields.description'), filterable: true },
]);
const { activeTab, tabLink } = useRouteTab('details', (key) => tabs.value.some((x) => x.key === key));

// the title : Roles › <name>, each step a link : Roles back to the list, the name to this page
const pageCrumbs = computed(() => [
  { title: t('settings.settingsPage.roles'), icon: 'user-shield', to: '/settings/roles' },
  // the role : a link to its own page too, its plain address (the first tab)
  {
    title: role.value?.name || roleName.value,
    icon: 'user-shield',
    to: `/settings/roles/${encodeURIComponent(roleName.value)}`,
  },
]);
// and the open tab last, as every page in tabs names it : Users › admin › Groups
const crumbs = computed(() => {
  const tab = tabs.value.find((x) => x.key === activeTab.value);
  return tab ? [...pageCrumbs.value, { title: tab.label, icon: tab.icon, to: tabLink(tab.key) }] : pageCrumbs.value;
});

// ─── actions ──────────────────────────────────────────────────────────────────
/**
 * Saves the forms config ; a renamed role's page then moves to its new name, on the same tab.
 */
async function saveRole() {
  // its position : the save reloads the roles under their new names, so the old one finds nothing
  const index = roleIndex.value;
  if (!(await saveRoles())) return;
  const name = roles.value[index]?._sortName;
  if (name && name !== roleName.value) {
    router.replace({ path: `/settings/roles/${encodeURIComponent(name)}`, query: route.query });
  }
}

// ─── Add user / Add group ─────────────────────────────────────────────────────
// a dialog for the user or the group added : where it comes from (its provider) and its name,
// a local one picked from the list, another typed. Saved at once, as the other New dialogs.
const adding = ref(null); // { kind: 'users' | 'groups', provider, name }

/**
 * Opens the Add user or Add group dialog, on the first local name not in the role yet.
 *
 * Args:
 *   kind (string): 'users' or 'groups'.
 */
function openAdd(kind) {
  adding.value = { kind, provider: 'local', name: localChoices(kind, 'local')[0] || '' };
}

/**
 * The local names the dialog offers : those not in the role yet.
 *
 * Args:
 *   kind (string): 'users' or 'groups'.
 *   provider (string): the provider chosen ; only 'local' has a list.
 *
 * Returns:
 *   string[]: the names.
 */
function localChoices(kind, provider) {
  if (provider !== 'local' || !role.value) return [];
  const taken = new Set(role.value[kind].filter((e) => e.provider === 'local').map((e) => e.name));
  return (kind === 'users' ? sortedLocalUsers.value : sortedLocalGroups.value).filter((n) => !taken.has(n));
}

/**
 * Adds the user or group of the dialog to the role and saves ; refused, it leaves the role
 * again and the dialog stays open.
 */
// the user or group of the dialog is in the role already : refused, said under the name
const addingTaken = computed(() => {
  if (!adding.value || !role.value) return false;
  const name = (adding.value.name || '').trim();
  return role.value[adding.value.kind].some((e) => e.provider === adding.value.provider && e.name === name);
});

async function confirmAdd() {
  const entry = { _uid: nextUid(), provider: adding.value.provider, name: (adding.value.name || '').trim() };
  if (!entry.name || addingTaken.value) return;
  const list = role.value[adding.value.kind];
  list.push(entry);
  if (await saveRoles()) {
    adding.value = null;
  } else {
    list.splice(list.indexOf(entry), 1);
  }
}

// ─── Remove from role ─────────────────────────────────────────────────────────
// the rows ticked in the Users and in the Groups table (their keys : a member's _uid), each its
// own (both shown while searching) ; none kept from one tab to the other
const noneSelected = () => ({ users: new Set(), groups: new Set() });
const selectedIds = ref(noneSelected());
watch(activeTab, () => (selectedIds.value = noneSelected()));

/**
 * Removes users or groups from the role, saved at once : those ticked, or one row's.
 *
 * Args:
 *   kind (string): 'users' or 'groups', the table they are in.
 *   uids (Set|string[]): the members' _uid.
 */
async function removeMembers(kind, uids) {
  const gone = new Set(uids);
  role.value[kind] = role.value[kind].filter((e) => !gone.has(e._uid));
  selectedIds.value = noneSelected();
  await saveRoles();
}

// ─── search ───────────────────────────────────────────────────────────────────
// A word typed in the title line's search narrows every tab at once, as Settings > General's :
// Details when one of its labels has it (the name, the description, the options and their
// groups), the users, groups and forms with it in one of their cells, each under its tab's
// name, the tabs set aside meanwhile.
const { search, searching, matches, shownTabs, tabShown, searchHead } = useRecordSearch({
  tabs: () => tabs.value,
  activeTab: () => activeTab.value,
  tabMatch: (key) => (key === 'details' ? detailsMatch.value : shownRows.value[key].length),
});
// the editor's fields are its own (AppRoleEditor) : Details shown whole when one matches
const detailsMatch = computed(() =>
  matches(
    t('settings.settingsPage.name'),
    t('settings.fields.description'),
    t('settings.settingsPage.permissions'),
    ...roleOptionGroups.map((g) => t(g.title)),
    ...roleOptionKeys.map((k) => roleOptionLabel(k)),
  ),
);
// the rows the tables get : those with the text in one of their cells ; Default has none (it
// is everyone's)
const shownRows = computed(() => ({
  users: role.value?._default ? [] : userRows.value.filter((r) => matches(r.name, r.provider, r.description, r.from)),
  groups: role.value?._default ? [] : groupRows.value.filter((r) => matches(r.name, r.provider, r.description)),
  forms: roleForms.value.filter((f) => matches(f.name, f.description)),
}));

// Delete asks first : it saves at once
const confirmDelete = ref(false);

/**
 * Removes the role and saves at once, then goes back to the list.
 */
async function deleteRole() {
  confirmDelete.value = false;
  // its place, read before the splice : afterwards the role is not found (roleIndex -1)
  const at = roleIndex.value;
  if (at < 0) return;
  const removed = roles.value.splice(at, 1)[0];
  if (await saveRoles()) {
    router.push('/settings/roles');
  } else {
    // refused (the config locked) : the role stays, where it was
    roles.value.splice(at, 0, removed);
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadLocalNames(), loadForms()]);
  stampRoleFlags();
  loaded.value = true;
});
</script>
<template>
  <BsModal v-if="confirmDelete" size="md" @close="confirmDelete = false" icon="trash">
    <template #title> {{ t('common.delete') }} {{ role?.name }} </template>
    <template #default>
      <p class="mb-0 fs-6 user-select-none">
        {{ t('settings.common.deleteConfirm') }} <strong>{{ role?.name }}</strong>?
      </p>
    </template>
    <template #footer>
      <BsButton icon="trash" @click="deleteRole()">{{ t('common.delete') }}</BsButton>
    </template>
  </BsModal>
  <BsModal v-if="adding" size="md" @close="adding = null" :icon="adding.kind === 'users' ? 'user' : 'users'">
    <template #title>
      {{ adding.kind === 'users' ? t('settings.settingsPage.addUser') : t('settings.settingsPage.addGroup') }}
    </template>
    <template #default>
      <label class="form-label fw-bold">{{ t('settings.settingsPage.provider') }}</label>
      <div class="input-group mb-3">
        <span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" icon="right-to-bracket" /></span>
        <select
          v-model="adding.provider"
          class="form-select"
          @change="adding.name = localChoices(adding.kind, adding.provider)[0] || ''"
        >
          <option v-for="p in authProviders" :key="p" :value="p">{{ providerPrefix(p) }}</option>
        </select>
      </div>
      <label class="form-label fw-bold">{{ t('settings.settingsPage.name') }}</label>
      <div class="input-group">
        <span class="input-group-text text-gray-500"
          ><FaIcon :fixedwidth="true" :icon="adding.kind === 'users' ? 'user' : 'users'"
        /></span>
        <select v-if="adding.provider === 'local'" v-model="adding.name" class="form-select">
          <option v-for="n in localChoices(adding.kind, 'local')" :key="n" :value="n">{{ n }}</option>
        </select>
        <input
          v-else
          v-model="adding.name"
          class="form-control"
          :placeholder="adding.kind === 'users' ? 'username' : 'groupname'"
        />
      </div>
      <div v-if="addingTaken" class="text-danger small mt-1">
        {{ t('settings.settingsPage.roleMemberTaken', { name: adding.name, role: role?.name }) }}
      </div>
      <div
        v-else-if="adding.provider === 'local' && !localChoices(adding.kind, 'local').length"
        class="text-muted small mt-1"
      >
        {{ t('settings.settingsPage.roleNoLocalLeft') }}
      </div>
    </template>
    <template #footer>
      <BsButton icon="save" :disabled="!(adding.name || '').trim() || addingTaken" @click="confirmAdd()">{{
        t('settings.common.save')
      }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="user-shield"
      :title="role?.name || roleName"
      :crumbs="crumbs"
      :description="t('settings.settingsPage.rolesDescription')"
    >
      <!-- narrows every tab at once ; the search box of the other pages -->
      <template v-if="role" #headerActions>
        <BsSearch v-model="search" />
        <!-- Select all, the columns and the export of the Users, Groups and Forms tables, on the
             title line as every list has them (no search box of their own : the page's narrows them, search="") -->
        <div :id="toolsId" class="af-title-flow"></div>
      </template>
      <template v-if="role && !searching" #tabs>
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
              <span v-if="tab.count !== undefined && tab.count !== null" class="badge af-tab-count ms-1">{{
                tab.count
              }}</span>
            </a>
          </li>
        </ul>
      </template>
      <!-- the role loading : its tabs as grey placeholders -->
      <template v-else-if="!loaded && !searching" #tabs>
        <AppSkeleton shape="tabs" :count="tabs.length" />
      </template>
      <template #default>
        <div v-if="loadError" class="alert alert-danger" role="alert">
          {{ t('settings.common.failedToLoad') }} : {{ loadError }}
        </div>
        <div v-else-if="loaded && !role" class="empty-state">
          <FaIcon icon="user-shield" class="empty-state-icon" />
          <span>{{ t('settings.settingsPage.roleNotFound', { name: roleName }) }}</span>
        </div>
        <!-- the role loading : its fields as grey placeholders, where they come -->
        <AppSkeleton v-else-if="!loaded && !role" shape="form" :count="3" />
        <template v-if="role && !loadError">
          <!-- Details : the name, its description and the permissions -->
          <template v-if="tabShown('details')">
            <h6
              v-if="searching && searchHead('details')"
              class="fw-bold text-body-secondary af-search-tab"
              :class="{ 'af-search-first': searchHead('details').first }"
            >
              <FaIcon :icon="searchHead('details').tab.icon" class="me-1" />{{ searchHead('details').tab.label }}
            </h6>
            <AppRoleEditor
              v-model:role="roles[roleIndex]"
              tab="general"
              :readOnly="readOnly"
              :authProviders="authProviders"
              :localGroups="sortedLocalGroups"
              :localUsers="sortedLocalUsers"
              :optionKeys="roleOptionKeys"
              :optionLabel="roleOptionLabel"
              :nextUid="nextUid"
            />
          </template>
          <!-- Users, Groups : tables as every list ; a member named in the role can be ticked and
               removed, one through a group is changed on the group. While searching, each table's
               controls and pager in its own frame, as the other tabs' tables are shown with it -->
          <template v-for="kind in ['users', 'groups']" :key="kind">
            <template v-if="tabShown(kind)">
              <template v-if="searching && searchHead(kind)">
                <hr v-if="!searchHead(kind).first" class="mt-4 mb-0 af-search-line" />
                <h6
                  class="fw-bold text-body-secondary af-search-tab"
                  :class="{ 'af-search-first': searchHead(kind).first }"
                >
                  <FaIcon :icon="searchHead(kind).tab.icon" class="me-1" />{{ searchHead(kind).tab.label }}
                </h6>
              </template>
              <!-- Default is everyone's : no users or groups to list -->
              <p v-if="role._default" class="text-muted small mb-0">
                {{ t('settings.settingsPage.defaultEveryone') }}
              </p>
              <BsDataTable
                v-else
                :key="`${kind}-${searching ? 'search' : 'tab'}`"
                search=""
                framed
                :toolbarTo="searching ? null : '#' + toolsId"
                :pagerTo="searching ? null : '#' + pagerId"
                :items="shownRows[kind]"
                :columns="kind === 'users' ? userColumns : groupColumns"
                idKey="key"
                :selectable="!readOnly"
                :rowSelectable="(row) => !!row.named"
                :rowClickSelects="false"
                linkColumn="none"
                :selectedIds="selectedIds[kind]"
                :name="`role-${kind}`"
                :exportName="`${role.name}-${kind}`"
                :empty="
                  kind === 'users' ? t('settings.settingsPage.roleNoUsers') : t('settings.settingsPage.roleNoGroups')
                "
                @update:selectedIds="selectedIds = { ...selectedIds, [kind]: $event }"
              >
                <template #bulk-actions="{ count }">
                  <BsButton
                    v-if="count"
                    icon="trash"
                    :disabled="readOnly"
                    @click="removeMembers(kind, selectedIds[kind])"
                    >{{ t('settings.settingsPage.removeFromRole') }} ({{ count }})</BsButton
                  >
                </template>
                <template v-if="!readOnly" #row-actions="{ item }">
                  <div v-if="item.named" class="dropdown">
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
                          class="dropdown-item text-danger"
                          href="#"
                          @click.prevent="removeMembers(kind, [item.named._uid])"
                        >
                          <FaIcon icon="trash" class="me-2" />{{ t('settings.settingsPage.removeFromRole') }}
                        </a>
                      </li>
                    </ul>
                  </div>
                </template>
              </BsDataTable>
            </template>
          </template>
          <!-- Forms : the forms that name the role ; a row opens the form -->
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
            <BsDataTable
              :key="`forms-${searching ? 'search' : 'tab'}`"
              search=""
              framed
              :toolbarTo="searching ? null : '#' + toolsId"
              :pagerTo="searching ? null : '#' + pagerId"
              :items="shownRows.forms"
              :columns="formColumns"
              idKey="name"
              :selectable="false"
              :rowClickSelects="false"
              linkColumn="name"
              name="role-forms"
              :exportName="`${role.name}-forms`"
              :empty="t('settings.linked.noFormRole')"
              @row-click="(f) => router.push(formPath(f.name))"
            />
          </template>
          <div v-if="searching && !shownTabs.length" class="text-body-secondary fst-italic">
            {{ t('settings.settingsPage.searchNone') }}
          </div>
        </template>
      </template>
      <!-- their pager, under the card -->
      <template #footer>
        <div :id="pagerId"></div>
      </template>
      <template v-if="role" #actions>
        <!-- the tab's own add, top right as on the other pages -->
        <BsButton
          v-if="tabShown('users') && !role._default"
          icon="plus"
          :disabled="readOnly"
          @click="openAdd('users')"
          >{{ t('settings.settingsPage.addUser') }}</BsButton
        >
        <BsButton
          v-if="tabShown('groups') && !role._default"
          icon="plus"
          :disabled="readOnly"
          @click="openAdd('groups')"
          >{{ t('settings.settingsPage.addGroup') }}</BsButton
        >
        <BsButton v-if="!role._required" icon="trash" :disabled="readOnly" @click="confirmDelete = true">{{
          t('common.delete')
        }}</BsButton>
        <BsButton icon="save" :disabled="!isRolesDirty || readOnly" @click="saveRole()">{{
          t('settings.common.save')
        }}</BsButton>
      </template>
      <!-- the record loading : its buttons as grey placeholders, so the title line keeps its
           height and nothing moves when they come -->
      <template v-else-if="!loaded" #actions>
        <AppSkeleton shape="buttons" :widths="recordButtons('roles', roleName)" />
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
<style scoped>
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
