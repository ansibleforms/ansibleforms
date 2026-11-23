// A form or a workflow node names the repository its playbook runs from (playbookRepository,
// playbook_repository) : the Designer offers the repositories used for playbooks, and the
// playbooks of the one named, from its root ; without one, the first repository's, as before.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playbookChoices } from '@/lib/playbookChoices';
import { USAGE_TYPES } from '@/lib/repositoryUsage';
import { NODE_RUN_KEYS } from '@/config/workflowFile';

const read = (p) => readFileSync(resolve(__dirname, '../src', p), 'utf8');
const LANGS = ['en', 'es', 'fr', 'it', 'de', 'nl', 'ca', 'pt', 'ja', 'zh', 'pl'];

// as /api/v2/files/playbooks lists them : the first repository's playbooks folder, then infra whole
const files = ['site.yml', 'team/web.yml', 'infra/playbooks/deploy.yml', 'infra/roles/x/tasks/main.yml'];
const repositories = [
  { name: 'first', prefix: '', folder: 'playbooks' },
  { name: 'infra', prefix: 'infra', folder: '' },
];

describe("a playbook's repository", () => {
  it('without one : the first repository as it runs them, nothing of the others', () => {
    expect(playbookChoices(files, repositories)).toEqual(['site.yml', 'team/web.yml']);
  });

  it("with one : its files from its root ; the first one's with its playbooks folder in front", () => {
    expect(playbookChoices(files, repositories, 'infra')).toEqual(['playbooks/deploy.yml', 'roles/x/tasks/main.yml']);
    expect(playbookChoices(files, repositories, 'first')).toEqual(['playbooks/site.yml', 'playbooks/team/web.yml']);
  });

  it('__self__ : the repository the form or the workflow file is in ; none outside one', () => {
    expect(playbookChoices(files, repositories, '__self__', 'infra')).toEqual([
      'playbooks/deploy.yml',
      'roles/x/tasks/main.yml',
    ]);
    expect(playbookChoices(files, repositories, '__self__', '')).toEqual([]);
    // a forms repository not used for playbooks
    expect(playbookChoices(files, repositories, '__self__', 'forms')).toEqual([]);
  });

  it('the form and the playbook node offer __self__, named in every language', async () => {
    expect(read('components/AppFormVisualEditor.vue')).toContain(':value="SELF_REPOSITORY"');
    expect(read('components/AppWorkflowNodeFields.vue')).toContain('<option value="__self__">');
    for (const lang of LANGS) {
      const d = (await import(`../src/locales/${lang}.js`)).default.designer;
      for (const key of ['visualOwnFormRepository', 'visualOwnWorkflowRepository']) {
        expect(d[key], `${lang} ${key}`).toContain('{name}');
        expect(d[key].length, `${lang} ${key}`).toBeLessThanOrEqual(45);
      }
    }
  });

  it('Playbooks may be on several repositories', () => {
    expect(USAGE_TYPES.find((u) => u.key === 'playbooks').oneOnly).toBeFalsy();
  });

  it("the form's Visual tab and a playbook node offer the repository, its words in every language", async () => {
    expect(read('components/AppFormVisualEditor.vue')).toContain("setText('playbookRepository', $event.target.value)");
    expect(read('components/AppWorkflowNodeFields.vue')).toContain(
      "emit('set', 'playbook_repository', $event.target.value)",
    );
    expect(NODE_RUN_KEYS).toContain('playbook_repository');
    for (const lang of LANGS) {
      const d = (await import(`../src/locales/${lang}.js`)).default.designer;
      for (const key of ['formPlaybookRepository', 'helpPlaybookRepository', 'visualFirstPlaybookRepository']) {
        expect(d[key], `${lang} ${key}`).toBeTruthy();
      }
      expect(d.helpPlaybookRepository, lang).toMatch(/[.。]$/);
      expect(d.helpPlaybookRepository.length, lang).toBeLessThanOrEqual(90);
    }
  });
});
