<script setup>
/******************************************************************/
/*                                                                */
/*  Settings > Users : the local users and the LDAP and SSO ones  */
/*  (AppAdminMulti, config/settings.js users) ; a row's Block     */
/*  sign-in asks first, its Allow sign-in saves at once. The New  */
/*  user wizard's Roles step : the roles picked are given once    */
/*  the user is created.                                          */
/*                                                                */
/******************************************************************/
import getSettings from '@/config/settings';
import Profile from '@/lib/Profile';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import { setSignInBlocked } from '@/lib/signIn';
import Helpers from '@/lib/Helpers';
import { useRoleMembership } from '@/composables/useRoleMembership';
import { giveRoles } from '@/lib/groupMembers';

const { t } = useI18n();
const authenticated = ref(false);

// ─── the New user wizard : its roles ──────────────────────────────────────────
// User, Password, Group, then Roles (config/settings.js) : the roles to pick from are read here,
// and those picked are given once the user is created
const { roleNames, readOnly: rolesReadOnly, addToAll } = useRoleMembership();
// the forms config locked or unreadable : no role to give
const roleChoices = computed(() => (rolesReadOnly.value ? [] : roleNames.value.map((n) => ({ value: n, label: n }))));

/**
 * Once a user is created : names it, as a local user, in the roles picked, in one save. A save
 * that fails leaves the user created, and a toast names the roles not given ; the list is read
 * again after it.
 *
 * Args:
 *   _answer (*): the create's answer (unused : the roles name the user by its username).
 *   values (object): the dialog's values, with username and role_names ; none after an update
 *     or a delete, which give nothing.
 *
 * Returns:
 *   Promise<void>: when they are given.
 */
async function givePicked(_answer, values) {
  if (!values?.role_names?.length) return;
  // named as the server stored it : a username is kept as typed
  const failed = await giveRoles(values.role_names, (names) => addToAll(names, 'users', 'local', values.username));
  if (failed.length) toast.error(t('settings.users.rolesNotGiven', { names: failed.join(', ') }));
}

// the list's settings, the Roles step given its choices, and the picks given after
const settings = computed(() => {
  const users = getSettings(t).users;
  return {
    ...users,
    fields: users.fields.map((field) =>
      field.key === 'role_names'
        ? { ...field, props: (item, list) => ({ ...field.props(item, list), choices: roleChoices.value }) }
        : field,
    ),
    afterSave: givePicked,
  };
});
const adminMulti = ref(null);
// the user whose Block sign-in is being asked, null while the dialog is closed
const blocking = ref(null);

/**
 * Blocks or allows a user's sign-in, then reloads the list ; a refusal (its own sign-in) in a
 * toast.
 *
 * Args:
 *   user (object): the row.
 *   blocked (boolean): true to block.
 */
async function setBlocked(user, blocked) {
  blocking.value = null;
  const name = user.username;
  try {
    await setSignInBlocked(user, blocked);
    toast.success(
      blocked ? t('settings.directory.nowBlocked', { name }) : t('settings.directory.nowAllowed', { name }),
    );
    adminMulti.value?.loadItems();
  } catch (err) {
    toast.error(Helpers.parseAxiosResponseError(err));
  }
}

onMounted(async () => {
  authenticated.value = !!(await Profile.load());
  if (!authenticated.value) {
    return;
  }
});
</script>

<template>
  <AppBlockSignInDialog
    v-if="blocking"
    :name="blocking.username"
    @confirm="setBlocked(blocking, true)"
    @close="blocking = null"
  />
  <AppSettingsPage>
    <AppAdminMulti
      v-if="authenticated"
      ref="adminMulti"
      :settings="settings"
      :apiVersion="2"
      @block_sign_in="(u) => (blocking = u)"
      @allow_sign_in="(u) => setBlocked(u, false)"
    />
  </AppSettingsPage>
</template>
