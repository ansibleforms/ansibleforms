// A list's New and Edit dialogs (AppAdminMulti) and its defaults dialog show each label above its
// field, the field the dialog's full width and its help under it, as every other dialog : no
// label column (col-sm-2 beside col-sm-10) in them or in what they draw.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withoutComments } from './vueSource.js';
import getSettings from '@/config/settings';

const read = (file) => withoutComments(readFileSync(join(import.meta.dirname, '../src', file), 'utf8'));
const multi = read('components/AppAdminMulti.vue');
// the template of the record dialog, from its first field to the end of its fields
const fields = multi.slice(multi.indexOf('<template v-for="field in dialogFields"'), multi.indexOf('childLists"'));

// a horizontal form's classes : a label column, its field beside it, a row under the field
const COLUMNS = /col-sm-|col-form-label|offset-sm-|isHorizontal|class="row/;

describe("a list's dialogs : each label above its field", () => {
  it('lays out no label column, in the record dialog nor the defaults dialog', () => {
    expect(multi).not.toMatch(COLUMNS);
  });

  it('nor do the parts they draw : a list of values, a radio choice, the password dialog', () => {
    for (const file of [
      'components/BsInputList.vue',
      'components/BsRadioChoice.vue',
      'components/AppChangePasswordDialog.vue',
    ]) {
      expect(read(file), file).not.toMatch(COLUMNS);
    }
    expect(read('components/BsRadioChoice.vue')).not.toMatch(/aligned/);
  });

  it('puts a bold label above a datetime, a cron and an rrule field, its help under it', () => {
    for (const type of ['datetime', 'cron', 'rrule']) {
      const at = fields.indexOf(`field.type === '${type}'" class="mb-3">`);
      expect(at, type).toBeGreaterThan(-1);
      expect(fields.slice(at, at + 200)).toContain('<label class="form-label fw-bold"');
    }
    expect(fields).not.toMatch(/<small v-if="field.help"/);
  });

  it('draws the other fields with BsInput and BsInputList in their labels-above layout', () => {
    expect(fields).toMatch(/<BsInputList\s+v-else-if=/);
    expect(fields).toMatch(/<BsInput\s+v-else-if=/);
    expect(fields).toContain(':isFloating="false"');
  });

  it('puts every switch under its bold title, as a record page', () => {
    const at = fields.indexOf('field.type === \'checkbox\'" class="mb-3">');
    expect(at).toBeGreaterThan(-1);
    const block = fields.slice(at, fields.indexOf('</div>\n        </div>', at));
    expect(block).toContain('<label class="form-label fw-bold d-block" :for="\'af-switch-\' + field.key">');
    // the switch says On or Off beside it (BsSwitch), its title above, no text of its own beside
    expect(block).toMatch(/<BsSwitch\s+:id="'af-switch-' \+ field\.key"/);
    expect(block).not.toContain('form-check-label');
    // no switch with its label beside it and no title above (the old flush switch)
    expect(fields).not.toContain('af-flush-switch');
    expect(fields).not.toMatch(/field\.type === 'checkbox' && field\.flush/);
  });

  it("sets flush on no switch, only on a component with its own titles (a schedule's End)", () => {
    const settings = getSettings((k) => k);
    const flushed = [];
    for (const [name, list] of Object.entries(settings)) {
      for (const f of list?.fields || []) {
        if (f.type === 'checkbox') expect(f.flush, `${name}.${f.key}`).toBeUndefined();
        if (f.flush) flushed.push(`${name}.${f.key}:${f.type}`);
      }
    }
    expect(flushed).toEqual(['schedules.end:component']);
  });

  it('puts a New button under its label or its dropdown, on its own line', () => {
    expect(fields).toContain(
      '<div class="form-label fw-bold">{{ field.label }}</div>\n          <BsButton icon="plus" @click="creators',
    );
    expect(fields).toContain('class="mb-3 mt-n2"');
  });

  it('puts the swatches and a component under their labels, a component without one unlabelled', () => {
    expect(fields).toMatch(/field\.type === 'swatches'" class="mb-3">\s+<div class="form-label fw-bold"/);
    expect(fields).toMatch(
      /field\.type === 'component'" class="mb-3">\s+<div v-if="field.label" class="form-label fw-bold">/,
    );
  });

  it('titles a radio choice among other fields, a credential sign-in, as they are', () => {
    expect(fields).toContain('<div v-else-if="field.titled && field.label" class="form-label fw-bold">');
    const credentials = getSettings((k) => k).credentials.fields;
    for (const key of ['awx_auth', 'git_auth', 'smtp_auth', 'entra_auth', 'ssh_auth']) {
      expect(credentials.find((f) => f.key === key).titled, key).toBe(true);
    }
  });

  it("puts the defaults dialog's labels above their dropdowns", () => {
    const picker = multi.slice(multi.indexOf('v-for="(group, i) in defaultPicker.groups"'));
    expect(picker.slice(0, 400)).toContain('<label class="form-label fw-bold" :for="\'af-default-\' + group.key">');
  });

  it('keeps no width or spacing made for the label column', () => {
    const styles = readFileSync(join(import.meta.dirname, '../src/styles/bootstrap-override.scss'), 'utf8');
    expect(styles).not.toContain('af-password-dialog');
    expect(styles).not.toMatch(/\.row\.mb-3:has\(\.form-switch\)/);
    expect(multi).not.toContain('af-swatch-row');
    expect(read('components/BsInputList.vue')).not.toContain('af-label-tall');
  });
});

describe("the profile's API token dialog : each label above its field", () => {
  const profile = read('pages/profile.vue');
  // the request's two steps : a name and a lifetime, then the password
  const dialog = profile.slice(profile.indexOf('v-else-if="tokenStep === 0"'), profile.indexOf('<template #footer>'));

  it('draws its fields in the labels-above layout, bold, with their left icons', () => {
    expect(dialog).not.toMatch(COLUMNS);
    // three BsInput, none horizontal : BsInput then puts a bold label above its field
    expect(dialog.match(/<BsInput\b/g)).toHaveLength(3);
    expect(dialog.match(/:isFloating="false"/g)).toHaveLength(3);
    for (const icon of ['tag', 'hourglass-half', 'lock']) expect(dialog).toContain(`icon="${icon}"`);
    const input = readFileSync(join(import.meta.dirname, '../src/components/BsInput.vue'), 'utf8');
    const above = input.slice(input.lastIndexOf('<template v-else>'));
    expect(above).toContain('<label :for="uid" class="form-label fw-bold"');
  });
});
