<script setup>
import { ref, computed, onMounted, useId } from 'vue';
import { useRouter } from 'vue-router';
import Profile from '@/lib/Profile';
import { useI18n } from 'vue-i18n';
import { useFormsConfig } from '@/composables/useFormsConfig';
import { useUnsavedGuard } from '@/composables/useUnsavedGuard';
import { useRoleSupport, roleNameProblem } from '@/composables/useRoleSupport';
import { useWizard } from '@/composables/useWizard';
import { requiredRoleDescription, roleWizardSteps } from '@/config/roles';
import { toast } from 'vue-sonner';
import BsDataTable from '@/components/BsDataTable.vue';
import { tableControls } from '@/lib/listControls';
import { askConfirm } from '@/lib/confirmPrompt';

const { t } = useI18n();
const router = useRouter();
const authenticated = ref(false);
// the roles read once : until then the table's rows as grey placeholders
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
  roleOptionDefaults,
  roleOptionLabel,
  authProviders,
} = useFormsConfig();
const { sortedLocalGroups, sortedLocalUsers, loadLocalNames, usersThroughGroups, stampRoleFlags, saveRoles } =
  useRoleSupport(roles, save);

// a role removed here is only gone once saved : leaving with it unsaved asks first
useUnsavedGuard(
  isRolesDirty,
  () => t('settings.common.unsavedChanges'),
  () => saveRoles(),
);

// Read-only when the config can't be loaded, can't be parsed or is a ytt template.
const readOnly = computed(() => parseError.value || isTemplated.value || !!loadError.value);

/**
 * Opens a role's page (/settings/roles/<name>) : its General, Users and Groups tabs.
 *
 * Args:
 *   role (object): the role clicked.
 */
function openRole(role) {
  router.push(`/settings/roles/${encodeURIComponent(role._sortName || role.name)}`);
}

/**
 * Opens the role of a row (the table gives the row, not the role).
 *
 * Args:
 *   item (object): the row.
 */
function openRow(item) {
  const role = roles.value.find((r) => r._uid === item.id);
  if (role) openRole(role);
}

// the roles in alphabetical order, each with its position in the config (which keeps its own
// order : the list is sorted, the file is not)
const sortedRoles = computed(() =>
  roles.value
    .map((role, rIdx) => ({ role, rIdx }))
    .sort((a, b) => (a.role._sortName ?? '').localeCompare(b.role._sortName ?? '', undefined, { sensitivity: 'base' })),
);

// ─── the New role wizard ──────────────────────────────────────────────────────
// A new role is filled in a dialog, not as an empty row at the end of the list : it joins the
// list, and the config is saved, only when the dialog is saved. The dialog is a wizard, as the
// other New dialogs : Details (its name and description), Permissions, Users, Groups ; Next
// leaves Details only with a name a save takes, Save is on the last step.
const newRole = ref(null);
// the name checked once Next or Save was tried : its problem shown under it from then on, as typed
const nameTouched = ref(false);
// why the new role's name cannot be saved, or '' : the checks of a save (useRoleSupport)
const newRoleNameError = computed(() => {
  if (!newRole.value || !nameTouched.value) return '';
  const taken = new Set(roles.value.filter((r) => r !== newRole.value).map((r) => (r.name || '').trim()));
  return roleNameProblem(t, newRole.value.name, taken) || '';
});
// the steps, each with its label, and Users and Groups with their count
const roleSteps = computed(() =>
  roleWizardSteps.map((step) => ({
    key: step.key,
    label: t(step.label),
    count: step.count && newRole.value ? newRole.value[step.count].length : undefined,
  })),
);
const {
  stepIndex: roleStep,
  stepReached: roleStepReached,
  step: roleStepShown,
  isLastStep: roleLastStep,
  goToStep: goToRoleStep,
  reset: resetRoleSteps,
} = useWizard(roleSteps, (step) => {
  if (step.key !== 'details') return true;
  nameTouched.value = true;
  return !newRoleNameError.value;
});

/**
 * Opens the New role wizard on an empty role, at its first step.
 */
function addRole() {
  resetRoleSteps();
  nameTouched.value = false;
  newRole.value = {
    _uid: nextUid(),
    _required: false,
    _default: false,
    name: '',
    groups: [],
    users: [],
    // start from the effective defaults : that is what a role without an
    // options block gets today, starting all-off would silently take
    // permissions away now that every flag is written explicitly
    options: roleOptionDefaults(''),
  };
}

/**
 * Adds the role of the dialog to the list and saves the config. The dialog stays open, and
 * the role leaves the list again, when the save is refused (a name taken, the config locked).
 */
async function createRole() {
  const role = newRole.value;
  roles.value.push(role);
  if (await saveRoles()) {
    newRole.value = null;
  } else {
    const index = roles.value.indexOf(role);
    if (index >= 0) roles.value.splice(index, 1);
  }
}

// ─── the table ────────────────────────────────────────────────────────────────
// the app's data table, as the other lists : a checkbox per role, Select all and Delete for the
// selection, the search and the columns on the title line, a row's menu ; a row opens its role
const toolsId = `af-tools-${useId()}`;
// and where its pager goes, under the card
const pagerId = `af-pager-${useId()}`;
const selectedIds = ref(new Set());
const escapeHtml = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
/**
 * How many users a role reaches : those named in it, and the local users of its local groups,
 * each once (the Users tab of its page). Members of LDAP or SSO groups are only known when they
 * sign in, so they are not counted.
 *
 * Args:
 *   role (object): the role.
 *
 * Returns:
 *   number: the users.
 */
function roleUserCount(role) {
  const names = new Set(role.users.map((u) => `${u.provider}/${u.name}`));
  for (const m of usersThroughGroups(role)) names.add(`local/${m.username}`);
  return names.size;
}

const tableItems = computed(() =>
  sortedRoles.value.map(({ role }) => ({
    id: role._uid,
    name: role.name,
    // admin and default : their fixed description
    description: role._required ? requiredRoleDescription(t, role.name) : role.description || '',
    required: role._required,
    // the default role is everyone's : no count
    users: role._default ? null : roleUserCount(role),
    // the groups it names, of every provider (local, LDAP, SSO) ; default's : none to name
    groups: role._default ? null : role.groups.length,
  })),
);
const columns = computed(() => [
  {
    key: 'name',
    // as wide as the longest name and its Required badge (v-fit-columns)
    label: t('settings.settingsPage.name'),
    sortable: true,
    filterable: true,
    // admin and default : the config must keep them, said beside their name
    render: (v, row) =>
      escapeHtml(v) +
      (row.required
        ? ` <span class="badge af-required-badge ms-2">${escapeHtml(t('settings.settingsPage.requiredItem'))}</span>`
        : ''),
  },
  // what the role is for ; an en dash when it says nothing
  {
    key: 'description',
    label: t('settings.fields.description'),
    sortable: true,
    filterable: true,
    render: (v) => (v ? escapeHtml(v) : '–'),
  },
  // how many users it reaches (local ones : see roleUserCount) ; default, everyone's, says All
  {
    key: 'users',
    label: t('settings.settingsPage.users'),
    align: 'end',
    sortable: true,
    filterable: false,
    sortValue: (row) => (row.users === null ? Number.MAX_SAFE_INTEGER : row.users),
    // none : an en dash, as the other empty cells
    render: (v) => (v === null ? escapeHtml(t('settings.settingsPage.roleUsersAll')) : v ? String(v) : '–'),
  },
  // how many groups it names ; default, everyone's, names none : All, as its users
  {
    key: 'groups',
    label: t('settings.settingsPage.groups'),
    align: 'end',
    sortable: true,
    filterable: false,
    sortValue: (row) => (row.groups === null ? Number.MAX_SAFE_INTEGER : row.groups),
    render: (v) => (v === null ? escapeHtml(t('settings.settingsPage.roleUsersAll')) : v ? String(v) : '–'),
  },
]);

/**
 * Removes roles and saves at once ; refused (the config locked), they come back.
 *
 * Args:
 *   uids (number[]): the roles' _uid.
 */
async function deleteRoles(uids) {
  const removed = roles.value.filter((r) => uids.includes(r._uid));
  roles.value = roles.value.filter((r) => !uids.includes(r._uid));
  if (await saveRoles()) {
    selectedIds.value = new Set();
  } else {
    roles.value = [...roles.value, ...removed];
  }
}

/**
 * Deletes the roles selected, after asking ; admin and default are left alone.
 */
async function bulkDelete() {
  const present = new Map(tableItems.value.map((r) => [r.id, r]));
  const chosen = [...selectedIds.value].filter((id) => present.has(id));
  const ids = chosen.filter((id) => !present.get(id).required);
  const skipped = chosen.length - ids.length;
  if (!ids.length) {
    if (skipped) toast.warning(t('settings.common.bulkDeleteNone'));
    return;
  }
  const question = skipped
    ? t('settings.common.bulkDeleteConfirmSkip', { count: ids.length, skipped })
    : t('settings.common.bulkDeleteConfirm', { count: ids.length });
  if (!(await askConfirm(question, { title: t('common.delete'), icon: 'trash' }))) return;
  await deleteRoles(ids);
}

/**
 * Deletes one role from its row's menu, after asking.
 *
 * Args:
 *   item (object): the row.
 */
async function deleteOne(item) {
  if (item.required) return;
  if (
    !(await askConfirm(`${t('settings.common.deleteConfirm')} ${item.name}?`, {
      title: t('common.delete'),
      icon: 'trash',
    }))
  )
    return;
  await deleteRoles([item.id]);
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) return;
  await Promise.all([load(), loadLocalNames()]);
  stampRoleFlags();
  loaded.value = true;
});
</script>
<template>
  <BsModal v-if="newRole" size="lg" @close="newRole = null" icon="user-shield">
    <template #title> {{ t('settings.settingsPage.newRole') }} </template>
    <!-- its steps, above the fields and out of their scroll ; back to a step reached -->
    <template #top>
      <AppWizardSteps :steps="roleSteps" :current="roleStep" :reached="roleStepReached" @go="goToRoleStep" />
    </template>
    <template #default>
      <AppRoleEditor
        v-model:role="newRole"
        :step="roleStepShown.key"
        :nameError="newRoleNameError"
        :authProviders="authProviders"
        :localGroups="sortedLocalGroups"
        :localUsers="sortedLocalUsers"
        :optionKeys="roleOptionKeys"
        :optionLabel="roleOptionLabel"
        :nextUid="nextUid"
      />
    </template>
    <!-- Previous / Next, and Save on the last step -->
    <template #footer>
      <BsButton v-if="roleStep > 0" icon="arrow-left" @click="goToRoleStep(roleStep - 1)">{{
        t('common.previous')
      }}</BsButton>
      <BsButton v-if="!roleLastStep" icon="arrow-right" @click="goToRoleStep(roleStep + 1)">{{
        t('common.next')
      }}</BsButton>
      <BsButton v-if="roleLastStep" icon="save" @click="createRole()">{{ t('settings.common.save') }}</BsButton>
    </template>
  </BsModal>
  <AppSettingsPage>
    <AppSettings
      v-if="authenticated"
      icon="user-shield"
      :title="t('settings.settingsPage.roles')"
      :description="t('settings.settingsPage.rolesDescription')"
    >
      <!-- the table's search and columns, on the title line as the other lists have them -->
      <template #headerActions>
        <div :id="toolsId" class="af-title-flow"></div>
        <!-- the first load : the table's controls as grey placeholders, so the title line has their
             room before they come (lib/listControls.js) -->
        <AppSkeleton v-if="!loaded" shape="buttons" :widths="tableControls(!readOnly)" />
      </template>
      <template #default>
        <div>
          <div v-if="loadError" class="alert alert-danger" role="alert">
            {{ t('settings.common.failedToLoad') }} : {{ loadError }}
          </div>
          <!-- the first load : the table's rows as grey placeholders -->
          <AppSkeleton v-if="!loaded" shape="table" :count="6" />
          <div v-else-if="roles.length === 0" class="empty-state">
            <FaIcon icon="user-shield" class="empty-state-icon" />
            <span>{{ t('settings.settingsPage.noRoles') }}</span>
          </div>
          <!-- the app's data table : checkboxes, Select all, Delete, search and columns on the
             title line ; a row opens its role's page -->
          <BsDataTable
            v-else
            framed
            :toolbarTo="'#' + toolsId"
            :pagerTo="'#' + pagerId"
            :items="tableItems"
            :columns="columns"
            idKey="id"
            :selectedIds="selectedIds"
            :selectable="!readOnly"
            :rowSelectable="(row) => !row.required"
            linkColumn="name"
            :rowClickSelects="false"
            :name="t('settings.settingsPage.roles')"
            :exportName="t('settings.settingsPage.roles')"
            @update:selectedIds="selectedIds = $event"
            @row-click="openRow"
          >
            <template v-if="!readOnly" #bulk-actions="{ count }">
              <BsButton v-if="count" icon="trash" @click="bulkDelete">
                {{ t('common.delete') }} ({{ count }})
              </BsButton>
            </template>
            <template #row-actions="{ item }">
              <div class="dropdown">
                <button
                  type="button"
                  class="bs-dt-row-menu px-2"
                  data-bs-toggle="dropdown"
                  data-bs-popper-config='{"strategy":"fixed"}'
                  @click.stop
                  :aria-label="t('common.actions')"
                >
                  <font-awesome-icon icon="ellipsis-vertical" />
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                  <li>
                    <a class="dropdown-item" href="#" @click.prevent="openRow(item)">
                      <font-awesome-icon icon="pencil" class="me-2" />{{ t('common.edit') }}
                    </a>
                  </li>
                  <li><hr class="dropdown-divider" /></li>
                  <li>
                    <a
                      class="dropdown-item"
                      :class="item.required || readOnly ? 'disabled text-muted' : 'text-danger'"
                      href="#"
                      @click.prevent="deleteOne(item)"
                    >
                      <font-awesome-icon icon="trash" class="me-2" />{{ t('common.delete') }}
                    </a>
                  </li>
                </ul>
              </div>
            </template>
          </BsDataTable>
        </div>
      </template>
      <!-- the table's pager, under the card -->
      <template #footer><div :id="pagerId"></div></template>
      <template #actions>
        <BsButton icon="plus" :disabled="readOnly" @click="addRole()">{{
          t('settings.settingsPage.addRole')
        }}</BsButton>
      </template>
    </AppSettings>
  </AppSettingsPage>
</template>
