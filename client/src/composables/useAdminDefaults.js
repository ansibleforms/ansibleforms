/******************************************************************/
/*                                                                */
/*  useAdminDefaults : the Admin option of a role, turned on or   */
/*  off by hand, takes along the options an admin gets by default */
/*  (Show Settings, Show Designer, ...), unless one was set apart */
/*  from that default (it keeps its own value).                   */
/*  Only a change made on the role shown counts : the role page   */
/*  hands the editor another role object when another role is     */
/*  opened or the list is read again, and that role's own Admin   */
/*  option is no change of the user's (its options stay as        */
/*  saved).                                                       */
/*                                                                */
/******************************************************************/
import { watch } from 'vue';
import { adminByDefaultOptions } from '@/config/roles';

/**
 * Follows the Admin option of the role edited and applies its defaults when it is turned on or off.
 *
 * Args:
 *   role (Ref<object>): the role edited ({ _required, _default, name, options }).
 *
 * Returns:
 *   Function: stops following it.
 */
export function useAdminDefaults(role) {
  return watch(
    // the role and its options object along with the Admin option : either one replaced means
    // another role is shown, not the Admin option of this one turned on or off
    () => [role.value, role.value.options, role.value.options?.admin],
    ([shown, options, now], [shownBefore, optionsBefore, before]) => {
      if (shown !== shownBefore || options !== optionsBefore) return;
      if (role.value._required || before === undefined || !!now === !!before) return;
      for (const key of adminByDefaultOptions) {
        if (role.value.options[key] === !!before) role.value.options[key] = !!now;
      }
    },
  );
}
