// An inventory edited field by field, the designer's Inventories Visual tab
// (config/inventoryEdit.js) : groups and child groups, hosts, the variables of a group or a host,
// each edit only the keys it touches, comments kept.
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import {
  varsOf,
  editAddGroup,
  editRenameGroup,
  editRemoveGroup,
  editAddHost,
  editRenameHost,
  editRemoveHost,
  editSetVar,
  editRenameVar,
  editRemoveVar,
} from '@/config/inventoryEdit';

const INVENTORY = `# production
all:
  vars:
    ntp: pool.ntp.org
  children:
    web:
      hosts:
        web1.example.com:
          http_port: 8080
        web2.example.com:
    db:
`;

describe('an inventory edited', () => {
  it("reads a group's and a host's variables", () => {
    expect(varsOf(INVENTORY, { path: ['all'] })).toEqual([{ key: 'ntp', value: 'pool.ntp.org', complex: false }]);
    expect(varsOf(INVENTORY, { path: ['all', 'web'], host: 'web1.example.com' })).toEqual([
      { key: 'http_port', value: '8080', complex: false },
    ]);
    expect(varsOf(INVENTORY, { path: ['all', 'web'], host: 'web2.example.com' })).toEqual([]);
  });

  it('adds, renames and removes groups ; a child of a group written with no value', () => {
    let t = editAddGroup(INVENTORY, ['all', 'db'], 'replicas');
    t = editRenameGroup(t, ['all', 'web'], 'frontend');
    t = editAddGroup(t, null, 'ungrouped');
    const data = YAML.parse(t);
    expect(data.all.children.db.children.replicas).toEqual({ hosts: {} });
    expect(Object.keys(data.all.children)).toEqual(['frontend', 'db']);
    expect(data.ungrouped).toEqual({ hosts: {} });
    expect(t).toContain('# production');
    expect(() => editAddGroup(INVENTORY, ['all'], 'web')).toThrow(/already/);
    t = editRemoveGroup(t, ['all', 'db']);
    expect(Object.keys(YAML.parse(t).all.children)).toEqual(['frontend']);
  });

  it('adds, renames and removes hosts', () => {
    let t = editAddHost(INVENTORY, ['all', 'db'], 'db1.example.com');
    t = editRenameHost(t, ['all', 'web'], 'web1.example.com', 'www1.example.com');
    t = editRemoveHost(t, ['all', 'web'], 'web2.example.com');
    const data = YAML.parse(t);
    expect(data.all.children.db.hosts).toEqual({ 'db1.example.com': null });
    expect(data.all.children.web.hosts).toEqual({ 'www1.example.com': { http_port: 8080 } });
  });

  it('sets, renames and removes variables ; an emptied host is a plain host again', () => {
    let t = editSetVar(INVENTORY, { path: ['all', 'web'], host: 'web2.example.com' }, 'http_port', '80');
    t = editSetVar(t, { path: ['all', 'web'] }, 'tls', 'true');
    t = editRenameVar(t, { path: ['all'] }, 'ntp', 'ntp_server');
    let data = YAML.parse(t);
    expect(data.all.children.web.hosts['web2.example.com']).toEqual({ http_port: 80 });
    expect(data.all.children.web.vars).toEqual({ tls: true });
    expect(data.all.vars).toEqual({ ntp_server: 'pool.ntp.org' });
    t = editRemoveVar(t, { path: ['all', 'web'], host: 'web2.example.com' }, 'http_port');
    t = editRemoveVar(t, { path: ['all', 'web'] }, 'tls');
    data = YAML.parse(t);
    expect(data.all.children.web.hosts['web2.example.com']).toBeNull();
    expect(data.all.children.web.vars).toBeUndefined();
  });

  it('writes a host emptied of its variables, or a new one, as `host:`', () => {
    const start = 'all:\n  children:\n    db:\n      hosts:\n        db1.example.com:\n          zz: ""\n';
    let t = editRemoveVar(start, { path: ['all', 'db'], host: 'db1.example.com' }, 'zz');
    expect(t).toBe('all:\n  children:\n    db:\n      hosts:\n        db1.example.com:\n');
    t = editAddHost(t, ['all', 'db'], 'db2.example.com');
    expect(t).toContain('        db2.example.com:\n');
    // a null the file spells out keeps its spelling
    expect(editSetVar('all:\n  vars:\n    a: ~\n', { path: ['all'] }, 'b', '1')).toContain('a: ~');
  });
});

describe('an inventory written short', () => {
  const FLOW = 'all:\n  hosts:\n    web1: { http_port: 8080 }\n    web2: { a: 1 }\n';

  it('writes a map an edit changes one key per line, the rest as written', () => {
    const out = editSetVar(FLOW, { path: ['all'], host: 'web1' }, 'ansible_user', 'deploy');
    expect(out).toContain('web1:\n      http_port: 8080\n      ansible_user: deploy\n');
    expect(out).toContain('web2: { a: 1 }');
  });
});
