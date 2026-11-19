// The New role, New group and New user wizards title their pick lists, as every field : the
// step's word ("Users", "Groups", "Roles") in bold above the list, a form-label.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withoutComments } from './vueSource.js';
import getSettings from '@/config/settings';

const read = (file) => withoutComments(readFileSync(join(import.meta.dirname, '../src', file), 'utf8'));
const settings = getSettings((k) => k);
const field = (list, key) => settings[list].fields.find((f) => f.key === key);

describe('the wizards title their pick lists', () => {
  it("gives the group's users and roles and the user's roles their step's word", () => {
    for (const [list, key, word] of [
      ['groups', 'user_ids', 'users'],
      ['groups', 'role_names', 'roles'],
      ['users', 'role_names', 'roles'],
    ]) {
      const f = field(list, key);
      expect(f.type, `${list}.${key}`).toBe('component');
      expect(f.label, `${list}.${key}`).toBe(`settings.settingsPage.${word}`);
      // a flush component draws no label : these are not
      expect(f.flush, `${list}.${key}`).toBeFalsy();
    }
  });

  it("draws a component's label bold, above it", () => {
    const multi = read('components/AppAdminMulti.vue');
    expect(multi).toMatch(
      /field\.type === 'component'" class="mb-3">\s+<div v-if="field.label" class="form-label fw-bold">\{\{ field\.label \}\}/,
    );
  });

  it("titles the New role wizard's Users and Groups steps, not the role page's tabs", () => {
    const editor = read('components/AppRoleEditor.vue');
    const users = editor.slice(editor.indexOf(`section === 'users'">`));
    expect(users.slice(0, 200)).toContain(
      `<div v-if="!tab" class="form-label fw-bold">{{ t('settings.settingsPage.users') }}</div>`,
    );
    const groups = users.slice(users.indexOf('<template v-else>'));
    expect(groups.slice(0, 200)).toContain(
      `<div v-if="!tab" class="form-label fw-bold">{{ t('settings.settingsPage.groups') }}</div>`,
    );
  });
});
