/******************************************************************/
/*                                                                */
/*  useRoleAssignments : the roles assigned to a user or a group, */
/*  local or from a directory (LDAP, Entra ID, OIDC)              */
/*                                                                */
/*  For the Roles tab of a user's page and a group's page : the   */
/*  roles of the config (config.yaml) that name the user, one of  */
/*  its groups, or the group - and default, everyone's role. Read */
/*  quietly : a config the roles editor warns about (a ytt        */
/*  template) still lists its roles here.                         */
/*                                                                */
/******************************************************************/
import { EVERYONE_ROLES } from '@/composables/useRoleSupport';
import { ref } from 'vue';
import axios from 'axios';
import yaml from 'yaml';
import { useI18n } from 'vue-i18n';
import { roleToEditable, requiredRoleDescription } from '@/config/roles';

/**
 * The roles of the config, and those of a user or a group.
 *
 * Returns:
 *   object: { loadRoles, rolesOfUser, rolesOfGroup }.
 */
export function useRoleAssignments() {
  const { t } = useI18n();
  // the config's roles, as the roles editor reads them : { name, description, users, groups }
  const roles = ref([]);

  /**
   * Reads the roles of the config ; none when it cannot be read.
   *
   * Returns:
   *   Promise<void>: when they are read.
   */
  async function loadRoles() {
    try {
      const result = await axios.get('/api/v2/settings/config');
      const config = yaml.parse(result.data?.config_yaml || '') || {};
      roles.value = (Array.isArray(config.roles) ? config.roles : [])
        .filter((r) => r && typeof r === 'object')
        .map(roleToEditable);
    } catch {
      roles.value = [];
    }
  }

  // a role as a row : its name and what it is for (admin's and default's own words)
  const row = (r) => ({ name: r.name, description: requiredRoleDescription(t, r.name) || r.description || '' });
  const byName = (a, b) => a.name.localeCompare(b.name);
  const names = (list, provider, wanted) =>
    list.filter((x) => x.provider === provider && wanted.has(x.name)).map((x) => x.name);

  /**
   * The roles a user has, each with how : by its name, through some of its groups, or as
   * everyone's (default).
   *
   * Args:
   *   username (string): the user's name.
   *   groupNames (string[]): the names of its groups (without their provider).
   *   provider (string): where the user and its groups come from : local (default), ldap,
   *     azuread, oidc.
   *
   * Returns:
   *   object[]: { name, description, direct, groups (string[]), everyone }, by name.
   */
  function rolesOfUser(username, groupNames, provider = 'local') {
    const mine = new Set(groupNames);
    return roles.value
      .map((r) => {
        const everyone = EVERYONE_ROLES.includes(r.name);
        const direct = !everyone && names(r.users, provider, new Set([username])).length > 0;
        const groups = everyone ? [] : names(r.groups, provider, mine);
        return everyone || direct || groups.length ? { ...row(r), direct, groups, everyone } : null;
      })
      .filter(Boolean)
      .sort(byName);
  }

  /**
   * The roles that name a group.
   *
   * Args:
   *   groupName (string): the group's name (without its provider).
   *   provider (string): where the group comes from : local (default), ldap, azuread, oidc.
   *
   * Returns:
   *   object[]: { name, description }, by name.
   */
  function rolesOfGroup(groupName, provider = 'local') {
    return roles.value
      .filter((r) => !EVERYONE_ROLES.includes(r.name) && names(r.groups, provider, new Set([groupName])).length)
      .map(row)
      .sort(byName);
  }

  return { loadRoles, rolesOfUser, rolesOfGroup };
}
