// The New user dialog is a wizard (pages/admin/users.vue, config/settings.js users) : User,
// Password, Group and Roles, walked by AppAdminMulti's settings.steps ; Save on the last step.
// Once the user is created, it is named as a local user in the roles picked, in one save
// (lib/groupMembers.js giveRoles) ; a save that fails leaves the user, and a toast says which.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import getSettings from '@/config/settings';
import { giveRoles } from '@/lib/groupMembers';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
const src = (f) => readFileSync(join(__dirname, '../src', f), 'utf8');
const users = getSettings((k) => k).users;
const field = (key) => users.fields.find((f) => f.key === key);

describe('the New user wizard : its steps', () => {
  it('User, Password, Group and Roles, in that order, with the existing labels', () => {
    expect(users.steps.map((s) => s.key)).toEqual(['user', 'password', 'group', 'roles']);
    expect(users.steps.map((s) => s.label)).toEqual([
      'settings.users.stepUser',
      'settings.users.stepPassword',
      'settings.users.stepGroup',
      'settings.settingsPage.roles',
    ]);
  });

  it('the existing steps keep their fields, Roles holds the roles picked', () => {
    // a field naming no step is on the first one
    const stepOf = (key) => field(key).step || users.steps[0].key;
    expect(['username', 'description', 'email'].map(stepOf)).toEqual(['user', 'user', 'user']);
    expect(stepOf('password')).toBe('password');
    expect(stepOf('group_id')).toBe('group');
    expect(stepOf('role_names')).toBe('roles');
    // the password and the group stay required ; the roles never are : none is fine
    expect(field('password').required && field('group_id').required).toBe(true);
    expect(field('role_names').required).toBeFalsy();
    // dialog only : no column of the list
    expect(field('role_names').noTable).toBe(true);
  });

  it('Roles counts what is picked, none at first', () => {
    const roles = users.steps[3];
    expect(roles.count({ role_names: field('role_names').initial() })).toBe(0);
    expect(roles.count({ role_names: ['ops', 'dev'] })).toBe(2);
    expect(roles.count({})).toBe(0);
  });

  it('Roles is a pick list of roles, with Add role under it', () => {
    const props = field('role_names').props({ role_names: ['ops'] });
    expect(props.modelValue).toEqual(['ops']);
    expect(props.icon).toBe('user-shield');
    expect(props.addLabel).toBe('settings.settingsPage.addRole');
    expect(props.emptyText).toBe('settings.users.noRole');
  });
});

describe('the New user wizard : Save', () => {
  it('the user is created with its own fields only : the roles picked are not sent', () => {
    const body = users.beforeSave({
      username: 'bob',
      password: 'secret',
      group_id: 2,
      email: 'b@x',
      role_names: ['ops'],
    });
    expect(body).toEqual({ username: 'bob', password: 'secret', group_id: 2, email: 'b@x' });
  });

  it('the page gives the roles after the create, to the local user, and reads the list after', () => {
    const page = src('pages/admin/users.vue');
    expect(page).toContain("addToAll(names, 'users', 'local', values.username)");
    expect(page).toContain('afterSave: givePicked');
    expect(page).toContain(':settings="settings"');
    // AppAdminMulti waits for afterSave, with the dialog's values, before it reads the list
    const multi = src('components/AppAdminMulti.vue');
    expect(multi).toMatch(
      /axios\.post\(`\/api\/v\$\{props\.apiVersion\}\/\$\{objectType\}\/`, body\);[\s\S]*?await props\.settings\.afterSave\?\.\(res\.data, item\.value\);[\s\S]*?loadItems\(\);/,
    );
  });
});

describe('the New user wizard : its roles given once it is created', () => {
  it('gives the roles in one save', async () => {
    const addRoles = vi.fn(async () => true);
    expect(await giveRoles(['ops', 'viewers'], addRoles)).toEqual([]);
    expect(addRoles).toHaveBeenCalledTimes(1);
    expect(addRoles).toHaveBeenCalledWith(['ops', 'viewers']);
  });

  it('gives nothing when nothing is picked', async () => {
    const addRoles = vi.fn();
    expect(await giveRoles([], addRoles)).toEqual([]);
    expect(addRoles).not.toHaveBeenCalled();
  });

  it('names the user in the roles as a local member, { provider: local, name }', async () => {
    // useRoleMembership's addToAll, the forms config mocked : what the roles get, and one save
    vi.resetModules();
    const roles = {
      value: [
        { name: 'ops', users: [], groups: [] },
        { name: 'dev', users: [], groups: [] },
      ],
    };
    const save = vi.fn(async () => true);
    vi.doMock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }));
    vi.doMock('@/composables/useFormsConfig', () => ({
      useFormsConfig: () => ({
        roles,
        load: vi.fn(async () => {}),
        save,
        nextUid: (() => {
          let n = 0;
          return () => ++n;
        })(),
        parseError: { value: '' },
        isTemplated: { value: false },
        loadError: { value: '' },
      }),
    }));
    const { useRoleMembership } = await import('@/composables/useRoleMembership');
    const { addToAll } = useRoleMembership();
    expect(await giveRoles(['ops'], (names) => addToAll(names, 'users', 'local', 'bob'))).toEqual([]);
    expect(roles.value[0].users.map(({ provider, name }) => ({ provider, name }))).toEqual([
      { provider: 'local', name: 'bob' },
    ]);
    expect(roles.value[1].users).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
    vi.doUnmock('@/composables/useFormsConfig');
    vi.doUnmock('vue-i18n');
  });
});

describe('the New user wizard : a failed save of its roles', () => {
  it('returns every role when the save is refused or throws', async () => {
    expect(await giveRoles(['ops'], async () => false)).toEqual(['ops']);
    expect(
      await giveRoles(['ops', 'dev'], async () => {
        throw new Error('locked');
      }),
    ).toEqual(['ops', 'dev']);
  });

  it('the page names the roles not given in a toast, in every language', async () => {
    const page = src('pages/admin/users.vue');
    expect(page).toMatch(/toast\.error\(t\('settings\.users\.rolesNotGiven', \{ names: failed\.join\(', '\) \}\)\)/);
    for (const lang of LANGS) {
      const { default: m } = await import(`../src/locales/${lang}.js`);
      expect(m.settings.users.rolesNotGiven, lang).toContain('{names}');
    }
  });
});
