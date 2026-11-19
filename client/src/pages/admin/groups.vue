<script setup>
import getSettings from '@/config/settings';
import Profile from '@/lib/Profile';
import { useI18n } from 'vue-i18n';
import axios from 'axios';
import { toast } from 'vue-sonner';
import { useRoleMembership } from '@/composables/useRoleMembership';
import { addGroupMembers } from '@/lib/groupMembers';

const { t } = useI18n();
const authenticated = ref(false);

// ─── the New group wizard : its users and roles ───────────────────────────────
// Details, then Users and Roles (config/settings.js) : the local users and the roles to pick
// from are read here, and those picked are added once the group is created
const localUsers = ref([]);
const { roleNames, readOnly: rolesReadOnly, addToAll } = useRoleMembership();
const choicesOf = computed(() => ({
  user_ids: localUsers.value.map((u) => ({ value: u.id, label: u.username })),
  // the forms config locked or unreadable : no role to give
  role_names: rolesReadOnly.value ? [] : roleNames.value.map((n) => ({ value: n, label: n })),
}));

/**
 * Reads the local users a new group can hold ; an error leaves none to pick.
 *
 * Returns:
 *   Promise<void>: when they are read.
 */
async function loadLocalUsers() {
  try {
    const result = await axios.get('/api/v2/user/');
    const records = result.data.records || result.data;
    localUsers.value = [...records].sort((a, b) => a.username.localeCompare(b.username));
  } catch {
    localUsers.value = [];
  }
}

/**
 * Once a group is created : adds the users picked to it and gives it the roles picked. One that
 * fails leaves the group created, and a toast says which ; the list is read again after it.
 *
 * Args:
 *   groupId (number): the group created (the create's answer).
 *   values (object): the dialog's values, with user_ids and role_names ; none after an update
 *     or a delete, which add nothing.
 *
 * Returns:
 *   Promise<void>: when they are added.
 */
async function addPicked(groupId, values) {
  if (!values || groupId === null || groupId === undefined) return;
  const { failedUsers, failedRoles } = await addGroupMembers({
    groupId,
    userIds: values.user_ids || [],
    roleNames: values.role_names || [],
    addUser: (userId, id) => axios.post(`/api/v2/user/${userId}/groups`, { group_id: id }),
    addRoles: (names) => addToAll(names, 'groups', 'local', values.name.trim()),
  });
  if (failedUsers.length) {
    const nameOf = new Map(localUsers.value.map((u) => [u.id, u.username]));
    toast.error(
      t('settings.groups.usersNotAdded', { names: failedUsers.map((id) => nameOf.get(id) ?? id).join(', ') }),
    );
  }
  if (failedRoles.length) {
    toast.error(t('settings.groups.rolesNotGiven', { names: failedRoles.join(', ') }));
  }
}

// the list's settings, the wizard's pick lists given their choices, and the picks added after
const settings = computed(() => {
  const groups = getSettings(t).groups;
  return {
    ...groups,
    fields: groups.fields.map((field) =>
      field.key in choicesOf.value
        ? { ...field, props: (item, list) => ({ ...field.props(item, list), choices: choicesOf.value[field.key] }) }
        : field,
    ),
    afterSave: addPicked,
  };
});

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
  await loadLocalUsers();
});
</script>
<template>
  <AppSettingsPage>
    <AppAdminMulti v-if="authenticated" :apiVersion="2" :settings="settings" />
  </AppSettingsPage>
</template>
