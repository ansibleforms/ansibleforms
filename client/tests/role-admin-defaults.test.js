// The Admin option of a role takes along the options an admin gets by default
// (composables/useAdminDefaults.js, used by AppRoleEditor).
//
// The role page binds the editor to roles[roleIndex] : opening another role (a new name in the
// address, the page kept) or reading the list again hands the editor another role object. The
// watch saw the Admin option of the old role, then that of the new one, took an admin role
// followed by a non-admin role for Admin turned off, and turned off Show Settings, Show Designer
// and the like on the role just opened : changed and unsaved, and saving it took those rights away.
import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { useAdminDefaults } from '../src/composables/useAdminDefaults.js';
import { adminByDefaultOptions } from '../src/config/roles.js';

/**
 * A role, every option an admin gets by default set to the same value.
 *
 * Args:
 *   name (string): its name.
 *   admin (boolean): its Admin option.
 *   value (boolean): the value of the options an admin gets by default.
 *
 * Returns:
 *   object: the role, as the editor holds it.
 */
function makeRole(name, admin, value) {
  const options = { admin };
  for (const key of adminByDefaultOptions) options[key] = value;
  return { _required: false, _default: false, name, groups: [], users: [], options };
}

describe('the Admin option of a role', () => {
  it('opening a non-admin role after an admin role changes nothing on it', async () => {
    const admins = makeRole('admins', true, true);
    // a role with Admin off whose admin options are still on, set apart from the default
    const ops = makeRole('ops', false, true);
    const saved = JSON.stringify(ops);
    const role = ref(admins);
    const stop = useAdminDefaults(role);
    role.value = ops;
    await nextTick();
    expect(JSON.stringify(ops)).toBe(saved);
    stop();
  });

  it('opening an admin role after a non-admin role changes nothing on it', async () => {
    const ops = makeRole('ops', false, false);
    const admins = makeRole('admins', true, false);
    const saved = JSON.stringify(admins);
    const role = ref(ops);
    const stop = useAdminDefaults(role);
    role.value = admins;
    await nextTick();
    expect(JSON.stringify(admins)).toBe(saved);
    stop();
  });

  it('reading the list again (a copy of the same role) changes nothing on it', async () => {
    const role = ref(makeRole('admins', true, true));
    const stop = useAdminDefaults(role);
    const reloaded = makeRole('admins', false, true);
    role.value = reloaded;
    await nextTick();
    expect(reloaded.options.showSettings).toBe(true);
    stop();
  });

  it('turned on by hand turns on the options an admin gets by default', async () => {
    const role = ref(makeRole('ops', false, false));
    const stop = useAdminDefaults(role);
    role.value.options.admin = true;
    await nextTick();
    for (const key of adminByDefaultOptions) expect(role.value.options[key]).toBe(true);
    stop();
  });

  it('turned off by hand turns them off, except one set apart from the default', async () => {
    const role = ref(makeRole('ops', true, true));
    role.value.options.showLogs = false;
    const stop = useAdminDefaults(role);
    role.value.options.admin = false;
    await nextTick();
    expect(role.value.options.showSettings).toBe(false);
    expect(role.value.options.showDesigner).toBe(false);
    expect(role.value.options.showLogs).toBe(false);
    // turned on again : showLogs, set apart, stays as it is ; the others follow
    role.value.options.showLogs = true;
    role.value.options.admin = true;
    await nextTick();
    expect(role.value.options.showSettings).toBe(true);
    stop();
  });

  it('toggled by hand on a role opened after another still applies its defaults', async () => {
    const role = ref(makeRole('admins', true, true));
    const stop = useAdminDefaults(role);
    role.value = makeRole('ops', false, false);
    await nextTick();
    role.value.options.admin = true;
    await nextTick();
    for (const key of adminByDefaultOptions) expect(role.value.options[key]).toBe(true);
    stop();
  });

  it('the admin and default roles are never changed', async () => {
    const role = ref({ ...makeRole('admin', true, true), _required: true });
    const stop = useAdminDefaults(role);
    role.value.options.admin = false;
    await nextTick();
    expect(role.value.options.showSettings).toBe(true);
    stop();
  });
});
