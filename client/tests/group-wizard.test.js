// The New group dialog is a wizard (pages/admin/groups.vue, config/settings.js groups) : Details,
// Users and Roles, walked by AppAdminMulti's settings.steps ; Next on Details only with a name, Save
// on the last step. Once the group is created, the users picked are added to it and it is given
// the roles picked (lib/groupMembers.js) ; one that fails leaves the group, and a toast says which.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import getSettings from '@/config/settings';
import { addGroupMembers } from '@/lib/groupMembers';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
const src = (f) => readFileSync(join(__dirname, '../src', f), 'utf8');
const groups = getSettings((k) => k).groups;
const field = (key) => groups.fields.find((f) => f.key === key);

describe('the New group wizard : its steps', () => {
  it('Details, Users and Roles, in that order, with the existing labels', () => {
    expect(groups.steps.map((s) => s.key)).toEqual(['details', 'users', 'roles']);
    expect(groups.steps.map((s) => s.label)).toEqual([
      'settings.common.tabDetails',
      'settings.settingsPage.users',
      'settings.settingsPage.roles',
    ]);
  });

  it('Details holds the name and the description, Users the users, Roles the roles', () => {
    // a field naming no step is on the first one
    const stepOf = (key) => field(key).step || groups.steps[0].key;
    expect(['name', 'description'].map(stepOf)).toEqual(['details', 'details']);
    expect(stepOf('user_ids')).toBe('users');
    expect(stepOf('role_names')).toBe('roles');
    // dialog only : no column of the list
    expect(field('user_ids').noTable && field('role_names').noTable).toBe(true);
  });

  it('Users and Roles count what is picked, none at first', () => {
    const [, users, roles] = groups.steps;
    const item = { user_ids: field('user_ids').initial(), role_names: field('role_names').initial() };
    expect([users.count(item), roles.count(item)]).toEqual([0, 0]);
    expect([users.count({ user_ids: [1, 2] }), roles.count({ role_names: ['ops'] })]).toEqual([2, 1]);
  });

  it('the list draws the count beside the step label, as the New role wizard', () => {
    const multi = src('components/AppAdminMulti.vue');
    expect(multi).toContain(`<span v-if="typeof step.count === 'function'" class="badge af-wizard-count">`);
  });
});

describe('the New group wizard : Next and Save', () => {
  it('Next on Details needs a name : the name is required, and a step with an invalid field is not left', () => {
    expect(field('name').required).toBe(true);
    expect(field('name').step).toBeUndefined();
    const multi = src('components/AppAdminMulti.vue');
    // goToStep : forward only when the step shown has no invalid field
    expect(multi).toMatch(
      /function goToStep\(index\) \{[\s\S]*?if \(index > stepIndex\.value\) \{\s*const errors = stepErrors\(\);\s*if \(errors\.length\) \{[\s\S]*?return;/,
    );
    // the users and roles picked are never required : none is fine
    expect(field('user_ids').required).toBeFalsy();
    expect(field('role_names').required).toBeFalsy();
  });

  it('Save is on the last step', () => {
    const multi = src('components/AppAdminMulti.vue');
    expect(multi).toContain('const isLastStep = computed(() => stepIndex.value === steps.value.length - 1);');
  });

  it('the group is created with its own fields only : the picks are not sent', () => {
    const body = groups.beforeSave({ name: 'ops', description: 'x', user_ids: [1], role_names: ['a'] });
    expect(body).toEqual({ name: 'ops', description: 'x' });
  });

  it('the list waits for what the create adds, with the dialog values, before it is read again', () => {
    const multi = src('components/AppAdminMulti.vue');
    expect(multi).toMatch(
      /axios\.post\(`\/api\/v\$\{props\.apiVersion\}\/\$\{objectType\}\/`, body\);[\s\S]*?await props\.settings\.afterSave\?\.\(res\.data, item\.value\);[\s\S]*?loadItems\(\);/,
    );
  });
});

describe('the New group wizard : its users and roles added once it is created', () => {
  it('adds each user, then gives the roles in one save', async () => {
    const calls = [];
    const result = await addGroupMembers({
      groupId: 7,
      userIds: [3, 5],
      roleNames: ['ops', 'viewers'],
      addUser: async (userId, groupId) => calls.push(['user', userId, groupId]),
      addRoles: async (names) => {
        calls.push(['roles', names]);
        return true;
      },
    });
    expect(calls).toEqual([
      ['user', 3, 7],
      ['user', 5, 7],
      ['roles', ['ops', 'viewers']],
    ]);
    expect(result).toEqual({ failedUsers: [], failedRoles: [] });
  });

  it('adds nothing when nothing is picked', async () => {
    const addUser = vi.fn();
    const addRoles = vi.fn();
    expect(await addGroupMembers({ groupId: 7, addUser, addRoles })).toEqual({ failedUsers: [], failedRoles: [] });
    expect(addUser).not.toHaveBeenCalled();
    expect(addRoles).not.toHaveBeenCalled();
  });

  it('the page adds a user through its groups API, and the roles through the forms config', () => {
    const page = src('pages/admin/groups.vue');
    expect(page).toContain('axios.post(`/api/v2/user/${userId}/groups`, { group_id: id })');
    expect(page).toContain("addToAll(names, 'groups', 'local', values.name.trim())");
    expect(page).toContain('afterSave: addPicked');
  });
});

describe('the New group wizard : a failed addition', () => {
  it('goes on after a user that fails, and returns it', async () => {
    const added = [];
    const result = await addGroupMembers({
      groupId: 7,
      userIds: [3, 4, 5],
      roleNames: ['ops'],
      addUser: async (userId) => {
        if (userId === 4) throw new Error('refused');
        added.push(userId);
      },
      addRoles: async () => true,
    });
    expect(added).toEqual([3, 5]);
    expect(result).toEqual({ failedUsers: [4], failedRoles: [] });
  });

  it('returns the roles when their save is refused or throws', async () => {
    const refused = await addGroupMembers({
      groupId: 7,
      roleNames: ['ops'],
      addUser: vi.fn(),
      addRoles: async () => false,
    });
    expect(refused.failedRoles).toEqual(['ops']);
    const thrown = await addGroupMembers({
      groupId: 7,
      roleNames: ['ops', 'dev'],
      addUser: vi.fn(),
      addRoles: async () => {
        throw new Error('locked');
      },
    });
    expect(thrown.failedRoles).toEqual(['ops', 'dev']);
  });

  it('the page says which failed in a toast, in every language', async () => {
    const page = src('pages/admin/groups.vue');
    expect(page).toMatch(/toast\.error\(\s*t\('settings\.groups\.usersNotAdded'/);
    expect(page).toMatch(/toast\.error\(\s*t\('settings\.groups\.rolesNotGiven'/);
    for (const lang of LANGS) {
      const { default: m } = await import(`../src/locales/${lang}.js`);
      for (const key of ['usersNotAdded', 'rolesNotGiven']) {
        expect(m.settings.groups[key], `${lang} ${key}`).toContain('{names}');
      }
    }
  });
});

describe('AppPickList : the users or roles picked', () => {
  const list = src('components/AppPickList.vue');

  it('a dropdown per pick, its icon on the left and its red X, as the New role wizard', () => {
    expect(list).toContain(
      '<span class="input-group-text text-gray-500"><FaIcon :fixedwidth="true" :icon="icon" /></span>',
    );
    expect(list).toContain('class="btn btn-outline-danger align-self-stretch af-remove" @click="remove(index)"');
  });

  it('Add on its own line under the picks, while a choice is left ; what none picked says', () => {
    expect(list).toMatch(
      /<div v-if="left\.length".*>\s*<BsButton icon="plus" @click="add\(\)">\{\{ addLabel \}\}<\/BsButton>/,
    );
    expect(list).toContain('<p v-if="picked.length === 0" class="text-muted small mb-3">{{ emptyText }}</p>');
  });
});
