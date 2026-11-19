/******************************************************************/
/*                                                                */
/*  A user's or a group's roles, changed from its own page (its   */
/*  Roles tab) : Add role names it in a role of the forms config, */
/*  Remove from role takes it out. Saved at once, through the     */
/*  forms config as the roles' pages save it (useFormsConfig,     */
/*  useRoleSupport : the same checks, the same lock).             */
/*                                                                */
/******************************************************************/
import { ref, computed } from 'vue';
import { useFormsConfig } from '@/composables/useFormsConfig';
import { useRoleSupport } from '@/composables/useRoleSupport';
import { EVERYONE_ROLES } from '@/composables/useRoleSupport';

/**
 * The roles a user or a group can be added to or removed from, from its page.
 *
 * Returns:
 *   object: { roleNames, readOnly, ready, addTo, addToAll, removeFrom }.
 */
export function useRoleMembership() {
  const { roles, load, save, nextUid, parseError, isTemplated, loadError } = useFormsConfig();
  const { saveRoles, stampRoleFlags } = useRoleSupport(roles, save);
  const loaded = ref(false);
  // read only when the config cannot be read, parsed or is a ytt template
  const readOnly = computed(() => parseError.value || isTemplated.value || !!loadError.value);
  // the roles one can be named in : every role but everyone's (default)
  const roleNames = computed(() =>
    roles.value
      .map((r) => r.name)
      .filter((n) => !EVERYONE_ROLES.includes(n))
      .sort((a, b) => a.localeCompare(b)),
  );

  /**
   * Reads the forms config's roles, once.
   *
   * Returns:
   *   Promise<void>: when they are read.
   */
  async function ready() {
    if (loaded.value) return;
    await load();
    stampRoleFlags();
    loaded.value = true;
  }

  /**
   * Names a user or a group in a role, and saves.
   *
   * Args:
   *   roleName (string): the role.
   *   kind (string): users or groups.
   *   provider (string): where it comes from (local, ldap, azuread, oidc).
   *   name (string): its name, as the role names it.
   *
   * Returns:
   *   Promise<boolean>: whether it was saved.
   */
  async function addTo(roleName, kind, provider, name) {
    await ready();
    const role = roles.value.find((r) => r.name === roleName);
    if (!role) return false;
    if (role[kind].some((e) => e.provider === provider && e.name === name)) return true;
    const entry = { _uid: nextUid(), provider, name };
    role[kind].push(entry);
    if (await saveRoles()) return true;
    role[kind].splice(role[kind].indexOf(entry), 1);
    return false;
  }

  /**
   * Names a user or a group in several roles, in one save (a new group's roles).
   *
   * Args:
   *   roleNames (string[]): the roles.
   *   kind (string): users or groups.
   *   provider (string): where it comes from (local, ldap, azuread, oidc).
   *   name (string): its name, as the roles name it.
   *
   * Returns:
   *   Promise<boolean>: whether it was saved.
   */
  async function addToAll(roleNames, kind, provider, name) {
    await ready();
    const added = [];
    for (const role of roles.value) {
      if (!roleNames.includes(role.name)) continue;
      if (role[kind].some((e) => e.provider === provider && e.name === name)) continue;
      const entry = { _uid: nextUid(), provider, name };
      role[kind].push(entry);
      added.push([role, entry]);
    }
    if (!added.length || (await saveRoles())) return true;
    // refused : the roles as they were
    for (const [role, entry] of added) role[kind].splice(role[kind].indexOf(entry), 1);
    return false;
  }

  /**
   * Takes a user or a group out of roles, and saves.
   *
   * Args:
   *   roleNames (string[]): the roles.
   *   kind (string): users or groups.
   *   provider (string): where it comes from.
   *   name (string): its name, as the roles name it.
   *
   * Returns:
   *   Promise<boolean>: whether it was saved.
   */
  async function removeFrom(roleNames, kind, provider, name) {
    await ready();
    const before = roles.value.map((r) => [...r[kind]]);
    for (const role of roles.value) {
      if (roleNames.includes(role.name)) {
        role[kind] = role[kind].filter((e) => !(e.provider === provider && e.name === name));
      }
    }
    if (await saveRoles()) return true;
    roles.value.forEach((r, i) => (r[kind] = before[i]));
    return false;
  }

  // read at once : Add role offers them as soon as the page shows
  ready();

  return { roleNames, readOnly, ready, addTo, addToAll, removeFrom };
}
