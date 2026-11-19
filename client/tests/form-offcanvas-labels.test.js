// The form page's Schedule (and Run later) and Save offcanvases title every field in bold, as
// every dialog : the name, the cron expression, the run time, the description, the removal and
// the visibility, the required ones keeping their red star.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withoutComments } from './vueSource.js';

const form = withoutComments(readFileSync(join(import.meta.dirname, '../src/pages/form.vue'), 'utf8'));
const template = form.slice(form.indexOf('<template>'));
const between = (from, to) => template.slice(template.indexOf(from), template.indexOf(to, template.indexOf(from)));
const schedule = between(':show="showScheduleOffcanvas"', '</BsOffCanvas>');
const save = between(':show="showStoreOffcanvas"', '</BsOffCanvas>');

describe("the form page's Schedule and Save offcanvases : bold labels", () => {
  it('draws no field label without fw-bold in either', () => {
    for (const [name, part] of [
      ['schedule', schedule],
      ['save', save],
    ]) {
      const labels = part.match(/<label class="form-label[^"]*"/g) || [];
      expect(labels.length, name).toBeGreaterThan(0);
      for (const label of labels) expect(label, name).toContain('fw-bold');
    }
  });

  it('keeps the red star on the required fields', () => {
    for (const key of ['form.scheduleName', 'form.cronExpression', 'form.runAt']) {
      expect(schedule).toContain(
        `<label class="form-label fw-bold">{{ t('${key}') }} <span class="text-danger">*</span></label>`,
      );
    }
    expect(save).toContain(
      `<label class="form-label fw-bold">{{ t('form.scheduleName') }} <span class="text-danger">*</span></label>`,
    );
    expect(save).toContain(`<label class="form-label fw-bold">{{ t('form.description') }}</label>`);
  });

  it("titles the removal choice in bold too, as the stored job's page", () => {
    expect(save).toMatch(/<AppStoredJobRemoval[^>]*labelClass="form-label fw-bold"/);
  });
});
