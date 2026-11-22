// The New role dialog is a wizard (pages/admin/roles.vue) : Details, Permissions, Users, Groups,
// walked with composables/useWizard.js, Next on Details only with a name a save takes
// (useRoleSupport's roleNameProblem), Save on the last step. A role's page keeps its tabs.
import { describe, it, expect } from 'vitest';
import { computed, ref } from 'vue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { roleWizardSteps } from '@/config/roles';
import { roleNameProblem } from '@/composables/useRoleSupport';
import { useWizard } from '@/composables/useWizard';

const LANGS = ['en', 'de', 'fr', 'it', 'es', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];
const src = (f) => readFileSync(join(__dirname, '../src', f), 'utf8');
// the message key, as vue-i18n's t would translate it
const t = (key) => key;

/**
 * The New role wizard as roles.vue builds it : its steps, Details left only with a valid name.
 *
 * Args:
 *   name (Ref<string>): the name typed.
 *   taken (string[]): the names of the other roles.
 *
 * Returns:
 *   object: useWizard's { stepIndex, stepReached, step, isLastStep, goToStep, reset }.
 */
function roleWizard(name, taken = ['admin', 'default']) {
  const steps = computed(() => roleWizardSteps.map((s) => ({ key: s.key, label: s.label })));
  return useWizard(steps, (step) => step.key !== 'details' || !roleNameProblem(t, name.value, new Set(taken)));
}

describe('the New role wizard : its steps', () => {
  it('Details, Permissions, Users and Groups, in that order, Users and Groups with their count', () => {
    expect(roleWizardSteps.map((s) => s.key)).toEqual(['details', 'permissions', 'users', 'groups']);
    expect(roleWizardSteps.map((s) => s.label)).toEqual([
      'settings.common.tabDetails',
      'settings.settingsPage.permissions',
      'settings.settingsPage.users',
      'settings.settingsPage.groups',
    ]);
    expect(roleWizardSteps.filter((s) => s.count).map((s) => s.count)).toEqual(['users', 'groups']);
  });

  it('the dialog draws them with the shared step strip, the editor showing the step', () => {
    const page = src('pages/admin/roles.vue');
    expect(page).toContain('<AppWizardSteps');
    expect(page).toContain(':step="roleStepShown.key"');
    expect(page).toContain('roleWizardSteps');
  });
});

describe('the New role wizard : Next', () => {
  it('is blocked on Details without a name', () => {
    const name = ref('');
    const w = roleWizard(name);
    expect(w.goToStep(1)).toBe(false);
    expect(w.stepIndex.value).toBe(0);
    name.value = '   ';
    expect(w.goToStep(1)).toBe(false);
    expect(w.stepIndex.value).toBe(0);
  });

  it('is blocked by the checks of a save : a name taken, or admin', () => {
    const name = ref('default');
    const w = roleWizard(name);
    expect(w.goToStep(1)).toBe(false);
    name.value = 'admin';
    expect(w.goToStep(1)).toBe(false);
    expect(w.stepIndex.value).toBe(0);
  });

  it('goes on with a valid name, one step at a time ; the strip goes back to the steps reached', () => {
    const name = ref('operators');
    const w = roleWizard(name);
    // never past the step after the furthest reached
    expect(w.goToStep(2)).toBe(false);
    expect(w.goToStep(1)).toBe(true);
    expect(w.goToStep(2)).toBe(true);
    expect(w.stepReached.value).toBe(2);
    // back always, and forward again straight to a step reached (the strip)
    expect(w.goToStep(0)).toBe(true);
    expect(w.goToStep(2)).toBe(true);
    // a name made empty on the way back keeps the wizard on Details, the strip too
    w.goToStep(0);
    name.value = '';
    expect(w.goToStep(1)).toBe(false);
    expect(w.goToStep(2)).toBe(false);
    expect(w.stepIndex.value).toBe(0);
    w.reset();
    expect([w.stepIndex.value, w.stepReached.value]).toEqual([0, 0]);
  });

  it('roleNameProblem is the check validateRoles runs on a save', () => {
    const support = src('composables/useRoleSupport.js');
    expect(support).toMatch(/function validateRoles\(\)[\s\S]*roleNameProblem\(t, name, seen, role\._required\)/);
    expect(roleNameProblem(t, '', new Set())).toBe('settings.settingsPage.roleNameRequired');
    expect(roleNameProblem(t, 'ops', new Set(['ops']))).toBe('settings.settingsPage.duplicateRoleName');
    expect(roleNameProblem(t, 'admin', new Set())).toBe('settings.settingsPage.reservedRoleName');
    expect(roleNameProblem(t, 'admin', new Set(), true)).toBeNull();
    expect(roleNameProblem(t, ' ops ', new Set(['admin']))).toBeNull();
  });
});

describe('the New role wizard : Save', () => {
  it('is only on the last step', () => {
    const name = ref('operators');
    const w = roleWizard(name);
    const seen = [];
    for (let i = 0; i < roleWizardSteps.length; i++) {
      w.goToStep(i);
      seen.push(w.isLastStep.value);
    }
    expect(seen).toEqual([false, false, false, true]);
    // the footer : Previous after the first step, Next until the last, Save on the last
    const page = src('pages/admin/roles.vue');
    expect(page).toContain('<BsButton v-if="roleStep > 0" icon="arrow-left"');
    expect(page).toContain('<BsButton v-if="!roleLastStep" icon="arrow-right"');
    expect(page).toContain('<BsButton v-if="roleLastStep" icon="save" @click="createRole()">');
  });
});

describe("a role's page", () => {
  it('keeps its tabs, the editor showing its Details tab whole (name, description, permissions)', () => {
    const page = src('pages/admin/role.vue');
    for (const key of ['details', 'users', 'groups', 'forms']) expect(page).toContain(`key: '${key}'`);
    expect(page).toContain('tab="general"');
    expect(page).not.toContain(':step=');
    const editor = src('components/AppRoleEditor.vue');
    expect(editor).toContain("['general', 'details'].includes(section.value)");
    expect(editor).toContain("['general', 'permissions'].includes(section.value)");
    // the block of switches is titled Permissions, not Options
    expect(editor).toContain("t('settings.settingsPage.permissions')");
    expect(editor).not.toContain('settingsPage.options');
  });
});

describe('the texts of the wizard', () => {
  it('in every language, each short enough for one line', async () => {
    for (const lang of LANGS) {
      const m = (await import(`../src/locales/${lang}.js`)).default;
      const texts = [
        m.settings.common.tabDetails,
        m.settings.settingsPage.permissions,
        m.settings.settingsPage.users,
        m.settings.settingsPage.groups,
        m.common.previous,
        m.common.next,
      ];
      for (const text of texts) {
        expect(text, lang).toBeTruthy();
        expect(text.length, `${lang}: ${text}`).toBeLessThanOrEqual(20);
      }
      // Options is now Permissions : the old key is gone
      expect(m.settings.settingsPage.options, lang).toBeUndefined();
    }
  });
});

describe("the New role dialog's width", () => {
  it('is wider on the Permissions step only', async () => {
    const { roleWizardSteps } = await import('@/config/roles');
    expect(roleWizardSteps.map((s) => s.dialogSize || 'lg')).toEqual(['lg', 'xl', 'lg', 'lg']);
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const page = readFileSync(resolve(__dirname, '../src/pages/admin/roles.vue'), 'utf8');
    expect(page).toMatch(/<BsModal v-if="newRole" :size="roleDialogSize"/);
    expect(page).toMatch(/roleWizardSteps\[roleStep\.value\]\?\.dialogSize \|\| 'lg'/);
  });
});
