// A playbook edited field by field, the designer's Playbooks Visual tab (config/playbookEdit.js) :
// its plays and their tasks read as fields, each edit only the keys it touches, comments kept.
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import {
  playbookFields,
  editAddPlay,
  editPlay,
  editRoles,
  editAddTask,
  editRemoveTask,
  editMoveTask,
  editTask,
  editModule,
  editArg,
  editRenameArg,
  editRemoveArg,
  editArgsText,
  typed,
} from '@/config/playbookEdit';

const PLAYBOOK = `---
# deploys the app
- name: Deploy
  hosts: web
  become: true
  roles:
    - nginx
  tasks:
    - name: Copy the release
      ansible.builtin.copy:
        src: app.tgz
        dest: /opt
        mode: "0644"
        owner: { user: app }
      when: release is defined
      tags: [deploy, copy]
    - name: Restart
      ansible.builtin.command: systemctl restart app
    - block:
        - debug: msg=hi
`;

describe('a playbook as fields', () => {
  const f = playbookFields(PLAYBOOK);

  it('its plays and their tasks', () => {
    const play = f.plays[0];
    expect(play).toMatchObject({
      kind: 'play',
      name: 'Deploy',
      hosts: 'web',
      become: true,
      gather_facts: true,
      roles: ['nginx'],
      rolesEditable: true,
    });
    const [copy, restart, block] = play.sections.tasks;
    expect(copy).toMatchObject({
      name: 'Copy the release',
      module: 'ansible.builtin.copy',
      args: 'map',
      when: 'release is defined',
      tags: 'deploy, copy',
    });
    expect(copy.params.map((p) => [p.key, p.value, p.complex])).toEqual([
      ['src', 'app.tgz', false],
      ['dest', '/opt', false],
      ['mode', '0644', false],
      ['owner', '', true],
    ]);
    expect(restart).toMatchObject({
      module: 'ansible.builtin.command',
      args: 'text',
      argsText: 'systemctl restart app',
    });
    expect(block.kind).toBe('block');
  });
});

describe('its edits', () => {
  it('a play : name, hosts, become, gather facts, roles - comments kept', () => {
    let t = editPlay(PLAYBOOK, 0, 'hosts', 'db');
    t = editPlay(t, 0, 'become', false);
    t = editPlay(t, 0, 'gather_facts', false);
    t = editRoles(t, 0, ['nginx', 'app']);
    const play = YAML.parse(t)[0];
    expect(play).toMatchObject({ hosts: 'db', gather_facts: false, roles: ['nginx', 'app'] });
    expect(play.become).toBeUndefined();
    expect(t).toContain('# deploys the app');
  });

  it('a task : added, its fields, its module and arguments', () => {
    const added = editAddTask(PLAYBOOK, 0, 'handlers');
    let t = editTask(added.text, 0, 'handlers', added.index, 'name', 'reload nginx');
    t = editModule(t, 0, 'handlers', added.index, 'ansible.builtin.service');
    t = editRemoveArg(t, 0, 'handlers', added.index, 'msg');
    t = editArg(t, 0, 'handlers', added.index, 'name', 'nginx');
    t = editArg(t, 0, 'handlers', added.index, 'enabled', 'true');
    t = editTask(t, 0, 'handlers', added.index, 'tags', 'web, reload');
    t = editTask(t, 0, 'handlers', added.index, 'ignore_errors', true);
    const handler = YAML.parse(t)[0].handlers[0];
    expect(handler).toEqual({
      name: 'reload nginx',
      'ansible.builtin.service': { name: 'nginx', enabled: true },
      tags: ['web', 'reload'],
      ignore_errors: true,
    });
    expect(Object.keys(handler)[0]).toBe('name');
  });

  it('an argument renamed, a one-line argument set ; a key emptied is removed', () => {
    let t = editRenameArg(PLAYBOOK, 0, 'tasks', 0, 'dest', 'path');
    t = editArgsText(t, 0, 'tasks', 1, 'systemctl reload app');
    t = editTask(t, 0, 'tasks', 0, 'when', '');
    const [copy, restart] = YAML.parse(t)[0].tasks;
    expect(copy['ansible.builtin.copy']).toEqual({
      src: 'app.tgz',
      path: '/opt',
      mode: '0644',
      owner: { user: 'app' },
    });
    expect(copy.when).toBeUndefined();
    expect(restart['ansible.builtin.command']).toBe('systemctl reload app');
  });

  it('a task moved and removed ; a play added', () => {
    let t = editMoveTask(PLAYBOOK, 0, 'tasks', 1, -1);
    expect(YAML.parse(t)[0].tasks[0].name).toBe('Restart');
    expect(editMoveTask(PLAYBOOK, 0, 'tasks', 0, -1)).toBe(PLAYBOOK);
    t = editRemoveTask(t, 0, 'tasks', 0);
    expect(YAML.parse(t)[0].tasks.map((x) => x.name)).toEqual(['Copy the release', undefined]);
    t = editAddPlay(t);
    expect(YAML.parse(t)[1]).toMatchObject({ name: 'New play', hosts: 'all' });
  });

  it('types what is typed', () => {
    expect([typed('true'), typed('3'), typed('0644'), typed('a')]).toEqual([true, 3, '0644', 'a']);
  });
});

describe('a playbook written short', () => {
  const FLOW =
    '- name: Deploy\n  hosts: web\n  tasks:\n    - name: Say\n      ansible.builtin.debug: { msg: hi }\n      tags: [a]\n';

  it('writes a map an edit changes one key per line, the rest as written', () => {
    const out = editArg(FLOW, 0, 'tasks', 0, 'verbosity', '1');
    expect(out).toContain('ansible.builtin.debug:\n        msg: hi\n        verbosity: 1\n');
    expect(out).toContain('tags: [ a ]');
  });
});
