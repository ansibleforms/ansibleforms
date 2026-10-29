// A form's YAML edited in place by its Visual tab (lib/formDoc.js) : each edit changes only what
// it touches - comments, quoting, the form's other keys and a field's other keys survive - and
// what cannot be rewritten safely (an alias) is not edited.
import { describe, test, expect } from 'vitest';
import YAML from 'yaml';
import {
  fieldsState,
  readFields,
  setFieldText,
  setFieldRequired,
  setFieldType,
  moveField,
  removeField,
  addField,
  setFormText,
  setFormType,
  formList,
  setFormList,
  setFormValue,
  fieldDefaultText,
  setFieldDefault,
  setFieldOutput,
  fieldValuesText,
  setFieldValues,
  formObject,
  setFormObject,
  setFormIn,
  renameFormCredential,
  EMAIL,
  orderedForms,
  placeOf,
  orderFor,
} from '@/lib/formDoc';
import { yamlText } from '@/lib/yamlBlock';

const FORM = `# the form
name: Deploy
type: ansible
playbook: deploy.yaml # the playbook
roles:
  - admin
fields:
  # who asks
  - name: user
    type: text
    label: User
    default: "007"
  - name: env
    type: enum
    values:
      - dev
      - prod
    required: true
jobs: keep me
`;

const parse = (text = FORM) => YAML.parseDocument(text);

describe("a form's fields, edited in place", () => {
  test('read as rows', () => {
    const rows = readFields(parse());
    expect(rows.map((r) => [r.name, r.type, r.label, r.required])).toEqual([
      ['user', 'text', 'User', false],
      ['env', 'enum', '', true],
    ]);
  });

  test('a rename and a label keep everything else as written', () => {
    const doc = parse();
    const [user] = readFields(doc);
    setFieldText(user.node, 'name', 'login');
    setFieldText(user.node, 'label', '');
    const out = doc.toString();
    expect(out).toContain('- name: login');
    expect(out).not.toContain('label: User');
    for (const kept of [
      '# the form',
      'playbook: deploy.yaml # the playbook',
      '# who asks',
      'default: "007"',
      'jobs: keep me',
    ])
      expect(out).toContain(kept);
  });

  test('required : true, or no key', () => {
    const doc = parse();
    const [user, env] = readFields(doc);
    setFieldRequired(user.node, true);
    setFieldRequired(env.node, false);
    const rows = readFields(doc);
    expect(rows.map((r) => r.required)).toEqual([true, false]);
    expect(doc.toString().match(/required/g)).toHaveLength(1);
  });

  test('a type change removes what the new type forbids, and tells what it lacks', () => {
    const doc = parse();
    const [, env] = readFields(doc);
    const result = setFieldType(env.node, 'text');
    expect(result.removed).toContain('values');
    expect(doc.toString()).not.toContain('- prod');
    const [user] = readFields(doc);
    expect(setFieldType(user.node, 'enum').needs).not.toBeNull();
  });

  test('moved, removed and added ; the comment travels with its field', () => {
    const doc = parse();
    expect(moveField(doc, 0, 1)).toBe(true);
    expect(readFields(doc).map((r) => r.name)).toEqual(['env', 'user']);
    expect(doc.toString()).toMatch(/# who asks\n\s*- name: user/);
    expect(moveField(doc, 1, 1)).toBe(false);
    expect(removeField(doc, 0)).toBe(true);
    expect(addField(doc)).toBe(true);
    const rows = readFields(doc);
    expect(rows.map((r) => r.name)).toEqual(['user', '']);
    expect(rows[1].noName).toBe(true);
  });

  test('a form without fields gets its list with the first one', () => {
    const doc = parse('name: X\ntype: ansible\n');
    expect(fieldsState(doc)).toBe('none');
    expect(addField(doc)).toBe(true);
    expect(fieldsState(doc)).toBe('list');
  });

  test('an alias is not edited', () => {
    const doc = parse('common: &f\n  - name: a\n    type: text\nname: X\ntype: ansible\nfields: *f\n');
    expect(fieldsState(doc)).toBe('alias');
    expect(readFields(doc)).toEqual([]);
    expect(addField(doc)).toBe(false);
    expect(moveField(doc, 0, 1)).toBe(false);
  });

  test('two fields with one name are said', () => {
    const doc = parse('name: X\ntype: ansible\nfields:\n  - name: a\n  - name: a\n');
    expect(readFields(doc).map((r) => r.duplicate)).toEqual([false, true]);
  });
});

describe('the form itself, edited in place', () => {
  test('its texts : an empty one goes, the name stays', () => {
    const doc = parse();
    setFormText(doc, 'description', 'Deploys it');
    setFormText(doc, 'playbook', '');
    setFormText(doc, 'name', '');
    const out = doc.toString();
    expect(out).toContain('description: Deploys it');
    expect(out).not.toContain('playbook');
    expect(out).toMatch(/^name: ""$/m);
    expect(out).toContain('# the form');
  });

  test('a type change removes what the new type forbids', () => {
    const doc = parse();
    expect(setFormType(doc, 'subform')).toEqual(expect.arrayContaining(['playbook', 'roles']));
    expect(doc.toString()).not.toContain('playbook');
  });

  test('its categories and roles : strings kept as written, none in Default', () => {
    const doc = parse('name: X\ntype: ansible\nroles:\n  - "admin" # admins\ncategories:\n  - Demo\n');
    expect(formList(doc, 'roles')).toEqual(['admin']);
    setFormList(doc, 'roles', ['admin', 'default']);
    expect(doc.toString()).toContain('- "admin" # admins');
    setFormList(doc, 'categories', []);
    expect(doc.toString()).not.toContain('categories');
    expect(formList(parse('roles:\n  - name: x\n'), 'roles')).toBe(null);
  });
});

describe('the rest, edited in place', () => {
  test('a flag : true, or no key ; a number ; a list', () => {
    const doc = parse();
    setFormValue(doc, 'check', true);
    setFormValue(doc, 'order', 3);
    setFormValue(doc, 'instanceGroups', ['a', 'b']);
    setFormValue(doc, 'check', undefined);
    const out = doc.toString();
    expect(out).not.toContain('check');
    expect(out).toContain('order: 3');
    expect(out).toMatch(/instanceGroups:\n\s+- a\n\s+- b/);
  });

  test("a field's default : typed as the fields editor types it, a list left alone", () => {
    const doc = parse();
    const [user] = readFields(doc);
    expect(fieldDefaultText(user.node)).toBe('007');
    setFieldDefault(user.node, '42');
    expect(user.node.get('default')).toBe(42);
    setFieldDefault(user.node, '0755');
    expect(user.node.get('default')).toBe('0755');
    setFieldDefault(user.node, '');
    expect(user.node.has('default')).toBe(false);
    expect(fieldDefaultText(parse('fields:\n  - name: a\n    default: [1, 2]\n').get('fields').items[0])).toBe(null);
  });

  test("a field's output and values", () => {
    const doc = parse();
    const [user, env] = readFields(doc);
    setFieldOutput(user.node, false);
    expect(user.node.get('output')).toBe(false);
    setFieldOutput(user.node, true);
    expect(user.node.has('output')).toBe(false);
    expect(fieldValuesText(env.node)).toBe('- dev\n- prod');
    expect(setFieldValues(doc, env.node, '- a\n- name: b')).toBe('');
    expect(env.node.get('values').toJSON()).toEqual(['a', { name: 'b' }]);
    expect(setFieldValues(doc, env.node, 'a: 1')).not.toBe('');
    expect(setFieldValues(doc, env.node, '')).toBe('');
    expect(env.node.has('values')).toBe(false);
  });
});

describe("the form's nested settings", () => {
  test('notifications : on with its recipients, a key at a time, off', () => {
    const doc = parse();
    expect(formObject(doc, 'notifications')).toBeUndefined();
    setFormObject(doc, 'notifications', { recipients: [] });
    setFormIn(doc, 'notifications', 'recipients', ['ops@example.com']);
    setFormIn(doc, 'notifications', 'onStatus', ['failed']);
    expect(formObject(doc, 'notifications')).toEqual({ recipients: ['ops@example.com'], onStatus: ['failed'] });
    setFormIn(doc, 'notifications', 'onStatus', undefined);
    expect(formObject(doc, 'notifications')).toEqual({ recipients: ['ops@example.com'] });
    setFormObject(doc, 'notifications', undefined);
    expect(doc.has('notifications')).toBe(false);
    expect(doc.toString()).toContain('# the form');
  });

  test('approval : its message, its roles', () => {
    const doc = parse();
    setFormObject(doc, 'approval', { message: '', roles: [] });
    setFormIn(doc, 'approval', 'message', 'Please approve');
    setFormIn(doc, 'approval', 'roles', ['admin']);
    expect(formObject(doc, 'approval')).toEqual({ message: 'Please approve', roles: ['admin'] });
  });

  test('credentials : renamed in place, removed, the map gone with the last', () => {
    const doc = parse('name: X\ntype: ansible\ncredentials:\n  db: mysql # the db\n  api: token\n');
    renameFormCredential(doc, 'db', 'database');
    expect(doc.toString()).toContain('database: mysql # the db');
    renameFormCredential(doc, 'database', undefined);
    renameFormCredential(doc, 'api', undefined);
    expect(doc.has('credentials')).toBe(false);
  });

  test('an empty placeholder that gets a value loses its quotes, a quoted value keeps them', () => {
    const doc = parse('name: X\ntype: ansible\ncredentials:\n  db: ""\n  api: "007"\n');
    setFormIn(doc, 'credentials', 'db', 'mysql');
    setFormIn(doc, 'credentials', 'api', '008');
    expect(doc.toString()).toContain('db: mysql\n');
    expect(doc.toString()).toContain('api: "008"');
  });

  test('an email as the schema takes it', () => {
    expect(EMAIL.test('ops@example.com')).toBe(true);
    expect(EMAIL.test('ops@')).toBe(false);
  });
});

describe("the form's place in the forms list", () => {
  const others = [
    { name: 'Deploy', order: 5 },
    { name: 'Hello', order: 2 },
    { name: 'Backup', order: 3 },
    { name: 'Loose' },
  ];

  test('the forms with an order, as the list sorts them', () => {
    expect(orderedForms(others).map((f) => f.name)).toEqual(['Hello', 'Backup', 'Deploy']);
  });

  test('where it sits now', () => {
    expect(placeOf(undefined, 'Me', others)).toBe('');
    expect(placeOf(1, 'Me', others)).toBe('first');
    expect(placeOf(4, 'Me', others)).toBe('after:Backup');
    expect(placeOf(9, 'Me', others)).toBe('after:Deploy');
  });

  test('the order of a place : a whole number when there is room, else halfway, none removes it', () => {
    expect(orderFor('first', others)).toBe(1);
    expect(orderFor('after:Backup', others)).toBe(4);
    expect(orderFor('after:Hello', others)).toBe(2.5);
    expect(orderFor('after:Deploy', others)).toBe(6);
    expect(orderFor('', others)).toBeUndefined();
    expect(orderFor('first', [])).toBe(1);
    // the place it gets is the place asked for
    for (const place of ['first', 'after:Hello', 'after:Backup', 'after:Deploy'])
      expect(placeOf(orderFor(place, others), 'Me', others), place).toBe(place);
  });
});

describe('the lists and maps an edit changes, written one item per line', () => {
  // the form as people write it short : flow lists and maps
  const FLOW = `name: Deploy
type: ansible
playbook: deploy.yaml
categories: [Linux, Web]
roles: [admin, ops]
tags: [ keep, me ]
notifications: { onSuccess: [ ops@example.com ] }
fields: [{ name: user, type: text }]
`;

  test('flow lists are still read', () => {
    const doc = parse(FLOW);
    expect(formList(doc, 'roles')).toEqual(['admin', 'ops']);
    expect(formList(doc, 'categories')).toEqual(['Linux', 'Web']);
    expect(readFields(doc).map((r) => r.name)).toEqual(['user']);
  });

  test('a role added writes the roles one per line, the rest as written', () => {
    const doc = parse(FLOW);
    setFormList(doc, 'roles', ['admin', 'ops', 'dev']);
    const out = yamlText(doc);
    expect(out).toContain('roles:\n  - admin\n  - ops\n  - dev\n');
    expect(out).not.toContain('[ admin');
    // the lists and maps the edit did not touch keep their style
    expect(out).toContain('categories: [ Linux, Web ]');
    expect(out).toContain('tags: [ keep, me ]');
    expect(out).toContain('notifications: { onSuccess: [ ops@example.com ] }');
    expect(YAML.parse(out).roles).toEqual(['admin', 'ops', 'dev']);
  });

  test('a category removed writes the categories one per line', () => {
    const doc = parse(FLOW);
    setFormList(doc, 'categories', ['Web']);
    expect(doc.toString()).toContain('categories:\n  - Web\n');
  });

  test('the same list set again keeps its style', () => {
    const doc = parse(FLOW);
    setFormList(doc, 'roles', ['admin', 'ops']);
    expect(yamlText(doc)).toContain('roles: [ admin, ops ]');
  });

  test('a setting changed inside a flow map writes it one key per line', () => {
    const doc = parse(FLOW);
    setFormIn(doc, 'notifications', 'onFailure', ['ops@example.com']);
    const out = yamlText(doc);
    expect(out).toContain('notifications:\n  onSuccess: [ ops@example.com ]\n  onFailure:\n    - ops@example.com\n');
  });

  test('a field changed in a flow fields list writes the list and the field one item per line', () => {
    const doc = parse(FLOW);
    const [user] = readFields(doc);
    setFieldRequired(user.node, true);
    const out = yamlText(doc);
    expect(out).toContain('fields:\n  - name: user\n    type: text\n    required: true\n');
    addField(doc);
    expect(YAML.parse(yamlText(doc)).fields).toHaveLength(2);
  });
});
